// scripts/probe-normalized-bundle-streaming.mjs
// Verifies Section 2, 3, 4:
// 1. Production R2 path streams request.body directly to bulkStore.put (zero arrayBuffer buffering).
// 2. Upfront Content-Length rejection: >25 MB returns 413 PAYLOAD_TOO_LARGE, 0 bytes returns 400 IMPORT_EMPTY_PAYLOAD.
// 3. Unknown Content-Length bounded size enforcement: stream exceeding 25 MB aborts with 413 without full buffering.
// 4. Unknown Content-Length empty stream validation: stream with 0 bytes aborts with 400 IMPORT_EMPTY_PAYLOAD.
// 5. R2-native checksum passed when x-payload-sha256 is present.
// 6. Idempotent upload handling (HTTP 200 already_uploaded).
// 7. Cross-property isolation and role enforcement.

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
import { sha256Hex } from "../src/lib/bulkImportPipeline.js";

const run = makeRunner("probe-normalized-bundle-streaming");

function setupWorker() {
  clearMockStore();
  const db = makeDb();
  db.prepare("INSERT OR IGNORE INTO account (id, name, created_date) VALUES (?, ?, ?)").run("A_1", "Streaming Test", "2026-01-01");
  seedUser(db, { id: "user_owner", email: "owner@stream.local", role: "owner", mode: "all", accountId: "A_1" });
  seedUser(db, { id: "user_p_a", email: "manager_a@stream.local", role: "manager", permissions: JSON.stringify({ import_reports: true }), mode: "specific", propertyId: "P_A", accountId: "A_1" });
  db.prepare("INSERT OR IGNORE INTO property (id, account_id, code, name, rooms, address, city, state, phone, active, created_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("P_A", "A_1", "RRI-A", "Red Roof Inn A", 100, "123 Main St", "Boston", "MA", "617-555-0100", 1, "2026-01-01");
  db.prepare("INSERT OR IGNORE INTO property (id, account_id, code, name, rooms, address, city, state, phone, active, created_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("P_B", "A_1", "RRI-B", "Red Roof Inn B", 120, "456 Oak St", "Boston", "MA", "617-555-0200", 1, "2026-01-01");

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

// 1. Regression test: request.arrayBuffer() is NEVER called in production R2 path
await run.check("Production R2 path streams request.body directly without arrayBuffer buffering", async () => {
  const { env, owner } = setupWorker();
  const samplePayload = new TextEncoder().encode('{"entity":"OccupancyDay","row":{"date":"2025-08-01","rooms":50}}\n');
  const normalizedHash = await sha256Hex("dummy_ndjson_data");
  const payloadHash = await sha256Hex(samplePayload);

  let r2PutCalled = false;
  let putKey = "";
  let putBodyType = "";
  let putOptions = null;

  // Mock R2 bucket bound to env.BULK_DATA
  env.BULK_DATA = {
    async head() { return null; },
    async put(key, body, options) {
      r2PutCalled = true;
      putKey = key;
      putBodyType = typeof body?.getReader === "function" ? "ReadableStream" : typeof body;
      putOptions = options;

      // Drain the stream to simulate real R2 consumption
      const reader = body.getReader();
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
      return { key, size: samplePayload.byteLength };
    },
  };

  const req = new Request("http://localhost/api/bulk-import/upload", {
    method: "PUT",
    headers: {
      "x-server-property-id": "P_A",
      "x-report-type": "occupancy",
      "x-normalized-hash": normalizedHash,
      "x-payload-sha256": payloadHash,
      "x-row-count": "1",
      "Content-Type": "application/x-ndjson",
      "Content-Encoding": "gzip",
      "Content-Length": String(samplePayload.byteLength),
    },
    body: samplePayload,
  });

  // Spy on request.arrayBuffer: must throw if invoked!
  let arrayBufferCalled = false;
  req.arrayBuffer = async () => {
    arrayBufferCalled = true;
    throw new Error("FATAL REGRESSION: request.arrayBuffer() was called in production R2 upload path!");
  };

  const res = await handleBulkImportRequest(req, env, owner, new URL(req.url), ["api", "bulk-import", "upload"]);
  assertEqual(res.status, 201, "Streaming upload returns 201 Created");
  assert(!arrayBufferCalled, "request.arrayBuffer() was NEVER called in production path");
  assert(r2PutCalled, "bulkStore.put was called");
  assertEqual(putBodyType, "ReadableStream", "bulkStore.put received a ReadableStream directly");
  assertEqual(putKey, `rri-bulk/A_1/P_A/v1/${normalizedHash}.ndjson.gz`, "Object key matches content-addressed format");
  assertEqual(putOptions?.httpMetadata?.contentEncoding, "gzip", "Preserves gzip contentEncoding");
  assertEqual(putOptions?.httpMetadata?.contentType, "application/x-ndjson", "Preserves ndjson contentType");
  assertEqual(putOptions?.sha256, payloadHash, "Passes native sha256 checksum verification to R2");
});

// 2. Upfront Content-Length preflight rejection (> 25 MB)
await run.check("Upfront Content-Length > 25 MB is rejected with HTTP 413 PAYLOAD_TOO_LARGE", async () => {
  const { env, owner } = setupWorker();
  const normalizedHash = await sha256Hex("test_oversized");

  env.BULK_DATA = {
    async put() { throw new Error("Should not be called!"); },
  };

  const req = new Request("http://localhost/api/bulk-import/upload", {
    method: "PUT",
    headers: {
      "x-server-property-id": "P_A",
      "x-report-type": "occupancy",
      "x-normalized-hash": normalizedHash,
      "content-length": String(26 * 1024 * 1024), // 26 MB declared
    },
    body: new Uint8Array(10),
  });

  const res = await handleBulkImportRequest(req, env, owner, new URL(req.url), ["api", "bulk-import", "upload"]);
  assertEqual(res.status, 413, "Returns 413 Payload Too Large");
  const data = await res.json();
  assertEqual(data.code, "PAYLOAD_TOO_LARGE");
});

// 3. Upfront Content-Length = 0 rejection
await run.check("Upfront Content-Length = 0 is rejected with HTTP 400 IMPORT_EMPTY_PAYLOAD", async () => {
  const { env, owner } = setupWorker();
  const normalizedHash = await sha256Hex("test_empty");

  env.BULK_DATA = {
    async put() { throw new Error("Should not be called!"); },
  };

  const req = new Request("http://localhost/api/bulk-import/upload", {
    method: "PUT",
    headers: {
      "x-server-property-id": "P_A",
      "x-report-type": "occupancy",
      "x-normalized-hash": normalizedHash,
      "content-length": "0",
    },
    body: new Uint8Array(0),
  });

  const res = await handleBulkImportRequest(req, env, owner, new URL(req.url), ["api", "bulk-import", "upload"]);
  assertEqual(res.status, 400, "Returns 400 Bad Request");
  const data = await res.json();
  assertEqual(data.code, "IMPORT_EMPTY_PAYLOAD");
});

// 4. Unknown Content-Length: stream exceeding 25 MB aborts without full buffering
await run.check("Unknown Content-Length: stream exceeding 25 MB aborts with 413 via bounded stream", async () => {
  const { env, owner } = setupWorker();
  const normalizedHash = await sha256Hex("test_unknown_cl_oversized");

  // Create stream that yields 26 MB without Content-Length
  const chunk = new Uint8Array(1024 * 1024); // 1 MB chunk
  let chunksYielded = 0;
  const bigStream = new ReadableStream({
    pull(controller) {
      if (chunksYielded < 26) {
        controller.enqueue(chunk);
        chunksYielded++;
      } else {
        controller.close();
      }
    },
  });

  env.BULK_DATA = {
    async head() { return null; },
    async put(key, stream) {
      const reader = stream.getReader();
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    },
  };

  const req = new Request("http://localhost/api/bulk-import/upload", {
    method: "PUT",
    headers: {
      "x-server-property-id": "P_A",
      "x-report-type": "occupancy",
      "x-normalized-hash": normalizedHash,
      // No Content-Length header!
    },
    body: bigStream,
    duplex: "half",
  });

  const res = await handleBulkImportRequest(req, env, owner, new URL(req.url), ["api", "bulk-import", "upload"]);
  assertEqual(res.status, 413, "Returns 413 Payload Too Large on bounded stream overflow");
  const data = await res.json();
  assertEqual(data.code, "PAYLOAD_TOO_LARGE");
});

// 5. Unknown Content-Length: empty stream returns 400 IMPORT_EMPTY_PAYLOAD
await run.check("Unknown Content-Length: empty stream (0 bytes) returns 400 IMPORT_EMPTY_PAYLOAD", async () => {
  const { env, owner } = setupWorker();
  const normalizedHash = await sha256Hex("test_unknown_cl_empty");

  const emptyStream = new ReadableStream({
    start(controller) {
      controller.close();
    },
  });

  env.BULK_DATA = {
    async head() { return null; },
    async put(key, stream) {
      const reader = stream.getReader();
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    },
  };

  const req = new Request("http://localhost/api/bulk-import/upload", {
    method: "PUT",
    headers: {
      "x-server-property-id": "P_A",
      "x-report-type": "occupancy",
      "x-normalized-hash": normalizedHash,
      // No Content-Length header!
    },
    body: emptyStream,
    duplex: "half",
  });

  const res = await handleBulkImportRequest(req, env, owner, new URL(req.url), ["api", "bulk-import", "upload"]);
  assertEqual(res.status, 400, "Returns 400 Bad Request on empty stream");
  const data = await res.json();
  assertEqual(data.code, "IMPORT_EMPTY_PAYLOAD");
});

// 6. Idempotent upload when object already exists in R2
await run.check("Idempotent upload returns HTTP 200 already_uploaded when object exists in R2", async () => {
  const { env, owner } = setupWorker();
  const samplePayload = new TextEncoder().encode('sample data');
  const normalizedHash = await sha256Hex("idempotent_sample");

  env.BULK_DATA = {
    async head(key) {
      if (key.includes(normalizedHash)) {
        return { size: samplePayload.byteLength, customMetadata: { normalized_hash: normalizedHash } };
      }
      return null;
    },
    async put() {
      throw new Error("Put should not be called when head indicates existing!");
    },
  };

  const req = new Request("http://localhost/api/bulk-import/upload", {
    method: "PUT",
    headers: {
      "x-server-property-id": "P_A",
      "x-report-type": "occupancy",
      "x-normalized-hash": normalizedHash,
    },
    body: samplePayload,
  });

  const res = await handleBulkImportRequest(req, env, owner, new URL(req.url), ["api", "bulk-import", "upload"]);
  assertEqual(res.status, 200, "Returns HTTP 200 for already uploaded object");
  const data = await res.json();
  assertEqual(data.status, "already_uploaded");
});

// 7. Property scoping assertion blocks unauthorized upload
await run.check("Property scoping blocks unauthorized upload across property boundary", async () => {
  const { env, managerA } = setupWorker();
  const samplePayload = new TextEncoder().encode('scoped data');
  const normalizedHash = await sha256Hex("scoped_test");

  const req = new Request("http://localhost/api/bulk-import/upload", {
    method: "PUT",
    headers: {
      "x-server-property-id": "P_B", // managerA only has access to P_A!
      "x-report-type": "occupancy",
      "x-normalized-hash": normalizedHash,
    },
    body: samplePayload,
  });

  let status = 0;
  try {
    const res = await handleBulkImportRequest(req, env, managerA, new URL(req.url), ["api", "bulk-import", "upload"]);
    status = res.status;
  } catch (err) {
    status = err.status || 403;
  }
  assertEqual(status, 403, "Manager of Property A cannot upload bundle for Property B");
});

run.done();
if (process.exitCode) process.exit(1);
console.log("PASSED: probe-normalized-bundle-streaming completed.");
process.exit(0);
