// Probe (audit selection): "MoneyKept.jsx inflates refunds by taking the
// magnitude at the DAY boundary instead of summing every signed row across the
// selected period and taking the magnitude ONCE."
//
// ── The per-row → per-day → per-period progression (why each section exists) ──
//
//   PER ROW    src/lib/paymentNorm.js#refundOf(row) = signed refund dollars for
//              one row. REFUND_FIELDS = ["closed_balance_folio","loyalty_discount"]
//              are stored SIGNED (the PMS emits refunds negative; a positive
//              closed_balance_folio is a CORRECTION that must OFFSET a refund).
//
//   PER PERIOD src/lib/paymentNorm.js#refundTotal(rows)
//                = Math.abs(fromCents(sumCents(rows.map(refundOf))))
//              = "sum every signed row across the period, take the magnitude
//              ONCE". This IS the contract the Payments page and
//              calculationService use, so it is the spec for the period figure.
//
//   PER DAY    src/components/dashboard/MoneyKept.jsx (CURRENT, WRONG) groups the
//              period's pay rows into `payByDay`, calls `refundTotal(dayRows)`
//              PER DAY (abs at the DAY boundary), then derives the headline
//              `refundsTotal` by summing the daily POSITIVE magnitudes
//              (`dayTotals.filter(d => d.refunds > 0)` → reduce). A refund on one
//              day and an opposing correction on another NO LONGER net — each is
//              abs()'d inside its own day first, so a cross-day sign flip
//              INFLATES the refund deduction, the refund CC-fee, the keep-rate
//              denominator and the trend.
//
//   Proven cross-day example: closed_balance_folio -500 on 2026-02-01, +300 on
//   2026-02-02. Contract = |−500 + 300| = 200. Current widget = |−500| + |+300|
//   = 800. Overstatement 600. The OLD probe passed only because its refund and
//   correction shared ONE date and its latch merely checked that `refundTotal(`
//   textually appears — which does NOT prove period-level aggregation.
//
// ── The fix this probe is failing-first against (Agent C) ──
//   A shared, pure, cent-exact helper ADDED to src/lib/paymentNorm.js:
//     refundPeriodBreakdown(rows, dateOf?) -> {
//       periodCents,      // signed integer cents = Σ every signed row's cents
//       magnitudeCents,   // Math.abs(periodCents)
//       magnitude,        // fromCents(magnitudeCents) === refundTotal(rows)
//       direction,        // periodCents < 0 ? -1 : 1  (default +1 at zero)
//       byDay,            // Map<dateStr,{signedCents,allocationCents,allocation}>
//     }
//   Reconciliation invariant the helper GUARANTEES:
//       Σ over byDay of allocationCents === magnitudeCents  (exact integer cents)
//   A day whose sign opposes the period reads as a NEGATIVE allocation (an honest
//   offset), never abs()'d at the day boundary. MoneyKept.jsx then derives the
//   refund deduction, the refundsTotal headline, the refund CC-fee, the keep-rate
//   denominator, total deductions and the daily/trend values from ONE breakdown.
//
//   SECTION A  encodes the contract with the EXISTING refundTotal (passes now).
//   SECTION B  BEHAVIOURAL, on the real exported helper (FAILS before the fix,
//              PASSES after) — magnitude + daily-allocation reconciliation.
//   SECTION C  STRUCTURAL latch on comment-stripped MoneyKept.jsx source.
//
// Run: node --import ./scripts/_loader-boot.mjs scripts/probe-moneykept-refund-signed.mjs

import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./_repo-root.mjs";
import { refundOf, refundTotal } from "@/lib/paymentNorm.js";

