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
  numericStringAlternateTypedKey,
} from "../worker/business-sync.js";

const run = makeRunner("probe-worker-property-resolution");

// ===========================================================================
// SECTION 27: R1 through R13 Unit & Resolver Matrix
// ===========================================================================

await run.check("R1: n:1 -> prop_A with incoming n:1 resolves to prop_A", async () => {
  const mappings = [{ property_key: "n:1", server_property_id: "prop_A" }];
  const resolved = resolvePropertyKeyFromMappings(mappings, "n:1");
  assertEqual(resolved, "prop_A");
});

await run.check("R2: n:1 -> prop_A with incoming s:1:1 resolves to prop_A", async () => {
  const mappings = [{ property_key: "n:1", server_property_id: "prop_A" }];
  const resolved = resolvePropertyKeyFromMappings(mappings, "s:1:1");
  assertEqual(resolved, "prop_A");
});

await run.check("R3: n:1 -> prop_A with incoming typed canonical prop_A resolves to prop_A", async () => {
  const mappings = [{ property_key: "n:1", server_property_id: "prop_A" }];
  const resolved = resolvePropertyKeyFromMappings(mappings, typedRecordKey("prop_A"));
  assertEqual(resolved, "prop_A");
});

await run.check("R4: s:1:1 -> prop_A with incoming n:1 resolves to prop_A", async () => {
  const mappings = [{ property_key: "s:1:1", server_property_id: "prop_A" }];
  const resolved = resolvePropertyKeyFromMappings(mappings, "n:1");
  assertEqual(resolved, "prop_A");
});

await run.check("R5: n:1 -> prop_A and s:1:1 -> prop_B with incoming s:1:1 fails closed with 422 ambiguous_property_identity", async () => {
  const mappings = [
    { property_key: "n:1", server_property_id: "prop_A" },
    { property_key: "s:1:1", server_property_id: "prop_B" },
  ];
  let err = null;
  try {
    resolvePropertyKeyFromMappings(mappings, "s:1:1");
  } catch (e) {
    err = e;
  }
  assert(err !== null, "must throw error");
  assertEqual(err.status, 422);
  assertEqual(err.message, "ambiguous property identity");
  assertEqual(err.details?.code, "ambiguous_property_identity");
});

await run.check("R6: n:1 -> prop_A and s:1:1 -> prop_B with incoming n:1 fails closed with 422 ambiguous_property_identity", async () => {
  const mappings = [
    { property_key: "n:1", server_property_id: "prop_A" },
    { property_key: "s:1:1", server_property_id: "prop_B" },
  ];
  let err = null;
  try {
    resolvePropertyKeyFromMappings(mappings, "n:1");
  } catch (e) {
    err = e;
  }
  assert(err !== null, "must throw error");
  assertEqual(err.status, 422);
  assertEqual(err.message, "ambiguous property identity");
  assertEqual(err.details?.code, "ambiguous_property_identity");
});

await run.check("R7: exact + alternate converge to same canonical server ID yields 1 candidate (success)", async () => {
  const mappings = [
    { property_key: "n:1", server_property_id: "prop_A" },
    { property_key: "s:1:1", server_property_id: "prop_A" },
  ];
  const resolved = resolvePropertyKeyFromMappings(mappings, "s:1:1");
  assertEqual(resolved, "prop_A");
  const resolvedReverse = resolvePropertyKeyFromMappings(mappings, "n:1");
  assertEqual(resolvedReverse, "prop_A");
});

await run.check("R8: s:2:01 does NOT alias n:1", async () => {
  assertEqual(numericStringAlternateTypedKey("s:2:01"), null);
  const mappings = [{ property_key: "n:1", server_property_id: "prop_A" }];
  let err = null;
  try {
    resolvePropertyKeyFromMappings(mappings, "s:2:01");
  } catch (e) {
    err = e;
  }
  assert(err !== null, "must throw");
  assertEqual(err.status, 422);
  assertEqual(err.message, "property mapping not found");
});

