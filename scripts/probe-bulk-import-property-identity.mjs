// scripts/probe-bulk-import-property-identity.mjs
// Production incident regression: an authenticated OWNER selected property code
// RRI1416 and 10 queued files failed with "property 1 is outside caller scope"
// because bulk-import routes asserted the browser-supplied legacy alias ("1")
// directly against scope.propertyIds, which holds only canonical server ids.
//
// Verifies the central server-side property identity resolver that EVERY
// bulk-import route now routes caller-supplied property ids through BEFORE any
// scope assertion, D1 manifest operation, canonical object key, storage
// metadata, upload/activation, duplicate/pending check, or manifest filter:
//
//   * canonical id already in scope returns unchanged at ZERO extra D1 reads
//   * numeric 1 and string "1" resolve equivalently through n:1 or s:1:1
//   * malformed/noncanonical numerics ("01", "1.0", " 1") gain no loose aliases
//   * unknown, ambiguous, or out-of-scope identities fail closed — owners too
//   * resolution happens ONLY through the account's ACTIVE generation map
//   * no legacy alias is stored in or used for object keys or metadata
//   * the X-Requested-With mutation gate is unchanged
//
// Routes covered (caller-supplied property id source):
//   POST   check-duplicate (body.server_property_id)
//   POST   raw-check        (body.server_property_id)
//   PUT    raw-upload        (x-server-property-id header / query)
//   POST   raw-archive       (body.server_property_id)
//   GET    pending           (query server_property_id)
//   PUT    upload            (x-server-property-id header / query)
//   POST   activate          (body.server_property_id)
//   GET    manifest          (query server_property_id)

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
import worker from "../worker/index.js";
import { handleBulkImportRequest } from "../worker/bulk-import.js";
import { clearMockStore, getMockStore, testR2Binding } from "./_r2-testkit.mjs";
import {
  buildNormalizedBundle,
  compressPayloadGzip,
  sha256Hex,
} from "../src/lib/bulkImportPipeline.js";

const run = makeRunner("probe-bulk-import-property-identity");

// ---------------------------------------------------------------------------
// Fixture: the exact production shape. One account, canonical property with
// code RRI1416 (the UI selection), an active dataset generation whose
// business_property_map carries the legacy alias n:1 -> canonical id.
// ---------------------------------------------------------------------------

const CANON = "prop_canonical_rri1416";
const OTHER = "prop_other_canonical";
const RAW_ALIAS = "1"; // what the production browser sent

function seedGeneration(db, accountId, generationId, userId, { withPointer = true } = {}) {
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO business_dataset (account_id,generation_id,status,schema_version,manifest_hash,manifest_json,expected_chunks,expected_records,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
  ).run(accountId, generationId, "active", 1, `hash_${generationId}`, "{}", 1, 10, userId, now);
  if (withPointer) {
    db.prepare(
      "INSERT INTO business_dataset_pointer (account_id,active_generation_id,updated_at) VALUES (?,?,?)"
    ).run(accountId, generationId, now);
  }
}

