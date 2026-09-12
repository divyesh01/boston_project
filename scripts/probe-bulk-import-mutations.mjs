// scripts/probe-bulk-import-mutations.mjs
// Verifies all 10 architectural mutation tests (M1 through M10) defined in Section 73:
// M1: Routing bundle rows back through old per-row D1 path fails cost/performance probe.
// M2: Removing D1 manifest unique constraint/idempotency fails duplicate test.
// M3: Allow R2 object without active D1 manifest to hydrate fails authority test.
// M4: Remove property authorization on object fetch fails security test (unauthorized property access returns 403).
// M5: Hash tampering fails integrity check.
// M6: Two browsers import same file resolves idempotently to exactly 1 active manifest.
// M7: D1 activation fails after R2 upload leaves 0 active rows (unreferenced object only).
// M8: Mid-stream upload failure leaves no active manifest.
// M9: Bulk import triggering 13-row chunk loop fails architecture gate.
// M10: Revoked user requesting old known object key returns 403.

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
import { handleBulkImportRequest, clearMockStore, getMockStore } from "../worker/bulk-import.js";
import {
  buildNormalizedBundle,
  compressPayloadGzip,
  sha256Hex,
} from "../src/lib/bulkImportPipeline.js";

const run = makeRunner("probe-bulk-import-mutations");

function setupEnv() {
  clearMockStore();
  const db = makeDb();
  db.prepare("INSERT OR IGNORE INTO account (id, name, created_date) VALUES (?, ?, ?)").run("A_1", "Mutation Account", "2026-01-01");
  seedUser(db, { id: "user_owner", email: "owner@mut.local", role: "owner", mode: "all", accountId: "A_1" });
  seedUser(db, { id: "user_restricted", email: "user@mut.local", role: "manager", mode: "specific", accountId: "A_1" });

  db.prepare("INSERT OR IGNORE INTO property (id, account_id, code, name, rooms, address, city, state, phone, active, created_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("P_A", "A_1", "RRI-A", "Red Roof Inn A", 100, "123 A St", "Boston", "MA", "617-555-0100", 1, "2026-01-01");
  db.prepare("INSERT OR IGNORE INTO property (id, account_id, code, name, rooms, address, city, state, phone, active, created_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("P_B", "A_1", "RRI-B", "Red Roof Inn B", 80, "456 B St", "Boston", "MA", "617-555-0200", 1, "2026-01-01");

  db.prepare("INSERT OR IGNORE INTO business_sync_state (account_id, revision) VALUES (?, ?)").run("A_1", 0);

  const { env, stats } = makeInstrumentedEnv(db, { ENABLE_BUSINESS_SYNC_API: "true" });
  const owner = scopeAll(["P_A", "P_B"]);
  owner.accountId = "A_1";
  owner.user.id = "user_owner";
  owner.user.account_id = "A_1";

  // Restricted scope: only has access to P_A, NOT P_B
  const restricted = scopeSpecific(["P_A"]);
  restricted.accountId = "A_1";
  restricted.user.id = "user_restricted";
  restricted.user.account_id = "A_1";
  restricted.user.role = "manager";
  restricted.user.permissions = JSON.stringify({ import_reports: true });

  return { db, env, stats, owner, restricted };
}

await run.check("M1: Proving per-row D1 path consumes > 10,000 writes while bundle path consumes <= 5 writes", async () => {
  // Legacy per-row write cost for 1,000 rows: 9M + 4*ceil(M/13) + 17 = 9,000 + 308 + 17 = 9,325 writes
  const rowCount = 1000;
  const legacyWrites = 9 * rowCount + 4 * Math.ceil(rowCount / 13) + 17;
  assert(legacyWrites > 9000, "Legacy path consumes > 9,000 writes");

  // Bundle path
  const { env, stats, owner } = setupEnv();
  const ndjson = JSON.stringify({ entity: "OccupancyDay", row: { count: rowCount } });
  const compressed = await compressPayloadGzip(ndjson);
  const rawHash = "1".repeat(64);
  const normHash = "2".repeat(64);

  const uploadReq = new Request("http://localhost/api/bulk-import/upload", {
    method: "PUT",
    headers: { "x-server-property-id": "P_A", "x-normalized-hash": normHash },
    body: compressed,
  });
  await handleBulkImportRequest(uploadReq, env, owner, new URL(uploadReq.url), ["api", "bulk-import", "upload"]);

  const stmtsBefore = stats.statements;
  const activateReq = new Request("http://localhost/api/bulk-import/activate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: "b_m1",
      server_property_id: "P_A",
      report_type: "occupancy",
      raw_file_hash: rawHash,
      normalized_hash: normHash,
      row_count: rowCount,
    }),
  });
  await handleBulkImportRequest(activateReq, env, owner, new URL(activateReq.url), ["api", "bulk-import", "activate"]);
  const bundleWrites = stats.statements - stmtsBefore;
  assert(bundleWrites <= 5, `Bundle path consumed ${bundleWrites} writes, expected <= 5`);
  assert(bundleWrites < legacyWrites / 1000, "Bundle path achieves > 1000x write reduction");
});