await run.check("R9: s:2:+1 does NOT alias n:1", async () => {
  assertEqual(numericStringAlternateTypedKey("s:2:+1"), null);
  const mappings = [{ property_key: "n:1", server_property_id: "prop_A" }];
  let err = null;
  try {
    resolvePropertyKeyFromMappings(mappings, "s:2:+1");
  } catch (e) {
    err = e;
  }
  assert(err !== null, "must throw");
  assertEqual(err.status, 422);
  assertEqual(err.message, "property mapping not found");
});

await run.check("R10: malformed typed length does NOT alias", async () => {
  assertEqual(numericStringAlternateTypedKey("s:999:1"), null);
  assertEqual(numericStringAlternateTypedKey("s:1:01"), null);
  assertEqual(numericStringAlternateTypedKey("s:abc:1"), null);
  assertEqual(numericStringAlternateTypedKey("n:1.0"), null);
  assertEqual(numericStringAlternateTypedKey("n:1e0"), null);
  assertEqual(numericStringAlternateTypedKey("s:3:1.0"), null);
  assertEqual(numericStringAlternateTypedKey("s:3:1e0"), null);
  assertEqual(numericStringAlternateTypedKey("s:2: 1"), null);
  assertEqual(numericStringAlternateTypedKey("s:2:1 "), null);
  assertEqual(numericStringAlternateTypedKey("s:2:-0"), null);
  assertEqual(numericStringAlternateTypedKey("n:-0"), null);
});

await run.check("R11: unsafe integer string does NOT alias", async () => {
  const unsafeStr = "9007199254740992";
  const key = typedRecordKey(unsafeStr);
  assertEqual(numericStringAlternateTypedKey(key), null);
});

await run.check("R12: s:0: remains global and is never mapped to n:0", async () => {
  assertEqual(numericStringAlternateTypedKey("s:0:"), null);
  const mappings = [{ property_key: "n:0", server_property_id: "prop_zero" }];
  let err = null;
  try {
    resolvePropertyKeyFromMappings(mappings, "s:0:");
  } catch (e) {
    err = e;
  }
  assert(err !== null, "global sentinel must not resolve through property mapping");
  assertEqual(err.status, 422);
  assertEqual(err.message, "property mapping not found");
});

await run.check("R13: s:1:0 <-> n:0 works when a legitimate property mapping exists", async () => {
  assertEqual(numericStringAlternateTypedKey("s:1:0"), "n:0");
  assertEqual(numericStringAlternateTypedKey("n:0"), "s:1:0");
  const mappings = [{ property_key: "n:0", server_property_id: "prop_zero" }];
  const resolved = resolvePropertyKeyFromMappings(mappings, "s:1:0");
  assertEqual(resolved, "prop_zero");
  const resolvedReverse = resolvePropertyKeyFromMappings(
    [{ property_key: "s:1:0", server_property_id: "prop_zero" }],
    "n:0"
  );
  assertEqual(resolvedReverse, "prop_zero");
});

// ===========================================================================
// DATABASE TESTKIT FIXTURES FOR INTEGRATION TESTS
// ===========================================================================

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

// ===========================================================================
// SECTION 28 & 29: Exact real 10-file local simulation with row.property_id = "1"
// and multi-entity report family coverage
// ===========================================================================