function setup() {
  clearMockStore();
  const db = makeDb();
  db.prepare("INSERT INTO account (id,name,created_date) VALUES (?,?,?)").run("A_1", "Incident Account", "2026-01-01");
  seedUser(db, { id: "user_owner", email: "owner@incident.local", role: "owner", mode: "all", accountId: "A_1" });

  db.prepare("INSERT INTO property (id,account_id,code,name,rooms,active,created_date) VALUES (?,?,?,?,?,?,?)")
    .run(CANON, "A_1", "RRI1416", "Middleboro RRI1416", 50, 1, "2026-01-01");
  db.prepare("INSERT INTO property (id,account_id,code,name,rooms,active,created_date) VALUES (?,?,?,?,?,?,?)")
    .run(OTHER, "A_1", "RRI-B", "Other Property", 40, 1, "2026-01-01");

  // Granted AFTER the property rows exist: user_property_access has an FK to property.
  seedUser(db, { id: "user_mgr", email: "mgr@incident.local", role: "manager", mode: "specific", grants: [CANON], accountId: "A_1" });

  const activeGen = "gen_active_incident";
  seedGeneration(db, "A_1", activeGen, "user_owner");
  db.prepare("INSERT INTO business_sync_state (account_id,revision) VALUES (?,?)").run("A_1", 0);
  // Legacy dataset aliases: n:1 -> RRI1416 canonical, n:2 -> other property.
  db.prepare("INSERT INTO business_property_map (account_id,generation_id,property_key,server_property_id,property_code) VALUES (?,?,?,?,?)")
    .run("A_1", activeGen, "n:1", CANON, "RRI1416");
  db.prepare("INSERT INTO business_property_map (account_id,generation_id,property_key,server_property_id,property_code) VALUES (?,?,?,?,?)")
    .run("A_1", activeGen, "n:2", OTHER, "RRI-B");

  const { env, stats, reset } = makeInstrumentedEnv(db, {
    ENABLE_D1_DATA_API: "true",
    ENABLE_BUSINESS_SYNC_API: "true",
    RAW_ARCHIVE: testR2Binding(),
    BULK_DATA: testR2Binding(),
  });

  const owner = scopeAll([CANON, OTHER]);
  owner.accountId = "A_1";
  owner.user.id = "user_owner";
  owner.user.account_id = "A_1";
  owner.user.role = "owner";

  const manager = scopeSpecific([CANON]);
  manager.accountId = "A_1";
  manager.user.id = "user_mgr";
  manager.user.account_id = "A_1";
  manager.user.role = "manager";
  manager.user.permissions = JSON.stringify({ import_reports: true });

  return { db, env, stats, reset, owner, manager };
}

function bulkReq(action, { method = "POST", body, headers = {}, scope } = {}) {
  const url = new URL(`http://localhost/api/bulk-import/${action}`);
  const request = new Request(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Requested-With": "XMLHttpRequest",
      ...headers,
    },
    body: body !== undefined ? (body instanceof Uint8Array ? body : JSON.stringify(body)) : undefined,
  });
  return handleBulkImportRequest(request, envHolder.env, scope ?? envHolder.owner, url, [
    "api", "bulk-import", action,
  ]);
}

// Shared mutable holder so bulkReq helpers stay one-liners in the checks below.
const envHolder = { env: null, owner: null };

async function checkDuplicateBody(scope, server_property_id, rawHash) {
  return bulkReq("check-duplicate", {
    scope,
    body: { server_property_id, raw_file_hash: rawHash || "a".repeat(64), normalized_hash: "b".repeat(64) },
  });
}

// ---------------------------------------------------------------------------
// 1. Canonical id already in scope returns unchanged — zero mapping reads.
// ---------------------------------------------------------------------------
await run.check("canonical id: returns unchanged and touches NO pointer/map table", async () => {
  const s = setup();
  envHolder.env = s.env;
  envHolder.owner = s.owner;
  s.reset();
  const res = await checkDuplicateBody(s.owner, CANON);
  assertEqual(res.status, 200, "canonical id must pass check-duplicate");
  const data = await res.json();
  assertEqual(data.is_duplicate, false);
  for (const call of s.stats.calls) {
    assert(
      !call.sql.includes("business_dataset_pointer") && !call.sql.includes("business_property_map"),
      `canonical id must not query mapping tables, saw: ${call.sql}`
    );
  }
});

// ---------------------------------------------------------------------------
// 2-3. THE PRODUCTION INCIDENT: string "1" and numeric 1 resolve equivalently.
// ---------------------------------------------------------------------------
await run.check("incident case: string \"1\" resolves through n:1 -> canonical (was 403 outside caller scope)", async () => {
  const s = setup();
  envHolder.env = s.env;
  envHolder.owner = s.owner;
  const res = await checkDuplicateBody(s.owner, RAW_ALIAS);
  assertEqual(res.status, 200, `string "1" must resolve for the owner; got ${res.status}`);
});

await run.check("numeric 1 resolves equivalently to string \"1\" through n:1", async () => {
  const s = setup();
  envHolder.env = s.env;
  envHolder.owner = s.owner;
  const res = await checkDuplicateBody(s.owner, 1);
  assertEqual(res.status, 200, "numeric 1 must resolve identically");
});

