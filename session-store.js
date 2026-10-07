/**
 * Session bookkeeping shared by everything that records agent activity.
 *
 * Three writers touch ~/.insomnia/agent-sessions.json:
 *   - agent-hook.js, spawned by Claude Code / Codex on this PC for every hook event
 *   - hook-bridge.js, inside the app, for hooks that arrive over HTTP from a dev
 *     container (Claude Code running in Linux cannot run a Windows hook)
 *   - main.js itself (Codex / Cursor transcript watchers)
 * and main.js reads it to decide whether to hold the PC awake. Keeping the rules
 * in one place means a session behaves the same wherever its hook came from.
 *
 * No Electron dependency: agent-hook.js runs this under ELECTRON_RUN_AS_NODE, and
 * the tests run it under plain Node.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const SESSIONS_DIR = path.join(os.homedir(), '.insomnia');
const SESSIONS_FILE = path.join(SESSIONS_DIR, 'agent-sessions.json');

// ── Timings ──────────────────────────────────────────────────────────────────
// Any hook event keeps the session awake for this long on its own.
const SESSION_TIMEOUT_MS = 3 * 60 * 1000;
// Ceiling for staying awake through silence (no hook firing) — a long build, a
// long test run, a long reply. Only ever applies while the agent process is
// still alive and something says work is still in flight.
const SESSION_TURN_GRACE_MS = 30 * 60 * 1000;
// A dev-container session proves its Claude process is alive by heartbeat
// (sent every 60s while a turn is open); allow two missed beats plus slack.
const REMOTE_HEARTBEAT_TTL_MS = 150 * 1000;
// Housekeeping: finished sessions are kept a day (so `stop_seen` survives
// between turns), anything untouched for a week is dropped.
const IDLE_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const STALE_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_OPEN_TOOLS = 64;

// ── File access ──────────────────────────────────────────────────────────────
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {}
}

function readSessions(file = SESSIONS_FILE) {
  // Writes are atomic (temp file + rename), so a parse failure normally means a
  // writer from an older build caught mid-write. Retry briefly rather than
  // treating the file as empty — writing an empty document back would wipe
  // every other session.
  for (let attempt = 0; attempt < 3; attempt++) {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') return { sessions: {} };
      sleepSync(20);
      continue;
    }
    try {
      const data = JSON.parse(raw);
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        if (!data.sessions || typeof data.sessions !== 'object' || Array.isArray(data.sessions)) data.sessions = {};
        return data;
      }
      break;
    } catch {
      sleepSync(20);
    }
  }
  return { sessions: {} };
}

function renameWithRetry(from, to) {
  // On Windows a rename over a file another process has open can fail
  // transiently (antivirus, indexer). A few short retries cover that.
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(from, to); return; }
    catch (err) {
      const transient = err && ['EPERM', 'EBUSY', 'EACCES'].includes(err.code);
      if (!transient || attempt >= 4) throw err;
      sleepSync(25 * (attempt + 1));
    }
  }
}

function writeSessions(data, file = SESSIONS_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  data.last_updated = new Date().toISOString();
  const json = JSON.stringify(data, null, 2);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, json);
    renameWithRetry(tmp, file);
  } catch {
    try { fs.unlinkSync(tmp); } catch {}
    fs.writeFileSync(file, json); // last resort: non-atomic write
  }
}

// Read, change, write. The mutator's return value is passed back.
function updateSessions(mutator, file = SESSIONS_FILE) {
  const data = readSessions(file);
  const result = mutator(data);
  writeSessions(data, file);
  return result;
}

// ── Hook events ──────────────────────────────────────────────────────────────
// How each Claude Code hook event moves a session along. Anything that is not
// listed falls back to the command the hook was registered with (`stay-awake`
// or `allow-sleep`), which is all older hook wiring and other tools provide.
const EVENT_EFFECTS = {
  UserPromptSubmit: 'new-turn',
  PreToolUse: 'tool-start',
  PostToolUse: 'tool-end',
  PostToolUseFailure: 'tool-end',
  PermissionRequest: 'activity',
  // Notification also fires *after* a turn ends ("waiting for your input"), so it
  // may refresh an open turn but must never open one. Earlier builds treated it
  // as activity, which re-armed the long grace a minute after every turn.
  Notification: 'touch',
  Stop: 'end-turn',
  StopFailure: 'end-turn',
  SessionEnd: 'end-session'
};

function effectFor(event, command) {
  if (event && EVENT_EFFECTS[event]) return EVENT_EFFECTS[event];
  if (command === 'allow-sleep') return 'end-turn';
  if (command === 'heartbeat') return 'heartbeat';
  return 'activity';
}

function safeString(value, max = 200) {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, max) : '';
}

function lastSeenMs(session) {
  return Math.max(
    Date.parse(session.last_activity || '') || 0,
    Date.parse(session.heartbeat_at || '') || 0,
    Date.parse(session.created_at || '') || 0
  );
}

function pruneSessions(data, now = Date.now()) {
  for (const [key, s] of Object.entries(data.sessions || {})) {
    if (!s || typeof s !== 'object') { delete data.sessions[key]; continue; }
    const age = now - lastSeenMs(s);
    if (age > STALE_SESSION_TTL_MS || (s.turn_open === false && age > IDLE_SESSION_TTL_MS)) {
      delete data.sessions[key];
    }
  }
}

/**
 * Apply one hook event to the sessions document (mutates `data`).
 *
 * @param {object} data      sessions document from readSessions()
 * @param {object} opts
 * @param {string} opts.integration  integration id, e.g. 'claude-code'
 * @param {string} [opts.command]    'stay-awake' | 'allow-sleep' | 'heartbeat'
 * @param {object} [opts.input]      the hook's JSON input (session_id, hook_event_name, tool_use_id, ...)
 * @param {number} [opts.now]        ms timestamp, for tests
 * @param {string} [opts.origin]     'local' (this PC) or where a bridged hook came from, e.g. 'devcontainer'
 * @param {string} [opts.host]       hostname the bridged hook came from
 * @returns {{ key: string, session: object|null, effect: string }}
 */
