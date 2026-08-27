/**
 * IMPACT (read-only, NO engine edits): quantify the owner-facing money change if
 * net_revenue is reinterpreted as POST-COMMISSION NET and the channel engines are
 * grossed up (gross = net/(1-rate), commission = gross - net) to match
 * ChannelRevenue.jsx, instead of the current net_revenue-AS-gross model
 * (gross = net_revenue, commission = gross*rate).
 *
 * Loads the REAL checked-in Source Summary fixtures (scripts/data/) exactly as
 * verify-source-contributions.mjs does, then reports, per channel and in total:
 *   - OLD commission (current model)  vs  NEW commission (gross-up model)
 *   - the delta, which is exactly the additional amount deducted from "Money Kept"
 * Only PERCENTAGE channels move; fixed/actual/none are unchanged (proven inline).
 *
 * RUN: node --import ./scripts/_loader-boot.mjs scripts/probe-netrev-grossup-impact.mjs
 */

await import("fake-indexeddb/auto");
globalThis.crypto ??= (await import("node:crypto")).webcrypto;
const __s = new Map();
const st = { getItem:k=>__s.has(k)?__s.get(k):null, setItem:(k,v)=>__s.set(k,String(v)), removeItem:k=>__s.delete(k), clear:()=>__s.clear() };
globalThis.localStorage = st; globalThis.sessionStorage = st; globalThis.window = globalThis;
if (globalThis.navigator === undefined) Object.defineProperty(globalThis,'navigator',{value:{userAgent:'harness',language:'en-US'},configurable:true});

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), "data");
const UP = process.env.UPLOADS_DIR || REPO_DATA;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, ...rest) => {
  if (typeof url === "string" && url.startsWith("file:///")) {
    let p = decodeURIComponent(url.replace("file:///", "/"));
    if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
    return new Response(fs.readFileSync(p, "utf8"), { status: 200 });
  }
  return realFetch(url, ...rest);
};

const mod = await import("@/lib/reportParsers.js");
const localDb = (await import("@/api/localDb")).default;
const { commissionFor } = await import("@/lib/hotel");
const { toCents, fromCents } = await import("@/lib/decimal");
const { signInAsAllPropertyOwner } = await import("./_harness-auth.mjs");
await signInAsAllPropertyOwner();

const PROP = { propertyId:"p1", propertyName:"RRI1416 - Red Roof Inn & Suites Middleborough" };
const order = ["Source Summary (1).csv","Source Summary (2).csv","Source Summary (3).csv","Source Summary.csv"];
for (const f of order) {
  const url = "file:///" + path.join(UP, f).replace(/^\//,"");
  const scan = await mod.scanReport("source", url, { ...PROP, sourceFile:f });
  await mod.importReport(scan, { ...PROP, importId:"imp_"+f, sourceFile:f });
}

const rows = await localDb.SourceDay.toArray();

// Aggregate net_revenue (cents) + stays per channel, exactly like the engines key it.
const byChannel = new Map();
for (const r of rows) {
  const key = r.source || r.code || "UNKNOWN";
  const cur = byChannel.get(key) || { source: key, netCents: 0, stays: 0 };
  cur.netCents += toCents(r.net_revenue);
  cur.stays += Number(r.stays) || 0;
  byChannel.set(key, cur);
}

const money = (c) => "$" + fromCents(c).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

let oldCommTotal = 0, newCommTotal = 0, netTotal = 0;
const lines = [];
for (const c of [...byChannel.values()].sort((a,b) => b.netCents - a.netCents)) {
  const info = commissionFor(c.source);
  const net = c.netCents;
  netTotal += net;
  let oldComm = 0, newComm = 0, grossNew = net;
  if (info.type === "percentage" && info.rate > 0) {
    oldComm = Math.round(net * info.rate);                 // net_revenue AS gross
    grossNew = Math.round(net / (1 - info.rate));          // gross-up
    newComm = grossNew - net;
  } else if (info.type === "fixed") {
    oldComm = toCents(info.rate) * c.stays;                // per-stay: unchanged
    newComm = oldComm;
    grossNew = net + newComm;
  } else if (info.type === "actual") {
    oldComm = toCents(info.rate); newComm = oldComm;        // flat: unchanged
    grossNew = net + newComm;
  }
  oldCommTotal += oldComm;
  newCommTotal += newComm;
  if (net > 0 || oldComm > 0) {
    lines.push({
      source: c.source,
      type: info.type,
      rate: info.type === "percentage" ? (info.rate * 100).toFixed(1) + "%" : info.type,
      net: money(net),
      commOld: money(oldComm),
      commNew: money(newComm),
      delta: money(newComm - oldComm),
    });
  }
}

console.log("\nPer-channel commission: CURRENT (net_revenue as gross) vs NEW (gross-up)\n");
console.log("Channel".padEnd(30), "Rate".padStart(6), "net_revenue".padStart(14), "Comm OLD".padStart(13), "Comm NEW".padStart(13), "Δ".padStart(12));
for (const l of lines) {
  console.log(l.source.padEnd(30), l.rate.padStart(6), l.net.padStart(14), l.commOld.padStart(13), l.commNew.padStart(13), l.delta.padStart(12));
}

console.log("\n── TOTALS ────────────────────────────────────────────────");
console.log("SourceDay rows                :", rows.length);
console.log("Total net_revenue (all chans) :", money(netTotal));
console.log("Channel commission — CURRENT  :", money(oldCommTotal), "(deducted from Money Kept today)");
console.log("Channel commission — NEW      :", money(newCommTotal), "(gross-up model)");
console.log("Extra commission deducted     :", money(newCommTotal - oldCommTotal));
console.log("=> Money Kept would DROP by   :", money(newCommTotal - oldCommTotal));
console.log("\nNote: only PERCENTAGE channels move (commission rises by 1/(1-rate));");
console.log("fixed and actual commissions are unchanged; the $1,020,598.17 headline");
console.log("revenue (room + ancillary) does NOT use net_revenue and does NOT move.");
console.log("DIAGNOSTIC: no assertions — this script reports the measured impact of two models.");

// The imported app client owns long-lived browser-style handles. All diagnostic
// work is complete and printed, so close Dexie and end the one-shot harness.
localDb.close();
process.exit(0);