await run.check("string \"1\" also resolves through an s:1:1 map row (alternate typed key)", async () => {
  const s = setup();
  envHolder.env = s.env;
  envHolder.owner = s.owner;
  const activeGen = s.db.prepare("SELECT active_generation_id FROM business_dataset_pointer WHERE account_id='A_1'").get().active_generation_id;
  // Retire n:1, keep only the string-typed alias s:1:1 -> CANON.
  s.db.prepare("UPDATE business_property_map SET property_key='s:1:1' WHERE account_id='A_1' AND generation_id=? AND property_key='n:1'").run(activeGen);
  const res = await checkDuplicateBody(s.owner, "1");
  assertEqual(res.status, 200, "string \"1\" must resolve through s:1:1");
  const resNum = await checkDuplicateBody(s.owner, 1);
  assertEqual(resNum.status, 200, "numeric 1 must resolve through s:1:1 via its alternate");
});

await run.check("raw-check (body) resolves the alias too", async () => {
  const s = setup();
  envHolder.env = s.env;
  envHolder.owner = s.owner;
  const res = await bulkReq("raw-check", { body: { server_property_id: RAW_ALIAS, raw_file_hash: "c".repeat(64) } });
  assertEqual(res.status, 200);
  const data = await res.json();
  assertEqual(data.exists, false);
});

// ---------------------------------------------------------------------------
// 4-5. Unknown and malformed aliases fail closed — no loose aliases.
// ---------------------------------------------------------------------------
await run.check("unknown alias fails closed with 403 outside caller scope", async () => {
  const s = setup();
  envHolder.env = s.env;
  envHolder.owner = s.owner;
  const res = await checkDuplicateBody(s.owner, "9");
  assertEqual(res.status, 403);
  const data = await res.json();
  assertEqual(data.code, "SCOPE_DENIED");
  assert(String(data.error).includes("outside caller scope"), `surface preserved, got: ${data.error}`);
});

await run.check("malformed/noncanonical numerics gain no loose aliases (\"01\", \"1.0\", \" 1\", \"+1\")", async () => {
  const s = setup();
  envHolder.env = s.env;
  envHolder.owner = s.owner;
  for (const bad of ["01", "1.0", " 1", "+1", "1e0"]) {
    const res = await checkDuplicateBody(s.owner, bad);
    assertEqual(res.status, 403, `"${bad}" must not resolve`);
  }
});

await run.check("missing property id still fails 400 IMPORT_PROPERTY_REQUIRED", async () => {
  const s = setup();
  envHolder.env = s.env;
  envHolder.owner = s.owner;
  const res = await bulkReq("check-duplicate", { body: { raw_file_hash: "a".repeat(64) } });
  assertEqual(res.status, 400);
  assertEqual((await res.json()).code, "IMPORT_PROPERTY_REQUIRED");
});

// ---------------------------------------------------------------------------
// 6. Ambiguous alias fails closed with a distinct 422 — owners too.
// ---------------------------------------------------------------------------
await run.check("ambiguous alias (n:1 and s:1:1 -> different properties) fails closed 422, owner included", async () => {
  const s = setup();
  envHolder.env = s.env;
  envHolder.owner = s.owner;
  const activeGen = s.db.prepare("SELECT active_generation_id FROM business_dataset_pointer WHERE account_id='A_1'").get().active_generation_id;
  // Ambiguity needs two DIFFERENT canonical properties holding the numeric and
  // string forms: UNIQUE(account,generation,server_property_id) forbids one
  // property from carrying both map rows.
  s.db.prepare("INSERT INTO property (id,account_id,code,name,rooms,active,created_date) VALUES (?,?,?,?,?,?,?)")
    .run("prop_amb_third", "A_1", "AMB", "Ambiguous Third", 30, 1, "2026-01-01");
  s.db.prepare("INSERT INTO business_property_map (account_id,generation_id,property_key,server_property_id,property_code) VALUES (?,?,?,?,?)")
    .run("A_1", activeGen, "s:1:1", "prop_amb_third", "AMB");
  for (const incoming of ["1", 1]) {
    const res = await checkDuplicateBody(s.owner, incoming);
    assertEqual(res.status, 422, `ambiguous alias must fail closed for ${JSON.stringify(incoming)}`);
    const data = await res.json();
    assertEqual(data.code, "IMPORT_PROPERTY_AMBIGUOUS");
  }
});