await run.check("Section 28 & 29: exact real 10-file simulation with row.property_id = '1' (s:1:1) and report entities succeeds with 0 map writes", async () => {
  const txId = "tx_real_browser_10_files";
  const browserPropertyKey = typedRecordKey("1"); // "s:1:1"
  assertEqual(browserPropertyKey, "s:1:1");

  const entities = [
    "OccupancyDay",
    "GrossRevenueDay",
    "PaymentDay",
    "SourceDay",
    "ClerkShiftRecord",
    "UploadedReport",
    "OccupancyDay",
    "GrossRevenueDay",
    "PaymentDay",
    "SourceDay",
  ];

  const operations = [];
  for (let i = 0; i < 10; i++) {
    const entity = entities[i];
    const recId = `rec_rep_${i + 1}`;
    const row = {
      id: recId,
      property_id: "1", // STRING "1", exactly as browser sends
      report_family: entity,
      metric_val: 100 + i,
    };
    operations.push({
      entity,
      operation: "upsert",
      record_key: typedRecordKey(recId),
      property_key: browserPropertyKey,
      row,
      base_row_hash: null,
    });
  }

  const requestHash = await sha256Hex(canonicalJson(operations));
  const startRes = await call("transaction/start", {
    method: "POST",
    body: { tx_id: txId, request_hash: requestHash, expected_chunks: 1, operation_count: 10 },
  });
  assertEqual(startRes.status, 201, "start status");

  const chunkHash = await transactionChunkHash(operations);
  const chunkRes = await call("transaction/chunk", {
    method: "POST",
    body: { tx_id: txId, chunk_index: 0, chunk_hash: chunkHash, operations },
  });
  assertEqual(chunkRes.status, 200, "chunk status");

  // Section 31: duplicate / idempotency contract: re-sending identical accepted chunk succeeds
  const chunkReplayRes = await call("transaction/chunk", {
    method: "POST",
    body: { tx_id: txId, chunk_index: 0, chunk_hash: chunkHash, operations },
  });
  assertEqual(chunkReplayRes.status, 200, "chunk replay status");

  const commitRes = await call("transaction/commit", {
    method: "POST",
    body: { tx_id: txId },
  });
  assertEqual(commitRes.status, 200, "commit status");

  // Verify all 10 stored rows
  const activePointer = db.prepare("SELECT active_generation_id FROM business_dataset_pointer WHERE account_id='A_1'").get().active_generation_id;
  const stored = db.prepare(
    "SELECT entity_name, record_key, property_key, server_property_id, row_json FROM business_record WHERE account_id='A_1' AND generation_id=?"
  ).all(activePointer);
  const simStored = stored.filter((r) => r.record_key.includes("rec_rep_"));
  assertEqual(simStored.length, 10, "10 rows stored");
  for (const row of simStored) {
    assertEqual(row.server_property_id, middleboroId, "server_property_id must be canonical Middleboro");
    assertEqual(row.property_key, "s:1:1", "property_key must be stored as incoming s:1:1");
    const parsed = JSON.parse(row.row_json);
    assertEqual(parsed.property_id, "1", "row_json.property_id must be string '1'");
  }

  // Verify 0 business_property_map rows added
  const mapRows = db.prepare("SELECT * FROM business_property_map WHERE account_id='A_1' AND generation_id=?").all(activePointer);
  assertEqual(mapRows.length, 2, "no duplicate alias map rows");
  assertEqual(mapRows.find((m) => m.server_property_id === middleboroId).property_key, "n:1", "original legacy key intact");
});

// ===========================================================================
// SECTION 30: Failure atomicity on mixed chunk
// ===========================================================================

await run.check("Section 30: mixed chunk (9 valid s:1:1 + 1 unmapped) fails atomically with 0 leaked rows", async () => {
  const txId = "tx_atomicity_unmapped";
  const validKey = typedRecordKey("1"); // s:1:1
  const unmappedKey = typedRecordKey("prop_unmapped_999");

  const operations = [];
  for (let i = 1; i <= 9; i++) {
    operations.push({
      entity: "OccupancyDay",
      operation: "upsert",
      record_key: typedRecordKey(`valid_unmap_${i}`),
      property_key: validKey,
      row: { id: `valid_unmap_${i}`, property_id: "1", rooms: 10 },
      base_row_hash: null,
    });
  }
  operations.push({
    entity: "OccupancyDay",
    operation: "upsert",
    record_key: typedRecordKey("invalid_unmap_10"),
    property_key: unmappedKey,
    row: { id: "invalid_unmap_10", property_id: "prop_unmapped_999", rooms: 10 },
    base_row_hash: null,
  });

  await call("transaction/start", {
    method: "POST",
    body: { tx_id: txId, request_hash: await sha256Hex(canonicalJson(operations)), expected_chunks: 1, operation_count: 10 },
  });

  const chunkRes = await call("transaction/chunk", {
    method: "POST",
    body: { tx_id: txId, chunk_index: 0, chunk_hash: await transactionChunkHash(operations), operations },
  });
  assertEqual(chunkRes.status, 422, "chunk must fail with 422");
  const errBody = await chunkRes.json();
  assertEqual(errBody.error, "property mapping not found");

  await call("transaction/abort", { method: "POST", body: { tx_id: txId } });

  // Verify 0 rows leaked to business_record
  const leaked = db.prepare("SELECT COUNT(*) AS n FROM business_record WHERE account_id='A_1' AND record_key LIKE '%valid_unmap%'").get().n;
  assertEqual(Number(leaked), 0, "zero rows leaked");
});

