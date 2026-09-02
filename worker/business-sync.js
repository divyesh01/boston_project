import { assertPropertyInScope, ScopeError } from "./scope.js";
import { queryAll, queryFirst } from "./db.js";

const MAX_CHUNK_ROWS = 40;
const MAX_PAGE_ROWS = 500;
const MAX_DATASET_ROWS = 250_000;

export const BUSINESS_ENTITIES = Object.freeze([
  "Property", "OccupancyDay", "SourceDay", "GrossRevenueDay", "PaymentDay",
  "ClerkShiftRecord", "UploadedReport", "Expense", "PayrollRun", "Staff",
  "HotelMetric", "TransactionLine", "AnomalyAlert", "Room", "RoomStay",
  "HousekeepingTask", "WeatherSnapshot", "Review", "AdjustmentRefund",
  "DailyFinancialAggregate", "ScanResult", "TimecardPunch", "Reservation",
  "RoomType", "ChannelMap",
]);
const ENTITY_SET = new Set(BUSINESS_ENTITIES);

class SyncRequestError extends Error {
  constructor(message, status = 400, details = {}) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const responseError = (error, status, details = {}) =>
  Response.json({ error, ...details }, { status });

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function assertLosslessJson(value, path = "row") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new SyncRequestError(`${path} contains a non-lossless number`, 422);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertLosslessJson(item, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) assertLosslessJson(item, `${path}.${key}`);
    return;
  }
  throw new SyncRequestError(`${path} is not lossless JSON`, 422);
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(typeof value === "string" ? value : canonicalJson(value));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (part) => part.toString(16).padStart(2, "0")).join("");
}

export function typedRecordKey(value) {
  if (typeof value === "number" && Number.isSafeInteger(value)) return `n:${value}`;
  if (typeof value === "string") return `s:${value.length}:${value}`;
  throw new SyncRequestError("record id must be a safe integer or string", 422);
}

async function readBody(request) {
  try { return await request.json(); }
  catch { throw new SyncRequestError("invalid JSON body"); }
}

function requireMigrationRole(scope) {
  const role = String(scope.user.role || "").toLowerCase();
  if (!scope.all || !["owner", "admin"].includes(role)) {
    throw new SyncRequestError("only an all-property owner or admin can migrate business data", 403);
  }
}

function requireMutationRole(scope) {
  const role = String(scope.user.role || "").toLowerCase();
  if (["owner", "admin"].includes(role)) return;
  let permissions = {};
  try { permissions = typeof scope.user.permissions === "string" ? JSON.parse(scope.user.permissions) : (scope.user.permissions || {}); }
  catch { permissions = {}; }
  if (!["gm", "manager"].includes(role) || !(
    permissions.import_reports === true || permissions.manual_entry === true || permissions.manage_operations === true
  )) throw new SyncRequestError("forbidden", 403);
}

async function scopeFingerprint(scope) {
  return sha256(canonicalJson(scope.all ? ["*"] : [...scope.propertyIds].map(String).sort()));
}

function parseManifest(row) {
  try { return JSON.parse(String(row.manifest_json)); }
  catch { throw new SyncRequestError("stored migration manifest is invalid", 500); }
}

async function loadDataset(env, scope, generationId) {
  const row = await queryFirst(
    env,
    "SELECT * FROM business_dataset WHERE account_id=? AND generation_id=?",
    [scope.accountId, generationId],
  );
  if (!row) throw new SyncRequestError("migration generation not found", 404);
  return row;
}

async function startMigration(request, env, scope) {
  requireMigrationRole(scope);
  const body = await readBody(request);
  const manifest = body.manifest;
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new SyncRequestError("manifest is required");
  }
  const chunks = Array.isArray(manifest.chunks) ? manifest.chunks : [];
  const counts = manifest.counts && typeof manifest.counts === "object" ? manifest.counts : {};
  if (chunks.length === 0 || chunks.length > 10_000) throw new SyncRequestError("manifest chunks are invalid", 422);
  const expectedRecords = Object.entries(counts).reduce((sum, [entity, count]) => {
    if (!ENTITY_SET.has(entity) || !Number.isSafeInteger(count) || count < 0) {
      throw new SyncRequestError(`invalid manifest count for ${entity}`, 422);
    }
    return sum + count;
  }, 0);
  if (expectedRecords <= 0 || expectedRecords > MAX_DATASET_ROWS) {
    throw new SyncRequestError("manifest record total is invalid", 422);
  }
  const manifestJson = canonicalJson(manifest);
  const manifestHash = await sha256(manifestJson);
  if (body.manifest_hash !== manifestHash) throw new SyncRequestError("manifest hash mismatch", 422);
  const existing = await queryFirst(
    env,
    "SELECT generation_id,status FROM business_dataset WHERE account_id=? AND manifest_hash=?",
    [scope.accountId, manifestHash],
  );
  if (existing) return Response.json({ generation_id: existing.generation_id, status: existing.status, resumed: true });

  const generationId = crypto.randomUUID();
  const now = new Date().toISOString();
  const pointer = await queryFirst(env, "SELECT active_generation_id FROM business_dataset_pointer WHERE account_id=?", [scope.accountId]);
  await env.DB.prepare(
    "INSERT INTO business_dataset (account_id,generation_id,status,schema_version,manifest_hash,manifest_json,expected_chunks,expected_records,previous_generation_id,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
  ).bind(
    scope.accountId, generationId, "staging", Number(manifest.schema_version) || 1,
    manifestHash, manifestJson, chunks.length, expectedRecords,
    pointer?.active_generation_id || null, String(scope.user.id), now,
  ).run();
  return Response.json({ generation_id: generationId, status: "staging", resumed: false }, { status: 201 });
}