// ---------------------------------------------------------------------------
// 7. Specific scope: own granted property alias works; another property's
//    alias resolves but is rejected because the RESULT is out of scope.
// ---------------------------------------------------------------------------
await run.check("specific scope: manager can use its granted property's alias \"1\"", async () => {
  const s = setup();
  envHolder.env = s.env;
  envHolder.owner = s.owner;
  const res = await checkDuplicateBody(s.manager, RAW_ALIAS);
  assertEqual(res.status, 200, "manager granted CANON must resolve alias \"1\"");
});

await run.check("specific scope: another property's alias \"2\" is denied even though it resolves", async () => {
  const s = setup();
  envHolder.env = s.env;
  envHolder.owner = s.owner;
  const res = await checkDuplicateBody(s.manager, "2");
  assertEqual(res.status, 403, "alias resolving to an out-of-scope property must fail closed");
  const data = await res.json();
  assertEqual(data.code, "SCOPE_DENIED");
  assert(String(data.error).includes("outside caller scope"));
});

// ---------------------------------------------------------------------------
// 8. Owner no-bypass: the resolved canonical id itself must be in scope.
// ---------------------------------------------------------------------------
await run.check("owner no-bypass: resolved id outside scope.propertyIds is denied even for role owner", async () => {
  const s = setup();
  envHolder.env = s.env;
  envHolder.owner = s.owner;
  const restrictedOwner = scopeAll([OTHER]); // owner, all=true, but materialized set excludes CANON
  restrictedOwner.accountId = "A_1";
  restrictedOwner.user = s.owner.user;
  const res = await checkDuplicateBody(restrictedOwner, RAW_ALIAS);
  assertEqual(res.status, 403, "owner must not bypass the result-in-scope requirement");
});

// ---------------------------------------------------------------------------
// 9. Resolution happens ONLY through the ACTIVE generation.
// ---------------------------------------------------------------------------
await run.check("alias mapping in a retired (inactive) generation does not resolve", async () => {
  const s = setup();
  envHolder.env = s.env;
  envHolder.owner = s.owner;
  const activeGen = s.db.prepare("SELECT active_generation_id FROM business_dataset_pointer WHERE account_id='A_1'").get().active_generation_id;
  const oldGen = "gen_retired";
  seedGeneration(s.db, "A_1", oldGen, "user_owner", { withPointer: false });
  s.db.prepare("UPDATE business_dataset SET status='retired' WHERE account_id='A_1' AND generation_id=?").run(oldGen);
  s.db.prepare("INSERT INTO property (id,account_id,code,name,rooms,active,created_date) VALUES (?,?,?,?,?,?,?)")
    .run("prop_old_only", "A_1", "OLD", "Old Property", 10, 1, "2026-01-01");
  s.db.prepare("INSERT INTO business_property_map (account_id,generation_id,property_key,server_property_id,property_code) VALUES (?,?,?,?,?)")
    .run("A_1", oldGen, "n:7", CANON, "RRI1416");
  assert(activeGen !== oldGen);
  const res = await checkDuplicateBody(s.owner, "7");
  assertEqual(res.status, 403, "retired-generation alias must not resolve");
});

await run.check("alias with no active generation pointer at all fails closed", async () => {
  const s = setup();
  envHolder.env = s.env;
  envHolder.owner = s.owner;
  s.db.prepare("DELETE FROM business_dataset_pointer WHERE account_id='A_1'").run();
  const res = await checkDuplicateBody(s.owner, RAW_ALIAS);
  assertEqual(res.status, 403, "alias without an active generation must fail closed");
  // Canonical id still works: exact-in-scope short-circuit needs no mapping.
  const resCanon = await checkDuplicateBody(s.owner, CANON);
  assertEqual(resCanon.status, 200, "canonical id must keep working without a generation");
});

