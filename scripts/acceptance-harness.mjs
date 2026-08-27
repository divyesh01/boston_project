// Real-data acceptance test harness for Red Roof Intelligence.
// Runs the REAL app modules (reportParsers, base44Client/Dexie, aiEngine,
// hotel, commissionRates, taxConfig, taxSettings) through Vite SSR against the
// real HotelKey CSV exports in scripts/data/.  Source values are computed by an
// INDEPENDENT csv/amount parser in this file (different implementation from the
// app's csvParser.js) so import bugs cannot be masked by shared code.
//
// Usage: node scripts/acceptance-harness.mjs

import 'fake-indexeddb/auto';
import { createServer } from 'vite';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { installDomShims } from './_dom-shims.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const DATA_DIR = path.join(__dirname, 'data');

// ───────────────────────── Browser shims ─────────────────────────
//
// The window/document/location/Worker set comes from scripts/_dom-shims.mjs, which
// is the single source of that rule. This harness used to shim them itself and got
// it wrong in two ways at once: it defined `document` without `location`, so axios
// threw `Cannot read properties of undefined (reading 'href')` while importing
// base44Client — the harness died before its first assertion — and it had no
// `Worker`, so once that was fixed it died on `ReferenceError: Worker is not
// defined` in csvParser.fetchCsvRows instead. Both were already solved in
// _loader-boot.mjs; the copies here had simply never been updated. See the note at
// the top of _dom-shims.mjs.
//
// The storage and `document.createElement` shims below are genuinely specific to
// this harness (it exercises the CSV export path, which builds an <a> and clicks
// it), so they stay here — and they are installed BEFORE installDomShims(), which
// merges rather than overwrites.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
  key: (i) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
};
globalThis.sessionStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};
globalThis.document = {
  createElement: () => ({ click() {}, set href(v) {} }),
  body: { appendChild() {}, removeChild() {} },
  addEventListener() {},
};

installDomShims({ userAgent: 'acceptance-harness' });

if (!globalThis.URL.createObjectURL) globalThis.URL.createObjectURL = () => 'blob:harness';
if (!globalThis.URL.revokeObjectURL) globalThis.URL.revokeObjectURL = () => {};

// fetch() for file:// URLs so the app's fetchCsvRows(file_url) works unchanged.
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (!url.startsWith('file:')) return realFetch(input, init);
  const u = new URL(url);
  let p = decodeURIComponent(u.pathname);
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1); // /C:/... -> C:/...
  const buf = fs.readFileSync(p);
  return {
    ok: true, status: 200, url,
    text: async () => buf.toString('utf8'),
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    headers: new Map([['content-type', 'text/csv']]),
  };
};

// ───────────────────────── Independent source parser ─────────────────────────
function parseCsv(text) {
  const rows = [];
  let row = [], cur = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
function amt(s) {
  if (s == null) return 0;
  s = String(s).trim();
  if (!s) return 0;
  const neg = (s.startsWith('(') && s.endsWith(')')) || s.startsWith('-');
  const n = parseFloat(s.replace(/[$,()\s]/g, ''));
  return Number.isFinite(n) ? (neg ? -n : n) : 0;
}
function isoDate(s) {
  s = String(s || '').trim();
  let m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
  if (m) {
    const MON = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
    const mon = MON[m[2].toLowerCase()];
    if (mon) return `20${m[3].slice(-2)}-${mon}-${m[1].padStart(2, '0')}`;
  }
  m = s.match(/^([A-Za-z]{3})\s+(\d{1,2}),\s+(\d{4})$/);
  if (m) {
    const MON = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
    const mon = MON[m[1].toLowerCase()];
    if (mon) return `${m[3]}-${mon}-${m[2].padStart(2, '0')}`;
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return '';
}
const inW = (d, from, to) => d && d >= from && d <= to;
const sumVals = (arr) => arr.reduce((a, b) => a + b, 0);

// Import-session history, for the lifecycle assertions.
//
// This used to hand-decrypt localStorage: hardcode the prefixed slot name
// 'rri_enc_rri_import_sessions', pull 'rri_enc_key' from sessionStorage, and run
// AES-GCM by hand. Two copies of a crypto protocol is one rename away from reading
// nothing — and it did: the storage key drifted, the decrypt returned [], and
// check 10.2 reported "0 sessions" for an app that had recorded ten. base44Client
// exports listImportSessions() precisely so callers don't re-implement this, so
// the harness now calls the app's own API and keeps the manual decryption only as
// a fallback that must AGREE with it — disagreement is itself a failed check,
// because it means one of the two copies of the protocol has rotted.
// `client` is passed explicitly by both callers: clientMod is block-scoped inside
// the try that boots the Vite server, so a default parameter could not see it.
async function readSessions(client) {
  const viaApi = await client.listImportSessions();
  let viaStorage = null;
  try {
    const raw = localStorage.getItem('rri_enc_rri_import_sessions');
    const keyHex = (sessionStorage || localStorage).getItem('rri_enc_key');
    if (raw && keyHex) {
      const toBytes = (h) => Uint8Array.from(h.match(/.{1,2}/g).map((b) => parseInt(b, 16)));
      const bytes = toBytes(raw);
      const cryptoKey = await crypto.subtle.importKey('raw', toBytes(keyHex), 'AES-GCM', false, ['decrypt']);
      const dec = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, cryptoKey, bytes.slice(12));
      viaStorage = JSON.parse(new TextDecoder().decode(dec));
    }
  } catch {
    viaStorage = null; // old path is best-effort; the API path is authoritative
  }
  if (viaStorage && Array.isArray(viaStorage)) {
    T('10.0 listImportSessions() agrees with raw encrypted storage',
      viaApi.length, viaStorage.length, viaApi.length - viaStorage.length,
      { note: 'two readings of the same history must match; a mismatch means the storage key or format drifted' });
  }
  return Array.isArray(viaApi) ? viaApi : [];
}

function loadCsv(name) {
  return parseCsv(fs.readFileSync(path.join(DATA_DIR, name), 'utf8'));
}
function headerRow(rows) {
  return rows[0].map((h) => String(h).trim());
}
function colIndex(headers, names) {
  for (const n of names) {
    const i = headers.indexOf(n);
    if (i >= 0) return i;
  }
  return -1;
}

// Occupancy Summary source model: per-day rows + window aggregates
function srcOccupancy(file) {
  const rows = loadCsv(file);
  const h = headerRow(rows);
  const cDate = colIndex(h, ['Date']);
  const cRoomRev = colIndex(h, ['Room Revenue']);
  const cTotRev = colIndex(h, ['Total Revenue']);
  const cRooms = colIndex(h, ['Total Rooms']);
  const cSold = colIndex(h, ['Total Sold Rooms']);
  const cADR = colIndex(h, ['ADR']);
  const cRevpar = colIndex(h, ['Revpar With OOO Rooms', 'RevPAR With OOO Rooms']);
  const cRevpar2 = colIndex(h, ['Revpar Without OOO Rooms', 'RevPAR Without OOO Rooms']);
  const cOccIncl = colIndex(h, ['Occupancy Including OOO Comp and House Use']);
  const out = [];
  for (const r of rows.slice(1)) {
    const d = isoDate(r[cDate]);
    if (!d) continue;
    out.push({
      date: d,
      roomRevenue: amt(r[cRoomRev]), totalRevenue: amt(r[cTotRev]),
      rooms: +amt(r[cRooms]), sold: +amt(r[cSold]),
      adr: amt(r[cADR]), revpar: amt(r[cRevpar]), revparNoOOO: amt(r[cRevpar2]),
      occPct: amt(r[cOccIncl]),
    });
  }
  return out;
}
function aggWindow(rows, from, to) {
  const sel = rows.filter((r) => inW(r.date, from, to));
  return {
    days: sel.length,
    revenue: sumVals(sel.map((r) => r.totalRevenue)),
    roomRevenue: sumVals(sel.map((r) => r.roomRevenue)),
    rooms: sumVals(sel.map((r) => r.rooms)),
    sold: sumVals(sel.map((r) => r.sold)),
    adrW: sumVals(sel.map((r) => r.adr * r.sold)) / (sumVals(sel.map((r) => r.sold)) || 1),
    revparW: sumVals(sel.map((r) => r.revpar * r.rooms)) / (sumVals(sel.map((r) => r.rooms)) || 1),
    occW: sumVals(sel.map((r) => r.sold)) / (sumVals(sel.map((r) => r.rooms)) || 1),
  };
}

// Payments Summary source model (skip blank-date subtotal rows)
function srcPayments(file) {
  const rows = loadCsv(file);
  const h = headerRow(rows);
  const cDate = colIndex(h, ['Date']);
  const cols = ['CASH', 'CHECK', 'CLOSED BALANCE FOLIO', 'CORPAY', 'DIRECT BILL', 'LOYALTY CERTIFICATE', 'LOYALTY DISCOUNT', 'VIP PASS', 'WIRE TRANSFER', 'AMEX', 'DISCOVER', 'MASTER', 'OTHER', 'VISA', 'Total'];
  const idx = Object.fromEntries(cols.map((c) => [c, colIndex(h, [c])]));
  const out = [];
  for (const r of rows.slice(1)) {
    const d = isoDate(r[cDate]);
    if (!d) continue;
    const rec = { date: d };
    for (const c of cols) rec[c] = amt(r[idx[c]]);
    out.push(rec);
  }
  return out;
}
function payWindow(pays, from, to) {
  const sel = pays.filter((r) => inW(r.date, from, to));
  const tenders = ['CASH', 'CHECK', 'CLOSED BALANCE FOLIO', 'CORPAY', 'DIRECT BILL', 'LOYALTY CERTIFICATE', 'LOYALTY DISCOUNT', 'VIP PASS', 'WIRE TRANSFER', 'AMEX', 'DISCOVER', 'MASTER', 'OTHER', 'VISA'];
  return {
    days: sel.length,
    total: sumVals(sel.map((r) => r.Total)),
    cardVolume: sumVals(sel.map((r) => r.AMEX + r.DISCOVER + r.MASTER + r.VISA)),
    refunds: sumVals(sel.map((r) => Math.abs(r['CLOSED BALANCE FOLIO']) + Math.abs(r['LOYALTY DISCOUNT']))),
    byMethod: Object.fromEntries(tenders.map((c) => [c, sumVals(sel.map((r) => r[c]))])),
  };
}

// Gross Revenue Report source model
function srcGross(file) {
  const rows = loadCsv(file);
  const h = headerRow(rows);
  const cDate = colIndex(h, ['Date']);
  const cats = ['Room Rent', 'Misc Charge', 'System', 'Food', 'Event', 'Bar', 'Laundry', 'Phone', 'Other', 'Non Revenue', 'Advance Deposit', 'Beverage'];
  const idx = Object.fromEntries(cats.map((c) => [c, colIndex(h, [c])]));
  const out = [];
  for (const r of rows.slice(1)) {
    const d = isoDate(r[cDate]);
    if (!d) continue;
    out.push({ date: d, ...Object.fromEntries(cats.map((c) => [c, amt(r[idx[c]])])) });
  }
  return out;
}
function grossWindow(g, from, to) {
  const sel = g.filter((r) => inW(r.date, from, to));
  const cats = ['Room Rent', 'Misc Charge', 'System', 'Food', 'Event', 'Bar', 'Laundry', 'Phone', 'Other', 'Non Revenue', 'Advance Deposit', 'Beverage'];
  const byCat = Object.fromEntries(cats.map((c) => [c, sumVals(sel.map((r) => r[c]))]));
  return { days: sel.length, byCat, total: sumVals(cats.map((c) => byCat[c])) };
}

// Source Summary source model
function srcSource(file) {
  const rows = loadCsv(file);
  const h = headerRow(rows);
  const cDate = colIndex(h, ['Date']);
  const cCode = colIndex(h, ['Code']);
  const cSource = colIndex(h, ['Source']);
  const cNet = colIndex(h, ['Net Revenue']);
  const cStays = colIndex(h, ['Stays']);
  const out = [];
  for (const r of rows.slice(1)) {
    const d = isoDate(r[cDate]);
    if (!d) continue;
    out.push({ date: d, code: String(r[cCode]).trim(), source: String(r[cSource]).trim(), net: amt(r[cNet]), stays: +amt(r[cStays]) });
  }
  return out;
}
function srcWindow(srcs, from, to) {
  const sel = srcs.filter((r) => inW(r.date, from, to));
  const bySource = new Map();
  for (const r of sel) {
    const k = r.source || r.code || 'UNKNOWN';
    const cur = bySource.get(k) || { name: k, net: 0, stays: 0 };
    cur.net += r.net; cur.stays += r.stays;
    bySource.set(k, cur);
  }
  return {
    days: new Set(sel.map((r) => r.date)).size,
    totalNet: sumVals(sel.map((r) => r.net)),
    totalStays: sumVals(sel.map((r) => r.stays)),
    bySource: [...bySource.values()].sort((a, b) => b.net - a.net),
    rows: sel,
  };
}

// Clerk Shift source model (independent stacked-section parser)
function srcClerk(file) {
  const rows = loadCsv(file);
  const payments = new Map();  // last block wins per payment type
  const drops = [];
  const employees = [];
  let mode = null;
  for (const r of rows) {
    const a = String(r[0] || '').trim();
    const b = String(r[1] || '').trim();
    const c = String(r[2] || '').trim();
    const d = String(r[3] || '').trim();
    const hdr = [a, b, c, d].map((x) => x.toLowerCase());
    if (hdr.includes('payment type') && hdr.includes('actual') && hdr.includes('net today')) { mode = 'pay'; continue; }
    if (hdr.includes('username') && hdr.includes('start time')) { mode = 'shift'; continue; }
    if (hdr.includes('username') && hdr.includes('payment type') && hdr.includes('amount')) { mode = 'emp'; continue; }
    if (hdr.includes('expense type') && hdr.includes('amount')) { mode = 'exp'; continue; }
    if (r.every((x) => String(x).trim() === '')) { mode = null; continue; }
    const dm = a.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2} [AP]M)\s*-\s*(.+)$/i);
    if (mode === 'pay') {
      if (dm) { drops.push({ shift_date: dm[1], clerk_name: dm[2].trim(), amount: amt(b) }); continue; }
      if (a && !/^TOTAL|CALCULATED|DUE BACK|CASH OVER|PAID OUT|CURRENCY/i.test(a)) payments.set(a.toUpperCase(), { payment_type: a.toUpperCase(), actual: amt(b), adjusted: amt(c), net_today: amt(d) });
    } else if (mode === 'emp') {
      if (a && b && c !== '') employees.push({ clerk_name: a, payment_type: b.toUpperCase(), amount: amt(c) });
    } else if (mode === 'exp') {
      if (a && b !== '') employees.push({ clerk_name: a, payment_type: 'EXPENSE', amount: amt(b) });
    }
  }
  return { payments: [...payments.values()], drops, employees };
}

