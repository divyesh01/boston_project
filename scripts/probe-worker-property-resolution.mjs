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
  resolvePropertyKeyFromMappings,
} from "../worker/business-sync.js";

const run = makeRunner("probe-worker-property-resolution");

const db = makeDb();
db.prepare("INSERT INTO account (id,name,created_date) VALUES (?,?,?)").run("A_1", "Account 1", "2026-01-01");
db.prepare("INSERT INTO account (id,name,created_date) VALUES (?,?,?)").run("A_2", "Account 2", "2026-01-01");

seedUser(db, { id: "owner_1", email: "owner1@test.local", role: "owner", mode: "all", account_id: "A_1" });
seedUser(db, { id: "mgr_1", email: "mgr1@test.local", role: "manager", mode: "specific", account_id: "A_1" });

const env = makeEnv(db, { ENABLE_BUSINESS_SYNC_API: "true" });

function seedDataset(accountId, genId, userId) {
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO business_dataset (account_id,generation_id,status,schema_version,manifest_hash,manifest_json,expected_chunks,expected_records,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
  ).run(accountId, genId, "active", 1, `hash_${genId}`, "{}", 1, 10, userId, now);
  db.prepare(
    "INSERT INTO business_dataset_pointer (account_id,active_generation_id,updated_at) VALUES (?,?,?)"
  ).run(accountId, genId, now);
}

// Initial setup of generations and properties
const activeGen1 = "gen_active_001";
seedDataset("A_1", activeGen1, "owner_1");
db.prepare("INSERT INTO business_sync_state (account_id,revision) VALUES (?,?)").run("A_1", 1);

// Seed Middleboro property in roster and business_property_map (with legacy property_key "n:1")
const middleboroId = "prop_middleboro_canonical";
db.prepare("INSERT INTO property (id,account_id,code,name,rooms,active,created_date) VALUES (?,?,?,?,?,?,?)")
  .run(middleboroId, "A_1", "MID", "Middleboro Hotel", 50, 1, "2026-01-01");
db.prepare("INSERT INTO business_property_map (account_id,generation_id,property_key,server_property_id,property_code) VALUES (?,?,?,?,?)")
  .run("A_1", activeGen1, "n:1", middleboroId, "MID");

// Seed a second property for A_1 (legacy "n:2")
const secondPropId = "prop_second_canonical";
db.prepare("INSERT INTO property (id,account_id,code,name,rooms,active,created_date) VALUES (?,?,?,?,?,?,?)")
  .run(secondPropId, "A_1", "SEC", "Second Hotel", 40, 1, "2026-01-01");
db.prepare("INSERT INTO business_property_map (account_id,generation_id,property_key,server_property_id,property_code) VALUES (?,?,?,?,?)")
  .run("A_1", activeGen1, "n:2", secondPropId, "SEC");

// Scope for owner including both properties
const owner = scopeAll([middleboroId, secondPropId]);
owner.accountId = "A_1";
owner.user = { id: "owner_1", email: "owner1@test.local", role: "owner", account_id: "A_1" };

// Seed Account 2 with its own property
const a2Gen = "gen_a2_001";
seedDataset("A_2", a2Gen, "owner_1");
db.prepare("INSERT INTO business_sync_state (account_id,revision) VALUES (?,?)").run("A_2", 1);
const a2PropId = "prop_account2_only";
db.prepare("INSERT INTO property (id,account_id,code,name,rooms,active,created_date) VALUES (?,?,?,?,?,?,?)")
  .run(a2PropId, "A_2", "A2P", "Account 2 Property", 30, 1, "2026-01-01");
db.prepare("INSERT INTO business_property_map (account_id,generation_id,property_key,server_property_id,property_code) VALUES (?,?,?,?,?)")
  .run("A_2", a2Gen, "n:1", a2PropId, "A2P");

async function sha256Hex(value) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(typeof value === "string" ? value : canonicalJson(value))));
  return Array.from(digest, (part) => part.toString(16).padStart(2, "0")).join("");
}

