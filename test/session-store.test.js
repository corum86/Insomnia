// Decision table for Claude Code sessions. Run with: npm test
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../session-store');

const MIN = 60 * 1000;
const T0 = Date.parse('2026-10-07T12:00:00Z');

// Feed a list of [minutesAfterT0, hookEventName, extra] into a fresh document.
function replay(events, { origin = 'local', sessionId = 's1' } = {}) {
  const data = { sessions: {} };
  for (const [minute, event, extra = {}] of events) {
    const command = ['Stop', 'StopFailure', 'SessionEnd'].includes(event) ? 'allow-sleep' : 'stay-awake';
    store.applyHookEvent(data, {
      integration: 'claude-code',
      command,
      input: { session_id: sessionId, hook_event_name: event, ...extra },
      now: T0 + minute * MIN,
      origin
    });
  }
  return data;
}

function active(data, minute, processAlive, key = 'claude-code:s1') {
  return store.isTurnSessionActive(data.sessions[key], T0 + minute * MIN, processAlive);
}

test('a 10-minute build stays awake even before the session has ever fired Stop', () => {
  const d = replay([[0, 'UserPromptSubmit'], [1, 'PreToolUse', { tool_use_id: 'build' }]]);
  assert.equal(active(d, 11, true), true);
  assert.equal(active(d, 25, true), true);
});

test('a running tool is not trusted once claude.exe is gone', () => {
  const d = replay([[0, 'UserPromptSubmit'], [1, 'PreToolUse', { tool_use_id: 'build' }]]);
  assert.equal(active(d, 11, false), false);
});

test('long tool calls are capped at 30 minutes of silence', () => {
  const d = replay([[0, 'UserPromptSubmit'], [0, 'PreToolUse', { tool_use_id: 'build' }]]);
  assert.equal(active(d, 29, true), true);
  assert.equal(active(d, 31, true), false);
});

test('Stop releases immediately', () => {
  const d = replay([[0, 'UserPromptSubmit'], [1, 'PreToolUse', { tool_use_id: 't' }], [2, 'PostToolUse', { tool_use_id: 't' }], [3, 'Stop']]);
  assert.equal(active(d, 3, true), false);
});

test('StopFailure (turn ended by an API error) releases immediately', () => {
  const d = replay([[0, 'UserPromptSubmit'], [1, 'StopFailure']]);
  assert.equal(active(d, 1, true), false);
});

test('without Stop (reported in the VS Code extension) an idle session releases after 3 minutes, not 30', () => {
  const d = replay([[0, 'UserPromptSubmit'], [1, 'PreToolUse', { tool_use_id: 't' }], [2, 'PostToolUse', { tool_use_id: 't' }]]);
  assert.equal(active(d, 4, true), true);
  assert.equal(active(d, 5.5, true), false);
});

test('once a session has fired Stop, an open turn is trusted for a long reply', () => {
  const d = replay([
    [0, 'UserPromptSubmit'], [1, 'Stop'],
    [10, 'UserPromptSubmit'] // second turn: long thinking, no tool yet
  ]);
  assert.equal(active(d, 20, true), true);
  assert.equal(active(d, 41, true), false); // still capped
  assert.equal(active(d, 20, false), false); // and needs the process
});

test('a Notification after the turn ended does not re-arm anything', () => {
  const d = replay([[0, 'UserPromptSubmit'], [1, 'Stop'], [2, 'Notification']]);
  assert.equal(active(d, 2, true), false);
  assert.equal(active(d, 10, true), false);
});

test('a failed tool closes its tool call', () => {
  const d = replay([[0, 'UserPromptSubmit'], [1, 'PreToolUse', { tool_use_id: 't' }], [2, 'PostToolUseFailure', { tool_use_id: 't' }]]);
  assert.equal(store.hasOpenTools(d.sessions['claude-code:s1']), false);
  assert.equal(active(d, 10, true), false);
});

test('parallel tool calls: awake until the last one finishes', () => {
  const d = replay([
    [0, 'UserPromptSubmit'],
    [1, 'PreToolUse', { tool_use_id: 'a' }], [1, 'PreToolUse', { tool_use_id: 'b' }],
    [2, 'PostToolUse', { tool_use_id: 'a' }]
  ]);
  assert.equal(active(d, 12, true), true);
});

