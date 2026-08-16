// End-to-end: import the four Source Summary files into ONE database, in the
// order the operator did, and assert what the history row would now say.
await import("fake-indexeddb/auto");
globalThis.crypto ??= (await import("node:crypto")).webcrypto;
const __s = new Map();
const st = { getItem:k=>__s.has(k)?__s.get(k):null, setItem:(k,v)=>__s.set(k,String(v)), removeItem:k=>__s.delete(k), clear:()=>__s.clear() };
globalThis.localStorage = st; globalThis.sessionStorage = st; globalThis.window = globalThis;
if (globalThis.navigator === undefined) Object.defineProperty(globalThis,'navigator',{value:{userAgent:'harness',language:'en-US'},configurable:true});

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Fixture directory, in order: UPLOADS_DIR env → the repo's own scripts/data.
//
// This used to default to an absolute path inside a since-deleted sandbox
// session, so the suite died with EACCES on every machine but the one it was
// written on. scripts/data/ is checked in and holds the same exports.
const REPO_DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), "data");
const UP = process.env.UPLOADS_DIR || REPO_DATA;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, ...rest) => {
  if (typeof url === "string" && url.startsWith("file:///")) {
    const p = decodeURIComponent(url.replace("file:///", "/"));
    return new Response(fs.readFileSync(p, "utf8"), { status: 200 });
  }
  return realFetch(url, ...rest);
};

const mod = await import("@/lib/reportParsers.js");
const localDb = (await import("@/api/localDb")).default;
// db.entities fails closed for an unauthenticated caller (blocker B3), so the
// suite has to sign in before it reads or writes a single row.
const { signInAsAllPropertyOwner } = await import("./_harness-auth.mjs");
await signInAsAllPropertyOwner();

let pass=0, fail=0;
const ok = (c,m)=>{ c?pass++:fail++; console.log(`  ${c?'ok  ':'FAIL'} ${m}`); };

const PROP = { propertyId:"p1", propertyName:"RRI1416 - Red Roof Inn & Suites Middleborough" };
const order = ["Source Summary (1).csv","Source Summary (2).csv","Source Summary (3).csv","Source Summary.csv"];
const hist = [];

for (const f of order) {
  const url = "file:///" + path.join(UP, f).replace(/^\//,"");
  const scan = await mod.scanReport("source", url, { ...PROP, sourceFile:f });
  const res  = await mod.importReport(scan, { ...PROP, importId:"imp_"+f, sourceFile:f });
  hist.push({ f, parsed: scan.totalRows, imported: res.count, skipped: res.excluded });
  console.log(`${f.padEnd(24)} parsed=${String(scan.totalRows).padStart(5)} imported=${String(res.count).padStart(5)} skipped=${String(res.excluded).padStart(5)}`);
}

console.log("\n2. history rows now distinguish duplicate-vs-failure");
for (const h of hist) {
  const label = h.imported>0
    ? `${h.imported} rows${h.skipped>0?` · ${h.skipped} already imported`:""}`
    : (h.skipped>0 ? `0 new · all ${h.skipped} already imported`
                   : (h.parsed===0 ? "No rows found" : `0 rows · ${h.parsed} parsed, none stored`));
  console.log(`  ${h.f.padEnd(24)} -> "${label}"`);
  ok(!(h.imported===0 && h.skipped===0 && h.parsed>0), `${h.f}: not silently zero`);
}

console.log("\n3. contribution columns persisted");
const all = await localDb.SourceDay.toArray();
ok(all.length===7918, `SourceDay row count is 7918 (got ${all.length})`);
const occ = all.filter(r=>r.occupancy_contribution!==undefined).length;
const rev = all.filter(r=>r.revpar_contribution!==undefined).length;
ok(occ===all.length, `every row has occupancy_contribution (${occ}/${all.length})`);
ok(rev===all.length, `every row has revpar_contribution (${rev}/${all.length})`);
ok(all.some(r=>Number(r.revpar_contribution)>0), "at least one non-zero revpar_contribution");
ok(all.every(r=>typeof r.revpar_contribution==="number"), "revpar_contribution stored as number, not string");

const jan = all.find(r=>r.date==="2026-01-01" && r.code==="PRP");
ok(jan && jan.revpar_contribution===3.65, `Jan1 PRP revpar_contribution === 3.65 (got ${jan?.revpar_contribution})`);
ok(jan && jan.occupancy_contribution===7, `Jan1 PRP occupancy_contribution === 7 (got ${jan?.occupancy_contribution})`);
ok(jan && jan.net_revenue===364.59, `Jan1 PRP net_revenue === 364.59 (got ${jan?.net_revenue})`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