async function call(path, { method = "GET", body, scope = owner } = {}) {
  const url = new URL(`https://api.test/api/business-sync/${path}`);
  const request = new Request(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return handleBusinessSyncRequest(request, env, scope, url, url.pathname.split("/").filter(Boolean));
}

async function transactionChunkHash(operations) {
  return sha256Hex(canonicalJson(operations.map((op) => ({
    entity: op.entity,
    operation: op.operation,
    record_key: op.record_key,
    property_key: op.property_key,
    row: op.row || null,
    base_row_hash: op.base_row_hash ?? null,
  }))));
}

// ---------------------------------------------------------------------------
// 1. SECTION 25: Exact production 10-file local simulation
// ---------------------------------------------------------------------------
await run.check("Section 25: exact production 10-file local simulation with canonical property IDs succeeds without duplicate map rows", async () => {
  const txId = "tx_middleboro_prod_sim_10";
  const operations = [];
  const middleboroCanonicalKey = typedRecordKey(middleboroId);

  for (let day = 1; day <= 10; day++) {
    const dayStr = `2026-09-${String(day).padStart(2, "0")}`;
    const row = {
      id: dayStr,
      property_id: middleboroId,
      date: dayStr,
      rooms_sold: 40 + day,
      rooms_available: 50,
    };
    operations.push({
      entity: "OccupancyDay",
      operation: "upsert",
      record_key: typedRecordKey(dayStr),
      property_key: middleboroCanonicalKey,
      row,
      base_row_hash: null,
    });
  }

  const requestHash = await sha256Hex(canonicalJson(operations));
  const startedRes = await call("transaction/start", {
    method: "POST",
    body: { tx_id: txId, request_hash: requestHash, expected_chunks: 1, operation_count: 10 },
  });
  assertEqual(startedRes.status, 201, "transaction/start status");

  const chunkHash = await transactionChunkHash(operations);
  const chunkRes = await call("transaction/chunk", {
    method: "POST",
    body: { tx_id: txId, chunk_index: 0, chunk_hash: chunkHash, operations },
  });
  assertEqual(chunkRes.status, 200, "transaction/chunk status must be 200");

  const commitRes = await call("transaction/commit", {
    method: "POST",
    body: { tx_id: txId },
  });
  assertEqual(commitRes.status, 200, "transaction/commit status must be 200");

  // Verify all 10 stored rows in active generation
  const activePointer = db.prepare("SELECT active_generation_id FROM business_dataset_pointer WHERE account_id='A_1'").get().active_generation_id;
  const storedRows = db.prepare(
    "SELECT record_key, property_key, server_property_id, row_json FROM business_record WHERE account_id='A_1' AND generation_id=? AND entity_name='OccupancyDay'"
  ).all(activePointer);
  assertEqual(storedRows.length, 10, "must have stored exactly 10 OccupancyDay rows");
  for (const stored of storedRows) {
    assertEqual(stored.server_property_id, middleboroId, "server_property_id must match canonical");
    assertEqual(stored.property_key, middleboroCanonicalKey, "property_key must be canonical typed key");
    const parsed = JSON.parse(stored.row_json);
    assertEqual(parsed.property_id, middleboroId, "row_json property_id must match canonical");
  }

  // Verify NO duplicate alias map rows were created
  const mapRows = db.prepare("SELECT * FROM business_property_map WHERE account_id='A_1' AND generation_id=?").all(activePointer);
  assertEqual(mapRows.length, 2, "map rows must not have duplicated aliases");
  const middleboroMaps = mapRows.filter((m) => m.server_property_id === middleboroId);
  assertEqual(middleboroMaps.length, 1, "exactly one map row for middleboro");
  assertEqual(middleboroMaps[0].property_key, "n:1", "original legacy key preserved in map");
});

// ---------------------------------------------------------------------------
// 2. SECTION 26: Failure atomicity on mixed chunk
// ---------------------------------------------------------------------------
await run.check("Section 26: mixed chunk with valid canonical and unmapped property fails atomically with 0 leaked rows", async () => {
  const txId = "tx_mixed_fail_atomicity";
  const validCanonicalKey = typedRecordKey(middleboroId);
  const unmappedKey = typedRecordKey("prop_unmapped_xyz_999");

  const operations = [
    {
      entity: "OccupancyDay",
      operation: "upsert",
      record_key: typedRecordKey("2026-09-98"),
      property_key: validCanonicalKey,
      row: { id: "2026-09-98", property_id: middleboroId, rooms_sold: 10 },
      base_row_hash: null,
    },
    {
      entity: "OccupancyDay",
      operation: "upsert",
      record_key: typedRecordKey("2026-09-99"),
      property_key: unmappedKey,
      row: { id: "2026-09-99", property_id: "prop_unmapped_xyz_999", rooms_sold: 15 },
      base_row_hash: null,
    },
  ];

  const requestHash = await sha256Hex(canonicalJson(operations));
  const startedRes = await call("transaction/start", {
    method: "POST",
    body: { tx_id: txId, request_hash: requestHash, expected_chunks: 1, operation_count: 2 },
  });
  assertEqual(startedRes.status, 201);

  const chunkHash = await transactionChunkHash(operations);
  const chunkRes = await call("transaction/chunk", {
    method: "POST",
    body: { tx_id: txId, chunk_index: 0, chunk_hash: chunkHash, operations },
  });
  assertEqual(chunkRes.status, 422, "mixed chunk must fail with 422");
  const errBody = await chunkRes.json();
  assertEqual(errBody.error, "property mapping not found");

  // Verify staging table is empty for this transaction
  const stagedOps = db.prepare("SELECT COUNT(*) AS n FROM business_record_staging WHERE account_id='A_1' AND transaction_id=?").get(txId).n;
  assertEqual(Number(stagedOps), 0, "no operations may be staged from a failed chunk");

  // Abort cleanly
  const abortRes = await call("transaction/abort", { method: "POST", body: { tx_id: txId } });
  assertEqual(abortRes.status, 200, "transaction/abort must succeed");

  // Verify 0 rows leaked to business_record
  const leaked = db.prepare(
    "SELECT COUNT(*) AS n FROM business_record WHERE account_id='A_1' AND record_key IN (?, ?)"
  ).get(typedRecordKey("2026-09-98"), typedRecordKey("2026-09-99")).n;
  assertEqual(Number(leaked), 0, "zero rows leaked into business_record");
});

// ---------------------------------------------------------------------------
// 3. SECTION 27: Collision adversarial test
// ---------------------------------------------------------------------------
await run.check("Section 27: collision adversarial test fails closed with ambiguous_property_identity and 0 writes", async () => {
  const collGen = "gen_collision_test";
  db.prepare("INSERT INTO account (id,name,created_date) VALUES (?,?,?)").run("A_COLL", "Collision Test", "2026-01-01");
  seedUser(db, { id: "owner_coll", email: "owner_coll@test.local", role: "owner", mode: "all", account_id: "A_COLL" });
  seedDataset("A_COLL", collGen, "owner_coll");
  db.prepare("INSERT INTO business_sync_state (account_id,revision) VALUES (?,?)").run("A_COLL", 1);

  // Pre-seed properties into property table so foreign keys pass
  db.prepare("INSERT INTO property (id,account_id,code,name,rooms,active,created_date) VALUES (?,?,?,?,?,?,?)")
    .run("prop_A", "A_COLL", "PA", "Property A", 10, 1, "2026-01-01");
  db.prepare("INSERT INTO property (id,account_id,code,name,rooms,active,created_date) VALUES (?,?,?,?,?,?,?)")
    .run("prop_B", "A_COLL", "PB", "Property B", 10, 1, "2026-01-01");

  const scopeColl = scopeAll(["prop_A", "prop_B"]);
  scopeColl.accountId = "A_COLL";
  scopeColl.user = { id: "owner_coll", email: "owner_coll@test.local", role: "owner", account_id: "A_COLL" };

  // Map A: legacy property_key = typedRecordKey("prop_B"), server_property_id = "prop_A"
  // Map B: legacy property_key = "n:2", server_property_id = "prop_B"
  const ambiguousKey = typedRecordKey("prop_B");
  db.prepare("INSERT INTO business_property_map (account_id,generation_id,property_key,server_property_id,property_code) VALUES (?,?,?,?,?)")
    .run("A_COLL", collGen, ambiguousKey, "prop_A", "PA");
  db.prepare("INSERT INTO business_property_map (account_id,generation_id,property_key,server_property_id,property_code) VALUES (?,?,?,?,?)")
    .run("A_COLL", collGen, "n:2", "prop_B", "PB");

  // Direct mutate test with ambiguousKey
  const mutateRes = await call("mutate", {
    method: "POST",
    scope: scopeColl,
    body: {
      mutation_id: "mut_coll_00000001",
      entity: "Expense",
      operation: "upsert",
      record_key: typedRecordKey(555),
      property_key: ambiguousKey,
      row: { id: 555, property_id: "prop_B", amount: 100 },
    },
  });
  assertEqual(mutateRes.status, 422, "must fail closed with 422 on collision");
  const mutateErr = await mutateRes.json();
  assertEqual(mutateErr.error, "ambiguous property identity");
  assertEqual(mutateErr.code, "ambiguous_property_identity");

  // Transaction chunk test with ambiguousKey
  const txId = "tx_coll_000000001";
  const op = {
    entity: "Expense",
    operation: "upsert",
    record_key: typedRecordKey(556),
    property_key: ambiguousKey,
    row: { id: 556, property_id: "prop_B", amount: 100 },
  };
  await call("transaction/start", {
    method: "POST",
    scope: scopeColl,
    body: { tx_id: txId, request_hash: await sha256Hex(canonicalJson([op])), expected_chunks: 1, operation_count: 1 },
  });
  const chunkRes = await call("transaction/chunk", {
    method: "POST",
    scope: scopeColl,
    body: { tx_id: txId, chunk_index: 0, chunk_hash: await transactionChunkHash([op]), operations: [op] },
  });
  assertEqual(chunkRes.status, 422, "transaction/chunk must fail closed with 422 on collision");
  const chunkErr = await chunkRes.json();
  assertEqual(chunkErr.error, "ambiguous property identity");
  assertEqual(chunkErr.code, "ambiguous_property_identity");

  // Verify 0 writes
  const rows = db.prepare("SELECT COUNT(*) AS n FROM business_record WHERE account_id='A_COLL'").get().n;
  assertEqual(Number(rows), 0, "zero writes must be stored on collision");
});

// ---------------------------------------------------------------------------
// 4. SECTION 11 & SECTION 28 Case A, B: Direct mutate with canonical and legacy keys
// ---------------------------------------------------------------------------
await run.check("Section 11 & 28 A, B: direct mutate supports both canonical server ID and legacy property key", async () => {
  const activePointer = db.prepare("SELECT active_generation_id FROM business_dataset_pointer WHERE account_id='A_1'").get().active_generation_id;

  // Case B: Canonical create
  const canonicalRes = await call("mutate", {
    method: "POST",
    body: {
      mutation_id: "mut_canonical_0001",
      entity: "Expense",
      operation: "upsert",
      record_key: typedRecordKey(9001),
      property_key: typedRecordKey(middleboroId),
      row: { id: 9001, property_id: middleboroId, expense_name: "Canonical Expense", amount: 99.50 },
    },
  });
  assertEqual(canonicalRes.status, 200, "canonical direct create status");
  const canonicalRecord = db.prepare(
    "SELECT server_property_id, property_key FROM business_record WHERE account_id='A_1' AND generation_id=? AND entity_name='Expense' AND record_key=?"
  ).get(activePointer, typedRecordKey(9001));
  assertEqual(canonicalRecord.server_property_id, middleboroId);
  assertEqual(canonicalRecord.property_key, typedRecordKey(middleboroId));

  // Case A: Legacy create
  const legacyRes = await call("mutate", {
    method: "POST",
    body: {
      mutation_id: "mut_legacy_0000001",
      entity: "Expense",
      operation: "upsert",
      record_key: typedRecordKey(9002),
      property_key: "n:1",
      row: { id: 9002, property_id: 1, expense_name: "Legacy Expense", amount: 50.00 },
    },
  });
  assertEqual(legacyRes.status, 200, "legacy direct create status");
  const legacyRecord = db.prepare(
    "SELECT server_property_id, property_key FROM business_record WHERE account_id='A_1' AND generation_id=? AND entity_name='Expense' AND record_key=?"
  ).get(activePointer, typedRecordKey(9002));
  assertEqual(legacyRecord.server_property_id, middleboroId);
  assertEqual(legacyRecord.property_key, "n:1");
});

// ---------------------------------------------------------------------------
// 5. SECTION 28 Case C: Both legacy and canonical interpretations point to SAME server ID
// ---------------------------------------------------------------------------
await run.check("Section 28 Case C: candidate set resolves when legacy and canonical point to same server ID", async () => {
  const samePropId = "prop_same_cand_id";
  const typedSameKey = typedRecordKey(samePropId);
  // A mapping row where the legacy property_key IS the typed canonical key
  const mappings = [
    { property_key: typedSameKey, server_property_id: samePropId },
  ];
  const resolved = resolvePropertyKeyFromMappings(mappings, typedSameKey);
  assertEqual(resolved, samePropId, "must resolve cleanly to samePropId");
});

// ---------------------------------------------------------------------------
// 6. SECTION 28 Case E: No candidate throws 422 property mapping not found
// ---------------------------------------------------------------------------
await run.check("Section 28 Case E: unknown property throws 422 property mapping not found", async () => {
  const res = await call("mutate", {
    method: "POST",
    body: {
      mutation_id: "mut_unknown_000001",
      entity: "Expense",
      operation: "upsert",
      record_key: typedRecordKey(9005),
      property_key: typedRecordKey("prop_completely_unknown"),
      row: { id: 9005, property_id: "prop_completely_unknown", amount: 10 },
    },
  });
  assertEqual(res.status, 422);
  assertEqual((await res.json()).error, "property mapping not found");
});

// ---------------------------------------------------------------------------
// 7. SECTION 28 Case F: Cross-account isolation
// ---------------------------------------------------------------------------
await run.check("Section 28 Case F: canonical property ID from another account cannot resolve", async () => {
  // A_1 tries to mutate using A_2's canonical property ID
  const res = await call("mutate", {
    method: "POST",
    body: {
      mutation_id: "mut_cross_acct_00001",
      entity: "Expense",
      operation: "upsert",
      record_key: typedRecordKey(9006),
      property_key: typedRecordKey(a2PropId),
      row: { id: 9006, property_id: a2PropId, amount: 20 },
    },
  });
  assertEqual(res.status, 422, "must fail with 422 property mapping not found for cross-account property");
  assertEqual((await res.json()).error, "property mapping not found");
});

// ---------------------------------------------------------------------------
// 8. SECTION 28 Case G: Property exists in roster table but not in generation map
// ---------------------------------------------------------------------------
await run.check("Section 28 Case G: roster-only orphan property not in generation map fails closed", async () => {
  const orphanId = "prop_orphan_roster_only";
  db.prepare("INSERT INTO property (id,account_id,code,name,rooms,active,created_date) VALUES (?,?,?,?,?,?,?)")
    .run(orphanId, "A_1", "ORP", "Orphan Hotel", 10, 1, "2026-01-01");

  const res = await call("mutate", {
    method: "POST",
    body: {
      mutation_id: "mut_orphan_00000001",
      entity: "Expense",
      operation: "upsert",
      record_key: typedRecordKey(9007),
      property_key: typedRecordKey(orphanId),
      row: { id: 9007, property_id: orphanId, amount: 30 },
    },
  });
  assertEqual(res.status, 422, "roster-only orphan property must not resolve without map entry");
  assertEqual((await res.json()).error, "property mapping not found");
});

// ---------------------------------------------------------------------------
// 9. SECTION 28 Case H: Restricted user targeting unauthorized mapped property gets 403
// ---------------------------------------------------------------------------
await run.check("Section 28 Case H: restricted user receives 403 before record existence oracle", async () => {
  // mgr_1 only has access to secondPropId
  const scopedMgr = scopeSpecific([secondPropId]);
  scopedMgr.accountId = "A_1";
  scopedMgr.user = { id: "mgr_1", email: "mgr1@test.local", role: "manager", account_id: "A_1", permissions: { manual_entry: true } };

  // Targets middleboroId (which exists in map, but mgr_1 is not authorized for)
  const res = await call("mutate", {
    method: "POST",
    scope: scopedMgr,
    body: {
      mutation_id: "mut_restricted_00001",
      entity: "Expense",
      operation: "upsert",
      record_key: typedRecordKey(9001), // record 9001 exists!
      property_key: typedRecordKey(middleboroId),
      row: { id: 9001, property_id: middleboroId, amount: 999 },
    },
  });
  assertEqual(res.status, 403, "restricted caller must receive 403");
  assert(String((await res.json()).error).includes("outside caller scope"), "must report outside caller scope");
});

// ---------------------------------------------------------------------------
// 10. SECTION 28 Case I: Global sentinel preserves existing behavior
// ---------------------------------------------------------------------------
await run.check("Section 28 Case I: global sentinel s:0: requires scope.all and rejects restricted caller with 403", async () => {
  // Global record with owner (scope.all)
  const globalRes = await call("mutate", {
    method: "POST",
    body: {
      mutation_id: "mut_global_00000001",
      entity: "Review",
      operation: "upsert",
      record_key: typedRecordKey("rev_global_1"),
      property_key: "s:0:",
      row: { id: "rev_global_1", property_id: "", rating: 5, comment: "Global feedback" },
    },
  });
  assertEqual(globalRes.status, 200, `owner can mutate global record, got: ${await globalRes.clone().text()}`);
  const activePointer = db.prepare("SELECT active_generation_id FROM business_dataset_pointer WHERE account_id='A_1'").get().active_generation_id;
  const stored = db.prepare("SELECT server_property_id, property_key FROM business_record WHERE account_id='A_1' AND generation_id=? AND record_key=?")
    .get(activePointer, typedRecordKey("rev_global_1"));
  assertEqual(stored.server_property_id, null, "global record must have server_property_id NULL");
  assertEqual(stored.property_key, "s:0:", "global record must have property_key s:0:");

  // Restricted caller fails with 403
  const scopedMgr = scopeSpecific([secondPropId]);
  scopedMgr.accountId = "A_1";
  scopedMgr.user = { id: "mgr_1", email: "mgr1@test.local", role: "manager", account_id: "A_1", permissions: { manual_entry: true } };
  const restrictedRes = await call("mutate", {
    method: "POST",
    scope: scopedMgr,
    body: {
      mutation_id: "mut_global_00000002",
      entity: "Review",
      operation: "upsert",
      record_key: typedRecordKey("rev_global_2"),
      property_key: "s:0:",
      row: { id: "rev_global_2", property_id: "", rating: 4 },
    },
  });
  assertEqual(restrictedRes.status, 403, "restricted caller must get 403 on global record");
});

// ---------------------------------------------------------------------------
// 11. SECTION 28 Case J: Malformed typed canonical key
// ---------------------------------------------------------------------------
await run.check("Section 28 Case J: malformed typed canonical key does not enter fallback and fails with 422", async () => {
  const malformedKey = `s:999:${middleboroId}`; // length prefix is wrong!
  const res = await call("mutate", {
    method: "POST",
    body: {
      mutation_id: "mut_malformed_key_01",
      entity: "Expense",
      operation: "upsert",
      record_key: typedRecordKey(9008),
      property_key: malformedKey,
      row: { id: 9008, property_id: middleboroId, amount: 45 },
    },
  });
  assertEqual(res.status, 422, "malformed typed key must fail 422");
  assertEqual((await res.json()).error, "property mapping not found");
});

// ---------------------------------------------------------------------------
// 12. SECTION 12, 13 & 28 Case K: Historical legacy record updated through canonical identity
// ---------------------------------------------------------------------------
await run.check("Section 12, 13 & 28 Case K: historical legacy record updated through canonical identity succeeds without cross-property error", async () => {
  const activePointer = db.prepare("SELECT active_generation_id FROM business_dataset_pointer WHERE account_id='A_1'").get().active_generation_id;

  // Create a historical record stored with legacy property_key "n:1"
  const histId = 9100;
  const histRecordKey = typedRecordKey(histId);
  const histRow = { id: histId, property_id: 1, expense_name: "Original Historical", amount: 120.00 };
  const histJson = canonicalJson(histRow);
  const histHash = await sha256Hex(histJson);
  db.prepare(
    "INSERT INTO business_record (account_id,generation_id,entity_name,record_key,property_key,server_property_id,row_json,row_hash,updated_at) VALUES (?,?,?,?,?,?,?,?,?)"
  ).run("A_1", activePointer, "Expense", histRecordKey, "n:1", middleboroId, histJson, histHash, new Date().toISOString());

  // Update through canonical property key: typedRecordKey(middleboroId)
  const updatedRow = { id: histId, property_id: middleboroId, expense_name: "Updated via Canonical", amount: 125.00 };
  const updateRes = await call("mutate", {
    method: "POST",
    body: {
      mutation_id: "mut_hist_update_0001",
      entity: "Expense",
      operation: "upsert",
      record_key: histRecordKey,
      property_key: typedRecordKey(middleboroId),
      base_row_hash: histHash,
      row: updatedRow,
    },
  });
  assertEqual(updateRes.status, 200, `update status must be 200, got: ${await updateRes.clone().text()}`);

  const storedAfterUpdate = db.prepare(
    "SELECT server_property_id, property_key, row_json, row_hash FROM business_record WHERE account_id='A_1' AND generation_id=? AND entity_name='Expense' AND record_key=?"
  ).get(activePointer, histRecordKey);
  assertEqual(storedAfterUpdate.server_property_id, middleboroId, "server_property_id must stay middleboroId");
  assertEqual(storedAfterUpdate.property_key, typedRecordKey(middleboroId), "property_key normalized to canonical typed key");
  assertEqual(JSON.parse(storedAfterUpdate.row_json).expense_name, "Updated via Canonical");
});

// ---------------------------------------------------------------------------
// 13. SECTION 14 & 28 Case L: Historical legacy record deleted through canonical identity
// ---------------------------------------------------------------------------
await run.check("Section 14 & 28 Case L: historical legacy record deleted through canonical identity succeeds", async () => {
  const activePointer = db.prepare("SELECT active_generation_id FROM business_dataset_pointer WHERE account_id='A_1'").get().active_generation_id;

  const histDeleteId = 9101;
  const histRecordKey = typedRecordKey(histDeleteId);
  const histRow = { id: histDeleteId, property_id: 1, expense_name: "To Delete", amount: 88.00 };
  const histJson = canonicalJson(histRow);
  const histHash = await sha256Hex(histJson);
  db.prepare(
    "INSERT INTO business_record (account_id,generation_id,entity_name,record_key,property_key,server_property_id,row_json,row_hash,updated_at) VALUES (?,?,?,?,?,?,?,?,?)"
  ).run("A_1", activePointer, "Expense", histRecordKey, "n:1", middleboroId, histJson, histHash, new Date().toISOString());

  // Delete via canonical property identity
  const deleteRes = await call("mutate", {
    method: "POST",
    body: {
      mutation_id: "mut_hist_delete_0001",
      entity: "Expense",
      operation: "delete",
      record_key: histRecordKey,
      property_key: typedRecordKey(middleboroId),
      base_row_hash: histHash,
    },
  });
  assertEqual(deleteRes.status, 200, "delete must succeed with 200");

  const check = db.prepare(
    "SELECT COUNT(*) AS n FROM business_record WHERE account_id='A_1' AND generation_id=? AND entity_name='Expense' AND record_key=?"
  ).get(activePointer, histRecordKey).n;
  assertEqual(Number(check), 0, "record must be deleted");
});

// ---------------------------------------------------------------------------
// 14. SECTION 28 Case M: Attempted canonical re-home A -> B fails with 403
// ---------------------------------------------------------------------------
await run.check("Section 28 Case M: cross-property re-home attempt fails closed with 403", async () => {
  const activePointer = db.prepare("SELECT active_generation_id FROM business_dataset_pointer WHERE account_id='A_1'").get().active_generation_id;

  const recordId = 9102;
  const recordKey = typedRecordKey(recordId);
  const row = { id: recordId, property_id: middleboroId, expense_name: "Belongs to Middleboro", amount: 10.00 };
  const rowJson = canonicalJson(row);
  const rowHash = await sha256Hex(rowJson);
  db.prepare(
    "INSERT INTO business_record (account_id,generation_id,entity_name,record_key,property_key,server_property_id,row_json,row_hash,updated_at) VALUES (?,?,?,?,?,?,?,?,?)"
  ).run("A_1", activePointer, "Expense", recordKey, typedRecordKey(middleboroId), middleboroId, rowJson, rowHash, new Date().toISOString());

  // Attempt to re-home to secondPropId
  const rehomeRes = await call("mutate", {
    method: "POST",
    body: {
      mutation_id: "mut_rehome_00000001",
      entity: "Expense",
      operation: "upsert",
      record_key: recordKey,
      property_key: typedRecordKey(secondPropId),
      base_row_hash: rowHash,
      row: { id: recordId, property_id: secondPropId, expense_name: "Rehome Attempt", amount: 10.00 },
    },
  });
  assertEqual(rehomeRes.status, 403, "cross-property re-homing must be forbidden (403)");
  assertEqual((await rehomeRes.json()).error, "record belongs to another property");
});

// ---------------------------------------------------------------------------
// 15. SECTION 15, 16 & 28 Case N: Rollback exact pre-image property key restoration
// ---------------------------------------------------------------------------
await run.check("Section 15, 16 & 28 Case N: rollback restores exact pre-image property_key and hash after representation transition", async () => {
  const activePointer = db.prepare("SELECT active_generation_id FROM business_dataset_pointer WHERE account_id='A_1'").get().active_generation_id;

  const recordId = 9103;
  const recordKey = typedRecordKey(recordId);
  const originalRow = { id: recordId, property_id: 1, expense_name: "Pre-Image Historical", amount: 200.00 };
  const originalJson = canonicalJson(originalRow);
  const originalHash = await sha256Hex(originalJson);
  db.prepare(
    "INSERT INTO business_record (account_id,generation_id,entity_name,record_key,property_key,server_property_id,row_json,row_hash,updated_at) VALUES (?,?,?,?,?,?,?,?,?)"
  ).run("A_1", activePointer, "Expense", recordKey, "n:1", middleboroId, originalJson, originalHash, new Date().toISOString());

  const txId = "tx_rollback_preimage_test";
  const updatedRow = { id: recordId, property_id: middleboroId, expense_name: "Updated in Tx", amount: 250.00 };
  const updateOp = {
    entity: "Expense",
    operation: "upsert",
    record_key: recordKey,
    property_key: typedRecordKey(middleboroId),
    base_row_hash: originalHash,
    row: updatedRow,
  };

  await call("transaction/start", {
    method: "POST",
    body: { tx_id: txId, request_hash: await sha256Hex(canonicalJson([updateOp])), expected_chunks: 1, operation_count: 1 },
  });

  const chunkRes = await call("transaction/chunk", {
    method: "POST",
    body: { tx_id: txId, chunk_index: 0, chunk_hash: await transactionChunkHash([updateOp]), operations: [updateOp] },
  });
  assertEqual(chunkRes.status, 200);

  const commitRes = await call("transaction/commit", { method: "POST", body: { tx_id: txId } });
  assertEqual(commitRes.status, 200);

  // Stored row is currently updated with canonical property key
  const storedCommitted = db.prepare(
    "SELECT property_key, server_property_id, row_hash, row_json FROM business_record WHERE account_id='A_1' AND generation_id=? AND entity_name='Expense' AND record_key=?"
  ).get(activePointer, recordKey);
  assertEqual(storedCommitted.property_key, typedRecordKey(middleboroId));

  // Rollback the transaction
  const rollbackRes = await call("transaction/rollback", { method: "POST", body: { tx_id: txId } });
  assertEqual(rollbackRes.status, 200, "transaction/rollback must succeed");
  const rollbackBody = await rollbackRes.json();
  assertEqual(rollbackBody.status, "rolled_back");

  // Verify EXACT pre-image restoration in business_record:
  const restored = db.prepare(
    "SELECT property_key, server_property_id, row_hash, row_json FROM business_record WHERE account_id='A_1' AND generation_id=? AND entity_name='Expense' AND record_key=?"
  ).get(activePointer, recordKey);
  assertEqual(restored.property_key, "n:1", "property_key must be restored to original legacy n:1");
  assertEqual(restored.server_property_id, middleboroId, "server_property_id must be restored to middleboroId");
  assertEqual(restored.row_hash, originalHash, "row_hash must match original pre-image hash H1");
  const restoredRow = JSON.parse(restored.row_json);
  assertEqual(restoredRow.property_id, 1, "row_json.property_id must be original 1");
  assertEqual(restoredRow.amount, 200.00, "row_json.amount must be original 200.00");
});

run.done();
if (process.exitCode) process.exit(1);
console.log("PASSED: worker property resolution distinguishes canonical and legacy identities, rejects ambiguous collisions, and restores exact pre-images.");

