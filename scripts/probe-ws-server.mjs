// Probe: can the Yjs WebSocket server actually start and complete a handshake?
//
// `npm run ws` (node backend/websocket.js) was dead on arrival. Two defects,
// both invisible to every other suite because nothing here is imported by src/:
//
//   1. `import { setupWSConnection } from 'y-websocket'` — the root entry
//      exports the CLIENT surface (WebsocketProvider, messageSync, ...). The
//      server helper is on the './bin/utils' subpath. Node rejected the named
//      import at load time, so the process died before `listen()`:
//        SyntaxError: The requested module 'y-websocket' does not provide an
//        export named 'setupWSConnection'
//
//   2. `setupWSConnection(socket, head, { docName })` — the real signature is
//      (WebSocket, IncomingMessage, opts). It was handed the raw TCP socket and
//      the head buffer, so no handshake happened. A net.Socket is an
//      EventEmitter, so setupWSConnection's conn.on(...) calls all succeeded
//      quietly; it then hit the numeric readyState check inside send(), read the
//      net.Socket's string 'open' as "not open", and called closeConn() ->
//      conn.close(), which a net.Socket does not have:
//        TypeError: conn.close is not a function
//      That was swallowed by the surrounding try/catch, which destroyed the
//      socket and logged "[WS] Error validating connection" — so a client saw an
//      ordinary dropped connection and crdt.jsx fell back to offline mode
//      silently. Fixing only defect 1 would have produced exactly that: a server
//      that starts, listens, and rejects every connection while looking healthy.
//
// Defect 2 is why this probe asserts the y-websocket API contract directly
// (section 3) instead of trusting that a started server means a working one.
//
// The auth path (cookie -> token -> base44.auth.me() -> property access) needs a
// real base44 endpoint, so this probe deliberately stops at the boundary it can
// observe offline: it proves rejection happens for missing/disallowed Origin and
// missing cookie, and it does NOT claim to have tested an authorized handshake.
//
// Run: node scripts/probe-ws-server.mjs

import { spawn } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './_repo-root.mjs';

// See scripts/_repo-root.mjs — the old `.pathname` form gave `C:\C:\Users\...`
// on Windows, so backend/websocket.js was unreadable and this probe died at
// load. It claimed "20 passed, 0 failed" in the checklist while never running.
const ROOT = REPO_ROOT;
const SERVER = path.join(ROOT, 'backend/websocket.js');
const ALLOWED = 'http://allowed.example';

let pass = 0;
let fail = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    const line = detail ? `${name} — ${detail}` : name;
    failures.push(line);
    console.log(`  FAIL  ${line}`);
  }
}

// ── 1. The import specifier ────────────────────────────────────────────────
console.log('\n1. Import specifiers');
const src = readFileSync(SERVER, 'utf8');
check('setupWSConnection is imported from the y-websocket/bin/utils subpath',
  /from\s+['"]y-websocket\/bin\/utils['"]/.test(src),
  'the root entry does not export it — the process dies at load');
check('the bare y-websocket root import is gone',
  !/import\s*\{[^}]*setupWSConnection[^}]*\}\s*from\s*['"]y-websocket['"]/.test(src),
  'that specifier throws SyntaxError before listen()');