await run.check("Section 30: mixed chunk (9 valid s:1:1 + 1 ambiguous collision) fails atomically with 0 leaked rows", async () => {
  const collGen = "gen_coll_atomicity";
  db.prepare("INSERT INTO account (id,name,created_date) VALUES (?,?,?)").run("A_COLL_ATOM", "Collision Atomicity", "2026-01-01");
  seedUser(db, { id: "owner_coll_atom", email: "owner_coll_atom@test.local", role: "owner", mode: "all", account_id: "A_COLL_ATOM" });
  seedDataset("A_COLL_ATOM", collGen, "owner_coll_atom");
  db.prepare("INSERT INTO business_sync_state (account_id,revision) VALUES (?,?)").run("A_COLL_ATOM", 1);

  db.prepare("INSERT INTO property (id,account_id,code,name,rooms,active,created_date) VALUES (?,?,?,?,?,?,?)")
    .run("prop_A", "A_COLL_ATOM", "PA", "Property A", 10, 1, "2026-01-01");
  db.prepare("INSERT INTO property (id,account_id,code,name,rooms,active,created_date) VALUES (?,?,?,?,?,?,?)")
    .run("prop_B", "A_COLL_ATOM", "PB", "Property B", 10, 1, "2026-01-01");
  db.prepare("INSERT INTO property (id,account_id,code,name,rooms,active,created_date) VALUES (?,?,?,?,?,?,?)")
    .run("prop_C", "A_COLL_ATOM", "PC", "Property C", 10, 1, "2026-01-01");

  // Map A: n:1 -> prop_A
  // Map B: s:1:1 -> prop_B
  db.prepare("INSERT INTO business_property_map (account_id,generation_id,property_key,server_property_id,property_code) VALUES (?,?,?,?,?)")
    .run("A_COLL_ATOM", collGen, "n:1", "prop_A", "PA");
  db.prepare("INSERT INTO business_property_map (account_id,generation_id,property_key,server_property_id,property_code) VALUES (?,?,?,?,?)")
    .run("A_COLL_ATOM", collGen, "s:1:1", "prop_B", "PB");

  // Map C: n:99 -> prop_C (unambiguous for the 9 valid ops)
  db.prepare("INSERT INTO business_property_map (account_id,generation_id,property_key,server_property_id,property_code) VALUES (?,?,?,?,?)")
    .run("A_COLL_ATOM", collGen, "n:99", "prop_C", "PC");

  const scopeColl = scopeAll(["prop_A", "prop_B", "prop_C"]);
  scopeColl.accountId = "A_COLL_ATOM";
  scopeColl.user = { id: "owner_coll_atom", email: "owner_coll_atom@test.local", role: "owner", account_id: "A_COLL_ATOM" };

  const txId = "tx_atomicity_ambiguous";
  const operations = [];
  for (let i = 1; i <= 9; i++) {
    operations.push({
      entity: "OccupancyDay",
      operation: "upsert",
      record_key: typedRecordKey(`valid_amb_${i}`),
      property_key: "s:2:99", // resolves unambiguously to prop_C via n:99
      row: { id: `valid_amb_${i}`, property_id: "99", rooms: 10 },
      base_row_hash: null,
    });
  }
  // 10th op is ambiguous: s:1:1 can resolve to prop_B (exact) or prop_A (alternate of n:1)
  operations.push({
    entity: "OccupancyDay",
    operation: "upsert",
    record_key: typedRecordKey("ambiguous_op_10"),
    property_key: "s:1:1",
    row: { id: "ambiguous_op_10", property_id: "1", rooms: 10 },
    base_row_hash: null,
  });

  await call("transaction/start", {
    method: "POST",
    scope: scopeColl,
    body: { tx_id: txId, request_hash: await sha256Hex(canonicalJson(operations)), expected_chunks: 1, operation_count: 10 },
  });

  const chunkRes = await call("transaction/chunk", {
    method: "POST",
    scope: scopeColl,
    body: { tx_id: txId, chunk_index: 0, chunk_hash: await transactionChunkHash(operations), operations },
  });
  assertEqual(chunkRes.status, 422, "ambiguous chunk must fail 422");
  const errBody = await chunkRes.json();
  assertEqual(errBody.error, "ambiguous property identity");
  assertEqual(errBody.code, "ambiguous_property_identity");

  await call("transaction/abort", { method: "POST", scope: scopeColl, body: { tx_id: txId } });

  const leaked = db.prepare("SELECT COUNT(*) AS n FROM business_record WHERE account_id='A_COLL_ATOM'").get().n;
  assertEqual(Number(leaked), 0, "zero rows committed");
});

