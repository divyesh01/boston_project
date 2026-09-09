import {
  assert,
  assertEqual,
  makeDb,
  makeEnv,
  makeRunner,
  seedUser,
  scopeAll,
  scopeSpecific,
} from "./_worker-testkit.mjs";
import {
  canonicalJson,
  handleBusinessSyncRequest,
  typedRecordKey,
  RESETTABLE_ENTITIES,
} from "../worker/business-sync.js";

const run = makeRunner("probe-business-sync-reset");
const db = makeDb();
db.prepare("INSERT INTO account (id,name,created_date) VALUES (?,?,?)").run("A_1", "Test Account", "2026-01-01");
seedUser(db, { id: "u_owner", email: "owner@test.local", role: "owner", mode: "all" });
seedUser(db, { id: "u_admin", email: "admin@test.local", role: "admin", mode: "all" });
seedUser(db, { id: "u_manager", email: "manager@test.local", role: "manager", mode: "specific", properties: ["prop_1"] });
seedUser(db, { id: "u_viewer", email: "viewer@test.local", role: "read_only", mode: "all" });

const env = makeEnv(db, { ENABLE_BUSINESS_SYNC_API: "true" });
const ownerScope = scopeAll(["prop_1", "prop_2"]);
ownerScope.user.id = "u_owner";
ownerScope.user.role = "owner";

const adminScope = scopeAll(["prop_1", "prop_2"]);
adminScope.user.id = "u_admin";
adminScope.user.role = "admin";

const managerScope = scopeSpecific(["prop_1"]);
managerScope.user.id = "u_manager";
managerScope.user.role = "manager";
managerScope.user.permissions = JSON.stringify({ import_reports: true });

const viewerScope = scopeAll([]);
viewerScope.user.id = "u_viewer";
viewerScope.user.role = "read_only";

async function hash(value) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(typeof value === "string" ? value : canonicalJson(value))));
  return Array.from(digest, (part) => part.toString(16).padStart(2, "0")).join("");
}

async function encoded(entity, row) {
  const record_key = typedRecordKey(row.id);
  const property_key = entity === "Property" ? record_key : typedRecordKey(row.property_id);
  return { entity, record_key, property_key, row, row_hash: await hash(canonicalJson(row)) };
}

