/**
 * Dev container setup: adds the claude-code-stay-awake feature to a project.
 *
 * Copies the feature (bundled with the app) next to the project's
 * devcontainer.json as a local feature, and adds `"./claude-code-stay-awake"`
 * to its "features" block. devcontainer.json is JSONC — comments and trailing
 * commas are common — so it is edited as text: only the inserted (or removed)
 * entry changes, and every comment and the file's own formatting survive.
 *
 * No Electron dependency, so it can be tested under plain Node.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const FEATURE_ID = 'claude-code-stay-awake';
const LOCAL_FEATURE_KEY = './' + FEATURE_ID;
const FEATURE_FILES = ['devcontainer-feature.json', 'install.sh', 'claude-hook.sh', 'insomnia-hooks.json', 'README.md'];
const DEFAULT_SOURCE_DIR = path.join(__dirname, 'devcontainer-features', 'src', FEATURE_ID);
const DEFAULT_BRIDGE_PORT = 47391;

function normalizeKey(key) {
  return key.replace(/\\/g, '/').replace(/\/+$/, '');
}

function isLocalKey(key) {
  return normalizeKey(key) === LOCAL_FEATURE_KEY;
}

// Our feature under any reference: the local copy, or the published one at any tag.
function isOurFeatureKey(key) {
  const k = normalizeKey(key);
  return k === LOCAL_FEATURE_KEY || /^ghcr\.io\/[^/]+\/insomnia\/claude-code-stay-awake(:[^/]*)?$/i.test(k);
}

// ── JSONC parsing (positions only) ─────────────────────────────────────────────

function tokenize(text) {
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '﻿') { i++; continue; }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) throw new Error('unterminated comment');
      i = end + 2;
      continue;
    }
    if (c === '"') {
      const start = i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\n') throw new Error('unterminated string');
        i += text[i] === '\\' ? 2 : 1;
      }
      if (i >= text.length) throw new Error('unterminated string');
      i++;
      tokens.push({ type: 'string', start, end: i, value: JSON.parse(text.slice(start, i)) });
      continue;
    }
    if ('{}[]:,'.includes(c)) { tokens.push({ type: c, start: i, end: i + 1 }); i++; continue; }
    const start = i;
    while (i < text.length && /[A-Za-z0-9+\-.]/.test(text[i])) i++;
    if (i === start) throw new Error(`unexpected character '${c}'`);
    tokens.push({ type: 'literal', start, end: i });
  }
  return tokens;
}

// Returns { type, start, end } for every value, plus `members` for objects:
// [{ key, keyStart, value, commaEnd }] where commaEnd is set when a comma follows.
function parseJsonc(text) {
  const tokens = tokenize(text);
  let p = 0;
  const peek = () => tokens[p];
  const expect = type => {
    const t = tokens[p];
    if (!t || t.type !== type) throw new Error(`expected '${type}'`);
    p++;
    return t;
  };

  function parseValue() {
    const t = peek();
    if (!t) throw new Error('unexpected end of file');
    if (t.type === '{') return parseObject();
    if (t.type === '[') return parseArray();
    if (t.type === 'string' || t.type === 'literal') { p++; return { type: t.type, start: t.start, end: t.end }; }
    throw new Error(`unexpected '${t.type}'`);
  }

  function parseObject() {
    const open = expect('{');
    const members = [];
    while (peek() && peek().type !== '}') {
      const keyTok = expect('string');
      expect(':');
      const value = parseValue();
      const member = { key: keyTok.value, keyStart: keyTok.start, value };
      members.push(member);
      if (peek() && peek().type === ',') member.commaEnd = tokens[p++].end;
      else break;
    }
    const close = expect('}');
    return { type: 'object', start: open.start, end: close.end, members };
  }

  function parseArray() {
    const open = expect('[');
    while (peek() && peek().type !== ']') {
      parseValue();
      if (peek() && peek().type === ',') p++;
      else break;
    }
    const close = expect(']');
    return { type: 'array', start: open.start, end: close.end };
  }

  const root = parseValue();
  if (p !== tokens.length) throw new Error('unexpected content after the end');
  return root;
}

function findFeaturesObject(root) {
  if (root.type !== 'object') return null;
  const features = root.members.find(m => m.key === 'features');
  return features && features.value.type === 'object' ? features.value : null;
}

// ── Text editing ───────────────────────────────────────────────────────────────

function lineStartOf(text, pos) {
  return text.lastIndexOf('\n', pos - 1) + 1;
}

function indentOfLine(text, pos) {
  return /^[ \t]*/.exec(text.slice(lineStartOf(text, pos)))[0];
}