check('the upgrade is completed through wss.handleUpgrade',
  /wss\.handleUpgrade\(\s*req\s*,\s*socket\s*,\s*head/.test(src),
  'without a handshake setupWSConnection receives a net.Socket');
check('setupWSConnection receives the WebSocket and the request, not the raw socket',
  /setupWSConnection\(\s*ws\s*,\s*req\s*,/.test(src),
  'signature is (WebSocket, IncomingMessage, opts)');

// ── 2. What y-websocket actually exports ───────────────────────────────────
console.log('\n2. The y-websocket API this file depends on');
const rootMod = await import('y-websocket');
check('the y-websocket ROOT entry really does not export setupWSConnection',
  !('setupWSConnection' in rootMod),
  `root exports: ${Object.keys(rootMod).join(', ')} — this is the original bug, not a guess`);
const utilsMod = await import('y-websocket/bin/utils');
check('y-websocket/bin/utils exports setupWSConnection',
  typeof utilsMod.setupWSConnection === 'function',
  `bin/utils exports: ${Object.keys(utilsMod).join(', ')}`);

// ── 3. Why passing a raw socket could never work ───────────────────────────
console.log('\n3. The old call shape, executed');
// Measured, not assumed. A net.Socket IS an EventEmitter, so setupWSConnection's
// conn.on('message'|'close'|'pong') registrations all succeed silently — that is
// why this bug never announced itself. The first genuine WebSocket-only surface
// it touches is the NUMERIC readyState: y-websocket's send() compares against
// 0/1, a net.Socket reports the string 'open', so send() decides the peer is
// gone and calls closeConn(), whose final line is conn.close() — which a
// net.Socket does not have.
const rawSock = new net.Socket();
check('a net.Socket satisfies the EventEmitter part of the WebSocket shape',
  typeof rawSock.on === 'function',
  'this is why the old code threw nothing during setup — the .on() calls all worked');
check('a net.Socket reports readyState as a string, not the numeric WebSocket enum',
  typeof rawSock.readyState === 'string',
  `readyState=${JSON.stringify(rawSock.readyState)}; y-websocket send() compares to 0/1, so it reads "not open"`);
check('a net.Socket has neither .close() nor .send()',
  typeof rawSock.close !== 'function' && typeof rawSock.send !== 'function',
  'both are required by setupWSConnection/closeConn');

let threw = '';
try {
  const fakeConn = new net.Socket(); // exactly what the old code passed
  utilsMod.setupWSConnection(fakeConn, Buffer.alloc(0), { docName: 'probe-doc' });
} catch (err) {
  threw = err.message;
}
// Asserting the specific method is deliberate: it pins the failure to the
// missing WebSocket surface rather than to any error at all.
check('setupWSConnection on a raw net.Socket throws on the missing .close()',
  /close is not a function/.test(threw),
  threw ? `threw: ${threw}` : 'it did NOT throw — the old call may have been viable after all');

// ── 4. The server starts and serves ────────────────────────────────────────
console.log('\n4. Startup');
const port = 20000 + (crypto.randomInt(9000));
const child = spawn(process.execPath, [SERVER], {
  env: { ...process.env, PORT: String(port), ALLOWED_WS_ORIGINS: ALLOWED },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
child.stdout.on('data', (d) => { out += d.toString(); });
child.stderr.on('data', (d) => { out += d.toString(); });

// Startup budget is 60s, which looks absurd for a server that only calls
// listen(). It is not: importing @base44/sdk alone was measured at ~7.5s in a
// cold container, plus ~1s for y-websocket and ~0.4s for ws. A 12s budget made
// this assertion flaky (passed, then failed on the next run with no code change)
// — the failure was this timer, not the server. verify-all.mjs allows 240s per
// suite, so 60s costs nothing on a healthy run and only trips on a real hang.
const STARTUP_BUDGET_MS = 60000;
const t0 = Date.now();
const listening = await new Promise((resolve) => {
  const t = setTimeout(() => resolve(false), STARTUP_BUDGET_MS);
  const tick = setInterval(() => {
    if (/listening on/.test(out)) { clearTimeout(t); clearInterval(tick); resolve(true); }
    if (child.exitCode !== null) { clearTimeout(t); clearInterval(tick); resolve(false); }
  }, 100);
});
const startupMs = Date.now() - t0;
check(`backend/websocket.js starts and listens (${startupMs}ms)`, listening,
  `exitCode=${child.exitCode} after ${startupMs}ms of ${STARTUP_BUDGET_MS}ms — output: ${out.trim().split('\n').slice(0, 4).join(' | ') || '(none)'}`);
check('startup produced no SyntaxError', !/SyntaxError/.test(out),
  out.match(/SyntaxError.*/)?.[0] || '');

// Raw HTTP so every header is under our control.
function rawRequest(headers, { pathname = '/prop1', waitMs = 2500 } = {}) {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    let buf = '';
    let done = false;
    const finish = (why) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch { /* already gone */ }
      resolve({ body: buf, why });
    };
    sock.on('connect', () => {
      sock.write(`GET ${pathname} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n${headers}\r\n`);
    });
    sock.on('data', (d) => { buf += d.toString(); });
    sock.on('close', () => finish('closed'));
    sock.on('error', () => finish('error'));
    setTimeout(() => finish('timeout'), waitMs);
  });
}
const UPGRADE = 'Upgrade: websocket\r\nConnection: Upgrade\r\n'
  + `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\n`
  + 'Sec-WebSocket-Version: 13\r\n';

if (listening) {
  console.log('\n5. Plain HTTP');
  const plain = await rawRequest('Connection: close\r\n');
  check('GET / answers over plain HTTP',
    /Yjs WebSocket server/.test(plain.body), `got: ${plain.body.slice(0, 80)}`);

  console.log('\n6. CSWSH rejection (the logic at lines 107-143 is unchanged)');
  const noOrigin = await rawRequest(UPGRADE);
  check('an upgrade with NO Origin header is rejected 403',
    /403/.test(noOrigin.body), `got: ${noOrigin.body.slice(0, 60) || '(empty)'}`);

  const badOrigin = await rawRequest(`${UPGRADE}Origin: http://evil.example\r\n`);
  check('an upgrade from a disallowed Origin is rejected 403',
    /403/.test(badOrigin.body), `got: ${badOrigin.body.slice(0, 60) || '(empty)'}`);

  const noCookie = await rawRequest(`${UPGRADE}Origin: ${ALLOWED}\r\n`);
  check('an allowed Origin with no session cookie is dropped, not upgraded',
    !/101/.test(noCookie.body),
    `expected no 101 Switching Protocols; got: ${noCookie.body.slice(0, 60) || '(empty)'}`);
  check('the allowed Origin got PAST the 403 gate (so the allowlist works)',
    !/403/.test(noCookie.body),
    `an allowlisted origin must not be 403'd; got: ${noCookie.body.slice(0, 60) || '(empty)'}`);

  const badDoc = await rawRequest(`${UPGRADE}Origin: ${ALLOWED}\r\n`, { pathname: '/bad..name' });
  check('a malformed property id is dropped, not upgraded',
    !/101/.test(badDoc.body), `got: ${badDoc.body.slice(0, 60) || '(empty)'}`);
}

try { child.kill('SIGKILL'); } catch { /* already exited */ }

// ── 7. The handshake mechanism itself, end to end ──────────────────────────
// Sections 1 and 6 can only pin the *shape* of the fix: the app's own upgrade
// path destroys the socket before reaching handleUpgrade unless a valid
// base44 session cookie is present, and auth.me() needs the network. So the
// positive case is proven here instead, against a local server that uses the
// exact same two-step handoff (wss.handleUpgrade -> setupWSConnection) with the
// auth check removed. If this passes, the pattern backend/websocket.js now uses
// is known to produce a completed handshake and a live Yjs sync stream.
console.log('\n7. handleUpgrade -> setupWSConnection, end to end');
const { WebSocketServer, default: WebSocket } = await import('ws');
const localPort = 20000 + crypto.randomInt(9000);
const localWss = new WebSocketServer({ noServer: true });
const localServer = http.createServer((_req, res) => { res.writeHead(200); res.end('ok'); });
localServer.on('upgrade', (req, socket, head) => {
  localWss.handleUpgrade(req, socket, head, (ws) => {
    utilsMod.setupWSConnection(ws, req, { docName: 'handshake-doc' });
  });
});
await new Promise((r) => localServer.listen(localPort, '127.0.0.1', r));

const handshake = await new Promise((resolve) => {
  const client = new WebSocket(`ws://127.0.0.1:${localPort}/handshake-doc`);
  const result = { open: false, firstByte: null, error: null };
  const done = () => { try { client.close(); } catch { /* noop */ } resolve(result); };
  client.on('open', () => { result.open = true; });
  client.on('message', (data) => {
    // y-websocket's first server->client frame is sync step 1: a varuint
    // message type, where messageSync === 0.
    // Read byte 0 via Buffer indexing, NOT `new Uint8Array(data.buffer)[0]`.
    // A Node Buffer is a view into a shared pool, so `.buffer` is the whole
    // pool and index 0 is whatever else happens to sit at its start — that
    // read returned 72 ('H', from pooled HTTP text) instead of the frame byte.
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    result.firstByte = buf[0];
    done();
  });
  client.on('error', (e) => { result.error = e.message; done(); });
  setTimeout(done, 8000);
});
localWss.close();
localServer.close();

check('the handshake completes — the client reaches the OPEN state',
  handshake.open === true,
  handshake.error ? `client error: ${handshake.error}` : 'no 101 Switching Protocols');
check('the server sends Yjs sync step 1 over the upgraded socket',
  handshake.firstByte === 0,
  `expected first byte 0 (messageSync); got ${handshake.firstByte} — this is the conn.send() path the old code could never reach`);

console.log(`\n${'─'.repeat(60)}`);
console.log(`probe-ws-server: ${pass} passed, ${fail} failed`);
console.log('NOT TESTED: an AUTHORIZED handshake through backend/websocket.js\'s');
console.log('            own upgrade handler. That needs a live base44 endpoint');
console.log('            for auth.me(), so sections 1/6 pin the handoff shape');
console.log('            statically and section 7 proves the mechanism works');
console.log('            against an identical server with auth removed.');
if (fail) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log(`  · ${f}`));
  process.exit(1);
}
process.exit(0);
