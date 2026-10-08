const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, powerSaveBlocker } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile, spawn } = require('child_process');
const store = require('./session-store');
const { createHookBridge, DEFAULT_BRIDGE_PORT } = require('./hook-bridge');
const devcontainerSetup = require('./devcontainer-setup');

// ── State ──────────────────────────────────────────────────────────────────────
let mainWindow = null;
let tray = null;
let powerSaveIds = [];
let pollInterval = null;
let isAwake = false;
let manualAwake = false;
let runningWatchedApps = [];
let activeIntegrations = [];
let config = { manualAwake: false, watchedApps: [], watchedIntegrations: [] };
let processLastSeen = {}; // integrationId → timestamp, for process-based grace period
let appLastSeen = {};     // exe.toLowerCase() → timestamp, for watched apps grace period
// Last tasklist output. Session checks triggered by a hook (file watcher, dev
// container bridge) reuse it rather than assuming no process is running — that
// assumption dropped the long-tool-call grace for up to 10s on every hook.
let lastTasklistLower = '';
let hookBridge = null;

const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');
const ASSETS = path.join(__dirname, 'assets');
// In production (asar), agent-hook.js is unpacked to app.asar.unpacked/
const HOOK_SCRIPT = app.isPackaged
  ? path.join(__dirname.replace('app.asar', 'app.asar.unpacked'), 'agent-hook.js')
  : path.join(__dirname, 'agent-hook.js');
const { SESSIONS_DIR, SESSIONS_FILE, SESSION_TIMEOUT_MS } = store;
// Hook launcher: a tiny .cmd shim so hooks never depend on the user having Node
// installed. It runs the app's own bundled Electron binary in Node mode, so a
// fresh install works on a machine with no Node runtime at all.
const HOOK_LAUNCHER = path.join(SESSIONS_DIR, 'insomnia-hook.cmd');
// Hook-based integrations without turn tracking (Codex, Cursor): while their
// process is alive, a session stays awake this long after its last activity.
const SESSION_PROCESS_GRACE_MS = 5 * 60 * 1000; // 5 minutes — covers long AI responses with no tool calls
// Claude Code reports turns and tool calls explicitly, so it uses the
// turn-aware rules in session-store.js instead (3 min after any hook, up to
// 30 min while a tool call is still running or an open turn can be trusted).
const PROCESS_GRACE_MS = 30 * 1000; // 30 seconds — grace period for process-based integrations/apps after process disappears

// ── Available Integrations ─────────────────────────────────────────────────────
const INTEGRATIONS = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    description: 'Keeps PC awake while Claude is actively working (terminal, VS Code, or a dev container)',
    hookBased: true,
    // Claude Code's hooks report turns (UserPromptSubmit … Stop) and tool calls
    // (PreToolUse / PostToolUse), so sessions are judged turn by turn — see
    // isTurnSessionActive() in session-store.js — instead of by silence alone.
    endOfTurnSignal: true,
    // The terminal CLI and the VS Code extension (its bundled
    // resources\native-binary\claude.exe) both show up as claude.exe. Sessions in
    // a dev container are not visible here; they prove liveness by heartbeat.
    processNames: ['claude.exe'],
    icon: 'claude'
  },
  {
    id: 'cursor',
    name: 'Cursor',
    description: 'Keeps PC awake while Cursor Agent is actively working on tasks',
    hookBased: true,
    processNames: ['cursor.exe'],
    icon: 'cursor'
  },
  {
    id: 'aider',
    name: 'Aider',
    description: 'Keeps PC awake while Aider is running',
    hookBased: false,
    processNames: ['aider.exe', 'aider'],
    icon: 'aider'
  },
  {
    id: 'codex-cli',
    name: 'OpenAI Codex',
    description: 'Keeps PC awake while Codex is actively working (CLI, VS Code, or desktop)',
    hookBased: true,
    processNames: ['codex.exe'],
    icon: 'codex'
  },
  {
    id: 'ollama',
    name: 'Ollama',
    description: 'Keeps PC awake while Ollama is running',
    hookBased: false,
    processNames: ['ollama.exe', 'ollama_llama_server.exe'],
    icon: 'ollama'
  }
];

// ── First-run detection ────────────────────────────────────────────────────────
// A fresh install should work with zero clicks: enable every integration whose
// tool is actually present on this machine, rather than shipping an app that sits
// there doing nothing until the user discovers the toggles. Only ever runs when
// there is no config.json, so it never overrides a choice the user has made.
const INTEGRATION_PROBES = {
  'claude-code': ['.claude'],
  'cursor': ['.cursor'],
  'aider': ['.aider.conf.yml', '.aider'],
  'codex-cli': ['.codex'],
  'ollama': ['.ollama']
};

function detectInstalledIntegrations() {
  const home = os.homedir();
  return INTEGRATIONS.filter(def =>
    (INTEGRATION_PROBES[def.id] || []).some(rel => {
      try { return fs.existsSync(path.join(home, rel)); } catch { return false; }
    })
  );
}

// Runs on every launch, not just the first: plenty of people install Insomnia
// before the coding tool they wanted it for, or add a second tool months later,
// and neither case should require finding the toggles. `seenIntegrations` records
// every id we have already offered, so an integration the user removed on purpose
// is never resurrected.
function autoEnableDetectedIntegrations() {
  let changed = false;

  // Anything already in the list has been decided on — never re-offer it.
  for (const integ of config.watchedIntegrations) {
    if (!config.seenIntegrations.includes(integ.id)) {
      config.seenIntegrations.push(integ.id);
      changed = true;
    }
  }

  for (const def of detectInstalledIntegrations()) {
    if (config.seenIntegrations.includes(def.id)) continue;
    config.watchedIntegrations.push({ id: def.id, name: def.name, enabled: true });
    config.seenIntegrations.push(def.id);
    changed = true;
  }

  if (changed) saveConfig();
  return changed;
}

// ── Config ─────────────────────────────────────────────────────────────────────
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    }
  } catch {}
  if (!config.watchedApps) config.watchedApps = [];
  if (!config.watchedIntegrations) config.watchedIntegrations = [];
  if (!config.seenIntegrations) config.seenIntegrations = [];
  // devcontainer.json files the dev container feature was added to from the app.
  if (!config.devcontainerProjects) config.devcontainerProjects = [];
  if (config.launchOnStartup === undefined) config.launchOnStartup = true;
  manualAwake = config.manualAwake || false;
}

function applyStartupSetting() {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: config.launchOnStartup });
}