async function call(path, { method = "GET", body, scope = ownerScope } = {}) {
  const url = new URL(`https://api.test/api/business-sync/${path}`);
  const request = new Request(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return handleBusinessSyncRequest(request, env, scope, url, url.pathname.split("/").filter(Boolean));
}

// 1. Setup active dataset with properties and rows
const genId = "gen_reset_test";
const now = new Date().toISOString();

db.prepare("INSERT INTO business_dataset (account_id,generation_id,status,schema_version,manifest_hash,manifest_json,expected_chunks,expected_records,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
  .run("A_1", genId, "active", 1, "mock_hash", "{}", 1, 10, "u_owner", now);

db.prepare("INSERT INTO business_dataset_pointer (account_id,active_generation_id,updated_at) VALUES (?,?,?)")
  .run("A_1", genId, now);

db.prepare("INSERT INTO business_sync_state (account_id,revision) VALUES (?,10)")
  .run("A_1");

// Seed properties
db.prepare("INSERT INTO property (id,account_id,code,name,rooms,active,created_date) VALUES (?,?,?,?,?,?,?)")
  .run("prop_1", "A_1", "P1", "Property 1", 50, 1, now);
db.prepare("INSERT INTO property (id,account_id,code,name,rooms,active,created_date) VALUES (?,?,?,?,?,?,?)")
  .run("prop_2", "A_1", "P2", "Property 2", 75, 1, now);

db.prepare("INSERT INTO business_property_map (account_id,generation_id,property_key,server_property_id,property_code) VALUES (?,?,?,?,?)")
  .run("A_1", genId, "s:6:prop_1", "prop_1", "P1");
db.prepare("INSERT INTO business_property_map (account_id,generation_id,property_key,server_property_id,property_code) VALUES (?,?,?,?,?)")
  .run("A_1", genId, "s:6:prop_2", "prop_2", "P2");

// Seed records:
// Persistent:
// - Property (2 rows)
// - Staff (2 rows)
// - PayrollRun (2 rows)
// - Expense (2 rows)
// Resettable (Imported):
// - OccupancyDay (2 rows for prop_1, 2 rows for prop_2)
// - UploadedReport (1 row for prop_1, 1 row for prop_2)
// - TransactionLine (2 rows for prop_1, 2 rows for prop_2)

async function seedRecords() {
  db.prepare("DELETE FROM business_record WHERE account_id=?").run("A_1");
  const records = [
    // Persistent records
    await encoded("Property", { id: "prop_1", code: "P1", name: "Property 1" }),
    await encoded("Property", { id: "prop_2", code: "P2", name: "Property 2" }),
    await encoded("Staff", { id: "st_1", property_id: "prop_1", name: "Alice" }),
    await encoded("Staff", { id: "st_2", property_id: "prop_2", name: "Bob" }),
    await encoded("PayrollRun", { id: "pr_1", property_id: "prop_1", total_pay: 1000 }),
    await encoded("PayrollRun", { id: "pr_2", property_id: "prop_2", total_pay: 1500 }),
    await encoded("Expense", { id: "ex_1", property_id: "prop_1", amount: 200 }),
    await encoded("Expense", { id: "ex_2", property_id: "prop_2", amount: 300 }),
    // Resettable records
    await encoded("OccupancyDay", { id: "occ_1_1", property_id: "prop_1", date: "2026-09-01", total_revenue: 500 }),
    await encoded("OccupancyDay", { id: "occ_1_2", property_id: "prop_1", date: "2026-09-02", total_revenue: 600 }),
    await encoded("OccupancyDay", { id: "occ_2_1", property_id: "prop_2", date: "2026-09-01", total_revenue: 700 }),
    await encoded("OccupancyDay", { id: "occ_2_2", property_id: "prop_2", date: "2026-09-02", total_revenue: 800 }),
    await encoded("UploadedReport", { id: "rep_1", property_id: "prop_1", file_name: "p1.csv" }),
    await encoded("UploadedReport", { id: "rep_2", property_id: "prop_2", file_name: "p2.csv" }),
    await encoded("TransactionLine", { id: "tx_1_1", property_id: "prop_1", amount: 100 }),
    await encoded("TransactionLine", { id: "tx_1_2", property_id: "prop_1", amount: 200 }),
    await encoded("TransactionLine", { id: "tx_2_1", property_id: "prop_2", amount: 300 }),
    await encoded("TransactionLine", { id: "tx_2_2", property_id: "prop_2", amount: 400 }),
  ];

  for (const r of records) {
    const serverPropId = r.entity === "Property" ? null : (r.row.property_id || null);
    db.prepare("INSERT INTO business_record (account_id,generation_id,entity_name,record_key,property_key,server_property_id,row_json,row_hash,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run("A_1", genId, r.entity, r.record_key, r.property_key, serverPropId, canonicalJson(r.row), r.row_hash, now);
  }
}

await run.check("RBAC: viewer role is rejected with 403", async () => {
  await seedRecords();
  const res = await call("reset", { method: "POST", body: { property_id: "all" }, scope: viewerScope });
  assertEqual(res.status, 403, "viewer forbidden");
});

await run.check("RBAC: manager without scope.all is rejected from resetting all properties", async () => {
  const res = await call("reset", { method: "POST", body: { property_id: "all" }, scope: managerScope });
  assertEqual(res.status, 403, "manager without all forbidden from all reset");
});

await run.check("Validation: non-resettable entity (Property, Staff) is rejected with 422", async () => {
  const res1 = await call("reset", { method: "POST", body: { entities: ["Property"] }, scope: ownerScope });
  assertEqual(res1.status, 422, "Property is not resettable");

  const res2 = await call("reset", { method: "POST", body: { entities: ["Staff"] }, scope: ownerScope });
  assertEqual(res2.status, 422, "Staff is not resettable");

  const res3 = await call("reset", { method: "POST", body: { entities: ["PayrollRun"] }, scope: ownerScope });
  assertEqual(res3.status, 422, "PayrollRun is not resettable");
});

await run.check("Scoped Reset: resets only prop_1 imported data, preserving prop_2 and all persistent entities", async () => {
  await seedRecords();
  const res = await call("reset", { method: "POST", body: { property_id: "prop_1" }, scope: ownerScope });
  assertEqual(res.status, 200, "scoped reset ok");
  const data = await res.json();
  assertEqual(data.ok, true, "data.ok true");
  assertEqual(data.deleted_records, 5, "5 records deleted for prop_1 (2 occ + 1 rep + 2 tx)");

  // Verify prop_1 imported records are gone
  const p1Occ = db.prepare("SELECT COUNT(*) AS count FROM business_record WHERE account_id=? AND entity_name='OccupancyDay' AND server_property_id='prop_1'").get("A_1");
  assertEqual(p1Occ.count, 0, "prop_1 OccupancyDay deleted");

  // Verify prop_2 imported records survive
  const p2Occ = db.prepare("SELECT COUNT(*) AS count FROM business_record WHERE account_id=? AND entity_name='OccupancyDay' AND server_property_id='prop_2'").get("A_1");
  assertEqual(p2Occ.count, 2, "prop_2 OccupancyDay preserved");

  // Verify persistent entities 100% survive across all properties
  const propCount = db.prepare("SELECT COUNT(*) AS count FROM business_record WHERE account_id=? AND entity_name='Property'").get("A_1");
  assertEqual(propCount.count, 2, "Property rows preserved");
  const staffCount = db.prepare("SELECT COUNT(*) AS count FROM business_record WHERE account_id=? AND entity_name='Staff'").get("A_1");
  assertEqual(staffCount.count, 2, "Staff rows preserved");
  const payrollCount = db.prepare("SELECT COUNT(*) AS count FROM business_record WHERE account_id=? AND entity_name='PayrollRun'").get("A_1");
  assertEqual(payrollCount.count, 2, "PayrollRun rows preserved");
  const expenseCount = db.prepare("SELECT COUNT(*) AS count FROM business_record WHERE account_id=? AND entity_name='Expense'").get("A_1");
  assertEqual(expenseCount.count, 2, "Expense rows preserved");
});

await run.check("All-Properties Reset: deletes all imported records, preserving 100% of persistent configuration", async () => {
  await seedRecords();
  const res = await call("reset", { method: "POST", body: { property_id: "all" }, scope: ownerScope });
  assertEqual(res.status, 200, "all reset ok");
  const data = await res.json();
  assertEqual(data.ok, true, "data.ok true");
  assertEqual(data.deleted_records, 10, "10 total imported records deleted across all properties");

  // Verify all imported records are gone
  const totalOcc = db.prepare("SELECT COUNT(*) AS count FROM business_record WHERE account_id=? AND entity_name='OccupancyDay'").get("A_1");
  assertEqual(totalOcc.count, 0, "all OccupancyDay deleted");
  const totalRep = db.prepare("SELECT COUNT(*) AS count FROM business_record WHERE account_id=? AND entity_name='UploadedReport'").get("A_1");
  assertEqual(totalRep.count, 0, "all UploadedReport deleted");
  const totalTx = db.prepare("SELECT COUNT(*) AS count FROM business_record WHERE account_id=? AND entity_name='TransactionLine'").get("A_1");
  assertEqual(totalTx.count, 0, "all TransactionLine deleted");

  // Verify persistent configuration 100% preserved
  const propCount = db.prepare("SELECT COUNT(*) AS count FROM business_record WHERE account_id=? AND entity_name='Property'").get("A_1");
  assertEqual(propCount.count, 2, "Property rows 100% preserved");
  const staffCount = db.prepare("SELECT COUNT(*) AS count FROM business_record WHERE account_id=? AND entity_name='Staff'").get("A_1");
  assertEqual(staffCount.count, 2, "Staff rows 100% preserved");
  const payrollCount = db.prepare("SELECT COUNT(*) AS count FROM business_record WHERE account_id=? AND entity_name='PayrollRun'").get("A_1");
  assertEqual(payrollCount.count, 2, "PayrollRun rows 100% preserved");
  const expenseCount = db.prepare("SELECT COUNT(*) AS count FROM business_record WHERE account_id=? AND entity_name='Expense'").get("A_1");
  assertEqual(expenseCount.count, 2, "Expense rows 100% preserved");
});

await run.check("Reactivity & Audit: destructive feed change row written, revision incremented", async () => {
  const syncState = db.prepare("SELECT revision FROM business_sync_state WHERE account_id=?").get("A_1");
  assertEqual(syncState.revision > 10, true, "sync state revision incremented");

  const destructiveChange = db.prepare("SELECT * FROM business_change WHERE account_id=? AND operation='property_delete' ORDER BY seq DESC LIMIT 1").get("A_1");
  assert(destructiveChange, "property_delete change entry exists");
  assertEqual(destructiveChange.seq, syncState.revision, "change seq matches state revision");

  // Check that feed API reports rebuild_required: true
  const feedRes = await call("feed?since=10", { method: "GET", scope: ownerScope });
  assertEqual(feedRes.status, 200, "feed ok");
  const feedData = await feedRes.json();
  assertEqual(feedData.rebuild_required, true, "feed signals rebuild_required: true for cache invalidation");
});

run.done();
if (process.exitCode) process.exit(1);
console.log("\nPASSED: All probe-business-sync-reset tests passed.\n");
process.exit(0);
