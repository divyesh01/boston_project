// Probe for "property isolation fails open and skips half the data layer"
// (B1, B2, B3, B4).
//
// Three separate defects compose into a live cross-property leak that needs no
// adversarial behaviour at all:
//
//   B3 src/api/base44Client.js:445-459 — resolvePropertyAccessUncached() returns
//      `null` on THREE failure paths (no user, property_access unset, any thrown
//      error), and `null` is the value applyPropertyFilter treats as "apply no
//      filter". Unauthenticated, misconfigured and broken all silently escalate
//      to full-portfolio scope. Failing open is the wrong direction for a
//      control whose whole job is to say no.
//
//   B2 PROPERTY_TABLES omits `Property`, so Property.list() hands the entire
//      roster (names, codes, room counts) to every account.
//
//   B4 PROPERTY_TABLES also omits DailyFinancialAggregate, ScanResult,
//      TimecardPunch, Reservation, RoomType and ChannelMap — tables that all
//      carry property_id. Rows in them are readable and writable across
//      properties even when the proxy is used correctly.
//
//   B1 getDailyAggregates() (src/lib/dailyAggregates.js) reads the raw Dexie
//      table, so `propertyId: 'all'` means every property on earth rather than
//      every property the caller may see — and the Dashboard PREFERS that
//      source over the proxy-clamped ledgers.
//
// Scope of the fix (the user's decision): launch is restricted to accounts
// authorised for all properties, AND these client-side controls are repaired as
// defence-in-depth. B5 — that Dexie in the user's own browser is the only entity
// store, so none of this is a server-side boundary — stays open by decision.
// That is exactly why the checks below still matter: they are what stands
// between a restricted account and the whole portfolio if the launch gate is
// ever loosened, and they must not be quietly reintroduced.
//
// Run: node --import ./scripts/_loader-boot.mjs scripts/probe-property-isolation.mjs

await import("fake-indexeddb/auto");
globalThis.crypto ??= (await import("node:crypto")).webcrypto;

const __store = new Map();
const __storage = {
  getItem: (k) => (__store.has(k) ? __store.get(k) : null),
  setItem: (k, v) => __store.set(k, String(v)),
  removeItem: (k) => __store.delete(k),
  clear: () => __store.clear(),
};
globalThis.localStorage = __storage;
globalThis.sessionStorage = __storage;
globalThis.window = globalThis;
if (globalThis.navigator === undefined) {
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: "harness", language: "en-US" },
    configurable: true,
  });
}

