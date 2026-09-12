import './_loader-boot.mjs';
import 'fake-indexeddb/auto';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { makeInstrumentedEnv, makeRunner, assert, assertEqual, scopeAll } from './_worker-testkit.mjs';
import { clearMockStore, getMockStore, testR2Binding } from './_r2-testkit.mjs';
import { handleBulkImportRequest } from '../worker/bulk-import.js';
import { executeBulkImport, buildNormalizedBundle, sha256Hex, compressPayloadGzip } from '../src/lib/bulkImportPipeline.js';
import { contentHash, normalizedContent } from '../worker/bulk-contract.js';
import { syncBulkBundles, getLastBulkRevision } from '../src/lib/bulkHydrationService.js';
import localDb from '../src/api/localDb.js';
const nativeFetch = globalThis.fetch;
const run = makeRunner('probe-bulk-import-integrity');
let db, env, scope;
async function setup() {
  if (db) db.close();
  clearMockStore();
  await localDb.delete(); await localDb.open();
  db = new DatabaseSync(':memory:');
  for (const name of readdirSync(new URL('../migrations-production/', import.meta.url)).filter(n => n.endsWith('.sql')).sort()) {
    db.exec(readFileSync(new URL(`../migrations-production/${name}`, import.meta.url), 'utf8'));
  }
  db.prepare('INSERT INTO account(id,name,created_date) VALUES(?,?,?)').run('A_1','test','2026-09-12');
  db.prepare('INSERT INTO business_sync_state(account_id,revision) VALUES(?,0)').run('A_1');
  env = makeInstrumentedEnv(db, { RAW_ARCHIVE: testR2Binding(), BULK_DATA: testR2Binding() }).env;
  scope = scopeAll(['P_A', 'P_B']);
  globalThis.fetch = async (input, init) => {
    const request = new Request(new URL(String(input), 'http://localhost'), init);
    const routeUrl = new URL(request.url);
    return handleBulkImportRequest(request, env, scope, routeUrl, routeUrl.pathname.split('/').filter(Boolean));
  };
}
const scan = (total = 100, date = '2026-09-01') => ({ type: 'payments', totalRows: 1, rowsToImport: [{date,total}] });
const meta = bytes => ({propertyId:'P_A',sourceFile:'payments.csv',rawBytes:new TextEncoder().encode(bytes)});
async function post(action, body) { return fetch(`/api/bulk-import/${action}`, {method:'POST',body:JSON.stringify(body)}); }
await run.check('Populated 0005 to 0006 preserves all prior columns, indexes and constraints', async () => {
  const migrationDb = new DatabaseSync(':memory:');
  try {
    const names = readdirSync(new URL('../migrations-production/',import.meta.url)).filter(n=>n.endsWith('.sql')).sort();
    for (const name of names.filter(n=>n<'0006')) migrationDb.exec(readFileSync(new URL(`../migrations-production/${name}`,import.meta.url),'utf8'));
    migrationDb.prepare('INSERT INTO account(id,name,created_date) VALUES(?,?,?)').run('migration-account','fixture','2026-09-12');
    for (const [i,status] of ['active','superseded','raw_archived'].entries()) {
      migrationDb.prepare(`INSERT INTO import_bundle_manifest(id,account_id,server_property_id,report_type,raw_file_hash,normalized_hash,
        original_file_name,uploaded_by,created_at,status,archive_status,revision,parser_version,schema_version,raw_archive_id,raw_object_key)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(`m${i}`,'migration-account','P_A','payments',`raw${i}`,`normalized${i}`,
        `file${i}.csv`,'owner','2026-09-12',status,'archived',10+i,7,1,`m${i}`,`key${i}`);
    }
    const before = migrationDb.prepare('SELECT * FROM import_bundle_manifest ORDER BY id').all();
    const indexes = migrationDb.prepare("SELECT name,sql FROM sqlite_master WHERE type='index' AND tbl_name='import_bundle_manifest' ORDER BY name").all();
    const migration = readFileSync(new URL('../migrations-production/0006_bulk_import_integrity.sql',import.meta.url),'utf8');
    migrationDb.exec('BEGIN'); migrationDb.exec(migration); migrationDb.exec('ROLLBACK');
    assertEqual(JSON.stringify(migrationDb.prepare('SELECT * FROM import_bundle_manifest ORDER BY id').all()),JSON.stringify(before),'rollback preserves original rows');
    migrationDb.exec('BEGIN'); migrationDb.exec(migration); migrationDb.exec('COMMIT');
    const after = migrationDb.prepare('SELECT * FROM import_bundle_manifest ORDER BY id').all();
    for (let i=0;i<before.length;i++) {
      for (const key of Object.keys(before[i])) assertEqual(after[i][key],before[i][key],`preserve ${key}`);
      assertEqual(after[i].identity_version,1); assertEqual(after[i].raw_destroyed_at,null);
    }
    assertEqual(JSON.stringify(migrationDb.prepare("SELECT name,sql FROM sqlite_master WHERE type='index' AND tbl_name='import_bundle_manifest' ORDER BY name").all()),JSON.stringify(indexes));
    for (const state of ['destroying','destroyed']) migrationDb.prepare('UPDATE import_bundle_manifest SET archive_status=? WHERE id=?').run(state,'m0');
    for (const sql of ["UPDATE import_bundle_manifest SET archive_status='invalid' WHERE id='m0'",
      "UPDATE import_bundle_manifest SET normalized_hash='normalized0',status='active' WHERE id='m1'",
      "UPDATE import_bundle_manifest SET account_id='missing' WHERE id='m0'"]) {
      let rejected=false;try {migrationDb.exec(sql);} catch {rejected=true;} assert(rejected,'constraint must reject invalid mutation');
    }
    assertEqual(migrationDb.prepare('PRAGMA foreign_key_check').all().length,0);
  } finally { migrationDb.close(); }
});
await run.check('Canonical normalized/raw bindings reject cross-account keys and missing metadata', async () => {
  await setup();
  const result = await executeBulkImport(scan(), meta('original'));
  const manifest = db.prepare('SELECT * FROM import_bundle_manifest WHERE id=?').get(result.bundle_id);
  const attack = await post('activate', {...manifest,id:'attack',object_key:'rri-bulk/victim/P_B/v1/'+manifest.normalized_hash+'.ndjson.gz'});
  assertEqual(attack.status,403);
  db.prepare('UPDATE import_bundle_manifest SET object_key=? WHERE id=?').run('rri-bulk/victim/key',manifest.id);
  assertEqual((await fetch(`/api/bulk-import/bundle/${manifest.id}`)).status,403);
  assertEqual((await post('delete',{bundle_id:manifest.id})).status,403);
  getMockStore().get(manifest.raw_object_key).customMetadata = {};
  assertEqual((await fetch(`/api/bulk-import/raw/${manifest.id}`)).status,403);
});
await run.check('Each missing R2 binding fails closed', async () => {
  await setup();
  for (const name of ['RAW_ARCHIVE','BULK_DATA']) {
    const binding = env[name]; delete env[name];
    assertEqual((await post('raw-check',{server_property_id:'P_A',raw_file_hash:'a'.repeat(64)})).status,503);
    env[name] = binding;
  }
  assertEqual(db.prepare('SELECT COUNT(*) n FROM import_bundle_manifest').get().n,0);
});
await run.check('Stable identity, duplicate retry and atomic correction keep exactly one active version', async () => {
  await setup();
  const first = await executeBulkImport(scan(),meta('v1'));
  const a = buildNormalizedBundle(scan(),meta('v1'),'random-a');
  const b = buildNormalizedBundle(scan(),meta('v1'),'random-b');
  const hash = bundle => contentHash(normalizedContent(bundle.ndjson.split('\n').map(line => JSON.parse(line))));
  assertEqual(await hash(a),await hash(b));
  await executeBulkImport(scan(),{...meta('v1'),forceImport:true});
  assertEqual(db.prepare("SELECT COUNT(*) n FROM import_bundle_manifest WHERE status='active'").get().n,1);
  const correction = await executeBulkImport(scan(125),{...meta('v2'),forceImport:true});
  assertEqual(db.prepare('SELECT status FROM import_bundle_manifest WHERE id=?').get(first.bundle_id).status,'superseded');
  assertEqual(db.prepare("SELECT COUNT(*) n FROM import_bundle_manifest WHERE status='active'").get().n,1);
  assertEqual((await localDb.PaymentDay.toArray())[0].total,125);
  assertEqual((await post('supersede',{old_bundle_id:correction.bundle_id,new_bundle_id:first.bundle_id,expected_revision:2})).status,409);
});
await run.check('Parser correction reuses immutable source while creating new analytics version', async () => {
  await setup();
  const first = await executeBulkImport(scan(),meta('unchanged source'));
  const second = await executeBulkImport(scan(120),{...meta('unchanged source'),forceImport:true});
  assert(first.bundle_id !== second.bundle_id);
  assertEqual(db.prepare("SELECT COUNT(*) n FROM import_bundle_manifest WHERE status='active'").get().n,1);
  const rows = db.prepare('SELECT raw_object_key FROM import_bundle_manifest').all();
  assertEqual(new Set(rows.map(row=>row.raw_object_key)).size,1);
  assertEqual((await localDb.PaymentDay.toArray())[0].total,120);
});
await run.check('Same-source concurrent retries and cross-property lineage fail safely', async () => {
  await setup();
  const outputs = await Promise.all([executeBulkImport(scan(),meta('same')),executeBulkImport(scan(),meta('same'))]);
  assertEqual(new Set(outputs.map(row=>row.bundle_id)).size,1);
  assertEqual(db.prepare("SELECT COUNT(*) n FROM import_bundle_manifest WHERE status='active'").get().n,1);
  const other = await executeBulkImport(scan(),{...meta('other'),propertyId:'P_B'});
  const old = db.prepare('SELECT * FROM import_bundle_manifest WHERE id=?').get(outputs[0].bundle_id);
  assertEqual((await post('supersede',{old_bundle_id:old.id,new_bundle_id:other.bundle_id,expected_revision:old.revision})).status,409);
});
await run.check('Generic R2 deletion failure stays retryable rather than labeled bucket lock', async () => {
  await setup(); const result = await executeBulkImport(scan(),meta('storage-error'));
  const originalDelete = env.RAW_ARCHIVE.delete.bind(env.RAW_ARCHIVE);
  for (const message of ['Network unavailable','Service could not inspect ObjectLockedByBucketPolicy metadata']) {
    env.RAW_ARCHIVE.delete = async () => { throw new Error(message); };
    const response = await post('raw-destroy',{archive_id:result.bundle_id,confirm_destroy:true});
    assertEqual(response.status,503); assertEqual((await response.json()).code,'RAW_DESTRUCTION_PENDING');
    assertEqual(db.prepare('SELECT archive_status FROM import_bundle_manifest WHERE id=?').get(result.bundle_id).archive_status,'destroying');
  }
  env.RAW_ARCHIVE.delete = async key => { await originalDelete(key); throw new Error('Response lost after deletion'); };
  assertEqual((await post('raw-destroy',{archive_id:result.bundle_id,confirm_destroy:true})).status,503);
  env.RAW_ARCHIVE.delete = originalDelete;
  assertEqual((await post('raw-destroy',{archive_id:result.bundle_id,confirm_destroy:true})).status,200);
  assertEqual(db.prepare('SELECT archive_status FROM import_bundle_manifest WHERE id=?').get(result.bundle_id).archive_status,'destroyed');
});
await run.check('Resume activates original pending manifest without uploading raw again', async () => {
  await setup();
  const bytes = new TextEncoder().encode('Date,Total\n2026-09-01,100');
  const hash = await sha256Hex(bytes);
  await fetch('/api/bulk-import/raw-upload',{method:'PUT',headers:{'x-server-property-id':'P_A','x-raw-hash':hash,'x-archive-id':'pending'},body:bytes});
  await post('raw-archive',{id:'pending',raw_archive_id:'pending',server_property_id:'P_A',raw_file_hash:hash,original_file_name:'report.csv'});
  const pending = db.prepare('SELECT * FROM import_bundle_manifest WHERE id=?').get('pending');
  const originalPut = env.RAW_ARCHIVE.put; env.RAW_ARCHIVE.put = async () => { throw new Error('Resume re-uploaded raw'); };
  const result = await executeBulkImport(scan(),{...meta('unused'),rawBytes:bytes,resumeManifest:pending,forceImport:true});
  env.RAW_ARCHIVE.put = originalPut;
  assertEqual(result.bundle_id,'pending');
  assertEqual(db.prepare('SELECT COUNT(*) n FROM import_bundle_manifest').get().n,1);
});
await run.check('Hydration errors preserve cursor and existing data', async () => {
  await setup();
  const result = await executeBulkImport(scan(),meta('hydration'));
  const manifest = db.prepare('SELECT * FROM import_bundle_manifest WHERE id=?').get(result.bundle_id);
  const key = manifest.object_key, original = getMockStore().get(key);
  for (const bad of ['bad gzip','invalid json','partial']) {
    await localDb.BusinessSyncState.clear(); await localDb.PaymentDay.clear();
    const data = bad === 'bad gzip' ? new TextEncoder().encode('bad') : await compressPayloadGzip(bad === 'invalid json' ? '{' : JSON.stringify({entity:'PaymentDay',row:{property_id:'P_A',total:999}}));
    getMockStore().set(key,{...original,data});
    let rejected=false; try { await syncBulkBundles({propertyId:'P_A'}); } catch { rejected=true; }
    assert(rejected,bad+' must reject'); assertEqual(await getLastBulkRevision('P_A'),0); assertEqual(await localDb.PaymentDay.count(),0);
  }
  getMockStore().set(key,original);
  const originalGet = env.BULK_DATA.get; env.BULK_DATA.get = async () => null;
  let rejected=false; try { await syncBulkBundles({propertyId:'P_A'}); } catch { rejected=true; }
  assert(rejected); assertEqual(await getLastBulkRevision('P_A'),0);
  env.BULK_DATA.get = originalGet;
  await syncBulkBundles({propertyId:'P_A'}); assertEqual(await localDb.PaymentDay.count(),1);
});
await run.check('Raw deletion survives D1 completion failure without changing analytics authority', async () => {
  await setup();
  const result = await executeBulkImport(scan(),meta('destroy'));
  const manifest = db.prepare('SELECT * FROM import_bundle_manifest WHERE id=?').get(result.bundle_id);
  const prepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = sql => {
    if (sql.includes("SET archive_status='destroyed'")) throw new Error('Injected D1 failure');
    return prepare(sql);
  };
  let rejected=false; try { await post('raw-destroy',{archive_id:manifest.id,confirm_destroy:true}); } catch { rejected=true; }
  assert(rejected); assert(!getMockStore().has(manifest.raw_object_key));
  assertEqual(db.prepare('SELECT archive_status FROM import_bundle_manifest WHERE id=?').get(manifest.id).archive_status,'destroying');
  env.DB.prepare = prepare;
  assertEqual((await post('raw-destroy',{archive_id:manifest.id,confirm_destroy:true})).status,200);
  const after = db.prepare('SELECT * FROM import_bundle_manifest WHERE id=?').get(manifest.id);
  assertEqual(after.status,'active'); assertEqual(after.archive_status,'destroyed'); assertEqual(after.revision,manifest.revision);
  assertEqual((await fetch(`/api/bulk-import/bundle/${manifest.id}`)).status,200);
});
await run.check('Overlap re-checked at transaction time; interleaved activate cannot bypass', async () => {
  await setup();
  const originalPrepare = env.DB.prepare.bind(env.DB);
  let armed = false;
  env.DB.prepare = (sql) => {
    const stmt = originalPrepare(sql);
    const originalBind = stmt.bind.bind(stmt);
    stmt.bind = (...args) => {
      const bound = originalBind(...args);
      const originalFirst = bound.first.bind(bound);
      bound.first = async () => {
        const isOverlap = sql.startsWith('SELECT id FROM import_bundle_manifest') && sql.includes('id<>?');
        const oldResult = await originalFirst();
        if (isOverlap && armed) {
          armed = false;
          await executeBulkImport(scan(200, '2026-09-01'), meta('a-overlap-b'));
        }
        return oldResult;
      };
      return bound;
    };
    return stmt;
  };
  armed = true;
  let rejected = false;
  try { await executeBulkImport(scan(100, '2026-09-01'), meta('a-overlap-a')); } catch { rejected = true; }
  env.DB.prepare = originalPrepare;
  assert(rejected, 'A must fail closed against concurrent overlapping B');
  const active = db.prepare("SELECT * FROM import_bundle_manifest WHERE status='active'").all();
  assertEqual(active.length, 1, 'exactly one active bundle remains');
  assertEqual(active[0].raw_file_hash, await sha256Hex(new TextEncoder().encode('a-overlap-b')), 'B (the overlapping commit) is the surviving active');
  assertEqual(db.prepare('SELECT revision FROM business_sync_state WHERE account_id=?').get('A_1').revision, 1, 'exactly one revision allocated');
  assertEqual(db.prepare('SELECT COUNT(*) n FROM business_change').get().n, 1, 'exactly one change event persisted');
  assertEqual(db.prepare("SELECT status FROM import_bundle_manifest WHERE raw_file_hash=?").get(await sha256Hex(new TextEncoder().encode('a-overlap-a'))).status, 'raw_archived', 'A stays raw_archived, never active');
  let guardOk = true;
  for (const row of db.prepare('SELECT ok FROM business_mutation_guard').all()) if (!row.ok) guardOk = false;
  assert(guardOk, 'no failed activation guard row persisted');
});
await run.check('R2 retention lock code 10069 / ObjectLockedByBucketPolicy is recognized', async () => {
  const lockCases = [
    { factory: () => Object.assign(new Error('bucket policy lock'), { code: 10069 }) },
    { factory: () => Object.assign(new Error('bucket policy lock'), { code: '10069' }) },
    { factory: () => Object.assign(new Error('bucket policy lock'), { code: 'ObjectLockedByBucketPolicy' }) },
    { factory: () => ({ message: 'ObjectLockedByBucketPolicy: object retained' }) },
    { factory: () => new Error('R2 delete failed: Object locked (10069)') },
  ];
  for (const { factory } of lockCases) {
    await setup(); const result = await executeBulkImport(scan(), meta('lock-code'));
    env.RAW_ARCHIVE.delete = async () => { throw factory(); };
    const response = await post('raw-destroy', { archive_id: result.bundle_id, confirm_destroy: true });
    assertEqual(response.status, 423, 'retention lock must yield 423');
    assertEqual((await response.json()).code, 'RAW_ARCHIVE_LOCKED', 'lock must be labeled, not pending');
  }
});
await run.check('Concurrent distinct activation retries allocate distinct revisions', async () => {
  await setup();
  const outputs = await Promise.all([executeBulkImport(scan(100,'2026-09-01'),meta('concurrent-1')),executeBulkImport(scan(200,'2026-09-02'),meta('concurrent-2'))]);
  assertEqual(new Set(outputs.map(row => row.revision)).size,2);
  assertEqual(db.prepare("SELECT COUNT(*) n FROM import_bundle_manifest WHERE status='active'").get().n,2);
});
await run.check('CSV, XLS and XLSX original bytes parse and resume the same manifest', async () => {
  const { scanReport } = await import('../src/lib/reportParsers.js');
  const XLSX = await import('xlsx');
  const grid = [['Date','Total Sold Rooms','Total Rooms','Room Revenue'],['2026-09-01',50,100,5000]];
  for (const extension of ['csv','xls','xlsx']) {
    await setup();
    const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet(grid),'Report');
    const bytes = extension === 'csv' ? new TextEncoder().encode(grid.map(row => row.join(',')).join('\n'))
      : new Uint8Array(XLSX.write(book,{type:'array',bookType:extension === 'xls' ? 'biff8' : 'xlsx'}));
    const hash = await sha256Hex(bytes);
    await fetch('/api/bulk-import/raw-upload',{method:'PUT',headers:{'x-server-property-id':'P_A','x-raw-hash':hash},body:bytes});
    await post('raw-archive',{id:'format',raw_archive_id:'format',server_property_id:'P_A',raw_file_hash:hash,report_type:'occupancy',original_file_name:`report.${extension}`});
    const pending = db.prepare('SELECT * FROM import_bundle_manifest WHERE id=?').get('format');
    const download = await fetch('/api/bulk-import/raw/format'); const rawBytes = await download.arrayBuffer();
    const scanResult = await scanReport('occupancy','',{propertyId:'P_A',sourceFile:`report.${extension}`,rawBytes,
      csvText:extension==='csv'?new TextDecoder().decode(rawBytes):null});
    assertEqual(scanResult.rowsToImport.length,1,extension+' parsed rows');
    const result = await executeBulkImport(scanResult,{propertyId:'P_A',sourceFile:`report.${extension}`,rawBytes,resumeManifest:pending,forceImport:true});
    assertEqual(result.bundle_id,'format'); assertEqual(await localDb.OccupancyDay.count(),1);
    assertEqual(db.prepare('SELECT COUNT(*) n FROM import_bundle_manifest').get().n,1);
  }
});
await run.check('Legacy cache overlap is reconciled and bulk-only reset prevents resurrection', async () => {
  await setup();
  await localDb.PaymentDay.put({id:17,property_id:'P_A',date:'2026-09-01',total:100});
  await executeBulkImport(scan(),meta('reconcile'));
  assertEqual(await localDb.PaymentDay.count(),1);
  const { handleBusinessSyncRequest } = await import('../worker/business-sync.js');
  const request = new Request('http://localhost/api/business-sync/reset',{method:'POST',body:JSON.stringify({property_id:'P_A',entities:['PaymentDay']})});
  const response = await handleBusinessSyncRequest(request,env,scope,new URL(request.url),['api','business-sync','reset']);
  assertEqual(response.status,200);
  assertEqual(db.prepare("SELECT COUNT(*) n FROM import_bundle_manifest WHERE status='active'").get().n,0);
  await syncBulkBundles({force:true,propertyId:'P_A'});
  assertEqual(await localDb.PaymentDay.count(),0);
  assert([...getMockStore().keys()].some(key=>key.startsWith('rri-raw/')),'Reset retains raw source');
});
await run.check('Older all-property hydration cannot resurrect a newer property tombstone', async () => {
  await setup();
  const result = await executeBulkImport(scan(), meta('stale-hydration'));
  const routeFetch = globalThis.fetch;
  let release, started;
  const paused = new Promise(resolve => { started = resolve; });
  const resume = new Promise(resolve => { release = resolve; });
  let armed = true;
  globalThis.fetch = async (...args) => {
    const response = await routeFetch(...args);
    if (armed && String(args[0]).includes('/bundle/')) {
      armed = false;
      const bytes = await response.arrayBuffer();
      started();
      await resume;
      return new Response(bytes, {status: response.status, headers: response.headers});
    }
    return response;
  };
  const older = syncBulkBundles({force:true});
  try {
    await paused;
    assertEqual((await post('delete',{bundle_id:result.bundle_id})).status,200);
    await syncBulkBundles({force:true,propertyId:'P_A'});
    const newerRevision = await getLastBulkRevision('P_A');
    assertEqual(await localDb.PaymentDay.count(),0);
    release();
    await older;
    assertEqual(await localDb.PaymentDay.count(),0,'stale active payload must not resurrect rows');
    assertEqual(await localDb.UploadedReport.count(),0,'stale history must not return');
    assertEqual(await getLastBulkRevision('P_A'),newerRevision);
    assertEqual(await getLastBulkRevision(),newerRevision);
  } finally { release(); await older.catch(()=>{}); globalThis.fetch = routeFetch; }
});
await run.check('Real HTTP delivers opaque gzip exactly once', async () => {
  await setup();
  const result = await executeBulkImport(scan(),meta('http'));
  const { createServer } = await import('node:http');
  const server = createServer(async (req,res) => {
    const response = await fetch(`/api/bulk-import/bundle/${result.bundle_id}`);
    res.writeHead(response.status,Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const response = await nativeFetch(`http://127.0.0.1:${server.address().port}`);
    assertEqual(response.headers.get('content-encoding'),null);
    const bytes = new Uint8Array(await response.arrayBuffer());
    assertEqual(bytes[0],31); assertEqual(bytes[1],139);
    const { decompressPayloadGzip } = await import('../src/lib/bulkImportPipeline.js');
    assert(JSON.parse(await decompressPayloadGzip(bytes)).row.total===100);
  } finally { await new Promise(resolve=>server.close(resolve)); }
});
await localDb.delete(); if(db) db.close();
run.done();
if(process.exitCode) process.exit(1);
console.log('PASSED: production-schema integrity and real pipeline regressions');

process.exit(0);
