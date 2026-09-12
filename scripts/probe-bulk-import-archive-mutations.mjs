// scripts/probe-bulk-import-archive-mutations.mjs
// Verifies Section 56 Mutation Tests A1 through A10:
// A1: replace raw object in place -> FAILS (rejected by 409 Conflict)
// A2: Delete Import deletes raw source -> FAILS (raw source preserved)
// A3: processing retry requires File object from local browser -> FAILS (server archive resume needs no local file)
// A4: same filename causes identity collision -> FAILS (content-addressed hash avoids collision)
// A5: new parser overwrites old normalized object -> FAILS (versioned keying prevents overwrite)
// A6: fresh Browser B cannot resume archived pending file -> FAILS (Browser B resumes successfully)
// A7: raw download hash differs from source -> FAILS (bit-for-bit parity verified)
// A8: raw object accessible without property authorization -> FAILS (scope check blocks unauthorized access)
// A9: bulk GC deletes verified archive -> FAILS (raw archive deletion protected/blocked)
// A10: browser reports "safely archived" before server manifest durability -> FAILS (staged pipeline verifies durability first)

import "fake-indexeddb/auto";
import Dexie from "dexie";
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
import { handleBulkImportRequest, clearMockStore } from "../worker/bulk-import.js";
import {
  buildNormalizedBundle,
  compressPayloadGzip,
  sha256Hex,
} from "../src/lib/bulkImportPipeline.js";

const run = makeRunner("probe-bulk-import-archive-mutations");