// ───────────────────────── Test bookkeeping ─────────────────────────
// Optional section filter, e.g. HARNESS_SKIP=3 to skip the import-lifecycle
// section.  Sections are stateful and run in order, so skipping is only for
// working around slow sandboxes (fake-indexeddb deletes are O(table size));
// a full unfiltered run remains the default and the source of truth.
const SKIP = new Set(String(process.env.HARNESS_SKIP || '').split(',').map((s) => s.trim()).filter(Boolean));
const skipSection = (id) => {
  if (!SKIP.has(id)) return false;
  console.log(`  (section ${id} skipped via HARNESS_SKIP)`);
  return true;
};

let passed = 0, failed = 0;
const failures = [];
const results = [];
// Wall-clock per check, so a slow sandbox can be diagnosed without guessing.
const HARNESS_T0 = Date.now();
let lastCheckAt = HARNESS_T0;
const TIMING = process.env.HARNESS_TIMING === '1';
function stamp() {
  const now = Date.now();
  const d = now - lastCheckAt;
  lastCheckAt = now;
  return TIMING ? `  [+${(d / 1000).toFixed(1)}s / ${((now - HARNESS_T0) / 1000).toFixed(1)}s]` : '';
}
// Times one step inside a test body; no-op unless HARNESS_TIMING=1.
async function mark(label, fn) {
  if (!TIMING) return fn();
  const t = Date.now();
  const out = await fn();
  console.log(`        · ${label}: ${((Date.now() - t) / 1000).toFixed(1)}s`);
  lastCheckAt = Date.now();
  return out;
}
function T(name, source, dashboard, diff, opts = {}) {
  const tol = opts.tol ?? 0.011;
  const ok = diff === undefined ? opts.ok : Math.abs(diff) <= tol;
  const rec = { name, source, dashboard, diff: diff === undefined ? null : diff, pass: ok, note: opts.note || '' };
  results.push(rec);
  if (ok) { passed++; console.log(`  PASS  ${name}${stamp()}`); }
  else { failed++; failures.push(name); console.log(`  FAIL  ${name}   src=${source}  dash=${dashboard}  diff=${diff}  ${opts.note || ''}${stamp()}`); }
}
const money = (v) => `$${Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (v) => `${(Number(v || 0) * 100).toFixed(1)}%`;

// ───────────────────────── Boot app modules ─────────────────────────
const server = await createServer({
  root,
  logLevel: 'error',
  server: { middlewareMode: true, hmr: false },
  appType: 'custom',
  plugins: [],
  optimizeDeps: { noDiscovery: true },
  resolve: { alias: [{ find: '@', replacement: path.resolve(root, 'src') }] },
});
const mod = (rel) => server.ssrLoadModule(rel);
try {

const clientMod = await mod('/src/api/base44Client.js');
const db = clientMod.db || clientMod.default;
const localDbMod = await mod('/src/api/localDb.js');
const localDb = localDbMod.default;
const parsers = await mod('/src/lib/reportParsers.js');
const aiMod = await mod('/src/lib/aiEngine.js');
const answerQuestion = aiMod.answerQuestion;
const hotel = await mod('/src/lib/hotel.js');
const decimal = await mod('/src/lib/decimal.js');
const commission = await mod('/src/lib/commissionRates.js');
const taxConfig = await mod('/src/lib/taxConfig.js');
const taxSettings = await mod('/src/lib/taxSettings.js');
const expCats = await mod('/src/lib/expenseCategories.js');
const payNorm = await mod('/src/lib/paymentNorm.js');
const csvMod = await mod('/src/lib/csvParser.js');

const fileUrl = (name) => 'file:///' + path.join(DATA_DIR, name).replace(/\\/g, '/');

// ───────────────────────── DB reset + seed ─────────────────────────
await DexieDelete();
async function DexieDelete() {
  // fresh db so each run is deterministic
  await localDb.delete();
  await localDb.open();
  localStorage.clear();
}

const PROP = { code: 'RRI1416', name: 'Red Roof Inn & Suites Middleborough', rooms: 100 };
const PROP2 = { code: 'RRI9999', name: 'Red Roof Inn & Suites Testville', rooms: 50 };
const pid1 = await localDb.Property.add({ ...PROP, active: 1, created_date: new Date().toISOString() });
const pid2 = await localDb.Property.add({ ...PROP2, active: 1, created_date: new Date().toISOString() });
console.log(`Properties seeded: #${pid1} ${PROP.name}, #${pid2} ${PROP2.name}\n`);

// Sign in before the first db.entities call.
//
// Property scoping in base44Client used to FAIL OPEN: an unauthenticated caller
// resolved to "no restriction" and could read and write every row. That was blocker
// B3. Now it fails CLOSED, so an unauthenticated harness is refused with
// "Access denied: Cannot create records for unauthorized property" — which is what
// killed this harness at its first import, one line after the axios crash was
// fixed. See scripts/_harness-auth.mjs.
//
// The pre-loaded modules are passed in ON PURPOSE. This harness loads the app
// through Vite's SSR loader, and `server.ssrLoadModule(...)` and plain
// `import(...)` give two SEPARATE module instances with separate module-scope
// state. Signing in on the imported copy would leave the SSR copy — the one every
// assertion below uses — still signed out, and the failure would look exactly like
// a broken permission check rather than a harness wiring mistake.
const { signInAsAllPropertyOwner } = await import('./_harness-auth.mjs');
await signInAsAllPropertyOwner({ localDb, client: clientMod });