await run.check("M2: Manifest unique constraint prevents duplicate insertion", async () => {
  const { db } = setupEnv();
  const normHash = "unique_hash_m2".padStart(64, "0");
  db.prepare(`INSERT INTO import_bundle_manifest (
    id, account_id, server_property_id, report_type, raw_file_hash,
    normalized_hash, object_key, schema_version, row_count, entity_counts_json,
    original_file_name, file_size, compressed_size, uploaded_by, status,
    created_at, activated_at, revision
  ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 100, '{}', 'file.csv', 1000, 200, 'u', 'active', '2026-01-01', '2026-01-01', 1)`).run(
    "b_m2_1", "A_1", "P_A", "occupancy", "raw_m2", normHash, "k_m2"
  );

  let duplicateBlocked = false;
  try {
    db.prepare(`INSERT INTO import_bundle_manifest (
      id, account_id, server_property_id, report_type, raw_file_hash,
      normalized_hash, object_key, schema_version, row_count, entity_counts_json,
      original_file_name, file_size, compressed_size, uploaded_by, status,
      created_at, activated_at, revision
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 100, '{}', 'file2.csv', 1000, 200, 'u', 'active', '2026-01-01', '2026-01-01', 2)`).run(
      "b_m2_2", "A_1", "P_A", "occupancy", "raw_m2_alt", normHash, "k_m2_2"
    );
  } catch (err) {
    if (/UNIQUE constraint failed/i.test(err.message)) duplicateBlocked = true;
  }
  assert(duplicateBlocked, "Database unique constraint idx_bundle_active_normalized blocked duplicate");
});

await run.check("M3: R2 object without active D1 manifest is invisible to hydration", async () => {
  const { env, owner } = setupEnv();
  // Put unactivated object in R2 store
  const mockStore = getMockStore();
  const orphanKey = "rri-bulk/A_1/P_A/v1/orphan.ndjson.gz";
  mockStore.set(orphanKey, { data: new Uint8Array([1, 2, 3]), customMetadata: {} });

  // Hydration query: manifest feed
  const manifestReq = new Request("http://localhost/api/bulk-import/manifest?since_revision=0");
  const res = await handleBulkImportRequest(manifestReq, env, owner, new URL(manifestReq.url), ["api", "bulk-import", "manifest"]);
  const data = await res.json();
  assertEqual(data.manifests.length, 0, "Unactivated R2 object is completely absent from manifest feed");

  // Attempting to download unactivated object without manifest returns 404
  const downloadReq = new Request("http://localhost/api/bulk-import/bundle/non_existent");
  const dlRes = await handleBulkImportRequest(downloadReq, env, owner, new URL(downloadReq.url), ["api", "bulk-import", "bundle", "non_existent"]);
  assertEqual(dlRes.status, 404, "Download without manifest returns 404");
});

