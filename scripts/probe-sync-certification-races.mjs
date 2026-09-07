import {
  assert,
  assertEqual,
  makeDb,
  makeEnv,
  seedUser,
  scopeAll,
  scopeSpecific,
} from "./_worker-testkit.mjs";
import {
  canonicalJson,
  handleBusinessSyncRequest,
  typedRecordKey,
} from "../worker/business-sync.js";

async function hash(value) {
  const bytes = new TextEncoder().encode(typeof value === "string" ? value : canonicalJson(value));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (part) => part.toString(16).padStart(2, "0")).join("");
}

async function encoded(entity, row) {
  const record_key = typedRecordKey(row.id);
  const property_key = entity === "Property" ? record_key : typedRecordKey(row.property_id);
  return { entity, record_key, property_key, row, row_hash: await hash(canonicalJson(row)) };
}

async function buildPayload() {
  const rows = [
    await encoded("Property", { id: 7, code: "NUM-7", name: "Numeric Seven", rooms: 10, active: true }),
    await encoded("Property", { id: "7", code: "STR-7", name: "String Seven", rooms: 11, active: true }),
    await encoded("Expense", { id: 1, property_id: 7, expense_name: "Numeric", amount: 12.34 }),
    await encoded("Expense", { id: 2, property_id: "7", expense_name: "String", amount: 56.78 }),
  ];
  const chunks = [rows.slice(0, 2), rows.slice(2)];
  const descriptors = [];
  for (let index = 0; index < chunks.length; index += 1) {
    descriptors.push({ index, count: chunks[index].length, hash: await hash(canonicalJson(chunks[index])) });
  }
  const counts = Object.fromEntries([
    "Property", "OccupancyDay", "SourceDay", "GrossRevenueDay", "PaymentDay",
    "ClerkShiftRecord", "UploadedReport", "Expense", "PayrollRun", "Staff",
    "HotelMetric", "TransactionLine", "AnomalyAlert", "Room", "RoomStay",
    "HousekeepingTask", "WeatherSnapshot", "Review", "AdjustmentRefund",
    "DailyFinancialAggregate", "ScanResult", "TimecardPunch", "Reservation",
    "RoomType", "ChannelMap",
  ].map((entity) => [entity, rows.filter((row) => row.entity === entity).length]));
  const manifest = { schema_version: 1, counts, chunks: descriptors };
  return { chunks, descriptors, manifest, manifest_hash: await hash(canonicalJson(manifest)) };
}

async function buildVariantPayload() {
  const variant = await buildPayload();
  variant.chunks[0][0].row.name = "Replacement Numeric Seven";
  variant.chunks[0][0].row.rooms = 99;
  variant.chunks[0][0].row_hash = await hash(canonicalJson(variant.chunks[0][0].row));
  variant.chunks[1][0].row.amount = 77.77;
  variant.chunks[1][0].row_hash = await hash(canonicalJson(variant.chunks[1][0].row));
  variant.descriptors[0].hash = await hash(canonicalJson(variant.chunks[0]));
  variant.descriptors[1].hash = await hash(canonicalJson(variant.chunks[1]));
  variant.manifest.chunks = variant.descriptors;
  variant.manifest_hash = await hash(canonicalJson(variant.manifest));
  return variant;
}