async function uploadChunk(request, env, scope) {
  requireMigrationRole(scope);
  const body = await readBody(request);
  const generationId = String(body.generation_id || "");
  const chunkIndex = Number(body.chunk_index);
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0) throw new SyncRequestError("chunk_index is invalid", 422);
  if (rows.length === 0 || rows.length > MAX_CHUNK_ROWS) throw new SyncRequestError(`rows must contain 1-${MAX_CHUNK_ROWS} records`, 422);
  const dataset = await loadDataset(env, scope, generationId);
  if (dataset.status !== "staging") throw new SyncRequestError("migration is not accepting chunks", 409);
  const manifest = parseManifest(dataset);
  const expected = (manifest.chunks || []).find((chunk) => Number(chunk.index) === chunkIndex);
  if (!expected) throw new SyncRequestError("chunk is not declared by the manifest", 422);

  const normalized = [];
  for (const item of rows) {
    if (!item || !ENTITY_SET.has(item.entity)) throw new SyncRequestError("chunk contains an unknown entity", 422);
    if (!item.row || typeof item.row !== "object" || Array.isArray(item.row)) throw new SyncRequestError("chunk row is invalid", 422);
    assertLosslessJson(item.row);
    if ("account_id" in item.row || "server_property_id" in item.row) throw new SyncRequestError("server scope fields are not accepted", 403);
    const recordKey = typedRecordKey(item.row.id);
    if (item.record_key !== recordKey) throw new SyncRequestError("typed record key mismatch", 422);
    const propertyKey = item.entity === "Property" ? recordKey : typedRecordKey(item.row.property_id);
    if (item.property_key !== propertyKey) throw new SyncRequestError("typed property key mismatch", 422);
    const rowJson = canonicalJson(item.row);
    const rowHash = await sha256(rowJson);
    if (item.row_hash !== rowHash) throw new SyncRequestError("row hash mismatch", 422);
    normalized.push({ entity: item.entity, recordKey, propertyKey, rowJson, rowHash });
  }
  const chunkHash = await sha256(canonicalJson(normalized.map((row) => ({
    entity: row.entity, record_key: row.recordKey, property_key: row.propertyKey,
    row_hash: row.rowHash, row: JSON.parse(row.rowJson),
  }))));
  if (body.chunk_hash !== chunkHash || expected.hash !== chunkHash || Number(expected.count) !== rows.length) {
    throw new SyncRequestError("chunk checksum or count mismatch", 422);
  }
  const replay = await queryFirst(
    env,
    "SELECT chunk_hash,record_count FROM business_migration_chunk WHERE account_id=? AND generation_id=? AND chunk_index=?",
    [scope.accountId, generationId, chunkIndex],
  );
  if (replay) {
    if (replay.chunk_hash !== chunkHash || Number(replay.record_count) !== rows.length) {
      throw new SyncRequestError("chunk index was already used by different content", 409);
    }
    return Response.json({ accepted: rows.length, replayed: true });
  }
  const now = new Date().toISOString();
  const statements = normalized.map((row) => env.DB.prepare(
    "INSERT INTO business_record (account_id,generation_id,entity_name,record_key,property_key,row_json,row_hash,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(account_id,generation_id,entity_name,record_key) DO UPDATE SET property_key=excluded.property_key,row_json=excluded.row_json,row_hash=excluded.row_hash,updated_at=excluded.updated_at",
  ).bind(scope.accountId, generationId, row.entity, row.recordKey, row.propertyKey, row.rowJson, row.rowHash, now));
  statements.push(env.DB.prepare(
    "INSERT INTO business_migration_chunk (account_id,generation_id,chunk_index,chunk_hash,record_count,received_at) VALUES (?,?,?,?,?,?)",
  ).bind(scope.accountId, generationId, chunkIndex, chunkHash, rows.length, now));
  await env.DB.batch(statements);
  return Response.json({ accepted: rows.length, replayed: false });
}

async function deterministicPropertyId(accountId, code) {
  return `prop_${(await sha256(canonicalJson([accountId, code]))).slice(0, 32)}`;
}