function saveConfig() {
  config.manualAwake = manualAwake;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// ── Power Management ───────────────────────────────────────────────────────────
// One request only. Adding 'prevent-app-suspension' alongside it does nothing:
// Electron applies just the highest-precedence blocker, and 'prevent-display-sleep'
// outranks it — `powercfg /requests` confirms DISPLAY held and SYSTEM "None" even
// with both started. That is the right request to hold on this platform anyway: a
// Modern Standby (S0 low power idle) PC enters standby when the display turns off,
// so holding the display awake is what keeps the machine running. What Windows
// will still honour over any app request is an explicit sleep — closing the lid,
// the power button, or a critical battery action.
const POWER_BLOCKER_TYPE = 'prevent-display-sleep';

function ensurePowerBlockers() {
  // Re-asserted on every poll, not only on transition: a request that Windows or
  // Electron drops would otherwise leave the tray reporting "staying awake" while
  // nothing actually holds the machine up.
  if (powerSaveIds.some(id => powerSaveBlocker.isStarted(id))) return;
  powerSaveIds = [powerSaveBlocker.start(POWER_BLOCKER_TYPE)];
}

function releasePowerBlockers() {
  for (const id of powerSaveIds) {
    if (powerSaveBlocker.isStarted(id)) powerSaveBlocker.stop(id);
  }
  powerSaveIds = [];
}

function startCaffeinating() {
  ensurePowerBlockers();
  isAwake = true;
  updateTray();
  notifyRenderer();
}

function stopCaffeinating() {
  releasePowerBlockers();
  isAwake = false;
  updateTray();
  notifyRenderer();
}

function evaluateState() {
  const shouldBeAwake = manualAwake || runningWatchedApps.length > 0 || activeIntegrations.length > 0;
  if (shouldBeAwake && !isAwake) {
    startCaffeinating();
  } else if (!shouldBeAwake && isAwake) {
    stopCaffeinating();
  } else {
    // Already in the right state — but if we are meant to be awake, make sure the
    // requests are still registered with Windows before trusting the tray.
    if (isAwake) ensurePowerBlockers();
    updateTray();
    notifyRenderer();
  }
}

// ── Process Monitoring ─────────────────────────────────────────────────────────
function checkRunningProcesses() {
  // Collect all process names to check (apps + process-based integrations)
  const enabledApps = config.watchedApps.filter(a => a.enabled);
  const processIntegrations = config.watchedIntegrations
    .filter(i => i.enabled)
    .map(i => INTEGRATIONS.find(def => def.id === i.id))
    .filter(def => def && !def.hookBased && def.processNames);

  // Hook-based integrations may also have processNames for background task detection
  const hookIntegrations = config.watchedIntegrations
    .filter(i => i.enabled)
    .map(i => INTEGRATIONS.find(def => def.id === i.id))
    .filter(def => def && def.hookBased);

  const needsTasklist = enabledApps.length > 0 || processIntegrations.length > 0 || hookIntegrations.some(d => d.processNames);

  if (!needsTasklist) {
    runningWatchedApps = [];
    checkAgentSessions('');
    return;
  }

  const proc = spawn('tasklist', { stdio: 'pipe', shell: true, windowsHide: true });
  let output = '';
  proc.stdout.on('data', d => { output += d.toString(); });
  proc.on('close', () => {
    const lower = output.toLowerCase();
    lastTasklistLower = lower;

    // Check apps — with 30s grace period so a brief disappearance doesn't instantly deactivate
    const now = Date.now();
    for (const a of enabledApps) {
      if (lower.includes(a.exe.toLowerCase())) {
        appLastSeen[a.exe.toLowerCase()] = now;
      }
    }
    runningWatchedApps = enabledApps.filter(a => {
      const key = a.exe.toLowerCase();
      if (lower.includes(key)) return true;
      return (now - (appLastSeen[key] || 0)) < PROCESS_GRACE_MS;
    });

    // Check process-based integrations — with 30s grace period
    for (const def of processIntegrations) {
      const isRunning = def.processNames.some(p => lower.includes(p.toLowerCase()));
      if (isRunning) {
        processLastSeen[def.id] = now;
        if (!activeIntegrations.find(a => a.id === def.id)) {
          activeIntegrations.push({ id: def.id, name: def.name, reason: 'process' });
        }
      } else {
        const withinGrace = (now - (processLastSeen[def.id] || 0)) < PROCESS_GRACE_MS;
        if (!withinGrace) {
          activeIntegrations = activeIntegrations.filter(a => !(a.id === def.id && a.reason === 'process'));
        }
      }
    }

    checkAgentSessions(lower);
  });
  proc.on('error', () => {
    runningWatchedApps = [];
    checkAgentSessions('');
  });
}

// ── Agent Session Monitoring (Hook-based integrations) ─────────────────────────
// Where a session is running, for the tray tooltip.
const ORIGIN_LABELS = { devcontainer: 'dev container', wsl: 'WSL', remote: 'remote' };

function checkAgentSessions(tasklistLower = lastTasklistLower) {
  const hookIntegrations = config.watchedIntegrations
    .filter(i => i.enabled)
    .map(i => INTEGRATIONS.find(def => def.id === i.id))
    .filter(def => def && def.hookBased);

  // Remove stale hook-based entries
  activeIntegrations = activeIntegrations.filter(a => a.reason !== 'hook');

  if (hookIntegrations.length === 0) {
    evaluateState();
    return;
  }

  try {
    if (!fs.existsSync(SESSIONS_FILE)) {
      evaluateState();
      return;
    }

    const data = store.readSessions(SESSIONS_FILE);
    const now = Date.now();

    for (const def of hookIntegrations) {
      const sessions = Object.values(data.sessions || {}).filter(s => s && s.integration === def.id);

      // Is the integration's process running on this PC? (Covers long tool
      // calls and replies, during which no hook fires.)
      const processAlive = def.processNames && tasklistLower
        ? def.processNames.some(p => tasklistLower.includes(p.toLowerCase()))
        : false;

      if (def.endOfTurnSignal) {
        // Claude Code: judged session by session, wherever it runs. Local
        // sessions borrow claude.exe's liveness; dev container sessions carry
        // their own heartbeat.
        const active = sessions.filter(s => store.isTurnSessionActive(s, now, processAlive));
        if (active.length > 0) {
          const remoteOnly = active.every(s => store.isRemoteSession(s));
          const where = remoteOnly ? (ORIGIN_LABELS[active[0].origin] || ORIGIN_LABELS.remote) : '';
          activeIntegrations.push({ id: def.id, name: where ? `${def.name} (${where})` : def.name, reason: 'hook' });
        }
        continue;
      }

      // Everything else: recent activity, or a grace period while the process lives.
      const lastActivities = sessions.map(s => new Date(s.last_activity).getTime()).filter(Number.isFinite);
      const hasRecentHook = lastActivities.some(t => (now - t) < SESSION_TIMEOUT_MS);
      const withinGracePeriod = lastActivities.some(t => (now - t) < SESSION_PROCESS_GRACE_MS);

      if (hasRecentHook || (processAlive && withinGracePeriod)) {
        activeIntegrations.push({ id: def.id, name: def.name, reason: 'hook' });
      }
    }
  } catch {}

  evaluateState();
}

// ── Session File Watcher (instant response to hook activity) ─────────────────
let sessionWatcher = null;
let watchDebounce = null;

// Debounced re-check — hooks can fire in rapid succession.
function scheduleSessionCheck() {
  if (watchDebounce) clearTimeout(watchDebounce);
  watchDebounce = setTimeout(() => {
    watchDebounce = null;
    checkAgentSessions();
  }, 200);
}

function watchSessionFile() {
  // Ensure the directory and file exist before watching
  if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  }
  if (!fs.existsSync(SESSIONS_FILE)) {
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify({ sessions: {} }, null, 2));
  }

  try {
    // Watch the folder, not the file: hooks now replace the file atomically
    // (write a temp file, rename it over), and a watch on the old file would go
    // quiet after the first replace on some platforms.
    const sessionsName = path.basename(SESSIONS_FILE);
    sessionWatcher = fs.watch(SESSIONS_DIR, (_event, filename) => {
      if (filename && filename.toString() !== sessionsName) return;
      scheduleSessionCheck();
    });

    sessionWatcher.on('error', () => {
      // File may be deleted/recreated — retry after a delay
      if (sessionWatcher) { sessionWatcher.close(); sessionWatcher = null; }
      setTimeout(watchSessionFile, 5000);
    });
  } catch {}
}

