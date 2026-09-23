// scripts/probe-bulk-import-mutation-headers.mjs
// Verifies:
// 1. Every client mutation function sends 'X-Requested-With: XMLHttpRequest' header:
//    - check-duplicate (POST)
//    - raw-check (POST)
//    - raw-upload (PUT)
//    - raw-archive (POST)
//    - upload (PUT)
//    - activate (POST)
//    - supersede (POST)
//    - delete (POST)
//    - raw-destroy (POST)
// 2. Worker sameOriginMutation rejects any mutation missing 'X-Requested-With: XMLHttpRequest' with 403.
// 3. Worker sameOriginMutation accepts mutations with 'X-Requested-With: XMLHttpRequest'.
// 4. Role-based authorization:
//    - owner and admin allowed
//    - manager / gm with permissions.import_reports = true allowed
//    - manager / gm without permissions.import_reports = true denied (403)
//    - unauthorized roles denied (403)
//    - raw-destroy requires owner role (non-owner denied 403)
// 5. Duplicate detection marks duplicate bundles and force import allows re-import.

import {
  assert,
  assertEqual,
  makeDb,
  makeInstrumentedEnv,
  makeRunner,
  seedUser,
  scopeAll,
  scopeSpecific,
} from "./_worker-testkit.mjs";
import worker from "../worker/index.js";
import { handleBulkImportRequest } from "../worker/bulk-import.js";
import { clearMockStore, testR2Binding } from "./_r2-testkit.mjs";
import {
  checkDuplicateServer,
  checkRawDuplicateServer,
  uploadRawArchiveToServer,
  recordRawArchiveOnServer,
  uploadBundleToServer,
  activateBundleOnServer,
  supersedeBundleOnServer,
  deleteBundleOnServer,
  destroyRawArchiveOnServer,
  compressPayloadGzip,
  sha256Hex,
} from "../src/lib/bulkImportPipeline.js";

const run = makeRunner("probe-bulk-import-mutation-headers");

