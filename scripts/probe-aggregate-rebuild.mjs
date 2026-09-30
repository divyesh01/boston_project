// scripts/probe-aggregate-rebuild.mjs — Independent probe for R03, R04, R05
// Verifies:
// 1. Cross-property authorization and capability check (R03)
// 2. Storage adapter resolution (R04)
// 3. Fail-closed on missing/corrupt bundles (R05)
// 4. Obsolete summary cleanup (R05)
// 5. Accurate calculations and dynamic health score (R05, R06)

import { contentHash, normalizedContent, REPORT_ENTITY } from "../worker/bulk-contract.js";
import { gzipSync } from "node:zlib";
import {
  makeDb,
  makeEnv,
  seedProperties,
  seedUser,
  makeRunner,
  assert,
  assertEqual,
} from "./_worker-testkit.mjs";
import { handleAggregatesRequest } from "../worker/aggregates.js";

const r = makeRunner("probe-aggregate-rebuild");

function createGzipBuffer(stringContent) {
  return gzipSync(Buffer.from(stringContent, "utf8"));
}

function makeMockStorage(objects = {}) {
  return {
    async get(key) {
      if (key in objects) {
        const val = objects[key];
        if (val === null) return null;
        if (val instanceof Error) throw val;
        const buf = Buffer.isBuffer(val) ? val : Buffer.from(val);
        return {
          async arrayBuffer() {
            return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
          },
        };
      }
      return null;
    },
  };
}

function buildTestFixture() {
  const db = makeDb();
  seedProperties(db); // P_A and P_B for account A_1

  // Staff user (no rebuild permission)
  seedUser(db, { id: "u_staff", email: "staff@hotel.example", role: "staff", mode: "specific", grants: ["P_A"] });

  // GM without explicit permissions
  seedUser(db, { id: "u_gm_noperm", email: "gm_noperm@hotel.example", role: "gm", mode: "all" });

  // GM with rebuild_aggregates permission
  seedUser(db, { id: "u_gm_perm", email: "gm_perm@hotel.example", role: "gm", mode: "all" });
  db.prepare("UPDATE user SET permissions = ? WHERE id = ?").run(JSON.stringify({ import_reports: true }), "u_gm_perm");

  // Manager scoped to P_A only with rebuild_aggregates permission
  seedUser(db, { id: "u_mgr_a", email: "mgr_a@hotel.example", role: "manager", mode: "specific", grants: ["P_A"] });
  db.prepare("UPDATE user SET permissions = ? WHERE id = ?").run(JSON.stringify({ import_reports: true }), "u_mgr_a");

  // Owner user
  seedUser(db, { id: "u_owner", email: "owner@hotel.example", role: "owner", mode: "all" });

  return db;
}

await r.check("R03: Staff caller is rejected with 403", async () => {
  const db = buildTestFixture();
  const env = makeEnv(db);
  const scope = {
    user: { id: "u_staff", account_id: "A_1", role: "staff", permissions: "{}" },
    accountId: "A_1",
    all: false,
    propertyIds: ["P_A"],
  };
  const req = new Request("https://api.test/api/aggregates/rebuild", { method: "POST" });
  const res = await handleAggregatesRequest(req, env, scope, new URL(req.url), ["api", "aggregates", "rebuild"]);
  assertEqual(res.status, 403, "Staff must be denied");
});

await r.check("R03: GM/Manager without rebuild permissions is rejected with 403", async () => {
  const db = buildTestFixture();
  const env = makeEnv(db);
  const scope = {
    user: { id: "u_gm_noperm", account_id: "A_1", role: "gm", permissions: "{}" },
    accountId: "A_1",
    all: true,
    propertyIds: ["P_A", "P_B"],
  };
  const req = new Request("https://api.test/api/aggregates/rebuild", { method: "POST" });
  const res = await handleAggregatesRequest(req, env, scope, new URL(req.url), ["api", "aggregates", "rebuild"]);
  assertEqual(res.status, 403, "GM without rebuild permission must be denied");
});

