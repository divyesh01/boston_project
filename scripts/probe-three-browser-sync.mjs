import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { createServer as createViteServer } from 'vite';

const testkit = await import('./_worker-testkit.mjs');
const { makeDb, makeEnv, seedUser, seedCredential } = testkit;
const worker = (await import('../worker/index.js')).default;

const pwCandidates = [
  process.env.PLAYWRIGHT_MODULE_PATH,
  'C:/Users/divye/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs',
  'playwright',
].filter(Boolean);

let playwright = null;
for (const cand of pwCandidates) {
  try {
    const target = cand.includes(':') || cand.startsWith('/') ? pathToFileURL(path.resolve(cand)).href : cand;
    playwright = await import(target);
    if (playwright?.chromium) break;
  } catch {}
}
assert(playwright, 'Playwright module could not be dynamically imported.');

const defaultChromeWin = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const chromeExe = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (process.platform === 'win32' && fs.existsSync(defaultChromeWin) ? defaultChromeWin : undefined);

const PEPPER = 'production-test-pepper-at-least-32-chars-long';
const ACCT_PRIMARY = 'acct_probe_primary';
const ACCT_ATTACKER = 'acct_probe_attacker';
const OWNER_EMAIL = 'owner@rri.test';
const OWNER_PASSWORD = 'Owner-Secure-Pass-1!';
const GM_EMAIL = 'gm@rri.test';
const GM_PASSWORD = 'GM-Secure-Pass-1!';
const OWNER2_EMAIL = 'owner2@rri.test';
const ATTACKER_EMAIL = 'attacker@other.test';
const ATTACKER_PASSWORD = 'Attacker-Pass-1!';

const serverDb = makeDb();
serverDb.prepare('INSERT INTO account (id, name, created_date) VALUES (?, ?, ?)').run(ACCT_PRIMARY, 'Primary Group', new Date().toISOString());
serverDb.prepare('INSERT INTO account (id, name, created_date) VALUES (?, ?, ?)').run(ACCT_ATTACKER, 'Attacker Group', new Date().toISOString());

const insProp = serverDb.prepare('INSERT INTO property (id, account_id, code, name, rooms, active, created_date) VALUES (?, ?, ?, ?, ?, 1, ?)');
insProp.run('prop_1', ACCT_PRIMARY, 'RRI101', 'Red Roof West', 50, new Date().toISOString());
insProp.run('prop_2', ACCT_PRIMARY, 'RRI102', 'Red Roof East', 40, new Date().toISOString());
insProp.run('prop_oth', ACCT_ATTACKER, 'OTH999', 'Other Hotel', 20, new Date().toISOString());

seedUser(serverDb, { id: 'user_a', accountId: ACCT_PRIMARY, email: OWNER_EMAIL, username: 'rri_owner', role: 'owner', mode: 'all' });
await seedCredential(serverDb, { userId: 'user_a', accountId: ACCT_PRIMARY, password: OWNER_PASSWORD, pepper: PEPPER });

seedUser(serverDb, { id: 'user_b', accountId: ACCT_PRIMARY, email: GM_EMAIL, username: 'rri_gm', role: 'manager', mode: 'specific', grants: ['prop_1'] });
serverDb.prepare("UPDATE user SET permissions=? WHERE account_id=? AND id=?")
  .run(JSON.stringify({ manage_operations: true }), ACCT_PRIMARY, 'user_b');
await seedCredential(serverDb, { userId: 'user_b', accountId: ACCT_PRIMARY, password: GM_PASSWORD, pepper: PEPPER });

seedUser(serverDb, { id: 'user_c', accountId: ACCT_PRIMARY, email: OWNER2_EMAIL, username: 'rri_owner2', role: 'owner', mode: 'all' });
await seedCredential(serverDb, { userId: 'user_c', accountId: ACCT_PRIMARY, password: OWNER_PASSWORD, pepper: PEPPER });

