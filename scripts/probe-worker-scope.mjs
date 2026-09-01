// scripts/probe-worker-scope.mjs — INDEPENDENT adversarial proof of
// worker/scope.js (fail-closed, default-deny property scope resolution) and its
// enforcement (scopeConstraint / assertPropertyInScope) against a REAL shim DB.
//
// Run: node scripts/probe-worker-scope.mjs   (exits non-zero on ANY failure)

import { resolveScope, scopeConstraint, assertPropertyInScope, ScopeError } from "../worker/scope.js";
import { queryAll } from "../worker/db.js";
import {
  makeDb,
  makeEnv,
  seedProperties,
  seedUser,
  seedTxn,
  makeRunner,
  assert,
  assertEqual,
} from "./_worker-testkit.mjs";

const r = makeRunner("probe-worker-scope");

function baseDb() {
  const db = makeDb();
  seedProperties(db);
  return db;
}
const sorted = (a) => [...a].sort();

// --- unknown email => 403, and NO user auto-provisioned --------------------
await r.check("unknown email (valid JWT, no user row) => 403, no user created", async () => {
  const db = baseDb();
  const env = makeEnv(db);
  const before = db.prepare("SELECT COUNT(*) c FROM user").get().c;
  const res = await resolveScope(env, { subject: "s", email: "ghost@nobody.example" });
  assert(res.ok === false, "unknown email must be denied");
  assertEqual(res.status, 403, "must be 403");
  const after = db.prepare("SELECT COUNT(*) c FROM user").get().c;
  assertEqual(after, before, "must NOT auto-create a user row");
});

// --- role owner/admin => ALL (role overrides the stored mode) --------------
await r.check("role 'owner' with mode 'specific' + zero grants => ALL property ids", async () => {
  const db = baseDb();
  seedUser(db, { id: "u-owner", email: "owner@hotel.example", role: "owner", mode: "specific", grants: [] });
  const res = await resolveScope(makeEnv(db), { subject: "s", email: "owner@hotel.example" });
  assert(res.ok === true, "owner must resolve");
  assert(res.scope.all === true, "owner is unrestricted");
  assertEqual(JSON.stringify(sorted(res.scope.propertyIds)), JSON.stringify(["P_A", "P_B"]), "owner sees all");
});

await r.check("role 'admin' => ALL property ids", async () => {
  const db = baseDb();
  seedUser(db, { id: "u-admin", email: "admin@hotel.example", role: "admin", mode: "specific", grants: [] });
  const res = await resolveScope(makeEnv(db), { subject: "s", email: "admin@hotel.example" });
  assert(res.ok === true && res.scope.all === true, "admin unrestricted");
  assertEqual(JSON.stringify(sorted(res.scope.propertyIds)), JSON.stringify(["P_A", "P_B"]), "admin sees all");
});

// --- property_access_mode = 'all' => ALL -----------------------------------
await r.check("staff mode 'all' => ALL property ids", async () => {
  const db = baseDb();
  seedUser(db, { id: "u-all", email: "all@hotel.example", role: "staff", mode: "all", grants: [] });
  const res = await resolveScope(makeEnv(db), { subject: "s", email: "all@hotel.example" });
  assert(res.ok === true && res.scope.all === true, "mode all unrestricted");
  assertEqual(JSON.stringify(sorted(res.scope.propertyIds)), JSON.stringify(["P_A", "P_B"]), "sees all");
});

// --- 'specific' => exactly the granted ids ---------------------------------
await r.check("staff mode 'specific' => exactly granted ids", async () => {
  const db = baseDb();
  seedUser(db, { id: "u-spec", email: "spec@hotel.example", role: "staff", mode: "specific", grants: ["P_A"] });
  const res = await resolveScope(makeEnv(db), { subject: "s", email: "spec@hotel.example" });
  assert(res.ok === true && res.scope.all === false, "specific is restricted");
  assertEqual(JSON.stringify(res.scope.propertyIds), JSON.stringify(["P_A"]), "only granted P_A");
});

