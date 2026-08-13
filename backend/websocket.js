import http from 'http';
import { setupWSConnection } from 'y-websocket';
import { createClient } from '@base44/sdk';

const port = parseInt(process.env.PORT || '1234');
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Yjs WebSocket server');
});

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
  const docName = url.pathname.slice(1) || 'default';
  
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

    setupWSConnection(socket, head, { docName });
  } catch (err) {
    console.error('[WS] Error validating connection:', err.message);
    socket.destroy();
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Yjs WebSocket server listening on 127.0.0.1:${port}`);
});
