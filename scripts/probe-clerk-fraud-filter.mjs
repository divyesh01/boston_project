// Probe: fraud-tab Clerk + Payment Type filter composition.
//
// The Employees "Fraud & Anomalies" tab derives every view (KPIs, risk matrix,
// anomaly ledger, drill-down) from detectClerkAnomalies({ adjustments, refunds }).
// The new filters work by narrowing those two INPUT arrays and letting the
// existing engine recompute. This probe proves the load-bearing contract:
//
//   1. all/all  → identical to an unfiltered run (default behavior preserved).
//   2. clerk=X  → every emitted anomaly AND every risk-matrix row is username X.
//   3. type=T   → every refund-derived anomaly carries tender T; adjustments
//                 (which carry no tender) pass through untouched.
//
// Zero-dependency import: anomalyDetector.js has no `@/` imports, so plain node
// can load it without the harness bootstrap loader.

import { detectClerkAnomalies } from "../src/lib/anomalyDetector.js";

let failures = 0;
const ok = (label, cond) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};

// ── Synthetic inputs (shape from scanAdjustmentsRefunds) ────────────────────
// Adjustments carry NO payment tender. Refunds carry paymentTypeRefunded.
const adjustments = [
  // alice: vague reason + $80 → large_uncategorized_writeoff (MEDIUM)
  { username: "alice@rri", date: "2026-02-10", time: "02:15:00 PM", roomNumber: "101",
    reasonCode: "OTHER ADJUSTMENTS", adjustedAmount: -80, remarks: "" },
  // bob: vague reason + $50 → writeoff + round_number_fraud (two distinct rules)
  { username: "bob@rri", date: "2026-02-11", time: "03:00:00 PM", roomNumber: "202",
    reasonCode: "HOSPITALITY ADJUSTMENT", adjustedAmount: -50, remarks: "" },
];

const refunds = [
  // alice: CASH $60 → cash_refund_skimming (CRITICAL) + room_rent_refund (MEDIUM)
  { username: "alice@rri", date: "2026-02-10", time: "10:00:00 AM", roomNumber: "101",
    paymentTypeRefunded: "CASH", refundCode: "CUSTOMER SATISFACTION", amount: -60, remarks: "" },
  // bob: FPCC CREDIT CARD $100 → deposit_refund (LOW)
  { username: "bob@rri", date: "2026-02-11", time: "11:30:00 AM", roomNumber: "202",
    paymentTypeRefunded: "FPCC CREDIT CARD", refundCode: "DEPOSIT", amount: -100, remarks: "" },
];

// ── The exact filter the UI applies to the inputs ───────────────────────────
function filterInputs(clerk, type) {
  let a = adjustments;
  let r = refunds;
  if (clerk !== "all") {
    a = a.filter((x) => x.username === clerk);
    r = r.filter((x) => x.username === clerk);
  }
  if (type !== "all") {
    // Payment tender lives on refunds only; adjustments pass through.
    r = r.filter((x) => (x.paymentTypeRefunded || "—") === type);
  }
  return { adjustments: a, refunds: r };
}

// ── 1. all/all preserves default behavior ───────────────────────────────────
const full = detectClerkAnomalies({ adjustments, refunds });
const allAll = detectClerkAnomalies(filterInputs("all", "all"));
ok(
  "all/all equals unfiltered run (anomaly + risk-row counts)",
  full.flaggedAnomalies.length === allAll.flaggedAnomalies.length &&
    full.clerkRiskScores.length === allAll.clerkRiskScores.length
);
ok(
  "all/all byte-identical output",
  JSON.stringify(full) === JSON.stringify(allAll)
);
console.log(`      (full run: ${full.flaggedAnomalies.length} anomalies, ${full.clerkRiskScores.length} clerks)`);

// ── 2. Clerk filter restricts everything to one username ────────────────────
const aliceOnly = detectClerkAnomalies(filterInputs("alice@rri", "all"));
ok(
  "clerk=alice → every anomaly is alice@rri",
  aliceOnly.flaggedAnomalies.length > 0 &&
    aliceOnly.flaggedAnomalies.every((f) => f.username === "alice@rri")
);
ok(
  "clerk=alice → every risk-matrix row is alice@rri",
  aliceOnly.clerkRiskScores.length > 0 &&
    aliceOnly.clerkRiskScores.every((c) => c.username === "alice@rri")
);
ok(
  "clerk=alice → bob's deposit_refund flag is gone",
  !aliceOnly.flaggedAnomalies.some((f) => f.username === "bob@rri")
);

// ── 3. Payment-type filter restricts refund anomalies to the tender ─────────
const cashOnly = detectClerkAnomalies(filterInputs("all", "CASH"));
const refundAnoms = cashOnly.flaggedAnomalies.filter((f) => f.paymentType); // refund-derived carry tender
ok(
  "type=CASH → every refund-derived anomaly is CASH tender",
  refundAnoms.length > 0 && refundAnoms.every((f) => String(f.paymentType).toUpperCase() === "CASH")
);
ok(
  "type=CASH → FPCC deposit refund excluded",
  !cashOnly.flaggedAnomalies.some((f) => String(f.paymentType).toUpperCase().includes("FPCC"))
);
ok(
  "type=CASH → adjustments pass through (adjustment anomalies still present)",
  cashOnly.flaggedAnomalies.some((f) => !f.paymentType && f.username)
);

console.log("");
if (failures) {
  console.error(`RESULT: ${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("RESULT: all checks PASSED");