function applyHookEvent(data, { integration, command = 'stay-awake', input = {}, now = Date.now(), origin = 'local', host = '' } = {}) {
  if (!data.sessions || typeof data.sessions !== 'object') data.sessions = {};
  const safeInput = input && typeof input === 'object' ? input : {};
  const sessionId = safeString(safeInput.session_id) || 'default';
  const key = `${integration}:${sessionId}`;
  const event = safeString(safeInput.hook_event_name, 64);
  const toolId = safeString(safeInput.tool_use_id);
  const effect = effectFor(event, command);
  const nowIso = new Date(now).toISOString();

  pruneSessions(data, now);

  if (effect === 'end-session') {
    delete data.sessions[key];
    return { key, session: null, effect };
  }

  let s = data.sessions[key];
  // These only ever annotate a session that already exists. (An end-turn does
  // create one: a closed session holds nothing awake, and it records that this
  // session fires Stop before its next turn begins.)
  if (!s && (effect === 'touch' || effect === 'heartbeat')) {
    return { key, session: null, effect };
  }
  if (!s) {
    s = data.sessions[key] = { integration, session_id: sessionId, created_at: nowIso };
  }
  if (!s.open_tools || typeof s.open_tools !== 'object') s.open_tools = {};
  s.origin = safeString(origin, 32) || 'local';
  const safeHost = safeString(host, 64);
  if (safeHost) s.host = safeHost;

  switch (effect) {
    case 'new-turn':
      // A new prompt means the previous turn is over, whatever was left open
      // by an interrupted tool call.
      s.turn_open = true;
      s.open_tools = {};
      s.last_activity = nowIso;
      break;
    case 'tool-start':
      s.turn_open = true;
      if (toolId && Object.keys(s.open_tools).length < MAX_OPEN_TOOLS) s.open_tools[toolId] = nowIso;
      s.last_activity = nowIso;
      break;
    case 'tool-end':
      if (toolId) delete s.open_tools[toolId];
      // A late tool-end must not reopen a turn that has already ended.
      if (s.turn_open !== false) s.last_activity = nowIso;
      break;
    case 'touch':
      if (s.turn_open !== false) s.last_activity = nowIso;
      break;
    case 'end-turn':
      s.turn_open = false;
      s.open_tools = {};
      s.last_activity = nowIso;
      s.ended_at = nowIso;
      // Proof that this session reports the end of its turns. Until a session
      // has shown that, an open turn on its own is not trusted to mean "still
      // working": the Stop hook has been reported not to fire in the VS Code
      // extension, and trusting it there would hold the PC awake for the whole
      // grace window after every turn.
      if (event === 'Stop') s.stop_seen = true;
      break;
    case 'heartbeat':
      s.heartbeat_at = nowIso;
      break;
    default: // 'activity'
      s.turn_open = true;
      s.last_activity = nowIso;
  }

  return { key, session: s, effect };
}

// ── Decisions ────────────────────────────────────────────────────────────────
function hasOpenTools(session) {
  return !!session && !!session.open_tools && Object.keys(session.open_tools).length > 0;
}

function isRemoteSession(session) {
  return !!session && !!session.origin && session.origin !== 'local';
}

// Is the agent process behind this session still running? Local sessions use
// the caller's process check (claude.exe in tasklist); a dev container is
// invisible to Windows, so its sessions rely on heartbeats.
function isSessionAlive(session, now, localProcessAlive) {
  if (isRemoteSession(session)) {
    const beat = Date.parse(session.heartbeat_at || '');
    return Number.isFinite(beat) && now - beat < REMOTE_HEARTBEAT_TTL_MS;
  }
  return !!localProcessAlive;
}

/**
 * Should this turn-tracked session (Claude Code) hold the PC awake right now?
 *
 *  1. A turn that has ended (Stop / StopFailure) never does.
 *  2. Any hook event in the last 3 minutes does.
 *  3. Beyond that, and only up to 30 minutes of silence, while the agent
 *     process is still alive:
 *       - a tool call is still running (PreToolUse seen, PostToolUse not yet) —
 *         a long build or test run, where no hook fires until it finishes; or
 *       - the turn is still open in a session that has already shown it fires
 *         Stop at the end of its turns (covers a long reply with no tool use).
 */
function isTurnSessionActive(session, now = Date.now(), localProcessAlive = false) {
  if (!session || session.turn_open === false) return false;
  const last = Date.parse(session.last_activity || '');
  if (!Number.isFinite(last)) return false;
  const silence = now - last;
  if (silence < SESSION_TIMEOUT_MS) return true;
  if (silence >= SESSION_TURN_GRACE_MS) return false;
  if (!isSessionAlive(session, now, localProcessAlive)) return false;
  return hasOpenTools(session) || session.stop_seen === true;
}

module.exports = {
  SESSIONS_DIR,
  SESSIONS_FILE,
  SESSION_TIMEOUT_MS,
  SESSION_TURN_GRACE_MS,
  REMOTE_HEARTBEAT_TTL_MS,
  IDLE_SESSION_TTL_MS,
  STALE_SESSION_TTL_MS,
  readSessions,
  writeSessions,
  updateSessions,
  applyHookEvent,
  pruneSessions,
  hasOpenTools,
  isRemoteSession,
  isSessionAlive,
  isTurnSessionActive
};