await r.check("R03: Specific-property manager cannot perform account-wide rebuild", async () => {
  const db = buildTestFixture();
  const env = makeEnv(db);
  const scope = {
    user: { id: "u_mgr_a", account_id: "A_1", role: "manager", permissions: JSON.stringify({ import_reports: true }) },
    accountId: "A_1",
    all: false,
    propertyIds: ["P_A"],
  };
  const req = new Request("https://api.test/api/aggregates/rebuild", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ property_id: "all" }),
  });
  const res = await handleAggregatesRequest(req, env, scope, new URL(req.url), ["api", "aggregates", "rebuild"]);
  assertEqual(res.status, 403, "Account-wide rebuild by single-property manager must be rejected");
});

await r.check("R03: Specific-property manager cannot rebuild foreign property (P_B)", async () => {
  const db = buildTestFixture();
  const env = makeEnv(db);
  const scope = {
    user: { id: "u_mgr_a", account_id: "A_1", role: "manager", permissions: JSON.stringify({ import_reports: true }) },
    accountId: "A_1",
    all: false,
    propertyIds: ["P_A"],
  };
  const req = new Request("https://api.test/api/aggregates/rebuild", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ property_id: "P_B" }),
  });
  const res = await handleAggregatesRequest(req, env, scope, new URL(req.url), ["api", "aggregates", "rebuild"]);
  assertEqual(res.status, 403, "Cross-property rebuild must be rejected");
});

await r.check("R04: Storage unconfigured returns 503", async () => {
  const db = buildTestFixture();
  const env = makeEnv(db); // No BULK_DATA and no R2_S3 / S3 configuration
  const scope = {
    user: { id: "u_owner", account_id: "A_1", role: "owner" },
    accountId: "A_1",
    all: true,
    propertyIds: ["P_A", "P_B"],
  };
  const req = new Request("https://api.test/api/aggregates/rebuild", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ property_id: "P_A" }),
  });
  const res = await handleAggregatesRequest(req, env, scope, new URL(req.url), ["api", "aggregates", "rebuild"]);
  assertEqual(res.status, 503, "Missing storage must return 503");
  const data = await res.json();
  assert(data.error.includes("storage"), "Error message should mention storage");
});

await r.check("R05: Missing storage bundle object fails closed with 422", async () => {
  const db = buildTestFixture();
  const mockStorage = makeMockStorage({}); // Empty storage, object does not exist
  const env = makeEnv(db, { BULK_DATA: mockStorage });

  // Insert active manifest referencing object_key "bundle-1.ndjson.gz"
  db.prepare(`
    INSERT INTO import_bundle_manifest (
      id, account_id, server_property_id, report_type, raw_file_hash,
      object_key, status, revision, original_file_name, uploaded_by, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "m1", "A_1", "P_A", "occupancy", "hash1",
    "bundle-1.ndjson.gz", "active", 1, "test.csv", "test@hotel.example", new Date().toISOString()
  );

  const scope = {
    user: { id: "u_owner", account_id: "A_1", role: "owner" },
    accountId: "A_1",
    all: true,
    propertyIds: ["P_A", "P_B"],
  };
  const req = new Request("https://api.test/api/aggregates/rebuild", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ property_id: "P_A" }),
  });
  const res = await handleAggregatesRequest(req, env, scope, new URL(req.url), ["api", "aggregates", "rebuild"]);
  assertEqual(res.status, 422, "Missing bundle in storage must fail closed with 422");
  const data = await res.json();
  assertEqual(data.failed_manifest, "m1");
});

await r.check("R05: Corrupt storage bundle fails closed with 422", async () => {
  const db = buildTestFixture();
  // Corrupt non-gzip data
  const mockStorage = makeMockStorage({
    "bundle-corrupt.ndjson.gz": Buffer.from("this is definitely not gzip data"),
  });
  const env = makeEnv(db, { BULK_DATA: mockStorage });

  db.prepare(`
    INSERT INTO import_bundle_manifest (
      id, account_id, server_property_id, report_type, raw_file_hash,
      object_key, status, revision, original_file_name, uploaded_by, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "m_corrupt", "A_1", "P_A", "occupancy", "hash_corrupt",
    "bundle-corrupt.ndjson.gz", "active", 1, "test.csv", "test@hotel.example", new Date().toISOString()
  );

  const scope = {
    user: { id: "u_owner", account_id: "A_1", role: "owner" },
    accountId: "A_1",
    all: true,
    propertyIds: ["P_A", "P_B"],
  };
  const req = new Request("https://api.test/api/aggregates/rebuild", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ property_id: "P_A" }),
  });
  const res = await handleAggregatesRequest(req, env, scope, new URL(req.url), ["api", "aggregates", "rebuild"]);
  assertEqual(res.status, 422, "Corrupt bundle must fail closed with 422");
});

