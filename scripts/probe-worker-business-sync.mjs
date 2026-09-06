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
} from "../worker/business-sync.js";

const run = makeRunner("probe-worker-business-sync");
const db = makeDb();
db.prepare("INSERT INTO account (id,name,created_date) VALUES (?,?,?)").run("A_1", "Test", "2026-01-01");
seedUser(db, { id: "owner", email: "owner@test.local", role: "owner", mode: "all" });
const env = makeEnv(db, { ENABLE_BUSINESS_SYNC_API: "true" });
const owner = scopeAll([]);
owner.user.id = "owner";

async function hash(value) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(typeof value === "string" ? value : canonicalJson(value))));
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

async function call(path, { method = "GET", body, scope = owner } = {}) {
  const url = new URL(`https://api.test/api/business-sync/${path}`);
  const request = new Request(url, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  return handleBusinessSyncRequest(request, env, scope, url, url.pathname.split("/").filter(Boolean));
}

async function start(payload) {
  const response = await call("migration/start", { method: "POST", body: { manifest: payload.manifest, manifest_hash: payload.manifest_hash } });
  assertEqual(response.status, 201, "migration start status");
  return response.json();
}

async function upload(generationId, payload, index) {
  const response = await call("migration/chunk", { method: "POST", body: { generation_id: generationId, chunk_index: index, chunk_hash: payload.descriptors[index].hash, rows: payload.chunks[index] } });
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

const payload = await buildPayload();
let abortedGeneration;

await run.check("numeric 7 and string 7 have distinct typed identities", () => {
  assertEqual(typedRecordKey(7), "n:7");
  assertEqual(typedRecordKey("7"), "s:1:7");
});

await run.check("migration start rejects an unsupported schema version", async () => {
  const invalid = await buildPayload();
  invalid.manifest.schema_version = 999;
  invalid.manifest_hash = await hash(canonicalJson(invalid.manifest));
  const response = await call("migration/start", { method: "POST", body: { manifest: invalid.manifest, manifest_hash: invalid.manifest_hash } });
  assertEqual(response.status, 422);
  assertEqual(Number(db.prepare("SELECT COUNT(*) AS n FROM business_dataset WHERE account_id='A_1' AND manifest_hash=?").get(invalid.manifest_hash).n), 0);
});

await run.check("25-percent interruption is invisible and staging rollback is complete", async () => {
  const started = await start(payload);
  abortedGeneration = started.generation_id;
  const first = await upload(abortedGeneration, payload, 0);
  assertEqual(first.response.status, 200);
  const pointer = db.prepare("SELECT * FROM business_dataset_pointer").get();
  assert(!pointer, "partial migration became active");
  const rollback = await call("migration/rollback", { method: "POST", body: { generation_id: abortedGeneration } });
  assertEqual(rollback.status, 200);
  assertEqual(Number(db.prepare("SELECT COUNT(*) AS n FROM business_record WHERE generation_id=?").get(abortedGeneration).n), 0);
});

let generation;
await run.check("complete migration activates atomically", async () => {
  const fresh = await buildPayload();
  // The aborted generation was deleted, so the same manifest hash is safe to retry.
  const started = await start(fresh);
  generation = started.generation_id;
  for (let index = 0; index < fresh.chunks.length; index += 1) {
    const result = await upload(generation, fresh, index);
    assertEqual(result.response.status, 200);
    const replay = await upload(generation, fresh, index);
    assertEqual(replay.response.status, 200);
    assertEqual(replay.body.replayed, true);
  }
  const activate = await call("migration/activate", { method: "POST", body: { generation_id: generation } });
  const result = await activate.json();
  assertEqual(activate.status, 200);
  assertEqual(result.status, "active");
  assertEqual(result.properties, 2);
  assertEqual(db.prepare("SELECT active_generation_id FROM business_dataset_pointer WHERE account_id='A_1'").get().active_generation_id, generation);
  owner.propertyIds = db.prepare("SELECT id FROM property WHERE account_id='A_1' ORDER BY id").all().map((row) => row.id);
});

await run.check("replaying migration start after activation is idempotent", async () => {
  const started = await call("migration/start", { method: "POST", body: { manifest: payload.manifest, manifest_hash: payload.manifest_hash } });
  const result = await started.json();
  assertEqual(started.status, 200);
  assertEqual(result.generation_id, generation);
  assertEqual(result.resumed, true);
  assertEqual(Number(db.prepare("SELECT COUNT(*) AS n FROM business_record WHERE account_id='A_1'").get().n), 4);
});

await run.check("snapshot preserves both typed properties and exact cents source values", async () => {
  const props = await (await call("snapshot?entity=Property&limit=10")).json();
  const expenses = await (await call("snapshot?entity=Expense&limit=10")).json();
  assertEqual(props.items.length, 2);
  assertEqual(expenses.items.length, 2);
  assertEqual(Math.round(expenses.items.reduce((sum, item) => sum + item.row.amount, 0) * 100), 6912);
});

await run.check("property-scoped snapshot cannot read the other property", async () => {
  const maps = db.prepare("SELECT property_key,server_property_id FROM business_property_map WHERE generation_id=? ORDER BY property_key").all(generation);
  const restricted = scopeSpecific([maps[0].server_property_id]);
  const response = await call("snapshot?entity=Expense&limit=10", { scope: restricted });
  const result = await response.json();
  assertEqual(result.items.length, 1);
  assertEqual(typedRecordKey(result.items[0].row.property_id), maps[0].property_key);
});

await run.check("server-first mutation is idempotent and appears in the feed", async () => {
  const row = { id: 1, property_id: 7, expense_name: "Numeric", amount: 20.01 };
  const body = { mutation_id: "mutation_expense_0001", entity: "Expense", operation: "upsert", record_key: typedRecordKey(1), property_key: typedRecordKey(7), row, base_row_hash: payload.chunks[1][0].row_hash };
  const first = await call("mutate", { method: "POST", body });
  const firstBody = await first.json();
  assertEqual(first.status, 200);
  const replay = await call("mutate", { method: "POST", body });
  const replayBody = await replay.json();
  assertEqual(replayBody.replayed, true);
  assertEqual(replayBody.seq, firstBody.seq);
  const feed = await (await call("feed?since=0&limit=10")).json();
  assertEqual(feed.items.length, 1);
  assertEqual(feed.items[0].row.amount, 20.01);
});

await run.check("direct mutations reject server-managed scope fields", async () => {
  const currentExpense = db.prepare("SELECT row_hash FROM business_record WHERE generation_id=? AND entity_name='Expense' AND record_key=?").get(generation, typedRecordKey(1));
  const attempts = [
    { mutation_id: "scope_field_expense_create_01", entity: "Expense", operation: "upsert", record_key: typedRecordKey(101), property_key: typedRecordKey(7), row: { id: 101, property_id: 7, amount: 5, account_id: "A_1" } },
    { mutation_id: "scope_field_expense_update_02", entity: "Expense", operation: "upsert", record_key: typedRecordKey(1), property_key: typedRecordKey(7), base_row_hash: currentExpense.row_hash, row: { id: 1, property_id: 7, amount: 15, server_property_id: "injected" } },
    { mutation_id: "scope_field_property_create_03", entity: "Property", operation: "upsert", record_key: typedRecordKey(8), property_key: typedRecordKey(8), row: { id: 8, code: "P-8", name: "Property Eight", server_property_id: "injected" } },
  ];
  const property = db.prepare("SELECT row_hash,row_json FROM business_record WHERE generation_id=? AND entity_name='Property' AND record_key=?").get(generation, typedRecordKey(7));
  attempts.push({ mutation_id: "scope_field_property_update_04", entity: "Property", operation: "upsert", record_key: typedRecordKey(7), property_key: typedRecordKey(7), base_row_hash: property.row_hash, row: { ...JSON.parse(property.row_json), account_id: "A_1" } });
  for (const body of attempts) {
    const response = await call("mutate", { method: "POST", body });
    assertEqual(response.status, 403, `reserved scope field accepted for ${body.entity}`);
    assertEqual((await response.json()).error, "server scope fields are not accepted");
  }
});

await run.check("stale write and cross-property write fail closed", async () => {
  const maps = db.prepare("SELECT property_key,server_property_id FROM business_property_map WHERE generation_id=? ORDER BY property_key").all(generation);
  const restricted = scopeSpecific([maps[0].server_property_id]);
  const stale = await call("mutate", { method: "POST", body: { mutation_id: "mutation_expense_0002", entity: "Expense", operation: "upsert", record_key: typedRecordKey(1), property_key: typedRecordKey(7), row: { id: 1, property_id: 7, amount: 99 }, base_row_hash: "stale" } });
  assertEqual(stale.status, 409);
  const foreignPropertyKey = maps.find((row) => row.server_property_id !== maps[0].server_property_id).property_key;
  const foreign = await call("mutate", { method: "POST", scope: restricted, body: { mutation_id: "mutation_expense_0003", entity: "Expense", operation: "upsert", record_key: typedRecordKey(99), property_key: foreignPropertyKey, row: { id: 99, property_id: foreignPropertyKey.startsWith("n:") ? Number(foreignPropertyKey.slice(2)) : "7", amount: 1 } } });
  assertEqual(foreign.status, 403);
});

await run.check("create-if-absent and current-record property scope are enforced", async () => {
  const maps = db.prepare("SELECT property_key,server_property_id FROM business_property_map WHERE generation_id=? ORDER BY property_key").all(generation);
  const numeric = maps.find((row) => row.property_key === typedRecordKey(7));
  const restricted = scopeSpecific([numeric.server_property_id]);
  const duplicate = await call("mutate", { method: "POST", body: { mutation_id: "mutation_duplicate_0004", entity: "Expense", operation: "upsert", record_key: typedRecordKey(1), property_key: typedRecordKey(7), row: { id: 1, property_id: 7, amount: 2 } } });
  assertEqual(duplicate.status, 409);
  const foreign = db.prepare("SELECT record_key,row_hash FROM business_record WHERE generation_id=? AND entity_name='Expense' AND server_property_id<>?").get(generation, numeric.server_property_id);
  const overwrite = await call("mutate", { method: "POST", scope: restricted, body: { mutation_id: "mutation_idor_000005", entity: "Expense", operation: "upsert", record_key: foreign.record_key, property_key: typedRecordKey(7), row: { id: 2, property_id: 7, amount: 3 }, base_row_hash: foreign.row_hash } });
  assertEqual(overwrite.status, 403);
  const remove = await call("mutate", { method: "POST", scope: restricted, body: { mutation_id: "mutation_idor_000006", entity: "Expense", operation: "delete", record_key: foreign.record_key, property_key: typedRecordKey(7), base_row_hash: foreign.row_hash } });
  assertEqual(remove.status, 403);
});

await run.check("snapshot revision is fixed and feed catches a concurrent create", async () => {
  const firstPage = await (await call("snapshot?entity=Property&limit=1")).json();
  const create = await call("mutate", { method: "POST", body: { mutation_id: "mutation_snapshot_007", entity: "Expense", operation: "upsert", record_key: typedRecordKey(3), property_key: typedRecordKey(7), row: { id: 3, property_id: 7, amount: 4.56 } } });
  assertEqual(create.status, 200);
  const nextPage = await (await call(`snapshot?entity=Property&cursor=${encodeURIComponent(firstPage.next_cursor)}&limit=1&snapshot_revision=${firstPage.snapshot_revision}`)).json();
  assertEqual(nextPage.snapshot_revision, firstPage.snapshot_revision);
  const feed = await (await call(`feed?since=${firstPage.snapshot_revision}&limit=10`)).json();
  assert(feed.items.some((item) => item.record_key === typedRecordKey(3)), "concurrent create missing from feed");
  assertEqual(feed.active_generation_id, generation);
});

await run.check("server id sequence is monotonic across callers", async () => {
  const first = await (await call("id-sequence/reserve", { method: "POST", body: { prefix: "EMP", floor: 12 } })).json();
  const second = await (await call("id-sequence/reserve", { method: "POST", body: { prefix: "EMP", floor: 2 } })).json();
  assertEqual(first.sequence, 13);
  assertEqual(second.sequence, 14);
});

await run.check("property deletion forces a cache rebuild and scope fingerprints differ", async () => {
  const before = await (await call("feed?since=0&limit=100")).json();
  const created = await call("mutate", { method: "POST", body: {
    mutation_id: "mutation_property_create_008",
    entity: "Property",
    operation: "upsert",
    record_key: typedRecordKey(9),
    property_key: typedRecordKey(9),
    row: { id: 9, code: "TEMP-9", name: "Temporary Nine", rooms: 9, active: true },
  } });
  const createdBody = await created.json();
  assertEqual(created.status, 200);
  const removed = await call("mutate", { method: "POST", body: {
    mutation_id: "mutation_property_delete_009",
    entity: "Property",
    operation: "delete",
    record_key: typedRecordKey(9),
    property_key: typedRecordKey(9),
    base_row_hash: createdBody.row_hash,
  } });
  assertEqual(removed.status, 200);
  const after = await (await call(`feed?since=${before.current_revision}&limit=100`)).json();
  assertEqual(after.rebuild_required, true);
  const maps = db.prepare("SELECT server_property_id FROM business_property_map WHERE generation_id=? ORDER BY property_key").all(generation);
  const restricted = await (await call("feed?since=0&limit=1", { scope: scopeSpecific([maps[0].server_property_id]) })).json();
  assert(before.scope_fingerprint !== restricted.scope_fingerprint, "all-property and restricted scopes shared a fingerprint");
});

await run.check("an activated replacement can roll back to the prior generation", async () => {
  const variant = await buildVariantPayload();
  const started = await start(variant);
  for (let index = 0; index < variant.chunks.length; index += 1) await upload(started.generation_id, variant, index);
  const activated = await call("migration/activate", { method: "POST", body: { generation_id: started.generation_id } });
  assertEqual(activated.status, 200);
  assertEqual(db.prepare("SELECT name FROM property WHERE account_id='A_1' AND code='NUM-7'").get().name, "Replacement Numeric Seven");
  const rollback = await call("migration/rollback", { method: "POST", body: { generation_id: started.generation_id } });
  const result = await rollback.json();
  assertEqual(rollback.status, 200);
  assertEqual(result.active_generation_id, generation);
  assertEqual(db.prepare("SELECT active_generation_id FROM business_dataset_pointer WHERE account_id='A_1'").get().active_generation_id, generation);
  const restored = db.prepare("SELECT name,rooms FROM property WHERE account_id='A_1' AND code='NUM-7'").get();
  assertEqual(restored.name, "Numeric Seven");
  assertEqual(restored.rooms, 10);
});

await run.check("rollback restores a prior roster after live property codes are reused", async () => {
  const variant = await buildVariantPayload();
  variant.chunks[0][0].row.name = "Second replacement";
  variant.chunks[0][0].row_hash = await hash(canonicalJson(variant.chunks[0][0].row));
  variant.descriptors[0].hash = await hash(canonicalJson(variant.chunks[0]));
  variant.manifest.chunks = variant.descriptors;
  variant.manifest_hash = await hash(canonicalJson(variant.manifest));
  const started = await start(variant);
  for (let index = 0; index < variant.chunks.length; index += 1) await upload(started.generation_id, variant, index);
  assertEqual((await call("migration/activate", { method: "POST", body: { generation_id: started.generation_id } })).status, 200);

  const numeric = db.prepare("SELECT row_hash,row_json FROM business_record WHERE account_id='A_1' AND generation_id=? AND entity_name='Property' AND record_key=?").get(started.generation_id, typedRecordKey(7));
  const numericRow = { ...JSON.parse(numeric.row_json), code: "TEMP-NUM-7" };
  assertEqual((await call("mutate", { method: "POST", body: { mutation_id: "rollback_code_vacate_001", entity: "Property", operation: "upsert", record_key: typedRecordKey(7), property_key: typedRecordKey(7), base_row_hash: numeric.row_hash, row: numericRow } })).status, 200);
  const stringy = db.prepare("SELECT row_hash,row_json FROM business_record WHERE account_id='A_1' AND generation_id=? AND entity_name='Property' AND record_key=?").get(started.generation_id, typedRecordKey("7"));
  const stringRow = { ...JSON.parse(stringy.row_json), code: "NUM-7" };
  assertEqual((await call("mutate", { method: "POST", body: { mutation_id: "rollback_code_reuse_002", entity: "Property", operation: "upsert", record_key: typedRecordKey("7"), property_key: typedRecordKey("7"), base_row_hash: stringy.row_hash, row: stringRow } })).status, 200);

  const rollback = await call("migration/rollback", { method: "POST", body: { generation_id: started.generation_id } });
  assertEqual(rollback.status, 200, `rollback failed after code reuse: ${JSON.stringify(await rollback.clone().json())}`);
  assertEqual(db.prepare("SELECT name FROM property WHERE account_id='A_1' AND code='NUM-7'").get().name, "Numeric Seven");
  assertEqual(db.prepare("SELECT name FROM property WHERE account_id='A_1' AND code='STR-7'").get().name, "String Seven");
});

await run.check("staged transaction preserves unchanged rows and accepts ordered idempotent chunks", async () => {
  const txId = "transaction_lifecycle_0001";
  const operations = Array.from({ length: 14 }, (_, index) => ({
    entity: "Expense",
    operation: "upsert",
    record_key: typedRecordKey(100 + index),
    property_key: typedRecordKey(7),
    row: { id: 100 + index, property_id: 7, expense_name: `Transaction ${index}`, amount: index + 0.25 },
  }));
  const chunks = [operations.slice(0, 13), operations.slice(13)];
  const hashes = await Promise.all(chunks.map(transactionChunkHash));
  const requestHash = await hash(canonicalJson(operations));
  const before = db.prepare("SELECT row_hash FROM business_record WHERE account_id='A_1' AND generation_id=? AND entity_name='Expense' AND record_key=?").get(generation, typedRecordKey(2));
  const started = await call("transaction/start", { method: "POST", body: { tx_id: txId, request_hash: requestHash, expected_chunks: 2, operation_count: 14 } });
  assertEqual(started.status, 201);
  const gap = await call("transaction/chunk", { method: "POST", body: { tx_id: txId, chunk_index: 1, chunk_hash: hashes[1], operations: chunks[1] } });
  assertEqual(gap.status, 409);
  const first = await call("transaction/chunk", { method: "POST", body: { tx_id: txId, chunk_index: 0, chunk_hash: hashes[0], operations: chunks[0] } });
  assertEqual(first.status, 200);
  const replay = await call("transaction/chunk", { method: "POST", body: { tx_id: txId, chunk_index: 0, chunk_hash: hashes[0], operations: chunks[0] } });
  assertEqual(replay.status, 200);
  assertEqual((await replay.json()).replayed, true);
  const second = await call("transaction/chunk", { method: "POST", body: { tx_id: txId, chunk_index: 1, chunk_hash: hashes[1], operations: chunks[1] } });
  assertEqual(second.status, 200);
  const committed = await call("transaction/commit", { method: "POST", body: { tx_id: txId } });
  assertEqual(committed.status, 200);
  const committedBody = await committed.json();
  const commitReplay = await call("transaction/commit", { method: "POST", body: { tx_id: txId } });
  assertEqual(commitReplay.status, 200);
  assertEqual((await commitReplay.json()).replayed, true);
  const status = await (await call(`transaction/status?tx_id=${txId}`)).json();
  assertEqual(status.status, "committed");
  assertEqual(status.received_operations, 14);
  const unchanged = db.prepare("SELECT row_hash FROM business_record WHERE account_id='A_1' AND generation_id=? AND entity_name='Expense' AND record_key=?").get(committedBody.active_generation_id, typedRecordKey(2));
  assertEqual(unchanged.row_hash, before.row_hash);
  assertEqual(Number(db.prepare("SELECT COUNT(*) AS n FROM business_record WHERE account_id='A_1' AND generation_id=? AND entity_name='Expense' AND record_key LIKE 'n:1%'").get(committedBody.active_generation_id).n) >= 14, true);
  assertEqual(Number(db.prepare("SELECT COUNT(*) AS n FROM business_staging_target WHERE account_id='A_1' AND tx_id=?").get(txId).n), 0);
  assertEqual(Number(db.prepare("SELECT COUNT(*) AS n FROM business_mutation_guard WHERE account_id='A_1' AND request_hash=?").get(requestHash).n), 0);
});

await run.check("concurrent transaction start replay converges on one generation", async () => {
  const txId = "transaction_start_race_0006";
  const requestHash = await hash("concurrent transaction start");
  const [left, right] = await Promise.all([
    call("transaction/start", { method: "POST", body: { tx_id: txId, request_hash: requestHash, expected_chunks: 1, operation_count: 1 } }),
    call("transaction/start", { method: "POST", body: { tx_id: txId, request_hash: requestHash, expected_chunks: 1, operation_count: 1 } }),
  ]);
  const [leftBody, rightBody] = await Promise.all([left.json(), right.json()]);
  assert([200, 201].includes(left.status), "first concurrent start failed");
  assert([200, 201].includes(right.status), "second concurrent start failed");
  assertEqual(leftBody.generation_id, rightBody.generation_id);
  assertEqual(Number(db.prepare("SELECT COUNT(*) AS n FROM business_staging_transaction WHERE account_id='A_1' AND tx_id=?").get(txId).n), 1);
  assertEqual((await call("transaction/abort", { method: "POST", body: { tx_id: txId } })).status, 200);
});

await run.check("staged transaction enforces property scope and supports abort cleanup", async () => {
  const txId = "transaction_abort_0002";
  const operation = { entity: "Expense", operation: "upsert", record_key: typedRecordKey(300), property_key: typedRecordKey("7"), row: { id: 300, property_id: "7", amount: 3 } };
  const requestHash = await hash(canonicalJson([operation]));
  const started = await call("transaction/start", { method: "POST", body: { tx_id: txId, request_hash: requestHash, expected_chunks: 1, operation_count: 1 } });
  const startedBody = await started.json();
  const maps = db.prepare("SELECT property_key,server_property_id FROM business_property_map WHERE account_id='A_1' AND generation_id=?").all(startedBody.generation_id);
  const numeric = maps.find((row) => row.property_key === typedRecordKey(7));
  const denied = await call("transaction/chunk", { method: "POST", scope: scopeSpecific([numeric.server_property_id]), body: { tx_id: txId, chunk_index: 0, chunk_hash: await transactionChunkHash([operation]), operations: [operation] } });
  assertEqual(denied.status, 403);
  const accepted = await call("transaction/chunk", { method: "POST", body: { tx_id: txId, chunk_index: 0, chunk_hash: await transactionChunkHash([operation]), operations: [operation] } });
  assertEqual(accepted.status, 200);
  const aborted = await call("transaction/abort", { method: "POST", body: { tx_id: txId } });
  assertEqual(aborted.status, 200);
  const abortedReplay = await call("transaction/abort", { method: "POST", body: { tx_id: txId } });
  assertEqual(abortedReplay.status, 200);
  assertEqual(Number(db.prepare("SELECT COUNT(*) AS n FROM business_record WHERE account_id='A_1' AND generation_id=?").get(startedBody.generation_id).n), 0);
  assertEqual(Number(db.prepare("SELECT COUNT(*) AS n FROM business_migration_chunk WHERE account_id='A_1' AND generation_id=?").get(startedBody.generation_id).n), 0);
  assertEqual(Number(db.prepare("SELECT COUNT(*) AS n FROM business_staging_target WHERE account_id='A_1' AND tx_id=?").get(txId).n), 0);
  assertEqual(Number(db.prepare("SELECT COUNT(*) AS n FROM business_mutation_guard WHERE account_id='A_1' AND request_hash=?").get(requestHash).n), 0);
});

await run.check("staged transaction rejects a stale revision and records the conflict", async () => {
  const txId = "transaction_conflict_0003";
  const operation = { entity: "Expense", operation: "upsert", record_key: typedRecordKey(400), property_key: typedRecordKey(7), row: { id: 400, property_id: 7, amount: 4 } };
  const started = await call("transaction/start", { method: "POST", body: { tx_id: txId, request_hash: await hash(canonicalJson([operation])), expected_chunks: 1, operation_count: 1 } });
  assertEqual(started.status, 201);
  const chunk = await call("transaction/chunk", { method: "POST", body: { tx_id: txId, chunk_index: 0, chunk_hash: await transactionChunkHash([operation]), operations: [operation] } });
  assertEqual(chunk.status, 200);
  const concurrent = await call("mutate", { method: "POST", body: { mutation_id: "mutation_tx_conflict_010", entity: "Expense", operation: "upsert", record_key: typedRecordKey(401), property_key: typedRecordKey(7), row: { id: 401, property_id: 7, amount: 4.01 } } });
  assertEqual(concurrent.status, 200);
  const commit = await call("transaction/commit", { method: "POST", body: { tx_id: txId } });
  assertEqual(commit.status, 409);
  const status = await (await call(`transaction/status?tx_id=${txId}`)).json();
  assertEqual(status.status, "conflict");
  const replay = await call("transaction/commit", { method: "POST", body: { tx_id: txId } });
  const replayBody = await replay.json();
  assertEqual(replay.status, 409);
  assertEqual(replayBody.code, "sync_conflict");
  assertEqual(Number(db.prepare("SELECT COUNT(*) AS n FROM business_record WHERE account_id='A_1' AND generation_id=?").get(status.staging_generation_id).n), 0);
  assertEqual(Number(db.prepare("SELECT COUNT(*) AS n FROM business_migration_chunk WHERE account_id='A_1' AND generation_id=?").get(status.staging_generation_id).n), 0);
  assertEqual(Number(db.prepare("SELECT COUNT(*) AS n FROM business_staging_target WHERE account_id='A_1' AND tx_id=?").get(txId).n), 0);
  assertEqual(Number(db.prepare("SELECT COUNT(*) AS n FROM business_mutation_guard WHERE account_id='A_1' AND request_hash=?").get(await hash(canonicalJson([operation]))).n), 0);
});

await run.check("expired staged transaction is cleaned on the next start", async () => {
  const expiredTxId = "transaction_expired_0004";
  const operation = { entity: "Expense", operation: "upsert", record_key: typedRecordKey(500), property_key: typedRecordKey(7), row: { id: 500, property_id: 7, amount: 5 } };
  const started = await call("transaction/start", { method: "POST", body: { tx_id: expiredTxId, request_hash: await hash(canonicalJson([operation])), expected_chunks: 1, operation_count: 1 } });
  const startedBody = await started.json();
  const chunk = await call("transaction/chunk", { method: "POST", body: { tx_id: expiredTxId, chunk_index: 0, chunk_hash: await transactionChunkHash([operation]), operations: [operation] } });
  assertEqual(chunk.status, 200);
  db.prepare("UPDATE business_staging_transaction SET expires_at='2000-01-01T00:00:00.000Z' WHERE account_id='A_1' AND tx_id=?").run(expiredTxId);
  const nextTxId = "transaction_cleanup_0005";
  const next = await call("transaction/start", { method: "POST", body: { tx_id: nextTxId, request_hash: await hash("cleanup transaction"), expected_chunks: 1, operation_count: 1 } });
  assertEqual(next.status, 201);
  assertEqual(db.prepare("SELECT status FROM business_staging_transaction WHERE account_id='A_1' AND tx_id=?").get(expiredTxId).status, "expired");
  assertEqual(Number(db.prepare("SELECT COUNT(*) AS n FROM business_record WHERE account_id='A_1' AND generation_id=?").get(startedBody.generation_id).n), 0);
  assertEqual(Number(db.prepare("SELECT COUNT(*) AS n FROM business_migration_chunk WHERE account_id='A_1' AND generation_id=?").get(startedBody.generation_id).n), 0);
  assertEqual(Number(db.prepare("SELECT COUNT(*) AS n FROM business_staging_target WHERE account_id='A_1' AND tx_id=?").get(expiredTxId).n), 0);
  assertEqual(Number(db.prepare("SELECT COUNT(*) AS n FROM business_mutation_guard WHERE account_id='A_1' AND request_hash=?").get(await hash(canonicalJson([operation]))).n), 0);
  const cleanup = await call("transaction/abort", { method: "POST", body: { tx_id: nextTxId } });
  assertEqual(cleanup.status, 200);
});

await run.check("commit cannot activate a staging generation aborted during the commit race", async () => {
  const txId = "transaction_commit_race_0007";
  const operation = { entity: "Expense", operation: "upsert", record_key: typedRecordKey(600), property_key: typedRecordKey(7), row: { id: 600, property_id: 7, amount: 6 } };
  const requestHash = await hash(canonicalJson([operation]));
  const started = await call("transaction/start", { method: "POST", body: { tx_id: txId, request_hash: requestHash, expected_chunks: 1, operation_count: 1 } });
  const startedBody = await started.json();
  assertEqual((await call("transaction/chunk", { method: "POST", body: { tx_id: txId, chunk_index: 0, chunk_hash: await transactionChunkHash([operation]), operations: [operation] } })).status, 200);
  const pointerBefore = db.prepare("SELECT active_generation_id FROM business_dataset_pointer WHERE account_id='A_1'").get().active_generation_id;
  const originalBatch = env.DB.batch.bind(env.DB);
  let intercepted = false;
  env.DB.batch = async (statements) => {
    if (!intercepted && statements.some((statement) => String(statement._sql).includes("SET status='committed'"))) {
      intercepted = true;
      db.prepare("DELETE FROM business_record WHERE account_id='A_1' AND generation_id=?").run(startedBody.generation_id);
      db.prepare("DELETE FROM business_property_map WHERE account_id='A_1' AND generation_id=?").run(startedBody.generation_id);
      db.prepare("DELETE FROM business_migration_chunk WHERE account_id='A_1' AND generation_id=?").run(startedBody.generation_id);
      db.prepare("DELETE FROM business_staging_target WHERE account_id='A_1' AND tx_id=?").run(txId);
      db.prepare("UPDATE business_dataset SET status='aborted' WHERE account_id='A_1' AND generation_id=?").run(startedBody.generation_id);
      db.prepare("UPDATE business_staging_transaction SET status='aborted' WHERE account_id='A_1' AND tx_id=?").run(txId);
    }
    return originalBatch(statements);
  };
  try {
    const commit = await call("transaction/commit", { method: "POST", body: { tx_id: txId } });
    assertEqual(commit.status, 409);
  } finally {
    env.DB.batch = originalBatch;
  }
  assertEqual(db.prepare("SELECT active_generation_id FROM business_dataset_pointer WHERE account_id='A_1'").get().active_generation_id, pointerBefore);
});

await run.check("chunk cannot write after expiry wins the upload race", async () => {
  const txId = "transaction_chunk_race_0008";
  const operation = { entity: "Expense", operation: "upsert", record_key: typedRecordKey(700), property_key: typedRecordKey(7), row: { id: 700, property_id: 7, amount: 7 } };
  const requestHash = await hash(canonicalJson([operation]));
  const started = await call("transaction/start", { method: "POST", body: { tx_id: txId, request_hash: requestHash, expected_chunks: 1, operation_count: 1 } });
  const startedBody = await started.json();
  const originalBatch = env.DB.batch.bind(env.DB);
  let intercepted = false;
  env.DB.batch = async (statements) => {
    if (!intercepted && statements.some((statement) => String(statement._sql).includes("INSERT INTO business_migration_chunk"))) {
      intercepted = true;
      db.prepare("DELETE FROM business_record WHERE account_id='A_1' AND generation_id=?").run(startedBody.generation_id);
      db.prepare("DELETE FROM business_property_map WHERE account_id='A_1' AND generation_id=?").run(startedBody.generation_id);
      db.prepare("UPDATE business_dataset SET status='aborted' WHERE account_id='A_1' AND generation_id=?").run(startedBody.generation_id);
      db.prepare("UPDATE business_staging_transaction SET status='expired' WHERE account_id='A_1' AND tx_id=?").run(txId);
    }
    return originalBatch(statements);
  };
  try {
    const chunk = await call("transaction/chunk", { method: "POST", body: { tx_id: txId, chunk_index: 0, chunk_hash: await transactionChunkHash([operation]), operations: [operation] } });
    assertEqual(chunk.status, 409);
  } finally {
    env.DB.batch = originalBatch;
  }
  assertEqual(Number(db.prepare("SELECT COUNT(*) AS n FROM business_record WHERE account_id='A_1' AND generation_id=?").get(startedBody.generation_id).n), 0);
  assertEqual(Number(db.prepare("SELECT COUNT(*) AS n FROM business_migration_chunk WHERE account_id='A_1' AND generation_id=?").get(startedBody.generation_id).n), 0);
  assertEqual(Number(db.prepare("SELECT COUNT(*) AS n FROM business_staging_target WHERE account_id='A_1' AND tx_id=?").get(txId).n), 0);
});

await run.check("abort cannot destroy a dataset activated during the abort race", async () => {
  const txId = "transaction_abort_after_commit_0009";
  const operation = { entity: "Expense", operation: "upsert", record_key: typedRecordKey(800), property_key: typedRecordKey(7), row: { id: 800, property_id: 7, amount: 8 } };
  const requestHash = await hash(canonicalJson([operation]));
  const started = await call("transaction/start", { method: "POST", body: { tx_id: txId, request_hash: requestHash, expected_chunks: 1, operation_count: 1 } });
  const startedBody = await started.json();
  assertEqual((await call("transaction/chunk", { method: "POST", body: { tx_id: txId, chunk_index: 0, chunk_hash: await transactionChunkHash([operation]), operations: [operation] } })).status, 200);
  const originalBatch = env.DB.batch.bind(env.DB);
  let intercepted = false;
  let commitStatus = 0;
  env.DB.batch = async (statements) => {
    if (!intercepted && statements.some((statement) => String(statement._sql).includes("UPDATE business_staging_transaction SET status='aborted'"))) {
      intercepted = true;
      commitStatus = (await call("transaction/commit", { method: "POST", body: { tx_id: txId } })).status;
    }
    return originalBatch(statements);
  };
  let abortStatus = 0;
  try {
    abortStatus = (await call("transaction/abort", { method: "POST", body: { tx_id: txId } })).status;
  } finally {
    env.DB.batch = originalBatch;
  }
  assert(intercepted, "the abort cleanup batch was never intercepted");
  assertEqual(commitStatus, 200, "the injected concurrent commit must win");
  assert(abortStatus >= 400, `abort must fail closed once the commit won, got ${abortStatus}`);
  const pointer = db.prepare("SELECT active_generation_id FROM business_dataset_pointer WHERE account_id='A_1'").get().active_generation_id;
  const committedBase = db.prepare("SELECT base_generation_id FROM business_staging_transaction WHERE account_id='A_1' AND tx_id=?").get(txId).base_generation_id;
  assertEqual(pointer, committedBase, "the committed generation must stay active");
  assertEqual(db.prepare("SELECT status FROM business_staging_transaction WHERE account_id='A_1' AND tx_id=?").get(txId).status, "committed");
  assert(Number(db.prepare("SELECT COUNT(*) AS n FROM business_record WHERE account_id='A_1' AND generation_id=?").get(pointer).n) > 0, "the losing abort destroyed the active dataset");
});

await run.check("expiry sweep cannot destroy a dataset committed during the sweep race", async () => {
  const txId = "transaction_expire_after_commit_0010";
  const operation = { entity: "Expense", operation: "upsert", record_key: typedRecordKey(810), property_key: typedRecordKey(7), row: { id: 810, property_id: 7, amount: 8.1 } };
  const requestHash = await hash(canonicalJson([operation]));
  const started = await call("transaction/start", { method: "POST", body: { tx_id: txId, request_hash: requestHash, expected_chunks: 1, operation_count: 1 } });
  const startedBody = await started.json();
  assertEqual((await call("transaction/chunk", { method: "POST", body: { tx_id: txId, chunk_index: 0, chunk_hash: await transactionChunkHash([operation]), operations: [operation] } })).status, 200);
  db.prepare("UPDATE business_staging_transaction SET expires_at='2000-01-01T00:00:00.000Z' WHERE account_id='A_1' AND tx_id=?").run(txId);
  const originalBatch = env.DB.batch.bind(env.DB);
  let intercepted = false;
  let commitStatus = 0;
  let commitBody = "";
  env.DB.batch = async (statements) => {
    if (!intercepted && statements.some((statement) => String(statement._sql).includes("UPDATE business_staging_transaction SET status='expired'"))) {
      intercepted = true;
      db.prepare("UPDATE business_staging_transaction SET expires_at='2999-01-01T00:00:00.000Z' WHERE account_id='A_1' AND tx_id=?").run(txId);
      const injected = await call("transaction/commit", { method: "POST", body: { tx_id: txId } });
      commitStatus = injected.status;
      commitBody = JSON.stringify(await injected.json());
    }
    return originalBatch(statements);
  };
  try {
    assertEqual((await call("transaction/start", { method: "POST", body: { tx_id: "transaction_sweep_driver_0010", request_hash: await hash("sweep driver"), expected_chunks: 1, operation_count: 1 } })).status, 201);
  } finally {
    env.DB.batch = originalBatch;
  }
  assert(intercepted, "the expiry cleanup batch was never intercepted");
  assertEqual(commitStatus, 200, `the injected concurrent commit must win (body: ${commitBody})`);
  assertEqual(db.prepare("SELECT status FROM business_staging_transaction WHERE account_id='A_1' AND tx_id=?").get(txId).status, "committed", "the committed transaction must not be downgraded to expired");
  const activePointer = db.prepare("SELECT active_generation_id FROM business_dataset_pointer WHERE account_id='A_1'").get().active_generation_id;
  assert(Number(db.prepare("SELECT COUNT(*) AS n FROM business_record WHERE account_id='A_1' AND generation_id=?").get(activePointer).n) > 0, "the losing expiry sweep destroyed the committed dataset");
  assertEqual((await call("transaction/abort", { method: "POST", body: { tx_id: "transaction_sweep_driver_0010" } })).status, 200);
});

await run.check("property scope is enforced on a later chunk, not only the first", async () => {
  const txId = "transaction_late_chunk_scope_0011";
  const allowed = [];
  for (let index = 0; index < 13; index += 1) {
    allowed.push({ entity: "Expense", operation: "upsert", record_key: typedRecordKey(1000 + index), property_key: typedRecordKey(7), row: { id: 1000 + index, property_id: 7, amount: 1 + index } });
  }
  const smuggled = { entity: "Expense", operation: "upsert", record_key: typedRecordKey(1099), property_key: typedRecordKey("7"), row: { id: 1099, property_id: "7", amount: 10.99 } };
  const requestHash = await hash(canonicalJson([...allowed, smuggled]));
  const started = await call("transaction/start", { method: "POST", body: { tx_id: txId, request_hash: requestHash, expected_chunks: 2, operation_count: 14 } });
  const startedBody = await started.json();
  assertEqual(started.status, 201);
  const maps = db.prepare("SELECT property_key,server_property_id FROM business_property_map WHERE account_id='A_1' AND generation_id=?").all(startedBody.generation_id);
  const numeric = maps.find((row) => row.property_key === typedRecordKey(7));
  // A property-restricted scope that still clears the mutation ROLE gate, so the
  // assertions below prove the PROPERTY gate rather than the role gate.
  const scoped = {
    user: { id: "mgr", account_id: "A_1", email: "mgr@test.local", role: "manager", property_access_mode: "specific", permissions: { manual_entry: true } },
    accountId: "A_1",
    all: false,
    propertyIds: [numeric.server_property_id],
  };
  const first = await call("transaction/chunk", { method: "POST", scope: scoped, body: { tx_id: txId, chunk_index: 0, chunk_hash: await transactionChunkHash(allowed), operations: allowed } });
  assertEqual(first.status, 200, "the in-scope first chunk must be accepted");
  const later = await call("transaction/chunk", { method: "POST", scope: scoped, body: { tx_id: txId, chunk_index: 1, chunk_hash: await transactionChunkHash([smuggled]), operations: [smuggled] } });
  assertEqual(later.status, 403, "an out-of-scope property smuggled into a later chunk must be denied");
  assertEqual(Number(db.prepare("SELECT next_chunk_index AS n FROM business_staging_transaction WHERE account_id='A_1' AND tx_id=?").get(txId).n), 1);
  assertEqual(Number(db.prepare("SELECT COUNT(*) AS n FROM business_staging_target WHERE account_id='A_1' AND tx_id=? AND server_property_id<>?").get(txId, numeric.server_property_id).n), 0, "no out-of-scope target may be staged");
  assertEqual((await call("transaction/abort", { method: "POST", body: { tx_id: txId } })).status, 200);
});

await run.check("commit cannot activate a transaction that was already aborted", async () => {
  const txId = "transaction_commit_after_abort_0012";
  const operation = { entity: "Expense", operation: "upsert", record_key: typedRecordKey(1100), property_key: typedRecordKey(7), row: { id: 1100, property_id: 7, amount: 11 } };
  const requestHash = await hash(canonicalJson([operation]));
  const started = await call("transaction/start", { method: "POST", body: { tx_id: txId, request_hash: requestHash, expected_chunks: 1, operation_count: 1 } });
  const startedBody = await started.json();
  assertEqual((await call("transaction/chunk", { method: "POST", body: { tx_id: txId, chunk_index: 0, chunk_hash: await transactionChunkHash([operation]), operations: [operation] } })).status, 200);
  const pointerBefore = db.prepare("SELECT active_generation_id FROM business_dataset_pointer WHERE account_id='A_1'").get().active_generation_id;
  const revisionBefore = Number(db.prepare("SELECT revision FROM business_sync_state WHERE account_id='A_1'").get().revision);
  assertEqual((await call("transaction/abort", { method: "POST", body: { tx_id: txId } })).status, 200);
  const late = await call("transaction/commit", { method: "POST", body: { tx_id: txId } });
  assertEqual(late.status, 409, "a commit after abort must be refused");
  assertEqual(db.prepare("SELECT active_generation_id FROM business_dataset_pointer WHERE account_id='A_1'").get().active_generation_id, pointerBefore, "the aborted generation must never become active");
  assert(startedBody.generation_id !== pointerBefore, "the staging generation must differ from the active generation");
  assertEqual(Number(db.prepare("SELECT revision FROM business_sync_state WHERE account_id='A_1'").get().revision), revisionBefore);
  assertEqual(db.prepare("SELECT status FROM business_staging_transaction WHERE account_id='A_1' AND tx_id=?").get(txId).status, "aborted");
});

await run.check("a pending staging generation is invisible to snapshot and feed", async () => {
  const txId = "transaction_pending_visibility_0013";
  const operation = { entity: "Expense", operation: "upsert", record_key: typedRecordKey(1200), property_key: typedRecordKey(7), row: { id: 1200, property_id: 7, amount: 12 } };
  const requestHash = await hash(canonicalJson([operation]));
  const activeBefore = db.prepare("SELECT active_generation_id FROM business_dataset_pointer WHERE account_id='A_1'").get().active_generation_id;
  const started = await call("transaction/start", { method: "POST", body: { tx_id: txId, request_hash: requestHash, expected_chunks: 1, operation_count: 1 } });
  const startedBody = await started.json();
  assertEqual((await call("transaction/chunk", { method: "POST", body: { tx_id: txId, chunk_index: 0, chunk_hash: await transactionChunkHash([operation]), operations: [operation] } })).status, 200);
  assert(Number(db.prepare("SELECT COUNT(*) AS n FROM business_record_staging WHERE account_id='A_1' AND transaction_id=? AND record_key=?").get(txId, typedRecordKey(1200)).n) === 1, "the staged row must exist in staging");
  assert(Number(db.prepare("SELECT COUNT(*) AS n FROM business_record WHERE account_id='A_1' AND generation_id=? AND record_key=?").get(activeBefore, typedRecordKey(1200)).n) === 0, "the uncommitted row must not exist in the active generation");
  const snap = await (await call("snapshot?entity=Expense&limit=200")).json();
  assertEqual(snap.generation_id, activeBefore, "snapshot must read the active generation, never the staging generation");
  assertEqual(snap.items.filter((item) => item.record_key === typedRecordKey(1200)).length, 0, "an uncommitted staged row must not appear in a snapshot");
  const changes = await (await call("feed?since=0&limit=200")).json();
  assertEqual(changes.active_generation_id, activeBefore, "feed must report the active generation");
  assertEqual(changes.items.filter((item) => item.record_key === typedRecordKey(1200)).length, 0, "an uncommitted staged row must not appear in the feed");
  assertEqual((await call("transaction/abort", { method: "POST", body: { tx_id: txId } })).status, 200);
});

await run.check("expiry sweep destroys only the expired transaction and spares a live one", async () => {
  const liveTxId = "transaction_sweep_survivor_0014";
  const staleTxId = "transaction_sweep_victim_0014";
  const liveOp = { entity: "Expense", operation: "upsert", record_key: typedRecordKey(1300), property_key: typedRecordKey(7), row: { id: 1300, property_id: 7, amount: 13 } };
  const staleOp = { entity: "Expense", operation: "upsert", record_key: typedRecordKey(1301), property_key: typedRecordKey(7), row: { id: 1301, property_id: 7, amount: 13.01 } };
  const live = await (await call("transaction/start", { method: "POST", body: { tx_id: liveTxId, request_hash: await hash(canonicalJson([liveOp])), expected_chunks: 1, operation_count: 1 } })).json();
  assertEqual((await call("transaction/chunk", { method: "POST", body: { tx_id: liveTxId, chunk_index: 0, chunk_hash: await transactionChunkHash([liveOp]), operations: [liveOp] } })).status, 200);
  const stale = await (await call("transaction/start", { method: "POST", body: { tx_id: staleTxId, request_hash: await hash(canonicalJson([staleOp])), expected_chunks: 1, operation_count: 1 } })).json();
  assertEqual((await call("transaction/chunk", { method: "POST", body: { tx_id: staleTxId, chunk_index: 0, chunk_hash: await transactionChunkHash([staleOp]), operations: [staleOp] } })).status, 200);
  db.prepare("UPDATE business_staging_transaction SET expires_at='2000-01-01T00:00:00.000Z' WHERE account_id='A_1' AND tx_id=?").run(staleTxId);
  const driverTxId = "transaction_sweep_driver_0014";
  assertEqual((await call("transaction/start", { method: "POST", body: { tx_id: driverTxId, request_hash: await hash("sweep driver 0014"), expected_chunks: 1, operation_count: 1 } })).status, 201);
  assertEqual(db.prepare("SELECT status FROM business_staging_transaction WHERE account_id='A_1' AND tx_id=?").get(staleTxId).status, "expired");
  assertEqual(Number(db.prepare("SELECT COUNT(*) AS n FROM business_record_staging WHERE account_id='A_1' AND transaction_id=?").get(staleTxId).n), 0, "the expired staging transaction must be cleaned");
  assertEqual(db.prepare("SELECT status FROM business_staging_transaction WHERE account_id='A_1' AND tx_id=?").get(liveTxId).status, "pending", "the live transaction must survive the sweep");
  assert(Number(db.prepare("SELECT COUNT(*) AS n FROM business_record_staging WHERE account_id='A_1' AND transaction_id=?").get(liveTxId).n) > 0, "the sweep destroyed a live transaction's staged rows");
  assertEqual(Number(db.prepare("SELECT COUNT(*) AS n FROM business_staging_target WHERE account_id='A_1' AND tx_id=?").get(liveTxId).n), 1, "the sweep destroyed a live transaction's staged targets");
  assertEqual((await call("transaction/abort", { method: "POST", body: { tx_id: liveTxId } })).status, 200);
  assertEqual((await call("transaction/abort", { method: "POST", body: { tx_id: driverTxId } })).status, 200);
});

await run.check("a second account cannot read, mutate, abort, or commit the first account's transaction", async () => {
  db.prepare("INSERT INTO account (id,name,created_date) VALUES (?,?,?)").run("A_2", "Other Tenant", "2026-01-01");
  seedUser(db, { id: "intruder", email: "intruder@other.local", role: "owner", mode: "all", accountId: "A_2" });
  const intruder = { user: { id: "intruder", account_id: "A_2", email: "intruder@other.local", role: "owner", property_access_mode: "all" }, accountId: "A_2", all: true, propertyIds: [] };
  const txId = "transaction_cross_account_0015";
  const operation = { entity: "Expense", operation: "upsert", record_key: typedRecordKey(1400), property_key: typedRecordKey(7), row: { id: 1400, property_id: 7, amount: 14 } };
  const started = await (await call("transaction/start", { method: "POST", body: { tx_id: txId, request_hash: await hash(canonicalJson([operation])), expected_chunks: 1, operation_count: 1 } })).json();
  assertEqual((await call("transaction/chunk", { method: "POST", body: { tx_id: txId, chunk_index: 0, chunk_hash: await transactionChunkHash([operation]), operations: [operation] } })).status, 200);
  const activeA = db.prepare("SELECT active_generation_id FROM business_dataset_pointer WHERE account_id='A_1'").get().active_generation_id;
  const recordsA = Number(db.prepare("SELECT COUNT(*) AS n FROM business_record WHERE account_id='A_1' AND generation_id=?").get(activeA).n);
  assertEqual((await call(`transaction/status?tx_id=${txId}`, { scope: intruder })).status, 404, "cross-account transaction status must not resolve");
  assertEqual((await call("transaction/chunk", { method: "POST", scope: intruder, body: { tx_id: txId, chunk_index: 1, chunk_hash: await transactionChunkHash([operation]), operations: [operation] } })).status, 404, "cross-account chunk upload must not resolve");
  assertEqual((await call("transaction/abort", { method: "POST", scope: intruder, body: { tx_id: txId } })).status, 404, "cross-account abort must not resolve");
  assertEqual((await call("transaction/commit", { method: "POST", scope: intruder, body: { tx_id: txId } })).status, 404, "cross-account commit must not resolve");
  const foreignSnapshot = await call("snapshot?entity=Expense&limit=200", { scope: intruder });
  assertEqual(foreignSnapshot.status, 404, "a foreign account must not receive a snapshot of another tenant's dataset");
  const foreignFeed = await call("feed?since=0&limit=200", { scope: intruder });
  assertEqual(foreignFeed.status, 200);
  const foreignFeedBody = await foreignFeed.json();
  assertEqual(foreignFeedBody.items.length, 0, "a foreign account must receive zero change rows");
  assertEqual(foreignFeedBody.active_generation_id, null, "a foreign account must not learn another tenant's generation id");
  const foreignMutate = await call("mutate", { method: "POST", scope: intruder, body: { mutation_id: "mutation_cross_account_0015", entity: "Expense", operation: "upsert", record_key: typedRecordKey(1400), property_key: typedRecordKey(7), row: { id: 1400, property_id: 7, amount: 99.99 } } });
  assert(foreignMutate.status >= 400, `a foreign account must not mutate another tenant's records, got ${foreignMutate.status}`);
  assertEqual((await call("migration/rollback", { method: "POST", scope: intruder, body: { generation_id: started.generation_id } })).status, 404, "cross-account rollback must not resolve");
  assertEqual(db.prepare("SELECT status FROM business_staging_transaction WHERE account_id='A_1' AND tx_id=?").get(txId).status, "pending", "the victim transaction must remain pending");
  assertEqual(Number(db.prepare("SELECT COUNT(*) AS n FROM business_record WHERE account_id='A_1' AND generation_id=?").get(activeA).n), recordsA, "the victim account's active dataset must be untouched");
  assertEqual(Number(db.prepare("SELECT COUNT(*) AS n FROM business_record WHERE account_id='A_2'").get().n), 0, "the intruder account must hold no business records");
  assertEqual(db.prepare("SELECT active_generation_id FROM business_dataset_pointer WHERE account_id='A_1'").get().active_generation_id, activeA);
  assertEqual((await call("transaction/abort", { method: "POST", body: { tx_id: txId } })).status, 200);
});

await run.check("only a transaction creator or account administrator can abort it", async () => {
  const propertyId = db.prepare("SELECT server_property_id FROM business_property_map WHERE account_id='A_1' AND property_key=? LIMIT 1").get(typedRecordKey(7)).server_property_id;
  seedUser(db, { id: "manager_creator", email: "manager.creator@test.local", role: "manager", mode: "specific", grants: [propertyId] });
  seedUser(db, { id: "manager_unrelated", email: "manager.unrelated@test.local", role: "manager", mode: "specific", grants: [propertyId] });
  const creator = { user: { id: "manager_creator", role: "manager", permissions: { manual_entry: true } }, accountId: "A_1", all: false, propertyIds: [propertyId] };
  const unrelated = { user: { id: "manager_unrelated", role: "manager", permissions: { manual_entry: true } }, accountId: "A_1", all: false, propertyIds: [propertyId] };
  const txId = "transaction_abort_owner_0016";
  const operation = { entity: "Expense", operation: "upsert", record_key: typedRecordKey(1600), property_key: typedRecordKey(7), row: { id: 1600, property_id: 7, amount: 16 } };
  assertEqual((await call("transaction/start", { method: "POST", scope: creator, body: { tx_id: txId, request_hash: await hash(canonicalJson([operation])), expected_chunks: 1, operation_count: 1 } })).status, 201);
  assertEqual((await call("transaction/chunk", { method: "POST", scope: creator, body: { tx_id: txId, chunk_index: 0, chunk_hash: await transactionChunkHash([operation]), operations: [operation] } })).status, 200);
  assertEqual((await call("transaction/abort", { method: "POST", scope: unrelated, body: { tx_id: txId } })).status, 403);
  assertEqual(db.prepare("SELECT status FROM business_staging_transaction WHERE account_id='A_1' AND tx_id=?").get(txId).status, "pending");
  assertEqual((await call("transaction/abort", { method: "POST", scope: creator, body: { tx_id: txId } })).status, 200);
});

await run.check("atomic guard blocks concurrent transaction starts at the cap boundary", async () => {
  for (const row of db.prepare("SELECT tx_id FROM business_staging_transaction WHERE account_id='A_1' AND status='pending'").all()) await call("transaction/abort", { method: "POST", body: { tx_id: row.tx_id } });
  for (let index = 1; index <= 2; index += 1) {
    const operation = { entity: "Expense", operation: "upsert", record_key: typedRecordKey(1800 + index), property_key: typedRecordKey(7), row: { id: 1800 + index, property_id: 7, amount: 18 + index / 100 } };
    assertEqual((await call("transaction/start", { method: "POST", body: { tx_id: `transaction_cap_fill_00${index}`, request_hash: await hash(canonicalJson([operation])), expected_chunks: 1, operation_count: 1 } })).status, 201);
  }
  const candidates = [1, 2].map((index) => ({
    txId: `transaction_cap_race_00${index}`,
    operation: { entity: "Expense", operation: "upsert", record_key: typedRecordKey(1810 + index), property_key: typedRecordKey(7), row: { id: 1810 + index, property_id: 7, amount: 18.1 + index / 100 } },
  }));
  const [first, second] = await Promise.all(
    candidates.map(async ({ txId, operation }) => call("transaction/start", {
      method: "POST",
      body: { tx_id: txId, request_hash: await hash(canonicalJson([operation])), expected_chunks: 1, operation_count: 1 },
    })),
  );
  assertEqual([first.status, second.status].sort().join(","), "201,409");
  assertEqual(Number(db.prepare("SELECT COUNT(*) AS n FROM business_staging_transaction WHERE account_id='A_1' AND status='pending'").get().n), 3);
  assertEqual(Number(db.prepare("SELECT COUNT(*) AS n FROM business_mutation_guard WHERE account_id='A_1' AND mutation_id LIKE 'transaction_cap_%:cap'").get().n), 0);
  for (const row of db.prepare("SELECT tx_id FROM business_staging_transaction WHERE account_id='A_1' AND status='pending'").all()) await call("transaction/abort", { method: "POST", body: { tx_id: row.tx_id } });
});

await run.check("expired pending transactions free capacity before admission", async () => {
  const txIds = [];
  for (let index = 1; index <= 3; index += 1) {
    const txId = `transaction_expiry_cap_00${index}`;
    const operation = { entity: "Expense", operation: "upsert", record_key: typedRecordKey(1900 + index), property_key: typedRecordKey(7), row: { id: 1900 + index, property_id: 7, amount: 19 + index / 100 } };
    assertEqual((await call("transaction/start", { method: "POST", body: { tx_id: txId, request_hash: await hash(canonicalJson([operation])), expected_chunks: 1, operation_count: 1 } })).status, 201);
    txIds.push(txId);
  }
  db.prepare("UPDATE business_staging_transaction SET expires_at='2000-01-01T00:00:00.000Z' WHERE account_id='A_1' AND tx_id=?").run(txIds[0]);
  const replacement = { entity: "Expense", operation: "upsert", record_key: typedRecordKey(1904), property_key: typedRecordKey(7), row: { id: 1904, property_id: 7, amount: 19.04 } };
  assertEqual((await call("transaction/start", { method: "POST", body: { tx_id: "transaction_expiry_cap_004", request_hash: await hash(canonicalJson([replacement])), expected_chunks: 1, operation_count: 1 } })).status, 201);
  assertEqual(db.prepare("SELECT status FROM business_staging_transaction WHERE account_id='A_1' AND tx_id=?").get(txIds[0]).status, "expired");
  for (const row of db.prepare("SELECT tx_id FROM business_staging_transaction WHERE account_id='A_1' AND status='pending'").all()) await call("transaction/abort", { method: "POST", body: { tx_id: row.tx_id } });
});

await run.check("pending transaction cap blocks unbounded dataset cloning", async () => {
  for (const row of db.prepare("SELECT tx_id FROM business_staging_transaction WHERE account_id='A_1' AND status='pending'").all()) {
    await call("transaction/abort", { method: "POST", body: { tx_id: row.tx_id } });
  }
  const accepted = [];
  for (let index = 1; index <= 4; index += 1) {
    const txId = `transaction_cap_test_00${index}`;
    const operation = { entity: "Expense", operation: "upsert", record_key: typedRecordKey(1700 + index), property_key: typedRecordKey(7), row: { id: 1700 + index, property_id: 7, amount: 17 + index } };
    const response = await call("transaction/start", { method: "POST", body: { tx_id: txId, request_hash: await hash(canonicalJson([operation])), expected_chunks: 1, operation_count: 1 } });
    if (index <= 3) {
      assertEqual(response.status, 201);
      accepted.push(txId);
    } else {
      assertEqual(response.status, 409, "fourth pending transaction must fail closed");
      assertEqual((await response.json()).error, "pending transaction limit reached");
    }
  }
  assertEqual(Number(db.prepare("SELECT COUNT(*) AS n FROM business_staging_transaction WHERE account_id='A_1' AND status='pending'").get().n), 3);
  for (const txId of accepted) assertEqual((await call("transaction/abort", { method: "POST", body: { tx_id: txId } })).status, 200);
});

await run.check("atomic transaction rollback restores exact pre-image rows via inverse journal", async () => {
  const txId = "transaction_rollback_test_0017";
  const activeGen = db.prepare("SELECT active_generation_id FROM business_dataset_pointer WHERE account_id='A_1'").get().active_generation_id;
  const originalExpense1 = db.prepare("SELECT row_json, row_hash FROM business_record WHERE account_id='A_1' AND generation_id=? AND entity_name='Expense' AND record_key=?").get(activeGen, typedRecordKey(1));
  const operations = [
    {
      entity: "Expense",
      operation: "upsert",
      record_key: typedRecordKey(1),
      property_key: typedRecordKey(7),
      base_row_hash: originalExpense1.row_hash,
      row: { id: 1, property_id: 7, expense_name: "Modified Expense", amount: 99.99 },
    },
    {
      entity: "Expense",
      operation: "upsert",
      record_key: typedRecordKey(2001),
      property_key: typedRecordKey(7),
      row: { id: 2001, property_id: 7, expense_name: "Created Expense", amount: 55.55 },
    },
  ];
  const chunkHash = await transactionChunkHash(operations);
  const requestHash = await hash(canonicalJson(operations));
  const started = await call("transaction/start", { method: "POST", body: { tx_id: txId, request_hash: requestHash, expected_chunks: 1, operation_count: 2 } });
  assertEqual(started.status, 201);
  const chunk = await call("transaction/chunk", { method: "POST", body: { tx_id: txId, chunk_index: 0, chunk_hash: chunkHash, operations } });
  assertEqual(chunk.status, 200);
  const committed = await call("transaction/commit", { method: "POST", body: { tx_id: txId } });
  assertEqual(committed.status, 200);

  // Verify journal was populated
  const journalEntries = db.prepare("SELECT entity_name, record_key, operation FROM business_rollback_journal WHERE account_id='A_1' AND transaction_id=? ORDER BY record_key").all(txId);
  assertEqual(journalEntries.length, 2);
  assertEqual(journalEntries[0].operation, "update");
  assertEqual(journalEntries[1].operation, "create");

  // Verify live state has committed changes
  const modified = db.prepare("SELECT row_json FROM business_record WHERE account_id='A_1' AND generation_id=? AND entity_name='Expense' AND record_key=?").get(activeGen, typedRecordKey(1));
  assertEqual(JSON.parse(modified.row_json).amount, 99.99);
  const created = db.prepare("SELECT row_json FROM business_record WHERE account_id='A_1' AND generation_id=? AND entity_name='Expense' AND record_key=?").get(activeGen, typedRecordKey(2001));
  assertEqual(JSON.parse(created.row_json).amount, 55.55);

  // Execute rollback
  const rollback = await call("transaction/rollback", { method: "POST", body: { tx_id: txId } });
  assertEqual(rollback.status, 200, `rollback status: ${await rollback.clone().text()}`);
  const rollbackBody = await rollback.json();
  assertEqual(rollbackBody.status, "rolled_back");
  assertEqual(rollbackBody.reverted_operations, 2);

  // Verify exact pre-image restoration
  const reverted = db.prepare("SELECT row_json, row_hash FROM business_record WHERE account_id='A_1' AND generation_id=? AND entity_name='Expense' AND record_key=?").get(activeGen, typedRecordKey(1));
  assertEqual(reverted.row_hash, originalExpense1.row_hash);
  assertEqual(JSON.parse(reverted.row_json).amount, JSON.parse(originalExpense1.row_json).amount);
  const deleted = db.prepare("SELECT COUNT(*) AS n FROM business_record WHERE account_id='A_1' AND generation_id=? AND entity_name='Expense' AND record_key=?").get(activeGen, typedRecordKey(2001));
  assertEqual(deleted.n, 0);

  // Verify rollback replay is idempotent
  const replay = await call("transaction/rollback", { method: "POST", body: { tx_id: txId } });
  assertEqual(replay.status, 200, `replay: ${await replay.clone().text()}`);
  assertEqual((await replay.json()).replayed, true);
});

await run.check("transaction rollback aborts with 409 ROLLBACK_CONFLICT when a record was edited by a subsequent transaction", async () => {
  const txA = "tx_conflict_a_0018";
  const txB = "tx_conflict_b_0018";
  const activeGen = db.prepare("SELECT active_generation_id FROM business_dataset_pointer WHERE account_id='A_1'").get().active_generation_id;
  const current1 = db.prepare("SELECT row_hash FROM business_record WHERE account_id='A_1' AND generation_id=? AND entity_name='Expense' AND record_key=?").get(activeGen, typedRecordKey(1));

  // Tx A edits record 1
  const opA = [{ entity: "Expense", operation: "upsert", record_key: typedRecordKey(1), property_key: typedRecordKey(7), base_row_hash: current1.row_hash, row: { id: 1, property_id: 7, expense_name: "Tx A", amount: 111.11 } }];
  await call("transaction/start", { method: "POST", body: { tx_id: txA, request_hash: await hash(canonicalJson(opA)), expected_chunks: 1, operation_count: 1 } });
  const chunkA = await call("transaction/chunk", { method: "POST", body: { tx_id: txA, chunk_index: 0, chunk_hash: await transactionChunkHash(opA), operations: opA } });
  assertEqual(chunkA.status, 200, `chunkA: ${await chunkA.clone().text()}`);
  const commitA = await call("transaction/commit", { method: "POST", body: { tx_id: txA } });
  assertEqual(commitA.status, 200, `commitA: ${await commitA.clone().text()}`);

  const hashAfterA = db.prepare("SELECT row_hash FROM business_record WHERE account_id='A_1' AND generation_id=? AND entity_name='Expense' AND record_key=?").get(activeGen, typedRecordKey(1)).row_hash;

  // Tx B edits record 1 subsequently
  const opB = [{ entity: "Expense", operation: "upsert", record_key: typedRecordKey(1), property_key: typedRecordKey(7), base_row_hash: hashAfterA, row: { id: 1, property_id: 7, expense_name: "Tx B", amount: 222.22 } }];
  await call("transaction/start", { method: "POST", body: { tx_id: txB, request_hash: await hash(canonicalJson(opB)), expected_chunks: 1, operation_count: 1 } });
  await call("transaction/chunk", { method: "POST", body: { tx_id: txB, chunk_index: 0, chunk_hash: await transactionChunkHash(opB), operations: opB } });
  const commitB = await call("transaction/commit", { method: "POST", body: { tx_id: txB } });
  assertEqual(commitB.status, 200, `commitB: ${await commitB.clone().text()}`);

  // Attempt to roll back Tx A (must conflict because Tx B modified it)
  const rbA = await call("transaction/rollback", { method: "POST", body: { tx_id: txA } });
  assertEqual(rbA.status, 409);
  const rbABody = await rbA.json();
  assertEqual(rbABody.code, "ROLLBACK_CONFLICT");

  // Verify live data was untouched (remains Tx B value)
  const liveAfterConflict = db.prepare("SELECT row_json FROM business_record WHERE account_id='A_1' AND generation_id=? AND entity_name='Expense' AND record_key=?").get(activeGen, typedRecordKey(1));
  assertEqual(JSON.parse(liveAfterConflict.row_json).amount, 222.22);
  assertEqual(db.prepare("SELECT status FROM business_staging_transaction WHERE account_id='A_1' AND tx_id=?").get(txA).status, "committed");
});

await run.check("migration rollback fails with 409 MIGRATION_ROLLBACK_BLOCKED when post_migration_mutated is 1", async () => {
  const variant = await buildVariantPayload();
  variant.chunks[0][0].row.name = "Mutated Migration Roster";
  variant.chunks[0][0].row_hash = await hash(canonicalJson(variant.chunks[0][0].row));
  variant.descriptors[0].hash = await hash(canonicalJson(variant.chunks[0]));
  variant.manifest.chunks = variant.descriptors;
  variant.manifest_hash = await hash(canonicalJson(variant.manifest));
  const started = await start(variant);
  for (let index = 0; index < variant.chunks.length; index += 1) await upload(started.generation_id, variant, index);
  const activated = await call("migration/activate", { method: "POST", body: { generation_id: started.generation_id } });
  assertEqual(activated.status, 200);

  // Perform a business transaction on the newly activated generation
  const txId = "tx_post_mig_0019";
  const op = [{ entity: "Expense", operation: "upsert", record_key: typedRecordKey(3001), property_key: typedRecordKey(7), row: { id: 3001, property_id: 7, amount: 30.01 } }];
  await call("transaction/start", { method: "POST", body: { tx_id: txId, request_hash: await hash(canonicalJson(op)), expected_chunks: 1, operation_count: 1 } });
  await call("transaction/chunk", { method: "POST", body: { tx_id: txId, chunk_index: 0, chunk_hash: await transactionChunkHash(op), operations: op } });
  assertEqual((await call("transaction/commit", { method: "POST", body: { tx_id: txId } })).status, 200);

  // Verify post_migration_mutated is set
  const dataset = db.prepare("SELECT post_migration_mutated, previous_generation_id FROM business_dataset WHERE account_id='A_1' AND generation_id=?").get(started.generation_id);
  assertEqual(dataset.post_migration_mutated, 1);
  assert(!!dataset.previous_generation_id, "must have previous generation");

  // Attempt migration rollback (must be blocked by barrier)
  const rollback = await call("migration/rollback", { method: "POST", body: { generation_id: started.generation_id } });
  assertEqual(rollback.status, 409);
  const rollbackBody = await rollback.json();
  assertEqual(rollbackBody.code, "MIGRATION_ROLLBACK_BLOCKED");

  // Verify active generation remained started.generation_id
  const pointer = db.prepare("SELECT active_generation_id FROM business_dataset_pointer WHERE account_id='A_1'").get().active_generation_id;
  assertEqual(pointer, started.generation_id);
});

run.done();
if (process.exitCode) process.exit(1);
console.log("PASSED: staged cross-browser business sync is idempotent, scoped, resumable, and feed-backed.");