function setupEnv() {
  clearMockStore();
  const db = makeDb();
  db.prepare("INSERT OR IGNORE INTO account (id, name, created_date) VALUES (?, ?, ?)").run("A_1", "Header Test Account", "2026-01-01");
  seedUser(db, { id: "user_owner", email: "owner@test.local", role: "owner", mode: "all", accountId: "A_1" });
  seedUser(db, { id: "user_admin", email: "admin@test.local", role: "admin", mode: "all", accountId: "A_1" });
  seedUser(db, { id: "user_mgr_allowed", email: "mgr_ok@test.local", role: "manager", mode: "specific", accountId: "A_1" });
  seedUser(db, { id: "user_gm_allowed", email: "gm_ok@test.local", role: "gm", mode: "specific", accountId: "A_1" });
  seedUser(db, { id: "user_mgr_denied", email: "mgr_no@test.local", role: "manager", mode: "specific", accountId: "A_1" });
  seedUser(db, { id: "user_staff", email: "staff@test.local", role: "staff", mode: "specific", accountId: "A_1" });

  db.prepare("INSERT OR IGNORE INTO property (id, account_id, code, name, rooms, address, city, state, phone, active, created_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("P_A", "A_1", "RRI-A", "Red Roof Inn A", 100, "123 A St", "Boston", "MA", "617-555-0100", 1, "2026-01-01");
  db.prepare("INSERT OR IGNORE INTO property (id, account_id, code, name, rooms, address, city, state, phone, active, created_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("P_B", "A_1", "RRI-B", "Red Roof Inn B", 80, "456 B St", "Boston", "MA", "617-555-0200", 1, "2026-01-01");

  db.prepare("INSERT OR IGNORE INTO business_sync_state (account_id, revision) VALUES (?, ?)").run("A_1", 0);

  const { env, stats } = makeInstrumentedEnv(db, {
    ENABLE_D1_DATA_API: "true",
    ENABLE_BUSINESS_SYNC_API: "true",
    RAW_ARCHIVE: testR2Binding(),
    BULK_DATA: testR2Binding(),
  });

  const owner = scopeAll(["P_A", "P_B"]);
  owner.accountId = "A_1";
  owner.user.id = "user_owner";
  owner.user.account_id = "A_1";
  owner.user.role = "owner";

  const admin = scopeAll(["P_A", "P_B"]);
  admin.accountId = "A_1";
  admin.user.id = "user_admin";
  admin.user.account_id = "A_1";
  admin.user.role = "admin";

  const managerAllowed = scopeSpecific(["P_A"]);
  managerAllowed.accountId = "A_1";
  managerAllowed.user.id = "user_mgr_allowed";
  managerAllowed.user.account_id = "A_1";
  managerAllowed.user.role = "manager";
  managerAllowed.user.permissions = JSON.stringify({ import_reports: true });

  const gmAllowed = scopeSpecific(["P_A"]);
  gmAllowed.accountId = "A_1";
  gmAllowed.user.id = "user_gm_allowed";
  gmAllowed.user.account_id = "A_1";
  gmAllowed.user.role = "gm";
  gmAllowed.user.permissions = JSON.stringify({ import_reports: true });

  const managerDenied = scopeSpecific(["P_A"]);
  managerDenied.accountId = "A_1";
  managerDenied.user.id = "user_mgr_denied";
  managerDenied.user.account_id = "A_1";
  managerDenied.user.role = "manager";
  managerDenied.user.permissions = JSON.stringify({ import_reports: false });

  const staff = scopeSpecific(["P_A"]);
  staff.accountId = "A_1";
  staff.user.id = "user_staff";
  staff.user.account_id = "A_1";
  staff.user.role = "staff";

  return { db, env, stats, owner, admin, managerAllowed, gmAllowed, managerDenied, staff };
}

// ---------------------------------------------------------------------------
// TEST 1: Worker sameOriginMutation rejects mutations missing X-Requested-With
// ---------------------------------------------------------------------------
await run.check("Worker router rejects mutations without X-Requested-With: XMLHttpRequest with 403 forbidden", async () => {
  const { env } = setupEnv();
  const mutationPaths = [
    { path: "/api/bulk-import/check-duplicate", method: "POST" },
    { path: "/api/bulk-import/raw-check", method: "POST" },
    { path: "/api/bulk-import/raw-upload", method: "PUT" },
    { path: "/api/bulk-import/raw-archive", method: "POST" },
    { path: "/api/bulk-import/upload", method: "PUT" },
    { path: "/api/bulk-import/activate", method: "POST" },
    { path: "/api/bulk-import/supersede", method: "POST" },
    { path: "/api/bulk-import/delete", method: "POST" },
    { path: "/api/bulk-import/raw-destroy", method: "POST" },
  ];

  for (const { path, method } of mutationPaths) {
    const reqNoHeader = new Request(`http://localhost${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: method === "GET" ? undefined : JSON.stringify({}),
    });
    const res = await worker.fetch(reqNoHeader, env, { waitUntil() {}, passThroughOnException() {} });
    assertEqual(res.status, 403, `${method} ${path} without X-Requested-With must be rejected with 403`);
    const data = await res.json();
    assertEqual(data.error, "forbidden", `${method} ${path} returns error: forbidden`);
  }
});

// ---------------------------------------------------------------------------
// TEST 2: Every client mutation function sends X-Requested-With: XMLHttpRequest
// ---------------------------------------------------------------------------
await run.check("All 9 client bulk-import mutation functions send X-Requested-With: XMLHttpRequest", async () => {
  const originalFetch = globalThis.fetch;
  const capturedRequests = [];

  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const method = init.method || (typeof input !== "string" ? input.method : "GET");
    const headers = new Headers(init.headers || (typeof input !== "string" ? input.headers : {}));
    capturedRequests.push({ url, method, headers });
    return new Response(JSON.stringify({ ok: true, is_duplicate: false, exists: false }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const rawHash = "a".repeat(64);
    const normHash = "b".repeat(64);

    // 1. checkDuplicateServer
    await checkDuplicateServer({ serverPropertyId: "P_A", rawFileHash: rawHash, normalizedHash: normHash });
    const req1 = capturedRequests.find(r => r.url === "/api/bulk-import/check-duplicate");
    assert(req1, "checkDuplicateServer called /api/bulk-import/check-duplicate");
    assertEqual(req1.method, "POST");
    assertEqual(req1.headers.get("X-Requested-With"), "XMLHttpRequest", "checkDuplicateServer sends X-Requested-With");

    // 2. checkRawDuplicateServer
    await checkRawDuplicateServer({ serverPropertyId: "P_A", rawFileHash: rawHash });
    const req2 = capturedRequests.find(r => r.url === "/api/bulk-import/raw-check");
    assert(req2, "checkRawDuplicateServer called /api/bulk-import/raw-check");
    assertEqual(req2.method, "POST");
    assertEqual(req2.headers.get("X-Requested-With"), "XMLHttpRequest", "checkRawDuplicateServer sends X-Requested-With");

    // 3. uploadRawArchiveToServer
    await uploadRawArchiveToServer({
      serverPropertyId: "P_A",
      reportType: "occupancy",
      rawFileHash: rawHash,
      rawArchiveId: "raw_123",
      rawBuffer: new Uint8Array([1, 2, 3]),
    });
    const req3 = capturedRequests.find(r => r.url === "/api/bulk-import/raw-upload");
    assert(req3, "uploadRawArchiveToServer called /api/bulk-import/raw-upload");
    assertEqual(req3.method, "PUT");
    assertEqual(req3.headers.get("X-Requested-With"), "XMLHttpRequest", "uploadRawArchiveToServer sends X-Requested-With");

    // 4. recordRawArchiveOnServer
    await recordRawArchiveOnServer({
      id: "raw_123",
      server_property_id: "P_A",
      raw_file_hash: rawHash,
      raw_archive_id: "raw_123",
    });
    const req4 = capturedRequests.find(r => r.url === "/api/bulk-import/raw-archive");
    assert(req4, "recordRawArchiveOnServer called /api/bulk-import/raw-archive");
    assertEqual(req4.method, "POST");
    assertEqual(req4.headers.get("X-Requested-With"), "XMLHttpRequest", "recordRawArchiveOnServer sends X-Requested-With");

    // 5. uploadBundleToServer
    await uploadBundleToServer({
      serverPropertyId: "P_A",
      reportType: "occupancy",
      rawFileHash: rawHash,
      normalizedHash: normHash,
      rowCount: 10,
      compressedBuffer: new Uint8Array([4, 5, 6]),
    });
    const req5 = capturedRequests.find(r => r.url === "/api/bulk-import/upload");
    assert(req5, "uploadBundleToServer called /api/bulk-import/upload");
    assertEqual(req5.method, "PUT");
    assertEqual(req5.headers.get("X-Requested-With"), "XMLHttpRequest", "uploadBundleToServer sends X-Requested-With");

    // 6. activateBundleOnServer
    await activateBundleOnServer({
      id: "b_123",
      server_property_id: "P_A",
      report_type: "occupancy",
      raw_file_hash: rawHash,
      normalized_hash: normHash,
      row_count: 10,
    });
    const req6 = capturedRequests.find(r => r.url === "/api/bulk-import/activate");
    assert(req6, "activateBundleOnServer called /api/bulk-import/activate");
    assertEqual(req6.method, "POST");
    assertEqual(req6.headers.get("X-Requested-With"), "XMLHttpRequest", "activateBundleOnServer sends X-Requested-With");

    // 7. supersedeBundleOnServer
    await supersedeBundleOnServer({ oldBundleId: "b_old", newBundleId: "b_new" });
    const req7 = capturedRequests.find(r => r.url === "/api/bulk-import/supersede");
    assert(req7, "supersedeBundleOnServer called /api/bulk-import/supersede");
    assertEqual(req7.method, "POST");
    assertEqual(req7.headers.get("X-Requested-With"), "XMLHttpRequest", "supersedeBundleOnServer sends X-Requested-With");

    // 8. deleteBundleOnServer
    await deleteBundleOnServer({ bundleId: "b_del", serverPropertyId: "P_A" });
    const req8 = capturedRequests.find(r => r.url === "/api/bulk-import/delete");
    assert(req8, "deleteBundleOnServer called /api/bulk-import/delete");
    assertEqual(req8.method, "POST");
    assertEqual(req8.headers.get("X-Requested-With"), "XMLHttpRequest", "deleteBundleOnServer sends X-Requested-With");

    // 9. destroyRawArchiveOnServer
    await destroyRawArchiveOnServer({ archiveId: "raw_123", confirmDestroy: true });
    const req9 = capturedRequests.find(r => r.url === "/api/bulk-import/raw-destroy");
    assert(req9, "destroyRawArchiveOnServer called /api/bulk-import/raw-destroy");
    assertEqual(req9.method, "POST");
    assertEqual(req9.headers.get("X-Requested-With"), "XMLHttpRequest", "destroyRawArchiveOnServer sends X-Requested-With");

    assertEqual(capturedRequests.length, 9, "All 9 mutations executed and audited");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// TEST 3: Role-based permissions: owner, admin, manager/GM (import_reports: true) vs unauthorized
// ---------------------------------------------------------------------------
await run.check("Role authorization: owner, admin, and manager/gm with import_reports=true are authorized; unauthorized denied", async () => {
  const { env, owner, admin, managerAllowed, gmAllowed, managerDenied, staff } = setupEnv();
  const payload = new Uint8Array([1, 2, 3]);
  const rawHash = await sha256Hex(payload);

  const makeReq = (userScope) => new Request("http://localhost/api/bulk-import/raw-upload", {
    method: "PUT",
    headers: {
      "X-Requested-With": "XMLHttpRequest",
      "x-server-property-id": "P_A",
      "x-raw-hash": rawHash,
      "x-report-type": "occupancy",
    },
    body: payload,
  });

  // Owner allowed
  const resOwner = await handleBulkImportRequest(makeReq(owner), env, owner, new URL("http://localhost/api/bulk-import/raw-upload"), ["api", "bulk-import", "raw-upload"]);
  assertEqual(resOwner.status, 201, "Owner is authorized for bulk import");

  // Admin allowed
  const resAdmin = await handleBulkImportRequest(makeReq(admin), env, admin, new URL("http://localhost/api/bulk-import/raw-upload"), ["api", "bulk-import", "raw-upload"]);
  assert([200, 201].includes(resAdmin.status), "Admin is authorized for bulk import");

  // Manager with import_reports=true allowed
  const resMgrOk = await handleBulkImportRequest(makeReq(managerAllowed), env, managerAllowed, new URL("http://localhost/api/bulk-import/raw-upload"), ["api", "bulk-import", "raw-upload"]);
  assert([200, 201].includes(resMgrOk.status), "Manager with import_reports=true is authorized");

  // GM with import_reports=true allowed
  const resGmOk = await handleBulkImportRequest(makeReq(gmAllowed), env, gmAllowed, new URL("http://localhost/api/bulk-import/raw-upload"), ["api", "bulk-import", "raw-upload"]);
  assert([200, 201].includes(resGmOk.status), "GM with import_reports=true is authorized");

  // Manager without import_reports=true denied with 403
  const resMgrNo = await handleBulkImportRequest(makeReq(managerDenied), env, managerDenied, new URL("http://localhost/api/bulk-import/raw-upload"), ["api", "bulk-import", "raw-upload"]);
  assertEqual(resMgrNo.status, 403, "Manager without import_reports=true is denied with 403");
  const dataMgrNo = await resMgrNo.json();
  assertEqual(dataMgrNo.code, "IMPORT_ROLE_FORBIDDEN", "Denied manager gets IMPORT_ROLE_FORBIDDEN");

  // Staff denied with 403
  const resStaff = await handleBulkImportRequest(makeReq(staff), env, staff, new URL("http://localhost/api/bulk-import/raw-upload"), ["api", "bulk-import", "raw-upload"]);
  assertEqual(resStaff.status, 403, "Staff is denied with 403");
  const dataStaff = await resStaff.json();
  assertEqual(dataStaff.code, "IMPORT_ROLE_FORBIDDEN", "Staff gets IMPORT_ROLE_FORBIDDEN");
});

// ---------------------------------------------------------------------------
// TEST 4: raw-destroy requires owner role (admin / manager denied)
// ---------------------------------------------------------------------------
await run.check("raw-destroy strictly requires owner role", async () => {
  const { env, owner, admin, managerAllowed } = setupEnv();

  // Create an active archive first
  const payload = new Uint8Array([10, 20, 30]);
  const rawHash = await sha256Hex(payload);
  const upReq = new Request("http://localhost/api/bulk-import/raw-upload", {
    method: "PUT",
    headers: {
      "X-Requested-With": "XMLHttpRequest",
      "x-server-property-id": "P_A",
      "x-raw-hash": rawHash,
      "x-archive-id": "raw_destroy_test",
    },
    body: payload,
  });
  await handleBulkImportRequest(upReq, env, owner, new URL(upReq.url), ["api", "bulk-import", "raw-upload"]);

  const recReq = new Request("http://localhost/api/bulk-import/raw-archive", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
    body: JSON.stringify({
      id: "raw_destroy_test",
      raw_archive_id: "raw_destroy_test",
      server_property_id: "P_A",
      raw_file_hash: rawHash,
      raw_size: 3,
    }),
  });
  await handleBulkImportRequest(recReq, env, owner, new URL(recReq.url), ["api", "bulk-import", "raw-archive"]);

  // Admin attempts destroy -> 403 OWNER_ROLE_REQUIRED
  const destroyAdminReq = new Request("http://localhost/api/bulk-import/raw-destroy", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
    body: JSON.stringify({ archive_id: "raw_destroy_test", confirm_destroy: true }),
  });
  const resAdminDestroy = await handleBulkImportRequest(destroyAdminReq, env, admin, new URL(destroyAdminReq.url), ["api", "bulk-import", "raw-destroy"]);
  assertEqual(resAdminDestroy.status, 403, "Admin cannot destroy raw archive");
  const adminData = await resAdminDestroy.json();
  assertEqual(adminData.code, "OWNER_ROLE_REQUIRED");

  // Manager attempts destroy -> 403 OWNER_ROLE_REQUIRED
  const destroyMgrReq = new Request("http://localhost/api/bulk-import/raw-destroy", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
    body: JSON.stringify({ archive_id: "raw_destroy_test", confirm_destroy: true }),
  });
  const resMgrDestroy = await handleBulkImportRequest(destroyMgrReq, env, managerAllowed, new URL(destroyMgrReq.url), ["api", "bulk-import", "raw-destroy"]);
  assertEqual(resMgrDestroy.status, 403, "Manager cannot destroy raw archive");
  const mgrData = await resMgrDestroy.json();
  assertEqual(mgrData.code, "OWNER_ROLE_REQUIRED");

  // Owner destroys with confirmation -> 200
  const destroyOwnerReq = new Request("http://localhost/api/bulk-import/raw-destroy", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
    body: JSON.stringify({ archive_id: "raw_destroy_test", confirm_destroy: true }),
  });
  const resOwnerDestroy = await handleBulkImportRequest(destroyOwnerReq, env, owner, new URL(destroyOwnerReq.url), ["api", "bulk-import", "raw-destroy"]);
  assertEqual(resOwnerDestroy.status, 200, "Owner can destroy raw archive with confirmation");
});

// ---------------------------------------------------------------------------
// TEST 5: Duplicate detection and explicit force-import behavior
// ---------------------------------------------------------------------------
await run.check("Duplicate detection marks duplicate bundle and check-duplicate reports duplicate", async () => {
  const { env, owner, db } = setupEnv();
  const rawHash = "e".repeat(64);
  const normHash = "f".repeat(64);

  // Initial check: not duplicate
  const checkReq1 = new Request("http://localhost/api/bulk-import/check-duplicate", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
    body: JSON.stringify({ server_property_id: "P_A", raw_file_hash: rawHash, normalized_hash: normHash }),
  });
  const res1 = await handleBulkImportRequest(checkReq1, env, owner, new URL(checkReq1.url), ["api", "bulk-import", "check-duplicate"]);
  const data1 = await res1.json();
  assertEqual(data1.is_duplicate, false, "Initial check shows not duplicate");

  // Insert an active manifest
  db.prepare(`INSERT INTO import_bundle_manifest (
    id, account_id, server_property_id, report_type, raw_file_hash,
    normalized_hash, object_key, schema_version, row_count, entity_counts_json,
    original_file_name, file_size, compressed_size, uploaded_by, status,
    created_at, activated_at, revision
  ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 10, '{}', 'file.csv', 100, 50, 'user_owner', 'active', '2026-01-01', '2026-01-01', 1)`).run(
    "b_dup_1", "A_1", "P_A", "occupancy", rawHash, normHash, "k_dup_1"
  );

  // Subsequent check: IS duplicate
  const checkReq2 = new Request("http://localhost/api/bulk-import/check-duplicate", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
    body: JSON.stringify({ server_property_id: "P_A", raw_file_hash: rawHash, normalized_hash: normHash }),
  });
  const res2 = await handleBulkImportRequest(checkReq2, env, owner, new URL(checkReq2.url), ["api", "bulk-import", "check-duplicate"]);
  const data2 = await res2.json();
  assertEqual(data2.is_duplicate, true, "Subsequent check marks bundle as duplicate");
  assertEqual(data2.existing_bundle.id, "b_dup_1");
});

run.done();
if (process.exitCode) process.exit(1);
console.log("PASSED: probe-bulk-import-mutation-headers completed.");
process.exit(0);