async function activateMigration(request, env, scope) {
  requireMigrationRole(scope);
  const body = await readBody(request);
  const generationId = String(body.generation_id || "");
  const dataset = await loadDataset(env, scope, generationId);
  if (dataset.status === "active") return Response.json({ generation_id: generationId, status: "active", replayed: true });
  if (dataset.status !== "staging") throw new SyncRequestError("migration cannot be activated", 409);
  const manifest = parseManifest(dataset);
  const received = await queryAll(env, "SELECT chunk_index,chunk_hash,record_count FROM business_migration_chunk WHERE account_id=? AND generation_id=? ORDER BY chunk_index", [scope.accountId, generationId]);
  if (received.length !== Number(dataset.expected_chunks)) throw new SyncRequestError("migration is incomplete", 409, { received_chunks: received.length, expected_chunks: Number(dataset.expected_chunks) });
  for (const expected of manifest.chunks || []) {
    const actual = received.find((row) => Number(row.chunk_index) === Number(expected.index));
    if (!actual || actual.chunk_hash !== expected.hash || Number(actual.record_count) !== Number(expected.count)) {
      throw new SyncRequestError("stored chunk manifest does not reconcile", 409);
    }
  }
  const total = await queryFirst(env, "SELECT COUNT(*) AS total FROM business_record WHERE account_id=? AND generation_id=?", [scope.accountId, generationId]);
  if (Number(total?.total || 0) !== Number(dataset.expected_records)) throw new SyncRequestError("stored record count does not reconcile", 409);
  const grouped = await queryAll(env, "SELECT entity_name,COUNT(*) AS count FROM business_record WHERE account_id=? AND generation_id=? GROUP BY entity_name", [scope.accountId, generationId]);
  const actualCounts = Object.fromEntries(grouped.map((row) => [row.entity_name, Number(row.count)]));
  for (const entity of BUSINESS_ENTITIES) {
    if (Number(actualCounts[entity] || 0) !== Number(manifest.counts?.[entity] || 0)) {
      throw new SyncRequestError(`record count does not reconcile for ${entity}`, 409);
    }
  }

  const propertyRows = await queryAll(env, "SELECT record_key,row_json FROM business_record WHERE account_id=? AND generation_id=? AND entity_name='Property' ORDER BY record_key", [scope.accountId, generationId]);
  if (propertyRows.length === 0) throw new SyncRequestError("dataset contains no property roster", 422);
  const existingProperties = await queryAll(env, "SELECT id,code FROM property WHERE account_id=?", [scope.accountId]);
  const existingByCode = new Map(existingProperties.map((row) => [String(row.code || "").toLowerCase(), row]));
  const mappings = new Map();
  const codes = new Set();
  for (const item of propertyRows) {
    const row = JSON.parse(String(item.row_json));
    const code = String(row.code || "").trim();
    const name = String(row.name || "").trim();
    if (!code || !name) throw new SyncRequestError("every property requires code and name", 422);
    if (codes.has(code.toLowerCase())) throw new SyncRequestError(`duplicate property code in migration: ${code}`, 409);
    codes.add(code.toLowerCase());
    const existing = existingByCode.get(code.toLowerCase());
    mappings.set(item.record_key, { serverId: existing?.id || await deterministicPropertyId(scope.accountId, code), code, row, exists: !!existing });
  }
  const referenced = await queryAll(env, "SELECT DISTINCT property_key FROM business_record WHERE account_id=? AND generation_id=?", [scope.accountId, generationId]);
  for (const item of referenced) {
    if (!mappings.has(item.property_key)) throw new SyncRequestError(`orphaned property reference: ${item.property_key}`, 422);
  }

  const now = new Date().toISOString();
  const statements = [];
  for (const [propertyKey, mapping] of mappings) {
    const row = mapping.row;
    statements.push(env.DB.prepare(
      "INSERT INTO property (id,account_id,code,name,rooms,address,city,state,phone,active,created_date) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(account_id,code) DO UPDATE SET name=excluded.name,rooms=excluded.rooms,address=excluded.address,city=excluded.city,state=excluded.state,phone=excluded.phone,active=excluded.active,created_date=excluded.created_date",
    ).bind(mapping.serverId, scope.accountId, mapping.code, String(row.name), row.rooms ?? null, row.address ?? null, row.city ?? null, row.state ?? null, row.phone ?? null, row.active === false ? 0 : 1, row.created_date ?? null));
    statements.push(env.DB.prepare(
      "INSERT INTO business_property_map (account_id,generation_id,property_key,server_property_id,property_code) VALUES (?,?,?,?,?)",
    ).bind(scope.accountId, generationId, propertyKey, mapping.serverId, mapping.code));
    statements.push(env.DB.prepare(
      "UPDATE business_record SET server_property_id=? WHERE account_id=? AND generation_id=? AND property_key=?",
    ).bind(mapping.serverId, scope.accountId, generationId, propertyKey));
  }
  if (dataset.previous_generation_id) {
    statements.push(env.DB.prepare("UPDATE business_dataset SET status='retired' WHERE account_id=? AND generation_id=? AND status='active'").bind(scope.accountId, dataset.previous_generation_id));
  }
  statements.push(env.DB.prepare("UPDATE business_dataset SET status='active',activated_at=? WHERE account_id=? AND generation_id=? AND status='staging'").bind(now, scope.accountId, generationId));
  statements.push(env.DB.prepare(
    "INSERT INTO business_dataset_pointer (account_id,active_generation_id,updated_at) VALUES (?,?,?) ON CONFLICT(account_id) DO UPDATE SET active_generation_id=excluded.active_generation_id,updated_at=excluded.updated_at",
  ).bind(scope.accountId, generationId, now));
  statements.push(env.DB.prepare("INSERT INTO business_sync_state (account_id,revision) VALUES (?,0) ON CONFLICT(account_id) DO NOTHING").bind(scope.accountId));
  await env.DB.batch(statements);
  return Response.json({ generation_id: generationId, status: "active", replayed: false, properties: mappings.size });
}