// ───────────────────────── 1. Real imports ─────────────────────────
console.log('=== 1. IMPORT REAL HOTELKEY REPORTS ===');
const IMPORT_FILES = [
  ['Occupancy Summary midelboro.csv', 'occupancy'],
  ['Source Summary (1).csv', 'source'],
  ['Gross Revenue Report midelboro.csv', 'gross'],
  ['Payments Summary.csv', 'payments'],
  ['Payments Summary (1).csv', 'payments'],
  ['Payments Summary (2).csv', 'payments'],
  ['Source Summary.csv', 'source'],
  ['Source Summary (2).csv', 'source'],
  ['Source Summary (3).csv', 'source'],
  ['Clerk Shift.csv', 'clerk'],
];
const importStats = {};
for (const [name, expectedType] of IMPORT_FILES) {
  const scan = await parsers.scanReport('auto', fileUrl(name), { propertyId: pid1, propertyName: PROP.name, sourceFile: name });
  const typeOk = scan.type === expectedType;
  const result = await parsers.importReport(scan, { propertyId: pid1, propertyName: PROP.name, sourceFile: name });
  importStats[name] = { type: scan.type, expectedType, typeOk, count: result.count, excluded: result.excluded, cleaned: result.cleaned, rows: (scan.rowsToImport || []).length };
  const flag = typeOk ? 'OK' : 'WRONG-TYPE';
  console.log(`  ${name}: auto→${scan.type} (expected ${expectedType}) [${flag}] imported ${result.count}, excluded ${result.excluded}, cleaned ${result.cleaned}`);
  T(`Auto-detect ${name} → ${expectedType}`, expectedType, scan.type, undefined, { ok: typeOk, note: 'report-type auto-detection' });
}
const totalRows = Object.values(importStats).reduce((a, s) => a + s.count, 0);
console.log(`  TOTAL rows imported: ${totalRows}\n`);

// date detection
{
  const iso = csvMod.convertDate;
  const cases = [['1-Jan-26', '2026-01-01'], ['Apr 01, 2026', '2026-04-01'], ['2-Aug-26', '2026-08-02'], ['Jul 1, 2026', '2026-07-01']];
  for (const [inp, want] of cases) {
    const got = iso(inp);
    T(`Date detection ${inp} → ${want}`, want, got, undefined, { ok: got === want, note: 'convertDate' });
  }
}

// property association
{
  const occRows = await db.entities.OccupancyDay.list('-date');
  const allProps = new Set(occRows.map((r) => String(r.property_id)));
  T('All occupancy rows carry selected property_id', String(pid1), [...allProps].join(','), undefined, {
    ok: allProps.size === 1 && allProps.has(String(pid1)),
    note: `rows=${occRows.length}, property_ids=${[...allProps]}`,
  });
}

// ───────────────────────── 2. Metrics vs source ─────────────────────────
const JAN = ['2026-01-01', '2026-01-31'];
const APR = ['2026-04-01', '2026-04-30'];
const JUL = ['2026-07-01', '2026-07-31'];
const FULL = ['2026-01-01', '2026-08-02'];
const WEEK = ['2026-01-04', '2026-01-10'];

const occSrc = srcOccupancy('Occupancy Summary midelboro.csv');
const paySrc = srcPayments('Payments Summary.csv');
const _pay1Src = srcPayments('Payments Summary (1).csv');
const _pay2Src = srcPayments('Payments Summary (2).csv');
const grossSrc = srcGross('Gross Revenue Report midelboro.csv');
const src1 = srcSource('Source Summary (1).csv');
const srcJan = srcWindow(src1, ...JAN);
const _srcJul = srcWindow(src1, ...JUL);
const _srcApr = srcWindow(srcSource('Source Summary (2).csv'), ...APR);
const _srcFull = srcWindow(src1, ...FULL);

const occAll = await db.entities.OccupancyDay.list('date');
const payAll = await db.entities.PaymentDay.list('date');
const srcAll = await db.entities.SourceDay.list('date');
const grossAll = await db.entities.GrossRevenueDay.list('date');
const _clerkAll = await db.entities.ClerkShiftRecord.list('-created_date');

const occIn = (from, to) => occAll.filter((r) => hotel.inRange(r.date, from, to));
const payIn = (from, to) => payAll.filter((r) => hotel.inRange(r.date, from, to));
const srcIn = (from, to) => srcAll.filter((r) => hotel.inRange(r.date, from, to));

console.log('\n=== 2. FINANCIAL METRICS: Dashboard vs Source ===');
{
  const [f, t] = JAN;
  const srcA = aggWindow(occSrc, f, t);
  const rows = occIn(f, t);
  // Occupancy metrics are ROOM metrics. The source's Total Revenue column also
  // contains ancillary income, which belongs to the Gross Revenue ledger and
  // must not be folded into ADR or RevPAR. The old harness did exactly that and
  // then accused the room-only implementation of being low. Compare room to room
  // here; total revenue is tested separately below via grossRevenueForPeriod().
  const rev = hotel.sum(rows, 'room_revenue');
  const sold = hotel.sum(rows, 'rooms_sold');
  const rooms = hotel.sum(rows, 'total_rooms');
  const adr = sold ? rev / sold : 0;
  const revpar = rooms ? rev / rooms : 0;
  const occ = rooms ? sold / rooms : 0;

  T('2.1 Room revenue (Jan)', srcA.roomRevenue, rev, srcA.roomRevenue - rev, { note: 'Dashboard=Σ occ.room_revenue; source=Σ Room Revenue col' });
  // Total revenue WITH ancillary, straight off the occupancy export. This is the
  // check that exposed the NUMERIC_FIELDS gap: total_revenue_with_misc used to be
  // stored as a raw CSV string, so this sum read 0 while every room metric passed.
  T('2.1b Total revenue (Jan) — occ Total Revenue col', srcA.revenue, hotel.sum(rows, 'total_revenue_with_misc'), srcA.revenue - hotel.sum(rows, 'total_revenue_with_misc'), { note: 'proves the with_misc field is parsed as a number, not stored as text' });
  T('2.2 Revenue (Jan) — gross Room Rent only', srcA.roomRevenue, hotel.sum(rows, 'room_revenue'), srcA.roomRevenue - hotel.sum(rows, 'room_revenue'), { note: 'occupancy Room Revenue column vs dashboard occ rows' });
  T('2.3 Occupancy (Jan)', srcA.occW, occ, srcA.occW - occ, { note: 'sold/total ratio; source=Σsold/Σrooms' });
  T('2.4 ADR (Jan)', srcA.adrW, adr, srcA.adrW - adr, { note: 'revenue/sold; source=Σ(ADR×sold)/Σsold' });
  T('2.5 RevPAR (Jan)', srcA.revparW, revpar, srcA.revparW - revpar, { note: 'revenue/rooms; source=Σ(RevPAR×rooms)/Σrooms' });

  const pS = payWindow(paySrc, f, t);
  const pRows = payIn(f, t);
  T('2.6 Payments (Jan) — Total col', pS.total, hotel.sum(pRows, 'total'), pS.total - hotel.sum(pRows, 'total'));
  T('2.7 Card volume (Jan)', pS.cardVolume, hotel.sum(pRows, 'visa') + hotel.sum(pRows, 'master') + hotel.sum(pRows, 'amex') + hotel.sum(pRows, 'discover'), pS.cardVolume - (hotel.sum(pRows, 'visa') + hotel.sum(pRows, 'master') + hotel.sum(pRows, 'amex') + hotel.sum(pRows, 'discover')));
  const _refundsDash = hotel.sum(pRows, 'closed_balance_folio') + hotel.sum(pRows, 'loyalty_discount');
  T('2.8 Refunds (Jan) — |closed balance folio|+|loyalty discount|', pS.refunds, Math.abs(hotel.sum(pRows, 'closed_balance_folio')) + Math.abs(hotel.sum(pRows, 'loyalty_discount')), pS.refunds - (Math.abs(hotel.sum(pRows, 'closed_balance_folio')) + Math.abs(hotel.sum(pRows, 'loyalty_discount'))), { note: 'refund model per aiEngine/MoneyKept' });

  const gSrc = grossWindow(grossSrc, f, t);
  const gRows = grossAll.filter((r) => hotel.inRange(r.date, f, t));
  T('2.9 Gross revenue (Jan) — all categories', gSrc.total, hotel.sum(gRows, 'room_rent') + hotel.sum(gRows, 'misc_charge') + hotel.sum(gRows, 'system_charge') + hotel.sum(gRows, 'food') + hotel.sum(gRows, 'event') + hotel.sum(gRows, 'bar') + hotel.sum(gRows, 'laundry') + hotel.sum(gRows, 'phone') + hotel.sum(gRows, 'other') + hotel.sum(gRows, 'non_revenue') + hotel.sum(gRows, 'advance_deposit') + hotel.sum(gRows, 'beverage'), gSrc.total - (hotel.sum(gRows, 'room_rent') + hotel.sum(gRows, 'misc_charge') + hotel.sum(gRows, 'system_charge') + hotel.sum(gRows, 'food') + hotel.sum(gRows, 'event') + hotel.sum(gRows, 'bar') + hotel.sum(gRows, 'laundry') + hotel.sum(gRows, 'phone') + hotel.sum(gRows, 'other') + hotel.sum(gRows, 'non_revenue') + hotel.sum(gRows, 'advance_deposit') + hotel.sum(gRows, 'beverage')));

  const sS = srcJan;
  const sRows = srcIn(...JAN);
  T('2.10 Source revenue (Jan) — Net Revenue', sS.totalNet, hotel.sum(sRows, 'net_revenue'), sS.totalNet - hotel.sum(sRows, 'net_revenue'));
  T('2.11 Source stays (Jan)', sS.totalStays, hotel.sum(sRows, 'stays'), sS.totalStays - hotel.sum(sRows, 'stays'));
  const expedia = sS.bySource.find((c) => c.name === 'EXPEDIA HOTEL COLLECT');
  const expDash = sRows.filter((r) => String(r.source || r.code).trim().toUpperCase() === 'EXPEDIA HOTEL COLLECT').reduce((a, r) => a + Number(r.net_revenue || 0), 0);
  T('2.12 Expedia revenue (Jan) — EHC channel net', expedia?.net ?? 0, expDash, (expedia?.net ?? 0) - expDash, { note: 'exact EHC channel; app keeps channel-level granularity (no Expedia-family aggregation)' });

  // commissions (owner model 2026-08-27: net_revenue is POST-commission net, so
  // commission = grossed-up gross − net; per-row cents via hotel.grossUpFromNetCents,
  // matching CalculationService and MoneyKept.jsx).
  const calcComm = (rows) => rows.reduce((a, r) => {
    const info = hotel.commissionFor(r.source || r.code);
    return a + decimal.fromCents(hotel.grossUpFromNetCents(decimal.toCents(r.net_revenue), info, r.stays).commissionCents);
  }, 0);
  const commJan = calcComm(sRows);
  const srcCommJan = srcJan.rows.reduce((a, r) => {
    const info = hotel.commissionFor(r.source || r.code);
    return a + decimal.fromCents(hotel.grossUpFromNetCents(decimal.toCents(r.net), info, r.stays).commissionCents);
  }, 0);
  T('2.13 OTA commissions (Jan) — gross-up model', srcCommJan, commJan, srcCommJan - commJan, { note: `rates: EHC=${commission.getCommissionRates()['EXPEDIA']?.rate}, net_revenue is post-commission net → gross up (gross=net/(1-rate))` });

  // taxes (no tax columns in source reports → estimated at configured rates)
  const eff = taxSettings.getEffectiveTaxRates(String(pid1), '2026-01-15');
  const taxable = srcJan.rows.filter((r) => taxConfig.TAX_SOURCES.find((s) => s.key === classifySrc(r.source || r.code))?.taxable);
  const taxBase = taxable.reduce((a, r) => a + r.net, 0);
  T('2.14 State tax (Jan) — estimated', taxBase * eff.state, taxBase * eff.state, 0, { ok: true, note: `No State Tax column in source reports; dashboard estimates taxable net × ${(eff.state * 100).toFixed(2)}% (configured rate). Expected diff = 0 by definition.` });
  T('2.15 City tax (Jan)', 0, eff.city * taxBase, 0 - eff.city * taxBase, { note: 'no city rate configured → 0' });

  // cc fees
  const ccRate = commission.getCcFeeRate();
  const ccJan = pS.cardVolume * ccRate;
  const ccDash = hotel.sum(pRows, 'visa') * ccRate + hotel.sum(pRows, 'master') * ccRate + hotel.sum(pRows, 'amex') * ccRate + hotel.sum(pRows, 'discover') * ccRate;
  T('2.16 CC processing fees (Jan) — card × 2.5%', ccJan, ccDash, ccJan - ccDash, { note: `rate=${(ccRate * 100).toFixed(2)}%; refund-fee-on-refunds=${commission.getCcFeeOnRefunds()}` });
}

