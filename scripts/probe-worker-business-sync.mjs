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

const payload = await buildPayload();
let abortedGeneration;

await run.check("numeric 7 and string 7 have distinct typed identities", () => {
  assertEqual(typedRecordKey(7), "n:7");
  assertEqual(typedRecordKey("7"), "s:1:7");
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
  }
  const activate = await call("migration/activate", { method: "POST", body: { generation_id: generation } });
  const result = await activate.json();
  assertEqual(activate.status, 200);
  assertEqual(result.status, "active");
  assertEqual(result.properties, 2);
  assertEqual(db.prepare("SELECT active_generation_id FROM business_dataset_pointer WHERE account_id='A_1'").get().active_generation_id, generation);
  owner.propertyIds = db.prepare("SELECT id FROM property WHERE account_id='A_1' ORDER BY id").all().map((row) => row.id);
});

await run.check("replaying the migration and every chunk is idempotent", async () => {
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

run.done();
if (process.exitCode) process.exit(1);
console.log("PASSED: staged cross-browser business sync is idempotent, scoped, resumable, and feed-backed.");