let pass = 0;
let fail = 0;
const T = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`); }
};

const localDb = (await import("@/api/localDb")).default;
const { db, invalidatePropertyAccess, browserHashPassword } = await import("@/api/base44Client");
const { getDailyAggregates } = await import("@/lib/dailyAggregates");
const { secureStore } = await import("@/lib/securityUtils");

const A = "prop_a";
const B = "prop_b";
const PASSWORD = "Probe-Password-9!";
const SALT = "0123456789abcdef0123456789abcdef";

// The client stores its offline session under this key via secureStore (AES-GCM
// into localStorage). It is module-private in base44Client.js, so the literal is
// repeated here; §1 asserts the impersonation actually took effect, which is what
// catches it if the key ever changes. See sessionAs() for why direct
// impersonation is necessary rather than calling db.auth.login().
const LOCAL_SESSION_KEY = "rr_local_session";

const USERS = [
  { id: "u_owner", username: "owner1", email: "owner@probe.local", role: "owner", property_access: "all" },
  // A one-property clerk: the account the leak was found with.
  { id: "u_clerk_a", username: "clerk_a", email: "clerk_a@probe.local", role: "manager", property_access: [A] },
  // property_access never set. Created by any code path that forgets the field —
  // and today the most dangerous account in the system, because "unset" reads as
  // "unrestricted".
  { id: "u_unset", username: "unset1", email: "unset@probe.local", role: "manager" },
  // property_access holding NUMBERS while property_id columns hold strings.
  // Dexie's ++id generates numbers and Users.jsx stores p.id raw, so this shape
  // is reachable in production. A type mismatch must fail closed.
  { id: "u_numeric", username: "numeric1", email: "numeric@probe.local", role: "manager", property_access: [1, 2] },
];

async function seed() {
  for (const t of localDb.tables) await t.clear();

  await localDb.Property.bulkAdd([
    { id: A, code: "AAA", name: "Alpha Inn", rooms: 40, active: true },
    { id: B, code: "BBB", name: "Bravo Lodge", rooms: 60, active: true },
  ]);

  const hash = "$pbkdf2$" + (await browserHashPassword(PASSWORD, SALT));
  await localDb.User.bulkAdd(
    USERS.map((u) => ({
      ...u,
      full_name: u.username,
      is_active: true,
      is_locked: false,
      mfa_enabled: false,
      failed_login_count: 0,
      salt: SALT,
      password_hash: hash,
      created_date: new Date().toISOString(),
    })),
  );

  for (const pid of [A, B]) {
    await localDb.TransactionLine.bulkAdd([
      { property_id: pid, date: "2026-01-05", username: "clerk", transaction_code: "RM", transaction_type: "CHARGE", amount: 100, folio_number: `${pid}-1` },
      { property_id: pid, date: "2026-01-06", username: "clerk", transaction_code: "RM", transaction_type: "CHARGE", amount: 200, folio_number: `${pid}-2` },
    ]);
    await localDb.OccupancyDay.add({ property_id: pid, date: "2026-01-05", rooms_sold: 10, total_rooms: 40, total_revenue: 1000 });
    await localDb.HotelMetric.add({ property_id: pid, business_date: "2026-01-05", section: "Revenue", metric_name: "YTD Revenue", period: "ytd", value: 5000 });
    await localDb.UploadedReport.add({ property_id: pid, file_name: `${pid}.csv`, uploaded_at: "2026-01-05T00:00:00.000Z" });
    // Tables that carry property_id but are absent from PROPERTY_TABLES today.
    await localDb.DailyFinancialAggregate.add({ property_id: pid, business_date: "2026-01-05", occ_revenue: 1000, payment_total: 900 });
    await localDb.ScanResult.add({ property_id: pid, file_id: `${pid}-f1`, scanned_at: "2026-01-05T00:00:00.000Z", health_score: 90 });
    await localDb.TimecardPunch.add({ property_id: pid, employee_name: "Someone", shift_date: "2026-01-05" });
    await localDb.Reservation.add({ property_id: pid, channel: "Direct", confirmation_num: `${pid}-C1`, check_in: "2026-01-05", check_out: "2026-01-06", status: "booked" });
    await localDb.RoomType.add({ property_id: pid, name: "King", total_inventory: 10 });
    await localDb.ChannelMap.add({ property_id: pid, channel_name: "Expedia", local_room_id: "K", remote_room_id: "EXP-K" });
  }
}

/**
 * Establish an offline session for a user id WITHOUT going through
 * db.auth.login().
 *
 * Deliberate: the launch gate added for B5 refuses exactly these restricted
 * accounts at login (§7 asserts that). The isolation checks are defence in depth
 * for the state the gate is meant to prevent, so they have to be able to reach
 * that state. Writing the session record the same way handleLocalAuthLogin does
 * is the smallest way to do it without weakening the gate to test around it.
 *
 * If this ever silently stops working, every isolation check below would go
 * green for the wrong reason — an unauthenticated caller sees zero rows once the
 * fail-closed change lands, which looks identical to perfect isolation. That is
 * why each call is followed by a hard assertion that the session is live.
 */
async function sessionAs(userId, label) {
  await secureStore(
    LOCAL_SESSION_KEY,
    JSON.stringify({ userId, expiresAt: new Date(Date.now() + 3600e3).toISOString() }),
  );
  invalidatePropertyAccess();
  const me = await db.auth.me();
  T(`session is live as ${label} (guards against a vacuous pass below)`,
    !!me && me.id === userId, `auth.me() => ${JSON.stringify(me && { id: me.id, role: me.role })}`);
  return me;
}

async function signOut() {
  await db.auth.logout();
  invalidatePropertyAccess();
}

const ids = (rows) => rows.map((r) => r.property_id ?? r.id).sort().join(",");
const threw = async (fn) => {
  try { await fn(); return null; } catch (e) { return e.message || String(e); }
};

await seed();

// ── 1. Owner baseline ───────────────────────────────────────────────────────
// Every verify suite in scripts/ reads through this proxy, so an over-tight fix
// would show up here first. An all-property account must keep seeing everything.
console.log("\n=== 1. An all-property account still sees every property ===");
await sessionAs("u_owner", "owner");
let rows = await db.entities.TransactionLine.filter({});
T("owner sees both properties' transactions", ids(rows) === `${A},${A},${B},${B}`, ids(rows));
rows = await db.entities.Property.list();
T("owner sees the whole property roster", ids(rows) === `${A},${B}`, ids(rows));
rows = await getDailyAggregates({ propertyId: "all" });
T("owner sees every daily aggregate", ids(rows) === `${A},${B}`, ids(rows));
rows = await db.entities.DailyFinancialAggregate.filter({});
T("owner reads aggregates through the proxy too", ids(rows) === `${A},${B}`, ids(rows));

// ── 2. The proxy-covered tables (the part that already worked) ───────────────
console.log("\n=== 2. A one-property clerk, on tables the proxy knows about ===");
await sessionAs("u_clerk_a", "clerk_a");
rows = await db.entities.TransactionLine.filter({});
T("transactions are scoped to the clerk's property", ids(rows) === `${A},${A}`, ids(rows));
rows = await db.entities.HotelMetric.list();
T("statistics are scoped", ids(rows) === A, ids(rows));
T("a cross-property write is refused",
  (await threw(() => db.entities.TransactionLine.create({ property_id: B, date: "2026-02-01", amount: 1 }))) !== null);

// ── 3. B2: the property roster ──────────────────────────────────────────────
console.log("\n=== 3. The property roster (B2) ===");
rows = await db.entities.Property.list();
T("the clerk sees only their own property in the roster", ids(rows) === A,
  `${ids(rows)}  — names leaked: ${rows.map((r) => r.name).join(", ")}`);
rows = await db.entities.Property.filter({});
T("filter() scopes the roster as well as list()", ids(rows) === A, ids(rows));
T("get() on another property's record is denied", (await db.entities.Property.get(B)) === null,
  JSON.stringify(await db.entities.Property.get(B)));
T("the clerk's own property is still readable", (await db.entities.Property.get(A))?.id === A);
T("a restricted account cannot add a property to the roster",
  (await threw(() => db.entities.Property.create({ code: "CCC", name: "Charlie" }))) !== null);
T("a restricted account cannot rename another property",
  (await threw(() => db.entities.Property.update(B, { name: "seized" }))) !== null);
T("a restricted account cannot delete another property",
  (await threw(() => db.entities.Property.delete(B))) !== null);

// ── 4. B4: every table that carries property_id, derived not enumerated ──────
// Re-seed first. The three mutation checks above are destructive when they fail:
// Property.delete() cascades into every enrolled table, so prop_b's ledger rows
// disappear and every later section would compare against a fixture that no
// longer has a second property in it — reporting isolation that is really just
// an empty database.
//
// This section used to name the six tables that leaked on 2026-08-15
// (DailyFinancialAggregate, ScanResult, TimecardPunch, Reservation, RoomType,
// ChannelMap). A hand-written list only ever tests the tables somebody remembered
// to add to it, which is the same failure that produced those six: the rule
// "if the schema line contains property_id, enrol it" was written down in
// base44Client.js and then not applied to the next table anyone created.
//
// So the list is derived from Dexie's LIVE schema instead — localDb.tables, with
// each table's real index metadata — and every table it yields is exercised
// against a two-property fixture. A table added to localDb.js next year is
// covered the day it appears, with no edit here.
//
// Deriving from the live schema rather than parsing PROPERTY_TABLES out of the
// source is deliberate twice over. It cannot be fooled by that set being renamed
// or moved, and it tests the observable behaviour (does this clerk see prop_b's
// rows?) rather than set membership, which is the thing that actually matters.
console.log("\n=== 4. Tables missing from PROPERTY_TABLES (B4) ===");
await seed();

// A table is in scope for this check when Dexie indexes property_id on it,
// either directly or as part of a compound index.
const indexesPropertyId = (table) =>
  table.schema.indexes.some((idx) =>
    Array.isArray(idx.keyPath) ? idx.keyPath.includes("property_id") : idx.keyPath === "property_id",
  );

// The one documented exemption. ImportRecordIds carries property_id, but it is
// the rollback ledger — a list of Dexie primary keys per import — and it is
// reached exclusively through `localDb.ImportRecordIds` (raw Dexie), never
// through the entity proxy. PROPERTY_TABLES only governs createEntityProxy, so
// enrolling it would change nothing at all today while looking like a fix.
//
// What actually protects it is one layer down: rollbackImportSession() deletes
// through `entities[row.entity]`, the scoped proxy, which throws on the first id
// belonging to a property the caller may not touch. Section 4b proves that, and
// pins the assumption the exemption rests on — that nothing reads the ledger
// through the proxy.
const LEDGER_EXEMPT = new Set(["ImportRecordIds"]);

const carriers = localDb.tables.filter(indexesPropertyId).map((t) => t.name).sort();
T("the live schema still has property_id tables to check (guards a vacuous loop)",
  carriers.length >= 24, `derived ${carriers.length}: ${carriers.join(", ")}`);

const enrolled = carriers.filter((n) => !LEDGER_EXEMPT.has(n));
for (const name of LEDGER_EXEMPT) {
  T(`${name} is a known exemption, and still exists to be exempted`,
    carriers.includes(name),
    `not found among property_id carriers — if it was renamed or dropped, remove it from LEDGER_EXEMPT rather than leaving a dead entry that hides a real table`);
}

// Give every derived table one row per property, so no assertion below can pass
// just because a table happened to be empty.
for (const name of enrolled) {
  await localDb[name].add({ property_id: A, date: "2026-03-01", business_date: "2026-03-01", probe_marker: true });
  await localDb[name].add({ property_id: B, date: "2026-03-01", business_date: "2026-03-01", probe_marker: true });
}

await sessionAs("u_clerk_a", "clerk_a");
for (const name of enrolled) {
  const planted = await localDb[name].where("property_id").equals(B).count();
  const seen = await db.entities[name].filter({});
  const leaked = seen.filter((r) => String(r.property_id) === B);
  T(`${name} is scoped to the clerk's property`,
    planted > 0 && seen.length > 0 && leaked.length === 0,
    `prop_b rows present in the raw table: ${planted}; rows returned: ${seen.length}; of another property: ${leaked.length}. ` +
      `If this table is new, add it to PROPERTY_TABLES in src/api/base44Client.js — a table missing from that set is readable and writable across every property even by code that uses the proxy correctly.`);
}