// ── Cursor Agent Activity Watcher ─────────────────────────────────────────────
// Cursor writes ~/.cursor/projects/*/agent-transcripts/**/*.jsonl during active
// Agent sessions. Poll those files every 5s — same approach used for Codex.
const CURSOR_PROJECTS_DIR = path.join(os.homedir(), '.cursor', 'projects');
let cursorWatchRetryTimer = null;
let cursorPollInterval = null;
let cursorTranscriptSnapshots = new Map();

function getCursorTranscriptFiles() {
  const files = [];
  const stack = [CURSOR_PROJECTS_DIR];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(fullPath);
    }
  }
  return files;
}

function syncCursorTranscriptSnapshots() {
  for (const filePath of getCursorTranscriptFiles()) {
    const snapshot = getFileSnapshot(filePath);
    if (snapshot) cursorTranscriptSnapshots.set(filePath, snapshot);
  }
}

function recordCursorActivity() {
  const isEnabled = config.watchedIntegrations.some(i => i.id === 'cursor' && i.enabled);
  if (!isEnabled) return;
  try {
    // Records `cursor:agent` with a fresh last_activity (atomic write).
    store.updateSessions(data => store.applyHookEvent(data, {
      integration: 'cursor', command: 'stay-awake', input: { session_id: 'agent' }
    }));
    checkAgentSessions();
  } catch {}
}

function handleCursorTranscriptChange() {
  let changed = false;
  const seen = new Set();
  for (const filePath of getCursorTranscriptFiles()) {
    seen.add(filePath);
    const snapshot = getFileSnapshot(filePath);
    if (!snapshot) continue;
    if (cursorTranscriptSnapshots.get(filePath) !== snapshot) {
      cursorTranscriptSnapshots.set(filePath, snapshot);
      changed = true;
    }
  }
  for (const filePath of Array.from(cursorTranscriptSnapshots.keys())) {
    if (!seen.has(filePath)) cursorTranscriptSnapshots.delete(filePath);
  }
  if (!changed) return;
  recordCursorActivity();
}

function scheduleCursorWatchRetry(delayMs) {
  if (cursorWatchRetryTimer) clearTimeout(cursorWatchRetryTimer);
  cursorWatchRetryTimer = setTimeout(() => {
    cursorWatchRetryTimer = null;
    watchCursorFiles();
  }, delayMs);
}

function watchCursorFiles() {
  stopCursorWatcher();
  if (!fs.existsSync(CURSOR_PROJECTS_DIR)) {
    scheduleCursorWatchRetry(30000);
    return;
  }
  syncCursorTranscriptSnapshots();
  cursorPollInterval = setInterval(handleCursorTranscriptChange, 5000);
}

function stopCursorWatcher() {
  if (cursorWatchRetryTimer) { clearTimeout(cursorWatchRetryTimer); cursorWatchRetryTimer = null; }
  if (cursorPollInterval) { clearInterval(cursorPollInterval); cursorPollInterval = null; }
}

// ── Codex App / VS Code Activity Watcher ──────────────────────────────────────
// Codex surfaces that run through `codex.exe app-server` do not fire the notify
// hook from config.toml. Avoid watching Codex SQLite DBs here: they can update
// while the app server is idle. Session JSONL files track actual turn activity.
const CODEX_SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions');
let codexWatchRetryTimer = null;
let codexPollInterval = null;
let codexSessionSnapshots = new Map();

function getFileSnapshot(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
}

function getCodexSessionFiles() {
  const files = [];
  const stack = [CODEX_SESSIONS_DIR];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(fullPath);
    }
  }
  return files;
}

function syncCodexSessionSnapshots() {
  for (const filePath of getCodexSessionFiles()) {
    const snapshot = getFileSnapshot(filePath);
    if (snapshot) codexSessionSnapshots.set(filePath, snapshot);
  }
}

function scheduleCodexWatchRetry(delayMs) {
  if (codexWatchRetryTimer) clearTimeout(codexWatchRetryTimer);
  codexWatchRetryTimer = setTimeout(() => {
    codexWatchRetryTimer = null;
    watchCodexFiles();
  }, delayMs);
}

function recordCodexActivity() {
  const isEnabled = config.watchedIntegrations.some(i => i.id === 'codex-cli' && i.enabled);
  if (!isEnabled) return;
  try {
    // Records `codex-cli:app-server` with a fresh last_activity (atomic write).
    store.updateSessions(data => store.applyHookEvent(data, {
      integration: 'codex-cli', command: 'stay-awake', input: { session_id: 'app-server' }
    }));
    checkAgentSessions();
  } catch {}
}

function handleCodexSessionFileChange() {
  let changed = false;
  const seen = new Set();

  for (const filePath of getCodexSessionFiles()) {
    seen.add(filePath);
    const snapshot = getFileSnapshot(filePath);
    if (!snapshot) continue;
    if (codexSessionSnapshots.get(filePath) !== snapshot) {
      codexSessionSnapshots.set(filePath, snapshot);
      changed = true;
    }
  }

  for (const filePath of Array.from(codexSessionSnapshots.keys())) {
    if (!seen.has(filePath)) codexSessionSnapshots.delete(filePath);
  }

  if (!changed) return;

  recordCodexActivity();
}

function watchCodexFiles() {
  stopCodexWatcher();

  if (!fs.existsSync(CODEX_SESSIONS_DIR)) {
    scheduleCodexWatchRetry(30000);
    return;
  }

  syncCodexSessionSnapshots();
  codexPollInterval = setInterval(handleCodexSessionFileChange, 5000);
}

function stopCodexWatcher() {
  if (codexWatchRetryTimer) { clearTimeout(codexWatchRetryTimer); codexWatchRetryTimer = null; }
  if (codexPollInterval) { clearInterval(codexPollInterval); codexPollInterval = null; }
}

// ── Hook launcher ──────────────────────────────────────────────────────────────
// Agent hooks are spawned by the coding tools themselves (Claude Code, Codex),
// in whatever environment those tools run in. Bare `node` is not guaranteed to
// exist there — on a machine without Node installed every hook fails silently.
// Insomnia already ships a Node runtime inside Electron, so we write a small
// .cmd shim that re-execs our own binary in Node mode and point hooks at that.
// Regenerated on every launch so the path survives upgrades and reinstalls.
function ensureHookLauncher() {
  try {
    if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

    const exeWin = process.execPath;
    const hookWin = HOOK_SCRIPT;
    const exePosix = exeWin.split('\\').join('/');
    const hookPosix = hookWin.split('\\').join('/');

    // Batch/shell polyglot. We do not control which shell the host tool uses to
    // spawn hooks: cmd.exe runs the batch half (line 1 is just a label to it),
    // while a POSIX shell such as Git Bash runs line 1 and execs away before it
    // ever reaches the batch lines. Either way the same command runs.
    const lines = [
      ':; export ELECTRON_RUN_AS_NODE=1; exec "' + exePosix + '" "' + hookPosix + '" "$@" # trailing CR is absorbed by this comment',
      '@echo off',
      'rem Auto-generated by Insomnia - do not edit; rewritten on every launch.',
      'set ELECTRON_RUN_AS_NODE=1',
      '"' + exeWin + '" "' + hookWin + '" %*',
      ''
    ];
    fs.writeFileSync(HOOK_LAUNCHER, lines.join('\r\n'));
    return true;
  } catch {
    return false;
  }
}