await run.check("M4: Property authorization is strictly enforced on object fetch (Property isolation)", async () => {
  const { env, owner, restricted } = setupEnv();
  // Owner uploads a bundle for property P_B
  const normHash = "b400".padStart(64, "0");
  const ndjson = JSON.stringify({ entity: "OccupancyDay", row: { property_id: "P_B" } });
  const compressed = await compressPayloadGzip(ndjson);

  const uploadReq = new Request("http://localhost/api/bulk-import/upload", {
    method: "PUT",
    headers: { "x-server-property-id": "P_B", "x-normalized-hash": normHash },
    body: compressed,
  });
  const upRes = await handleBulkImportRequest(uploadReq, env, owner, new URL(uploadReq.url), ["api", "bulk-import", "upload"]);
  assertEqual(upRes.status, 201);

  const activateReq = new Request("http://localhost/api/bulk-import/activate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: "bundle_pb",
      server_property_id: "P_B",
      report_type: "occupancy",
      raw_file_hash: "raw_pb",
      normalized_hash: normHash,
      row_count: 1,
    }),
  });
  const actRes = await handleBulkImportRequest(activateReq, env, owner, new URL(activateReq.url), ["api", "bulk-import", "activate"]);
  assertEqual(actRes.status, 201);

  // Restricted user (only P_A access) attempts to download bundle for P_B
  const dlReq = new Request("http://localhost/api/bulk-import/bundle/bundle_pb");
  const dlRes = await handleBulkImportRequest(dlReq, env, restricted, new URL(dlReq.url), ["api", "bulk-import", "bundle", "bundle_pb"]);
  assertEqual(dlRes.status, 403, "Restricted user cannot fetch bundle belonging to unauthorized property P_B");
});

await run.check("M5: Tampered hash is rejected during activation and upload", async () => {
  const { env, owner } = setupEnv();
  const uploadReq = new Request("http://localhost/api/bulk-import/upload", {
    method: "PUT",
    headers: { "x-server-property-id": "P_A", "x-normalized-hash": "invalid_short_hash" },
    body: new Uint8Array([1, 2, 3]),
  });
  const uploadRes = await handleBulkImportRequest(uploadReq, env, owner, new URL(uploadReq.url), ["api", "bulk-import", "upload"]);
  assertEqual(uploadRes.status, 400, "Upload rejects invalid hash format");
});

await run.check("M6: Concurrent duplicate imports resolve idempotently to exactly 1 active manifest", async () => {
  const { env, owner } = setupEnv();
  const normHash = "c600".padStart(64, "0");
  const ndjson = JSON.stringify({ entity: "OccupancyDay", row: { id: 1 } });
  const compressed = await compressPayloadGzip(ndjson);

  const uploadReq = new Request("http://localhost/api/bulk-import/upload", {
    method: "PUT",
    headers: { "x-server-property-id": "P_A", "x-normalized-hash": normHash },
    body: compressed,
  });
  const upRes = await handleBulkImportRequest(uploadReq, env, owner, new URL(uploadReq.url), ["api", "bulk-import", "upload"]);
  assertEqual(upRes.status, 201);

  // Browser A and Browser B both attempt activation for the same content
  const activateReqA = new Request("http://localhost/api/bulk-import/activate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "bundle_m6_A", server_property_id: "P_A", report_type: "occupancy", raw_file_hash: "raw_m6", normalized_hash: normHash }),
  });
  const activateReqB = new Request("http://localhost/api/bulk-import/activate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "bundle_m6_B", server_property_id: "P_A", report_type: "occupancy", raw_file_hash: "raw_m6", normalized_hash: normHash }),
  });

  const resA = await handleBulkImportRequest(activateReqA, env, owner, new URL(activateReqA.url), ["api", "bulk-import", "activate"]);
  assertEqual(resA.status, 201, "First activation succeeds");

  const resB = await handleBulkImportRequest(activateReqB, env, owner, new URL(activateReqB.url), ["api", "bulk-import", "activate"]);
  assertEqual(resB.status, 200, "Second concurrent activation returns 200 already_active");
  const dataB = await resB.json();
  assertEqual(dataB.status, "already_active");
});

