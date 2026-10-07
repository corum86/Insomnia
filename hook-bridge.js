/**
 * Hook bridge: a loopback HTTP endpoint for agents that run where Insomnia's
 * own hook cannot.
 *
 * Claude Code inside a dev container (or WSL) runs its hooks in Linux. Those
 * hooks cannot run the Windows launcher or write to %USERPROFILE%\.insomnia, and
 * Windows cannot see the Linux `claude` process to tell a long build from a dead
 * session. The container-side hook (devcontainer-features/) therefore POSTs each
 * hook event here instead, plus a heartbeat every minute while a turn is open,
 * and this records them through the same session-store rules a local hook uses.
 *
 * Reached from a container as http://host.docker.internal:<port> — Docker
 * Desktop forwards that name to the Windows loopback — so it listens on
 * 127.0.0.1 only and is never exposed to the network.
 *
 *   GET  /v1/ping                       -> {"app":"insomnia",...}
 *   POST /v1/hooks/<integration>        body: the hook's JSON input, as-is
 *   POST /v1/heartbeat/<integration>    body: {"session_id": "..."}
 *
 * Responses are plain `key=value` lines so a POSIX shell can read them:
 *   ok / session=<id> / turn=open|closed|none
 *
 * No Electron dependency, so it can be tested under plain Node.
 */

'use strict';

const http = require('http');
const store = require('./session-store');

const DEFAULT_BRIDGE_PORT = 47391;
const MAX_BODY_BYTES = 32 * 1024 * 1024; // PostToolUse inputs carry tool output
const RETRY_LISTEN_MS = 60 * 1000;
const SUPPORTED_INTEGRATIONS = new Set(['claude-code']);

// Host names a legitimate caller uses to reach us. Anything else — notably a
// web page that DNS-rebinds its own name to 127.0.0.1 — is refused.
const ALLOWED_HOSTNAMES = [
  '127.0.0.1',
  'localhost',
  '::1',
  'host.docker.internal',      // Docker Desktop
  'gateway.docker.internal',
  'host.containers.internal',  // Podman
  'host.lima.internal',        // Rancher Desktop / Lima
  'host.orb.internal'          // OrbStack
];

function hostnameOf(hostHeader) {
  if (typeof hostHeader !== 'string') return '';
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end > 0 ? h.slice(1, end) : '';
  }
  const colon = h.lastIndexOf(':');
  return colon > -1 ? h.slice(0, colon) : h;
}

function cleanLabel(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/[^A-Za-z0-9._-]/g, '').slice(0, max);
}