// Any hook command Insomnia has ever written, across versions: the current .cmd
// shim, the older bare-`node` form, and the pre-rename cc-caffeine builds.
function isInsomniaHookCommand(command) {
  if (!command || typeof command !== 'string') return false;
  return command.includes('insomnia-hook.cmd')
    || command.includes('agent-hook.js')
    || command.includes('cc-caffeine');
}

// A Claude Code hook handler Insomnia wrote: shell form (command string) or
// exec form (cmd.exe with the launcher among its args).
function isInsomniaHookHandler(handler) {
  if (!handler || typeof handler !== 'object') return false;
  if (isInsomniaHookCommand(handler.command)) return true;
  return Array.isArray(handler.args) && handler.args.some(isInsomniaHookCommand);
}

// ── Claude Code Hook Setup ─────────────────────────────────────────────────────
function getClaudeSettingsPath() {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

function getCmdExePath() {
  const comspec = process.env.ComSpec || process.env.COMSPEC;
  if (comspec && /cmd\.exe$/i.test(comspec)) return comspec;
  return path.join(process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows', 'System32', 'cmd.exe');
}

// The hook handler Claude Code runs for one of our commands.
//
// Claude Code runs a hook *string* through Git Bash on Windows — or through
// PowerShell when it cannot find Git Bash, which is common with the VS Code
// extension. The old string, `"C:\…\insomnia-hook.cmd" stay-awake claude-code`,
// is a parse error in PowerShell (a quoted string followed by bare words), so on
// those machines every Insomnia hook failed and Claude Code was never detected.
//
// Exec form (`args`, Claude Code 2.1.139+) avoids shells altogether: Claude Code
// starts cmd.exe directly with an argument list. `.cmd` files cannot be started
// that way themselves, hence cmd.exe /c. cmd keeps the quotes libuv puts around a
// launcher path with spaces only while the path holds none of & < > ( ) @ ^ |;
// for the rare profile folder that does, keep the shell form, which Git Bash runs.
function buildClaudeHookHandler(hookCommand) {
  if (process.platform === 'win32' && !/[&<>()@^|%!"]/.test(HOOK_LAUNCHER)) {
    return {
      type: 'command',
      command: getCmdExePath(),
      args: ['/d', '/c', HOOK_LAUNCHER, hookCommand, 'claude-code'],
      timeout: 30
    };
  }
  return { type: 'command', command: `"${HOOK_LAUNCHER}" ${hookCommand} claude-code`, timeout: 30 };
}

function setupClaudeCodeHooks() {
  const settingsPath = getClaudeSettingsPath();
  let settings = {};

  try {
    if (fs.existsSync(settingsPath)) {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    }
  } catch {
    // Unreadable or hand-broken settings: leave the file alone rather than
    // overwrite the user's other settings with just our hooks.
    return;
  }

  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};

  ensureHookLauncher();

  const stayAwakeHook = { hooks: [buildClaudeHookHandler('stay-awake')] };
  const allowSleepHook = { hooks: [buildClaudeHookHandler('allow-sleep')] };

  // Activity. The event name travels in the hook's JSON, so the hook script
  // tells a new prompt from a tool starting or finishing (see session-store.js).
  // Notification is deliberately absent: it also fires a minute *after* a turn
  // ends ("waiting for your input") and used to re-arm the grace period then.
  const stayAwakeEvents = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest'];
  // End of a turn: Stop when Claude finishes, StopFailure when an API error ends
  // it instead. SessionEnd covers the session going away entirely.
  const allowSleepEvents = ['Stop', 'StopFailure', 'SessionEnd'];

  // Clear out hooks from every previous Insomnia build first — including events
  // we no longer manage (older versions wrote a `Stop` hook) and stale absolute
  // paths left behind by an install under a different user profile. Without this
  // sweep those dead commands linger and fail on every hook event.
  for (const event of Object.keys(settings.hooks)) {
    if (!Array.isArray(settings.hooks[event])) continue;
    settings.hooks[event] = settings.hooks[event].filter(h =>
      !h.hooks?.some(isInsomniaHookHandler)
    );
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }

  for (const event of stayAwakeEvents) {
    if (!settings.hooks[event]) settings.hooks[event] = [];
    settings.hooks[event].push(stayAwakeHook);
  }

  for (const event of allowSleepEvents) {
    if (!settings.hooks[event]) settings.hooks[event] = [];
    settings.hooks[event].push(allowSleepHook);
  }

  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

function removeClaudeCodeHooks() {
  const settingsPath = getClaudeSettingsPath();
  try {
    if (!fs.existsSync(settingsPath)) return;
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    if (!settings.hooks) return;

    for (const event of Object.keys(settings.hooks)) {
      if (!Array.isArray(settings.hooks[event])) continue;
      settings.hooks[event] = settings.hooks[event].filter(h =>
        !h.hooks?.some(isInsomniaHookHandler)
      );
      if (settings.hooks[event].length === 0) {
        delete settings.hooks[event];
      }
    }

    if (Object.keys(settings.hooks).length === 0) {
      delete settings.hooks;
    }

    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  } catch {}
}

// ── Codex Hook Setup ───────────────────────────────────────────────────────────
// Codex (CLI / VS Code extension / desktop) all read ~/.codex/config.toml.
// The `notify` field runs a command on agent-turn-complete events — we use it
// as a heartbeat so Insomnia knows Codex is actively being used, not just sitting open.
function getCodexConfigPath() {
  return path.join(os.homedir(), '.codex', 'config.toml');
}

const INSOMNIA_NOTIFY_MARKER = '# Insomnia notify hook (auto-managed)';

function buildCodexNotifyLine() {
  // TOML literal strings (single quotes) keep Windows backslashes intact, and
  // Codex spawns notify through CreateProcess, which cannot launch a .cmd
  // directly — hence the cmd /c wrapper.
  return `notify = ['cmd', '/c', '${HOOK_LAUNCHER}', 'stay-awake', 'codex-cli']`;
}

// Recognise Insomnia's own notify line in any form we have ever written.
function isInsomniaNotifyLine(line) {
  return line.includes('insomnia-hook.cmd') || line.includes('agent-hook.js');
}

function hasExternalCodexNotify(lines) {
  let inSection = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) {
      inSection = true;
      continue;
    }
    if (!inSection && /^\s*notify\s*=/.test(line) && !isInsomniaNotifyLine(line)) {
      return true;
    }
  }
  return false;
}

// Strip only Insomnia's Codex notify hook, leaving user-managed notify commands alone.
function stripCodexNotify(lines) {
  const out = [];
  let inSection = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === INSOMNIA_NOTIFY_MARKER) continue;
    if (trimmed.startsWith('[')) {
      inSection = true;
      out.push(line);
      continue;
    }
    if (!inSection && /^\s*notify\s*=/.test(line)) {
      if (isInsomniaNotifyLine(line)) continue;
    }
    out.push(line);
  }
  // Collapse runs of blank lines to a single blank, and trim leading/trailing blanks.
  const collapsed = [];
  for (const line of out) {
    if (line.trim() === '' && collapsed.length > 0 && collapsed[collapsed.length - 1].trim() === '') continue;
    collapsed.push(line);
  }
  while (collapsed.length && collapsed[0].trim() === '') collapsed.shift();
  while (collapsed.length && collapsed[collapsed.length - 1].trim() === '') collapsed.pop();
  return collapsed;
}

