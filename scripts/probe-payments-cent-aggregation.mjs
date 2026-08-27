// Probe for "Payments.jsx aggregates dollar values with float `reduce` instead
// of cent-exact primitives".
//
// Root cause (src/pages/Payments.jsx, before fix): the page keeps a
// paymentType-filtered `methodTotals` map (each entry already cent-exact via
// hotel.sum) but then re-aggregates across methods with raw float `+`:
//
//   const cardTotal = CARD_METHODS.reduce((a, k) => a + (methodTotals[k] || 0), 0);
//   const totalCollected = activeMethods.reduce((a,[k]) => a + (methodTotals[k]||0), 0);
//   const netPaymentCollected = totalCollected - refunds;
//   const variance = totalCollected - expectedRevenue;
//   const totalTaxCollected = taxCalculations.reduce((a, c) => a + c.tax, 0);
//
// Adding several dollar floats reintroduces IEEE-754 residue (0.1 + 0.2 =
// 0.30000000000000004) into numbers that BUSINESS.md requires to reconcile to
// the exact cent. This probe reproduces the residue on those exact reduce
// patterns and proves the cent-exact replacement (fromCents(sumCents(...)),
// subtract) removes it.
//
// Run: node --import ./scripts/_loader-boot.mjs scripts/probe-payments-cent-aggregation.mjs

let pass = 0;
let fail = 0;
const T = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`); }
};

const { sumCents, fromCents, subtract } = await import("@/lib/decimal");

// A methodTotals map whose card entries are residue-prone dollar values, exactly
// as hotel.sum() would return them (cent-exact dollars like 0.1, 0.2, 0.05).
const CARD = ["visa", "mastercard", "amex", "discover"];
const methodTotals = { visa: 0.1, mastercard: 0.2, amex: 0, discover: 0, cash: 0.7 };

// ── 1. The old float reduce carries residue ─────────────────────────────────
const oldCardTotal = CARD.reduce((a, k) => a + (methodTotals[k] || 0), 0);
T("old float reduce does NOT yield an exact 0.3 (residue reproduced)",
  oldCardTotal !== 0.3,
  `old cardTotal = ${oldCardTotal}`);

// ── 2. Cent-exact aggregation yields exactly 0.3 ────────────────────────────
const cardTotal = fromCents(sumCents(CARD.map((k) => methodTotals[k] || 0)));
T("cent-exact cardTotal is exactly 0.3", cardTotal === 0.3, `got ${cardTotal}`);
T("cent-exact cardTotal is finite number", Number.isFinite(cardTotal) && typeof cardTotal === "number");

// ── 3. netPaymentCollected = totalCollected - refunds, to the cent ──────────
const totalCollected = fromCents(sumCents([0.1, 0.2, 0, 0, 0.7])); // 1.0
const refunds = 0.3;
const oldNet = 1.2 - refunds; // reproduce residue on a subtraction
const net = fromCents(subtract(totalCollected, refunds));
T("cent-exact netPaymentCollected is exactly 0.7", net === 0.7, `got ${net}`);
T("float subtraction of residue-prone values is NOT exact (bug reproduced)",
  oldNet !== 0.9, `old net = ${oldNet}`);

// ── 4. variance = totalCollected - expectedRevenue, to the cent ─────────────
const expectedRevenue = 0.9;
const variance = fromCents(subtract(totalCollected, expectedRevenue));
T("cent-exact variance is exactly 0.1 (1.0 - 0.9)", variance === 0.1, `got ${variance}`);

// ── 5. totalTaxCollected sums per-bucket tax to the cent ────────────────────
const taxCalculations = [{ tax: 0.1 }, { tax: 0.2 }, { tax: 0.05 }];
const oldTax = taxCalculations.reduce((a, c) => a + c.tax, 0);
const totalTax = fromCents(sumCents(taxCalculations.map((c) => c.tax)));
T("cent-exact totalTaxCollected is exactly 0.35", totalTax === 0.35, `got ${totalTax}`);
T("float tax reduce is NOT exact (bug reproduced)", oldTax !== 0.35, `old tax = ${oldTax}`);

console.log(`\n${fail === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
