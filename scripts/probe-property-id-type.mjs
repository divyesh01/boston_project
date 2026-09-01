// PROBE: `property_id` is written as a Dexie autoincrement NUMBER but the
// Property cascade-delete queries it as a STRING, so deleting a property
// orphans every row that belonged to it instead of removing them.
//
// THE TWO REPRESENTATIONS, and where each one comes from:
//
//   NUMBER  localDb.js declares `Property: '++id, &code, name, active,
//           created_date'`. Dexie's `++id` mints integer primary keys. Every
//           writer stamps the property id it was handed by the roster UI, and
//           the roster UI hands over `p.id` verbatim — Import.jsx builds
//           `propertyOpts` as `properties.map((p) => [p.id, p.name])` and
//           stamps `property_id: propertyId`; Users.jsx pushes `p.id` into
//           `property_ids` and stores that array as `property_access`. Nothing
//           on that path calls String(). So the stored column is a Number.
//
//   STRING  Every base44/entities/*.jsonc that declares the column declares
//           `"property_id": { "type": "string" }`. String-keyed legacy/custom
//           properties must therefore keep working without coercing numeric ids:
//
//               const propIds = await propertyCascadeIds([deletedRecord]);
//               localDb[related].where('property_id').anyOf(propIds).primaryKeys()
//
//           IndexedDB keys are typed. `"1"` and `1` are different keys, and a
//           `where({property_id: "1"})` equality lookup against a column
//           holding `1` matches nothing. `.primaryKeys()` returns `[]`, the
//           `if (keys.length > 0)` guard skips the bulkDelete, and the cascade
//           completes silently having deleted nothing.
//
// WHY THAT IS DATA CORRUPTION AND NOT A COSMETIC LEFTOVER. The Property row is
// deleted, so the id can never be re-selected in the roster and no scoped read
// will ever name it again. The orphaned ledger rows are simultaneously
// unreachable through the property filter and still counted by anything that
// scans a table without a property condition. Portfolio totals keep the deleted
// hotel's revenue forever while the hotel itself no longer exists, and Dexie's
// `++id` will eventually reissue the freed primary key to a NEW property, which
// then adopts the dead hotel's entire ledger.
//
// The compatibility helper may add an alternate numeric/string representation
// only when no separate cross-type Property row owns it.
//
// WHAT THIS PROBE PROVES, in order:
//   1. the schema files really do declare `string` (and which tables have no
//      declaration at all)
//   2. the Dexie primary key really is autoincrement, so ids really are Numbers
//   3. what `typeof property_id` actually is once a row is written
//   4. the cascade is a NO-OP for Number-keyed rows  <- the defect
//   5. the same cascade DOES work for String-keyed rows  <- proves the cause is
//      the representation mismatch and not a broken cascade
//   6. bulkDelete has the same hole
//   7. a legitimate all-of-these-properties grant is refused when the two sides
//      disagree on representation (fail-closed lockout, not a leak)
//
// Sections 4 and 6 were the failing-first evidence. They go green only when the
// cascade preserves the stored id representation and unrelated rows survive.
//
// Run: node --import ./scripts/_loader-boot.mjs scripts/probe-property-id-type.mjs

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

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..");

const localDb = (await import("@/api/localDb")).default;
const { db, invalidatePropertyAccess, browserHashPassword } = await import("@/api/base44Client");
const { signInAsAllPropertyOwner } = await import("./_harness-auth.mjs");

let pass = 0;
let fail = 0;
const failures = [];