// Whether `pos` is the first non-blank character on its line.
function startsLine(text, pos) {
  return /^[ \t]*$/.test(text.slice(lineStartOf(text, pos), pos));
}

function detectFormat(text, root) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const first = root.members.find(m => startsLine(text, m.keyStart));
  const unit = (first && indentOfLine(text, first.keyStart).slice(indentOfLine(text, root.start).length)) || '\t';
  return { eol, unit };
}

// Adds a member to an object after its last member, so a trailing comment on
// that line stays where it was. entryFor(indent) returns the member's text for
// a member that starts at that indentation.
function appendMember(text, obj, entryFor, { eol, unit }) {
  const objIndent = indentOfLine(text, obj.start);
  if (obj.members.length === 0) {
    const entry = entryFor(objIndent + unit);
    const body = text.slice(obj.start + 1, obj.end - 1);
    if (/^\s*$/.test(body)) {
      return text.slice(0, obj.start) + `{${eol}${objIndent}${unit}${entry}${eol}${objIndent}}` + text.slice(obj.end);
    }
    // Empty apart from comments: keep them, below the new member.
    const at = obj.start + 1;
    return text.slice(0, at) + `${eol}${objIndent}${unit}${entry}` + text.slice(at);
  }

  const last = obj.members[obj.members.length - 1];
  const afterLast = last.commaEnd || last.value.end;
  const comma = last.commaEnd ? '' : ',';
  if (!startsLine(text, last.keyStart)) {
    // Single-line object: { "a": {} }
    return text.slice(0, last.value.end) + comma + text.slice(last.value.end, afterLast)
      + ' ' + entryFor(objIndent + unit) + text.slice(afterLast);
  }
  const lineEnd = text.indexOf('\n', afterLast);
  const rest = lineEnd < 0 ? '' : text.slice(afterLast, lineEnd);
  const at = lineEnd >= 0 && /^[ \t]*(\/\/.*)?\r?$/.test(rest)
    ? (text[lineEnd - 1] === '\r' ? lineEnd - 1 : lineEnd)
    : afterLast;
  const indent = indentOfLine(text, last.keyStart);
  return text.slice(0, last.value.end) + comma + text.slice(last.value.end, at)
    + eol + indent + entryFor(indent) + text.slice(at);
}

function featureEntryValue(bridgePort) {
  return bridgePort && Number(bridgePort) !== DEFAULT_BRIDGE_PORT ? `{ "bridgePort": "${Number(bridgePort)}" }` : '{}';
}

/**
 * Adds our feature to a devcontainer.json's text.
 * Returns { text, changed, existingKey } — existingKey is set when the feature
 * (local or published) is already referenced, in which case nothing changes.
 */
function addFeatureToConfigText(text, { bridgePort } = {}) {
  const root = parseJsonc(text);
  if (root.type !== 'object') throw new Error('it is not a JSON object');
  const format = detectFormat(text, root);
  const { eol, unit } = format;
  const entry = `"${LOCAL_FEATURE_KEY}": ${featureEntryValue(bridgePort)}`;

  const features = root.members.find(m => m.key === 'features');
  if (features) {
    if (features.value.type !== 'object') throw new Error('its "features" is not an object');
    const existing = features.value.members.find(m => isOurFeatureKey(m.key));
    if (existing) return { text, changed: false, existingKey: existing.key };
    return { text: appendMember(text, features.value, () => entry, format), changed: true };
  }

  const block = indent => `"features": {${eol}${indent}${unit}${entry}${eol}${indent}}`;
  return { text: appendMember(text, root, block, format), changed: true };
}