function setupCodexHooks() {
  ensureHookLauncher();
  const configPath = getCodexConfigPath();
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  let content = '';
  try {
    if (fs.existsSync(configPath)) content = fs.readFileSync(configPath, 'utf8');
  } catch {}

  const stripped = stripCodexNotify(content.split(/\r?\n/));

  // Codex only honours one top-level notify command. If the user already has
  // their own, preserve it and rely on transcript polling for app-server activity.
  if (hasExternalCodexNotify(stripped)) {
    fs.writeFileSync(configPath, stripped.length ? stripped.join('\n') + '\n' : '');
    return;
  }

  // Prepend our notify block; pad with a blank line before any further content.
  const block = [INSOMNIA_NOTIFY_MARKER, buildCodexNotifyLine()];
  if (stripped.length > 0) block.push('');
  const finalLines = [...block, ...stripped];

  fs.writeFileSync(configPath, finalLines.join('\n') + '\n');
}

function removeCodexHooks() {
  const configPath = getCodexConfigPath();
  if (!fs.existsSync(configPath)) return;
  try {
    const content = fs.readFileSync(configPath, 'utf8');
    const lines = stripCodexNotify(content.split(/\r?\n/));
    fs.writeFileSync(configPath, lines.length ? lines.join('\n') + '\n' : '');
  } catch {}
}

// ── Dev container bridge ───────────────────────────────────────────────────────
// Claude Code inside a dev container runs its hooks in Linux, where neither the
// launcher nor %USERPROFILE%\.insomnia exist. The container-side hook (see
// devcontainer-features/) reports to this loopback endpoint instead, which
// Docker Desktop exposes to containers as host.docker.internal.
function getBridgePort() {
  const port = Number(config.bridgePort);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_BRIDGE_PORT;
}

function startHookBridge() {
  if (!hookBridge) {
    hookBridge = createHookBridge({
      port: getBridgePort(),
      isEnabled: id => config.watchedIntegrations.some(i => i.id === id && i.enabled),
      onActivity: scheduleSessionCheck,
      version: app.getVersion(),
      log: msg => console.log(msg)
    });
  }
  hookBridge.start();
}

function stopHookBridge() {
  if (hookBridge) hookBridge.stop();
}

// ── Dev container projects ─────────────────────────────────────────────────────
// Adds the claude-code-stay-awake feature to a project's devcontainer.json (see
// devcontainer-setup.js), so the bridge above hears from its container.
function getDevcontainerProjects() {
  return config.devcontainerProjects.map(p => {
    const configPath = p.configPath;
    const devDir = path.dirname(configPath);
    const inNamedConfig = path.basename(devDir).toLowerCase() !== '.devcontainer';
    const projectDir = inNamedConfig ? path.dirname(path.dirname(devDir)) : path.dirname(devDir);
    return {
      configPath,
      name: path.basename(projectDir) + (inNamedConfig ? ` (${path.basename(devDir)})` : ''),
      detail: path.relative(projectDir, configPath),
      status: devcontainerSetup.getFeatureStatus(configPath)
    };
  });
}

function rememberDevcontainerProject(configPath) {
  const key = configPath.toLowerCase();
  if (!config.devcontainerProjects.some(p => p.configPath.toLowerCase() === key)) {
    config.devcontainerProjects.push({ configPath });
  }
}

function findDevcontainerProject(configPath) {
  return config.devcontainerProjects.find(p => p.configPath === configPath);
}

async function addDevcontainerProject() {
  const pick = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a project that has a dev container',
    properties: ['openDirectory']
  });
  if (pick.canceled || pick.filePaths.length === 0) return { projects: getDevcontainerProjects() };

  const { configs, rootLevel } = devcontainerSetup.findDevcontainerConfigs(pick.filePaths[0]);
  if (configs.length === 0) {
    const error = rootLevel
      ? 'This project keeps its config in .devcontainer.json at the top level. Move it to .devcontainer/devcontainer.json and try again: a local feature has to live in the .devcontainer folder.'
      : 'No .devcontainer/devcontainer.json in that folder. Choose the project folder (or its .devcontainer folder).';
    return { projects: getDevcontainerProjects(), error };
  }

  let added = 0;
  const warnings = [];
  const errors = [];
  for (const configPath of configs) {
    try {
      const r = devcontainerSetup.installFeature(configPath, { bridgePort: getBridgePort() });
      rememberDevcontainerProject(configPath);
      if (r.publishedKey) warnings.push(`${path.relative(pick.filePaths[0], configPath) || 'devcontainer.json'} already uses ${r.publishedKey}; left as it is.`);
      else added++;
      warnings.push(...r.warnings);
    } catch (err) {
      errors.push(err.message);
    }
  }
  saveConfig();
  const where = configs.length > 1 ? ` to ${added} of ${configs.length} configurations` : '';
  return {
    projects: getDevcontainerProjects(),
    message: added ? `Added${where}. Rebuild the container to apply it.` : undefined,
    warnings,
    error: errors.join(' ') || undefined
  };
}

function updateDevcontainerProject(configPath) {
  if (!findDevcontainerProject(configPath)) return { projects: getDevcontainerProjects() };
  try {
    const r = devcontainerSetup.installFeature(configPath, { bridgePort: getBridgePort() });
    return { projects: getDevcontainerProjects(), message: 'Updated. Rebuild the container to apply it.', warnings: r.warnings };
  } catch (err) {
    return { projects: getDevcontainerProjects(), error: err.message };
  }
}

async function removeDevcontainerProject(configPath) {
  const entry = findDevcontainerProject(configPath);
  if (!entry) return { projects: getDevcontainerProjects() };

  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    buttons: ['Remove from project', 'Only forget it', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    title: 'Remove dev container feature',
    message: `Remove Insomnia from ${configPath}?`,
    detail: `"Remove from project" deletes the ${devcontainerSetup.FEATURE_ID} folder and its entry in devcontainer.json. "Only forget it" leaves the project as it is.`
  });
  if (response === 2) return { projects: getDevcontainerProjects() };

  let message;
  if (response === 0) {
    const r = devcontainerSetup.uninstallFeature(configPath);
    message = r.configChanged || r.filesRemoved ? 'Removed. Rebuild the container to apply it.' : undefined;
  }
  config.devcontainerProjects = config.devcontainerProjects.filter(p => p !== entry);
  saveConfig();
  return { projects: getDevcontainerProjects(), message };
}