// ===========================================================================
// SECTION 16: Direct mutate Cases M1, M2, M3
// ===========================================================================

await run.check("Section 16: Direct mutate M1, M2, M3 succeed with identical resolution rule", async () => {
  // Case M1: property_id = "1", property_key = "s:1:1"
  const m1Res = await call("mutate", {
    method: "POST",
    body: {
      mutation_id: "mut_m1_case_00000001",
      entity: "Expense",
      operation: "upsert",
      record_key: typedRecordKey(8001),
      property_key: "s:1:1",
      row: { id: 8001, property_id: "1", expense_name: "M1 Expense", amount: 10 },
    },
  });
  assertEqual(m1Res.status, 200, "M1 direct create status");
  const m1Record = db.prepare("SELECT server_property_id, property_key FROM business_record WHERE account_id='A_1' AND record_key=?").get(typedRecordKey(8001));
  assertEqual(m1Record.server_property_id, middleboroId);
  assertEqual(m1Record.property_key, "s:1:1");

  // Case M2: property_id = 1, property_key = "n:1"
  const m2Res = await call("mutate", {
    method: "POST",
    body: {
      mutation_id: "mut_m2_case_00000001",
      entity: "Expense",
      operation: "upsert",
      record_key: typedRecordKey(8002),
      property_key: "n:1",
      row: { id: 8002, property_id: 1, expense_name: "M2 Expense", amount: 20 },
    },
  });
  assertEqual(m2Res.status, 200, "M2 direct create status");
  const m2Record = db.prepare("SELECT server_property_id, property_key FROM business_record WHERE account_id='A_1' AND record_key=?").get(typedRecordKey(8002));
  assertEqual(m2Record.server_property_id, middleboroId);
  assertEqual(m2Record.property_key, "n:1");

  // Case M3: property_id = middleboroId, property_key = typedRecordKey(middleboroId)
  const m3Res = await call("mutate", {
    method: "POST",
    body: {
      mutation_id: "mut_m3_case_00000001",
      entity: "Expense",
      operation: "upsert",
      record_key: typedRecordKey(8003),
      property_key: typedRecordKey(middleboroId),
      row: { id: 8003, property_id: middleboroId, expense_name: "M3 Expense", amount: 30 },
    },
  });
  assertEqual(m3Res.status, 200, "M3 direct create status");
  const m3Record = db.prepare("SELECT server_property_id, property_key FROM business_record WHERE account_id='A_1' AND record_key=?").get(typedRecordKey(8003));
  assertEqual(m3Record.server_property_id, middleboroId);
  assertEqual(m3Record.property_key, typedRecordKey(middleboroId));
});