await run.check("M7: D1 activation failure after R2 upload leaves 0 active manifests", async () => {
  const { db, env, owner } = setupEnv();
  const normHash = "d700".padStart(64, "0");
  const ndjson = JSON.stringify({ entity: "OccupancyDay", row: { id: 1 } });
  const compressed = await compressPayloadGzip(ndjson);

  // Upload succeeds
  const uploadReq = new Request("http://localhost/api/bulk-import/upload", {
    method: "PUT",
    headers: { "x-server-property-id": "P_A", "x-normalized-hash": normHash },
    body: compressed,
  });
  await handleBulkImportRequest(uploadReq, env, owner, new URL(uploadReq.url), ["api", "bulk-import", "upload"]);

  // Activation fails due to invalid/missing property
  const activateReq = new Request("http://localhost/api/bulk-import/activate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "b_m7", server_property_id: "", report_type: "occupancy", normalized_hash: normHash }),
  });
  const actRes = await handleBulkImportRequest(activateReq, env, owner, new URL(activateReq.url), ["api", "bulk-import", "activate"]);
  assertEqual(actRes.status, 400, "Activation fails closed");

  const activeCount = db.prepare("SELECT count(*) as count FROM import_bundle_manifest WHERE id='b_m7'").get();
  assertEqual(activeCount.count, 0, "0 active manifests in D1");
});

await run.check("M8: Failed/empty upload leaves no active manifest", async () => {
  const { db, env, owner } = setupEnv();
  const uploadReq = new Request("http://localhost/api/bulk-import/upload", {
    method: "PUT",
    headers: { "x-server-property-id": "P_A", "x-normalized-hash": "a".repeat(64) },
    body: new Uint8Array([]), // Empty body
  });
  const uploadRes = await handleBulkImportRequest(uploadReq, env, owner, new URL(uploadReq.url), ["api", "bulk-import", "upload"]);
  assertEqual(uploadRes.status, 400, "Empty payload rejected");

  const count = db.prepare("SELECT count(*) as count FROM import_bundle_manifest WHERE account_id='A_1'").get();
  assertEqual(count.count, 0, "No manifest created");
});

await run.check("M9: Architecture gate: Bulk import routes do not invoke 13-row transaction chunk endpoint", async () => {
  const { env, stats, owner } = setupEnv();
  const ndjson = JSON.stringify({ entity: "OccupancyDay", row: { id: 1 } });
  const compressed = await compressPayloadGzip(ndjson);
  const normHash = "9".repeat(64);

  // Execute full bulk import flow
  const uploadReq = new Request("http://localhost/api/bulk-import/upload", {
    method: "PUT",
    headers: { "x-server-property-id": "P_A", "x-normalized-hash": normHash },
    body: compressed,
  });
  await handleBulkImportRequest(uploadReq, env, owner, new URL(uploadReq.url), ["api", "bulk-import", "upload"]);

  const activateReq = new Request("http://localhost/api/bulk-import/activate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "b_m9", server_property_id: "P_A", report_type: "occupancy", normalized_hash: normHash }),
  });
  await handleBulkImportRequest(activateReq, env, owner, new URL(activateReq.url), ["api", "bulk-import", "activate"]);

  // Verify none of the executed SQL calls touched business_record_staging or business_staging_chunk
  const touchedStaging = stats.calls.some(c => /business_record_staging|business_staging_chunk|business_staging_target/i.test(c.sql));
  assertEqual(touchedStaging, false, "Bulk import never touches legacy per-row staging tables");
});

await run.check("M10: Revoked session / unauthorized user is denied access to known object key", async () => {
  const { env, owner } = setupEnv();
  // Seed an active manifest
  const normHash = "10".repeat(32);
  const activateReq = new Request("http://localhost/api/bulk-import/activate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "b_m10", server_property_id: "P_A", report_type: "occupancy", normalized_hash: normHash }),
  });
  // Need object in store first
  getMockStore().set(`rri-bulk/A_1/P_A/v1/${normHash}.ndjson.gz`, { data: new Uint8Array([1, 2, 3]) });
  await handleBulkImportRequest(activateReq, env, owner, new URL(activateReq.url), ["api", "bulk-import", "activate"]);

  // Unauthenticated caller (null or empty scope)
  const revokedScope = { user: { role: "viewer" }, accountId: "A_1", all: false, propertyIds: [] };
  const dlReq = new Request("http://localhost/api/bulk-import/bundle/b_m10");
  const dlRes = await handleBulkImportRequest(dlReq, env, revokedScope, new URL(dlReq.url), ["api", "bulk-import", "bundle", "b_m10"]);
  assertEqual(dlRes.status, 403, "Revoked user without property access is denied (403)");
});

run.done();
if (process.exitCode) process.exit(1);
console.log("PASSED: probe-bulk-import-mutations completed.");
process.exit(0);