// ── Hook dispatch ──────────────────────────────────────────────────────────────
function setupHooksForIntegration(integrationId) {
  if (integrationId === 'claude-code') { setupClaudeCodeHooks(); startHookBridge(); }
  else if (integrationId === 'codex-cli') { setupCodexHooks(); watchCodexFiles(); }
  else if (integrationId === 'cursor') watchCursorFiles();
}

function removeHooksForIntegration(integrationId) {
  if (integrationId === 'claude-code') { removeClaudeCodeHooks(); stopHookBridge(); }
  else if (integrationId === 'codex-cli') { removeCodexHooks(); stopCodexWatcher(); }
  else if (integrationId === 'cursor') stopCursorWatcher();
}

// ── Tray ───────────────────────────────────────────────────────────────────────
function getTooltip() {
  if (!isAwake) return 'Inactive';

  const reasons = [];
  if (manualAwake) reasons.push('Manually triggered');
  if (runningWatchedApps.length > 0) {
    reasons.push(runningWatchedApps.map(a => a.name).join(', '));
  }
  if (activeIntegrations.length > 0) {
    reasons.push(activeIntegrations.map(a => a.name).join(', '));
  }
  return 'Staying awake for \u2014 ' + reasons.join(', ');
}

function updateTray() {
  if (!tray) return;
  const iconFile = isAwake ? 'tray-active.png' : 'tray-inactive.png';
  tray.setImage(path.join(ASSETS, iconFile));
  tray.setToolTip(getTooltip());
}

function createTray() {
  tray = new Tray(path.join(ASSETS, 'tray-inactive.png'));
  tray.setToolTip('Inactive');

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show Insomnia', click: () => { mainWindow.show(); } },
    { type: 'separator' },
    {
      label: 'Toggle Awake',
      click: () => {
        manualAwake = !manualAwake;
        saveConfig();
        evaluateState();
      }
    },
    { type: 'separator' },
    {
      label: 'Exit',
      click: () => {
        releasePowerBlockers();
        app.quit();
      }
    }
  ]);
  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => { mainWindow.show(); });

  // Try to promote tray icon to always-visible on Windows
  promoteTrayIcon();
}

function promoteTrayIcon() {
  // Windows stores tray icon visibility in registry under NotifyIconSettings.
  // We find our app's entry and set IsPromoted=1 to show it in the main tray area.
  const exePath = app.getPath('exe');
  const psScript = `
    $regPath = 'HKCU:\\Control Panel\\NotifyIconSettings'
    if (Test-Path $regPath) {
      Get-ChildItem $regPath -ErrorAction SilentlyContinue | ForEach-Object {
        $execPath = (Get-ItemProperty $_.PSPath -Name 'ExecutablePath' -ErrorAction SilentlyContinue).ExecutablePath
        if ($execPath -and $execPath -like '*Insomnia*') {
          Set-ItemProperty $_.PSPath -Name 'IsPromoted' -Value 1 -Type DWord -ErrorAction SilentlyContinue
        }
      }
    }
  `;
  execFile('powershell', ['-NoProfile', '-Command', psScript], { windowsHide: true }, () => {});
}

