import http from 'http';
// `setupWSConnection` is NOT exported from the y-websocket root entry. That entry
// exports the *client* surface (WebsocketProvider, messageSync, ...); the server
// helper lives in the './bin/utils' subpath, which the package declares in its
// exports map. The old `from 'y-websocket'` made `node backend/websocket.js`
// die at import time with:
//     SyntaxError: The requested module 'y-websocket' does not provide an
//     export named 'setupWSConnection'
// so `npm run ws` could never start and multi-device sync was unreachable.
import { setupWSConnection } from 'y-websocket/bin/utils';
import { createClient } from '@base44/sdk';

// The upgrade handoff needs a real WebSocket, which means the `ws` package.
// `ws` is not a declared dependency of this project, and not of y-websocket
// either — it currently resolves only because engine.io-client happens to pull
// in ws@~8.21.0. That is an accident, not a contract, so fail with an
// actionable message instead of a bare MODULE_NOT_FOUND if it ever stops
// being true. To depend on it properly: npm install ws
let WebSocketServer;
try {
  ({ WebSocketServer } = await import('ws'));
} catch {
  console.error(
    '[WS] Cannot start: the "ws" package could not be resolved.\n'
    + '     It is required for the WebSocket upgrade handoff.\n'
    + '     Run `npm install ws` to declare it as a direct dependency.\n'
    + '     (It was previously present only as a transitive dependency of\n'
    + '      engine.io-client, so it was never guaranteed to be there.)',
  );
  process.exit(1);
}

const port = parseInt(process.env.PORT || '1234');
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Yjs WebSocket server');
});

// noServer: this process does its own auth in the 'upgrade' handler below and
// only completes the handshake for connections that pass it.
const wss = new WebSocketServer({ noServer: true });

const ipMap = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const RATE_LIMIT_MAX = 20;

// CSWSH protection: validate the Origin header against a server-side allowlist.
// We deliberately do NOT compare against the client-supplied `Host` header
// (an attacker can forge it). Configure via ALLOWED_WS_ORIGINS (comma-separated
// origins) and/or APP_ORIGIN. Missing configuration fails CLOSED (reject).
const ALLOWED_WS_ORIGINS = (process.env.ALLOWED_WS_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const APP_ORIGIN = process.env.APP_ORIGIN || '';

function originIsAllowed(origin) {
  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  if (ALLOWED_WS_ORIGINS.length > 0) {
    return ALLOWED_WS_ORIGINS.some((o) => {
      try {
        return new URL(o).host === originHost;
      } catch {
        return false;
      }
    });
  }
  if (APP_ORIGIN) {
    try {
      return new URL(APP_ORIGIN).host === originHost;
    } catch {
      return false;
    }
  }
  return false; // misconfigured -> fail closed
}

server.on('upgrade', async (req, socket, head) => {
  // Strict Origin Validation for CSWSH protection. A missing Origin header
  // (non-browser clients / scripts, or stripped by a proxy) must NEVER be
  // trusted — reject it outright.
  const origin = req.headers.origin;
  if (!origin) {
    console.log('[WS] Rejected connection: Missing Origin header (CSWSH protection)');
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }

  if (!originIsAllowed(origin)) {
    console.log(`[WS] Rejected connection: Origin ${origin} not in allowlist`);
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }

  const ip = req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  let times = ipMap.get(ip);
  if (!times) {
    times = [];
    ipMap.set(ip, times);
  }
  const recent = times.filter(t => now - t < RATE_LIMIT_WINDOW);
  
  if (recent.length >= RATE_LIMIT_MAX) {
    console.log(`[WS] Rate limit exceeded for IP: ${ip}`);
    socket.destroy();
    return;
  }
  recent.push(now);
  ipMap.set(ip, recent);

  // Periodically clean up old IP entries to prevent memory leaks
  if (Math.random() < 0.05) {
    for (const [key, tArr] of ipMap.entries()) {
      const valid = tArr.filter(t => now - t < RATE_LIMIT_WINDOW);
      if (valid.length === 0) ipMap.delete(key);
      else ipMap.set(key, valid);
    }
  }

  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const docNameRaw = url.pathname.slice(1) || 'default';
  
  // Validate docName (propertyId) with strict format
  if (!docNameRaw || docNameRaw.length > 255 || !/^[a-zA-Z0-9_-]+$/.test(docNameRaw)) {
    console.log(`[WS] Rejected connection: Invalid property ID format`);
    socket.destroy();
    return;
  }
  const docName = docNameRaw;
  
  const cookieHeader = req.headers['cookie'] || '';
  const match = cookieHeader.match(/base44_session=([^;]+)/);
  const token = match ? match[1] : null;

  if (!token) {
    console.log('[WS] Rejected connection: Missing token');
    socket.destroy();
    return;
  }

  try {
    const base44 = createClient({ appId: 'base44-app', token });
    const user = await base44.auth.me();
    
    if (!user) {
      console.log('[WS] Rejected connection: Invalid token');
      socket.destroy();
      return;
    }

    if (user.is_active === false) {
      console.log(`[WS] Rejected connection: User ${user.email} is suspended`);
      socket.destroy();
      return;
    }

    // docName represents the property_id. Check if user is authorized.
    const propertyId = docName;
    if (user.role !== 'admin' && user.role !== 'owner' && user.property_access !== 'all') {
      const accessArray = Array.isArray(user.property_access) ? user.property_access : [];
      if (!accessArray.includes(propertyId)) {
        console.log(`[WS] Rejected connection: User ${user.email} unauthorized for property ${propertyId}`);
        socket.destroy();
        return;
      }
    }

    // setupWSConnection expects (WebSocket, IncomingMessage, opts). The old call
    // passed the raw TCP socket and the `head` buffer, so no handshake ever
    // happened. Measured failure sequence (see scripts/probe-ws-server.mjs):
    // a net.Socket IS an EventEmitter, so setupWSConnection's conn.on('message'
    // |'close'|'pong') calls all succeed silently — nothing complains. It then
    // calls send(), which compares conn.readyState against the numeric
    // WebSocket constants 0/1; a net.Socket reports the STRING 'open', so the
    // comparison says "not open", send() concludes the peer is gone and calls
    // closeConn(), whose last line is conn.close() — absent on a net.Socket.
    // TypeError: conn.close is not a function. That landed in the catch below,
    // which destroyed the socket and logged a generic validation error, so the
    // client just saw a dropped connection and crdt.jsx fell back to offline
    // mode. handleUpgrade completes the handshake and yields a real WebSocket.
    wss.handleUpgrade(req, socket, head, (ws) => {
      setupWSConnection(ws, req, { docName });
    });
  } catch (err) {
    console.error('[WS] Error validating connection:', err.message);
    socket.destroy();
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Yjs WebSocket server listening on 127.0.0.1:${port}`);
});