// ---------------------------------------------------------------------------
// 10. Full-flow canonicalization: every route normalizes the alias to the
// canonical id in R2 keys, storage metadata, and D1 manifest values.
// ---------------------------------------------------------------------------
await run.check("full flow via alias: raw-upload, raw-archive, pending, upload, activate, manifest, duplicate — all canonical", async () => {
  const s = setup();
  envHolder.env = s.env;
  envHolder.owner = s.owner;

  // The browser builds the bundle rows with the id it knows: the alias "1".
  const rawRows = Array.from({ length: 12 }, (_, i) => ({
    date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().split("T")[0],
    rooms_occupied: 40 + i,
    total_rooms: 50,
    room_revenue: 4000 + i * 10,
  }));
  const bundle = buildNormalizedBundle(
    { type: "occupancy", rowsToImport: rawRows, totalRows: rawRows.length },
    { propertyId: RAW_ALIAS, propertyName: "Middleboro RRI1416", sourceFile: "jan.csv" },
    "bundle_alias_flow"
  );
  const rawPayload = new TextEncoder().encode("raw,file,contents\n1,2,3\n");
  const rawHash = await sha256Hex(rawPayload);
  const normalizedHash = await sha256Hex(bundle.ndjson);
  const compressed = await compressPayloadGzip(bundle.ndjson);

  // (a) raw-upload via alias header
  const rawUpRes = await bulkReq("raw-upload", {
    method: "PUT",
    headers: {
      "Content-Type": "text/csv",
      "x-server-property-id": RAW_ALIAS,
      "x-raw-hash": rawHash,
      "x-report-type": "occupancy",
      "x-archive-id": "raw_alias_flow",
    },
    body: rawPayload,
  });
  assertEqual(rawUpRes.status, 201, `raw-upload via alias must succeed; got ${rawUpRes.status}`);
  const rawUpData = await rawUpRes.json();
  const canonicalRawKey = `rri-raw/A_1/${CANON}/${rawHash}`;
  assertEqual(rawUpData.raw_object_key, canonicalRawKey, "raw object key must be canonical");
  assert(getMockStore().has(canonicalRawKey), "raw object stored under canonical key");
  assert(!getMockStore().has(`rri-raw/A_1/${RAW_ALIAS}/${rawHash}`), "no legacy alias key may exist");
  assertEqual(getMockStore().get(canonicalRawKey).customMetadata.server_property_id, CANON, "raw metadata must be canonical");

  // (b) raw-archive via alias body
  const rawRecRes = await bulkReq("raw-archive", {
    body: {
      id: "raw_alias_flow",
      raw_archive_id: "raw_alias_flow",
      server_property_id: RAW_ALIAS,
      report_type: "occupancy",
      raw_file_hash: rawHash,
      raw_size: rawPayload.byteLength,
      original_file_name: "jan.csv",
    },
  });
  assertEqual(rawRecRes.status, 201, `raw-archive via alias must succeed; got ${rawRecRes.status}`);
  let manifestRow = s.db.prepare("SELECT * FROM import_bundle_manifest WHERE account_id='A_1' AND id='raw_alias_flow'").get();
  assertEqual(manifestRow.server_property_id, CANON, "D1 manifest must store the canonical id");
  assertEqual(manifestRow.raw_object_key, canonicalRawKey, "manifest raw key must be canonical");

  // (c) pending feed via alias query must surface the canonical row
  const pendingUrl = new URL(`http://localhost/api/bulk-import/pending?server_property_id=${RAW_ALIAS}`);
  const pendingRes = await handleBulkImportRequest(
    new Request(pendingUrl), s.env, s.owner, pendingUrl, ["api", "bulk-import", "pending"]
  );
  assertEqual(pendingRes.status, 200);
  const pendingData = await pendingRes.json();
  assertEqual(pendingData.pending.length, 1, "alias-filtered pending feed finds the canonical row");
  assertEqual(pendingData.pending[0].server_property_id, CANON);

  // (d) upload bundle via alias header (rows carry the alias; key/metadata canonical)
  const upRes = await bulkReq("upload", {
    method: "PUT",
    headers: {
      "Content-Type": "application/gzip",
      "x-server-property-id": RAW_ALIAS,
      "x-report-type": "occupancy",
      "x-raw-hash": rawHash,
      "x-normalized-hash": normalizedHash,
      "x-row-count": String(bundle.totalRowCount),
    },
    body: compressed,
  });
  assertEqual(upRes.status, 201, `upload via alias must succeed; got ${upRes.status}`);
  const upData = await upRes.json();
  const canonicalBulkKey = `rri-bulk/A_1/${CANON}/v1/${normalizedHash}.ndjson.gz`;
  assertEqual(upData.object_key, canonicalBulkKey, "bundle object key must be canonical");
  assert(getMockStore().has(canonicalBulkKey), "bundle stored under canonical key");
  assert(!getMockStore().has(`rri-bulk/A_1/${RAW_ALIAS}/v1/${normalizedHash}.ndjson.gz`), "no alias bundle key");
  assertEqual(getMockStore().get(canonicalBulkKey).customMetadata.server_property_id, CANON, "bundle metadata must be canonical");

  // (e) activate via alias body
  const actRes = await bulkReq("activate", {
    body: {
      id: "raw_alias_flow",
      server_property_id: RAW_ALIAS,
      report_type: "occupancy",
      raw_file_hash: rawHash,
      normalized_hash: normalizedHash,
      row_count: bundle.totalRowCount,
      entity_counts: bundle.entityCounts,
    },
  });
  assertEqual(actRes.status, 201, `activate via alias must succeed; got ${actRes.status}`);
  manifestRow = s.db.prepare("SELECT * FROM import_bundle_manifest WHERE account_id='A_1' AND id='raw_alias_flow'").get();
  assertEqual(manifestRow.status, "active");
  assertEqual(manifestRow.server_property_id, CANON, "activated manifest must be canonical");
  assertEqual(manifestRow.object_key, canonicalBulkKey, "activated object key must be canonical");
  const changeRow = s.db.prepare("SELECT server_property_id FROM business_change WHERE account_id='A_1' AND record_key='raw_alias_flow'").get();
  assertEqual(changeRow.server_property_id, CANON, "business_change must record the canonical id");

  // (f) manifest feed via alias query
  const manifestUrl = new URL(`http://localhost/api/bulk-import/manifest?server_property_id=${RAW_ALIAS}&since_revision=0`);
  const manifestRes = await handleBulkImportRequest(
    new Request(manifestUrl), s.env, s.owner, manifestUrl, ["api", "bulk-import", "manifest"]
  );
  assertEqual(manifestRes.status, 200);
  const manifestData = await manifestRes.json();
  assertEqual(manifestData.manifests.length, 1, "alias-filtered manifest feed finds the canonical row");
  assertEqual(manifestData.manifests[0].server_property_id, CANON);

  // (g) duplicate lookup via alias must find the canonical-stored bundle
  const dupRes = await bulkReq("check-duplicate", {
    body: { server_property_id: RAW_ALIAS, raw_file_hash: rawHash, normalized_hash: normalizedHash },
  });
  assertEqual(dupRes.status, 200);
  const dupData = await dupRes.json();
  assertEqual(dupData.is_duplicate, true, "alias-based duplicate lookup must hit the canonical row");
  assertEqual(dupData.existing_bundle.id, "raw_alias_flow");

  // (h) NO legacy alias anywhere in D1 or R2
  const aliasRows = s.db.prepare("SELECT COUNT(*) AS n FROM import_bundle_manifest WHERE account_id='A_1' AND server_property_id='1'").get().n;
  assertEqual(Number(aliasRows), 0, "no manifest row may store the legacy alias");
  for (const key of getMockStore().keys()) {
    assert(!key.includes("/1/"), `no legacy alias object key, saw ${key}`);
  }
});