// ── App Discovery ──────────────────────────────────────────────────────────────
function discoverInstalledApps() {
  return new Promise((resolve) => {
    const tmpFile = require('path').join(require('os').tmpdir(), 'insomnia-apps.json');
    const psScript = `
      [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
      $OutputEncoding = [System.Text.Encoding]::UTF8
      $shell = New-Object -ComObject WScript.Shell
      $apps = @{}

      $lnkPaths = @(
        [Environment]::GetFolderPath('CommonStartMenu') + '\\Programs',
        [Environment]::GetFolderPath('StartMenu') + '\\Programs'
      )
      foreach ($dir in $lnkPaths) {
        if (Test-Path $dir) {
          Get-ChildItem -Path $dir -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
            try {
              $shortcut = $shell.CreateShortcut($_.FullName)
              $target = $shortcut.TargetPath
              if ($target -and $target -match '\\.exe$' -and (Test-Path $target -ErrorAction SilentlyContinue)) {
                $name = [System.IO.Path]::GetFileNameWithoutExtension($_.Name)
                $key = $target.ToLower()
                if (-not $apps.ContainsKey($key)) {
                  $apps[$key] = @{ name = $name; exe = $target }
                }
              }
            } catch {}
          }
        }
      }

      # Executables that are updaters/wrappers and never have the real app icon
      $badExeNames = @('update.exe','uninstall.exe','uninst.exe','unins000.exe','squirrel.exe','chrome_proxy.exe','createdump.exe','crashpad_handler.exe','elevate.exe','notification_helper.exe')

      function Find-BestExe($displayName, $iconPath, $installLocation) {
        $exe = ''
        # Extract exe from DisplayIcon (may include args like "Update.exe --processStart Discord.exe")
        if ($iconPath) {
          # Try to grab the LAST .exe in the string (often the real app after --processStart)
          $allExes = [regex]::Matches($iconPath, '(?i)[\w\-. ]+\.exe')
          foreach ($m in ($allExes | Select-Object -Last 5)) {
            $candidate = $m.Value.Trim()
            if ($badExeNames -notcontains $candidate.ToLower()) {
              # Try to find this exe under the install location
              if ($installLocation -and (Test-Path $installLocation -ErrorAction SilentlyContinue)) {
                $found = Get-ChildItem -Path $installLocation -Filter $candidate -Recurse -Depth 3 -ErrorAction SilentlyContinue | Select-Object -First 1
                if ($found) { $exe = $found.FullName; break }
              }
            }
          }
          # Fallback: grab the first full path .exe from DisplayIcon
          if (-not $exe -and $iconPath -match '(?i)^"?([A-Za-z]:[^"]+\.exe)') {
            $candidate = $Matches[1]
            if ((Test-Path $candidate -ErrorAction SilentlyContinue) -and ($badExeNames -notcontains [System.IO.Path]::GetFileName($candidate).ToLower())) {
              $exe = $candidate
            }
          }
        }
        # Search install location for a well-named exe
        if (-not $exe -and $installLocation -and (Test-Path $installLocation -ErrorAction SilentlyContinue)) {
          # Prefer an exe whose name resembles the app display name
          $safeName = ($displayName -replace '[^a-zA-Z0-9]', '').ToLower()
          $candidates = Get-ChildItem -Path $installLocation -Filter '*.exe' -Recurse -Depth 3 -ErrorAction SilentlyContinue |
            Where-Object { $badExeNames -notcontains $_.Name.ToLower() } |
            Sort-Object { [int]($_.Name.ToLower() -replace '[^a-z0-9]','' -eq $safeName) } -Descending |
            Select-Object -First 1
          if ($candidates) { $exe = $candidates.FullName }
        }
        # Last resort: use whatever the icon path says, even if it's a bad exe
        if (-not $exe -and $iconPath -and $iconPath -match '(?i)^"?([A-Za-z]:[^",]+\.exe)') {
          $candidate = $Matches[1]
          if (Test-Path $candidate -ErrorAction SilentlyContinue) { $exe = $candidate }
        }
        return $exe
      }

      $regPaths = @(
        'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
        'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
        'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
      )
      foreach ($p in $regPaths) {
        try {
          Get-ItemProperty $p -ErrorAction SilentlyContinue |
            Where-Object { $_.DisplayName -and $_.DisplayName -notmatch '^ms-resource:' } |
            ForEach-Object {
              $exe = Find-BestExe $_.DisplayName $_.DisplayIcon $_.InstallLocation
              if ($exe -and (Test-Path $exe -ErrorAction SilentlyContinue)) {
                # Skip Store apps (WindowsApps folder) — AppX section handles them better
                if ($exe -match '\\WindowsApps\\') { return }
                $key = $exe.ToLower()
                if (-not $apps.ContainsKey($key)) {
                  $apps[$key] = @{ name = $_.DisplayName; exe = $exe }
                }
              }
            }
        } catch {}
      }

      try {
        Get-AppxPackage -ErrorAction SilentlyContinue |
          Where-Object { $_.IsFramework -eq $false -and $_.SignatureKind -eq 'Store' } |
          ForEach-Object {
            try {
              $manifest = Join-Path $_.InstallLocation 'AppxManifest.xml'
              if (Test-Path $manifest) {
                [xml]$xml = Get-Content $manifest -ErrorAction SilentlyContinue

                # Resolve display name — prefer VisualElements name, fall back to Properties name,
                # skip entirely if still an unresolvable ms-resource: string
                $displayName = $xml.Package.Applications.Application.'uap:VisualElements'.DisplayName
                if (-not $displayName -or $displayName -match '^ms-resource:') {
                  $displayName = $xml.Package.Properties.DisplayName
                }
                if (-not $displayName -or $displayName -match '^ms-resource:') {
                  # Pass raw package name — camelCase splitting done in Node to avoid PS escaping issues
                  $displayName = 'pkg:' + ($_.Name -replace '^[^.]+\.', '')
                }

                $exeName = $xml.Package.Applications.Application.Executable
                if ($displayName -and $exeName) {
                  $fullExe = Join-Path $_.InstallLocation $exeName
                  if (Test-Path $fullExe -ErrorAction SilentlyContinue) {
                    $key = $fullExe.ToLower()
                    if (-not $apps.ContainsKey($key)) {
                      # Find the best icon PNG from the package Assets folder
                      $iconPath = ''
                      $logoRel = $xml.Package.Applications.Application.'uap:VisualElements'.Square44x44Logo
                      if (-not $logoRel) { $logoRel = $xml.Package.Properties.Logo }
                      if ($logoRel) {
                        $logoFull = Join-Path $_.InstallLocation $logoRel
                        if (Test-Path $logoFull) {
                          $iconPath = $logoFull
                        } else {
                          # Windows may store scaled versions like Logo.scale-100.png
                          $logoDir  = Join-Path $_.InstallLocation ([System.IO.Path]::GetDirectoryName($logoRel))
                          $logoBase = [System.IO.Path]::GetFileNameWithoutExtension($logoRel)
                          $found = Get-ChildItem -Path $logoDir -Filter "$logoBase*.png" -ErrorAction SilentlyContinue |
                            Sort-Object { [int]($_.Name -replace '[^0-9]','') } -Descending |
                            Select-Object -First 1
                          if ($found) { $iconPath = $found.FullName }
                        }
                      }
                      $apps[$key] = @{ name = $displayName; exe = $fullExe; iconPath = $iconPath }
                    }
                  }
                }
              }
            } catch {}
          }
      } catch {}

      $desktopPaths = @(
        [Environment]::GetFolderPath('Desktop'),
        [Environment]::GetFolderPath('CommonDesktopDirectory')
      )
      foreach ($dir in $desktopPaths) {
        if (Test-Path $dir) {
          Get-ChildItem -Path $dir -Filter '*.lnk' -ErrorAction SilentlyContinue | ForEach-Object {
            try {
              $shortcut = $shell.CreateShortcut($_.FullName)
              $target = $shortcut.TargetPath
              if ($target -and $target -match '\\.exe$' -and (Test-Path $target -ErrorAction SilentlyContinue)) {
                $name = [System.IO.Path]::GetFileNameWithoutExtension($_.Name)
                $key = $target.ToLower()
                if (-not $apps.ContainsKey($key)) {
                  $apps[$key] = @{ name = $name; exe = $target }
                }
              }
            } catch {}
          }
        }
      }

      $json = $apps.Values | Sort-Object { $_.name } | ConvertTo-Json -Compress
      [System.IO.File]::WriteAllText('${tmpFile.replace(/\\/g, '\\\\')}', $json, [System.Text.Encoding]::UTF8)
    `;

    execFile('powershell', ['-NoProfile', '-Command', psScript], {
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30000
    }, (err) => {
      try {
        const raw = require('fs').readFileSync(tmpFile, 'utf8');
        const trimmed = raw.replace(/^\uFEFF/, '').trim();
        if (!trimmed) { resolve([]); return; }
        let parsed = JSON.parse(trimmed);
        if (!Array.isArray(parsed)) parsed = [parsed];
        const seen = new Set();
        const unique = [];
        for (const a of parsed) {
          if (!a.name || !a.exe) continue;
          // Resolve package names passed with pkg: prefix (camelCase split done here to avoid PS escaping)
          if (a.name.startsWith('pkg:')) {
            a.name = a.name.slice(4).replace(/([a-z])([A-Z])/g, '$1 $2');
          }
          const key = path.basename(a.exe).toLowerCase();
          if (!seen.has(key)) {
            seen.add(key);
            unique.push({ name: a.name, exe: a.exe, exeName: path.basename(a.exe), iconPath: a.iconPath || '' });
          }
        }
        unique.sort((a, b) => a.name.localeCompare(b.name));
        resolve(unique);
      } catch { resolve([]); }
      try { require('fs').unlinkSync(tmpFile); } catch {}
    });
  });
}

async function getAppIcon(exePath, iconPath) {
  try {
    if (iconPath && fs.existsSync(iconPath)) {
      const { nativeImage } = require('electron');
      const img = nativeImage.createFromPath(iconPath);
      if (!img.isEmpty()) return img.toDataURL();
    }
    const icon = await app.getFileIcon(exePath, { size: 'large' });
    return icon.toDataURL();
  } catch {
    return null;
  }
}

// ── Renderer Communication ─────────────────────────────────────────────────────
function notifyRenderer() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('status-update', getStatus());
  }
}

function getStatus() {
  return {
    isAwake,
    manualAwake,
    watchedApps: config.watchedApps,
    watchedIntegrations: config.watchedIntegrations,
    runningWatchedApps: runningWatchedApps.map(a => a.exe),
    activeIntegrations: activeIntegrations.map(a => a.id),
    tooltip: getTooltip()
  };
}