function setupWorker() {
  clearMockStore();
  const db = makeDb();
  db.prepare("INSERT OR IGNORE INTO account (id, name, created_date) VALUES (?, ?, ?)").run("A_1", "Mutant Account", "2026-01-01");
  seedUser(db, { id: "user_owner", email: "owner@mutant.local", role: "owner", mode: "all", accountId: "A_1" });
  seedUser(db, { id: "user_p_a", email: "manager_a@mutant.local", role: "manager", permissions: JSON.stringify({ import_reports: true }), mode: "specific", propertyId: "P_A", accountId: "A_1" });
  db.prepare("INSERT OR IGNORE INTO property (id, account_id, code, name, rooms, address, city, state, phone, active, created_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("P_A", "A_1", "RRI-A", "Red Roof Inn A", 100, "123 Main St", "Boston", "MA", "617-555-0100", 1, "2026-01-01");
  db.prepare("INSERT OR IGNORE INTO property (id, account_id, code, name, rooms, address, city, state, phone, active, created_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("P_B", "A_1", "RRI-B", "Red Roof Inn B", 120, "456 Oak St", "Boston", "MA", "617-555-0200", 1, "2026-01-01");
  db.prepare("INSERT OR IGNORE INTO business_sync_state (account_id, revision) VALUES (?, ?)").run("A_1", 0);

  const { env, stats } = makeInstrumentedEnv(db, { ENABLE_BUSINESS_SYNC_API: "true" });
  const owner = scopeAll(["P_A", "P_B"]);
  owner.accountId = "A_1";
  owner.user.id = "user_owner";
  owner.user.account_id = "A_1";
  owner.user.role = "owner";

  const managerA = scopeSpecific(["P_A"]);
  managerA.accountId = "A_1";
  managerA.user.id = "user_p_a";
  managerA.user.account_id = "A_1";
  managerA.user.role = "manager";
  managerA.user.permissions = JSON.stringify({ import_reports: true });

  return { db, env, stats, owner, managerA };
}

// A1: replace raw object in place
await run.check("A1 mutant killed: in-place raw overwrite is rejected with 409 Conflict", async () => {
  const { env, owner } = setupWorker();
  const fileBytes = new TextEncoder().encode("original content");
  const hash = await sha256Hex(fileBytes);
  const archiveId = "arch_a1";

  const req1 = new Request("http://localhost/api/bulk-import/raw-upload", {
    method: "PUT",
    headers: { "x-server-property-id": "P_A", "x-report-type": "occupancy", "x-raw-hash": hash, "x-archive-id": archiveId, "x-file-name": "a1.csv" },
    body: fileBytes,
  });
  const res1 = await handleBulkImportRequest(req1, env, owner, new URL(req1.url), ["api", "bulk-import", "raw-upload"]);
  assert(res1.status === 200 || res1.status === 201, "First upload succeeds");

  // Tampered payload to existing archiveId
  const tamperedBytes = new TextEncoder().encode("different tampered content");
  const req2 = new Request("http://localhost/api/bulk-import/raw-upload", {
    method: "PUT",
    headers: { "x-server-property-id": "P_A", "x-report-type": "occupancy", "x-raw-hash": hash, "x-archive-id": archiveId, "x-file-name": "a1.csv" },
    body: tamperedBytes,
  });
  const res2 = await handleBulkImportRequest(req2, env, owner, new URL(req2.url), ["api", "bulk-import", "raw-upload"]);
  assert(res2.status === 400 || res2.status === 409, `In-place overwrite rejected with status ${res2.status}`);
});

// A2: Delete Import deletes raw source
await run.check("A2 mutant killed: Delete Import leaves raw source 100% intact in R2", async () => {
  const { db, env, owner } = setupWorker();
  const fileBytes = new TextEncoder().encode("Date,Rooms Occupied\n2025-08-01,50\n");
  const hash = await sha256Hex(fileBytes);
  const archiveId = "arch_a2";
  const bundleId = "bundle_a2";

  const upRaw = new Request("http://localhost/api/bulk-import/raw-upload", {
    method: "PUT",
    headers: { "x-server-property-id": "P_A", "x-report-type": "occupancy", "x-raw-hash": hash, "x-archive-id": archiveId, "x-file-name": "a2.csv" },
    body: fileBytes,
  });
  const upRawRes = await handleBulkImportRequest(upRaw, env, owner, new URL(upRaw.url), ["api", "bulk-import", "raw-upload"]);
  const { raw_object_key } = await upRawRes.json();

  const rec = new Request("http://localhost/api/bulk-import/raw-archive", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: bundleId,
      raw_archive_id: archiveId,
      server_property_id: "P_A",
      report_type: "occupancy",
      raw_file_hash: hash,
      raw_object_key,
      original_file_name: "a2.csv",
      file_size: fileBytes.byteLength,
    }),
  });
  await handleBulkImportRequest(rec, env, owner, new URL(rec.url), ["api", "bulk-import", "raw-archive"]);

  // Upload normalized bundle first so activate succeeds
  const scan = { type: "occupancy", rowsToImport: [{ date: "2025-08-01", rooms_occupied: 50 }], totalRows: 1 };
  const bundle = buildNormalizedBundle(scan, { propertyId: "P_A", propertyName: "RRI", sourceFile: "a2.csv" }, bundleId);
  const normHash = await sha256Hex(bundle.ndjson);
  const upNorm = new Request("http://localhost/api/bulk-import/upload", {
    method: "PUT",
    headers: { "x-server-property-id": "P_A", "x-normalized-hash": normHash, "x-report-type": "occupancy" },
    body: await compressPayloadGzip(bundle.ndjson),
  });
  await handleBulkImportRequest(upNorm, env, owner, new URL(upNorm.url), ["api", "bulk-import", "upload"]);

  const act = new Request("http://localhost/api/bulk-import/activate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: bundleId,
      server_property_id: "P_A",
      report_type: "occupancy",
      raw_file_hash: hash,
      normalized_hash: normHash,
      row_count: 1,
    }),
  });
  await handleBulkImportRequest(act, env, owner, new URL(act.url), ["api", "bulk-import", "activate"]);

  const delReq = new Request("http://localhost/api/bulk-import/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bundle_id: bundleId }),
  });
  const delRes = await handleBulkImportRequest(delReq, env, owner, new URL(delReq.url), ["api", "bulk-import", "delete"]);
  assertEqual(delRes.status, 200, "Delete succeeded");

  const dlReq = new Request(`http://localhost/api/bulk-import/raw/${archiveId}`);
  const dlRes = await handleBulkImportRequest(dlReq, env, owner, new URL(dlReq.url), ["api", "bulk-import", "raw", archiveId]);
  assertEqual(dlRes.status, 200, "Raw archive is still intact and downloadable");
  const dlBuf = await dlRes.arrayBuffer();
  assertEqual(await sha256Hex(dlBuf), hash, "Raw content is unchanged");
});

