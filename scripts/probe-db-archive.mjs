/**
 * PROBE: whole-database backup and restore (src/lib/dbArchive.js).
 *
 * WHAT THIS DEFENDS. Every record in this app lives in one browser under one
 * origin, with no server copy. Until this module existed there was no way to get
 * the database out, so a cleared site-data or a dead laptop was total loss. A
 * backup feature that is subtly lossy is worse than none, because it is trusted:
 * the loss is discovered at the moment of restore, when the original is gone.
 *
 * So this suite is written to fail on LOSS, not on crashes. The load-bearing
 * assertions are the ones that compare the database after a restore against what
 * it held before the export, field by field, including the fields no Dexie index
 * mentions and the settings that never lived in Dexie at all.
 *
 * SECTIONS
 *   1  codec: every value shape round-trips, and every shape that cannot is REFUSED
 *   2  canonical JSON + checksum: key order cannot change the digest
 *   3  classification: every live store is archived or excluded with a reason
 *   4  full round trip: seed → export → wipe → restore → compare row by row
 *   5  audit chain still verifies after a restore (byte fidelity, hardest table)
 *   6  refusal set: nine ways a bad file is rejected instead of half-restored
 *   7  atomicity: a restore that fails leaves the existing database untouched
 *   8  permission gate fails closed
 *   9  cross-module invariants: the duplicated key literal, the CSV upload gate,
 *      the single download implementation, and the localStorage-writer manifest
 *
 * Run: node --import ./scripts/_loader-boot.mjs scripts/probe-db-archive.mjs
 */

await import("fake-indexeddb/auto");
globalThis.crypto ??= (await import("node:crypto")).webcrypto;
if (!globalThis.crypto?.subtle) globalThis.crypto = (await import("node:crypto")).webcrypto;

// A fuller localStorage shim than most probes need: dbArchive ENUMERATES storage
// (`length` + `key(i)`) to find settings keys, so a Map-with-getItem shim would
// make section 4 pass by finding nothing.
const __store = new Map();
const __storage = {
  getItem: (k) => (__store.has(k) ? __store.get(k) : null),
  setItem: (k, v) => __store.set(String(k), String(v)),
  removeItem: (k) => __store.delete(String(k)),
  clear: () => __store.clear(),
  key: (i) => [...__store.keys()][i] ?? null,
  get length() {
    return __store.size;
  },
};
globalThis.localStorage = __storage;
globalThis.sessionStorage = __storage;
globalThis.window = globalThis;
globalThis.screen = { width: 1920, height: 1080 };
if (globalThis.navigator === undefined) {
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: "harness", language: "en-US" },
    configurable: true,
  });
}

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");

const { default: localDb } = await import("@/api/localDb");
const { db } = await import("@/api/base44Client");
const { signInAsAllPropertyOwner } = await import("./_harness-auth.mjs");
const { verifyAuditChain } = await import("@/lib/auditLogger");

// Loaded defensively: a probe that dies at import reports NOTHING, and the runner
// calls that BROKEN — which looks like a suite that verified something.
let A = null;
try {
  A = await import("@/lib/dbArchive");
} catch (e) {
  console.log(`  (src/lib/dbArchive.js did not load: ${e.code || e.message})`);
}

let pass = 0;
let fail = 0;
const failures = [];