// ── IPC Handlers ───────────────────────────────────────────────────────────────
function setupIPC() {
  ipcMain.handle('get-status', () => getStatus());

  ipcMain.handle('toggle-awake', () => {
    manualAwake = !manualAwake;
    saveConfig();
    evaluateState();
    return getStatus();
  });

  // App management
  ipcMain.handle('add-app', (_, appData) => {
    const exists = config.watchedApps.some(a => a.exe.toLowerCase() === appData.exe.toLowerCase());
    if (!exists) {
      config.watchedApps.push({ name: appData.name, exe: appData.exe, enabled: true });
      saveConfig();
      checkRunningProcesses();
    }
    return getStatus();
  });

  ipcMain.handle('remove-app', (_, exe) => {
    config.watchedApps = config.watchedApps.filter(a => a.exe.toLowerCase() !== exe.toLowerCase());
    delete appLastSeen[exe.toLowerCase()];
    saveConfig();
    checkRunningProcesses();
    return getStatus();
  });

  ipcMain.handle('toggle-app', (_, exe) => {
    const found = config.watchedApps.find(a => a.exe.toLowerCase() === exe.toLowerCase());
    if (found) {
      found.enabled = !found.enabled;
      saveConfig();
      checkRunningProcesses();
    }
    return getStatus();
  });

  // Integration management
  ipcMain.handle('get-available-integrations', () => {
    return INTEGRATIONS.map(def => ({
      ...def,
      enabled: config.watchedIntegrations.some(i => i.id === def.id && i.enabled),
      added: config.watchedIntegrations.some(i => i.id === def.id)
    }));
  });

  ipcMain.handle('add-integration', (_, integrationId) => {
    const def = INTEGRATIONS.find(d => d.id === integrationId);
    if (!def) return getStatus();

    const exists = config.watchedIntegrations.find(i => i.id === integrationId);
    if (!exists) {
      config.watchedIntegrations.push({ id: def.id, name: def.name, enabled: true });
    }

    // Setup hooks if hook-based
    if (def.hookBased) setupHooksForIntegration(integrationId);

    saveConfig();
    checkRunningProcesses();
    return getStatus();
  });

  ipcMain.handle('remove-integration', (_, integrationId) => {
    const def = INTEGRATIONS.find(d => d.id === integrationId);
    config.watchedIntegrations = config.watchedIntegrations.filter(i => i.id !== integrationId);
    // Remember the removal so auto-detection does not add it back on next launch.
    if (!config.seenIntegrations.includes(integrationId)) config.seenIntegrations.push(integrationId);

    // Remove hooks if hook-based
    if (def?.hookBased) removeHooksForIntegration(integrationId);

    activeIntegrations = activeIntegrations.filter(a => a.id !== integrationId);
    delete processLastSeen[integrationId];
    saveConfig();
    evaluateState();
    return getStatus();
  });

  // Startup setting
  ipcMain.handle('get-startup', () => config.launchOnStartup);

  ipcMain.handle('toggle-startup', () => {
    config.launchOnStartup = !config.launchOnStartup;
    saveConfig();
    applyStartupSetting();
    return config.launchOnStartup;
  });

  ipcMain.handle('toggle-integration', (_, integrationId) => {
    const found = config.watchedIntegrations.find(i => i.id === integrationId);
    if (found) {
      found.enabled = !found.enabled;
      const def = INTEGRATIONS.find(d => d.id === integrationId);
      if (def?.hookBased) {
        if (found.enabled) setupHooksForIntegration(integrationId);
        else removeHooksForIntegration(integrationId);
      }
      if (!found.enabled) {
        activeIntegrations = activeIntegrations.filter(a => a.id !== integrationId);
      }
      saveConfig();
      checkRunningProcesses();
    }
    return getStatus();
  });

  // Dev container projects
  ipcMain.handle('get-devcontainer-projects', () => getDevcontainerProjects());
  ipcMain.handle('add-devcontainer-project', () => addDevcontainerProject());
  ipcMain.handle('update-devcontainer-project', (_, configPath) => updateDevcontainerProject(configPath));
  ipcMain.handle('remove-devcontainer-project', (_, configPath) => removeDevcontainerProject(configPath));

  // App discovery
  ipcMain.handle('get-installed-apps', async () => {
    const apps = await discoverInstalledApps();
    const results = [];
    for (const a of apps) {
      const icon = await getAppIcon(a.exe, a.iconPath);
      results.push({ ...a, icon });
    }
    return results;
  });

  ipcMain.handle('browse-exe', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select Application',
      filters: [{ name: 'Executables', extensions: ['exe'] }],
      properties: ['openFile']
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const exePath = result.filePaths[0];
    const name = path.basename(exePath, '.exe');
    const icon = await getAppIcon(exePath);
    return { name, exe: exePath, icon };
  });
}

// ── Window ─────────────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 500,
    height: 760,
    resizable: false,
    maximizable: false,
    icon: path.join(ASSETS, 'icon.png'),
    title: 'Insomnia',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile('index.html');
  mainWindow.setMenuBarVisibility(false);

  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

// ── Single Instance Lock ───────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // Someone tried to run a second instance — focus our window instead
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ── App Lifecycle ──────────────────────────────────────────────────────────────
app.on('before-quit', () => {
  app.isQuitting = true;
  if (pollInterval) clearInterval(pollInterval);
  if (sessionWatcher) { sessionWatcher.close(); sessionWatcher = null; }
  stopCodexWatcher();
  stopCursorWatcher();
  stopHookBridge();
  releasePowerBlockers();
});

app.whenReady().then(() => {
  // Ensure sessions directory exists
  if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  }

  loadConfig();
  applyStartupSetting();
  ensureHookLauncher();

  // Turn on whatever this machine actually has, on this and every later launch.
  autoEnableDetectedIntegrations();

  // Clean up stale Codex false-positive entries left behind by older builds.
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      const data = store.readSessions(SESSIONS_FILE);
      let removed = false;
      for (const key of Object.keys(data.sessions || {})) {
        if (key.endsWith(':auto-detected')) { delete data.sessions[key]; removed = true; }
        if (key === 'codex-cli:vscode') { delete data.sessions[key]; removed = true; }
        // Clean up stale cursor:agent entries from pre-hook builds so they don't
        // cause a false awake window on first launch after upgrade.
        if (key === 'cursor:agent') { delete data.sessions[key]; removed = true; }
      }
      if (removed) store.writeSessions(data, SESSIONS_FILE);
    }
  } catch {}

  // Sync stored display names with the current INTEGRATIONS table (rename migrations).
  let configChanged = false;
  for (const integ of config.watchedIntegrations) {
    const def = INTEGRATIONS.find(d => d.id === integ.id);
    if (def && integ.name !== def.name) {
      integ.name = def.name;
      configChanged = true;
    }
  }
  if (configChanged) saveConfig();

  // Re-apply hooks for already-enabled hook-based integrations so users who
  // upgrade get the new wiring without having to toggle the integration off/on.
  for (const integ of config.watchedIntegrations) {
    if (!integ.enabled) continue;
    const def = INTEGRATIONS.find(d => d.id === integ.id);
    if (def?.hookBased) setupHooksForIntegration(integ.id);
  }

  setupIPC();
  createWindow();
  createTray();

  checkRunningProcesses();
  pollInterval = setInterval(checkRunningProcesses, 10000);

  // Watch session file for instant hook-based integration response
  watchSessionFile();

  // Watch Codex session transcripts for VS Code / standalone app activity.
  if (config.watchedIntegrations.some(i => i.id === 'codex-cli' && i.enabled)) {
    watchCodexFiles();
  }

  // Watch Cursor agent transcripts for active Agent session activity.
  if (config.watchedIntegrations.some(i => i.id === 'cursor' && i.enabled)) {
    watchCursorFiles();
  }

  if (manualAwake) evaluateState();
});

app.on('window-all-closed', () => {
  // Don't quit — we live in the tray
});
