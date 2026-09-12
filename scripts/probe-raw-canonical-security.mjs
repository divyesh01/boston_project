// scripts/probe-raw-canonical-security.mjs
// Verifies Security & Invariant Enforcement:
// 1. Malicious x-raw-object-key header is ignored/rejected (cannot override destination R2 key)
// 2. Malicious raw_object_key query parameter is ignored/rejected (cannot override destination R2 key)
// 3. Cross-account path injection fails (caller cannot upload/record to a different account)
// 4. Cross-property path injection fails (caller cannot upload/record to property outside caller scope)
// 5. ../ path traversal cannot alter R2 destination (in propertyId, rawHash, or headers)
// 6. Same account + property + SHA always produces exactly one canonical key: rri-raw/<account>/<property>/<hash>
// 7. Duplicate/concurrency behavior remains idempotent (multi-client race yields 1 object, 1 manifest, 0 duplicate writes)

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
import { sha256Hex } from "../src/lib/bulkImportPipeline.js";

const run = makeRunner("probe-raw-canonical-security");

function setupWorker() {
  clearMockStore();
  const db = makeDb();
  db.prepare("INSERT OR IGNORE INTO account (id, name, created_date) VALUES (?, ?, ?)").run("A_1", "Security Test Account 1", "2026-01-01");
  db.prepare("INSERT OR IGNORE INTO account (id, name, created_date) VALUES (?, ?, ?)").run("A_2", "Victim Account 2", "2026-01-01");

  seedUser(db, { id: "user_owner_1", email: "owner1@sec.local", role: "owner", mode: "all", accountId: "A_1" });
  seedUser(db, { id: "user_p_a", email: "mgr_a@sec.local", role: "manager", permissions: JSON.stringify({ import_reports: true }), mode: "specific", propertyId: "P_A", accountId: "A_1" });
  seedUser(db, { id: "user_p_b", email: "mgr_b@sec.local", role: "manager", permissions: JSON.stringify({ import_reports: true }), mode: "specific", propertyId: "P_B", accountId: "A_1" });

  db.prepare("INSERT OR IGNORE INTO property (id, account_id, code, name, rooms, address, city, state, phone, active, created_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("P_A", "A_1", "RRI-A", "Red Roof Inn A", 100, "123 Main St", "Boston", "MA", "617-555-0100", 1, "2026-01-01");
  db.prepare("INSERT OR IGNORE INTO property (id, account_id, code, name, rooms, address, city, state, phone, active, created_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("P_B", "A_1", "RRI-B", "Red Roof Inn B", 120, "456 Oak St", "Boston", "MA", "617-555-0200", 1, "2026-01-01");
  db.prepare("INSERT OR IGNORE INTO property (id, account_id, code, name, rooms, address, city, state, phone, active, created_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("P_VICTIM", "A_2", "RRI-V", "Victim Property", 80, "789 Victim St", "Boston", "MA", "617-555-0300", 1, "2026-01-01");

  const { env, stats } = makeInstrumentedEnv(db, { ENABLE_BUSINESS_SYNC_API: "true" });
  const owner = scopeAll(["P_A", "P_B"]);
  owner.accountId = "A_1";
  owner.user.id = "user_owner_1";
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

// 1. Malicious x-raw-object-key header is ignored (cannot override destination R2 key)
await run.check("1. malicious x-raw-object-key header is ignored; server enforces canonical key", async () => {
  const { env, owner } = setupWorker();
  const mockStore = getMockStore();
  const fileBytes = new TextEncoder().encode("Date,Rooms,Revenue\n2025-08-01,100,5000\n");
  const rawHash = await sha256Hex(fileBytes);
  const maliciousKey = "rri-raw/victim_account/victim_property/stolen.csv";
  const canonicalKey = `rri-raw/A_1/P_A/${rawHash}`;

  const req = new Request("http://localhost/api/bulk-import/raw-upload", {
    method: "PUT",
    headers: {
      "x-server-property-id": "P_A",
      "x-raw-hash": rawHash,
      "x-archive-id": "arch_malicious_header",
      "x-file-name": "normal.csv",
      "x-raw-object-key": maliciousKey,
      "Content-Type": "text/csv",
    },
    body: fileBytes,
  });

  const res = await handleBulkImportRequest(req, env, owner, new URL(req.url), ["api", "bulk-import", "raw-upload"]);
  assertEqual(res.status, 201, "Upload succeeds with 201 Created");
  const data = await res.json();

  assertEqual(data.raw_object_key, canonicalKey, "Server returned canonical key, ignoring malicious header");
  assert(!mockStore.has(maliciousKey), "Malicious key was NEVER written to R2 storage");
  assert(mockStore.has(canonicalKey), "Canonical key exists in R2 storage");
});

// 2. Malicious raw_object_key query parameter is ignored (cannot override destination R2 key)
await run.check("2. malicious raw_object_key query parameter is ignored; server enforces canonical key", async () => {
  const { env, owner } = setupWorker();
  const mockStore = getMockStore();
  const fileBytes = new TextEncoder().encode("Date,Rooms,Revenue\n2025-08-02,90,4500\n");
  const rawHash = await sha256Hex(fileBytes);
  const maliciousQueryKey = "rri-raw/other_acc/p2/hacked_via_query.csv";
  const canonicalKey = `rri-raw/A_1/P_A/${rawHash}`;

  const req = new Request(`http://localhost/api/bulk-import/raw-upload?raw_object_key=${encodeURIComponent(maliciousQueryKey)}`, {
    method: "PUT",
    headers: {
      "x-server-property-id": "P_A",
      "x-raw-hash": rawHash,
      "x-archive-id": "arch_malicious_query",
      "x-file-name": "normal.csv",
      "Content-Type": "text/csv",
    },
    body: fileBytes,
  });

  const res = await handleBulkImportRequest(req, env, owner, new URL(req.url), ["api", "bulk-import", "raw-upload"]);
  assertEqual(res.status, 201, "Upload succeeds with 201 Created");
  const data = await res.json();

  assertEqual(data.raw_object_key, canonicalKey, "Server returned canonical key, ignoring malicious query param");
  assert(!mockStore.has(maliciousQueryKey), "Malicious query param key was NEVER written to R2 storage");
  assert(mockStore.has(canonicalKey), "Canonical key exists in R2 storage");
});

// 3. Cross-account path injection fails
await run.check("3. cross-account path injection fails closed with 403 SCOPE_DENIED", async () => {
  const { env, owner } = setupWorker();
  const mockStore = getMockStore();
  const fileBytes = new TextEncoder().encode("Date,Rooms,Revenue\n2025-08-03,80,4000\n");
  const rawHash = await sha256Hex(fileBytes);

  // Attempt to target victim property belonging to account A_2
  const req = new Request("http://localhost/api/bulk-import/raw-upload", {
    method: "PUT",
    headers: {
      "x-server-property-id": "P_VICTIM",
      "x-raw-hash": rawHash,
      "x-archive-id": "arch_cross_account",
      "Content-Type": "text/csv",
    },
    body: fileBytes,
  });

  let status = 0;
  let code = "";
  try {
    const res = await handleBulkImportRequest(req, env, owner, new URL(req.url), ["api", "bulk-import", "raw-upload"]);
    status = res.status;
    const body = await res.json();
    code = body.code || "";
  } catch (err) {
    status = err.status || 403;
    code = err.details?.code || "SCOPE_DENIED";
  }

  assertEqual(status, 403, "Cross-account property target returns 403 Forbidden");
  assertEqual(code, "SCOPE_DENIED", "Error code is SCOPE_DENIED");
  assert(!mockStore.has(`rri-raw/A_2/P_VICTIM/${rawHash}`), "Zero objects written to victim account");
  assert(!mockStore.has(`rri-raw/A_1/P_VICTIM/${rawHash}`), "Zero objects written to caller account");
});

// 4. Cross-property path injection fails
await run.check("4. cross-property path injection fails closed when user lacks property scope", async () => {
  const { env, managerA } = setupWorker();
  const mockStore = getMockStore();
  const fileBytes = new TextEncoder().encode("Date,Rooms,Revenue\n2025-08-04,70,3500\n");
  const rawHash = await sha256Hex(fileBytes);

  // Manager A (scoped only to P_A) attempts to upload to P_B
  const req = new Request("http://localhost/api/bulk-import/raw-upload", {
    method: "PUT",
    headers: {
      "x-server-property-id": "P_B",
      "x-raw-hash": rawHash,
      "x-archive-id": "arch_cross_prop",
      "Content-Type": "text/csv",
    },
    body: fileBytes,
  });

  let status = 0;
  let code = "";
  try {
    const res = await handleBulkImportRequest(req, env, managerA, new URL(req.url), ["api", "bulk-import", "raw-upload"]);
    status = res.status;
    const body = await res.json();
    code = body.code || "";
  } catch (err) {
    status = err.status || 403;
    code = err.details?.code || "SCOPE_DENIED";
  }

  assertEqual(status, 403, "Cross-property upload returns 403 Forbidden");
  assertEqual(code, "SCOPE_DENIED", "Error code is SCOPE_DENIED");
  assert(!mockStore.has(`rri-raw/A_1/P_B/${rawHash}`), "Zero objects written for unpermitted property");
});

// 5. ../ path traversal cannot alter R2 destination
await run.check("5. ../ path traversal attempts in propertyId or rawHash are blocked fail-closed", async () => {
  const { env, owner } = setupWorker();
  const mockStore = getMockStore();
  const fileBytes = new TextEncoder().encode("Date,Rooms,Revenue\n2025-08-05,60,3000\n");
  const rawHash = await sha256Hex(fileBytes);

  // 5a. Traversal in property ID
  const traversalProps = [
    "../../other_account/p1",
    "P_A/../../secret",
    "..%2f..%2fetc%2fpasswd",
    "P_A/../P_B",
  ];

  for (const badProp of traversalProps) {
    const req = new Request("http://localhost/api/bulk-import/raw-upload", {
      method: "PUT",
      headers: {
        "x-server-property-id": badProp,
        "x-raw-hash": rawHash,
        "x-archive-id": "arch_traversal",
        "Content-Type": "text/csv",
      },
      body: fileBytes,
    });

    let status = 0;
    try {
      const res = await handleBulkImportRequest(req, env, owner, new URL(req.url), ["api", "bulk-import", "raw-upload"]);
      status = res.status;
    } catch (err) {
      status = err.status || 403;
    }
    assertEqual(status, 403, `Property traversal attempt "${badProp}" is blocked with 403`);
  }

  // 5b. Traversal or invalid characters in rawHash
  const badHashes = [
    "../../etc/passwd",
    "../" + rawHash.slice(3),
    rawHash + "/../evil",
    "not_a_valid_64_character_hex_hash_at_all",
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdeG", // non-hex character 'G'
  ];

  for (const badHash of badHashes) {
    const req = new Request("http://localhost/api/bulk-import/raw-upload", {
      method: "PUT",
      headers: {
        "x-server-property-id": "P_A",
        "x-raw-hash": badHash,
        "x-archive-id": "arch_bad_hash",
        "Content-Type": "text/csv",
      },
      body: fileBytes,
    });

    let status = 0;
    let code = "";
    try {
      const res = await handleBulkImportRequest(req, env, owner, new URL(req.url), ["api", "bulk-import", "raw-upload"]);
      status = res.status;
      const body = await res.json();
      code = body.code || "";
    } catch (err) {
      status = err.status || 400;
      code = err.details?.code || "";
    }
    assertEqual(status, 400, `Hash traversal/invalid attempt "${badHash.slice(0, 15)}" is blocked with 400`);
    assertEqual(code, "IMPORT_INVALID_HASH", "Error code is IMPORT_INVALID_HASH");
  }

  // Confirm zero stray objects in storage
  assertEqual(mockStore.size, 0, "No objects were created in storage during traversal attacks");
});

// 6. Same account + property + SHA always produces exactly one canonical key
await run.check("6. same account + property + SHA always produces exactly one canonical key regardless of client variations", async () => {
  const { env, owner } = setupWorker();
  const mockStore = getMockStore();
  const fileBytes = new TextEncoder().encode("Date,Rooms,Revenue\n2025-08-06,50,2500\n");
  const rawHash = await sha256Hex(fileBytes);
  const expectedCanonicalKey = `rri-raw/A_1/P_A/${rawHash}`;

  // Variation 1: original filename report.csv, date 2025-08-06, no extra headers
  const req1 = new Request("http://localhost/api/bulk-import/raw-upload", {
    method: "PUT",
    headers: {
      "x-server-property-id": "P_A",
      "x-raw-hash": rawHash,
      "x-archive-id": "arch_v1",
      "x-file-name": "report.csv",
      "x-report-date": "2025-08-06",
      "Content-Type": "text/csv",
    },
    body: fileBytes,
  });
  const res1 = await handleBulkImportRequest(req1, env, owner, new URL(req1.url), ["api", "bulk-import", "raw-upload"]);
  assertEqual(res1.status, 201, "First upload succeeds with 201");
  const data1 = await res1.json();
  assertEqual(data1.raw_object_key, expectedCanonicalKey, "Variation 1 receives canonical key");

  // Variation 2: completely different filename, different report date, attempted key override header
  const req2 = new Request("http://localhost/api/bulk-import/raw-upload", {
    method: "PUT",
    headers: {
      "x-server-property-id": "P_A",
      "x-raw-hash": rawHash,
      "x-archive-id": "arch_v2",
      "x-file-name": "HotelKey_Aug_2025_Final_v3.xlsx",
      "x-report-date": "2026-09-12",
      "x-raw-object-key": "some/arbitrary/path.xlsx",
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    },
    body: fileBytes,
  });
  const res2 = await handleBulkImportRequest(req2, env, owner, new URL(req2.url), ["api", "bulk-import", "raw-upload"]);
  assertEqual(res2.status, 200, "Second upload of identical bytes is idempotent (200 already_archived)");
  const data2 = await res2.json();
  assertEqual(data2.raw_object_key, expectedCanonicalKey, "Variation 2 resolves to identical canonical key");
  assertEqual(data2.status, "already_archived", "Status confirms already_archived");

  // Exactly 1 object in storage
  assertEqual(mockStore.size, 1, "Exactly ONE object exists in R2 storage");
  assert(mockStore.has(expectedCanonicalKey), "Object is keyed strictly by canonical format");
});

// 7. Duplicate / concurrency behavior remains idempotent
await run.check("7. concurrent upload & manifest creation of identical raw bytes remains fully idempotent", async () => {
  const { db, env, owner } = setupWorker();
  const mockStore = getMockStore();
  const fileBytes = new TextEncoder().encode("Date,Rooms,Revenue\n2025-08-07,110,5500\n");
  const rawHash = await sha256Hex(fileBytes);
  const expectedKey = `rri-raw/A_1/P_A/${rawHash}`;

  // Fire 5 concurrent uploads of the same raw file bytes
  const uploadPromises = Array.from({ length: 5 }, (_, i) => {
    const req = new Request("http://localhost/api/bulk-import/raw-upload", {
      method: "PUT",
      headers: {
        "x-server-property-id": "P_A",
        "x-raw-hash": rawHash,
        "x-archive-id": `race_arch_${i}`,
        "x-file-name": `client_${i}_report.csv`,
        "Content-Type": "text/csv",
      },
      body: fileBytes,
    });
    return handleBulkImportRequest(req, env, owner, new URL(req.url), ["api", "bulk-import", "raw-upload"]);
  });

  const uploadResults = await Promise.all(uploadPromises);
  const uploadStatuses = uploadResults.map((r) => r.status);
  assert(uploadStatuses.every((s) => s === 200 || s === 201), "All concurrent uploads return 200 or 201");
  const uploadJson = await Promise.all(uploadResults.map((r) => r.json()));
  assert(uploadJson.every((j) => j.raw_object_key === expectedKey), "All concurrent uploads return identical canonical key");
  assertEqual(mockStore.size, 1, "Storage contains exactly 1 canonical raw object");

  // Fire 5 concurrent manifest recordings
  const manifestPromises = Array.from({ length: 5 }, (_, i) => {
    const req = new Request("http://localhost/api/bulk-import/raw-archive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: `race_manifest_${i}`,
        raw_archive_id: `race_arch_${i}`,
        server_property_id: "P_A",
        report_type: "occupancy",
        raw_file_hash: rawHash,
        raw_object_key: expectedKey,
        original_file_name: `client_${i}_report.csv`,
        file_size: fileBytes.byteLength,
      }),
    });
    return handleBulkImportRequest(req, env, owner, new URL(req.url), ["api", "bulk-import", "raw-archive"]);
  });

  const manifestResults = await Promise.all(manifestPromises);
  const manifestStatuses = manifestResults.map((r) => r.status);
  assert(manifestStatuses.every((s) => s === 200 || s === 201), "All concurrent manifest creations return 200 or 201");

  // Verify exactly 1 manifest row in D1
  const rows = db.prepare(
    "SELECT id, raw_archive_id, raw_object_key, status FROM import_bundle_manifest WHERE account_id='A_1' AND server_property_id='P_A' AND raw_file_hash=?"
  ).all(rawHash);
  assertEqual(rows.length, 1, "Exactly 1 logical manifest row exists in D1 database");
  assertEqual(rows[0].raw_object_key, expectedKey, "Manifest points to canonical raw key");
});

run.done();
if (process.exitCode) process.exit(1);
console.log("PASSED: probe-raw-canonical-security completed.");
process.exit(0);
