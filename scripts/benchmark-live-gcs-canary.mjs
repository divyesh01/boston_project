import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createCredential } from '../worker/password-credential.js';
import { CanaryClient } from './canary/canary-client.mjs';

const WORKER = 'rri-bulk-canary-a61a110';
const TARGET = 'https://rri-bulk-canary-a61a110.divyesh-boston.workers.dev';
const DB = 'rri-bulk-canary-a61a110';
const DB_ID = '7e746318-2280-4907-931d-9c257b62ee78';
const PROD_DB = 'e9008126-d4b4-4588-841c-128eadd94c8d';
const PREVIEW = `rri-auth-bench-${crypto.randomBytes(5).toString('hex')}`;
const ROOT = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rri-gcs-bench-'));
const q = (v) => `'${String(v).replaceAll("'", "''")}'`;
const now = () => new Date().toISOString();
const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');
const wrangler = (args, input = '') => execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['wrangler', ...args], { cwd: ROOT, input, encoding: 'utf8', shell: process.platform === 'win32', env: { ...process.env, CI: '1' }, stdio: 'pipe' });
function d1(sql) { const f = path.join(tmp, `${crypto.randomBytes(5).toString('hex')}.sql`); fs.writeFileSync(f, sql); return wrangler(['d1','execute',DB,'--remote',`--file=${f}`,'--json']); }
function parseWranglerJson(output) {
  const start = output.indexOf('[');
  if (start < 0) throw new Error(`Wrangler JSON response missing: ${output.slice(-240)}`);
  return JSON.parse(output.slice(start));
}
function assertCanary() {
  if (!TARGET.includes('rri-bulk-canary-a61a110') || TARGET.includes('boston-project.divyesh') || DB_ID === PROD_DB || WORKER !== 'rri-bulk-canary-a61a110') throw new Error('CANARY GUARD FAILED');
}
async function login(email, password) {
  // The local Wrangler preview rewrites the request URL while preserving the
  // same-origin mutation guard. Omitting Origin exercises the guard's explicit
  // same-origin allowance without changing Worker authentication code.
  const r = await fetch(`${PREVIEW_URL}/api/auth/login`, { method:'POST', headers:{'content-type':'application/json','x-requested-with':'XMLHttpRequest'}, body:JSON.stringify({identifier:email,password}) });
  const responseText = await r.text();
  if (r.status !== 200) throw new Error(`login HTTP ${r.status} body=${responseText.replace(/\s+/g, ' ').slice(0, 240)}`);
  const c = (r.headers.get('set-cookie') || '').match(/(__Host-rri_session=[^;]+)/);
  if (!c) throw new Error('login did not return session cookie');
  return c[1];
}
function runCanary(account, property, cookie) {
  return new Promise((resolve) => {
    const started = performance.now();
    const reportFile = path.join(tmp, `report-${crypto.randomBytes(5).toString('hex')}.json`);
    // Matrix workers exercise one complete non-overlapping workflow. The
    // harness's separate concurrency stage intentionally creates overlap
    // control cases, so it is measured independently rather than mixed into
    // this workflow-latency matrix.
    const child = spawn('node', ['scripts/canary-bulk-import.mjs','--smoke','--import','--hydration','--large','--cleanup','--json',`--output=${reportFile}`], { cwd:ROOT, env:{...process.env,CANARY_CONFIRM_ISOLATED:'YES',CANARY_ACCOUNT_ID:account,CANARY_PROPERTY_ID:property,CANARY_AUTH_COOKIE:cookie}, stdio:['ignore','pipe','pipe'] });
    let out=''; child.stdout.on('data', b => { out += b; }); child.stderr.on('data', b => { out += b; });
    const timer = setTimeout(() => child.kill(), 300000);
    child.on('close', code => { clearTimeout(timer); let report = null; try { report = JSON.parse(fs.readFileSync(reportFile, 'utf8')); } catch {} resolve({ account, code, ms:performance.now()-started, report, output:out.slice(-30000) }); });
  });
}
let PREVIEW_URL = '';
let fixture = [];
let cookies = new Map();
let previewProcess = null;
async function startPreview(configFile, secretsFile) {
  const port = 8700 + crypto.randomInt(0, 200);
  const npxCli = process.platform === 'win32' ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node_modules', 'npm', 'bin', 'npx-cli.js') : 'npx';
  previewProcess = spawn(process.execPath, [npxCli, 'wrangler', 'dev', '--remote', '--config', configFile, '--env-file', secretsFile, '--port', String(port), '--ip', '127.0.0.1', '--show-interactive-dev-session', 'false'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = '';
  for (const stream of [previewProcess.stdout, previewProcess.stderr]) stream.on('data', (b) => { output += b.toString(); });
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (previewProcess.exitCode !== null) throw new Error(`temporary preview exited: ${output.replace(/\s+/g, ' ').slice(-500)}`);
    try { await fetch(`${url}/api`, { signal: AbortSignal.timeout(1500) }); PREVIEW_URL = url; return; } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  throw new Error(`temporary preview did not become ready: ${output.replace(/\s+/g, ' ').slice(-500)}`);
}
async function cleanupFixtures() {
  for (const f of fixture) {
    try { d1(`DELETE FROM account WHERE id=${q(f.account)};`); }
    catch (e) { console.error(`fixture cleanup failed for synthetic account ${f.account}: ${String(e.message || e).replace(/\s+/g, ' ').slice(0, 240)}`); }
  }
}
async function sweepRawArchives(f, result) {
  const remaining = result.report?.stages?.cleanup?.details?.remainingKeys || [];
  if (!remaining.length) return { attempted: 0, deleted: 0 };
  d1(`UPDATE user SET role='owner' WHERE id=${q(f.user)};`);
  try {
    let ownerCookie;
    for (let attempt = 0; attempt < 3 && !ownerCookie; attempt++) {
      try { ownerCookie = await login(f.email, f.password); } catch (error) { if (attempt === 2) throw error; await new Promise((r) => setTimeout(r, 750 * (attempt + 1))); }
    }
    const client = new CanaryClient({ baseUrl: TARGET, accountId: f.account, propertyId: f.property, authCookie: ownerCookie });
    let deleted = 0;
    for (const archiveId of remaining) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try { const response = await client.destroyRawArchive({ archiveId }); if (response?.ok !== false) deleted++; break; } catch (error) { if (attempt === 2) break; await new Promise((r) => setTimeout(r, 500 * (attempt + 1))); }
      }
    }
    return { attempted: remaining.length, deleted };
  } catch (error) {
    return { attempted: remaining.length, deleted: 0, error: String(error.message || error).replace(/\s+/g, ' ').slice(0, 240) };
  } finally { d1(`UPDATE user SET role='manager' WHERE id=${q(f.user)};`); }
}
async function main() {
  assertCanary();
  const pepper = crypto.randomBytes(48).toString('base64url');
  fixture = [];
  const sql = [];
  for (let i=0;i<40;i++) {
    const run = `bench-${Date.now()}-${i}-${crypto.randomBytes(5).toString('hex')}`;
    const account = `acct-${run}`, user = `user-${run}`, email = `bench-${run}@example.com`, password = crypto.randomBytes(24).toString('base64url')+'Aa9!';
    const c = await createCredential(password, pepper); const t=now();
    sql.push(`INSERT INTO account(id,name,created_date) VALUES(${q(account)},${q(run)},${q(t)});`);
    const property = `canary-prop-${i}-${crypto.randomBytes(3).toString('hex')}`;
    sql.push(`INSERT INTO property(id,account_id,code,name,rooms,active,created_date) VALUES(${q(property)},${q(account)},${q(property)},'Benchmark Property',100,1,${q(t)});`);
    sql.push(`INSERT INTO user(id,account_id,username,email,role,property_access_mode,permissions,is_active,is_locked,must_change_password,password_hash,salt,created_date,updated_date) VALUES(${q(user)},${q(account)},${q(email)},${q(email)},'manager','specific','{"import_reports":true}',1,0,0,${q(c.encoded)},${q(c.salt)},${q(t)},${q(t)});`);
    sql.push(`INSERT INTO user_property_access(account_id,user_id,property_id) VALUES(${q(account)},${q(user)},${q(property)});`);
    sql.push(`INSERT INTO business_sync_state(account_id,revision) VALUES(${q(account)},0);`);
    fixture.push({account,user,email,password,property,initialRevision:0,manifestId:null});
  }
  d1(sql.join('\n'));
  const config = { $schema:'./node_modules/wrangler/config-schema.json', name:PREVIEW, main:path.join(ROOT,'worker','index.js'), compatibility_date:'2026-08-31', preview_urls:false, workers_dev:true, d1_databases:[{binding:'DB',database_name:DB,database_id:DB_ID}], vars:{ENVIRONMENT:'canary',ENABLE_D1_DATA_API:'false',ENABLE_BUSINESS_SYNC_API:'true'}, secrets:{required:['PASSWORD_PEPPER_V1']} };
  const configFile=path.join(tmp,'preview.jsonc'), secretsFile=path.join(tmp,'secrets.txt'); fs.writeFileSync(configFile,JSON.stringify(config)); fs.writeFileSync(secretsFile,`PASSWORD_PEPPER_V1=${pepper}\n`);
  await startPreview(configFile, secretsFile);
  const loggedIn = await Promise.all(fixture.map(async (f) => [f.account, await login(f.email, f.password)]));
  cookies = new Map(loggedIn);
  console.error(`AUTH_FIXTURE_PASS accounts=${cookies.size}`);
  const levels=[2,5,10,20], starts=[0,2,7,17], matrix={};
  for (let i=0;i<levels.length;i++) {
    const n = levels[i], cohort = fixture.slice(starts[i], starts[i]+n);
    assert(cohort.length === n && cohort.every((f) => f.initialRevision === 0 && !f.manifestId), `fresh cohort fixture assertion failed for cohort ${n}`);
    console.error(`WORKFLOW_MATRIX_START concurrency=${n}`);
    const results=await Promise.all(cohort.map(f=>runCanary(f.account,f.property,cookies.get(f.account))));
    for (const result of results) { const f = fixture.find((x) => x.account === result.account); if (f) result.rawSweep = await sweepRawArchives(f, result); }
    const durations=results.map(x=>x.ms).sort((a,b)=>a-b);
    matrix[n]={attempts:n,successes:results.filter(x=>x.code===0).length,failures:results.filter(x=>x.code!==0).length,p50:durations[Math.floor(durations.length*.5)],p95:durations[Math.floor(durations.length*.95)],max:durations.at(-1),results};
    console.error(`WORKFLOW_MATRIX_DONE concurrency=${n} successes=${matrix[n].successes} failures=${matrix[n].failures}`);
  }
  const soakDuration = Number(process.env.BENCHMARK_SOAK_MS ?? 600000);
  const soakStart=Date.now(); const soak=[]; while(Date.now()-soakStart<soakDuration){ const f=fixture[0], t=Date.now(); const r=await fetch(`${TARGET}/api/bulk-import/manifest?server_property_id=${encodeURIComponent(f.property)}`,{headers:{cookie:cookies.get(f.account)}}); soak.push({status:r.status,ms:Date.now()-t}); await new Promise(x=>setTimeout(x,1000)); }
  console.log(JSON.stringify({target:TARGET,d1:DB_ID,matrix,soak:{durationMs:Date.now()-soakStart,requests:soak.length,statuses:Object.fromEntries([...new Set(soak.map(x=>x.status))].map(s=>[s,soak.filter(x=>x.status===s).length]))}},null,2));
}
try { await main(); } finally {
  await cleanupFixtures();
  if (previewProcess && previewProcess.exitCode === null) {
    try {
      if (process.platform === 'win32') execFileSync('C:\\Windows\\System32\\taskkill.exe', ['/pid', String(previewProcess.pid), '/t', '/f'], { stdio: 'ignore' });
      else previewProcess.kill('SIGTERM');
    } catch {}
  }
  fs.rmSync(tmp,{recursive:true,force:true});
}
