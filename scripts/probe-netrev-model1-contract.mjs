/**
 * PROBE (item: net_revenue commission contract). Pins the AUTHORITATIVE model:
 * per-channel `net_revenue` IS the gross booked room revenue, and OTA commission
 * is a COST derived from it (percentage: commission = round(net * rate)), with
 * net kept = gross − commission. This is the contract that reconciles:
 *
 *   sum(net_revenue) == room ledger $1,011,258.67   (probe-netrev-grossup-impact)
 *   documented OTA commission == $50,287.65 == sum(net_revenue * rate)
 *
 * It FAILS if the rejected "Model 2" gross-up is reintroduced anywhere in the
 * contract-owning abstraction hotel.js#grossUpFromNetCents or its consumers —
 * i.e. gross = round(net / (1 - rate)) and commission = gross − net, which
 * over-stated the Middleborough commission to $59,327.68 (+$9,040.03) and
 * double-counted against the room-ledger gross base in Money Kept.
 *
 * The Model-1 vs Model-2 separation is the whole point: a fixture that could not
 * tell $50,287.65 from $59,327.68 would not prove the contract. §1 pins the unit
 * contract; §2 pins it on the REAL checked-in Source Summary fixtures end-to-end
 * through CalculationService; §3 pins the internal reconciliation gross − commission
 * === net so no consumer can carry a mismatched net field again.
 *
 * RUN: node --import ./scripts/_loader-boot.mjs scripts/probe-netrev-model1-contract.mjs
 */

await import("fake-indexeddb/auto");
globalThis.crypto ??= (await import("node:crypto")).webcrypto;
const __s = new Map();
const st = { getItem: (k) => (__s.has(k) ? __s.get(k) : null), setItem: (k, v) => __s.set(k, String(v)), removeItem: (k) => __s.delete(k), clear: () => __s.clear() };
globalThis.localStorage = st; globalThis.sessionStorage = st; globalThis.window = globalThis;
if (globalThis.navigator === undefined) Object.defineProperty(globalThis, "navigator", { value: { userAgent: "harness", language: "en-US" }, configurable: true });

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