/**
 * Removes our local feature entry from a devcontainer.json's text.
 * A published (ghcr.io) reference is left alone: the user added that, not us.
 */
function removeFeatureFromConfigText(text) {
  const features = findFeaturesObject(parseJsonc(text));
  if (!features) return { text, changed: false };
  const members = features.members;
  const idx = members.findIndex(m => isLocalKey(m.key));
  if (idx < 0) return { text, changed: false };
  const member = members[idx];

  let start = member.keyStart;
  let end = member.commaEnd || member.value.end;
  const after = /^[ \t]*(\r?\n)?/.exec(text.slice(end))[0];
  if (startsLine(text, start) && after.endsWith('\n')) {
    // The entry had its line to itself: drop the line.
    start = lineStartOf(text, start);
    end += after.length;
  } else {
    while (start > 0 && (text[start - 1] === ' ' || text[start - 1] === '\t')) start--;
  }
  let out = text.slice(0, start) + text.slice(end);
  // The last entry has no comma of its own: drop the one before it, which now
  // trails. Only the comma — a comment after it stays.
  if (!member.commaEnd && idx > 0) {
    const comma = members[idx - 1].commaEnd - 1;
    out = out.slice(0, comma) + out.slice(comma + 1);
  }
  return { text: out, changed: true };
}

// ── Project files ──────────────────────────────────────────────────────────────

const isFile = p => { try { return fs.statSync(p).isFile(); } catch { return false; } };

/**
 * The devcontainer.json files a chosen folder stands for. Accepts the project
 * root, its .devcontainer folder, or a .devcontainer/<name> folder. Local
 * features must live inside .devcontainer, so a root-level .devcontainer.json
 * is returned separately as `rootLevel` (not supported).
 */
function findDevcontainerConfigs(dir) {
  const base = path.basename(dir).toLowerCase();
  if (base !== '.devcontainer' && path.basename(path.dirname(dir)).toLowerCase() === '.devcontainer') {
    const p = path.join(dir, 'devcontainer.json');
    return { configs: isFile(p) ? [p] : [], rootLevel: null };
  }

  const devDir = base === '.devcontainer' ? dir : path.join(dir, '.devcontainer');
  const configs = [];
  if (isFile(path.join(devDir, 'devcontainer.json'))) configs.push(path.join(devDir, 'devcontainer.json'));
  // Projects with several configurations keep each in .devcontainer/<name>/.
  let entries = [];
  try { entries = fs.readdirSync(devDir, { withFileTypes: true }); } catch {}
  for (const e of entries) {
    if (!e.isDirectory() || e.name === FEATURE_ID) continue;
    const p = path.join(devDir, e.name, 'devcontainer.json');
    if (isFile(p)) configs.push(p);
  }
  const rootLevel = base !== '.devcontainer' && isFile(path.join(dir, '.devcontainer.json'))
    ? path.join(dir, '.devcontainer.json') : null;
  return { configs, rootLevel };
}

// Feature files as written to a project: LF line endings, since the scripts run
// in Linux and a checkout with core.autocrlf may have turned them into CRLF.
function readFeatureFiles(sourceDir = DEFAULT_SOURCE_DIR) {
  const files = {};
  for (const name of FEATURE_FILES) {
    files[name] = fs.readFileSync(path.join(sourceDir, name), 'utf8').replace(/\r\n/g, '\n');
  }
  // Keeps git on Windows from checking the scripts out with CRLF later.
  files['.gitattributes'] = '* text eol=lf\n';
  return files;
}

function featureDirFor(configPath) {
  return path.join(path.dirname(configPath), FEATURE_ID);
}