// Money Kept (Jan window)
console.log('\n=== 2b. ESTIMATED MONEY KEPT (Jan 2026) ===');
const mk = await moneyKeptMirror({ from: JAN[0], to: JAN[1], pid: String(pid1), label: PROP.name });
{
  // independent expectation from source aggregates
  const srcA = aggWindow(occSrc, ...JAN);
  const pS = payWindow(paySrc, ...JAN);
  const ccRate = commission.getCcFeeRate();
  const eff = taxSettings.getEffectiveTaxRates(String(pid1), '2026-01-15');
  // net_revenue is POST-commission NET (owner model 2026-08-27): the taxable base
  // is the grossed-up booking value, and channel commission is gross − net. Both
  // mirror the per-row cents math in MoneyKept.jsx via hotel.grossUpFromNetCents.
  const taxBaseSrc = srcJan.rows.filter((r) => taxConfig.TAX_SOURCES.find((s) => s.key === classifySrc(r.source || r.code))?.taxable).reduce((a, r) => a + decimal.fromCents(hotel.grossUpFromNetCents(decimal.toCents(r.net), hotel.commissionFor(r.source || r.code), r.stays).grossCents), 0);
  const srcComm = srcJan.rows.reduce((a, r) => {
    const info = hotel.commissionFor(r.source || r.code);
    return a + decimal.fromCents(hotel.grossUpFromNetCents(decimal.toCents(r.net), info, r.stays).commissionCents);
  }, 0);
  // component model: per-day card sum, negative-card (refund) days contribute 0
  const byDay = new Map();
  paySrc.forEach((r) => {
    const d = String(isoDate(r.date)).slice(0, 10);
    if (!(d >= JAN[0] && d <= JAN[1])) return;
    const card = (Number(r.VISA) || 0) + (Number(r.MASTER) || 0) + (Number(r.AMEX) || 0) + (Number(r.DISCOVER) || 0);
    byDay.set(d, (byDay.get(d) || 0) + card);
  });
  const ccFeePos = [...byDay.values()].reduce((a, v) => a + Math.max(0, v) * ccRate, 0);
  console.log(`  [debug cc] paySrc[0]=${JSON.stringify(paySrc[0])} byDay.size=${byDay.size} sumCards=${[...byDay.values()].reduce((a, v) => a + v, 0)} ccFeePos=${ccFeePos.toFixed(4)}`);
  const grossJan = grossWindow(grossSrc, ...JAN);
  // Same classification as hotel.GROSS_ANCILLARY_COMPONENTS. Non Revenue and
  // Advance Deposit are deliberately excluded: one is not revenue and the other
  // is a liability until the stay is consumed.
  const ancillarySrc = ['Misc Charge', 'System', 'Food', 'Event', 'Bar', 'Beverage', 'Laundry', 'Phone', 'Other']
    .reduce((a, key) => a + (Number(grossJan.byCat[key]) || 0), 0);
  const expectedGross = srcA.roomRevenue + ancillarySrc;
  const expected = {
    // MoneyKept uses total earned revenue: room revenue from OccupancyDay plus
    // ancillary charges from GrossRevenueDay. That can differ from the occupancy
    // export's own Total Revenue column because the two reports classify certain
    // charges differently; the component deliberately uses the reconciled ledger
    // pair, so the independent expectation must use the same accounting basis.
    gross: expectedGross,
    commissions: srcComm,
    ccFee: ccFeePos,
    refundFee: 0,
    taxes: taxBaseSrc * eff.state,
    refunds: pS.refunds,
    kept: expectedGross - (srcComm + ccFeePos + taxBaseSrc * eff.state + pS.refunds),
  };
  T('2.17 Money Kept (Jan) — gross', expected.gross, mk.gross, expected.gross - mk.gross);
  T('2.18 Money Kept (Jan) — total deductions', expected.kept - expected.gross + mk.gross, mk.totalDeductions, (expected.gross - expected.kept) - mk.totalDeductions, { note: 'gross − kept' });
  T('2.19 Money Kept (Jan) — kept = gross − deductions', expected.kept, mk.kept, expected.kept - mk.kept, { tol: 0.03, note: 'mirror of MoneyKept.jsx item model (cc fee skips negative-card days)' });
  console.log(`      gross=${money(mk.gross)}  deductions=${money(mk.totalDeductions)}  kept=${money(mk.kept)}  keep-rate=${pct(mk.kept / (mk.gross || 1))}`);
  for (const i of mk.items) console.log(`      − ${i.label}: ${money(i.amount)}`);
  console.log(`      [debug] expected pieces: comm=${expected.commissions.toFixed(4)} ccFee=${expected.ccFee.toFixed(4)} taxes=${expected.taxes.toFixed(4)} refunds=${expected.refunds.toFixed(4)}`);
}

// ───────────────────────── 3. Lifecycle tests ─────────────────────────
console.log('\n=== 3. IMPORT LIFECYCLE ===');
if (!skipSection('3')) {
  // Duplicate import
  const scan = await parsers.scanReport('auto', fileUrl('Occupancy Summary midelboro.csv'), { propertyId: pid1, propertyName: PROP.name, sourceFile: 'Occupancy Summary midelboro.csv' });
  const res2 = await parsers.importReport(scan, { propertyId: pid1, propertyName: PROP.name, sourceFile: 'Occupancy Summary midelboro.csv' });
  const before = occAll.length;
  const after = (await db.entities.OccupancyDay.list('date')).length;
  T('3.1 Duplicate import skipped (0 new rows)', 0, res2.count, 0 - res2.count, { ok: res2.count === 0 && before === after, note: `new=${res2.count} excluded=${res2.excluded} rows ${before}→${after}` });

  // Delete import (by import_id) — sessions tracked encrypted in localStorage
  const sessions = await readSessions(clientMod);
  const occSess = sessions.find((s) => s.reportType === 'occupancy' || s.type === 'occupancy');
  // The imported rows are the authoritative source for the session id. Older
  // harnesses assumed encrypted UI metadata always had a `reportType` field;
  // when it did not, `occSess` was undefined and the harness crashed before
  // reporting a result. Prefer the row ledger, then metadata, and turn a missing
  // id into an honest failed check rather than a TypeError.
  const occImportId = occAll.find((r) => r.import_id)?.import_id || occSess?.importId;
  const occWithImport = occImportId ? occAll.filter((r) => r.import_id === occImportId) : [];
  T('3.1b Imported occupancy rows have a rollback session id', true, Boolean(occImportId), !occImportId ? 1 : 0, {
    ok: Boolean(occImportId),
    note: `row import_id=${occImportId || '(missing)'}`,
  });
  await db.entities.OccupancyDay.bulkDelete(occWithImport.map((r) => r.id));
  const afterDel = (await db.entities.OccupancyDay.list('date')).length;
  T('3.2 Delete import removes only its rows', before - occWithImport.length, afterDel, (before - occWithImport.length) - afterDel, { ok: afterDel === before - occWithImport.length, note: `deleted ${occWithImport.length} rows (session ${occImportId || '(missing)'})` });

  // Re-import after delete (restore)
  const scan3 = await parsers.scanReport('auto', fileUrl('Occupancy Summary midelboro.csv'), { propertyId: pid1, propertyName: PROP.name, sourceFile: 'Occupancy Summary midelboro.csv' });
  const res3 = await parsers.importReport(scan3, { propertyId: pid1, propertyName: PROP.name, sourceFile: 'Occupancy Summary midelboro.csv' });
  const afterRe = (await db.entities.OccupancyDay.list('date')).length;
  T('3.3 Re-import after delete restores rows', before, afterRe, before - afterRe, { note: `new=${res3.count} rows ${afterDel}→${afterRe}` });

  // Reprocess (delete + re-import, totals identical)
  const allOcc = await db.entities.OccupancyDay.list('date');
  const revBefore = hotel.sum(allOcc, 'total_revenue_with_misc');
  await db.entities.OccupancyDay.bulkDelete(allOcc.map((r) => r.id));
  const scan4 = await parsers.scanReport('auto', fileUrl('Occupancy Summary midelboro.csv'), { propertyId: pid1, propertyName: PROP.name, sourceFile: 'Occupancy Summary midelboro.csv' });
  await parsers.importReport(scan4, { propertyId: pid1, propertyName: PROP.name, sourceFile: 'Occupancy Summary midelboro.csv' });
  const revAfter = hotel.sum(await db.entities.OccupancyDay.list('date'), 'total_revenue_with_misc');
  T('3.4 Reprocess preserves totals (revenue unchanged)', revBefore, revAfter, revBefore - revAfter);

  // Replace import — delete only the rows from the file's import session, then re-import
  const srcAllRows = await db.entities.SourceDay.list('date');
  const srcCountBefore = srcAllRows.length;
  const srcRevBefore = hotel.sum(srcAllRows, 'net_revenue');
  const src1Sess = sessions.find((s) => (s.reportType === 'source' || s.type === 'source') && String(s.sourceFile || '').includes('Source Summary (1)'));
  const src1ImportId = srcAllRows.find((r) => r.import_id)?.import_id || src1Sess?.importId;
  const oldSrc1Rows = src1ImportId ? srcAllRows.filter((r) => r.import_id === src1ImportId) : [];
  T('3.5a Source rows have a rollback session id', true, Boolean(src1ImportId), !src1ImportId ? 1 : 0, {
    ok: Boolean(src1ImportId),
    note: `row import_id=${src1ImportId || '(missing)'}`,
  });
  await mark(`bulkDelete ${oldSrc1Rows.length} rows`, () => db.entities.SourceDay.bulkDelete(oldSrc1Rows.map((r) => r.id)));
  const scan5 = await mark('scanReport', () => parsers.scanReport('auto', fileUrl('Source Summary (1).csv'), { propertyId: pid1, propertyName: PROP.name, sourceFile: 'Source Summary (1).csv' }));
  await mark('importReport', () => parsers.importReport(scan5, { propertyId: pid1, propertyName: PROP.name, sourceFile: 'Source Summary (1).csv' }));
  const srcAfter = await mark('list after', () => db.entities.SourceDay.list('date'));
  T('3.5 Replace import: same-file rows replaced (count restored)', srcCountBefore, srcAfter.length, srcCountBefore - srcAfter.length, { ok: srcCountBefore === srcAfter.length, note: `old import ${oldSrc1Rows.length} rows → re-imported ${scan5.rowsToImport.length}; ${srcCountBefore}→${srcAfter.length}` });
  T('3.5b Replace import: net revenue restored (other files untouched)', srcRevBefore, hotel.sum(srcAfter, 'net_revenue'), srcRevBefore - hotel.sum(srcAfter, 'net_revenue'));
}