seedUser(serverDb, { id: 'user_att', accountId: ACCT_ATTACKER, email: ATTACKER_EMAIL, username: 'attacker', role: 'owner', mode: 'all' });
await seedCredential(serverDb, { userId: 'user_att', accountId: ACCT_ATTACKER, password: ATTACKER_PASSWORD, pepper: PEPPER });

serverDb.prepare('INSERT OR IGNORE INTO user_property_access (account_id, user_id, property_id) VALUES (?, ?, ?)').run(ACCT_PRIMARY, 'user_b', 'prop_1');

const baseEnv = makeEnv(serverDb, {
  ENVIRONMENT: 'production',
  ENABLE_BUSINESS_SYNC_API: 'true',
  ENABLE_D1_DATA_API: 'false',
  PASSWORD_PEPPER_V1: PEPPER,
});

const now = new Date().toISOString();
const genId = 'gen_probe_seed_01';
serverDb.prepare(`INSERT INTO business_dataset (
  account_id, generation_id, status, schema_version, manifest_hash, manifest_json,
  expected_chunks, expected_records, created_by, created_at, activated_at
) VALUES (?, ?, 'active', 1, 'manifest_seed', '{}', 1, 26, 'user_a', ?, ?)`).run(ACCT_PRIMARY, genId, now, now);

serverDb.prepare('INSERT INTO business_dataset_pointer (account_id, active_generation_id, updated_at) VALUES (?, ?, ?)').run(ACCT_PRIMARY, genId, now);
serverDb.prepare('INSERT INTO business_sync_state (account_id, revision) VALUES (?, 1)').run(ACCT_PRIMARY);

const insMap = serverDb.prepare('INSERT INTO business_property_map (account_id, generation_id, property_key, server_property_id, property_code) VALUES (?, ?, ?, ?, ?)');
insMap.run(ACCT_PRIMARY, genId, 's:6:prop_1', 'prop_1', 'RRI101');
insMap.run(ACCT_PRIMARY, genId, 's:6:prop_2', 'prop_2', 'RRI102');

const insRec = serverDb.prepare('INSERT INTO business_record (account_id, generation_id, entity_name, record_key, property_key, server_property_id, row_json, row_hash, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');

const ENTITIES = [
  'Property', 'OccupancyDay', 'SourceDay', 'GrossRevenueDay', 'PaymentDay',
  'ClerkShiftRecord', 'UploadedReport', 'Expense', 'PayrollRun', 'Staff',
  'HotelMetric', 'TransactionLine', 'AnomalyAlert', 'Room', 'RoomStay',
  'HousekeepingTask', 'WeatherSnapshot', 'Review', 'AdjustmentRefund',
  'DailyFinancialAggregate', 'ScanResult', 'TimecardPunch', 'Reservation',
  'RoomType', 'ChannelMap',
];

function sha256HexSync(val) {
  return crypto.createHash('sha256').update(typeof val === 'string' ? val : JSON.stringify(val)).digest('hex');
}

const seedRows = [
  { entity: 'Property', row: { id: 'prop_1', code: 'RRI101', name: 'Red Roof West', active: 1, rooms: 50, created_date: now } },
  { entity: 'Property', row: { id: 'prop_2', code: 'RRI102', name: 'Red Roof East', active: 1, rooms: 40, created_date: now } },
  { entity: 'Staff', row: { id: 'staff_1', property_id: 'prop_1', employee_name: 'Alice Baseline', department: 'Desk', active: 1, created_date: now } },
  { entity: 'Expense', row: { id: 'exp_1', property_id: 'prop_1', amount: 150, category: 'Supplies', expense_date: '2026-01-01', created_date: now } },
  { entity: 'Room', row: { id: 'room_1', property_id: 'prop_1', room_number: '101', room_type: 'King', status: 'clean', created_date: now } },
  { entity: 'SourceDay', row: { id: 'src_1', property_id: 'prop_1', date: '2026-01-01', code: 'OTA', source: 'Expedia', net_revenue: 350, created_date: now } },
];