// Writes, not just reads. A scoped read that still permits a cross-property
// create leaks in the other direction: rows planted under a property the caller
// cannot see, which then feed the aggregates everyone else reads.
for (const name of ["DailyFinancialAggregate", "ScanResult", "TransactionLine"]) {
  T(`a cross-property write to ${name} is refused`,
    (await threw(() => db.entities[name].create({ property_id: B, date: "2026-02-01", business_date: "2026-02-01" }))) !== null,
    "create() must reject a property_id outside the caller's access rather than storing it");
}

// ── 4b. The rollback ledger exemption, and the negative case behind it ───────
// The ledger names raw Dexie primary keys, so anything that consumes it is one
// unscoped delete away from reaching across properties. Two things are asserted:
// that the exemption's premise still holds (nothing reads the ledger through the
// proxy), and that an undo requested by the wrong account fails instead of
// deleting another property's rows.
console.log("\n=== 4b. The rollback ledger stays out of reach (B4) ===");

const { readFileSync, readdirSync, statSync } = await import("node:fs");
const nodePath = await import("node:path");
const SRC = nodePath.resolve(process.cwd(), "src");
const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir)) {
    const full = nodePath.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(js|jsx|ts|tsx)$/.test(entry) && !/\.test\./.test(entry)) out.push(full);
  }
  return out;
};