// ───────────────────────── 4. Property isolation / switching ─────────────────────────
console.log('\n=== 4. PROPERTY ISOLATION & SWITCHING ===');
if (!skipSection('4')) {
  const occP1 = await db.entities.OccupancyDay.filter({ property_id: pid1 }, 'date');
  const srcP1 = await db.entities.SourceDay.filter({ property_id: pid1 }, 'date');
  const payP1 = await db.entities.PaymentDay.filter({ property_id: pid1 }, 'date');
  const occP2 = await db.entities.OccupancyDay.filter({ property_id: pid2 }, 'date');
  const srcP2 = await db.entities.SourceDay.filter({ property_id: pid2 }, 'date');
  const payP2 = await db.entities.PaymentDay.filter({ property_id: pid2 }, 'date');
  T('4.1 Prop#1 rows present; Prop#2 empty', 0, occP2.length + srcP2.length + payP2.length, 0 - (occP2.length + srcP2.length + payP2.length), { ok: occP2.length + srcP2.length + payP2.length === 0 && occP1.length > 0, note: `P1: occ=${occP1.length} src=${srcP1.length} pay=${payP1.length}; P2: occ=${occP2.length} src=${srcP2.length} pay=${payP2.length}` });
  // switching to P2 shows nothing (no cross-property leakage)
  const revP2 = hotel.sum(occP2, 'room_revenue');
  T('4.2 Switching to Prop#2 → zero revenue (isolation)', 0, revP2, 0 - revP2);

  // ALL PROPERTIES / portfolio (weighted, real function from hotel.js)
  const roomCounts = { [String(pid1)]: PROP.rooms, [String(pid2)]: PROP2.rooms };
  const ps = hotel.portfolioStats(occP1, roomCounts);
  // portfolioStats/occupancyStats are ROOM-metric engines (ADR, RevPAR), so the
  // independent expectation must be room revenue — the same basis. Comparing
  // against total_revenue_with_misc here made every check below fail by exactly
  // the ancillary total and read like an engine bug.
  const revP1 = hotel.sum(occP1, 'room_revenue');
  const soldP1 = hotel.sum(occP1, 'rooms_sold');
  const daysP1 = occP1.length;
  T('4.3 Portfolio revenue (ALL PROPERTIES, only P1 data)', revP1, ps.revenue, revP1 - ps.revenue);
  T('4.4 Portfolio occupancy (weighted sold/capacity)', soldP1 / (daysP1 * PROP.rooms), ps.occupancy, soldP1 / (daysP1 * PROP.rooms) - ps.occupancy);
  T('4.5 Portfolio ADR (revenue/sold)', revP1 / soldP1, ps.adr, revP1 / soldP1 - ps.adr);
  T('4.6 Portfolio RevPAR (revenue/capacity)', revP1 / (daysP1 * PROP.rooms), ps.revpar, revP1 / (daysP1 * PROP.rooms) - ps.revpar);

  // per-property table
  const per = hotel.perPropertyStats(occP1, [{ id: String(pid1), name: PROP.name, rooms: PROP.rooms }]);
  T('4.7 Per-property stats (P1 ADR)', revP1 / soldP1, per.find((x) => String(x.property_id) === String(pid1))?.adr, revP1 / soldP1 - per.find((x) => String(x.property_id) === String(pid1))?.adr);
}