await r.check("R05: Storage read failure returns 502", async () => {
  const db = buildTestFixture();
  const mockStorage = makeMockStorage({
    "bundle-err.ndjson.gz": new Error("Connection reset by peer"),
  });
  const env = makeEnv(db, { BULK_DATA: mockStorage });

  db.prepare(`
    INSERT INTO import_bundle_manifest (
      id, account_id, server_property_id, report_type, raw_file_hash,
      object_key, status, revision, original_file_name, uploaded_by, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "m_err", "A_1", "P_A", "occupancy", "hash_err",
    "bundle-err.ndjson.gz", "active", 1, "test.csv", "test@hotel.example", new Date().toISOString()
  );

  const scope = {
    user: { id: "u_owner", account_id: "A_1", role: "owner" },
    accountId: "A_1",
    all: true,
    propertyIds: ["P_A", "P_B"],
  };
  const req = new Request("https://api.test/api/aggregates/rebuild", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ property_id: "P_A" }),
  });
  const res = await handleAggregatesRequest(req, env, scope, new URL(req.url), ["api", "aggregates", "rebuild"]);
  assertEqual(res.status, 502, "Storage read error must return 502");
});

await r.check("R05: Obsolete summaries are cleaned up when no active manifests exist", async () => {
  const db = buildTestFixture();
  const mockStorage = makeMockStorage({});
  const env = makeEnv(db, { BULK_DATA: mockStorage });

  // Insert an obsolete row in property_day_summary
  db.prepare(`
    INSERT INTO property_day_summary (
      id, account_id, property_id, business_date, room_revenue_cents,
      ancillary_revenue_cents, total_revenue_cents, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("A_1:P_A:2026-01-01", "A_1", "P_A", "2026-01-01", 10000, 1000, 11000, new Date().toISOString());

  const scope = {
    user: { id: "u_owner", account_id: "A_1", role: "owner" },
    accountId: "A_1",
    all: true,
    propertyIds: ["P_A", "P_B"],
  };
  const req = new Request("https://api.test/api/aggregates/rebuild", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ property_id: "P_A" }),
  });
  const res = await handleAggregatesRequest(req, env, scope, new URL(req.url), ["api", "aggregates", "rebuild"]);
  assertEqual(res.status, 200, "Clean rebuild should succeed with 200");
  const data = await res.json();
  assertEqual(data.rebuilt_days, 0);

  // Prove obsolete summary was deleted
  const remaining = db.prepare("SELECT COUNT(*) as cnt FROM property_day_summary WHERE property_id = 'P_A'").get();
  assertEqual(remaining.cnt, 0, "Obsolete property_day_summary must be deleted");
});