const proxyReaders = [];
for (const file of walk(SRC)) {
  const body = readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  if (/\b(?:db|entities)\s*(?:\.entities)?\s*\.\s*ImportRecordIds\b/.test(body)) {
    proxyReaders.push(nodePath.relative(process.cwd(), file));
  }
}
T("nothing reaches the rollback ledger through the entity proxy",
  proxyReaders.length === 0,
  `${proxyReaders.join(", ")}\n          The exemption above holds only while the ledger is raw-Dexie-only. Reading it through db.entities gives an UNSCOPED proxy, because ImportRecordIds is deliberately absent from PROPERTY_TABLES. If this access is intended, enrol the table there first.`);

// A real import belonging to prop_b, undone by an account that may only see
// prop_a. The ledger row is visible to that caller (it is unscoped, by design),
// so the only thing standing between them and prop_b's rows is the proxy inside
// rollbackImportSession.
await seed();
const { rollbackImportSession, addImportRecordIds, createImportSession, completeImportSession } =
  await import("@/api/base44Client");

await sessionAs("u_owner", "owner");
const bRows = await localDb.TransactionLine.where("property_id").equals(B).primaryKeys();
T("the prop_b import fixture has rows to protect", bRows.length > 0, `ids: ${bRows.join(",")}`);
const session = await createImportSession("probe-b-import.csv", "TransactionLine", bRows.length);
const importId = session.importId ?? session.import_id ?? session;
await addImportRecordIds(importId, "TransactionLine", bRows, B);
await completeImportSession(importId, bRows.length);