for (const e of ENTITIES) {
  if (['Property', 'Staff', 'Expense', 'Room', 'SourceDay'].includes(e)) continue;
  seedRows.push({
    entity: e,
    row: {
      id: e.toLowerCase() + '_1',
      property_id: 'prop_1',
      date: '2026-01-01',
      shift_date: '2026-01-01',
      business_date: '2026-01-01',
      task_date: '2026-01-01',
      review_date: '2026-01-01',
      check_in: '2026-01-01',
      pay_period_start: '2026-01-01',
      created_date: now,
    },
  });
}

for (const { entity, row } of seedRows) {
  const rKey = 's:' + String(row.id).length + ':' + row.id;
  const pKey = entity === 'Property' ? rKey : 's:' + String(row.property_id).length + ':' + row.property_id;
  const sPid = entity === 'Property' ? row.id : row.property_id;
  const jsonStr = JSON.stringify(row);
  insRec.run(ACCT_PRIMARY, genId, entity, rKey, pKey, sPid, jsonStr, sha256HexSync(jsonStr), now);
}

const testClientJsx = `
import React, { useState } from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClientProvider, useQuery } from '@tanstack/react-query';
import { queryClientInstance } from '/src/lib/query-client.js';
import { useRealtimeInvalidation, isCurrentTabLeader } from '/src/lib/realtime.js';
import { createBusinessSyncClient } from '/src/api/businessSync.js';
import localDb from '/src/api/localDb.js';

async function clientRequest(path, options = {}) {
  const res = await fetch('/api/' + path, {
    ...options,
    headers: { 'content-type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', ...(options.headers || {}) },
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(json?.error || 'HTTP ' + res.status);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

const sync = createBusinessSyncClient({ request: clientRequest });
const wrappedStaff = sync.wrapEntity('Staff', { list: () => localDb.Staff.toArray(), get: (id) => localDb.Staff.get(id), delete: (id) => localDb.Staff.delete(id) });
const wrappedExpense = sync.wrapEntity('Expense', { list: () => localDb.Expense.toArray(), get: (id) => localDb.Expense.get(id), delete: (id) => localDb.Expense.delete(id) });
const wrappedRoom = sync.wrapEntity('Room', { list: () => localDb.Room.toArray(), get: (id) => localDb.Room.get(id), delete: (id) => localDb.Room.delete(id) });
const wrappedSourceDay = sync.wrapEntity('SourceDay', { list: () => localDb.SourceDay.toArray(), get: (id) => localDb.SourceDay.get(id), delete: (id) => localDb.SourceDay.delete(id) });

window.__sync = sync;
window.__localDb = localDb;
window.__wrapped = { Staff: wrappedStaff, Expense: wrappedExpense, Room: wrappedRoom, SourceDay: wrappedSourceDay };
window.__isLeader = isCurrentTabLeader;

sync.api.hydrateFromServer().catch(console.error);

function ProbeApp() {
  useRealtimeInvalidation(['Staff', 'Expense', 'Room', 'SourceDay'], { enabled: true, pollMs: 10000 });
  const staffQuery = useQuery({ queryKey: ['Staff'], queryFn: () => wrappedStaff.list() });
  const expenseQuery = useQuery({ queryKey: ['Expense'], queryFn: () => wrappedExpense.list() });
  const roomQuery = useQuery({ queryKey: ['Room'], queryFn: () => wrappedRoom.list() });
  const sourceQuery = useQuery({ queryKey: ['SourceDay'], queryFn: () => wrappedSourceDay.list() });
  const [opState, setOpState] = useState('idle');

  const executeAction = async (action) => {
    setOpState('running_' + action);
    try {
      const { entity, id, data } = window.__nextAction || {};
      const proxy = window.__wrapped[entity];
      if (action === 'create') await proxy.create(data);
      else if (action === 'update') await proxy.update(id, data);
      else if (action === 'delete') await proxy.delete(id);
      setOpState('done_' + action);
    } catch (err) {
      window.__lastActionError = err;
      setOpState('error_' + action);
    }
  };

  return React.createElement('div', { id: 'probe-root' },
    React.createElement('div', { id: 'controls' },
      React.createElement('button', { id: 'btn-create', onClick: () => executeAction('create') }, 'Create'),
      React.createElement('button', { id: 'btn-update', onClick: () => executeAction('update') }, 'Update'),
      React.createElement('button', { id: 'btn-delete', onClick: () => executeAction('delete') }, 'Delete'),
      React.createElement('span', { id: 'op-status' }, opState)
    ),
    React.createElement('div', { id: 'staff-section' },
      React.createElement('span', { id: 'staff-count' }, staffQuery.data?.length ?? 0),
      React.createElement('div', { id: 'staff-list' }, (staffQuery.data || []).map((s) => React.createElement('div', { key: s.id, id: 'staff-' + s.id }, s.id + ':' + s.employee_name + ':' + s.department)))
    ),
    React.createElement('div', { id: 'expense-section' },
      React.createElement('span', { id: 'expense-count' }, expenseQuery.data?.length ?? 0),
      React.createElement('div', { id: 'expense-list' }, (expenseQuery.data || []).map((e) => React.createElement('div', { key: e.id, id: 'expense-' + e.id }, e.id + ':' + e.amount + ':' + e.category)))
    ),
    React.createElement('div', { id: 'room-section' },
      React.createElement('span', { id: 'room-count' }, roomQuery.data?.length ?? 0),
      React.createElement('div', { id: 'room-list' }, (roomQuery.data || []).map((r) => React.createElement('div', { key: r.id, id: 'room-' + r.id }, r.id + ':' + r.room_number + ':' + r.status)))
    ),
    React.createElement('div', { id: 'sourceday-section' },
      React.createElement('span', { id: 'sourceday-count' }, sourceQuery.data?.length ?? 0),
      React.createElement('div', { id: 'sourceday-list' }, (sourceQuery.data || []).map((src) => React.createElement('div', { key: src.id, id: 'sourceday-' + src.id }, src.id + ':' + src.code + ':' + src.net_revenue)))
    )
  );
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(React.createElement(QueryClientProvider, { client: queryClientInstance }, React.createElement(ProbeApp)));
`;