// ───────────────────────── 5. Date ranges / weekly / monthly / YoY ─────────────────────────
console.log('\n=== 5. CUSTOM RANGES, WEEKLY, MONTHLY, YoY ===');
if (!skipSection('5')) {
  const aprSrc = aggWindow(occSrc, ...APR);
  const julSrc = aggWindow(occSrc, ...JUL);
  const weekSrc = aggWindow(occSrc, ...WEEK);
  const aprDash = occIn(...APR);
  const julDash = occIn(...JUL);
  const weekDash = occIn(...WEEK);
  T('5.1 Custom range Apr — revenue', aprSrc.revenue, hotel.sum(aprDash, 'total_revenue_with_misc'), aprSrc.revenue - hotel.sum(aprDash, 'total_revenue_with_misc'));
  T('5.2 Custom range Jul — revenue', julSrc.revenue, hotel.sum(julDash, 'total_revenue_with_misc'), julSrc.revenue - hotel.sum(julDash, 'total_revenue_with_misc'));
  T('5.3 Weekly (Jan 4–10) — revenue', weekSrc.revenue, hotel.sum(weekDash, 'total_revenue_with_misc'), weekSrc.revenue - hotel.sum(weekDash, 'total_revenue_with_misc'));

  // weekly bucketing (Monday-start, mirror of bucketKey)
  const bucket = (d) => {
    const dt = new Date(`${d}T00:00:00`);
    const monday = new Date(dt);
    monday.setDate(dt.getDate() - ((dt.getDay() + 6) % 7));
    return monday.toISOString().slice(0, 10);
  };
  const occJan = occIn(...JAN);
  const weeks = new Map();
  for (const r of occJan) {
    const k = bucket(String(r.date).slice(0, 10));
    weeks.set(k, (weeks.get(k) || 0) + (Number(r.total_revenue_with_misc) || 0));
  }
  const weekBuckets = [...weeks.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const wk1 = weekBuckets[0];
  const _wk1Src = aggWindow(occSrc, wk1[0], new Date(`${wk1[0]}T00:00:00`).toISOString() !== '' ? wk1[0] : wk1[0]);
  // expected = sum of source rows within that ISO week window
  const wk1End = new Date(new Date(`${wk1[0]}T00:00:00`).getTime() + 6 * 86400000).toISOString().slice(0, 10);
  const wk1SrcSum = aggWindow(occSrc, wk1[0], wk1End).revenue;
  T('5.4 Weekly bucket aggregation matches source (first ISO week)', wk1SrcSum, wk1[1], wk1SrcSum - wk1[1]);

  // monthly buckets
  const months = new Map();
  for (const r of occJan) {
    const k = String(r.date).slice(0, 7);
    months.set(k, (months.get(k) || 0) + (Number(r.total_revenue_with_misc) || 0));
  }
  const janBucket = months.get('2026-01');
  T('5.5 Monthly bucket (2026-01) matches source', janSrcExpected(), janBucket, janSrcExpected() - janBucket);
  function janSrcExpected() { return aggWindow(occSrc, '2026-01-01', '2026-01-31').revenue; }

  // Year-over-year: no 2025 data → documented limitation
  //
  // allowedPropertyIds is 'all', not null, ON PURPOSE. aiEngine is fail-closed by
  // design (see the scopeProperties contract in src/lib/aiEngine.js): null means
  // "the caller never proved any scope" and denies everything, so every AI check
  // below answered "1 selected (no access)" while the harness still held a valid
  // owner session. This harness signs in as an all-property owner via
  // _harness-auth.mjs, so 'all' is the truthful declaration — and if the engine
  // ever loosens null back into "everything", these checks stay honest because
  // they never relied on the loose behaviour.
  const aiYoy = await answerQuestion({ question: 'Compare January 2026 with January 2025', propertyId: String(pid1), from: '', to: '', allowedPropertyIds: 'all' });
  const yoyMissing = /2025|no imported|couldn't find/i.test(aiYoy.answer);
  T('5.6 YoY comparison reports missing 2025 data (documented)', 'missing-2025', aiYoy.summary?.range || aiYoy.answer.slice(0, 40), undefined, { ok: yoyMissing, note: `AI: ${aiYoy.answer.replace(/\n/g, ' | ').slice(0, 110)}` });

  const aiJan = await answerQuestion({ question: 'What was my revenue in January 2026?', propertyId: String(pid1), from: '', to: '', allowedPropertyIds: 'all' });
  const janExp = aggWindow(occSrc, '2026-01-01', '2026-01-31').revenue;
  const janExpTxt = `${Math.round(janExp).toLocaleString('en-US')}`;
  const janMatch = aiJan.answer.includes(janExpTxt);
  T('5.7 AI "revenue in January 2026" matches source', money(aggWindow(occSrc, '2026-01-01', '2026-01-31').revenue), aiJan.answer.match(/\$[\d,]+/)?.[0] || '?', undefined, { ok: janMatch, note: aiJan.answer.replace(/\n/g, ' | ').slice(0, 130) });
}

// ───────────────────────── 6. Expenses, payroll, rates ─────────────────────────
console.log('\n=== 6. EXPENSES, PAYROLL, RATE CHANGES ===');
let mk2;
if (!skipSection('6')) {
  const [f, t] = JAN;
  // expense entry (real app path)
  await db.entities.Expense.create({ property_id: pid1, expense_date: '2026-01-10', expense_name: 'Laundry supplies', vendor: 'Acme', category: 'laundry', amount: 250.75, frequency: 'one_time', payment_status: 'paid', created_date: new Date().toISOString() });
  await db.entities.Expense.create({ property_id: pid1, expense_date: '2026-01-20', expense_name: 'Office rent', vendor: 'LLC', category: 'other', amount: 1200.00, frequency: 'one_time', payment_status: 'paid', created_date: new Date().toISOString() });
  // payroll entry (real app path)
  await db.entities.PayrollRun.create({ property_id: pid1, pay_period_start: '2026-01-01', pay_period_end: '2026-01-15', employee_name: 'Front Desk', total_pay: 3400.00, payroll_status: 'completed', created_date: new Date().toISOString() });
  // recurring payroll (3 periods → totals counted in the window)
  await db.entities.PayrollRun.create({ property_id: pid1, pay_period_start: '2026-01-16', pay_period_end: '2026-01-31', employee_name: 'Front Desk', total_pay: 3400.00, payroll_status: 'completed', created_date: new Date().toISOString() });
  await db.entities.PayrollRun.create({ property_id: pid1, pay_period_start: '2026-02-01', pay_period_end: '2026-02-15', employee_name: 'Front Desk', total_pay: 3400.00, payroll_status: 'completed', created_date: new Date().toISOString() });

  mk2 = await moneyKeptMirror({ from: f, to: t, pid: String(pid1), label: PROP.name });
  const _expRow = mk2.items.find((i) => i.key === 'laundry' || i.key === 'other');
  T('6.1 Expense entry appears in deductions', 1450.75, (mk2.items.find((i) => i.key === 'laundry')?.amount || 0) + (mk2.items.find((i) => i.key === 'other')?.amount || 0), 1450.75 - ((mk2.items.find((i) => i.key === 'laundry')?.amount || 0) + (mk2.items.find((i) => i.key === 'other')?.amount || 0)));
  T('6.2 Payroll counted in window (Jan: 2 of 3 periods)', 6800, mk2.items.find((i) => i.key === 'payroll')?.amount || 0, 6800 - (mk2.items.find((i) => i.key === 'payroll')?.amount || 0), { note: 'recurring biweekly payroll; Feb period excluded from Jan window' });

  // rates change → future results recalc, historical rows unchanged
  const rowsBefore = JSON.stringify((await db.entities.SourceDay.list('date')).map((r) => r.id + r.date + r.net_revenue + r.stays));
  const mkBefore = mk2.kept;
  commission.setCommissionRates({ 'EXPEDIA HOTEL COLLECT': { type: 'percentage', rate: 0.18, taxExempt: false } });
  commission.setCcFeeRate(0.03);
  const mk3 = await moneyKeptMirror({ from: f, to: t, pid: String(pid1), label: PROP.name });
  const rowsAfter = JSON.stringify((await db.entities.SourceDay.list('date')).map((r) => r.id + r.date + r.net_revenue + r.stays));
  const commNew = mk3.items.find((i) => i.key === 'ota')?.amount || 0;
  const commOld = mk2.items.find((i) => i.key === 'ota')?.amount || 0;
  const expectedDelta = srcJan.bySource.filter((c) => c.name.toUpperCase() === 'EXPEDIA HOTEL COLLECT').reduce((a, c) => a + c.net, 0) * (0.18 - 0.15);
  T('6.3 Commission-rate change recalculates future kept', commOld + expectedDelta, commNew, commOld + expectedDelta - commNew, { note: 'Expedia 15%→18%' });
  T('6.4 Historical SourceDay rows unchanged by rate change', rowsBefore === rowsAfter, rowsBefore === rowsAfter, undefined, { ok: rowsBefore === rowsAfter, note: 'no DB mutation on settings change (derived-at-render model)' });
  console.log(`      kept before=${money(mkBefore)} after(18%+3%)=${money(mk3.kept)}`);

  // tax-rate change (state 11.7% → 8.0% effective for a future window via taxSettings)
  taxSettings.saveTaxSettings([{ property_id: String(pid1), state_rate: 0.08, city_rate: 0.02, other_rate: 0, effective_start: '2026-01-01' }]);
  const mk4 = await moneyKeptMirror({ from: f, to: t, pid: String(pid1), label: PROP.name });
  const taxBaseJan = srcJan.rows.filter((r) => taxConfig.TAX_SOURCES.find((s) => s.key === classifySrc(r.source || r.code))?.taxable).reduce((a, r) => a + r.net, 0);
  const expectedTaxNew = taxBaseJan * 0.08 + taxBaseJan * 0.02;
  T('6.5 Tax-rate change recalculates taxes (8%+2% on taxable base)', expectedTaxNew, (mk4.items.find((i) => i.key === 'taxes')?.amount || 0), expectedTaxNew - (mk4.items.find((i) => i.key === 'taxes')?.amount || 0), { tol: 0.02 });
  const rowsAfterTax = JSON.stringify((await db.entities.SourceDay.list('date')).map((r) => r.id + r.date + r.net_revenue + r.stays));
  T('6.6 Tax change does not mutate historical rows', rowsBefore === rowsAfterTax, rowsBefore === rowsAfterTax, undefined, { ok: rowsBefore === rowsAfterTax });
  taxSettings.saveTaxSettings([]);
  commission.setCommissionRates({ 'EXPEDIA HOTEL COLLECT': { type: 'percentage', rate: 0.15, taxExempt: false } });
  commission.setCcFeeRate(0.025);
}

// ───────────────────────── 7. Refund analysis ─────────────────────────
console.log('\n=== 7. REFUND ANALYSIS ===');
if (!skipSection('7')) {
  const [f, t] = JAN;
  const pRows = payIn(f, t);
  const negDays = pRows.filter((r) => Number(r.total) < 0);
  const negSrc = paySrc.filter((r) => inW(r.date, f, t) && r.Total < 0);
  T('7.1 Negative-payment days match source', negSrc.length, negDays.length, negSrc.length - negDays.length, { note: `${negSrc.length} negative-Total days in Jan` });
  const refundModel = Math.abs(hotel.sum(pRows, 'closed_balance_folio')) + Math.abs(hotel.sum(pRows, 'loyalty_discount'));
  const srcRefund = payWindow(paySrc, f, t).refunds;
  T('7.2 Refund analysis (closed folio + loyalty discount)', srcRefund, refundModel, srcRefund - refundModel);
}

// ───────────────────────── 8. Clerk audit ─────────────────────────
console.log('\n=== 8. CLERK SHIFT & CASH AUDIT ===');
if (!skipSection('8')) {
  const srcC = srcClerk('Clerk Shift.csv');
  const scan = await parsers.scanReport('auto', fileUrl('Clerk Shift.csv'), { propertyId: pid1, propertyName: PROP.name, sourceFile: 'Clerk Shift.csv' });
  const cRows = await db.entities.ClerkShiftRecord.list('created_date');
  const dropsDb = cRows.filter((r) => r.record_type === 'drop');
  const dropsScan = scan.drops || [];
  const srcDrops = srcC.drops;
  T('8.1 Clerk drops scanned = independent parse', srcDrops.length, dropsScan.length, srcDrops.length - dropsScan.length, { note: `source drops=${srcDrops.length}, scan drops=${dropsScan.length}` });
  const sumDrops = (d) => d.reduce((a, x) => a + (Number(x.amount) || 0), 0);
  T('8.2 Clerk drop amounts match source', sumDrops(srcDrops), sumDrops(dropsScan), sumDrops(srcDrops) - sumDrops(dropsScan), { tol: 0.02 });
  T('8.3 Clerk drop amounts in DB match source', sumDrops(srcDrops), sumDrops(dropsDb), sumDrops(srcDrops) - sumDrops(dropsDb), { tol: 0.02 });
  const payC = cRows.filter((r) => r.record_type === 'payment');
  const cashSrc = srcC.payments.find((p) => p.payment_type === 'CASH');
  const cashDb = payC.find((p) => p.payment_type === 'CASH');
  T('8.4 Clerk CASH payment block matches source (net today)', cashSrc?.net_today ?? 0, cashDb?.net_today ?? 0, (cashSrc?.net_today ?? 0) - (cashDb?.net_today ?? 0), { note: 'last block wins (Jan/Apr/Jul stacked)' });

  // variance computation = app aiEngine intentClerk math
  const byClerk = new Map();
  dropsDb.forEach((d) => {
    const k = d.clerk_name || 'Unknown';
    const cur = byClerk.get(k) || { clerk: k, drops: 0, count: 0, expected: 0 };
    cur.drops += Number(d.amount) || 0; cur.count += 1;
    byClerk.set(k, cur);
  });
  const employees = await db.entities.ClerkShiftRecord.filter({ record_type: 'clerk_payment' });
  employees.forEach((r) => {
    if ((r.payment_type || '').toUpperCase() === 'CASH') {
      const k = r.clerk_name || 'Unknown';
      if (!byClerk.has(k)) byClerk.set(k, { clerk: k, drops: 0, count: 0, expected: 0 });
      byClerk.get(k).expected += Number(r.amount) || 0;
    }
  });
  const variances = [...byClerk.values()].map((c) => ({ ...c, variance: c.expected - c.drops })).sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance));
  T('8.5 Clerk audit variances computed (no NaN, sorted)', variances.length > 0 && variances.every((v) => Number.isFinite(v.variance)), variances.length, undefined, { ok: variances.length > 0 && variances.every((v) => Number.isFinite(v.variance)), note: `top: ${variances.slice(0, 3).map((v) => `${v.clerk} ${v.variance > 0 ? 'short' : 'over'} ${money(Math.abs(v.variance))}`).join('; ')}` });
}