function ok(label, cond, detail) {
  if (cond) pass += 1;
  else {
    fail += 1;
    failures.push(detail ? `${label} — ${detail}` : label);
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
const eq = (label, actual, expected) =>
  ok(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

/** Assert `fn` throws, and that the message names the reason. */
async function refuses(label, fn, needle) {
  let message = null;
  try {
    await fn();
  } catch (e) {
    message = e?.message || String(e);
  }
  if (message === null) {
    ok(label, false, "did not throw");
    return;
  }
  ok(
    label,
    message.toLowerCase().includes(needle.toLowerCase()),
    `threw, but the message does not mention "${needle}": ${message}`,
  );
}

if (!A) {
  console.log(`\nPASS 0   FAIL 1`);
  console.log(`\nFAILED: 0 passed, 1 failed`);
  console.log("  src/lib/dbArchive.js is missing — nothing could be verified.");
  process.exit(1);
}

// Deep comparison that is strict about the things JSON quietly changes: a Date
// must come back a Date, `undefined` must come back as a PRESENT key holding
// undefined, and a number must not have become a string.
function deepEqual(a, b, path = "") {
  if (a instanceof Date || b instanceof Date) {
    if (!(a instanceof Date) || !(b instanceof Date)) return `${path}: Date vs ${typeof (a instanceof Date ? b : a)}`;
    return a.getTime() === b.getTime() ? null : `${path}: ${a.toISOString()} vs ${b.toISOString()}`;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return `${path}: array vs non-array`;
    if (a.length !== b.length) return `${path}: length ${a.length} vs ${b.length}`;
    for (let i = 0; i < a.length; i += 1) {
      const r = deepEqual(a[i], b[i], `${path}[${i}]`);
      if (r) return r;
    }
    return null;
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (ka.join("|") !== kb.join("|")) return `${path}: keys [${ka}] vs [${kb}]`;
    for (const k of ka) {
      const r = deepEqual(a[k], b[k], `${path}.${k}`);
      if (r) return r;
    }
    return null;
  }
  if (a === b) return null;
  if (Number.isNaN(a) && Number.isNaN(b)) return null;
  return `${path}: ${JSON.stringify(a)} (${typeof a}) vs ${JSON.stringify(b)} (${typeof b})`;
}

async function wipe() {
  await localDb.open();
  await Promise.all(localDb.tables.map((t) => t.clear()));
  localStorage.clear();
  sessionStorage.clear();
}

// ─── 1. Codec ────────────────────────────────────────────────────────────────
console.log("\n1. Value codec: lossless for what this schema stores, refuses the rest");
{
  const hazards = [];
  const roundTrip = (value) => A.decodeValue(JSON.parse(JSON.stringify(A.encodeValue(value, "x", hazards))));

  const cases = [
    ["a string", "Nuñez — €1,020,598.17"],
    ["an empty string", ""],
    ["zero", 0],
    ["a negative cents integer", -204518],
    ["a float", 0.025],
    ["true", true],
    ["false", false],
    ["null", null],
    ["a Date", new Date("2026-08-23T14:12:00.000Z")],
    ["the epoch", new Date(0)],
    ["a nested array of objects", [{ a: 1 }, { a: 2, b: [3, 4] }]],
    ["a deeply nested object", { a: { b: { c: { d: [1, { e: "f" }] } } } }],
    ["an empty object", {}],
    ["an empty array", []],
    ["a row with a Date inside an array", { rows: [{ at: new Date("2020-01-02T03:04:05.678Z") }] }],
  ];
  for (const [label, value] of cases) {
    const back = roundTrip(value);
    const diff = deepEqual(value, back);
    ok(`round-trips ${label}`, diff === null, diff || undefined);
  }
  eq("no hazards recorded for legal values", hazards.length, 0);

  // `undefined` as a VALUE must survive as a present key. Plain JSON drops the
  // key entirely, which silently turns "field explicitly cleared" into "field
  // never existed" — a difference the app can see.
  const withUndef = roundTrip({ note: undefined, kept: 1 });
  ok(
    "a key holding undefined survives as a present key",
    Object.prototype.hasOwnProperty.call(withUndef, "note") && withUndef.note === undefined,
    `got ${JSON.stringify(Object.keys(withUndef))}`,
  );

  // A row that itself carries the tag key must not be misread as a tagged node.
  const collide = roundTrip({ $dba: "date", v: "not-a-date", other: 7 });
  const collideDiff = deepEqual({ $dba: "date", v: "not-a-date", other: 7 }, collide);
  ok("a row carrying the tag key is escaped, not misread", collideDiff === null, collideDiff || undefined);

  // Refusals: each one records a hazard naming the path, and the value is NOT
  // silently written as null/{}.
  const refusals = [
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["-Infinity", -Infinity],
    ["a BigInt", 10n],
    ["a function", () => 1],
    ["a Map", new Map([["a", 1]])],
    ["a Set", new Set([1])],
    ["a RegExp", /x/g],
    ["a typed array", new Uint8Array([1, 2, 3])],
    ["an ArrayBuffer", new ArrayBuffer(4)],
    ["an Invalid Date", new Date("nope")],
  ];
  for (const [label, value] of refusals) {
    const h = [];
    A.encodeValue({ field: value }, "Store[0]", h);
    ok(`refuses ${label}`, h.length === 1, `recorded ${h.length} hazards: ${JSON.stringify(h)}`);
    ok(`the ${label} refusal names the field`, h[0]?.includes("Store[0].field"), `got ${JSON.stringify(h[0] || null)}`);
  }
  ok("an unknown tag throws rather than guessing", (() => {
    try {
      A.decodeValue({ $dba: "future-type", v: 1 });
      return false;
    } catch {
      return true;
    }
  })());
}

// ─── 2. Canonical JSON + checksum ────────────────────────────────────────────
console.log("\n2. Canonical serialization: the digest depends on the data, not key order");
{
  const a = { b: 1, a: { z: [1, 2], y: "x" }, c: null };
  const b = { c: null, a: { y: "x", z: [1, 2] }, b: 1 };
  eq("two orderings serialize identically", A.canonicalJson(a), A.canonicalJson(b));
  ok("array order is preserved (it is data, not ordering noise)",
    A.canonicalJson([1, 2]) !== A.canonicalJson([2, 1]));

  const c1 = await A.archiveChecksum({ stores: { X: [{ a: 1, b: 2 }] } });
  const c2 = await A.archiveChecksum({ stores: { X: [{ b: 2, a: 1 }] } });
  eq("checksum is stable across key order", c1, c2);
  eq("checksum is 64 hex chars (SHA-256)", /^[0-9a-f]{64}$/.test(c1), true);
  const c3 = await A.archiveChecksum({ stores: { X: [{ a: 1, b: 3 }] } });
  ok("checksum changes when a value changes", c1 !== c3);
  // The one that matters: a single cent must change the digest.
  const m1 = await A.archiveChecksum({ stores: { E: [{ amount_cents: 102059817 }] } });
  const m2 = await A.archiveChecksum({ stores: { E: [{ amount_cents: 102059816 }] } });
  ok("a one-cent difference changes the digest", m1 !== m2);
}

// ─── 3. Store classification ─────────────────────────────────────────────────
console.log("\n3. Classification: no live store can fall out of a backup by omission");
{
  await localDb.open();
  const live = localDb.tables.map((t) => t.name);
  const { included, excluded } = A.classifyStores(live);

  eq("every live store is classified", included.length + excluded.length, live.length);
  ok("nothing is in both lists", included.every((n) => !excluded.includes(n)));
  ok("the include list is not empty (the check is not vacuous)", included.length >= 25,
    `included ${included.length} of ${live.length}`);

  // Every exclusion must name a REAL table: a rename would otherwise turn a
  // deliberate exclusion into a store nobody archives and nobody notices.
  const phantom = Object.keys(A.EXCLUDED_STORES).filter((n) => typeof localDb[n]?.toArray !== "function");
  ok("every excluded name is still a declared store", phantom.length === 0,
    `phantom exclusions: ${JSON.stringify(phantom)}`);
  const unreasoned = Object.entries(A.EXCLUDED_STORES).filter(([, why]) => !why || String(why).length < 30);
  ok("every exclusion carries a written reason", unreasoned.length === 0,
    `no reason for: ${JSON.stringify(unreasoned.map(([n]) => n))}`);

  // The two named exclusions are the only ones, and they are the credential ones.
  eq("LocalSession is excluded", excluded.includes("LocalSession"), true);
  eq("PasswordResetRequest is excluded", excluded.includes("PasswordResetRequest"), true);
  eq("nothing else is excluded", excluded.length, 2);

  // The restore writes every store with the same uniform `bulkPut(rows)`, which
  // only works when the primary key rides INSIDE the row. A store declared with
  // an outbound key would throw on restore — and section 4 would not catch it for
  // a store that happens to be empty in the fixture, so it is checked directly
  // for all of them. `keyPath === null` means outbound.
  const outbound = included.filter((name) => localDb[name].schema.primKey.keyPath === null);
  ok("every archived store has an inbound primary key", outbound.length === 0,
    `outbound-key store(s) would fail bulkPut on restore: ${JSON.stringify(outbound)}`);
  const keyPaths = included.map((name) => `${name}:${localDb[name].schema.primKey.keyPath}`);
  ok("the key-path check saw every archived store", keyPaths.length === included.length);
  console.log(`        archived stores with inbound keys: ${included.length}`);

  // Stores that carry money or hand-entered records must be INCLUDED. Named
  // explicitly, so a future exclusion of one of them fails here instead of
  // shipping a backup that quietly omits payroll.
  for (const name of [
    "Property", "User", "Staff", "PayrollRun", "Expense", "TransactionLine",
    "OccupancyDay", "SourceDay", "GrossRevenueDay", "PaymentDay", "AuditLog",
    "ImportRecordIds", "IdSequence", "AdjustmentRefund", "TimecardPunch",
  ]) {
    ok(`${name} is archived`, included.includes(name), `not in the include list`);
  }

  // Local-slot rules.
  for (const key of [
    "rri_commission_rates_v2", "rri_cc_fee_rate", "rri_cc_fee_refunds_v1",
    "rri_tax_settings_v1", "rri_tax_config_v1", "rri_alert_thresholds",
    "rri_revenue_thresholds", "rri_pricing_config", "rri_weather_config",
    "rri_housekeeping_config_p1", "rri_automationRules", "rri_filters_transactions",
    "manual_draft_p1_occupancy",
  ]) {
    ok(`archives the setting "${key}"`, A.shouldArchiveLocalKey(key));
  }
  for (const key of [
    "rr_local_session", "rri_enc_rr_local_session", "rri_enc_rri_import_sessions",
    "rri_rate_limit_login", "rri_rate_limits_v1", "rri_csrf_token",
    "rri_session_revocation", "rri_realtime_change", "rri_audit_write_failures_v1",
    "_rri_test_", "__yjs_hotel", "some_other_app_key",
  ]) {
    ok(`never archives "${key}"`, A.shouldArchiveLocalKey(key) === false);
  }
}

// ─── 4. Full round trip ──────────────────────────────────────────────────────
console.log("\n4. Round trip: seed → export → wipe → restore → compare");

// Rows written with RAW localDb on purpose: the entity proxy stamps created_date
// and property_id, and this section is about byte fidelity, so the fixture has to
// be the exact bytes. Field shapes mirror what the app really stores — ISO date
// strings, integer cents, nested arrays, an explicitly-undefined field.
const FIXTURE = {
  Property: [
    { id: 1, code: "BOS1", name: "Red Roof Boston", rooms: 108, created_date: "2026-01-02T00:00:00.000Z" },
    { id: 2, code: "BOS2", name: "Red Roof Revere", rooms: 92, created_date: "2026-01-02T00:00:00.000Z" },
  ],
  Staff: [
    { id: 1, employee_id: "JOH001", full_name: "Ann Johnson", property_id: 1, hourly_rate_cents: 2150, active: true },
    { id: 2, employee_id: "NUN001", full_name: "Luis Nuñez", property_id: 2, hourly_rate_cents: 2400, active: false, terminated_on: "2026-06-30" },
  ],
  PayrollRun: [
    {
      id: 1, property_id: 1, period_start: "2026-08-01", period_end: "2026-08-15",
      status: "approved", paid: true, gross_cents: 1842300, tax_withheld_cents: 267400,
      lines: [{ employee_id: "JOH001", hours: 78.5, gross_cents: 1687750 }],
    },
  ],
  Expense: [
    { id: 1, property_id: 1, category: "utilities", amount_cents: 412988, payment_status: "paid", incurred_on: "2026-08-03", memo: undefined },
    { id: 2, property_id: 2, category: "supplies", amount_cents: 9900, payment_status: "unpaid", incurred_on: "2026-08-04" },
  ],
  TransactionLine: [
    { id: 1, property_id: 1, date: "2026-08-01", type: "CHARGE", amount_cents: 18900, source: "EXPEDIA", import_id: "imp_1" },
    { id: 2, property_id: 1, date: "2026-08-01", type: "REFUND", amount_cents: -4500, source: "DIRECT", import_id: "imp_1" },
    { id: 3, property_id: 2, date: "2026-08-02", type: "CHARGE", amount_cents: 22100, source: "BOOKING", import_id: "imp_2" },
  ],
  OccupancyDay: [
    { id: 1, property_id: 1, date: "2026-08-01", rooms_sold: 91, rooms_available: 108, revenue_cents: 1718900 },
  ],
  ImportRecordIds: [
    { id: 1, import_id: "imp_1", entity: "TransactionLine", record_ids: [1, 2], status: "active" },
    { id: 2, import_id: "imp_2", entity: "TransactionLine", record_ids: [3], status: "active" },
  ],
  IdSequence: [
    { prefix: "JOH", next: 2 },
    { prefix: "NUN", next: 2 },
  ],
  AdjustmentRefund: [
    { id: 1, property_id: 1, date: "2026-08-05", amount_cents: -4500, reason: "duplicate charge" },
  ],
};

const SETTINGS = {
  rri_commission_rates_v2: JSON.stringify({ EXPEDIA: { type: "percentage", rate: 0.18, taxExempt: false } }),
  rri_cc_fee_rate: "0.0275",
  rri_cc_fee_refunds_v1: "1",
  rri_tax_settings_v1: JSON.stringify([{ property_id: "*", state_rate: 0.0575, city_rate: 0.06, other_rate: 0, effective_start: "2026-01-01", effective_end: "" }]),
  rri_alert_thresholds: JSON.stringify({ occupancy_low: 0.45 }),
  rri_housekeeping_config_1: JSON.stringify({ minutes_per_room: 27 }),
  manual_draft_1_occupancy: JSON.stringify([{ date: "2026-08-20", rooms_sold: 77 }]),
};

const IMPORT_SESSIONS = [
  { id: "sess_1", import_id: "imp_1", source_file: "transactions.csv", status: "completed", rows: 2 },
  { id: "sess_2", import_id: "imp_2", source_file: "transactions2.csv", status: "completed", rows: 1 },
];

let exportedText = null;
{
  await wipe();
  await signInAsAllPropertyOwner();

  for (const [table, rows] of Object.entries(FIXTURE)) {
    for (const row of rows) await localDb[table].add(row);
  }
  for (const [k, v] of Object.entries(SETTINGS)) localStorage.setItem(k, v);
  const { secureStore } = await import("@/lib/securityUtils");
  await secureStore("rri_import_sessions", IMPORT_SESSIONS);

  // Three real audit rows, written the way the app writes them, so section 5 has
  // a genuine hash chain to verify rather than hand-built rows.
  for (const action of ["Commission rates updated", "Tax settings updated", "Payroll approved"]) {
    await db.audit.log({ username: "harness-owner", action, detail: `${action} in the fixture` });
  }
  const auditBefore = await localDb.AuditLog.toArray();
  ok("fixture wrote a real audit chain", auditBefore.length >= 3, `${auditBefore.length} rows`);
  const chainBefore = await verifyAuditChain();
  ok("the fixture chain verifies before export", chainBefore?.valid !== false,
    `verifyAuditChain returned ${JSON.stringify(chainBefore)}`);

  const before = {};
  for (const t of localDb.tables) before[t.name] = await t.toArray();

  const archive = await A.buildArchive();
  exportedText = A.serializeArchive(archive);

  eq("the archive names the format", archive.format, A.ARCHIVE_FORMAT);
  eq("the archive records the schema version", archive.schema_version, localDb.verno);
  eq("the archive records the database name", archive.database, localDb.name);
  ok("the archive records who exported it", typeof archive.exported_by === "string" && archive.exported_by.length > 0,
    `got ${JSON.stringify(archive.exported_by)}`);
  ok("the archive records when", /^\d{4}-\d{2}-\d{2}T/.test(archive.exported_at || ""), archive.exported_at);
  eq("total_rows matches the sum of the per-store counts",
    archive.total_rows, Object.values(archive.counts).reduce((s, n) => s + n, 0));

  // Excluded stores must be ABSENT, not empty — an empty array would restore as
  // "clear the sessions", which is a decision this module says it does not make.
  for (const name of Object.keys(A.EXCLUDED_STORES)) {
    ok(`${name} is absent from the file`, !(name in archive.payload.stores));
  }
  ok("the exported file carries no session ciphertext",
    !Object.keys(archive.payload.local_slots).some((k) => k.startsWith("rri_enc_")),
    `found ${JSON.stringify(Object.keys(archive.payload.local_slots).filter((k) => k.startsWith("rri_enc_")))}`);
  eq("every setting was captured", Object.keys(SETTINGS).every((k) => k in archive.payload.local_slots), true);
  eq("import history was captured decrypted",
    JSON.stringify(A.decodeValue(archive.payload.secure_slots.rri_import_sessions)),
    JSON.stringify(IMPORT_SESSIONS));

  // Now destroy everything, the way a cleared site-data or a new laptop does.
  await wipe();
  const emptied = await localDb.Staff.count();
  eq("the database is empty before the restore", emptied, 0);
  eq("the settings are gone before the restore", localStorage.getItem("rri_cc_fee_rate"), null);

  // A fresh machine has an owner (Setup) before it can restore anything.
  await signInAsAllPropertyOwner();

  const parsed = await A.parseArchive(exportedText);
  eq("parse reports the row total", parsed.totalRows, archive.total_rows);
  eq("parse reports no missing stores", parsed.missingStores.length, 0);

  const result = await A.restoreArchive(parsed, { confirm: "REPLACE" });
  eq("restore reports the same row total", result.total_rows, archive.total_rows);
  eq("restore reports no warnings", result.warnings.length, 0, JSON.stringify(result.warnings));
  eq("restore asks the caller to re-authenticate", result.requiresReauth, true);

  // THE assertion this whole file exists for: table by table, row by row.
  let mismatches = 0;
  for (const t of localDb.tables) {
    if (Object.prototype.hasOwnProperty.call(A.EXCLUDED_STORES, t.name)) continue;
    const after = await t.toArray();
    const expected = before[t.name];
    const byKey = (rows) => [...rows].sort((x, y) => JSON.stringify(x.id ?? x.prefix).localeCompare(JSON.stringify(y.id ?? y.prefix)));
    const diff = deepEqual(byKey(expected), byKey(after), t.name);
    if (diff) mismatches += 1;
    ok(`${t.name} restored byte-for-byte (${expected.length} row(s))`, diff === null, diff || undefined);
  }
  eq("no table differs after the restore", mismatches, 0);

  // The unindexed columns are the point: a schema-derived exporter would have
  // dropped every one of these.
  const payroll = await localDb.PayrollRun.get(1);
  eq("an unindexed money field survives", payroll?.gross_cents, 1842300);
  eq("a nested array inside a row survives", JSON.stringify(payroll?.lines),
    JSON.stringify(FIXTURE.PayrollRun[0].lines));
  const expense = await localDb.Expense.get(1);
  ok("an explicitly-undefined field survives as a present key",
    Object.prototype.hasOwnProperty.call(expense || {}, "memo") && expense.memo === undefined,
    `keys: ${JSON.stringify(Object.keys(expense || {}))}`);
  const ledger = await localDb.ImportRecordIds.get(1);
  eq("the rollback ledger's id array survives", JSON.stringify(ledger?.record_ids), "[1,2]");

  // IdSequence is keyed on `prefix`, not `++id`. bulkPut has to honour that or
  // staff IDs start being reused — the exact defect item #1 fixed.
  const seq = await localDb.IdSequence.get("JOH");
  eq("IdSequence restores under its own inbound key", seq?.next, 2);
  eq("IdSequence did not gain rows", await localDb.IdSequence.count(), 2);

  // Settings and import history.
  for (const [k, v] of Object.entries(SETTINGS)) {
    eq(`setting "${k}" restored verbatim`, localStorage.getItem(k), v);
  }
  const { secureRetrieve } = await import("@/lib/securityUtils");
  eq("import history restored", JSON.stringify(await secureRetrieve("rri_import_sessions")),
    JSON.stringify(IMPORT_SESSIONS));

  // Replace, not merge: a setting this browser holds that the backup predates is
  // removed, so the result is the backup and not a blend of two machines.
  localStorage.setItem("rri_pricing_config", JSON.stringify({ stale: true }));
  const parsed2 = await A.parseArchive(exportedText);
  await A.restoreArchive(parsed2, { confirm: "REPLACE" });
  eq("a setting absent from the backup is removed, not kept", localStorage.getItem("rri_pricing_config"), null);

  // ...but a skipped key is never touched. Asserted against the REAL session
  // ciphertext the sign-in wrote, not a placeholder: the property that matters is
  // that the operator is still signed in after restoring, and a fake value here
  // would break the session rather than test it.
  const liveSession = localStorage.getItem("rri_enc_rr_local_session");
  ok("the harness is signed in with a real encrypted session",
    typeof liveSession === "string" && liveSession.length > 32,
    `session slot holds ${JSON.stringify(liveSession)?.slice(0, 40)}`);
  localStorage.setItem("rri_rate_limit_login", '{"requests":[1]}');
  const parsed3 = await A.parseArchive(exportedText);
  await A.restoreArchive(parsed3, { confirm: "REPLACE" });
  eq("the live session survives a restore", localStorage.getItem("rri_enc_rr_local_session"), liveSession);
  eq("rate-limit counters are left alone by a restore", localStorage.getItem("rri_rate_limit_login"), '{"requests":[1]}');
  const stillMe = await db.auth.me();
  ok("the operator is still signed in after a restore", !!stillMe,
    "db.auth.me() returned nothing — a restore signed the operator out of their own browser");
}

// ─── 5. Audit chain ──────────────────────────────────────────────────────────
console.log("\n5. The audit chain still verifies after a restore");
{
  // The hardest fidelity test available: every field of every audit row feeds an
  // HMAC over the previous row's hash, so a single changed character anywhere in
  // the table breaks verification. If this passes, the restore is faithful in a
  // way row counts cannot demonstrate.
  const rows = await localDb.AuditLog.toArray();
  ok("audit rows came back", rows.length >= 3, `${rows.length} rows`);
  const chain = await verifyAuditChain();
  ok("verifyAuditChain still passes on the restored table", chain?.valid !== false,
    `verifyAuditChain returned ${JSON.stringify(chain)}`);
  ok("the restored rows still carry their hashes",
    rows.every((r) => typeof r.hash === "string" && r.hash.length === 64),
    `hash lengths: ${JSON.stringify(rows.map((r) => r.hash?.length ?? null))}`);
}

// ─── 6. Refusals ─────────────────────────────────────────────────────────────
console.log("\n6. A damaged or foreign file is refused, never half-restored");
{
  const base = JSON.parse(exportedText);
  const reserialize = (mutate) => {
    const copy = JSON.parse(exportedText);
    mutate(copy);
    return JSON.stringify(copy);
  };

  await refuses("refuses an empty file", () => A.parseArchive(""), "empty");
  await refuses("refuses non-JSON", () => A.parseArchive("not json at all"), "not valid json");
  await refuses("refuses a JSON array", () => A.parseArchive("[1,2,3]"), "does not contain a backup");
  await refuses("refuses another app's JSON", () => A.parseArchive('{"hello":"world"}'), "not a hotel database backup");
  await refuses("refuses a newer format version",
    () => A.parseArchive(reserialize((c) => { c.format_version = A.ARCHIVE_FORMAT_VERSION + 1; })), "newer version");
  await refuses("refuses a different database",
    () => A.parseArchive(reserialize((c) => { c.database = "SomeOtherDb"; })), "different database");
  await refuses("refuses a file with no table data",
    () => A.parseArchive(reserialize((c) => { delete c.payload.stores; })), "no table data");

  // Checksum: one edited cent is enough.
  await refuses("refuses a tampered value (checksum)",
    () => A.parseArchive(reserialize((c) => { c.payload.stores.Expense[0].amount_cents = 1; })), "checksum");
  await refuses("refuses a truncated file (checksum)",
    () => A.parseArchive(reserialize((c) => { c.payload.stores.TransactionLine.pop(); })), "checksum");
  await refuses("refuses an edited setting (checksum)",
    () => A.parseArchive(reserialize((c) => { c.payload.local_slots.rri_cc_fee_rate = "0.99"; })), "checksum");

  // Count mismatch, with the checksum recomputed so it is the COUNT check that
  // fires — otherwise this test would pass for the wrong reason.
  const countTampered = JSON.parse(exportedText);
  countTampered.counts.Expense = 99;
  countTampered.checksum = await A.archiveChecksum(countTampered.payload);
  await refuses("refuses a declared count that does not match the rows",
    () => A.parseArchive(JSON.stringify(countTampered)), "row(s) but carries");

  // A store this build no longer has: the Transaction/ImportSession-era file.
  const oldStore = JSON.parse(exportedText);
  oldStore.payload.stores.Transaction = [{ id: 1, amount: 1 }];
  oldStore.counts.Transaction = 1;
  oldStore.checksum = await A.archiveChecksum(oldStore.payload);
  await refuses("refuses a file naming a dropped store",
    () => A.parseArchive(JSON.stringify(oldStore)), "no longer has");

  // A file carrying sessions.
  const withSessions = JSON.parse(exportedText);
  withSessions.payload.stores.LocalSession = [{ id: 1, user_id: "someone" }];
  withSessions.counts.LocalSession = 1;
  withSessions.checksum = await A.archiveChecksum(withSessions.payload);
  await refuses("refuses a file carrying session rows",
    () => A.parseArchive(JSON.stringify(withSessions)), "never supposed to carry");

  // A newer schema.
  const newerSchema = JSON.parse(exportedText);
  newerSchema.schema_version = localDb.verno + 5;
  newerSchema.checksum = await A.archiveChecksum(newerSchema.payload);
  await refuses("refuses a newer schema version",
    () => A.parseArchive(JSON.stringify(newerSchema)), "update the app");

  // Merge is refused by name, not silently treated as replace.
  const parsed = await A.parseArchive(exportedText);
  await refuses("refuses a restore without the REPLACE confirmation",
    () => A.restoreArchive(parsed), "cannot merge");
  await refuses("refuses a restore with the wrong confirmation",
    () => A.restoreArchive(parsed, { confirm: "MERGE" }), "cannot merge");

  // The file gate: .json only, and never the report importer's allowlist.
  eq("accepts a .json backup", A.inspectArchiveFile({ name: "hotel-backup.json", size: 1024 }).ok, true);
  eq("refuses a .csv as a backup", A.inspectArchiveFile({ name: "transactions.csv", size: 1024 }).ok, false);
  eq("refuses an .exe as a backup", A.inspectArchiveFile({ name: "payload.exe", size: 1024 }).ok, false);
  eq("refuses an empty file", A.inspectArchiveFile({ name: "b.json", size: 0 }).ok, false);
  eq("refuses a file past the size cap",
    A.inspectArchiveFile({ name: "b.json", size: A.ARCHIVE_MAX_BYTES + 1 }).ok, false);
  ok("the size refusal says what the limit is",
    /MB/.test(A.inspectArchiveFile({ name: "b.json", size: A.ARCHIVE_MAX_BYTES + 1 }).reason || ""));

  ok("the fixture archive is unchanged by all of this", base.checksum === JSON.parse(exportedText).checksum);
}

// ─── 7. Atomicity ────────────────────────────────────────────────────────────
console.log("\n7. A restore that fails leaves the existing database untouched");
{
  const staffBefore = await localDb.Staff.toArray();
  const propsBefore = await localDb.Property.toArray();
  ok("there is live data to protect", staffBefore.length > 0 && propsBefore.length > 0,
    `${staffBefore.length} staff, ${propsBefore.length} properties`);

  // Two properties with the same `code`, which carries a UNIQUE index. bulkPut
  // rejects, the transaction aborts, and every table in it must roll back —
  // including the ones already cleared and refilled before the failure.
  const bad = JSON.parse(exportedText);
  bad.payload.stores.Property = [
    { id: 10, code: "DUP", name: "One" },
    { id: 11, code: "DUP", name: "Two" },
  ];
  bad.counts.Property = 2;
  bad.payload.stores.Staff = [{ id: 99, employee_id: "ZZZ001", full_name: "Should not appear" }];
  bad.counts.Staff = 1;
  bad.checksum = await A.archiveChecksum(bad.payload);

  const parsedBad = await A.parseArchive(JSON.stringify(bad));
  let threw = false;
  // Dexie logs the rejected bulkPut's async stack through console before the
  // rejection reaches us — ~40 lines of trace for a failure this section
  // REQUIRES. Silenced for this one call only; the assertion below still fails if
  // the restore does not throw, so nothing is being hidden.
  const realError = console.error;
  const realWarn = console.warn;
  console.error = () => {};
  console.warn = () => {};
  try {
    await A.restoreArchive(parsedBad, { confirm: "REPLACE" });
  } catch {
    threw = true;
  } finally {
    console.error = realError;
    console.warn = realWarn;
  }
  ok("the restore failed loudly", threw);

  const staffAfter = await localDb.Staff.toArray();
  const propsAfter = await localDb.Property.toArray();
  const staffDiff = deepEqual(staffBefore, staffAfter, "Staff");
  const propDiff = deepEqual(propsBefore, propsAfter, "Property");
  ok("Staff is exactly as it was", staffDiff === null, staffDiff || undefined);
  ok("Property is exactly as it was", propDiff === null, propDiff || undefined);
  ok("the failed restore's rows are absent", !staffAfter.some((s) => s.employee_id === "ZZZ001"));
}

// ─── 8. Permission gate ──────────────────────────────────────────────────────
console.log("\n8. The gate fails closed");
{
  const parsed = await A.parseArchive(exportedText);

  // Signed out entirely.
  await db.auth.logout();
  const { invalidatePropertyAccess } = await import("@/api/base44Client");
  invalidatePropertyAccess?.();
  await refuses("a signed-out caller cannot export", () => A.buildArchive(), "owner or admin");
  await refuses("a signed-out caller cannot restore",
    () => A.restoreArchive(parsed, { confirm: "REPLACE" }), "owner or admin");

  // Signed in, but scoped to one property — the launch policy refuses this
  // account at login today, so this is defence in depth rather than a live path.
  await signInAsAllPropertyOwner();
  const owner = await db.auth.me();
  await localDb.User.update(owner.id, { role: "manager", property_access: ["1"] });
  invalidatePropertyAccess?.();
  await refuses("a single-property user cannot export a portfolio backup",
    () => A.buildArchive(), "every property");
  await localDb.User.update(owner.id, { role: "owner", property_access: "all" });
  invalidatePropertyAccess?.();
  const restored = await A.buildArchive();
  ok("an all-property owner can export again", restored.total_rows > 0, `${restored.total_rows} rows`);
}

// ─── 9. Cross-module invariants ──────────────────────────────────────────────
console.log("\n9. Invariants that live in another file");
{
  // (a) The import-session key is duplicated on purpose (base44Client keeps its
  // copy module-private). A rename there must fail HERE, not silently archive an
  // empty slot for the rest of the app's life.
  const clientSrc = read("src/api/base44Client.js");
  const m = clientSrc.match(/const\s+IMPORT_SESSION_KEY\s*=\s*['"]([^'"]+)['"]/);
  ok("base44Client still declares IMPORT_SESSION_KEY", !!m, "declaration not found");
  eq("dbArchive's copy of the key matches base44Client's", A.SECURE_SLOT_KEYS[0], m ? m[1] : null);
  eq("there is exactly one secure slot", A.SECURE_SLOT_KEYS.length, 1);

  // (b) The report importer's allowlist must NOT have been widened to admit the
  // backup file. Widening it there would open the CSV door to .json.
  const guardSrc = read("src/lib/uploadGuard.js");
  const allow = guardSrc.match(/ALLOWED_EXT\s*=\s*(\/[^\n]+\/[a-z]*)/);
  ok("uploadGuard still declares ALLOWED_EXT", !!allow, "declaration not found");
  ok("the report upload gate still admits only csv/xlsx/xls",
    !!allow && allow[1] === "/\\.(csv|xlsx|xls)$/i", `found ${allow ? allow[1] : "nothing"}`);
  ok("the report upload gate does not mention json", !!allow && !/json/i.test(allow[1]));

  // (c) One download implementation, shared. Two copies means one of them will
  // be missing the Firefox attach or the deferred revoke.
  const exportSrc = read("src/lib/exportData.js");
  eq("exportData exports downloadBlob", /export function downloadBlob\(/.test(exportSrc), true);
  eq("exportData creates exactly one object URL",
    (exportSrc.match(/URL\.createObjectURL/g) || []).length, 1);
  ok("the shared helper still attaches the anchor (Firefox)", /document\.body\.appendChild\(a\)/.test(exportSrc));
  ok("the shared helper still defers the revoke", /setTimeout\(\(\) => \{\s*\n?\s*URL\.revokeObjectURL/.test(exportSrc));
  const archiveSrc = read("src/lib/dbArchive.js");
  ok("dbArchive downloads through the shared helper", /downloadBlob\(/.test(archiveSrc));
  eq("dbArchive has no download logic of its own",
    (archiveSrc.match(/URL\.createObjectURL/g) || []).length, 0);

  // (d) THE STALENESS GUARD. Settings that never lived in Dexie are the part of
  // this backup most likely to rot: a new module writes a new localStorage key,
  // nobody thinks about backups, and the key is silently absent from every
  // archive from then on. Every file in src/ that writes web storage is listed
  // here with a decision. A new writer fails this suite until it is classified.
  const MANIFEST = {
    "src/lib/alertThresholds.js": "archived — rri_alert_thresholds",
    "src/lib/commissionRates.js": "archived — rri_commission_rates_v2, rri_cc_fee_rate, rri_cc_fee_refunds_v1",
    "src/lib/exportData.js": "archived — rri_filters_<page>",
    "src/lib/housekeepingConfig.js": "archived — rri_housekeeping_config_<propertyId>",
    "src/lib/pricingSettings.js": "archived — rri_pricing_config",
    "src/lib/revenueThresholds.js": "archived — rri_revenue_thresholds",
    "src/lib/taxConfig.js": "archived — rri_tax_config_v1",
    "src/lib/taxSettings.js": "archived — rri_tax_settings_v1",
    "src/lib/weatherSettings.js": "archived — rri_weather_config",
    "src/pages/DataIntelligence.jsx": "archived — rri_automationRules, rri_reportHistory",
    "src/pages/ManualEntry.jsx": "archived — manual_draft_<propertyId>_<reportType>",
    "src/lib/dbArchive.js": "the restore writer itself",
    "src/lib/securityUtils.js": "skipped — rri_rate_limit_* counters, rri_enc_* ciphertext, _rri_test_ probe, rri_csrf_token (sessionStorage)",
    "src/lib/realtime.js": "skipped — rri_realtime_change, a cross-tab ping",
    "src/lib/sessionChannel.js": "skipped — rri_session_revocation, a cross-tab signal",
    "src/lib/auditFailureLog.js": "skipped — rri_audit_write_failures_v1, machine-local diagnostics",
    "src/crdt.jsx": "skipped — __yjs_* CRDT snapshots, derived state that could resurrect deleted rows",
    "src/lib/app-params.js": "skipped — dead module (no importers) writing a URL param cache",
    "src/components/Layout.jsx": "not localStorage — rri_tab_history in sessionStorage, transient",
    "src/pages/Setup.jsx": "not localStorage — setup_attempts in sessionStorage, transient",
  };
  const writers = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (/\.(js|jsx)$/.test(entry.name) && read(rel).includes(".setItem(")) writers.push(rel);
    }
  };
  walk("src");
  const unclassified = writers.filter((f) => !(f in MANIFEST));
  ok("every file in src/ that writes web storage is classified for backup",
    unclassified.length === 0,
    `unclassified writer(s): ${JSON.stringify(unclassified)} — decide whether each key belongs ` +
      `in a backup, then add it to MANIFEST in this probe`);
  const gone = Object.keys(MANIFEST).filter((f) => !writers.includes(f));
  ok("the manifest names no file that stopped writing storage", gone.length === 0,
    `stale manifest entries: ${JSON.stringify(gone)}`);
  ok("the manifest is not vacuous", writers.length >= 15, `found only ${writers.length} writers`);
  console.log(`        storage writers classified: ${writers.length}`);
}

console.log(`\n${"─".repeat(70)}`);
if (failures.length) {
  console.log("Failures:");
  failures.forEach((f) => console.log(`  • ${f}`));
}
console.log(`PASS ${pass}   FAIL ${fail}`);
console.log(`\n${fail === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