// ===========================================================================
// SECTION 17: Representation transitions
// ===========================================================================

await run.check("Section 17: representation transitions (n:1 -> s:1:1 -> canonical) succeed", async () => {
  const activePointer = db.prepare("SELECT active_generation_id FROM business_dataset_pointer WHERE account_id='A_1'").get().active_generation_id;

  // Stored with n:1
  const recId = 8100;
  const recKey = typedRecordKey(recId);
  const rowV1 = { id: recId, property_id: 1, expense_name: "Version 1", amount: 100 };
  const jsonV1 = canonicalJson(rowV1);
  const hashV1 = await sha256Hex(jsonV1);
  db.prepare(
    "INSERT INTO business_record (account_id,generation_id,entity_name,record_key,property_key,server_property_id,row_json,row_hash,updated_at) VALUES (?,?,?,?,?,?,?,?,?)"
  ).run("A_1", activePointer, "Expense", recKey, "n:1", middleboroId, jsonV1, hashV1, new Date().toISOString());

  // Transition 1: n:1 -> s:1:1
  const rowV2 = { id: recId, property_id: "1", expense_name: "Version 2 via s:1:1", amount: 110 };
  const jsonV2 = canonicalJson(rowV2);
  const hashV2 = await sha256Hex(jsonV2);
  const res1 = await call("mutate", {
    method: "POST",
    body: {
      mutation_id: "mut_trans_00000001",
      entity: "Expense",
      operation: "upsert",
      record_key: recKey,
      property_key: "s:1:1",
      base_row_hash: hashV1,
      row: rowV2,
    },
  });
  assertEqual(res1.status, 200, "n:1 -> s:1:1 status");
  const storedV2 = db.prepare("SELECT property_key, server_property_id FROM business_record WHERE account_id='A_1' AND record_key=?").get(recKey);
  assertEqual(storedV2.property_key, "s:1:1");
  assertEqual(storedV2.server_property_id, middleboroId);

  // Transition 2: s:1:1 -> canonical
  const rowV3 = { id: recId, property_id: middleboroId, expense_name: "Version 3 via canonical", amount: 120 };
  const jsonV3 = canonicalJson(rowV3);
  const hashV3 = await sha256Hex(jsonV3);
  const res2 = await call("mutate", {
    method: "POST",
    body: {
      mutation_id: "mut_trans_00000002",
      entity: "Expense",
      operation: "upsert",
      record_key: recKey,
      property_key: typedRecordKey(middleboroId),
      base_row_hash: hashV2,
      row: rowV3,
    },
  });
  assertEqual(res2.status, 200, "s:1:1 -> canonical status");
  const storedV3 = db.prepare("SELECT property_key, server_property_id FROM business_record WHERE account_id='A_1' AND record_key=?").get(recKey);
  assertEqual(storedV3.property_key, typedRecordKey(middleboroId));
  assertEqual(storedV3.server_property_id, middleboroId);

  // Transition 3: canonical -> s:1:1
  const rowV4 = { id: recId, property_id: "1", expense_name: "Version 4 via s:1:1 again", amount: 130 };
  const res3 = await call("mutate", {
    method: "POST",
    body: {
      mutation_id: "mut_trans_00000003",
      entity: "Expense",
      operation: "upsert",
      record_key: recKey,
      property_key: "s:1:1",
      base_row_hash: hashV3,
      row: rowV4,
    },
  });
  assertEqual(res3.status, 200, "canonical -> s:1:1 status");
  const storedV4 = db.prepare("SELECT property_key, server_property_id FROM business_record WHERE account_id='A_1' AND record_key=?").get(recKey);
  assertEqual(storedV4.property_key, "s:1:1");
});

// ===========================================================================
// SECTION 18: No cross-property re-homing
// ===========================================================================