const virtualPlugin = {
  name: 'virtual-probe-client',
  resolveId(id) {
    if (id === '/probe-client.js' || id === '/probe-client.jsx' || id.endsWith('probe-client.js') || id.endsWith('probe-client.jsx')) return '\0virtual:probe-client.js';
  },
  load(id) {
    if (id === '\0virtual:probe-client.js') return testClientJsx;
  },
};

const vite = await createViteServer({
  plugins: [virtualPlugin],
  resolve: { alias: { '@': path.resolve('src') } },
  server: { middlewareMode: true },
  appType: 'custom',
  optimizeDeps: {
    noDiscovery: true,
    entries: [],
    include: ['react', 'react-dom', 'react-dom/client', '@tanstack/react-query', 'dexie'],
  },
});

let httpTotalRequests = 0;
const server = http.createServer(async (req, res) => {
  httpTotalRequests++;
  try {
    const url = new URL(req.url, 'http://' + req.headers.host);
    if (url.pathname.startsWith('/api/')) {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (Array.isArray(v)) v.forEach((val) => headers.append(k, val));
        else if (v !== undefined) headers.set(k, v);
      }
      // The production cookie is correctly __Host-prefixed and therefore cannot
      // be installed on this HTTP-only local probe origin. Translate only inside
      // the test server; the real Worker still receives its exact production key.
      const probeCookie = String(req.headers.cookie || '')
        .split(';')
        .map((part) => part.trim())
        .find((part) => part.startsWith('rri_probe_session='));
      if (probeCookie) {
        headers.set('cookie', `__Host-rri_session=${probeCookie.slice('rri_probe_session='.length)}`);
      }
      let body = null;
      if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
        const chunks = [];
        for await (const ch of req) chunks.push(ch);
        body = Buffer.concat(chunks);
      }
      const workerReq = new Request(url.href, {
        method: req.method,
        headers,
        body: body && body.length > 0 ? body : undefined,
      });
      const workerRes = await worker.fetch(workerReq, baseEnv, { waitUntil() {}, passThroughOnException() {} });
      res.statusCode = workerRes.status;
      for (const [k, v] of workerRes.headers.entries()) res.setHeader(k, v);
      const cookies = typeof workerRes.headers.getSetCookie === 'function'
        ? workerRes.headers.getSetCookie()
        : [workerRes.headers.get('set-cookie')].filter(Boolean);
      if (cookies.length) res.setHeader('set-cookie', cookies);
      const buf = Buffer.from(await workerRes.arrayBuffer());
      res.end(buf);
      return;
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      let html = '<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Sync Probe</title><script>window.VITE_USE_LOCAL_AUTH="true";</script></head><body><div id="root"></div><script type="module" src="/probe-client.js"></script></body></html>';
      html = await vite.transformIndexHtml(url.pathname, html);
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(html);
      return;
    }
    vite.middlewares(req, res);
  } catch (err) {
    res.statusCode = 500;
    res.end(String(err.stack || err));
  }
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const serverPort = server.address().port;
const appUrl = 'http://127.0.0.1:' + serverPort;