await r.check("R05 & R06: Successful rebuild with accurate calculations, dimensions, and health score", async () => {
  const db = buildTestFixture();

  // Create valid NDJSON bundle items for date 2026-03-15
  const ndjson = [
    JSON.stringify({
      entity: "OccupancyDay",
      row: { property_id: "P_A", date: "2026-03-15", rooms_sold: 75, total_rooms: 100, room_revenue: 7500.0 },
    }),
    JSON.stringify({
      entity: "GrossRevenueDay",
      row: {
        property_id: "P_A",
        date: "2026-03-15",
        room_rent: 7500.0,
        misc_charge: 300.0,
        food: 200.0,
        event: 0,
        bar: 100.0,
        laundry: 50.0,
        other: 50.0,
        state_tax: 700.0,
        city_tax: 300.0,
        other_tax: 50.0,
      },
    }),
    JSON.stringify({
      entity: "SourceDay",
      row: { property_id: "P_A", date: "2026-03-15", source: "Expedia", net_revenue: 4500.0, stays: 45 },
    }),
    JSON.stringify({
      entity: "SourceDay",
      row: { property_id: "P_A", date: "2026-03-15", source: "Direct", net_revenue: 3000.0, stays: 30 },
    }),
    JSON.stringify({
      entity: "PaymentDay",
      row: { property_id: "P_A", date: "2026-03-15", total: 8200.0, cash: 1200.0, visa: 7000.0 },
    }),
  ].join("\n");

  const objects = {};
  for (const [type,entity] of Object.entries(REPORT_ENTITY)) {
    const items = ndjson.split('\n').map(JSON.parse).filter(item => item.entity === entity);
    if (!items.length) continue;
    const hash = await contentHash(normalizedContent(items)); const key = type + '.gz';
    objects[key] = createGzipBuffer(items.map(item=>JSON.stringify(item)).join('\n'));
    db.prepare("INSERT INTO import_bundle_manifest(id,account_id,server_property_id,report_type,raw_file_hash,normalized_hash,identity_version,row_count,object_key,status,revision,min_date,max_date,original_file_name,uploaded_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(type,'A_1','P_A',type,hash,hash,2,items.length,key,'active',5,'2026-03-15','2026-03-15','fixture.csv','owner@hotel.example',new Date().toISOString());
  }
  const env = makeEnv(db,{BULK_DATA:makeMockStorage(objects)});
  db.prepare("INSERT INTO property_day_summary(id,account_id,property_id,business_date,total_revenue_cents,updated_at) VALUES (?,?,?,?,?,?)").run('old','A_1','P_A','2026-02-01',5500,new Date().toISOString());
  const scope = {
    user: { id: "u_owner", account_id: "A_1", role: "owner" },
    accountId: "A_1",
    all: true,
    propertyIds: ["P_A", "P_B"],
  };
  const req = new Request("https://api.test/api/aggregates/rebuild", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ property_id: "P_A" }),
  });
  const res = await handleAggregatesRequest(req, env, scope, new URL(req.url), ["api", "aggregates", "rebuild"]);
  assertEqual(res.status, 200, "Rebuild should succeed with 200");
  const data = await res.json();
  assertEqual(data.ok, true);
  assertEqual(data.rebuilt_days, 1);

  // Verify DB state
  const summaries = db.prepare(
    "SELECT * FROM property_day_summary WHERE property_id = 'P_A' ORDER BY business_date"
  ).all();
  assertEqual(summaries.length, 1, "Obsolete 2026-02-01 summary must be pruned; only 2026-03-15 should remain");

  const row = summaries[0];
  assertEqual(row.business_date, "2026-03-15");
  assertEqual(row.room_revenue_cents, 750000, "Room revenue cents should match 7500.00");
  assertEqual(row.ancillary_revenue_cents, 70000, "Ancillary revenue cents: 300+200+100+50+50 = 700.00");
  assertEqual(row.total_revenue_cents, 820000, "Total revenue cents: 7500 + 700 = 8200.00");
  assertEqual(row.rooms_sold, 75);
  assertEqual(row.available_rooms, 100);
  assertEqual(row.occupancy_rate, 0.75);
  assertEqual(row.adr_cents, 10000, "ADR = 7500.00 / 75 = 100.00");
  assertEqual(row.revpar_cents, 7500, "RevPAR = 7500.00 / 100 = 75.00");
  assertEqual(row.gross_ota_revenue_cents, 450000, "Expedia OTA revenue cents: 4500.00");
  assertEqual(row.ota_commission_cents, 0, "Server must not invent a property commission rate");
  assertEqual(row.direct_revenue_cents, 300000, "Direct revenue: 3000.00");
  assertEqual(row.payment_total_cents, 820000, "Payment total: 8200.00");
  assertEqual(row.data_health_score, 100, "All 4 report types present => 100 health score");

  // Verify channel_summary_json and _meta dimensions
  const chJson = JSON.parse(row.channel_summary_json);
  assertEqual(chJson.Expedia, 450000);
  assertEqual(chJson.Direct, 300000);
  assert(chJson._meta != null, "_meta dimensions must be present");
  assertEqual(chJson._meta.taxes.state_tax_cents, 70000);
  assertEqual(chJson._meta.taxes.city_tax_cents, 30000);
  assertEqual(chJson._meta.payments.cash, 120000);
  assertEqual(chJson._meta.payments.visa, 700000);
});

