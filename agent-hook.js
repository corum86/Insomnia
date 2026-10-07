#!/usr/bin/env node

/**
 * Lightweight hook handler for Insomnia integrations.
 * Called by Claude Code hooks (and similar tools) to signal activity.
 * No Electron dependency — reads the hook's JSON from stdin and records it in
 * ~/.insomnia/agent-sessions.json (see session-store.js for the rules).
 *
 * Usage:
 *   echo '{"session_id":"abc","hook_event_name":"PreToolUse","tool_use_id":"t1"}' | node agent-hook.js stay-awake <integration-id>
 *   echo '{"session_id":"abc","hook_event_name":"Stop"}' | node agent-hook.js allow-sleep <integration-id>
 *
 * Claude Code passes the event name in the JSON, so the event decides what
 * happens; the command is only a fallback for tools that do not send one.
 *
 * A hook must never get in the agent's way: no stdout, always exit 0.
 */

const store = require('./session-store');

const command = process.argv[2];
const integrationId = process.argv[3] || 'unknown';

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { resolve(JSON.parse(data)); }
      catch { resolve({}); }
    };
    try {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', chunk => { data += chunk; });
      process.stdin.on('end', finish);
      process.stdin.on('error', finish);
    } catch {
      finish();
    }
    // Some callers (Codex notify) never close stdin — don't wait forever.
    setTimeout(finish, 1000);
  });
}

async function main() {
  const input = await readStdin();
  try {
    store.updateSessions(data => store.applyHookEvent(data, {
      integration: integrationId,
      command,
      input,
      origin: 'local'
    }));
  } catch {}
  process.exit(0);
}

main().catch(() => process.exit(0));