await run.check("Section 18: cross-property re-home attempt fails closed with 403", async () => {
  const activePointer = db.prepare("SELECT active_generation_id FROM business_dataset_pointer WHERE account_id='A_1'").get().active_generation_id;
  const recId = 8200;
  const recKey = typedRecordKey(recId);
  const row = { id: recId, property_id: "1", expense_name: "Belongs to Middleboro", amount: 10 };
  const json = canonicalJson(row);
  const hash = await sha256Hex(json);
  db.prepare(
    "INSERT INTO business_record (account_id,generation_id,entity_name,record_key,property_key,server_property_id,row_json,row_hash,updated_at) VALUES (?,?,?,?,?,?,?,?,?)"
  ).run("A_1", activePointer, "Expense", recKey, "s:1:1", middleboroId, json, hash, new Date().toISOString());

  // Attempt to rehome to secondPropId (legacy n:2 / s:1:2)
  const res = await call("mutate", {
    method: "POST",
    body: {
      mutation_id: "mut_rehome_denied_0001",
      entity: "Expense",
      operation: "upsert",
      record_key: recKey,
      property_key: "s:1:2",
      base_row_hash: hash,
      row: { id: recId, property_id: "2", expense_name: "Rehome attempt", amount: 10 },
    },
  });
  assertEqual(res.status, 403, "cross-property rehoming must return 403");
  assertEqual((await res.json()).error, "record belongs to another property");
});

// ===========================================================================
// SECTION 19: Rollback pre-image exactness (n:1 + numeric 1 restored, no hybrid)
// ===========================================================================