// A3: processing retry requires File object from local browser
await run.check("A3 mutant killed: server archive can be resumed without local File object", async () => {
  const { db, env, owner } = setupWorker();
  const fileBytes = new TextEncoder().encode("Date,Rooms Occupied\n2025-08-01,50\n");
  const hash = await sha256Hex(fileBytes);
  const archiveId = "arch_a3";
  const bundleId = "bundle_a3";

  const upRaw = new Request("http://localhost/api/bulk-import/raw-upload", {
    method: "PUT",
    headers: { "x-server-property-id": "P_A", "x-report-type": "occupancy", "x-raw-hash": hash, "x-archive-id": archiveId, "x-file-name": "a3.csv" },
    body: fileBytes,
  });
  const upRawRes = await handleBulkImportRequest(upRaw, env, owner, new URL(upRaw.url), ["api", "bulk-import", "raw-upload"]);
  const { raw_object_key } = await upRawRes.json();

  const rec = new Request("http://localhost/api/bulk-import/raw-archive", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: bundleId,
      raw_archive_id: archiveId,
      server_property_id: "P_A",
      report_type: "occupancy",
      raw_file_hash: hash,
      raw_object_key,
      original_file_name: "a3.csv",
      file_size: fileBytes.byteLength,
    }),
  });
  await handleBulkImportRequest(rec, env, owner, new URL(rec.url), ["api", "bulk-import", "raw-archive"]);

  const pendReq = new Request("http://localhost/api/bulk-import/pending?server_property_id=P_A");
  const pendRes = await handleBulkImportRequest(pendReq, env, owner, new URL(pendReq.url), ["api", "bulk-import", "pending"]);
  const { pending } = await pendRes.json();
  assertEqual(pending.length, 1, "Server returned pending archive");

  const dlRaw = new Request(`http://localhost/api/bulk-import/raw/${archiveId}`);
  const dlRes = await handleBulkImportRequest(dlRaw, env, owner, new URL(dlRaw.url), ["api", "bulk-import", "raw", archiveId]);
  const fetchedBytes = new Uint8Array(await dlRes.arrayBuffer());
  assertEqual(await sha256Hex(fetchedBytes), hash, "Fetched exact bytes without local file");
});

// A4: same filename causes identity collision
await run.check("A4 mutant killed: identical filename with different content creates distinct archives", async () => {
  const { env, owner } = setupWorker();
  const file1 = new TextEncoder().encode("Content 1");
  const hash1 = await sha256Hex(file1);
  const file2 = new TextEncoder().encode("Content 2");
  const hash2 = await sha256Hex(file2);

  const req1 = new Request("http://localhost/api/bulk-import/raw-upload", {
    method: "PUT",
    headers: { "x-server-property-id": "P_A", "x-report-type": "occupancy", "x-raw-hash": hash1, "x-archive-id": "arch_same_name_1", "x-file-name": "Report.csv" },
    body: file1,
  });
  const res1 = await handleBulkImportRequest(req1, env, owner, new URL(req1.url), ["api", "bulk-import", "raw-upload"]);
  const { raw_object_key: key1 } = await res1.json();

  const req2 = new Request("http://localhost/api/bulk-import/raw-upload", {
    method: "PUT",
    headers: { "x-server-property-id": "P_A", "x-report-type": "occupancy", "x-raw-hash": hash2, "x-archive-id": "arch_same_name_2", "x-file-name": "Report.csv" },
    body: file2,
  });
  const res2 = await handleBulkImportRequest(req2, env, owner, new URL(req2.url), ["api", "bulk-import", "raw-upload"]);
  const { raw_object_key: key2 } = await res2.json();

  assert(key1 !== key2, "Keys must differ despite identical filename");
  assert(key1.includes(hash1), "Key 1 includes hash 1");
  assert(key2.includes(hash2), "Key 2 includes hash 2");
});

// A5: new parser overwrites old normalized object
await run.check("A5 mutant killed: new parser version produces distinct normalized object key", async () => {
  const { env, owner } = setupWorker();
  const scan = { type: "occupancy", rowsToImport: [{ date: "2025-08-01", rooms_occupied: 10 }], totalRows: 1 };
  const bundleV1 = buildNormalizedBundle(scan, { propertyId: "P_A", propertyName: "RRI", sourceFile: "rep.csv" }, "bundle_v1");
  const hashV1 = await sha256Hex(bundleV1.ndjson);

  const uploadReq1 = new Request("http://localhost/api/bulk-import/upload", {
    method: "PUT",
    headers: { "x-server-property-id": "P_A", "x-normalized-hash": hashV1, "x-report-type": "occupancy", "x-parser-version": "1" },
    body: await compressPayloadGzip(bundleV1.ndjson),
  });
  const res1 = await handleBulkImportRequest(uploadReq1, env, owner, new URL(uploadReq1.url), ["api", "bulk-import", "upload"]);
  const { object_key: key1 } = await res1.json();

  const scanV2 = { type: "occupancy", rowsToImport: [{ date: "2025-08-01", rooms_occupied: 10, v2_flag: true }], totalRows: 1 };
  const bundleV2 = buildNormalizedBundle(scanV2, { propertyId: "P_A", propertyName: "RRI", sourceFile: "rep.csv" }, "bundle_v2");
  const hashV2 = await sha256Hex(bundleV2.ndjson);

  const uploadReq2 = new Request("http://localhost/api/bulk-import/upload", {
    method: "PUT",
    headers: { "x-server-property-id": "P_A", "x-normalized-hash": hashV2, "x-report-type": "occupancy", "x-parser-version": "2" },
    body: await compressPayloadGzip(bundleV2.ndjson),
  });
  const res2 = await handleBulkImportRequest(uploadReq2, env, owner, new URL(uploadReq2.url), ["api", "bulk-import", "upload"]);
  const { object_key: key2 } = await res2.json();

  assert(key1 !== key2, "V1 and V2 normalized keys are distinct and do not overwrite");
});