async function rollbackMigration(request, env, scope) {
  requireMigrationRole(scope);
  const body = await readBody(request);
  const generationId = String(body.generation_id || "");
  const dataset = await loadDataset(env, scope, generationId);
  if (dataset.status === "staging") {
    await env.DB.prepare("DELETE FROM business_dataset WHERE account_id=? AND generation_id=?").bind(scope.accountId, generationId).run();
    return Response.json({ generation_id: generationId, status: "aborted", active_dataset_changed: false });
  }
  if (dataset.status === "active" && dataset.previous_generation_id) {
    const previous = await loadDataset(env, scope, String(dataset.previous_generation_id));
    if (!['retired', 'active'].includes(String(previous.status))) throw new SyncRequestError("previous generation is not rollback-eligible", 409);
    const now = new Date().toISOString();
    // The account-level `property` roster is shared with authorization scope.
    // Flipping only the dataset pointer would leave names/room counts/active
    // flags from the replacement generation visible after rollback. Restore the
    // prior generation's exact roster fields in the SAME D1 batch as the pointer
    // swap. Properties introduced only by the replacement are deactivated, not
    // deleted: deletion would cascade user_property_access and destroy grants.
    const previousProperties = await queryAll(env,
      "SELECT bpm.server_property_id,br.row_json FROM business_property_map bpm JOIN business_record br ON br.account_id=bpm.account_id AND br.generation_id=bpm.generation_id AND br.entity_name='Property' AND br.record_key=bpm.property_key WHERE bpm.account_id=? AND bpm.generation_id=?",
      [scope.accountId, previous.generation_id],
    );
    const currentMappings = await queryAll(env,
      "SELECT server_property_id FROM business_property_map WHERE account_id=? AND generation_id=?",
      [scope.accountId, generationId],
    );
    const previousIds = new Set(previousProperties.map((item) => String(item.server_property_id)));
    const rosterStatements = [];
    for (const item of previousProperties) {
      const row = JSON.parse(String(item.row_json));
      const code = String(row.code || "").trim();
      const name = String(row.name || "").trim();
      if (!code || !name) throw new SyncRequestError("previous property roster is invalid", 409);
      rosterStatements.push(env.DB.prepare(
        "INSERT INTO property (id,account_id,code,name,rooms,address,city,state,phone,active,created_date) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET code=excluded.code,name=excluded.name,rooms=excluded.rooms,address=excluded.address,city=excluded.city,state=excluded.state,phone=excluded.phone,active=excluded.active,created_date=excluded.created_date WHERE account_id=excluded.account_id",
      ).bind(String(item.server_property_id), scope.accountId, code, name, row.rooms ?? null, row.address ?? null, row.city ?? null, row.state ?? null, row.phone ?? null, row.active === false ? 0 : 1, row.created_date ?? null));
    }
    const introducedIds = [...new Set(currentMappings.map((item) => String(item.server_property_id)))].filter((id) => !previousIds.has(id));
    for (const id of introducedIds) {
      rosterStatements.push(env.DB.prepare("UPDATE property SET active=0 WHERE account_id=? AND id=?").bind(scope.accountId, id));
    }
    await env.DB.batch([
      ...rosterStatements,
      env.DB.prepare("UPDATE business_dataset SET status='rolled_back' WHERE account_id=? AND generation_id=? AND status='active'").bind(scope.accountId, generationId),
      env.DB.prepare("UPDATE business_dataset SET status='active' WHERE account_id=? AND generation_id=?").bind(scope.accountId, previous.generation_id),
      env.DB.prepare("UPDATE business_dataset_pointer SET active_generation_id=?,updated_at=? WHERE account_id=? AND active_generation_id=?").bind(previous.generation_id, now, scope.accountId, generationId),
      env.DB.prepare("INSERT INTO business_sync_state (account_id,revision) VALUES (?,1) ON CONFLICT(account_id) DO UPDATE SET revision=revision+1").bind(scope.accountId),
    ]);
    return Response.json({ generation_id: generationId, status: "rolled_back", active_dataset_changed: true, active_generation_id: previous.generation_id, restored_properties: previousProperties.length, deactivated_properties: introducedIds.length });
  }
  throw new SyncRequestError("migration cannot be rolled back", 409);
}