test('a new prompt clears tool calls left open by an interrupted turn', () => {
  const d = replay([[0, 'UserPromptSubmit'], [1, 'PreToolUse', { tool_use_id: 'x' }], [5, 'UserPromptSubmit']]);
  assert.equal(store.hasOpenTools(d.sessions['claude-code:s1']), false);
});

test('a late PostToolUse does not reopen an ended turn', () => {
  const d = replay([[0, 'UserPromptSubmit'], [1, 'PreToolUse', { tool_use_id: 't' }], [2, 'Stop'], [2, 'PostToolUse', { tool_use_id: 't' }]]);
  assert.equal(active(d, 2, true), false);
});

test('SessionEnd removes the session', () => {
  const d = replay([[0, 'UserPromptSubmit'], [1, 'SessionEnd']]);
  assert.equal(d.sessions['claude-code:s1'], undefined);
});

test('legacy wiring without an event name still works (stay-awake / allow-sleep)', () => {
  const data = { sessions: {} };
  store.applyHookEvent(data, { integration: 'claude-code', command: 'stay-awake', input: { session_id: 's1' }, now: T0 });
  assert.equal(active(data, 1, false), true);
  store.applyHookEvent(data, { integration: 'claude-code', command: 'allow-sleep', input: { session_id: 's1' }, now: T0 + MIN });
  assert.equal(active(data, 1, true), false);
});

// ── Dev container sessions ───────────────────────────────────────────────────
test('dev container: a long build stays awake while heartbeats arrive, regardless of claude.exe', () => {
  const d = replay([[0, 'UserPromptSubmit'], [1, 'PreToolUse', { tool_use_id: 'build' }]], { origin: 'devcontainer' });
  for (let m = 2; m <= 12; m++) {
    store.applyHookEvent(d, { integration: 'claude-code', command: 'heartbeat', input: { session_id: 's1' }, now: T0 + m * MIN, origin: 'devcontainer' });
  }
  assert.equal(active(d, 12.5, false), true);
});

test('dev container: heartbeats stopping (container gone) releases within 2.5 minutes', () => {
  const d = replay([[0, 'UserPromptSubmit'], [1, 'PreToolUse', { tool_use_id: 'build' }]], { origin: 'devcontainer' });
  store.applyHookEvent(d, { integration: 'claude-code', command: 'heartbeat', input: { session_id: 's1' }, now: T0 + 5 * MIN, origin: 'devcontainer' });
  assert.equal(active(d, 7, false), true);
  assert.equal(active(d, 8, true), false); // a local claude.exe does not keep a container session alive
});

test('a heartbeat never creates a session', () => {
  const data = { sessions: {} };
  store.applyHookEvent(data, { integration: 'claude-code', command: 'heartbeat', input: { session_id: 'ghost' }, now: T0, origin: 'devcontainer' });
  assert.deepEqual(data.sessions, {});
});

// ── Housekeeping and file handling ───────────────────────────────────────────
test('finished sessions are pruned after a day, untouched ones after a week', () => {
  const d = replay([[0, 'UserPromptSubmit'], [1, 'Stop']]);
  store.applyHookEvent(d, { integration: 'claude-code', input: { session_id: 'other', hook_event_name: 'UserPromptSubmit' }, now: T0 + 25 * 60 * MIN });
  assert.equal(d.sessions['claude-code:s1'], undefined);
  assert.ok(d.sessions['claude-code:other']);
});

test('updateSessions writes atomically and keeps other sessions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'insomnia-test-'));
  const file = path.join(dir, 'agent-sessions.json');
  store.updateSessions(d => store.applyHookEvent(d, { integration: 'codex-cli', input: { session_id: 'app-server' } }), file);
  store.updateSessions(d => store.applyHookEvent(d, { integration: 'claude-code', input: { session_id: 'abc', hook_event_name: 'UserPromptSubmit' } }), file);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(data.sessions['codex-cli:app-server']);
  assert.ok(data.sessions['claude-code:abc']);
  assert.deepEqual(fs.readdirSync(dir), ['agent-sessions.json']); // no temp files left behind
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a corrupt sessions file reads as empty instead of throwing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'insomnia-test-'));
  const file = path.join(dir, 'agent-sessions.json');
  fs.writeFileSync(file, '{"sessions": {');
  assert.deepEqual(store.readSessions(file), { sessions: {} });
  fs.rmSync(dir, { recursive: true, force: true });
});