// Only a folder that is our feature is ever overwritten or deleted.
function isOurFeatureDir(dir) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'devcontainer-feature.json'), 'utf8'));
    return meta.id === FEATURE_ID;
  } catch {
    return false;
  }
}

/**
 * 'ok' | 'outdated' (files differ from the bundled copy) | 'published' (uses
 * the ghcr.io feature) | 'missing' (not set up, or the config is gone).
 */
function getFeatureStatus(configPath, { sourceDir } = {}) {
  let features;
  try { features = findFeaturesObject(parseJsonc(fs.readFileSync(configPath, 'utf8'))); } catch { return 'missing'; }
  const member = features && features.members.find(m => isOurFeatureKey(m.key));
  if (!member) return 'missing';
  if (!isLocalKey(member.key)) return 'published';

  const dir = featureDirFor(configPath);
  if (!isOurFeatureDir(dir)) return 'missing';
  for (const [name, content] of Object.entries(readFeatureFiles(sourceDir))) {
    let have;
    try { have = fs.readFileSync(path.join(dir, name), 'utf8'); } catch { return 'outdated'; }
    if (have !== content) return 'outdated';
  }
  return 'ok';
}

/**
 * Sets up (or refreshes) the feature for one devcontainer.json.
 * Returns { configChanged, filesWritten, publishedKey, warnings }.
 */
function installFeature(configPath, { sourceDir, bridgePort } = {}) {
  const raw = fs.readFileSync(configPath, 'utf8');
  let result;
  try {
    result = addFeatureToConfigText(raw, { bridgePort });
  } catch (err) {
    throw new Error(`Could not read ${configPath}: ${err.message}. It was left unchanged.`);
  }

  // Already uses the published feature: nothing to copy.
  const publishedKey = result.existingKey && !isLocalKey(result.existingKey) ? result.existingKey : null;

  let filesWritten = false;
  if (!publishedKey) {
    const dir = featureDirFor(configPath);
    if (fs.existsSync(dir) && !isOurFeatureDir(dir)) {
      throw new Error(`${dir} already exists and is not Insomnia's feature. Nothing was changed.`);
    }
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(readFeatureFiles(sourceDir))) {
      fs.writeFileSync(path.join(dir, name), content);
    }
    filesWritten = true;
  }

  if (result.changed) fs.writeFileSync(configPath, result.text);

  // Anthropic's reference Claude Code container blocks outbound traffic,
  // including the host bridge, unless its firewall script allows it.
  const warnings = [];
  const firewall = path.join(path.dirname(configPath), 'init-firewall.sh');
  const port = String(Number(bridgePort) || DEFAULT_BRIDGE_PORT);
  if (isFile(firewall) && !fs.readFileSync(firewall, 'utf8').includes(port)) {
    warnings.push(`init-firewall.sh blocks outbound traffic, including Insomnia. Allow port ${port} to host.docker.internal: see "Firewalled containers" in ${FEATURE_ID}/README.md.`);
  }

  return { configChanged: result.changed, filesWritten, publishedKey, warnings };
}

/** Undoes installFeature: removes our entry and our feature folder. */
function uninstallFeature(configPath) {
  let configChanged = false;
  try {
    const result = removeFeatureFromConfigText(fs.readFileSync(configPath, 'utf8'));
    if (result.changed) { fs.writeFileSync(configPath, result.text); configChanged = true; }
  } catch {}
  const dir = featureDirFor(configPath);
  const filesRemoved = isOurFeatureDir(dir);
  if (filesRemoved) fs.rmSync(dir, { recursive: true, force: true });
  return { configChanged, filesRemoved };
}

module.exports = {
  FEATURE_ID,
  LOCAL_FEATURE_KEY,
  parseJsonc,
  addFeatureToConfigText,
  removeFeatureFromConfigText,
  findDevcontainerConfigs,
  getFeatureStatus,
  installFeature,
  uninstallFeature
};