async function migrationStatus(url, env, scope) {
  const generationId = String(url.searchParams.get("generation_id") || "");
  const dataset = await loadDataset(env, scope, generationId);
  const chunks = await queryFirst(env, "SELECT COUNT(*) AS count,COALESCE(SUM(record_count),0) AS records FROM business_migration_chunk WHERE account_id=? AND generation_id=?", [scope.accountId, generationId]);
  const records = await queryFirst(env, "SELECT COUNT(*) AS count FROM business_record WHERE account_id=? AND generation_id=?", [scope.accountId, generationId]);
  return Response.json({ generation_id: generationId, status: dataset.status, expected_chunks: Number(dataset.expected_chunks), received_chunks: Number(chunks?.count || 0), expected_records: Number(dataset.expected_records), received_records: Number(records?.count || 0) });
}

function scopedRecordClause(scope) {
  if (scope.all) return { sql: "1=1", params: [] };
  if (scope.propertyIds.length === 0) return { sql: "1=0", params: [] };
  return { sql: `server_property_id IN (${scope.propertyIds.map(() => "?").join(",")})`, params: scope.propertyIds };
}

async function snapshot(url, env, scope) {
  const entity = String(url.searchParams.get("entity") || "");
  if (!ENTITY_SET.has(entity)) throw new SyncRequestError("unknown entity", 404);
  const cursor = String(url.searchParams.get("cursor") || "");
  const limit = Math.max(1, Math.min(MAX_PAGE_ROWS, Number(url.searchParams.get("limit")) || 200));
  const pointer = await queryFirst(env, "SELECT active_generation_id FROM business_dataset_pointer WHERE account_id=?", [scope.accountId]);
  if (!pointer) throw new SyncRequestError("no active business dataset", 404, { code: "no_active_dataset" });
  const revision = await queryFirst(env, "SELECT revision FROM business_sync_state WHERE account_id=?", [scope.accountId]);
  const currentRevision = Number(revision?.revision || 0);
  const requestedRevision = url.searchParams.get("snapshot_revision");
  const snapshotRevision = requestedRevision == null ? currentRevision : Number(requestedRevision);
  if (!Number.isSafeInteger(snapshotRevision) || snapshotRevision < 0 || snapshotRevision > currentRevision) {
    throw new SyncRequestError("snapshot_revision is invalid", 422);
  }
  const scoped = scopedRecordClause(scope);
  const rows = await queryAll(
    env,
    `SELECT record_key,row_json,row_hash FROM business_record WHERE account_id=? AND generation_id=? AND entity_name=? AND record_key>? AND ${scoped.sql} ORDER BY record_key LIMIT ?`,
    [scope.accountId, pointer.active_generation_id, entity, cursor, ...scoped.params, limit + 1],
  );
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return Response.json({ generation_id: pointer.active_generation_id, snapshot_revision: snapshotRevision, scope_fingerprint: await scopeFingerprint(scope), entity, items: page.map((row) => ({ record_key: row.record_key, row_hash: row.row_hash, row: JSON.parse(String(row.row_json)) })), has_more: hasMore, next_cursor: page.at(-1)?.record_key || null });
}

async function feed(url, env, scope) {
  const since = Math.max(0, Number(url.searchParams.get("since")) || 0);
  const limit = Math.max(1, Math.min(MAX_PAGE_ROWS, Number(url.searchParams.get("limit")) || 200));
  const scoped = scopedRecordClause(scope);
  const rows = await queryAll(env, `SELECT seq,generation_id,entity_name,record_key,operation,row_json,row_hash FROM business_change WHERE account_id=? AND seq>? AND ${scoped.sql} ORDER BY seq LIMIT ?`, [scope.accountId, since, ...scoped.params, limit]);
  const current = await queryFirst(env, "SELECT revision FROM business_sync_state WHERE account_id=?", [scope.accountId]);
  const pointer = await queryFirst(env, "SELECT active_generation_id FROM business_dataset_pointer WHERE account_id=?", [scope.accountId]);
  const destructive = await queryFirst(env, "SELECT seq FROM business_change WHERE account_id=? AND seq>? AND operation='property_delete' ORDER BY seq LIMIT 1", [scope.accountId, since]);
  return Response.json({
    items: rows.map((row) => ({ ...row, row: row.row_json ? JSON.parse(String(row.row_json)) : null, row_json: undefined })),
    active_generation_id: pointer?.active_generation_id || null,
    scope_fingerprint: await scopeFingerprint(scope),
    rebuild_required: !!destructive,
    current_revision: Number(current?.revision || 0),
    next_revision: rows.length ? Number(rows.at(-1).seq) : since,
    has_more: rows.length === limit,
  });
}