let pass = 0, fail = 0;
const failures = [];
function ok(label, cond, detail) {
  if (cond) { pass += 1; }
  else { fail += 1; failures.push(detail ? `${label} — ${detail}` : label); console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
}

const { CalculationService } = await import("@/lib/calculationService");
const { commissionFor, grossUpFromNetCents } = await import("@/lib/hotel");
const { toCents, fromCents, sumCents } = await import("@/lib/decimal");

// PLACEHOLDER_SECTIONS
console.log("--- PROBE: net_revenue = gross booked revenue (Model 1) contract ---");

// ── §1 UNIT: the contract-owning abstraction does NOT gross up ───────────────
console.log("\n[1] grossUpFromNetCents: net_revenue IS gross; commission = round(net * rate)");
{
  const info = { type: "percentage", rate: 0.15 };
  const netCents = toCents(100000); // $100,000 booked on a 15% channel
  const { grossCents, commissionCents } = grossUpFromNetCents(netCents, info, 0);

  ok("gross equals net_revenue (no gross-up)", grossCents === netCents,
    `gross ${grossCents}c vs net ${netCents}c`);
  ok("commission = round(net * rate) = $15,000", commissionCents === Math.round(netCents * 0.15),
    `commission ${commissionCents}c (expected ${Math.round(netCents * 0.15)}c)`);

  // The rejected Model 2 would gross up to round(net / 0.85) and take commission
  // = gross − net. This fixture is chosen so the two models are unmistakably apart.
  const model2Gross = Math.round(netCents / (1 - 0.15));
  const model2Comm = model2Gross - netCents;
  ok("gross is NOT the Model-2 gross-up round(net / (1 - rate))", grossCents !== model2Gross,
    `gross ${grossCents}c must not equal Model-2 ${model2Gross}c`);
  ok("commission is NOT the Model-2 gross − net", commissionCents !== model2Comm,
    `commission ${commissionCents}c must not equal Model-2 ${model2Comm}c`);

  // Fixed and 0% behave as costs on the booked revenue, gross unchanged.
  const fixed = grossUpFromNetCents(toCents(1000), { type: "fixed", rate: 5 }, 10);
  ok("fixed: gross === net_revenue, commission = round(rate * stays)",
    fixed.grossCents === toCents(1000) && fixed.commissionCents === toCents(5) * 10,
    `gross ${fixed.grossCents}c commission ${fixed.commissionCents}c`);
  const zero = grossUpFromNetCents(toCents(1000), { type: "none", rate: 0 }, 3);
  ok("none/0%: gross === net_revenue, commission === 0",
    zero.grossCents === toCents(1000) && zero.commissionCents === 0,
    `gross ${zero.grossCents}c commission ${zero.commissionCents}c`);
}

// ── §2 END-TO-END on the REAL Source Summary fixtures ────────────────────────
console.log("\n[2] CalculationService.calculateChannelMetrics on real fixtures");
{
  const mod = await import("@/lib/reportParsers.js");
  const localDb = (await import("@/api/localDb")).default;
  const { signInAsAllPropertyOwner } = await import("./_harness-auth.mjs");
  await signInAsAllPropertyOwner();

  const PROP = { propertyId: "p1", propertyName: "RRI1416 - Red Roof Inn & Suites Middleborough" };
  const order = ["Source Summary (1).csv", "Source Summary (2).csv", "Source Summary (3).csv", "Source Summary.csv"];
  for (const f of order) {
    const url = "file:///" + path.join(UP, f).replace(/^\//, "");
    const scan = await mod.scanReport("source", url, { ...PROP, sourceFile: f });
    await mod.importReport(scan, { ...PROP, importId: "imp_" + f, sourceFile: f });
  }
  const rows = await localDb.SourceDay.toArray();
  ok("real Source Summary rows were imported", rows.length > 0, `got ${rows.length} rows`);

  const channels = CalculationService.calculateChannelMetrics(rows);
  const grossCentsTotal = sumCents(channels.map((c) => c.gross));
  const commCentsTotal = sumCents(channels.map((c) => c.commission));
  const netRevCentsTotal = sumCents(rows.map((r) => r.net_revenue));

  // Independent Model-1 recompute straight from net_revenue, keyed like the engine.
  const byCh = new Map();
  for (const r of rows) {
    const key = r.source || r.code || "UNKNOWN";
    const cur = byCh.get(key) || { netCents: 0, stays: 0 };
    cur.netCents += toCents(r.net_revenue);
    cur.stays += Number(r.stays) || 0;
    byCh.set(key, cur);
  }
  let m1Comm = 0, m2Comm = 0;
  for (const [key, c] of byCh) {
    const info = commissionFor(key);
    if (info.type === "percentage" && info.rate > 0 && info.rate < 1) {
      m1Comm += Math.round(c.netCents * info.rate);                       // Model 1
      m2Comm += Math.round(c.netCents / (1 - info.rate)) - c.netCents;    // Model 2
    } else if (info.type === "fixed") {
      const f = Math.round(toCents(info.rate) * c.stays); m1Comm += f; m2Comm += f;
    } else if (info.type === "actual") {
      const a = toCents(info.rate); m1Comm += a; m2Comm += a;
    }
  }

  console.log(`  net_revenue total : $${fromCents(netRevCentsTotal).toLocaleString("en-US", { minimumFractionDigits: 2 })}`);
  console.log(`  engine gross total: $${fromCents(grossCentsTotal).toLocaleString("en-US", { minimumFractionDigits: 2 })}`);
  console.log(`  engine commission : $${fromCents(commCentsTotal).toLocaleString("en-US", { minimumFractionDigits: 2 })}  (Model 1 $${fromCents(m1Comm).toLocaleString("en-US", { minimumFractionDigits: 2 })}, Model 2 $${fromCents(m2Comm).toLocaleString("en-US", { minimumFractionDigits: 2 })})`);

  ok("engine gross total === sum(net_revenue) (net_revenue IS gross)",
    grossCentsTotal === netRevCentsTotal,
    `gross ${grossCentsTotal}c vs net_revenue ${netRevCentsTotal}c`);
  ok("engine commission total === independent Model-1 recompute",
    commCentsTotal === m1Comm, `engine ${commCentsTotal}c vs Model-1 ${m1Comm}c`);
  ok("engine commission total is NOT the Model-2 gross-up total",
    commCentsTotal !== m2Comm, `engine ${commCentsTotal}c must not equal Model-2 ${m2Comm}c`);
  ok("net_revenue reconciles to the room ledger $1,011,258.67",
    netRevCentsTotal === toCents(1011258.67), `got $${fromCents(netRevCentsTotal)}`);
  ok("commission reconciles to the documented $50,287.65 (Model 1)",
    commCentsTotal === toCents(50287.65), `got $${fromCents(commCentsTotal)}`);

  // ── §3 internal reconciliation: gross − commission === net kept ────────────
  console.log("\n[3] per-channel gross − commission === net (no mismatched net field)");
  let reconciled = true;
  for (const c of channels) {
    if (toCents(c.gross) - toCents(c.commission) !== toCents(c.net)) {
      reconciled = false;
      console.log(`    ${c.source}: gross ${c.gross} − comm ${c.commission} !== net ${c.net}`);
    }
  }
  ok("every channel's net === gross − commission", reconciled);

  localDb.close();
}

console.log(`\n${"─".repeat(70)}`);
if (failures.length) { console.log("Failures:"); failures.forEach((f) => console.log(`  • ${f}`)); }
console.log(`\n${fail === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);