async function call(env, path, { method = "GET", body, scope } = {}) {
  const url = new URL(`https://api.test/api/business-sync/${path}`);
  const request = new Request(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return handleBusinessSyncRequest(request, env, scope, url, url.pathname.split("/").filter(Boolean));
}

async function start(env, payload, scope) {
  const response = await call(env, "migration/start", {
    method: "POST",
    body: { manifest: payload.manifest, manifest_hash: payload.manifest_hash },
    scope,
  });
  assertEqual(response.status, 201, "migration start status");
  return response.json();
}

async function upload(env, generationId, payload, index, scope) {
  const response = await call(env, "migration/chunk", {
    method: "POST",
    body: {
      generation_id: generationId,
      chunk_index: index,
      chunk_hash: payload.descriptors[index].hash,
      rows: payload.chunks[index],
    },
    scope,
  });
  return { response, body: await response.json() };
}

async function transactionChunkHash(operations) {
  return hash(canonicalJson(operations.map((operation) => ({
    entity: operation.entity,
    operation: operation.operation,
    record_key: operation.record_key,
    property_key: operation.property_key,
    row: operation.row || null,
    base_row_hash: operation.base_row_hash ?? null,
  }))));
}

function setupContext() {
  const db = makeDb();
  db.prepare("INSERT INTO account (id,name,created_date) VALUES (?,?,?)").run("A_1", "Test", "2026-01-01");
  seedUser(db, { id: "owner", email: "owner@test.local", role: "owner", mode: "all" });
  const env = makeEnv(db, { ENABLE_BUSINESS_SYNC_API: "true" });
  const owner = scopeAll([]);
  owner.user.id = "owner";
  owner.user.role = "owner";
  owner.user.permissions = JSON.stringify({
    manage_operations: true,
    import_reports: true,
    manual_entry: true,
  });
  return { db, env, owner };
}

function refreshScopeProperties(db, scope) {
  scope.propertyIds = db.prepare("SELECT id FROM property WHERE account_id='A_1' ORDER BY id").all().map((r) => String(r.id));
}

function hookRevisionFirst(env, onBeforeFirst) {
  const origPrepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = function (sql) {
    const stmt = origPrepare(sql);
    if (!stmt || typeof stmt.bind !== "function") return stmt;
    const origBind = stmt.bind.bind(stmt);
    stmt.bind = function (...values) {
      const bound = origBind(...values);
      if (bound && typeof bound.first === "function" && String(sql).includes("SELECT revision FROM business_sync_state")) {
        const origFirst = bound.first.bind(bound);
        bound.first = async function (...args) {
          await onBeforeFirst();
          return await origFirst(...args);
        };
      }
      return bound;
    };
    return stmt;
  };
  return () => {
    env.DB.prepare = origPrepare;
  };
}

const testResults = [];
async function testCase(name, fn) {
  try {
    await fn();
    console.log(`[PASS] ${name}`);
    testResults.push({ name, status: "PASS" });
  } catch (error) {
    const message = error?.message || String(error);
    console.log(`[FAIL] ${name}: ${message}`);
    testResults.push({ name, status: "FAIL", error: message });
  }
}

// ---------------------------------------------------------------------------
// Test 1: Direct mutate must NOT trip the migration-rollback barrier.
// Only a staged-transaction commit sets post_migration_mutated (pinned by
// probe-worker-business-sync.mjs: roster restore must keep working after
// direct mutates). This test guards against re-broadening the barrier.
// ---------------------------------------------------------------------------
await testCase("direct mutate must leave post_migration_mutated clear so migration rollback still restores", async () => {
  const { db, env, owner } = setupContext();

  const p1 = await buildPayload();
  const s1 = await start(env, p1, owner);
  for (let i = 0; i < p1.chunks.length; i++) await upload(env, s1.generation_id, p1, i, owner);
  assertEqual((await call(env, "migration/activate", { method: "POST", body: { generation_id: s1.generation_id }, scope: owner })).status, 200);

  const p2 = await buildVariantPayload();
  const s2 = await start(env, p2, owner);
  for (let i = 0; i < p2.chunks.length; i++) await upload(env, s2.generation_id, p2, i, owner);
  assertEqual((await call(env, "migration/activate", { method: "POST", body: { generation_id: s2.generation_id }, scope: owner })).status, 200);
  refreshScopeProperties(db, owner);

  const mutateRes = await call(env, "mutate", {
    method: "POST",
    body: {
      mutation_id: "mutation_direct_barrier_001",
      entity: "Expense",
      operation: "upsert",
      record_key: typedRecordKey(9001),
      property_key: typedRecordKey(7),
      row: { id: 9001, property_id: 7, expense_name: "Direct Mutation Barrier", amount: 99.99 },
    },
    scope: owner,
  });
  const mutateBody = await mutateRes.clone().json().catch(() => ({}));
  assertEqual(mutateRes.status, 200, `direct mutate must succeed: status ${mutateRes.status}, body: ${JSON.stringify(mutateBody)}`);

  const genRow = db.prepare("SELECT post_migration_mutated FROM business_dataset WHERE account_id='A_1' AND generation_id=?").get(s2.generation_id);
  assertEqual(Number(genRow?.post_migration_mutated || 0), 0, "direct mutate must not mark active generation post_migration_mutated");

  const rollbackRes = await call(env, "migration/rollback", {
    method: "POST",
    body: { generation_id: s2.generation_id },
    scope: owner,
  });
  const rollbackBody = await rollbackRes.json();
  assertEqual(rollbackRes.status, 200, `migration rollback must still restore after a direct mutation, got ${rollbackRes.status}: ${JSON.stringify(rollbackBody)}`);
});

// ---------------------------------------------------------------------------
// Test 2: Restricted scope cannot rollback global journal record
// ---------------------------------------------------------------------------
await testCase("restricted scope cannot rollback global journal record", async () => {
  const { db, env, owner } = setupContext();

  const payload = await buildPayload();
  const started = await start(env, payload, owner);
  for (let i = 0; i < payload.chunks.length; i++) await upload(env, started.generation_id, payload, i, owner);
  assertEqual((await call(env, "migration/activate", { method: "POST", body: { generation_id: started.generation_id }, scope: owner })).status, 200);
  refreshScopeProperties(db, owner);

  const txId = "transaction_global_scope_0001";
  const operation = {
    entity: "AnomalyAlert",
    operation: "upsert",
    record_key: typedRecordKey(8888),
    property_key: typedRecordKey(""),
    row: { id: 8888, property_id: "", alert_type: "global_security_audit", severity: "high", message: "Global incident record" },
  };
  const requestHash = await hash(canonicalJson([operation]));
  assertEqual((await call(env, "transaction/start", { method: "POST", body: { tx_id: txId, request_hash: requestHash, expected_chunks: 1, operation_count: 1 }, scope: owner })).status, 201);
  assertEqual((await call(env, "transaction/chunk", { method: "POST", body: { tx_id: txId, chunk_index: 0, chunk_hash: await transactionChunkHash([operation]), operations: [operation] }, scope: owner })).status, 200);
  assertEqual((await call(env, "transaction/commit", { method: "POST", body: { tx_id: txId }, scope: owner })).status, 200);

  const journal = db.prepare("SELECT server_property_id FROM business_rollback_journal WHERE account_id='A_1' AND transaction_id=?").get(txId);
  assertEqual(journal.server_property_id, null, "global record must record null server_property_id in journal");

  const maps = db.prepare("SELECT server_property_id FROM business_property_map WHERE account_id='A_1' AND generation_id=?").all(started.generation_id);
  const restricted = scopeSpecific([maps[0].server_property_id]);
  restricted.user.role = "manager";
  restricted.user.permissions = JSON.stringify({ manage_operations: true });
  assertEqual(restricted.all, false, "restricted scope must have all=false");

  const rollbackRes = await call(env, "transaction/rollback", { method: "POST", body: { tx_id: txId }, scope: restricted });
  const rollbackBody = await rollbackRes.clone().json().catch(() => ({}));
  assertEqual(rollbackRes.status, 403, `restricted caller must be denied (403) when rolling back global journal record, got ${rollbackRes.status}: ${JSON.stringify(rollbackBody)}`);
});

// ---------------------------------------------------------------------------
// Test 3: Feed empty-page watermark interleaving must not advance unseen change
// ---------------------------------------------------------------------------
await testCase("feed empty-page watermark interleaving must not advance client beyond unseen change", async () => {
  const { db, env, owner } = setupContext();

  const payload = await buildPayload();
  const started = await start(env, payload, owner);
  for (let i = 0; i < payload.chunks.length; i++) await upload(env, started.generation_id, payload, i, owner);
  assertEqual((await call(env, "migration/activate", { method: "POST", body: { generation_id: started.generation_id }, scope: owner })).status, 200);
  refreshScopeProperties(db, owner);

  let inInterleave = false;
  let interleaveFired = false;

  const unhook = hookRevisionFirst(env, async () => {
    if (inInterleave || interleaveFired) return;
    interleaveFired = true;
    inInterleave = true;
    try {
      const mutRes = await call(env, "mutate", {
        method: "POST",
        body: {
          mutation_id: "mutation_feed_interleave_0001",
          entity: "Expense",
          operation: "upsert",
          record_key: typedRecordKey(555),
          property_key: typedRecordKey(7),
          row: { id: 555, property_id: 7, expense_name: "Interleaved Expense", amount: 55.55 },
        },
        scope: owner,
      });
      assertEqual(mutRes.status, 200, "interleaved mutation must succeed");
    } finally {
      inInterleave = false;
    }
  });

  let feedRes;
  try {
    feedRes = await call(env, "feed?since=0&limit=500", { scope: owner });
  } finally {
    unhook();
  }

  assertEqual(feedRes.status, 200);
  const page = await feedRes.json();

  assert(interleaveFired, "feed query sequence was faithfully interleaved");
  let clientWatermark = 0;
  let sawSeq1 = false;
  if (page.items.length === 0) {
    assert(
      page.current_revision <= 0,
      `watermark leak: empty feed page advanced current_revision to ${page.current_revision} ahead of unseen change at seq=1`
    );
    clientWatermark = Math.max(0, Number(page.current_revision) || 0);
  } else {
    sawSeq1 = page.items.some((item) => Number(item.seq) === 1);
    assert(sawSeq1, "non-empty feed page must contain the interleaved change at seq=1");
    assert(Number(page.next_revision) >= 1, `next_revision must be >= 1, got ${page.next_revision}`);
    clientWatermark = Number(page.next_revision);
  }

  const secondFeedRes = await call(env, `feed?since=${clientWatermark}&limit=500`, { scope: owner });
  assertEqual(secondFeedRes.status, 200);
  const secondPage = await secondFeedRes.json();
  if (!sawSeq1) {
    assert(secondPage.items.some((item) => Number(item.seq) === 1), "subsequent feed from watermark must deliver change seq=1");
  } else {
    assertEqual(secondPage.items.length, 0, "subsequent feed from advanced watermark should have no further unseen changes");
  }
});

// ---------------------------------------------------------------------------
// Test 4: Rollback postimage-to-batch interleave must fail closed
// ---------------------------------------------------------------------------
await testCase("rollback postimage-to-batch interleave must fail closed", async () => {
  const { db, env, owner } = setupContext();

  const payload = await buildPayload();
  const started = await start(env, payload, owner);
  for (let i = 0; i < payload.chunks.length; i++) await upload(env, started.generation_id, payload, i, owner);
  assertEqual((await call(env, "migration/activate", { method: "POST", body: { generation_id: started.generation_id }, scope: owner })).status, 200);
  refreshScopeProperties(db, owner);

  const txId = "transaction_rollback_race_0001";
  const opRow = { id: 7777, property_id: 7, expense_name: "Race Target", amount: 77.77 };
  const opRowHash = await hash(canonicalJson(opRow));
  const operation = {
    entity: "Expense",
    operation: "upsert",
    record_key: typedRecordKey(7777),
    property_key: typedRecordKey(7),
    row: opRow,
  };
  const requestHash = await hash(canonicalJson([operation]));
  const startTx = await call(env, "transaction/start", { method: "POST", body: { tx_id: txId, request_hash: requestHash, expected_chunks: 1, operation_count: 1 }, scope: owner });
  assertEqual(startTx.status, 201, `start tx status: ${startTx.status}`);
  const chunkTx = await call(env, "transaction/chunk", { method: "POST", body: { tx_id: txId, chunk_index: 0, chunk_hash: await transactionChunkHash([operation]), operations: [operation] }, scope: owner });
  assertEqual(chunkTx.status, 200, `chunk tx status: ${chunkTx.status}`);
  const commitTx = await call(env, "transaction/commit", { method: "POST", body: { tx_id: txId }, scope: owner });
  assertEqual(commitTx.status, 200, `commit tx status: ${commitTx.status}`);

  let inInterleave = false;
  let interleaveFired = false;

  const unhook = hookRevisionFirst(env, async () => {
    if (inInterleave || interleaveFired) return;
    interleaveFired = true;
    inInterleave = true;
    try {
      const mutRes = await call(env, "mutate", {
        method: "POST",
        body: {
          mutation_id: "mutation_postimage_race_0001",
          entity: "Expense",
          operation: "upsert",
          record_key: typedRecordKey(7777),
          property_key: typedRecordKey(7),
          base_row_hash: opRowHash,
          row: { id: 7777, property_id: 7, expense_name: "Race Target Mutated", amount: 99.99 },
        },
        scope: owner,
      });
      assertEqual(mutRes.status, 200, "concurrent mutation before revision read must succeed");
    } finally {
      inInterleave = false;
    }
  });

  let rollbackRes;
  try {
    rollbackRes = await call(env, "transaction/rollback", { method: "POST", body: { tx_id: txId }, scope: owner });
  } finally {
    unhook();
  }

  assert(interleaveFired, "interleaving after postimage check and before revision read was executed");
  const rollbackBody = await rollbackRes.json();
  assertEqual(
    rollbackRes.status,
    409,
    `rollback must fail closed (409) when record is concurrently modified after postimage checks, got ${rollbackRes.status}: ${JSON.stringify(rollbackBody)}`
  );
});

// ---------------------------------------------------------------------------
// Test 5: Rollback racing a migration activation must fail closed on generation
// ---------------------------------------------------------------------------
await testCase("rollback racing migration activation must fail closed on generation change", async () => {
  const { db, env, owner } = setupContext();

  const p1 = await buildPayload();
  const s1 = await start(env, p1, owner);
  for (let i = 0; i < p1.chunks.length; i++) await upload(env, s1.generation_id, p1, i, owner);
  assertEqual((await call(env, "migration/activate", { method: "POST", body: { generation_id: s1.generation_id }, scope: owner })).status, 200);
  refreshScopeProperties(db, owner);

  const txId = "transaction_rollback_genrace_0001";
  const opRow = { id: 6666, property_id: 7, expense_name: "Generation Race Target", amount: 66.66 };
  const operation = {
    entity: "Expense",
    operation: "upsert",
    record_key: typedRecordKey(6666),
    property_key: typedRecordKey(7),
    row: opRow,
  };
  const requestHash = await hash(canonicalJson([operation]));
  assertEqual((await call(env, "transaction/start", { method: "POST", body: { tx_id: txId, request_hash: requestHash, expected_chunks: 1, operation_count: 1 }, scope: owner })).status, 201);
  assertEqual((await call(env, "transaction/chunk", { method: "POST", body: { tx_id: txId, chunk_index: 0, chunk_hash: await transactionChunkHash([operation]), operations: [operation] }, scope: owner })).status, 200);
  assertEqual((await call(env, "transaction/commit", { method: "POST", body: { tx_id: txId }, scope: owner })).status, 200);

  const p2 = await buildVariantPayload();
  const s2 = await start(env, p2, owner);
  for (let i = 0; i < p2.chunks.length; i++) await upload(env, s2.generation_id, p2, i, owner);

  let activated = false;
  const origBatch = env.DB.batch.bind(env.DB);
  env.DB.batch = async function (statements) {
    if (!activated) {
      activated = true;
      assertEqual((await call(env, "migration/activate", { method: "POST", body: { generation_id: s2.generation_id }, scope: owner })).status, 200, "staged generation must activate mid-rollback");
    }
    return origBatch(statements);
  };

  let rollbackRes;
  try {
    rollbackRes = await call(env, "transaction/rollback", { method: "POST", body: { tx_id: txId }, scope: owner });
  } finally {
    env.DB.batch = origBatch;
  }

  assert(activated, "migration activation interleaved before the rollback batch");
  const rollbackBody = await rollbackRes.json();
  assertEqual(rollbackRes.status, 409, `rollback must fail closed (409) when the active generation changed mid-rollback, got ${rollbackRes.status}: ${JSON.stringify(rollbackBody)}`);
  assertEqual(rollbackBody.code, "ROLLBACK_CONFLICT");
});

// ---------------------------------------------------------------------------
// Summary and Exit
// ---------------------------------------------------------------------------
console.log("\n============================================================");
console.log("Probe Sync Certification Races Summary:");
let failedCount = 0;
for (const r of testResults) {
  console.log(`  [${r.status}] ${r.name}${r.error ? ` -> ${r.error}` : ""}`);
  if (r.status === "FAIL") failedCount++;
}
console.log(`Total: ${testResults.length}, Passed: ${testResults.length - failedCount}, Failed: ${failedCount}`);
console.log("============================================================\n");
console.log(`${failedCount === 0 ? "PASSED" : "FAILED"}: sync certification races: ${testResults.length - failedCount} passed, ${failedCount} failed.`);

process.exit(failedCount > 0 ? 1 : 0);