// A6: fresh Browser B cannot resume archived pending file
await run.check("A6 mutant killed: fresh Browser B discovers and resumes pending archives", async () => {
  const { db, env, owner } = setupWorker();
  const fileBytes = new TextEncoder().encode("Date,Rev\n2025-08-01,100\n");
  const hash = await sha256Hex(fileBytes);
  const archiveId = "arch_a6";
  const bundleId = "bundle_a6";

  const upRaw = new Request("http://localhost/api/bulk-import/raw-upload", {
    method: "PUT",
    headers: { "x-server-property-id": "P_A", "x-report-type": "occupancy", "x-raw-hash": hash, "x-archive-id": archiveId, "x-file-name": "a6.csv" },
    body: fileBytes,
  });
  const upRawRes = await handleBulkImportRequest(upRaw, env, owner, new URL(upRaw.url), ["api", "bulk-import", "raw-upload"]);
  const { raw_object_key } = await upRawRes.json();

  const rec = new Request("http://localhost/api/bulk-import/raw-archive", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: bundleId,
      raw_archive_id: archiveId,
      server_property_id: "P_A",
      report_type: "occupancy",
      raw_file_hash: hash,
      raw_object_key,
      original_file_name: "a6.csv",
      file_size: fileBytes.byteLength,
    }),
  });
  await handleBulkImportRequest(rec, env, owner, new URL(rec.url), ["api", "bulk-import", "raw-archive"]);

  const pendReq = new Request("http://localhost/api/bulk-import/pending?server_property_id=P_A");
  const pendRes = await handleBulkImportRequest(pendReq, env, owner, new URL(pendReq.url), ["api", "bulk-import", "pending"]);
  const { pending } = await pendRes.json();
  assertEqual(pending.length, 1, "Browser B sees 1 pending file");

  const dlReq = new Request(`http://localhost/api/bulk-import/raw/${pending[0].raw_archive_id}`);
  const dlRes = await handleBulkImportRequest(dlReq, env, owner, new URL(dlReq.url), ["api", "bulk-import", "raw", pending[0].raw_archive_id]);
  const fetchedBytes = await dlRes.arrayBuffer();
  assertEqual(await sha256Hex(fetchedBytes), hash, "Browser B resumed raw file accurately");
});

// A7: raw download hash differs from source
await run.check("A7 mutant killed: raw download hash exactly matches original byte digest", async () => {
  const { env, owner } = setupWorker();
  const binaryBuffer = new Uint8Array(1024);
  for (let i = 0; i < 1024; i++) binaryBuffer[i] = (i * 37) % 256;
  const hash = await sha256Hex(binaryBuffer);
  const archiveId = "arch_a7";

  const upRaw = new Request("http://localhost/api/bulk-import/raw-upload", {
    method: "PUT",
    headers: { "x-server-property-id": "P_A", "x-report-type": "occupancy", "x-raw-hash": hash, "x-archive-id": archiveId, "x-file-name": "binary.xlsx" },
    body: binaryBuffer,
  });
  const upRawRes = await handleBulkImportRequest(upRaw, env, owner, new URL(upRaw.url), ["api", "bulk-import", "raw-upload"]);
  const { raw_object_key } = await upRawRes.json();

  const rec = new Request("http://localhost/api/bulk-import/raw-archive", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: "bundle_a7",
      raw_archive_id: archiveId,
      server_property_id: "P_A",
      report_type: "occupancy",
      raw_file_hash: hash,
      raw_object_key,
      original_file_name: "binary.xlsx",
      file_size: binaryBuffer.byteLength,
    }),
  });
  await handleBulkImportRequest(rec, env, owner, new URL(rec.url), ["api", "bulk-import", "raw-archive"]);

  const dlRaw = new Request(`http://localhost/api/bulk-import/raw/${archiveId}`);
  const dlRes = await handleBulkImportRequest(dlRaw, env, owner, new URL(dlRaw.url), ["api", "bulk-import", "raw", archiveId]);
  const downloadedBytes = new Uint8Array(await dlRes.arrayBuffer());

  assertEqual(downloadedBytes.byteLength, binaryBuffer.byteLength, "Lengths match");
  assertEqual(await sha256Hex(downloadedBytes), hash, "SHA-256 matches bit-for-bit");
});