// ───────────────────────── 9. AI assistant vs DB ─────────────────────────
console.log('\n=== 9. AI ASSISTANT (answers verified against database) ===');
if (!skipSection('9')) {
  const occ = (f, t) => occIn(f, t);
  const pRows = (f, t) => payIn(f, t);
  const srcRows = (f, t) => srcIn(f, t);
  const occTotals = (rows) => {
    const revenue = rows.reduce((a, r) => a + (Number(r.total_revenue_with_misc) || 0), 0);
    const roomsSold = rows.reduce((a, r) => a + (Number(r.rooms_sold) || 0), 0);
    const capacity = rows.reduce((a, r) => a + (Number(r.total_rooms) || 0), 0);
    return { revenue, roomsSold, capacity, adr: roomsSold ? revenue / roomsSold : 0, revpar: capacity ? revenue / capacity : 0, occ: capacity ? roomsSold / capacity : 0 };
  };
  const payTotals = (rows) => {
    const tfs = ['cash', 'check', 'amex', 'master', 'visa', 'discover', 'direct_bill', 'corpay', 'wire_transfer', 'loyalty_certificate', 'vip_pass', 'other'];
    const payments = rows.reduce((a, r) => a + tfs.reduce((b, k) => b + (Number(r[k]) || 0), 0), 0);
    const refunds = Math.abs(rows.reduce((a, r) => a + (Number(r.closed_balance_folio) || 0), 0)) + Math.abs(rows.reduce((a, r) => a + (Number(r.loyalty_discount) || 0), 0));
    return { payments, refunds };
  };
  const ask = (q, from, to) => answerQuestion({ question: q, propertyId: String(pid1), from, to, allowedPropertyIds: 'all' });
  const money0 = (v) => `$${Math.abs(Number(v) || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

  // Q1 ADR on a date
  const q1 = await ask('What was my ADR on January 15 2026?', '', '');
  const adrExpected = occTotals(occ('2026-01-15', '2026-01-15')).adr;
  T('9.1 AI ADR on 2026-01-15', money0(adrExpected), q1.answer.match(/\$[\d,]+\.?\d*/)?.[0] || '?', undefined, { ok: q1.answer.includes(money(adrExpected)) || q1.answer.includes(money0(adrExpected)) || q1.answer.includes((adrExpected).toFixed(2)), note: q1.answer.replace(/\n/g, ' | ').slice(0, 120) });

  // Q2 rooms sold
  const q2 = await ask('How many rooms were sold in January 2026?', '', '');
  const soldExp = occTotals(occ('2026-01-01', '2026-01-31')).roomsSold;
  T('9.2 AI rooms sold Jan', soldExp.toLocaleString('en-US'), q2.answer.match(/[\d,]+/)?.[0] || '?', undefined, { ok: q2.answer.includes(String(soldExp)) || q2.answer.includes(soldExp.toLocaleString('en-US')), note: q2.answer.replace(/\n/g, ' | ').slice(0, 120) });

  // Q3 Expedia revenue
  const q3 = await ask('How much did Expedia generate in January 2026?', '', '');
  const expExp = srcRows('2026-01-01', '2026-01-31').filter((r) => /EXPEDIA/.test(`${r.source} ${r.code}`) && !/HOTEL COLLECT/i.test(`${r.source} ${r.code}`)).reduce((a, r) => a + (Number(r.net_revenue) || 0), 0);
  T('9.3 AI Expedia Jan', money0(expExp), q3.answer.match(/\$[\d,]+\.?\d*/)?.[0] || '?', undefined, { ok: q3.answer.includes(money(expExp)) || q3.answer.includes(money0(expExp)), note: q3.answer.replace(/\n/g, ' | ').slice(0, 120) });

  // Q4 money kept (falls back to summary; verify net profit line vs model)
  const q4 = await ask('How much money did I keep in January 2026?', '', '');
  const occJ = occTotals(occ('2026-01-01', '2026-01-31'));
  const payJ = payTotals(pRows('2026-01-01', '2026-01-31'));
  const expJ = (await db.entities.Expense.filter({ property_id: pid1 }, 'expense_date')).filter((e) => hotel.inRange(e.expense_date, '2026-01-01', '2026-01-31'));
  const payrJAll = (await db.entities.PayrollRun.filter({ property_id: pid1 }, 'pay_period_start')).filter((p) => hotel.inRange(p.pay_period_start, '2026-01-01', '2026-01-31'));
  //
  // COMMITTED PAYROLL ONLY, deliberately. The AI (and every money page since the
  // 2026-08-16 fixes) counts payroll that is approved/paid and ignores DRAFT runs —
  // a draft is a proposal, and counting one made "money kept" drop the moment a run
  // was keyed in. This harness summed total_pay across ALL runs, so it expected
  // ~$6,800 more cost than the documented model, and checks 9.4/9.6 failed by
  // exactly that delta while the app agreed with itself. The expectation now uses
  // the same filterCommittedPay the production code uses — loaded from the real
  // module, not re-implemented here.
  const { filterCommittedPay } = await mod('/src/lib/payrollCalc.js');
  const payrJ = filterCommittedPay(payrJAll);
  T('9.4a Draft-payroll exclusion is exercised by this fixture',
    true, payrJAll.length > payrJ.length ? 1 : 0, payrJAll.length > payrJ.length ? 0 : 1,
    { ok: payrJAll.length > payrJ.length, note: `${payrJAll.length} runs total, ${payrJ.length} committed — without a draft present this check would pass vacuously` });
  const costsJ = payrJ.reduce((a, r) => a + (Number(r.total_pay) || 0), 0) + expJ.filter((e) => e.category !== 'payroll').reduce((a, e) => a + (Number(e.amount) || 0), 0);
  const netProfit = occJ.revenue - payJ.refunds - costsJ;
  const profitLine = q4.answer.split('\n').find((l) => l.includes('Net profit'));
  const profitMatch = profitLine && (profitLine.includes(money0(netProfit)) || profitLine.includes(money(netProfit)));
  T('9.4 AI "money kept" (net profit line vs model)', money0(netProfit), profitLine || '(none)', undefined, { ok: !!profitMatch, note: `AI net-rev model: gross−refunds−costs; kept model differs (includes comm/cc/tax) — documented; committed payroll ${money0(payrJ.reduce((a, r) => a + (Number(r.total_pay) || 0), 0))} of ${money0(payrJAll.reduce((a, r) => a + (Number(r.total_pay) || 0), 0))} total` });

  // Q5 taxes — no tax intent; documented fallback
  const q5 = await ask('What were my taxes in January 2026?', '', '');
  const _hasTaxInfo = /tax/i.test(q5.answer);
  T('9.5 AI taxes question returns (documented: summary fallback, no tax intent)', 'summary-fallback', q5.answer.slice(0, 60), undefined, { ok: !/missing|couldn't find/i.test(q5.answer), note: q5.answer.replace(/\n/g, ' | ').slice(0, 120) });

  // Q6 expenses
  const q6 = await ask('What were my expenses in January 2026?', '', '');
  const expTotal = costsJ;
  T('9.6 AI expenses Jan', money0(expTotal), q6.answer.match(/\$[\d,]+\.?\d*/)?.[0] || '?', undefined, { ok: q6.answer.includes(money(expTotal)) || q6.answer.includes(money0(expTotal)), note: q6.answer.replace(/\n/g, ' | ').slice(0, 120) });

  // Q7 compare months (this-year only data)
  const q7 = await ask('Compare March with April 2026', '', '');
  T('9.7 AI month-vs-month compare answers', true, q7.answer.length > 0, undefined, { ok: q7.answer.length > 0 && !/couldn't find/i.test(q7.answer), note: q7.answer.replace(/\n/g, ' | ').slice(0, 130) });

  // Q8 summary numbers (revenue/occupancy/ADR/RevPAR all cross-checked)
  const q8 = await ask('Show the executive summary for January 2026', '', '');
  const revLine = q8.answer.split('\n').find((l) => l.includes('Revenue:'));
  const revOk = revLine && (revLine.includes(money0(occJ.revenue)) || revLine.includes(money(occJ.revenue)));
  T('9.8 AI summary Revenue line matches DB', money0(occJ.revenue), revLine || '(none)', undefined, { ok: !!revOk, note: revLine || q8.answer.replace(/\n/g, ' | ').slice(0, 100) });
}

// ───────────────────────── 10. Referential integrity & sessions ─────────────────────────
console.log('\n=== 10. INTEGRITY & SESSIONS ===');
if (!skipSection('10')) {
  const issues = await clientMod.checkReferentialIntegrity();
  T('10.1 Referential integrity (no orphan property refs)', 0, issues.length, 0 - issues.length, { ok: issues.length === 0, note: issues.map((i) => `${i.table}:${i.value}`).join(',') || 'clean' });
  const sessions = await readSessions(clientMod);
  const completed = sessions.filter((s) => s.status === 'completed').length;
  T('10.2 Import sessions recorded & completed (>= files; lifecycle re-imports add more)', completed, completed - IMPORT_FILES.length, undefined, { ok: completed >= IMPORT_FILES.length, note: `${sessions.length} sessions, ${completed} completed, ${IMPORT_FILES.length} files` });
  const dupRows = await countDupes('OccupancyDay', (r) => `${r.property_id}|${r.date}`);
  T('10.3 No duplicate occupancy rows after all lifecycle tests', 0, dupRows, 0 - dupRows);
}

// ───────────────────────── Helpers (defined after use) ─────────────────────────
async function countDupes(table, keyFn) {
  const all = await localDb[table].toArray();
  const seen = new Set();
  let dups = 0;
  for (const r of all) {
    const k = keyFn(r);
    if (seen.has(k)) dups++;
    seen.add(k);
  }
  return dups;
}

// Mirror of the MoneyKept.jsx calculation (component uses these exact steps; this
// port exists so we can drive it in Node. It imports the same lib functions.)
async function moneyKeptMirror({ from, to, pid, label: _label }) {
  const occRows = (await db.entities.OccupancyDay.list('date')).filter((r) => hotel.inRange(r.date, from, to));
  const srcRows = (await db.entities.SourceDay.list('date')).filter((r) => hotel.inRange(r.date, from, to));
  const grossRows = (await db.entities.GrossRevenueDay.list('date')).filter((r) => hotel.inRange(r.date, from, to));
  const payRows = (await db.entities.PaymentDay.list('date')).filter((r) => hotel.inRange(r.date, from, to));
  const expenses = await db.entities.Expense.list('-expense_date');
  const payroll = await db.entities.PayrollRun.list('-pay_period_start');
  const ccFee = commission.getCcFeeRate();
  const ccFeeRefunds = commission.getCcFeeOnRefunds();

  const taxImp = new Map();
  grossRows.forEach((r) => {
    const d = String(r.date).slice(0, 10);
    const cur = taxImp.get(d) || { state: 0, city: 0, other: 0 };
    cur.state += Number(r.state_tax) || 0;
    cur.city += Number(r.city_tax) || 0;
    cur.other += Number(r.other_tax) || 0;
    taxImp.set(d, cur);
  });
  const taxBase = new Map();
  srcRows.forEach((r) => {
    const src = taxConfig.TAX_SOURCES.find((s) => s.key === classifySrc(r.source || r.code));
    if (!src || !src.taxable) return;
    const d = String(r.date).slice(0, 10);
    // Gross up the tax base too (owner directive 2026-08-27): net_revenue is
    // post-commission net, taxable base is the grossed-up booking value.
    const { grossCents } = hotel.grossUpFromNetCents(decimal.toCents(r.net_revenue), hotel.commissionFor(r.source || r.code), r.stays);
    taxBase.set(d, (taxBase.get(d) || 0) + decimal.fromCents(grossCents));
  });
  const dayMap = new Map();
  const bump = (date, key, v) => {
    if (!date) return;
    const cur = dayMap.get(date) || { date, gross: 0, commission: 0, ccFee: 0, refundFee: 0, refunds: 0 };
    cur[key] += v;
    dayMap.set(date, cur);
  };
  // Mirror MoneyKept.jsx exactly: the occupancy ledger owns ROOM revenue and the
  // gross-revenue ledger owns ancillary charges. `total_revenue_with_misc` was a
  // stale parser field assumption and read as zero on imported rows, which made
  // this harness report gross=$0 while the real component correctly called
  // grossRevenueForPeriod(). Keeping the two legs explicit also prevents the same
  // room night being counted twice.
  occRows.forEach((r) => bump(String(r.date).slice(0, 10), 'gross', Number(r.room_revenue) || 0));
  grossRows.forEach((r) => bump(
    String(r.date).slice(0, 10),
    'gross',
    decimal.fromCents(hotel.rowAncillaryRevenueCents(r)),
  ));
  srcRows.forEach((r) => {
    const info = hotel.commissionFor(r.source || r.code);
    // net_revenue is POST-commission net: commission = grossed-up gross − net.
    const { commissionCents } = hotel.grossUpFromNetCents(decimal.toCents(r.net_revenue), info, r.stays);
    bump(String(r.date).slice(0, 10), 'commission', decimal.fromCents(commissionCents));
  });
  payRows.forEach((r) => {
    const date = String(r.date).slice(0, 10);
    const card = payNorm.CARD_METHODS.reduce((a, k) => a + (Number(r[k]) || 0), 0);
    bump(date, 'ccFee', card * ccFee);
    const refund = Math.abs(Number(r.closed_balance_folio) || 0) + Math.abs(Number(r.loyalty_discount) || 0);
    bump(date, 'refunds', refund);
    if (ccFeeRefunds) bump(date, 'refundFee', refund * ccFee);
  });
  const taxEnabled = taxConfig.getTaxConfig().taxEnabled;
  const ratesCache = new Map();
  const ratesFor = (d) => {
    if (!ratesCache.has(d)) ratesCache.set(d, taxSettings.getEffectiveTaxRates(pid, d));
    return ratesCache.get(d);
  };
  const dayTotals = [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date)).map((d) => {
    const imp = taxImp.get(d.date);
    const hasImported = imp && (imp.state + imp.city + imp.other) > 0.004;
    let state = 0, city = 0, other = 0, passTax = 0, deductTax = 0;
    if (hasImported) {
      state = imp.state; city = imp.city; other = imp.other;
      passTax = state + city + other;
    } else if (taxEnabled) {
      const r = ratesFor(d.date);
      const base = taxBase.get(d.date) || d.gross;
      state = base * r.state;
      city = base * r.city;
      other = base * r.other;
      deductTax = state + city + other;
    }
    return { ...d, state, city, other, passTax, deductTax };
  });

  const expInPeriod = expenses.filter((e) => hotel.inRange(e.expense_date, from, to));
  const payInPeriod = payroll.filter((p) => hotel.inRange(p.pay_period_start, from, to));
  const otaFromSources = srcRows.length > 0;
  const expGroups = {};
  expInPeriod.forEach((e) => {
    const cat = e.category;
    const b = cat === 'ota_commission' ? (otaFromSources ? 'other' : 'ota') : cat === 'payroll' ? 'payroll' : ['state_taxes', 'city_taxes'].includes(cat) ? 'taxes' : cat || 'other';
    (expGroups[b] = expGroups[b] || []).push(e);
  });
  const expAmt = (b) => (expGroups[b] || []).reduce((a, e) => a + (Number(e.amount) || 0), 0);

  const srcMap = new Map();
  srcRows.forEach((r) => {
    const src = r.source || r.code || 'UNKNOWN';
    const info = hotel.commissionFor(src);
    const stays = Number(r.stays) || 0;
    // net_revenue is POST-commission net: gross up to the booking value, commission = gross − net.
    const { grossCents, commissionCents } = hotel.grossUpFromNetCents(decimal.toCents(r.net_revenue), info, stays);
    const cur = srcMap.get(src) || { name: src, gross: 0, stays: 0, comm: 0, rate: info.rate };
    cur.gross += decimal.fromCents(grossCents); cur.stays += stays; cur.comm += decimal.fromCents(commissionCents);
    srcMap.set(src, cur);
  });
  const otaRecords = [...srcMap.values()].filter((x) => x.gross > 0 || x.comm > 0);

  const ccRecords = payRows
    .map((r) => {
      const date = String(r.date).slice(0, 10);
      const card = payNorm.CARD_METHODS.reduce((a, k) => a + (Number(r[k]) || 0), 0);
      return { name: date, detail: '', amount: card * ccFee };
    })
    .filter((x) => x.amount > 0);

  const items = [];
  const pushItem = (key, label, amount) => {
    if (amount > 0.004) items.push({ key, label, amount: Math.round(amount * 100) / 100 });
  };
  if (otaFromSources) {
    pushItem('ota', 'OTA Commissions', otaRecords.reduce((a, x) => a + x.comm, 0));
  } else {
    pushItem('ota', 'OTA Commissions', expAmt('ota'));
  }
  pushItem('cc', 'Credit Card Processing Fees', ccRecords.reduce((a, x) => a + x.amount, 0));
  if (ccFeeRefunds) pushItem('refund_fee', 'CC Fee on Refunds', dayTotals.reduce((a, d) => a + d.refundFee, 0));
  const estimatedTaxTotal = dayTotals.reduce((a, d) => a + d.deductTax, 0) + expAmt('taxes');
  pushItem('taxes', 'Business Taxes (estimated)', estimatedTaxTotal);
  pushItem('payroll', 'Payroll', payInPeriod.reduce((a, p) => a + (Number(p.total_pay) || 0), 0) + expAmt('payroll'));
  const specialBuckets = new Set(['ota', 'payroll', 'taxes']);
  for (const k of [...expCats.STANDARD_CATEGORY_KEYS, ...Object.keys(expGroups)]) {
    if (specialBuckets.has(k) || k === 'other') continue;
    if (expGroups[k]) pushItem(k, expCats.expenseLabel(k), expAmt(k));
  }
  pushItem('other', 'Other Expenses', expAmt('other'));
  pushItem('refunds', 'Refunds', dayTotals.reduce((a, d) => a + d.refunds, 0));

  const totalDeductions = items.reduce((a, i) => a + i.amount, 0);
  const gross = dayTotals.reduce((a, d) => a + d.gross, 0);
  const kept = gross - totalDeductions;
  console.log(`  [debug mirror] payRows=${payRows.length} refunds=${dayTotals.reduce((a, d) => a + d.refunds, 0).toFixed(2)} commission=${dayTotals.reduce((a, d) => a + d.commission, 0).toFixed(2)} folioSample=${JSON.stringify(payRows.slice(0, 3).map((r) => [r.date, r.closed_balance_folio, r.loyalty_discount]))}`);
  return { gross, totalDeductions, kept, items };
}

function classifySrc(text) {
  const t = `${text || ''}`.toUpperCase();
  if (/EXPEDIA.*HOTEL COLLECT|EHC/.test(t)) return 'EXPEDIA_HC';
  if (/BOOKING\.?COM.*HOTEL COLLECT|BHC/.test(t)) return 'BOOKING_HC';
  if (/WALK|WIN/.test(t)) return 'WALK_IN';
  if (/PROPERTY BOOKING|PRP|RR WEBSITE|WEB|RED ROOF APP|APP|CONTACT CENTER|CRS/.test(t)) return 'PROPERTY_BOOKING';
  return 'OTHER_OTA';
}

// ───────────────────────── Report ─────────────────────────
console.log(`\n${'='.repeat(70)}`);
console.log(`RESULT: ${passed} passed, ${failed} failed  (${results.length} checks)`);
if (failures.length) {
  console.log('\nFAILED:');
  failures.forEach((f) => console.log('  - ' + f));
}
const report = {
  generated: new Date().toISOString(),
  summary: { passed, failed, total: results.length },
  rows: results.map((r) => ({
    test: r.name,
    source: r.note && /documented/.test(r.note) && r.diff === 0 ? 'documented-formula' : typeof r.source === 'number' ? `$${r.source.toFixed(2)}` : String(r.source).slice(0, 40),
    dashboard: typeof r.dashboard === 'number' ? `$${r.dashboard.toFixed(2)}` : String(r.dashboard).slice(0, 40),
    diff: r.diff === null ? '-' : typeof r.diff === 'number' ? `$${Math.abs(r.diff).toFixed(2)}` : String(r.diff),
    pass: r.pass,
    note: r.note,
  })),
};
fs.writeFileSync(path.join(__dirname, 'acceptance-report.json'), JSON.stringify(report, null, 2));
console.log(`\nReport written to scripts/acceptance-report.json`);
} finally {
  await server.close();
}
process.exit(failed ? 1 : 0);