function ok(label, cond, detail = "") {
  if (cond) {
    pass += 1;
    console.log(`  ok   ${label}`);
  } else {
    fail += 1;
    failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
const eq = (label, actual, expected) =>
  ok(label, actual === expected, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);

console.log("--- PROBE: property_id REPRESENTATION vs THE PROPERTY CASCADE ---");

// The tables the cascade actually walks. Parsed out of the live source rather
// than copied, because PROPERTY_TABLES is a module-private const inside
// createEntityProxy and a hand-copied list would silently stop matching it.
const clientSrc = fs.readFileSync(path.join(REPO, "src/api/base44Client.js"), "utf8");
const cascadeTables = (() => {
  const m = clientSrc.match(/const PROPERTY_TABLES = new Set\(\[([\s\S]*?)\]\);/);
  if (!m) return [];
  return [...m[1].matchAll(/'([A-Za-z]+)'/g)].map((x) => x[1]);
})();

// ── 1. What the committed schema files claim ────────────────────────────────
console.log("\n[1] the declared type of property_id in base44/entities/*.jsonc");
{
  const dir = path.join(REPO, "base44", "entities");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonc"));
  const declared = [];
  const nonString = [];

  for (const f of files) {
    const raw = fs.readFileSync(path.join(dir, f), "utf8");
    // The top-level property block only: `"property_id": {\n "type": "..." }`.
    // The RLS rules further down use the "data.property_id" spelling and are not
    // type declarations, so the dot-prefixed form is deliberately not matched.
    const m = raw.match(/(?<!data\.)"property_id"\s*:\s*\{\s*"type"\s*:\s*"([a-z]+)"/);
    if (!m) continue;
    declared.push([f, m[1]]);
    if (m[1] !== "string") nonString.push(`${f} => ${m[1]}`);
  }

  ok("the scan found schema files declaring property_id (not vacuous)",
    declared.length >= 10, `found ${declared.length} of ${files.length} entity files`);
  ok("EVERY declaration that exists says \"string\"", nonString.length === 0,
    nonString.length ? nonString.join(", ") : "");
  console.log(`        declared as string: ${declared.map(([f]) => f.replace(".jsonc", "")).join(", ")}`);

  // The other half of the schema story, and it is worse than a wrong type: most
  // of the tables the cascade walks have no committed declaration at all, so a
  // D1 migration generated from base44/entities/ would not create them.
  const undeclaredSet = new Set(declared.map(([f]) => f.replace(".jsonc", "")));
  const missing = cascadeTables.filter((t) => !undeclaredSet.has(t));
  ok("the cascade table list was parsed out of base44Client.js",
    cascadeTables.length >= 20, `parsed ${cascadeTables.length}`);
  console.log(`        cascade walks ${cascadeTables.length} tables; ${missing.length} of them have NO entity schema file:`);
  console.log(`        ${missing.join(", ")}`);
}

// ── 2. What Dexie actually mints for a Property primary key ─────────────────
console.log("\n[2] the live Dexie schema for Property");
{
  const primKey = localDb.Property.schema.primKey;
  eq("Property's primary key is named 'id'", primKey.keyPath, "id");
  ok("Property's primary key is AUTOINCREMENT (++id), so ids are Numbers",
    primKey.auto === true, `primKey.auto = ${JSON.stringify(primKey.auto)}`);
  ok("code carries a uniqueness constraint (&code) — the only cross-device stable key",
    localDb.Property.schema.indexes.some((i) => i.keyPath === "code" && i.unique === true),
    localDb.Property.schema.indexes.map((i) => `${i.keyPath}${i.unique ? "(&)" : ""}`).join(", "));
}

// ── 3. typeof property_id as actually stored, per writer ────────────────────
//
// Reported, not assumed. The chain that decides the type is: Property.create()
// mints the id -> the roster UI hands `p.id` on unchanged -> the writer stamps
// it. Section 3 measures the first link at runtime and section 3b pins the
// "unchanged" claim about the second link statically, because the React layer
// cannot be driven from a Node harness.
console.log("\n[3] typeof the id a real Property.create() mints");
let NUM_PROP_ID;
{
  for (const t of localDb.tables) await t.clear();
  __store.clear();
  await signInAsAllPropertyOwner();

  const created = await db.entities.Property.create({
    code: "TYP", name: "Typecheck Inn", rooms: 10, active: true,
  });
  NUM_PROP_ID = created.id;
  eq("Property.create() returns a numeric id", typeof NUM_PROP_ID, "number");
  console.log(`        Property.create() => id = ${JSON.stringify(NUM_PROP_ID)} (${typeof NUM_PROP_ID})`);

  // A scoped write through the proxy preserves whatever it is given.
  const line = await db.entities.TransactionLine.create({
    property_id: NUM_PROP_ID, date: "2026-01-05", username: "clerk",
    transaction_code: "RM", transaction_type: "CHARGE", amount: 100, folio_number: "F1",
  });
  const stored = await localDb.TransactionLine.get(line.id);
  eq("a row written with the minted id stores it as a Number", typeof stored.property_id, "number");
}

console.log("\n[3b] the roster UI passes Property.id on without coercion");
{
  const importSrc = fs.readFileSync(path.join(REPO, "src/pages/Import.jsx"), "utf8");
  const usersSrc = fs.readFileSync(path.join(REPO, "src/pages/Users.jsx"), "utf8");

  ok("Import.jsx builds its property options from p.id raw",
    /properties\s*\.?[\s\S]{0,80}?map\(\(p\)\s*=>\s*\[p\.id,/.test(importSrc),
    "expected `.map((p) => [p.id, p.name])` — a String(p.id) here would change the answer");
  ok("Import.jsx stamps that value straight into property_id",
    /property_id:\s*propertyId\b/.test(importSrc));
  ok("Users.jsx puts p.id raw into the property_access array",
    /property_ids:\s*v\s*\?\s*\[\.\.\.f\.property_ids,\s*p\.id\]/.test(usersSrc));
  console.log("        so property_access holds Numbers and property_id holds Numbers: they agree with each other");
  console.log("        and both disagree with the \"string\" the entity schemas and the cascade assume");
}

// ── 4. THE DEFECT: the cascade does not match a Number-keyed row ────────────
console.log("\n[4] Property.delete() cascade against Number-keyed rows");
const NUMBER_ORPHANS = {};
{
  for (const t of localDb.tables) await t.clear();
  __store.clear();
  await signInAsAllPropertyOwner();

  const prop = await db.entities.Property.create({ code: "NUM", name: "Number Inn", rooms: 20, active: true });
  const otherProp = await db.entities.Property.create({ code: "OTH", name: "Other Inn", rooms: 20, active: true });
  const pid = prop.id;
  eq("the fixture property id is a Number", typeof pid, "number");

  // One row per cascade table, stamped exactly the way Import.jsx stamps it.
  const seeded = {};
  for (const t of cascadeTables) {
    if (typeof localDb[t]?.add !== "function") continue;
    await localDb[t].add({ property_id: pid, date: "2026-01-05", business_date: "2026-01-05", created_date: "2026-01-05T00:00:00.000Z" });
    await localDb[t].add({ property_id: otherProp.id, date: "2026-01-05", business_date: "2026-01-05", created_date: "2026-01-05T00:00:00.000Z" });
    seeded[t] = 1;
  }
  const seededTotal = Object.values(seeded).reduce((a, b) => a + b, 0);
  ok("the fixture seeded a row in every cascade table (guards a vacuous check)",
    seededTotal === cascadeTables.length, `seeded ${seededTotal} of ${cascadeTables.length}`);

  await db.entities.Property.delete(pid);
  eq("the Property row itself is gone", await localDb.Property.get(pid), undefined);

  let orphanTotal = 0;
  for (const t of Object.keys(seeded)) {
    const left = await localDb[t].where("property_id").equals(pid).count();
    if (left > 0) {
      orphanTotal += left;
      NUMBER_ORPHANS[t] = left;
    }
  }

  console.log(`        rows still referencing the DELETED property id ${JSON.stringify(pid)}: ${orphanTotal}`);
  if (orphanTotal > 0) {
    console.log(`        orphaned by table: ${Object.entries(NUMBER_ORPHANS).map(([t, n]) => `${t}=${n}`).join(", ")}`);
  }

  ok("deleting a Property cascades into every table that referenced it",
    orphanTotal === 0,
    `${orphanTotal} row(s) ORPHANED across ${Object.keys(NUMBER_ORPHANS).length} table(s).`);

  let unrelatedTotal = 0;
  for (const t of Object.keys(seeded)) {
    unrelatedTotal += await localDb[t].where("property_id").equals(otherProp.id).count();
  }
  eq("deleting one Property preserves every dependent row for another property",
    unrelatedTotal, cascadeTables.length);
}

// ── 5. CONTROL: the same cascade works when the row is String-keyed ─────────
//
// Without this section a reader could believe the cascade is simply broken. It
// is not: it is correct for exactly one representation, and that is not the one
// the app writes. This is what makes section 4 a type-mismatch proof rather than
// a "cascade does not work" complaint.
console.log("\n[5] control — the same cascade against String-keyed rows");
{
  for (const t of localDb.tables) await t.clear();
  __store.clear();
  await signInAsAllPropertyOwner();

  const SPID = "prop_str";
  await localDb.Property.add({ id: SPID, code: "STR", name: "String Inn", rooms: 20, active: true });
  for (const t of cascadeTables) {
    if (typeof localDb[t]?.add !== "function") continue;
    await localDb[t].add({ property_id: SPID, date: "2026-01-05", business_date: "2026-01-05" });
  }
  const before = await localDb.TransactionLine.where("property_id").equals(SPID).count();
  eq("the string fixture seeded a TransactionLine row", before, 1);

  await db.entities.Property.delete(SPID);

  let left = 0;
  for (const t of cascadeTables) {
    if (typeof localDb[t]?.where !== "function") continue;
    left += await localDb[t].where("property_id").equals(SPID).count();
  }
  eq("a String-keyed property cascades cleanly — the cascade logic itself is fine", left, 0);
  console.log("        so the failure in [4] is the REPRESENTATION, not the cascade");
}

console.log("\n[5b] cross-type collision stays isolated");
{
  for (const t of localDb.tables) await t.clear();
  __store.clear();
  await signInAsAllPropertyOwner();

  await localDb.Property.bulkAdd([
    { id: 1, code: "N1", name: "Numeric One", active: true },
    { id: "1", code: "S1", name: "String One", active: true },
  ]);
  await localDb.TransactionLine.bulkAdd([
    { property_id: 1, date: "2026-01-06", amount: 10 },
    { property_id: "1", date: "2026-01-06", amount: 20 },
  ]);

  await db.entities.Property.delete(1);
  eq("the numeric Property is deleted", await localDb.Property.get(1), undefined);
  ok("the distinct string Property remains", !!(await localDb.Property.get("1")));
  eq("numeric children are removed", await localDb.TransactionLine.where("property_id").equals(1).count(), 0);
  eq("string children owned by the distinct string Property remain",
    await localDb.TransactionLine.where("property_id").equals("1").count(), 1);
}

// ── 6. bulkDelete has the same hole, spelled differently ───────────────────
console.log("\n[6] Property.bulkDelete() cascade against Number-keyed rows");
{
  for (const t of localDb.tables) await t.clear();
  __store.clear();
  await signInAsAllPropertyOwner();

  const p1 = await db.entities.Property.create({ code: "BD1", name: "Bulk One", rooms: 10, active: true });
  const p2 = await db.entities.Property.create({ code: "BD2", name: "Bulk Two", rooms: 10, active: true });
  for (const pid of [p1.id, p2.id]) {
    await localDb.TransactionLine.add({ property_id: pid, date: "2026-02-01", amount: 50 });
    await localDb.OccupancyDay.add({ property_id: pid, date: "2026-02-01", rooms_sold: 5 });
  }
  eq("the bulk fixture seeded 4 scoped rows",
    (await localDb.TransactionLine.count()) + (await localDb.OccupancyDay.count()), 4);

  ok("the bulkDelete cascade uses the collision-aware compatibility helper (source check)",
    /const propIds = await propertyCascadeIds\(deletedRecords\)/.test(clientSrc),
    "if this line changed, re-read the assertion below");

  await db.entities.Property.bulkDelete([p1.id, p2.id]);
  eq("both Property rows are gone", await localDb.Property.count(), 0);

  const orphans =
    (await localDb.TransactionLine.count()) + (await localDb.OccupancyDay.count());
  console.log(`        rows left behind by bulkDelete: ${orphans} of 4`);
  ok("bulkDelete cascades into the rows it orphans", orphans === 0,
    `${orphans} row(s) ORPHANED after typed anyOf([${[p1.id, p2.id].join(", ")}]).`);
}

// ── 7. The read-side twin is real but UNREACHABLE today ────────────────────
//
// The scope check is `allowedIds(propertyAccess).includes(id)` — strict equality
// inside Array.prototype.includes — so a Number column and a String grant miss
// each other there too. That would be a lockout rather than a leak (the safe
// direction), and it is worth knowing about before a D1 schema fixes one side
// only.
//
// But it cannot be reached in this release, and this section proves that rather
// than claiming it. LAUNCH_POLICY_V1 (src/lib/launchPolicy.js, enforced at
// base44Client.js#handleLocalAuthLogin) refuses EVERY non-owner/admin account
// whose property_access is not the literal 'all'. So the `Array.isArray(...)`
// branch of resolvePropertyAccessUncached is dead for anybody who can sign in,
// and the type of an ARRAY grant is currently unobservable at runtime.
//
// That is the discriminator between "the cascade defect" and "a general
// property_id typing defect": section 4 is live today; section 7 is latent
// behind the launch gate. The full role x property_access truth table is in
// scripts/probe-property-access-sentinel.mjs.
console.log("\n[7] the read-side twin is gated off by LAUNCH_POLICY_V1");
{
  for (const t of localDb.tables) await t.clear();
  __store.clear();
  await signInAsAllPropertyOwner();

  const prop = await db.entities.Property.create({ code: "MGR", name: "Manager Inn", rooms: 10, active: true });
  const pid = prop.id; // Number
  await localDb.TransactionLine.add({ property_id: pid, date: "2026-03-01", amount: 77 });

  const SALT = "0123456789abcdef0123456789abcdef";
  const PASSWORD = "Manager-Probe-Password-1!";
  const hash = "$pbkdf2$" + (await browserHashPassword(PASSWORD, SALT));
  const mkUser = (id, access) => ({
    id, username: id, email: `${id}@probe.local`, full_name: id, role: "manager",
    property_access: access, is_active: true, is_locked: false, mfa_enabled: false,
    failed_login_count: 0, salt: SALT, password_hash: hash,
    created_date: new Date().toISOString(),
  });
  await localDb.User.bulkAdd([
    mkUser("mgr_num", [pid]),            // what Users.jsx stores today (Numbers)
    mkUser("mgr_str", [String(pid)]),    // what the entity schemas declare (Strings)
  ]);

  const loginErr = async (email) => {
    try {
      await db.auth.login(email, PASSWORD);
      return null;
    } catch (e) {
      return e?.message || String(e);
    } finally {
      invalidatePropertyAccess();
    }
  };

  const numErr = await loginErr("mgr_num@probe.local");
  const strErr = await loginErr("mgr_str@probe.local");
  console.log(`        manager with [${pid}]   => ${numErr === null ? "LOGGED IN" : "REFUSED"}`);
  console.log(`        manager with ["${pid}"] => ${strErr === null ? "LOGGED IN" : "REFUSED"}`);

  ok("a per-property manager is refused REGARDLESS of representation (Number grant)",
    numErr !== null && /all properties/.test(numErr), `error was ${JSON.stringify(numErr)}`);
  ok("a per-property manager is refused REGARDLESS of representation (String grant)",
    strErr !== null && /all properties/.test(strErr), `error was ${JSON.stringify(strErr)}`);
  ok("both refusals are the SAME refusal — so the representation is not what decides it",
    numErr === strErr, `${JSON.stringify(numErr)} vs ${JSON.stringify(strErr)}`);
  console.log("        => the array branch of resolvePropertyAccessUncached is dead code for any");
  console.log("           account that can sign in, so the read-side type mismatch is LATENT.");

  await signInAsAllPropertyOwner();
}

// ── Summary ────────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(72)}`);
console.log("VERDICT");
if (Object.keys(NUMBER_ORPHANS).length > 0) {
  console.log("  Property cascade delete is a NO-OP for the representation the app writes.");
  console.log(`  ${Object.values(NUMBER_ORPHANS).reduce((a, b) => a + b, 0)} row(s) orphaned across ` +
    `${Object.keys(NUMBER_ORPHANS).length} table(s) in the single-property fixture.`);
  console.log("  ONE representation must win. See the probe header.");
}
if (failures.length) {
  console.log("\nFailures:");
  failures.forEach((f) => console.log(`  • ${f}`));
}
console.log(`\n${fail === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