let pass = 0;
let fail = 0;
const failures = [];
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`); }
};
const near = (a, b, eps = 0.005) => Math.abs(a - b) < eps;

// The date accessor the widget uses everywhere: first 10 chars of `.date`.
const dateOf = (r) => String(r?.date || "").slice(0, 10);

// ─── A. Contract arithmetic (EXISTING refundTotal — encodes the spec) ─────────
// These pass even now: they pin what the PERIOD figure must be, so Section B has
// a fixed target and Section C has a reason to exist.
console.log("\n=== A. period refund contract (paymentNorm#refundTotal) ===");

// A refund on one day, an opposing correction on the NEXT day. refundTotal sums
// every signed row across the period and takes the magnitude once → 200.
const crossDayRows = [
  { date: "2026-02-01", closed_balance_folio: -500, loyalty_discount: 0 },
  { date: "2026-02-02", closed_balance_folio: 300, loyalty_discount: 0 },
];
const contract = refundTotal(crossDayRows);
ok("cross-day [-500, +300] nets to the period magnitude |−500+300| = 200",
  near(contract, 200), `got ${contract}`);

// The naive per-day-abs model the CURRENT widget uses: group by day, abs each
// day, add. This is what inflates — document it and assert it diverges.
const perDayAbs = (rows) => {
  const byDay = new Map();
  rows.forEach((r) => byDay.set(dateOf(r), (byDay.get(dateOf(r)) || 0) + refundOf(r)));
  return [...byDay.values()].reduce((a, v) => a + Math.abs(v), 0);
};
const naive = perDayAbs(crossDayRows);
ok("the naive per-day-abs model computes 800 on this fixture (bug reproduced)",
  near(naive, 800), `got ${naive}`);
ok("per-day-abs (800) is NOT the period contract (200) — negative assertion",
  !near(naive, contract), `naive=${naive} contract=${contract}`);
ok("per-day-abs over-deducts by exactly twice the correction (600)",
  near(naive - contract, 600), `got ${naive - contract}`);

// ─── B. Behavioural: the real exported refundPeriodBreakdown helper ───────────
// FAILS before Agent C (helper undefined → guarded, no load crash), PASSES after.
console.log("\n=== B. refundPeriodBreakdown period aggregation + reconciliation ===");

// Namespace/dynamic import so a missing named export does not crash the module
// load — we assert on typeof and guard every case below.
const PN = await import("@/lib/paymentNorm.js");
const refundPeriodBreakdown = PN.refundPeriodBreakdown;
const helperExists = typeof refundPeriodBreakdown === "function";
ok("refundPeriodBreakdown is exported from paymentNorm and is a function",
  helperExists, `typeof = ${typeof refundPeriodBreakdown}`);

// Safe caller: returns null when the helper is missing, {__err} when it throws.
const bd = (rows) => {
  if (!helperExists) return null;
  try { return refundPeriodBreakdown(rows, dateOf); } catch (e) { return { __err: String(e && e.message || e) }; }
};
// Σ allocationCents across byDay — the reconciliation invariant's left side.
const allocSum = (r) => [...(r.byDay?.values?.() || [])].reduce((a, v) => a + v.allocationCents, 0);
// Σ |signedCents| across byDay — the INFLATING per-day-abs model, in cents.
const perDayAbsCents = (r) => [...(r.byDay?.values?.() || [])].reduce((a, v) => a + Math.abs(v.signedCents), 0);
// Assert a case's magnitude, that it equals the contract, and that byDay reconciles.
const checkCase = (label, rows, expectMagnitude, expectDirection) => {
  const r = bd(rows);
  const has = !!r && !r.__err;
  ok(`${label}: magnitude === ${expectMagnitude}`,
    has && near(r.magnitude, expectMagnitude),
    r ? (r.__err || `got ${r.magnitude}`) : "helper missing");
  // Helper agrees with the EXISTING contract to the cent (strict, not near).
  ok(`${label}: magnitude === refundTotal(rows) (agrees with contract to the cent)`,
    has && r.magnitude === refundTotal(rows),
    r ? (r.__err || `helper=${r.magnitude} contract=${refundTotal(rows)}`) : "helper missing");
  ok(`${label}: Σ byDay.allocationCents === magnitudeCents (reconciles exactly)`,
    has && allocSum(r) === r.magnitudeCents,
    r ? (r.__err || `Σalloc=${has ? allocSum(r) : "?"} magnitudeCents=${r.magnitudeCents}`) : "helper missing");
  if (expectDirection !== undefined) {
    ok(`${label}: direction === ${expectDirection}`,
      has && r.direction === expectDirection,
      r ? (r.__err || `got ${r.direction}`) : "helper missing");
  }
  return r;
};

// 1. Same-day −500 + 300 → 200.
checkCase("1 same-day [-500,+300]",
  [{ date: "2026-02-01", closed_balance_folio: -500 }, { date: "2026-02-01", closed_balance_folio: 300 }],
  200, -1);

// 2. Cross-day −500 (d1) + 300 (d2) → 200; allocations {d1:+500, d2:−300}; Σ 200.
{
  const rows = [
    { date: "2026-02-01", closed_balance_folio: -500 },
    { date: "2026-02-02", closed_balance_folio: 300 },
  ];
  const r = checkCase("2 cross-day [-500(d1),+300(d2)]", rows, 200, -1);
  const has = !!r && !r.__err;
  ok("2 cross-day: d1 allocation is +500 (honest, not abs'd to a bigger refund)",
    has && r.byDay.get("2026-02-01")?.allocationCents === 50000,
    has ? `got ${r.byDay.get("2026-02-01")?.allocationCents}` : "helper missing");
  ok("2 cross-day: d2 allocation is −300 (the correction reads as a NEGATIVE offset)",
    has && r.byDay.get("2026-02-02")?.allocationCents === -30000,
    has ? `got ${r.byDay.get("2026-02-02")?.allocationCents}` : "helper missing");
  // Negative assertion: helper is NOT the per-day-abs model on a cross-day flip.
  ok("2 cross-day: helper magnitudeCents (20000) ≠ per-day-abs model (80000)",
    has && perDayAbsCents(r) === 80000 && r.magnitudeCents !== perDayAbsCents(r),
    has ? `magnitudeCents=${r.magnitudeCents} perDayAbs=${perDayAbsCents(r)}` : "helper missing");
}

// 3. Two refunds −500 + −300 on different days → 800; here per-day-abs AGREES
//    (no cross-day sign flip), which proves the negative assertion is not blanket.
{
  const rows = [
    { date: "2026-02-01", closed_balance_folio: -500 },
    { date: "2026-02-02", closed_balance_folio: -300 },
  ];
  const r = checkCase("3 two refunds [-500(d1),-300(d2)]", rows, 800, -1);
  const has = !!r && !r.__err;
  ok("3 same-sign: helper magnitudeCents (80000) EQUALS per-day-abs (no flip)",
    has && r.magnitudeCents === perDayAbsCents(r) && r.magnitudeCents === 80000,
    has ? `magnitudeCents=${r.magnitudeCents} perDayAbs=${perDayAbsCents(r)}` : "helper missing");
}

// 4. Correction-only +300 → magnitude 300 (= refundTotal), direction +1.
checkCase("4 correction-only [+300]",
  [{ date: "2026-02-01", closed_balance_folio: 300 }],
  300, 1);

// 5. Exact cancellation −300 (d1) + 300 (d2) → 0; direction default +1; Σ 0.
{
  const rows = [
    { date: "2026-02-01", closed_balance_folio: -300 },
    { date: "2026-02-02", closed_balance_folio: 300 },
  ];
  const r = checkCase("5 exact cancellation [-300(d1),+300(d2)]", rows, 0, 1);
  const has = !!r && !r.__err;
  ok("5 cancellation: byDay allocations sum to 0 (offsets net exactly)",
    has && allocSum(r) === 0, has ? `Σalloc=${allocSum(r)}` : "helper missing");
}

// 6. Both refund fields populated in ONE row → signed sum honored.
//    −500 (closed_balance_folio) + 200 (loyalty_discount) = −300 signed → 300.
checkCase("6 both fields one row [cbf -500, loyalty +200]",
  [{ date: "2026-02-01", closed_balance_folio: -500, loyalty_discount: 200 }],
  300, -1);

// 7. Empty input → magnitude 0, byDay empty, no throw.
{
  const r = bd([]);
  const has = !!r && !r.__err;
  ok("7 empty []: magnitude 0", has && near(r.magnitude, 0), r ? (r.__err || `got ${r.magnitude}`) : "helper missing");
  ok("7 empty []: byDay is empty", has && r.byDay?.size === 0, r ? (r.__err || `size ${r.byDay?.size}`) : "helper missing");
  ok("7 empty []: magnitude === refundTotal([]) (agrees, no throw)",
    has && r.magnitude === refundTotal([]), r ? (r.__err || "mismatch") : "helper missing");
}

// 8. Fractional-cent-sensitive dollars: −0.1 (d1) + −0.2 (d2) drift under float
//    (0.1 + 0.2 !== 0.3) but resolve to exactly 0.30 through integer cents.
{
  const rows = [
    { date: "2026-02-01", closed_balance_folio: -0.1 },
    { date: "2026-02-02", closed_balance_folio: -0.2 },
  ];
  const floatAbs = Math.abs(rows.reduce((a, r) => a + r.closed_balance_folio, 0)); // 0.30000000000000004
  ok("8 fixture bites: naive float |−0.1 + −0.2| is NOT exactly 0.30",
    floatAbs !== 0.30, `floatAbs=${floatAbs}`);
  const r = checkCase("8 fractional [-0.1(d1),-0.2(d2)]", rows, 0.30, -1);
  const has = !!r && !r.__err;
  ok("8 fractional: magnitude is EXACTLY 0.30 (strict ===, cent-exact)",
    has && r.magnitude === 0.30, has ? `got ${r.magnitude}` : "helper missing");
  ok("8 fractional: magnitudeCents is the integer 30 (no residue)",
    has && r.magnitudeCents === 30, has ? `got ${r.magnitudeCents}` : "helper missing");
}

// ─── C. Structural latch on comment-stripped MoneyKept.jsx source ─────────────
// The widget's math is a ~400-line useMemo with no headless entry point (the same
// limitation verify-money-kept.mjs and probe-money-kept-double-count.mjs document),
// so the binding is structural. Comments are stripped first so a comment that
// EXPLAINS the old pattern cannot fail the latch. The [^:] guard keeps "https://"
// out of the line-comment rule.
console.log("\n=== C. MoneyKept.jsx routes refunds through refundPeriodBreakdown ===");
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const widgetSrc = stripComments(
  readFileSync(path.join(REPO_ROOT, "src", "components", "dashboard", "MoneyKept.jsx"), "utf8")
);

ok("the widget imports refundPeriodBreakdown from paymentNorm",
  /import \{[^}]*refundPeriodBreakdown[^}]*\} from "@\/lib\/paymentNorm"/.test(widgetSrc),
  "expected refundPeriodBreakdown in the paymentNorm import");
ok("the widget CALLS refundPeriodBreakdown(",
  /refundPeriodBreakdown\s*\(/.test(widgetSrc),
  "expected refundPeriodBreakdown(...) to drive the refund figures");
ok("the widget no longer takes the refund magnitude PER ROW (Math.abs(refundOf(...)))",
  !/Math\.abs\(\s*refundOf\s*\(/.test(widgetSrc),
  "found a per-row Math.abs(refundOf(...)) — the inflating pattern");
// Strictest latch: no per-day refundTotal(...) call survives. The widget must go
// through refundPeriodBreakdown now, so refundTotal( must not appear at all
// (the import switching to refundPeriodBreakdown removes the only usage).
ok("the widget no longer calls refundTotal( at any day boundary (abs-per-day gone)",
  !/refundTotal\s*\(/.test(widgetSrc),
  "found refundTotal(...) — the per-day abs aggregation is still present");

console.log(`\n${"─".repeat(70)}`);
if (failures.length) { console.log("Failures:"); failures.forEach((f) => console.log(`  • ${f}`)); }
console.log(`\n${fail === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