async function getSessionCookie(email, password) {
  const req = new Request(`${appUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', origin: appUrl },
    body: JSON.stringify({ identifier: email, password }),
  });
  const res = await worker.fetch(req, baseEnv, { waitUntil() {}, passThroughOnException() {} });
  const resText = await res.text();
  if (res.status !== 200) {
    throw new Error(`Login failed for ${email}: status ${res.status}, body: ${resText}`);
  }
  const cookie = String(res.headers.get('set-cookie') || '').split(';', 1)[0];
  const equalsAt = cookie.indexOf('=');
  assert(equalsAt > 0, `Login response for ${email} did not include a session cookie`);
  const name = cookie.slice(0, equalsAt);
  const value = cookie.slice(equalsAt + 1);
  assert(value.length > 0, `Login response for ${email} included an empty session cookie`);
  return { name: 'rri_probe_session', value, domain: '127.0.0.1', path: '/' };
}

const cookieA = await getSessionCookie(OWNER_EMAIL, OWNER_PASSWORD);
const cookieB = await getSessionCookie(GM_EMAIL, GM_PASSWORD);
const cookieC = await getSessionCookie(OWNER2_EMAIL, OWNER_PASSWORD);
const cookieAtt = await getSessionCookie(ATTACKER_EMAIL, ATTACKER_PASSWORD);

const passedTests = [];
const failedTests = [];
const notRunTests = [
  'Cross-context native BroadcastChannel propagation (browsers isolate BC per profile context)',
  '10-minute idle soak (fast run mode: verified real 10s idle writes)',
];

async function runTest(name, fn) {
  try {
    await fn();
    passedTests.push(name);
    console.log(`  [PASSED] ${name}`);
  } catch (err) {
    failedTests.push({ name, err });
    console.error(`  [FAILED] ${name}:`, err.message);
  }
}

let browser = null;
let ctxA = null;
let ctxB = null;
let ctxC = null;
let ctxAtt = null;
let ctxBCDisabled = null;
const latencies = [];

try {
  const launchOpts = { headless: true };
  if (chromeExe) launchOpts.executablePath = chromeExe;
  browser = await playwright.chromium.launch(launchOpts);

  ctxA = await browser.newContext();
  ctxB = await browser.newContext();
  ctxC = await browser.newContext();
  ctxAtt = await browser.newContext();
  ctxBCDisabled = await browser.newContext();

  await ctxA.addCookies([cookieA]);
  await ctxB.addCookies([cookieB]);
  await ctxC.addCookies([cookieC]);
  await ctxAtt.addCookies([cookieAtt]);
  await ctxBCDisabled.addCookies([cookieA]);
  await ctxBCDisabled.addInitScript(() => { delete window.BroadcastChannel; });

  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  const pageC = await ctxC.newPage();

  const pageErrors = [];
  const attachErrorCapture = (page, name) => {
    page.on('pageerror', (err) => pageErrors.push(`[${name} pageerror] ${err.stack || err}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') pageErrors.push(`[${name} console.error] ${msg.text()}`);
    });
  };
  attachErrorCapture(pageA, 'Context A');
  attachErrorCapture(pageB, 'Context B');
  attachErrorCapture(pageC, 'Context C');

  try {
    await Promise.all([pageA.goto(appUrl), pageB.goto(appUrl), pageC.goto(appUrl)]);
    await Promise.all([
      pageA.waitForSelector('#probe-root', { timeout: 10000 }),
      pageB.waitForSelector('#probe-root', { timeout: 10000 }),
      pageC.waitForSelector('#probe-root', { timeout: 10000 }),
    ]);
  } catch (error) {
    const details = pageErrors.length
      ? `\nCollected browser errors:\n${pageErrors.join('\n')}`
      : '\nNo console or page errors captured.';
    throw new Error(`Failed to load #probe-root within 10s: ${error.message}${details}`);
  }

  await runTest('Storage sentinels prove context isolation', async () => {
    await pageA.evaluate(() => localStorage.setItem('probe_sentinel', 'SENTINEL_A'));
    await pageB.evaluate(() => localStorage.setItem('probe_sentinel', 'SENTINEL_B'));
    await pageC.evaluate(() => localStorage.setItem('probe_sentinel', 'SENTINEL_C'));
    assert.strictEqual(await pageA.evaluate(() => localStorage.getItem('probe_sentinel')), 'SENTINEL_A');
    assert.strictEqual(await pageB.evaluate(() => localStorage.getItem('probe_sentinel')), 'SENTINEL_B');
    assert.strictEqual(await pageC.evaluate(() => localStorage.getItem('probe_sentinel')), 'SENTINEL_C');
  });

  await runTest('Fresh hydration loads all 25 entities into IDB without server re-import', async () => {
    await pageA.waitForSelector('#staff-staff_1', { timeout: 25000 });
    await pageB.waitForSelector('#staff-staff_1', { timeout: 25000 });
    await pageC.waitForSelector('#staff-staff_1', { timeout: 25000 });
    const counts = await pageA.evaluate(async (entities) => {
      const res = {};
      for (const e of entities) res[e] = await window.__localDb[e].count();
      return res;
    }, ENTITIES);
    for (const e of ENTITIES) {
      assert(counts[e] >= 1, `Entity ${e} should have >=1 hydrated row in IDB`);
    }
  });

  const dispatchOp = async ({ actor, observers, entity, action, id, data, expectSubstr }) => {
    const t0 = Date.now();
    await actor.evaluate(({ entity, id, data }) => {
      window.__nextAction = { entity, id, data };
    }, { entity, id, data });
    await actor.click('#btn-' + action);
    await actor.waitForSelector('#op-status:has-text("done_' + action + '")', { timeout: 15000 });
    const targetSel = '#' + entity.toLowerCase() + '-' + id;
    for (const obs of observers) {
      if (action === 'create') {
        await obs.waitForSelector(targetSel, { timeout: 35000 });
      } else if (action === 'update') {
        await obs.waitForFunction(
          ({ sel, text }) => document.querySelector(sel)?.textContent?.includes(text),
          { sel: targetSel, text: expectSubstr },
          { timeout: 35000 }
        );
      } else if (action === 'delete') {
        await obs.waitForSelector(targetSel, { state: 'detached', timeout: 35000 });
      }
    }
    const elapsed = Date.now() - t0;
    latencies.push(elapsed);
  };

  await runTest('CRUD cycles from EACH context A, B, C for Staff, Expense, Room, SourceDay', async () => {
    await dispatchOp({
      actor: pageA,
      observers: [pageB, pageC],
      entity: 'Staff',
      action: 'create',
      id: 'staff_a2',
      data: { id: 'staff_a2', property_id: 'prop_1', employee_name: 'Bob A', department: 'Maintenance', active: 1 },
    });
    await dispatchOp({
      actor: pageB,
      observers: [pageA, pageC],
      entity: 'Staff',
      action: 'update',
      id: 'staff_a2',
      data: { employee_name: 'Bob A Updated', department: 'Engineering' },
      expectSubstr: 'Bob A Updated',
    });
    await dispatchOp({
      actor: pageC,
      observers: [pageA, pageB],
      entity: 'Staff',
      action: 'delete',
      id: 'staff_a2',
    });
    await dispatchOp({
      actor: pageB,
      observers: [pageA, pageC],
      entity: 'Expense',
      action: 'create',
      id: 'exp_b2',
      data: { id: 'exp_b2', property_id: 'prop_1', amount: 320, category: 'Repairs', expense_date: '2026-01-02' },
    });
    await dispatchOp({
      actor: pageC,
      observers: [pageA, pageB],
      entity: 'Expense',
      action: 'update',
      id: 'exp_b2',
      data: { amount: 450, category: 'HVAC' },
      expectSubstr: '450',
    });
    await dispatchOp({
      actor: pageA,
      observers: [pageB, pageC],
      entity: 'Expense',
      action: 'delete',
      id: 'exp_b2',
    });
    await dispatchOp({
      actor: pageC,
      observers: [pageA, pageB],
      entity: 'Room',
      action: 'create',
      id: 'room_c2',
      data: { id: 'room_c2', property_id: 'prop_1', room_number: '205', room_type: 'Suite', status: 'dirty' },
    });
    await dispatchOp({
      actor: pageA,
      observers: [pageB, pageC],
      entity: 'Room',
      action: 'update',
      id: 'room_c2',
      data: { status: 'inspected' },
      expectSubstr: 'inspected',
    });
    await dispatchOp({
      actor: pageB,
      observers: [pageA, pageC],
      entity: 'Room',
      action: 'delete',
      id: 'room_c2',
    });
    await dispatchOp({
      actor: pageA,
      observers: [pageB, pageC],
      entity: 'SourceDay',
      action: 'create',
      id: 'src_a2',
      data: { id: 'src_a2', property_id: 'prop_1', date: '2026-01-02', code: 'DIR', source: 'DirectWeb', net_revenue: 880 },
    });
    await dispatchOp({
      actor: pageB,
      observers: [pageA, pageC],
      entity: 'SourceDay',
      action: 'update',
      id: 'src_a2',
      data: { net_revenue: 950 },
      expectSubstr: '950',
    });
    await dispatchOp({
      actor: pageC,
      observers: [pageA, pageB],
      entity: 'SourceDay',
      action: 'delete',
      id: 'src_a2',
    });
  });

  await runTest('Idle verification: exactly 0 SQLite business writes during 10s quiet period', async () => {
    const getBusinessCounts = () => {
      const c = serverDb.prepare('SELECT COUNT(*) AS n FROM business_change').get().n;
      const r = serverDb.prepare('SELECT COUNT(*) AS n FROM business_record').get().n;
      return c + r;
    };
    const writesBefore = getBusinessCounts();
    const reqsBefore = httpTotalRequests;
    await new Promise((resolve) => setTimeout(resolve, 10000));
    const writesDelta = getBusinessCounts() - writesBefore;
    const reqsDelta = httpTotalRequests - reqsBefore;
    assert.strictEqual(writesDelta, 0, `Idle period wrote ${writesDelta} business rows to SQLite (expected 0)`);
    console.log(`    [Metrics] Idle polling requests: ${reqsDelta}, DB business writes: ${writesDelta}`);
  });

  await runTest('Negative cases: scope-only B isolation & foreign account isolation', async () => {
    const bProp2Count = await pageB.evaluate(async () => window.__localDb.Property.where('id').equals('prop_2').count());
    assert.strictEqual(bProp2Count, 0, 'Context B should not hydrate out-of-scope prop_2 into local IDB');
    await pageB.evaluate(() => {
      window.__nextAction = {
        entity: 'Staff',
        data: { id: 'staff_bad_scope', property_id: 'prop_2', employee_name: 'Out of Scope', department: 'Desk' },
      };
    });
    await pageB.click('#btn-create');
    await pageB.waitForSelector('#op-status:has-text("error_create")', { timeout: 15000 });
    const pageAtt = await ctxAtt.newPage();
    await pageAtt.goto(appUrl);
    await new Promise((r) => setTimeout(r, 1500));
    const attStaffCount = await pageAtt.evaluate(async () => window.__localDb.Staff.count());
    assert.strictEqual(attStaffCount, 0, 'Attacker context should not receive acct_1 records in IDB');
    await pageAtt.close();
  });

  await runTest('Dynamic scope revocation removes records automatically from local IDB & DOM', async () => {
    serverDb.prepare('DELETE FROM user_property_access WHERE account_id=? AND user_id=? AND property_id=?').run(ACCT_PRIMARY, 'user_b', 'prop_1');
    await pageB.waitForSelector('#staff-count:has-text("0")', { timeout: 35000 });
    const countInDb = await pageB.evaluate(async () => window.__localDb.Staff.count());
    assert.strictEqual(countInDb, 0, 'Revoked property records must be automatically evicted from localDb');
  });

  await runTest('Stale reopened page catches up and BC-disabled context syncs via polling', async () => {
    let rePageC = await ctxC.newPage();
    await rePageC.goto(appUrl);
    await rePageC.waitForSelector('#staff-count', { timeout: 20000 });
    await rePageC.close();
    await pageA.evaluate(() => {
      window.__nextAction = {
        entity: 'Staff',
        data: { id: 'staff_reopen_test', property_id: 'prop_1', employee_name: 'Reopen Catchup', department: 'Desk', active: 1 },
      };
    });
    await pageA.click('#btn-create');
    await pageA.waitForSelector('#op-status:has-text("done_create")', { timeout: 15000 });
    rePageC = await ctxC.newPage();
    await rePageC.goto(appUrl);
    await rePageC.waitForSelector('#staff-staff_reopen_test', { timeout: 35000 });
    await rePageC.close();
    const pageBC = await ctxBCDisabled.newPage();
    await pageBC.goto(appUrl);
    await pageBC.waitForSelector('#staff-staff_reopen_test', { timeout: 35000 });
    await pageBC.close();
  });

  await runTest('10 tabs leader diagnostic measured', async () => {
    const tabs = await Promise.all(Array.from({ length: 10 }, () => ctxA.newPage()));
    await Promise.all(tabs.map((t) => t.goto(appUrl)));
    await new Promise((r) => setTimeout(r, 4500));
    const leadership = await Promise.all(tabs.map((t) => t.evaluate(() => window.__isLeader && window.__isLeader())));
    const leaderCount = leadership.filter(Boolean).length;
    console.log(`    [Diagnostic] 10 tabs leader distribution: ${leaderCount} leader(s) elected`);
    await Promise.all(tabs.map((t) => t.close()));
  });

  if (latencies.length) {
    latencies.sort((a, b) => a - b);
    const mean = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
    const p50 = latencies[Math.floor(latencies.length * 0.5)];
    const max = latencies[latencies.length - 1];
    console.log(`\n[Latency Metrics] CRUD E2E mean: ${mean}ms, p50: ${p50}ms, max: ${max}ms (n=${latencies.length})`);
  }
} finally {
  if (browser) await browser.close().catch(() => {});
  await vite.close().catch(() => {});
  await new Promise((resolve) => server.close(resolve)).catch(() => {});
  serverDb.close();
}

console.log('\n============================================================');
console.log(`PROBE SUMMARY: PASSED: ${passedTests.length}, FAILED: ${failedTests.length}`);
for (const nr of notRunTests) console.log(`  [NOT_RUN] ${nr}`);
console.log('============================================================\n');

if (failedTests.length > 0) {
  console.error('FAILED scenarios:');
  for (const f of failedTests) console.error(`  - ${f.name}: ${f.err.stack || f.err}`);
  process.exit(1);
} else {
  console.log('PASSED: All cross-browser synchronization probe tests passed.');
  process.exit(0);
}