// --- 'specific' with zero grants => empty set (sees nothing) ---------------
await r.check("staff mode 'specific' with zero grants => empty set", async () => {
  const db = baseDb();
  seedUser(db, { id: "u-none", email: "none@hotel.example", role: "staff", mode: "specific", grants: [] });
  const res = await resolveScope(makeEnv(db), { subject: "s", email: "none@hotel.example" });
  assert(res.ok === true && res.scope.all === false, "restricted");
  assertEqual(res.scope.propertyIds.length, 0, "zero grants => empty set");
});

// --- scopeConstraint actually filters cross-property reads -----------------
await r.check("scopeConstraint: property-A user CANNOT read property-B rows (real SQL)", async () => {
  const db = baseDb();
  seedUser(db, { id: "u-a", email: "a@hotel.example", role: "staff", mode: "specific", grants: ["P_A"] });
  // Rows in BOTH properties.
  seedTxn(db, { id: "t1", property_id: "P_A", date: "2026-01-02", amount: 100.0, folio: "F1", code: "RENT", dedupe_key: "k1" });
  seedTxn(db, { id: "t2", property_id: "P_A", date: "2026-01-03", amount: 50.5, folio: "F2", code: "RENT", dedupe_key: "k2" });
  seedTxn(db, { id: "t3", property_id: "P_B", date: "2026-01-02", amount: 999.99, folio: "F9", code: "RENT", dedupe_key: "k3" });
  const env = makeEnv(db);
  const res = await resolveScope(env, { subject: "s", email: "a@hotel.example" });
  assert(res.ok === true, "resolve ok");
  const c = scopeConstraint(res.scope, "property_id");
  const rows = await queryAll(env, `SELECT id, property_id FROM transaction_line WHERE ${c.sql}`, c.params);
  assertEqual(rows.length, 2, "must see exactly the 2 property-A rows");
  assert(rows.every((x) => x.property_id === "P_A"), "must NOT leak any property-B row");
});

// --- empty scope constraint = 1 = 0 (fail-closed) --------------------------
await r.check("scopeConstraint for empty scope yields 1=0 (reads nothing)", async () => {
  const db = baseDb();
  seedUser(db, { id: "u-z", email: "z@hotel.example", role: "staff", mode: "specific", grants: [] });
  seedTxn(db, { id: "t1", property_id: "P_A", date: "2026-01-02", amount: 100.0, folio: "F1", code: "RENT", dedupe_key: "k1" });
  const env = makeEnv(db);
  const res = await resolveScope(env, { subject: "s", email: "z@hotel.example" });
  const c = scopeConstraint(res.scope, "property_id");
  assertEqual(c.sql, "1 = 0", "empty set must be 1 = 0");
  const rows = await queryAll(env, `SELECT id FROM transaction_line WHERE ${c.sql}`, c.params);
  assertEqual(rows.length, 0, "zero-grant caller must read nothing even when rows exist");
});

// --- assertPropertyInScope: out-of-scope id throws -------------------------
await r.check("assertPropertyInScope throws for out-of-scope id, allows in-scope", async () => {
  const db = baseDb();
  seedUser(db, { id: "u-a2", email: "a2@hotel.example", role: "staff", mode: "specific", grants: ["P_A"] });
  const res = await resolveScope(makeEnv(db), { subject: "s", email: "a2@hotel.example" });
  assertPropertyInScope(res.scope, "P_A"); // must NOT throw
  let threw = null;
  try {
    assertPropertyInScope(res.scope, "P_B");
  } catch (e) {
    threw = e;
  }
  assert(threw instanceof ScopeError, "out-of-scope must throw ScopeError");
});

r.done();
if (process.exitCode) process.exit(1);
console.log("PASSED: Worker authorization-scope contract completed.");