// ---------------------------------------------------------------------------
// 11. Mutation-header security gate unchanged (router level).
// ---------------------------------------------------------------------------
await run.check("X-Requested-With gate unchanged: mutation without the header is 403 before anything else", async () => {
  const s = setup();
  const reqNoHeader = new Request("http://localhost/api/bulk-import/check-duplicate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ server_property_id: RAW_ALIAS, raw_file_hash: "a".repeat(64) }),
  });
  const res = await worker.fetch(reqNoHeader, s.env, { waitUntil() {}, passThroughOnException() {} });
  assertEqual(res.status, 403);
  assertEqual((await res.json()).error, "forbidden");

  const reqWithHeader = new Request("http://localhost/api/bulk-import/check-duplicate", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
    body: JSON.stringify({ server_property_id: RAW_ALIAS, raw_file_hash: "a".repeat(64) }),
  });
  const resGate = await worker.fetch(reqWithHeader, s.env, { waitUntil() {}, passThroughOnException() {} });
  assert(resGate.status !== 403 || (await resGate.clone().json()).error !== "forbidden",
    "gate must pass the headered mutation on to auth (401), not reject as forbidden");
  assertEqual(resGate.status, 401, "headered but unauthenticated mutation reaches auth as 401");
});

run.done();
if (process.exitCode) process.exit(1);
console.log("PASSED: probe-bulk-import-property-identity completed all tests successfully.");
process.exit(0);