function absentGuard(env, scope, generationId, entity, recordKey, mutationId, requestHash, now) {
  return env.DB.prepare(
    "INSERT INTO business_mutation_guard (account_id,mutation_id,request_hash,ok,created_at) SELECT ?,?,?,CASE WHEN NOT EXISTS (SELECT 1 FROM business_record WHERE account_id=? AND generation_id=? AND entity_name=? AND record_key=?) THEN 1 ELSE 0 END,?",
  ).bind(scope.accountId, mutationId, requestHash, scope.accountId, generationId, entity, recordKey, now);
}

function presentGuard(env, scope, generationId, entity, recordKey, rowHash, serverPropertyId, mutationId, requestHash, now) {
  return env.DB.prepare(
    "INSERT INTO business_mutation_guard (account_id,mutation_id,request_hash,ok,created_at) SELECT ?,?,?,CASE WHEN EXISTS (SELECT 1 FROM business_record WHERE account_id=? AND generation_id=? AND entity_name=? AND record_key=? AND row_hash=? AND (? IS NULL OR server_property_id=?)) THEN 1 ELSE 0 END,?",
  ).bind(scope.accountId, mutationId, requestHash, scope.accountId, generationId, entity, recordKey, rowHash, serverPropertyId, serverPropertyId, now);
}

