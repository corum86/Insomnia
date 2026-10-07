// Dev container path, end to end on Linux: the container-side hook script
// (devcontainer-features/…/claude-hook.sh) talking to the bridge Insomnia runs
// on the host. Run with: npm test
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const { createHookBridge } = require('../hook-bridge');
const store = require('../session-store');

const HOOK = path.join(__dirname, '..', 'devcontainer-features', 'src', 'claude-code-stay-awake', 'claude-hook.sh');
const sleep = ms => new Promise(r => setTimeout(r, ms));
// The container-side script is POSIX sh and reads /proc: Linux only.
const linuxOnly = { skip: process.platform !== 'linux' || !fs.existsSync('/bin/bash') ? 'needs Linux' : false };

async function startBridge(t, { enabled = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'insomnia-bridge-'));
  const sessionsFile = path.join(dir, 'agent-sessions.json');
  let activity = 0;
  const bridge = createHookBridge({
    port: 0,
    sessionsFile,
    isEnabled: () => enabled,
    onActivity: () => { activity++; },
    version: 'test'
  });
  bridge.start();
  for (let i = 0; i < 100 && !bridge.listening; i++) await sleep(10);
  assert.ok(bridge.listening, 'bridge should listen');
  t.after(() => { bridge.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { bridge, dir, sessionsFile, port: bridge.address.port, activity: () => activity };
}

function request(port, { method = 'POST', urlPath = '/v1/hooks/claude-code', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const json = { 'Content-Type': 'application/json' };

test('bridge records a hook posted as JSON and answers in key=value lines', async t => {
  const { port, sessionsFile } = await startBridge(t);
  const res = await request(port, {
    headers: { ...json, 'X-Insomnia-Origin': 'devcontainer', 'X-Insomnia-Host': 'abc123' },
    body: JSON.stringify({ session_id: 'sess-1', hook_event_name: 'PreToolUse', tool_use_id: 'toolu_1', tool_input: { command: 'make' } })
  });
  assert.equal(res.status, 200);
  assert.match(res.body, /session=sess-1/);
  assert.match(res.body, /turn=open/);
  const s = store.readSessions(sessionsFile).sessions['claude-code:sess-1'];
  assert.equal(s.origin, 'devcontainer');
  assert.equal(s.host, 'abc123');
  assert.ok(s.open_tools.toolu_1);
});

test('bridge refuses browsers, foreign host names and non-JSON bodies', async t => {
  const { port } = await startBridge(t);
  const body = JSON.stringify({ session_id: 'x', hook_event_name: 'UserPromptSubmit' });
  assert.equal((await request(port, { headers: { ...json, Origin: 'https://evil.example' }, body })).status, 403);
  assert.equal((await request(port, { headers: { ...json, Host: 'evil.example:47391' }, body })).status, 403);
  assert.equal((await request(port, { headers: { 'Content-Type': 'text/plain' }, body })).status, 415);
  assert.equal((await request(port, { headers: json, body: '{not json' })).status, 400);
  assert.equal((await request(port, { urlPath: '/v1/hooks/unknown', headers: json, body })).status, 404);
  assert.equal((await request(port, { method: 'GET', headers: json })).status, 405);
  // host.docker.internal is how a container reaches it
  assert.equal((await request(port, { headers: { ...json, Host: `host.docker.internal:${port}` }, body })).status, 200);
});

test('a bridged session can never pose as local', async t => {
  const { port, sessionsFile } = await startBridge(t);
  await request(port, { headers: { ...json, 'X-Insomnia-Origin': 'local' }, body: JSON.stringify({ session_id: 'p', hook_event_name: 'UserPromptSubmit' }) });
  assert.equal(store.readSessions(sessionsFile).sessions['claude-code:p'].origin, 'remote');
});

test('bridge ignores events while the integration is disabled', async t => {
  const { port, sessionsFile } = await startBridge(t, { enabled: false });
  const res = await request(port, { headers: json, body: JSON.stringify({ session_id: 'd', hook_event_name: 'UserPromptSubmit' }) });
  assert.match(res.body, /ignored=disabled/);
  assert.equal(fs.existsSync(sessionsFile), false);
});

test('ping reports the app', async t => {
  const { port } = await startBridge(t);
  const res = await request(port, { method: 'GET', urlPath: '/v1/ping' });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { app: 'insomnia', version: 'test', integrations: { 'claude-code': true } });
});

// ── The container-side hook script ───────────────────────────────────────────
// Runs the hook the way Claude Code would: as a child of a process named
// "claude" (a copy of bash), with the event JSON on stdin.
function makeFakeClaude(dir) {
  const fake = path.join(dir, 'claude');
  fs.copyFileSync('/bin/bash', fake);
  fs.chmodSync(fake, 0o755);
  return fake;
}

function hookEnv(port, stateDir) {
  return {
    ...process.env,
    INSOMNIA_URL: `http://127.0.0.1:${port}`,
    INSOMNIA_HEARTBEAT_INTERVAL: '1',
    REMOTE_CONTAINERS: 'true', // what VS Code sets inside a dev container
    TMPDIR: stateDir
  };
}

function runHook(fakeClaude, env, event) {
  // `claude -c '…'` → sh -c → hook, like Claude Code's shell form.
  const r = spawnSync(fakeClaude, ['-c', `printf '%s' "$EVT" | sh -c '${HOOK}'`], {
    env: { ...env, EVT: JSON.stringify(event) },
    encoding: 'utf8',
    timeout: 10000
  });
  return r;
}

test('container hook: forwards events, prints nothing, exits 0 — even with no Insomnia listening', linuxOnly, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'insomnia-hook-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fake = makeFakeClaude(dir);
  // Port 9 (discard) is closed: the hook must shrug it off quickly.
  const started = Date.now();
  const r = runHook(fake, hookEnv(9, dir), { session_id: 'nobody', hook_event_name: 'Stop' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.ok(Date.now() - started < 4000, 'unreachable host must not stall Claude');
});

test('container hook: full turn with a long tool call keeps heartbeats coming until Stop', linuxOnly, async t => {
  const { port, sessionsFile } = await startBridge(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'insomnia-hook-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fake = makeFakeClaude(dir);
  const env = hookEnv(port, dir);
  const sid = '0b3c5c2e-1111-4222-8333-944455556666';
  const key = `claude-code:${sid}`;

  // A long-lived "claude" that runs the hooks as its children.
  const big = 'x'.repeat(100000); // PostToolUse inputs carry tool output
  const script = [
    `ev() { printf '%s' "$1" | sh -c '${HOOK}'; }`,
    `ev '${JSON.stringify({ session_id: sid, hook_event_name: 'UserPromptSubmit', prompt: 'build it' })}'`,
    `ev '${JSON.stringify({ session_id: sid, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'make' }, tool_use_id: 'toolu_build' })}'`,
    'sleep 3.5', // the "build": no hook fires, heartbeat should
    `ev '${JSON.stringify({ session_id: sid, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'make' }, tool_response: { stdout: big }, tool_use_id: 'toolu_build' })}'`,
    `ev '${JSON.stringify({ session_id: sid, hook_event_name: 'Stop', stop_hook_active: false })}'`,
    'sleep 3' // claude stays open after the turn; heartbeats must stop
  ].join('\n');
  const claude = spawn(fake, ['-c', script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  claude.stdout.on('data', d => { stdout += d; });

  // During the build: turn open, tool open, heartbeat arriving.
  await sleep(2600);
  let s = store.readSessions(sessionsFile).sessions[key];
  assert.ok(s, 'session recorded');
  assert.equal(s.origin, 'devcontainer');
  assert.equal(s.turn_open, true);
  assert.ok(s.open_tools.toolu_build, 'build is an open tool call');
  assert.ok(s.heartbeat_at, 'heartbeat received while the tool runs');
  assert.ok(Date.now() - Date.parse(s.heartbeat_at) < 2500);
  const hbPid = Number(fs.readFileSync(path.join(dir, `insomnia-${process.getuid()}`, `heartbeat-${sid}.pid`), 'utf8'));
  assert.ok(hbPid > 0);

  await new Promise(r => claude.on('exit', r));
  assert.equal(stdout, '', 'hooks print nothing');
  s = store.readSessions(sessionsFile).sessions[key];
  assert.equal(s.turn_open, false, 'Stop closed the turn');
  assert.equal(s.stop_seen, true);
  assert.deepEqual(s.open_tools, {}, 'PostToolUse with a 100 KB body closed the tool');
  // Heartbeat process gone after the turn ended.
  await sleep(1500);
  assert.equal(processExists(hbPid), false, 'heartbeat stopped after Stop');
});

test('container hook: heartbeat stops when the claude process dies mid-turn', linuxOnly, async t => {
  const { port, sessionsFile } = await startBridge(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'insomnia-hook-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fake = makeFakeClaude(dir);
  const sid = 'crash-session';
  const script = [
    `printf '%s' '${JSON.stringify({ session_id: sid, hook_event_name: 'PreToolUse', tool_use_id: 't1' })}' | sh -c '${HOOK}'`,
    'sleep 30'
  ].join('\n');
  const claude = spawn(fake, ['-c', script], { env: hookEnv(port, dir), stdio: 'ignore' });
  await sleep(1500);
  const pidFile = path.join(dir, `insomnia-${process.getuid()}`, `heartbeat-${sid}.pid`);
  const hbPid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.ok(processExists(hbPid));
  claude.kill('SIGKILL'); // the container's claude crashes, no Stop
  await sleep(2500);
  assert.equal(processExists(hbPid), false, 'heartbeat noticed claude is gone');
  const s = store.readSessions(sessionsFile).sessions[`claude-code:${sid}`];
  // Host side: heartbeats have stopped, so once the 3-minute window passes the
  // session no longer counts, even with the tool call still "open".
  assert.equal(store.isTurnSessionActive(s, Date.parse(s.last_activity) + 4 * 60 * 1000, true), false);
});

function processExists(pid) {
  try { process.kill(pid, 0); } catch { return false; }
  // A zombie still "exists"; check its state.
  try { return !/^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return false; }
}