function readBody(req, limit, callback) {
  const chunks = [];
  let size = 0;
  let failed = false;
  req.on('data', chunk => {
    if (failed) return;
    size += chunk.length;
    if (size > limit) {
      failed = true;
      callback(Object.assign(new Error('too large'), { status: 413 }));
      req.resume(); // drain and discard the rest
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => { if (!failed) callback(null, Buffer.concat(chunks).toString('utf8')); });
  req.on('error', err => { if (!failed) { failed = true; callback(err); } });
}

function createHookBridge(options = {}) {
  const {
    port = DEFAULT_BRIDGE_PORT,
    host = '127.0.0.1',
    sessionsFile = store.SESSIONS_FILE,
    isEnabled = () => true,
    onActivity = () => {},
    version = '',
    extraAllowedHosts = [],
    log = () => {}
  } = options;

  const allowedHosts = new Set([
    ...ALLOWED_HOSTNAMES,
    ...extraAllowedHosts.map(h => String(h).toLowerCase())
  ]);

  let server = null;
  let listening = false;
  let retryTimer = null;
  let wanted = false;

  function send(res, status, body, type = 'text/plain; charset=utf-8') {
    res.writeHead(status, {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(body);
  }

  function handle(req, res) {
    // Only programs talk to this endpoint. Browsers attach an Origin header to
    // every POST, so refusing it shuts out any web page outright.
    if (req.headers.origin) return send(res, 403, 'forbidden\n');
    if (!allowedHosts.has(hostnameOf(req.headers.host))) return send(res, 403, 'forbidden\n');

    let url;
    try { url = new URL(req.url, 'http://bridge.invalid'); }
    catch { return send(res, 400, 'bad request\n'); }

    if (url.pathname === '/v1/ping') {
      if (req.method !== 'GET') return send(res, 405, 'method not allowed\n');
      const integrations = {};
      for (const id of SUPPORTED_INTEGRATIONS) integrations[id] = !!isEnabled(id);
      return send(res, 200, JSON.stringify({ app: 'insomnia', version, integrations }) + '\n', 'application/json');
    }

    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length !== 3 || parts[0] !== 'v1' || !['hooks', 'heartbeat'].includes(parts[1])) {
      return send(res, 404, 'not found\n');
    }
    const [, kind, integration] = parts;
    if (!SUPPORTED_INTEGRATIONS.has(integration)) return send(res, 404, 'not found\n');
    if (req.method !== 'POST') return send(res, 405, 'method not allowed\n');
    // A JSON content type cannot be sent cross-site without a CORS preflight,
    // which this server never approves.
    if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
      return send(res, 415, 'expected application/json\n');
    }

    readBody(req, MAX_BODY_BYTES, (err, raw) => {
      if (err) return send(res, err.status || 400, 'bad request\n');

      let input;
      try { input = JSON.parse(raw); } catch { return send(res, 400, 'bad json\n'); }
      if (!input || typeof input !== 'object' || Array.isArray(input)) return send(res, 400, 'bad json\n');

      if (!isEnabled(integration)) return send(res, 200, 'ok\nignored=disabled\n');

      // Whatever the caller says, a bridged session is never "local": that would
      // let it borrow liveness from an unrelated claude.exe on this PC.
      let origin = cleanLabel(req.headers['x-insomnia-origin'], 32) || 'remote';
      if (origin === 'local') origin = 'remote';
      const remoteHost = cleanLabel(req.headers['x-insomnia-host'], 64);

      let result;
      try {
        result = store.updateSessions(data => store.applyHookEvent(data, {
          integration,
          command: kind === 'heartbeat' ? 'heartbeat' : 'stay-awake',
          input: kind === 'heartbeat' ? { session_id: input.session_id } : input,
          origin,
          host: remoteHost
        }), sessionsFile);
      } catch (e) {
        log(`hook bridge: could not record event: ${e && e.message}`);
        return send(res, 500, 'error\n');
      }

      try { onActivity(); } catch {}

      const session = result && result.session;
      const turn = !session ? 'none' : (session.turn_open === false ? 'closed' : 'open');
      const sid = cleanLabel(session ? session.session_id : '', 200);
      send(res, 200, `ok\nsession=${sid}\nturn=${turn}\n`);
    });
  }

  function listen() {
    if (!wanted || server) return;
    const srv = http.createServer(handle);
    srv.requestTimeout = 15000;
    srv.headersTimeout = 10000;
    srv.keepAliveTimeout = 1000;
    srv.on('error', err => {
      listening = false;
      if (server === srv) server = null;
      try { srv.close(); } catch {}
      log(`hook bridge: cannot listen on ${host}:${port} (${err && err.code || err}); retrying in ${RETRY_LISTEN_MS / 1000}s`);
      if (wanted && !retryTimer) {
        retryTimer = setTimeout(() => { retryTimer = null; listen(); }, RETRY_LISTEN_MS);
        if (retryTimer.unref) retryTimer.unref();
      }
    });
    srv.listen(port, host, () => {
      listening = true;
      const addr = srv.address();
      log(`hook bridge: listening on http://${host}:${addr && addr.port}`);
    });
    server = srv;
  }

  return {
    start() { wanted = true; listen(); },
    stop() {
      wanted = false;
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      if (server) { try { server.close(); } catch {} server = null; }
      listening = false;
    },
    get listening() { return listening; },
    get port() { return port; },
    get address() { return server && listening ? server.address() : null; }
  };
}

module.exports = {
  DEFAULT_BRIDGE_PORT,
  ALLOWED_HOSTNAMES,
  createHookBridge,
  hostnameOf
};