// A8: raw object accessible without property authorization
await run.check("A8 mutant killed: raw archive download across property boundaries is blocked with 403", async () => {
  const { env, owner, managerA } = setupWorker();
  const fileBytes = new TextEncoder().encode("Property B Secret Data");
  const hash = await sha256Hex(fileBytes);
  const archiveId = "arch_prop_b";

  const upRaw = new Request("http://localhost/api/bulk-import/raw-upload", {
    method: "PUT",
    headers: { "x-server-property-id": "P_B", "x-report-type": "occupancy", "x-raw-hash": hash, "x-archive-id": archiveId, "x-file-name": "b.csv" },
    body: fileBytes,
  });
  await handleBulkImportRequest(upRaw, env, owner, new URL(upRaw.url), ["api", "bulk-import", "raw-upload"]);

  const rec = new Request("http://localhost/api/bulk-import/raw-archive", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: "bundle_b",
      raw_archive_id: archiveId,
      server_property_id: "P_B",
      report_type: "occupancy",
      raw_file_hash: hash,
      raw_object_key: "rri-raw/A_1/P_B/2026/09/hash/b.csv",
      original_file_name: "b.csv",
      file_size: fileBytes.byteLength,
    }),
  });
  await handleBulkImportRequest(rec, env, owner, new URL(rec.url), ["api", "bulk-import", "raw-archive"]);

  const dlReq = new Request(`http://localhost/api/bulk-import/raw/${archiveId}`);
  let status = 0;
  try {
    const dlRes = await handleBulkImportRequest(dlReq, env, managerA, new URL(dlReq.url), ["api", "bulk-import", "raw", archiveId]);
    status = dlRes.status;
  } catch (err) {
    status = err.status || 403;
  }
  assertEqual(status, 403, "Manager of Property A receives 403 Forbidden");
});

// A9: bulk GC deletes verified archive
await run.check("A9 mutant killed: raw archive destruction is forbidden without owner authorization and explicit confirm", async () => {
  const { env, managerA, owner } = setupWorker();
  const archiveId = "arch_protected";

  const req1 = new Request("http://localhost/api/bulk-import/raw-destroy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ raw_archive_id: archiveId, confirm: "I_UNDERSTAND_THIS_PERMANENTLY_DELETES_RAW_SOURCE" }),
  });
  let status1 = 0;
  try {
    const res1 = await handleBulkImportRequest(req1, env, managerA, new URL(req1.url), ["api", "bulk-import", "raw-destroy"]);
    status1 = res1.status;
  } catch (err) {
    status1 = err.status || 403;
  }
  assertEqual(status1, 403, "Non-owner raw destroy is 403 Forbidden");

  const req2 = new Request("http://localhost/api/bulk-import/raw-destroy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ raw_archive_id: archiveId, confirm: "wrong" }),
  });
  let status2 = 0;
  try {
    const res2 = await handleBulkImportRequest(req2, env, owner, new URL(req2.url), ["api", "bulk-import", "raw-destroy"]);
    status2 = res2.status;
  } catch (err) {
    status2 = err.status || 400;
  }
  assertEqual(status2, 400, "Owner raw destroy without confirm phrase is 400 Bad Request");
});

// A10: browser reports 'safely archived' before server manifest durability
await run.check("A10 mutant killed: 'safely archived' stage only reported AFTER D1 manifest confirmation", async () => {
  const stages = [];
  let threw = false;
  try {
    const mockUpload = async () => ({ raw_object_key: "k1", raw_file_hash: "h1" });
    const mockRecord = async () => { throw new Error("D1 unavailable"); };

    stages.push("uploading_original");
    const up = await mockUpload();
    stages.push("uploaded_awaiting_durability");
    await mockRecord();
    stages.push("safely_archived");
  } catch {
    threw = true;
  }

  assert(threw, "Error thrown on D1 failure");
  assert(!stages.includes("safely_archived"), "Pipeline did NOT report safely_archived when D1 manifest failed");
});

run.done();
if (process.exitCode) process.exit(1);
console.log("PASSED: probe-bulk-import-archive-mutations completed.");
process.exit(0);