await run.check("Section 19: rollback restores exact pre-image (n:1, numeric 1, H1) after real browser transition (s:1:1, string '1', H2)", async () => {
  const activePointer = db.prepare("SELECT active_generation_id FROM business_dataset_pointer WHERE account_id='A_1'").get().active_generation_id;

  const recId = 8300;
  const recKey = typedRecordKey(recId);
  const origRow = { id: recId, property_id: 1, expense_name: "Historical Pre-Image", amount: 200 };
  const origJson = canonicalJson(origRow);
  const origHash = await sha256Hex(origJson);
  db.prepare(
    "INSERT INTO business_record (account_id,generation_id,entity_name,record_key,property_key,server_property_id,row_json,row_hash,updated_at) VALUES (?,?,?,?,?,?,?,?,?)"
  ).run("A_1", activePointer, "Expense", recKey, "n:1", middleboroId, origJson, origHash, new Date().toISOString());

  const txId = "tx_rollback_exact_preimage";
  const updatedRow = { id: recId, property_id: "1", expense_name: "Updated by Browser Tx", amount: 250 };
  const updateOp = {
    entity: "Expense",
    operation: "upsert",
    record_key: recKey,
    property_key: "s:1:1",
    base_row_hash: origHash,
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

  // Stored row is committed with s:1:1
  const storedCommitted = db.prepare("SELECT property_key, server_property_id, row_hash, row_json FROM business_record WHERE account_id='A_1' AND record_key=?").get(recKey);
  assertEqual(storedCommitted.property_key, "s:1:1");

  // Rollback
  const rollbackRes = await call("transaction/rollback", { method: "POST", body: { tx_id: txId } });
  assertEqual(rollbackRes.status, 200);

  // Verify EXACT pre-image restoration:
  const restored = db.prepare("SELECT property_key, server_property_id, row_hash, row_json FROM business_record WHERE account_id='A_1' AND record_key=?").get(recKey);
  assertEqual(restored.property_key, "n:1", "property_key restored to n:1");
  assertEqual(restored.server_property_id, middleboroId, "server_property_id restored to middleboroId");
  assertEqual(restored.row_hash, origHash, "row_hash restored to H1");
  const parsedRestored = JSON.parse(restored.row_json);
  assertEqual(parsedRestored.property_id, 1, "row_json.property_id restored to numeric 1 (NO HYBRID)");
  assertEqual(parsedRestored.amount, 200);
});

// ===========================================================================
// SECTION 20 & 21: Global sentinel protection
// ===========================================================================

await run.check("Section 20 & 21: global sentinel s:0: requires scope.all and rejects restricted caller with 403", async () => {
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
  assertEqual(globalRes.status, 200);
  const activePointer = db.prepare("SELECT active_generation_id FROM business_dataset_pointer WHERE account_id='A_1'").get().active_generation_id;
  const stored = db.prepare("SELECT server_property_id, property_key FROM business_record WHERE account_id='A_1' AND generation_id=? AND record_key=?")
    .get(activePointer, typedRecordKey("rev_global_1"));
  assertEqual(stored.server_property_id, null, "global server_property_id is NULL");
  assertEqual(stored.property_key, "s:0:");

  // Restricted caller fails 403
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
  assertEqual(restrictedRes.status, 403);
});

// ===========================================================================
// SECTION 22: Account and generation isolation
// ===========================================================================

await run.check("Section 22: account isolation: Account A's property key cannot resolve in Account B", async () => {
  // A_1 tries to mutate using A_2's property key
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
  assertEqual(res.status, 422);
  assertEqual((await res.json()).error, "property mapping not found");
});

await run.check("Section 22: generation isolation: mapping in old generation does not resolve in active generation", async () => {
  const oldGen = "gen_old_isolated";
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO business_dataset (account_id,generation_id,status,schema_version,manifest_hash,manifest_json,expected_chunks,expected_records,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
  ).run("A_1", oldGen, "retired", 1, `hash_${oldGen}`, "{}", 1, 10, "owner_1", now);
  db.prepare("INSERT INTO property (id,account_id,code,name,rooms,active,created_date) VALUES (?,?,?,?,?,?,?)")
    .run("prop_only_in_old", "A_1", "OLD", "Old Hotel", 10, 1, "2026-01-01");
  db.prepare("INSERT INTO business_property_map (account_id,generation_id,property_key,server_property_id,property_code) VALUES (?,?,?,?,?)")
    .run("A_1", oldGen, "n:999", "prop_only_in_old", "OLD");

  const res = await call("mutate", {
    method: "POST",
    body: {
      mutation_id: "mut_old_gen_test_0001",
      entity: "Expense",
      operation: "upsert",
      record_key: typedRecordKey(9010),
      property_key: "s:3:999", // alternate of n:999
      row: { id: 9010, property_id: "999", amount: 20 },
    },
  });
  assertEqual(res.status, 422);
  assertEqual((await res.json()).error, "property mapping not found");
});

// ===========================================================================
// SECTION 23: Authorization order fail-closed
// ===========================================================================

await run.check("Section 23: restricted manager targeting unauthorized property gets 403 before record existence check", async () => {
  const scopedMgr = scopeSpecific([middleboroId]);
  scopedMgr.accountId = "A_1";
  scopedMgr.user = { id: "mgr_1", email: "mgr1@test.local", role: "manager", account_id: "A_1", permissions: { manual_entry: true } };

  // Manager authorized only for middleboroId. Targets secondPropId (s:1:2 -> n:2).
  const res = await call("mutate", {
    method: "POST",
    scope: scopedMgr,
    body: {
      mutation_id: "mut_restr_auth_order_01",
      entity: "Expense",
      operation: "upsert",
      record_key: typedRecordKey(8001), // this record exists under middleboro!
      property_key: "s:1:2",
      row: { id: 8001, property_id: "2", amount: 999 },
    },
  });
  assertEqual(res.status, 403, "must get 403 before 409 conflict");
  assert(String((await res.json()).error).includes("outside caller scope"));
});

// ===========================================================================
// SECTION 24: Roster-only orphan property fails closed
// ===========================================================================

await run.check("Section 24: roster-only orphan property not in generation map fails closed", async () => {
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
  assertEqual(res.status, 422);
  assertEqual((await res.json()).error, "property mapping not found");
});

run.done();
if (process.exitCode) process.exit(1);
console.log("PASSED: worker property resolution probe completed all tests successfully.");