async function rebuildFixture(items, type='occupancy', mutate=null) {
  const db=buildTestFixture(); const text=items.map(item=>JSON.stringify(item)).join('\n');
  const hash=await contentHash(normalizedContent(items));
  db.prepare("INSERT INTO import_bundle_manifest(id,account_id,server_property_id,report_type,raw_file_hash,normalized_hash,identity_version,row_count,object_key,status,revision,original_file_name,uploaded_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run('m','A_1','P_A',type,hash,hash,2,items.length,'fixture.gz','active',1,'fixture.csv','owner@hotel.example',new Date().toISOString());
  db.prepare("INSERT INTO property_day_summary(id,account_id,property_id,business_date,total_revenue_cents,updated_at) VALUES (?,?,?,?,?,?)").run('old','A_1','P_A','2025-01-01',555,new Date().toISOString());
  const storage=makeMockStorage({'fixture.gz':createGzipBuffer(text)});
  const env=makeEnv(db,{BULK_DATA:{get:async key=>{if(mutate)mutate(db);return storage.get(key);}}});
  const scope={user:{id:'u_owner',role:'owner'},accountId:'A_1',all:true,propertyIds:['P_A','P_B']};
  const req=new Request('https://api.test/api/aggregates/rebuild',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({property_id:'P_A'})});
  const res=await handleAggregatesRequest(req,env,scope,new URL(req.url),['api','aggregates','rebuild']);
  return {res,db,env};
}
const occupancy=(date,extra={})=>({entity:'OccupancyDay',row:{property_id:'P_A',date,room_revenue:100,rooms_sold:1,total_rooms:10,...extra}});
await r.check('214 days use bounded parameters and one atomic publication',async()=>{
  const items=Array.from({length:214},(_,i)=>occupancy(new Date(Date.UTC(2026,0,i+1)).toISOString().slice(0,10)));
  const {res,db}=await rebuildFixture(items); assertEqual(res.status,200); assertEqual(db.prepare('SELECT COUNT(*) AS n FROM property_day_summary').get().n,214);
});
await r.check('failure on late insert rolls back deletion and every replacement',async()=>{
  const items=Array.from({length:60},(_,i)=>occupancy(new Date(Date.UTC(2026,0,i+1)).toISOString().slice(0,10)));
  const {res,db}=await rebuildFixture(items,'occupancy',db=>db.exec("CREATE TRIGGER reject_day BEFORE INSERT ON property_day_summary WHEN NEW.business_date='2026-02-09' BEGIN SELECT RAISE(ABORT,'injected failure'); END"));
  assertEqual(res.status,409); const rows=db.prepare('SELECT * FROM property_day_summary').all();assertEqual(rows.length,1);assertEqual(rows[0].total_revenue_cents,555);
});
await r.check('mid-read permission revocation preserves prior authority',async()=>{
 const {res,db}=await rebuildFixture([occupancy('2026-01-01')],'occupancy',db=>db.prepare("UPDATE user SET is_active=0 WHERE id='u_owner'").run());assertEqual(res.status,409);assertEqual(db.prepare('SELECT total_revenue_cents FROM property_day_summary').get().total_revenue_cents,555);
});
await r.check('unsafe room counts never publish',async()=>{
 for (const sold of [-1,0.5,Infinity]) {const {res}=await rebuildFixture([occupancy('2026-01-01',{rooms_sold:sold})]);assertEqual(res.status,422);}
});
await r.check('prototype-shaped source names remain ordinary data',async()=>{
 const items=['__proto__','constructor','toString'].map(source=>({entity:'SourceDay',row:{property_id:'P_A',date:'2026-01-01',source,net_revenue:10,stays:1}}));
 const {res,db}=await rebuildFixture(items,'source');assertEqual(res.status,200);assertEqual(Object.prototype.net,undefined);
 const meta=JSON.parse(db.prepare('SELECT channel_summary_json FROM property_day_summary').get().channel_summary_json)._meta;assertEqual(meta.channelsWithStays['__proto__'].net,1000);
});
await r.check('duplicate daily sections add consistently with the raw ledger',async()=>{
 const {res,db}=await rebuildFixture([occupancy('2026-01-01'),occupancy('2026-01-01',{room_revenue:150})]);assertEqual(res.status,200);const row=db.prepare('SELECT * FROM property_day_summary').get();assertEqual(row.room_revenue_cents,25000);assertEqual(row.available_rooms,20);
});

r.done();
console.log('PASSED: aggregate rebuild checks completed');
process.exit(0);