async function mutate(request, env, scope) {
  requireMutationRole(scope);
  const body = await readBody(request);
  const mutationId = String(body.mutation_id || "");
  const entity = String(body.entity || "");
  const operation = String(body.operation || "");
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(mutationId)) throw new SyncRequestError("mutation_id is invalid", 422);
  if (!ENTITY_SET.has(entity)) throw new SyncRequestError("unknown entity", 404);
  if (!['upsert', 'delete'].includes(operation)) throw new SyncRequestError("operation is invalid", 422);
  const requestHash = await sha256(canonicalJson({ entity, operation, record_key: body.record_key, property_key: body.property_key, row: body.row || null, base_row_hash: body.base_row_hash ?? null }));
  const replay = await queryFirst(env, "SELECT seq,request_hash,operation,row_json,row_hash FROM business_change WHERE account_id=? AND mutation_id=?", [scope.accountId, mutationId]);
  if (replay) {
    if (replay.request_hash !== requestHash) throw new SyncRequestError("mutation id was reused with different content", 409);
    return Response.json({ replayed: true, seq: Number(replay.seq), operation: replay.operation, row_hash: replay.row_hash, row: replay.row_json ? JSON.parse(String(replay.row_json)) : null });
  }
  const pointer = await queryFirst(env, "SELECT active_generation_id FROM business_dataset_pointer WHERE account_id=?", [scope.accountId]);
  if (!pointer) throw new SyncRequestError("no active business dataset", 409);
  const generationId = String(pointer.active_generation_id);
  const recordKey = String(body.record_key || "");
  const propertyKey = String(body.property_key || "");
  const current = await queryFirst(env, "SELECT row_hash,property_key,server_property_id,row_json FROM business_record WHERE account_id=? AND generation_id=? AND entity_name=? AND record_key=?", [scope.accountId, generationId, entity, recordKey]);
  const isCreate = operation === 'upsert' && body.base_row_hash == null;
  if (operation === 'delete' && body.base_row_hash == null) throw new SyncRequestError("delete requires base_row_hash", 422);
  if (isCreate && current) throw new SyncRequestError("record already exists", 409, { code: "sync_conflict" });
  if (!isCreate && (!current || body.base_row_hash !== current.row_hash)) throw new SyncRequestError("record changed on another device", 409, { code: "sync_conflict" });
  const now = new Date().toISOString();
  let serverPropertyId;
  let rowJson = null;
  let rowHash = null;
  let changeOperation = operation;
  const statements = [
    env.DB.prepare("INSERT INTO business_sync_state (account_id,revision) VALUES (?,0) ON CONFLICT(account_id) DO NOTHING").bind(scope.accountId),
    env.DB.prepare("UPDATE business_sync_state SET revision=revision+1 WHERE account_id=?").bind(scope.accountId),
  ];

  if (entity === "Property") {
    if (!scope.all) throw new SyncRequestError("only all-property accounts can change the roster", 403);
    if (operation === "delete") {
      const mapping = await queryFirst(env, "SELECT server_property_id FROM business_property_map WHERE account_id=? AND generation_id=? AND property_key=?", [scope.accountId, generationId, recordKey]);
      if (!mapping) throw new SyncRequestError("property not found", 404);
      serverPropertyId = String(mapping.server_property_id);
      changeOperation = "property_delete";
      statements.push(presentGuard(env, scope, generationId, entity, recordKey, String(body.base_row_hash), serverPropertyId, mutationId, requestHash, now));
      statements.push(env.DB.prepare("DELETE FROM business_record WHERE account_id=? AND generation_id=? AND server_property_id=?").bind(scope.accountId, generationId, serverPropertyId));
      statements.push(env.DB.prepare("DELETE FROM property WHERE account_id=? AND id=?").bind(scope.accountId, serverPropertyId));
    } else {
      const row = body.row;
      if (!row || typedRecordKey(row.id) !== recordKey) throw new SyncRequestError("record key mismatch", 422);
      assertLosslessJson(row);
      const code = String(row.code || "").trim();
      const name = String(row.name || "").trim();
      if (!code || !name) throw new SyncRequestError("property code and name are required", 422);
      const mapped = await queryFirst(env, "SELECT server_property_id FROM business_property_map WHERE account_id=? AND generation_id=? AND property_key=?", [scope.accountId, generationId, recordKey]);
      const byCode = await queryFirst(env, "SELECT id FROM property WHERE account_id=? AND lower(code)=lower(?)", [scope.accountId, code]);
      if (mapped?.server_property_id && byCode?.id && String(mapped.server_property_id) !== String(byCode.id)) {
        throw new SyncRequestError("property code belongs to another property", 409);
      }
      if (!mapped?.server_property_id && byCode?.id) {
        const claimed = await queryFirst(env, "SELECT property_key FROM business_property_map WHERE account_id=? AND generation_id=? AND server_property_id=?", [scope.accountId, generationId, byCode.id]);
        if (claimed && claimed.property_key !== recordKey) throw new SyncRequestError("property code is already mapped", 409);
      }
      serverPropertyId = String(mapped?.server_property_id || byCode?.id || await deterministicPropertyId(scope.accountId, code));
      rowJson = canonicalJson(row);
      rowHash = await sha256(rowJson);
      statements.push(isCreate
        ? absentGuard(env, scope, generationId, entity, recordKey, mutationId, requestHash, now)
        : presentGuard(env, scope, generationId, entity, recordKey, String(body.base_row_hash), serverPropertyId, mutationId, requestHash, now));
      statements.push(env.DB.prepare("INSERT INTO property (id,account_id,code,name,rooms,address,city,state,phone,active,created_date) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET code=excluded.code,name=excluded.name,rooms=excluded.rooms,address=excluded.address,city=excluded.city,state=excluded.state,phone=excluded.phone,active=excluded.active,created_date=excluded.created_date WHERE account_id=excluded.account_id").bind(serverPropertyId, scope.accountId, code, name, row.rooms ?? null, row.address ?? null, row.city ?? null, row.state ?? null, row.phone ?? null, row.active === false ? 0 : 1, row.created_date ?? null));
      statements.push(env.DB.prepare("INSERT INTO business_property_map (account_id,generation_id,property_key,server_property_id,property_code) VALUES (?,?,?,?,?) ON CONFLICT(account_id,generation_id,property_key) DO UPDATE SET server_property_id=excluded.server_property_id,property_code=excluded.property_code").bind(scope.accountId, generationId, recordKey, serverPropertyId, code));
      statements.push(env.DB.prepare("INSERT INTO business_record (account_id,generation_id,entity_name,record_key,property_key,server_property_id,row_json,row_hash,updated_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(account_id,generation_id,entity_name,record_key) DO UPDATE SET property_key=excluded.property_key,server_property_id=excluded.server_property_id,row_json=excluded.row_json,row_hash=excluded.row_hash,updated_at=excluded.updated_at").bind(scope.accountId, generationId, entity, recordKey, recordKey, serverPropertyId, rowJson, rowHash, now));
    }
  } else {
    const mapping = await queryFirst(env, "SELECT server_property_id FROM business_property_map WHERE account_id=? AND generation_id=? AND property_key=?", [scope.accountId, generationId, propertyKey]);
    if (!mapping) throw new SyncRequestError("property mapping not found", 422);
    serverPropertyId = String(mapping.server_property_id);
    assertPropertyInScope(scope, serverPropertyId);
    if (current) {
      assertPropertyInScope(scope, String(current.server_property_id));
      if (String(current.server_property_id) !== serverPropertyId || String(current.property_key) !== propertyKey) {
        throw new SyncRequestError("record belongs to another property", 403);
      }
    }
    if (operation === "delete") {
      if (!current) throw new SyncRequestError("record not found", 404);
      statements.push(presentGuard(env, scope, generationId, entity, recordKey, String(body.base_row_hash), serverPropertyId, mutationId, requestHash, now));
      statements.push(env.DB.prepare("DELETE FROM business_record WHERE account_id=? AND generation_id=? AND entity_name=? AND record_key=?").bind(scope.accountId, generationId, entity, recordKey));
    } else {
      const row = body.row;
      if (!row || typedRecordKey(row.id) !== recordKey || typedRecordKey(row.property_id) !== propertyKey) throw new SyncRequestError("record or property key mismatch", 422);
      assertLosslessJson(row);
      rowJson = canonicalJson(row);
      rowHash = await sha256(rowJson);
      statements.push(isCreate
        ? absentGuard(env, scope, generationId, entity, recordKey, mutationId, requestHash, now)
        : presentGuard(env, scope, generationId, entity, recordKey, String(body.base_row_hash), serverPropertyId, mutationId, requestHash, now));
      statements.push(env.DB.prepare("INSERT INTO business_record (account_id,generation_id,entity_name,record_key,property_key,server_property_id,row_json,row_hash,updated_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(account_id,generation_id,entity_name,record_key) DO UPDATE SET property_key=excluded.property_key,server_property_id=excluded.server_property_id,row_json=excluded.row_json,row_hash=excluded.row_hash,updated_at=excluded.updated_at").bind(scope.accountId, generationId, entity, recordKey, propertyKey, serverPropertyId, rowJson, rowHash, now));
    }
  }
  statements.push(env.DB.prepare("INSERT INTO business_change (account_id,seq,generation_id,entity_name,record_key,server_property_id,operation,row_json,row_hash,mutation_id,request_hash,created_at) SELECT ?,revision,?,?,?,?,?,?,?,?,?,? FROM business_sync_state WHERE account_id=?").bind(scope.accountId, generationId, entity, recordKey, serverPropertyId, changeOperation, rowJson, rowHash, mutationId, requestHash, now, scope.accountId));
  try {
    await env.DB.batch(statements);
  } catch (error) {
    const concurrentReplay = await queryFirst(env, "SELECT seq,request_hash,operation,row_json,row_hash FROM business_change WHERE account_id=? AND mutation_id=?", [scope.accountId, mutationId]);
    if (concurrentReplay && concurrentReplay.request_hash === requestHash) {
      return Response.json({ replayed: true, seq: Number(concurrentReplay.seq), operation: concurrentReplay.operation, row_hash: concurrentReplay.row_hash, row: concurrentReplay.row_json ? JSON.parse(String(concurrentReplay.row_json)) : null });
    }
    if (/business_mutation_guard|CHECK constraint/i.test(String(error?.message || error))) {
      throw new SyncRequestError("record changed on another device", 409, { code: "sync_conflict" });
    }
    throw error;
  }
  const applied = await queryFirst(env, "SELECT seq FROM business_change WHERE account_id=? AND mutation_id=?", [scope.accountId, mutationId]);
  return Response.json({ replayed: false, seq: Number(applied.seq), operation: changeOperation, row_hash: rowHash, row: rowJson ? JSON.parse(rowJson) : null });
}