await sessionAs("u_clerk_a", "clerk_a");
const undoErr = await threw(() => rollbackImportSession(importId));
const survived = await localDb.TransactionLine.where("property_id").equals(B).count();
T("a clerk cannot undo another property's import",
  undoErr !== null || survived === bRows.length,
  `rollback threw: ${JSON.stringify(undoErr)}; prop_b rows remaining: ${survived} of ${bRows.length}`);
T("...and prop_b's rows are all still there",
  survived === bRows.length,
  `${survived} of ${bRows.length} remain — a partial delete is worse than a refusal, because the import history now disagrees with the data`);

// Positive control: the refusal above must be about property access, not a
// rollback path that is simply broken for everyone.
await sessionAs("u_owner", "owner");
const ownerUndo = await rollbackImportSession(importId);
const afterOwner = await localDb.TransactionLine.where("property_id").equals(B).count();
T("an all-property account CAN undo the same import (the refusal was about scope)",
  ownerUndo?.success === true && afterOwner === 0,
  `result: ${JSON.stringify(ownerUndo)}; prop_b rows remaining: ${afterOwner}`);

// ── 5. B1: the Dashboard's preferred read path ──────────────────────────────
// This is the one that renders in production: rebuildDailyAggregates runs on
// every import, and Dashboard.jsx prefers the aggregate cache over the ledgers.
console.log("\n=== 5. getDailyAggregates with propertyId 'all' (B1) ===");
await seed();
await sessionAs("u_clerk_a", "clerk_a");
rows = await getDailyAggregates({ propertyId: "all" });
T("'all' means all ACCESSIBLE, not all existing", ids(rows) === A, ids(rows));
rows = await getDailyAggregates({});
T("the default scope is also clamped", ids(rows) === A, ids(rows));
rows = await getDailyAggregates({ propertyId: B });
T("asking for another property by name returns nothing", rows.length === 0, ids(rows));
rows = await getDailyAggregates({ propertyId: [A, B] });
T("an explicit list is intersected, not trusted", ids(rows) === A, ids(rows));

// ── 6. B3: the three fail-open paths ────────────────────────────────────────
console.log("\n=== 6. Failure must deny, not escalate (B3) ===");
await seed();
await sessionAs("u_unset", "a user whose property_access was never set");
rows = await db.entities.TransactionLine.filter({});
T("an unset property_access grants nothing, not everything", rows.length === 0, ids(rows));
rows = await db.entities.Property.list();
T("...and no roster either", rows.length === 0, ids(rows));
rows = await getDailyAggregates({ propertyId: "all" });
T("...and no aggregates", rows.length === 0, ids(rows));

await sessionAs("u_numeric", "a user whose property_access holds numbers");
rows = await db.entities.TransactionLine.filter({});
T("a number/string type mismatch fails closed", rows.length === 0, ids(rows));

await signOut();
const me = await db.auth.me();
T("the session really is gone", !me, JSON.stringify(me));
rows = await db.entities.TransactionLine.filter({});
T("a signed-out caller reads no transactions", rows.length === 0, ids(rows));
rows = await db.entities.Property.list();
T("a signed-out caller reads no properties", rows.length === 0, ids(rows));
rows = await getDailyAggregates({ propertyId: "all" });
T("a signed-out caller reads no aggregates", rows.length === 0, ids(rows));

// ── 7. The launch gate ──────────────────────────────────────────────────────
// B5 is accepted rather than fixed: every control above runs in the user's own
// browser, so a determined staff member with devtools can still reach any row.
// The gate is what makes that acceptable — only accounts already entitled to all
// properties can sign in, so there is no confidentiality boundary left to break.
// (base44/functions/custom_auth_login enforces the same rule server-side;
// scripts/probe-auth-audit.mjs covers that copy.)
console.log("\n=== 7. Only all-property accounts can sign in ===");
await seed();
await signOut();
let err = await threw(() => db.auth.login("clerk_a@probe.local", PASSWORD));
T("a one-property account is refused at login", err !== null, `login returned without throwing`);
T("the refusal explains itself", err !== null && /propert/i.test(err), err || "");
T("no session was created for the refused account", !(await db.auth.me()));

err = await threw(() => db.auth.login("unset@probe.local", PASSWORD));
T("an account with no property_access is refused", err !== null, "login returned without throwing");

err = await threw(() => db.auth.login("owner@probe.local", PASSWORD));
T("an all-property owner can still sign in", err === null, err || "");
invalidatePropertyAccess();
T("...and the session works", (await db.auth.me())?.id === "u_owner");
rows = await db.entities.TransactionLine.filter({});
T("...and sees the whole portfolio", ids(rows) === `${A},${A},${B},${B}`, ids(rows));

console.log(`\n${fail === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