async function reserveIdSequence(request, env, scope) {
  requireMutationRole(scope);
  const body = await readBody(request);
  const prefix = String(body.prefix || "").trim().toUpperCase();
  const floor = Number(body.floor || 0);
  if (!/^[A-Z]{3}$/.test(prefix) || !Number.isSafeInteger(floor) || floor < 0) {
    throw new SyncRequestError("id sequence request is invalid", 422);
  }
  const now = new Date().toISOString();
  const row = await env.DB.prepare(
    "INSERT INTO business_id_sequence (account_id,prefix,last_seq,updated_at) VALUES (?,?,?+1,?) ON CONFLICT(account_id,prefix) DO UPDATE SET last_seq=MAX(business_id_sequence.last_seq,?)+1,updated_at=excluded.updated_at RETURNING last_seq",
  ).bind(scope.accountId, prefix, floor, now, floor).first();
  return Response.json({ prefix, sequence: Number(row.last_seq) });
}

export async function handleBusinessSyncRequest(request, env, scope, url, parts) {
  try {
    const action = parts[2] || "";
    if (action === "migration" && parts[3] === "start" && request.method === "POST") return await startMigration(request, env, scope);
    if (action === "migration" && parts[3] === "chunk" && request.method === "POST") return await uploadChunk(request, env, scope);
    if (action === "migration" && parts[3] === "activate" && request.method === "POST") return await activateMigration(request, env, scope);
    if (action === "migration" && parts[3] === "rollback" && request.method === "POST") return await rollbackMigration(request, env, scope);
    if (action === "migration" && parts[3] === "status" && request.method === "GET") return await migrationStatus(url, env, scope);
    if (action === "snapshot" && request.method === "GET") return await snapshot(url, env, scope);
    if (action === "feed" && request.method === "GET") return await feed(url, env, scope);
    if (action === "mutate" && request.method === "POST") return await mutate(request, env, scope);
    if (action === "id-sequence" && parts[3] === "reserve" && request.method === "POST") return await reserveIdSequence(request, env, scope);
    return responseError("not found", 404);
  } catch (error) {
    if (error instanceof SyncRequestError) return responseError(error.message, error.status, error.details);
    if (error instanceof ScopeError) return responseError(error.message, 403);
    throw error;
  }
}
