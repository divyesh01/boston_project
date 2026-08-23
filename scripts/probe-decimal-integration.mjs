// probe-decimal-integration.mjs — integer-cent money math, ACROSS module boundaries.
//
// Run: node --import ./scripts/_loader-boot.mjs scripts/probe-decimal-integration.mjs
//
// WHAT THIS DEFENDS (and why a decimal.js unit test would not)
// ─────────────────────────────────────────────────────────────────────────────────
// scripts/probe-decimal.mjs already proves decimal.js itself adds correctly. That
// was never the failure mode. The failure mode in this repo is that two modules
// compute THE SAME dollar figure by two different routes — one in cents, one in
// floats — and print both to the owner on the same screen. Measured examples that
// existed before 2026-08-20:
//
//   1. src/lib/actionCenter.js computed card fees as `cardVolume * ccFee` while
//      src/lib/calculationService.js:208 computes the identical quantity as
//      multiply(fromCents(cardTotalCents), ccFee). Dashboard and Action Center
//      could disagree about one month's card fees with no row to blame.
//   2. src/lib/payrollCalc.js#sumCommittedPay float-summed total_pay, and FOUR
//      callers subtract its result from revenue.
//   3. src/lib/dailyAggregates.js float-accumulated every per-day total, and the
//      Dashboard PREFERS that cache over the live ledgers — so the same period
//      returned different totals depending on whether the cache was warm.
//   4. src/lib/calculationService.js#calculateProfitMetrics summed expenses with
//      `a + (e.amount || 0)`, no coercion, so a string amount from a CSV import
//      turned the accumulator into a string and operating expenses became 0.
//   5. src/lib/calculationService.js#calculateOccupancyMetrics applied the "this
//      property has N rooms" fallback ONCE PER ROW. This PMS emits several occupancy
//      rows per (property, date), so a fully-imported day bought several days of
//      inventory: capacity 80 live vs 60 from the cache on the fixture below, hence
//      occupancy 18.33% vs 13.75% and RevPAR $20.92 vs $15.69 for one period.
//
// So every assertion below is a CROSS-MODULE equality or a coercion test. None of
// them re-implement the arithmetic and then agree with themselves — that is the
// defect class this repo keeps finding (see the header of
// scripts/probe-audit-export.mjs).
//
// BEST OUTCOME NOTE (2026-08-20): §1 asserts that the naive float route and the
// product route DISAGREE on these fixtures before any assertion claims the product
// route is right. Without that, every assertion here would still pass on a float
// implementation and the suite would be decoration.
//
// Every drifting fixture below was MEASURED in node, not assumed — which matters,
// because the obvious-looking [19.99, 0.01, 0.1, 0.2] left-folds to EXACTLY 20.3 and
// makes a useless fixture. Measured (2026-08-20):
//   [1234.56, 0.07, 0.1, 0.2] -> 1234.9299999999998   (exact 1234.93)  DRIFTS
//   [1234.56, 0.07, 0.1]      -> 1234.7299999999998   (exact 1234.73)  DRIFTS
//   [0.1, 0.7]                -> 0.7999999999999999   (exact 0.8)      DRIFTS
//   0.07 x 1000 rows          -> 69.99999999999966    (exact 70)       DRIFTS
//   [19.99, 0.01, 0.1, 0.2]   -> 20.3                                  does NOT
//   [10.1, 0.2, 0.07]         -> 10.37                                 does NOT
// Whether a value drifts depends on the running total, so §1's guards are not
// ceremony: they fail loudly if a future edit to a fixture removes its drift.

import assert from "node:assert/strict";

let pass = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    pass++;
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
    console.error(`  FAIL  ${name}\n        ${err.message}`);
  }
}

const D = await import("../src/lib/decimal.js");
const { CalculationService } = await import("../src/lib/calculationService.js");
const { sumCommittedPay, filterCommittedPay } = await import("../src/lib/payrollCalc.js");
const { aggregateDays, buildSyntheticRows } = await import("../src/lib/dailyAggregates.js");
const { buildActionCenter } = await import("../src/lib/actionCenter.js");
const { getCcFeeRate, getCcFeeOnRefunds } = await import("../src/lib/commissionRates.js");
const { CARD_METHODS } = await import("../src/lib/paymentNorm.js");

// Cent-exact comparison. Anything that differs by less than half a cent is the
// same money; anything that differs by more is a defect. Comparing raw floats with
// === would fail on values that ARE correct, and comparing with a loose epsilon
// would pass on values that are not.
const cents = (v) => D.toCents(v);
function sameMoney(actual, expected, what) {
  assert.equal(
    cents(actual),
    cents(expected),
    `${what}: got ${actual} (${cents(actual)}c), expected ${expected} (${cents(expected)}c)`,
  );
}

console.log("== §1 the fixture actually distinguishes float from cent math ==");

// If these two agreed, nothing else in this file would be evidence of anything.
const DRIFTY = [1234.56, 0.07, 0.1, 0.2];
check("naive float sum of the fixture is WRONG (so the fixture is fit for purpose)", () => {
  const floatSum = DRIFTY.reduce((a, b) => a + b, 0);
  assert.notEqual(floatSum, 1234.93, "fixture no longer exposes float drift — pick harder values");
  assert.ok(Math.abs(floatSum - 1234.93) > 0, "expected a non-zero residue");
});
check("sumCents of the same fixture is exact", () => {
  assert.equal(D.sumCents(DRIFTY), 123493);
  assert.equal(D.fromCents(D.sumCents(DRIFTY)), 1234.93);
});

// 1000 rows of a third of a cent's worth of drift each: this is the scale at which
// a month of transactions accumulates.
const MANY = Array.from({ length: 1000 }, () => 0.07);
check("1000-row float sum drifts; cent sum does not", () => {
  const floatSum = MANY.reduce((a, b) => a + b, 0);
  assert.notEqual(floatSum, 70, `expected float drift, got exactly ${floatSum}`);
  assert.equal(D.fromCents(D.sumCents(MANY)), 70);
});

console.log("== §2 sumCommittedPay: cent-exact, and units unchanged ==");

const RUNS = [
  { total_pay: 1234.56, payroll_status: "paid", pay_period_start: "2026-07-01" },
  { total_pay: 0.07, payroll_status: "approved", pay_period_start: "2026-07-01" },
  { total_pay: 0.1, payroll_status: "paid", pay_period_start: "2026-07-01" },
  { total_pay: 0.2, payroll_status: "approved", pay_period_start: "2026-07-01" },
  { total_pay: 90000, payroll_status: "draft", pay_period_start: "2026-07-01" },
];
const RUNS_COMMITTED = 1234.93;

check("sumCommittedPay returns DOLLARS (all 4 callers subtract it from revenue)", () => {
  // 1234.93, not 123493. A silent switch to cents here would make the dashboard
  // deduct a hundred times the payroll and is the single most damaging thing this
  // change could have got wrong.
  sameMoney(sumCommittedPay(RUNS), RUNS_COMMITTED, "sumCommittedPay");
  assert.ok(sumCommittedPay(RUNS) < 10000, "returned a cents-scaled value (123493), not dollars");
});

check("sumCommittedPay is exact where a float reduce is not", () => {
  const floatWay = filterCommittedPay(RUNS).reduce((a, r) => a + (Number(r.total_pay) || 0), 0);
  assert.notEqual(floatWay, RUNS_COMMITTED, "fixture no longer distinguishes the two routes");
  assert.equal(sumCommittedPay(RUNS), RUNS_COMMITTED);
});

check("drafts still excluded (a draft run must not move money kept)", () => {
  assert.equal(filterCommittedPay(RUNS).length, 4);
  assert.ok(sumCommittedPay(RUNS) < 90000, "a draft run leaked into committed pay");
});

check("sumCommittedPay is order-independent", () => {
  const shuffled = [...RUNS].reverse();
  assert.equal(sumCommittedPay(shuffled), sumCommittedPay(RUNS));
});

check("sumCommittedPay coerces string amounts (CSV imports produce strings)", () => {
  const strung = [
    { total_pay: "19.99", payroll_status: "paid" },
    { total_pay: "0.31", payroll_status: "approved" },
  ];
  sameMoney(sumCommittedPay(strung), 20.3, "string total_pay");
});

check("sumCommittedPay tolerates junk without poisoning the total", () => {
  const junk = [
    { total_pay: 10, payroll_status: "paid" },
    { total_pay: null, payroll_status: "paid" },
    { total_pay: undefined, payroll_status: "approved" },
    { total_pay: "", payroll_status: "approved" },
    { total_pay: "n/a", payroll_status: "paid" },
  ];
  sameMoney(sumCommittedPay(junk), 10, "junk total_pay");
  assert.ok(Number.isFinite(sumCommittedPay(junk)), "returned NaN");
});

console.log("== §3 the cached day aggregates equal the live ledger, to the cent ==");

// Values chosen so the per-day float accumulation drifts: three rows on p1's first
// day whose dollar sum ([1234.56, 0.07, 0.1]) is not representable. Two of those
// three rows carry total_rooms: 0, which is what the per-row inventory fallback used
// to turn into two extra days of capacity.
const OCC = [
  { property_id: "p1", date: "2026-07-01", room_revenue: 1234.56, rooms_sold: 3, total_rooms: 10 },
  { property_id: "p1", date: "2026-07-01", room_revenue: 0.07, rooms_sold: 1, total_rooms: 0 },
  { property_id: "p1", date: "2026-07-01", room_revenue: 0.1, rooms_sold: 0, total_rooms: 0 },
  { property_id: "p1", date: "2026-07-02", room_revenue: 0.2, rooms_sold: 1, total_rooms: 10 },
  { property_id: "p2", date: "2026-07-01", room_revenue: 1234.56, rooms_sold: 5, total_rooms: 20 },
  { property_id: "p2", date: "2026-07-02", room_revenue: 0.07, rooms_sold: 1, total_rooms: 20 },
];
const OCC_P1_DAY1_REVENUE = 1234.73;
const SRC = [
  { property_id: "p1", date: "2026-07-01", source: "EXPEDIA", net_revenue: 10.1, stays: 2 },
  { property_id: "p1", date: "2026-07-01", source: "EXPEDIA", net_revenue: 0.2, stays: 1 },
  { property_id: "p1", date: "2026-07-01", source: "WALK IN", net_revenue: 9.7, stays: 1 },
  { property_id: "p2", date: "2026-07-01", source: "BOOKING.COM", net_revenue: 1234.56, stays: 5 },
];
const GROSS = [
  { property_id: "p1", date: "2026-07-01", state_tax: 1.11, city_tax: 0.22, other_tax: 0.03, misc_charge: 0.1, food: 0.2 },
  { property_id: "p1", date: "2026-07-01", state_tax: 2.22, city_tax: 0.33, other_tax: 0.04, misc_charge: 0.7, food: 0.1 },
];
// Payment columns are the REAL schema columns. An earlier draft of this probe used a
// `credit_card` column that does not exist in CARD_METHODS, so the card-fee
// assertions were reading an absent field and comparing 0 to 0 — which is how the
// `total - cash - check` card-volume defect survived a suite that appeared to cover
// it. Row 4 is the whole point: $750 of direct_bill + wire_transfer that never
// touched a card processor and must not be charged a card fee.
const PAY = [
  { property_id: "p1", date: "2026-07-01", total: 1234.56, visa: 1234.56, cash: 0, check: 0 },
  { property_id: "p1", date: "2026-07-01", total: 0.17, master: 0.07, amex: 0.1, cash: 0, check: 0 },
  { property_id: "p2", date: "2026-07-01", total: 1234.56, visa: 1000, cash: 234.56, check: 0, closed_balance_folio: -25.5 },
  { property_id: "p2", date: "2026-07-01", total: 750, direct_bill: 500, wire_transfer: 250, cash: 0, check: 0 },
];
const PAY_CARD_VOLUME = 2234.73; // visa 1234.56 + master 0.07 + amex 0.1 + visa 1000
const PAY_REFUNDS = 25.5;
const RANGE = { from: "2026-07-01", to: "2026-07-31" };
const EXP = [
  { property_id: "p1", expense_date: "2026-07-01", category: "utilities", amount: 10.1 },
  { property_id: "p1", expense_date: "2026-07-01", category: "utilities", amount: 0.2 },
  { property_id: "p1", expense_date: "2026-07-01", category: "payroll", amount: 500 },
];

const DAYS = aggregateDays({ occ: OCC, src: SRC, gross: GROSS, pay: PAY, exp: EXP });

check("aggregateDays produced one row per (property, date)", () => {
  assert.equal(DAYS.length, 4, `expected 4 day-rows, got ${DAYS.length}`);
  const keys = DAYS.map((d) => `${d.property_id}|${d.business_date}`).sort();
  assert.deepEqual(keys, ["p1|2026-07-01", "p1|2026-07-02", "p2|2026-07-01", "p2|2026-07-02"]);
});

check("aggregateDays stores DOLLARS, not cents", () => {
  // The single most dangerous way this refactor could fail: an unconverted field
  // renders as a figure 100x too large and looks like real revenue.
  const d1 = DAYS.find((d) => d.property_id === "p1" && d.business_date === "2026-07-01");
  sameMoney(d1.occ_revenue, OCC_P1_DAY1_REVENUE, "p1 day-1 occ_revenue");
  assert.notEqual(d1.occ_revenue, 123473, `occ_revenue looks cents-scaled: ${d1.occ_revenue}`);
});

check("every money field on every cached day is dollar-scaled and finite", () => {
  for (const d of DAYS) {
    const moneyValues = [
      d.occ_revenue, d.gross_state_tax, d.gross_city_tax, d.gross_other_tax, d.payment_total,
      ...Object.values(d.gross_misc || {}),
      ...Object.values(d.payment || {}),
      ...Object.values(d.expense_by_category || {}),
      ...Object.values(d.source_net || {}).map((v) => v.net),
    ];
    for (const v of moneyValues) {
      assert.ok(Number.isFinite(v), `non-finite money on ${d.property_id}|${d.business_date}: ${v}`);
      // A dollar value converted from cents always lands on a whole cent.
      assert.equal(D.toCents(v) / 100, v, `not a whole cent on ${d.property_id}|${d.business_date}: ${v}`);
    }
  }
});

check("counts stay counts (not divided by 100 on the way out)", () => {
  const d1 = DAYS.find((d) => d.property_id === "p1" && d.business_date === "2026-07-01");
  assert.equal(d1.occ_rooms_sold, 4, "rooms_sold");
  assert.equal(d1.occ_capacity_rooms, 10, "capacity");
  assert.equal(d1.source_net.EXPEDIA.stays, 3, "stays");
});

check("cached money totals are exact where a float accumulation is not", () => {
  const floatWay = OCC.filter((r) => r.property_id === "p1" && r.date === "2026-07-01")
    .reduce((a, r) => a + r.room_revenue, 0);
  assert.notEqual(floatWay, OCC_P1_DAY1_REVENUE, "fixture no longer distinguishes the two routes");
  const d1 = DAYS.find((d) => d.property_id === "p1" && d.business_date === "2026-07-01");
  assert.equal(d1.occ_revenue, OCC_P1_DAY1_REVENUE);
  // gross_misc.misc_charge: 0.1 + 0.7 float-sums to 0.7999999999999999
  assert.notEqual(0.1 + 0.7, 0.8, "fixture no longer distinguishes the two routes");
  assert.equal(d1.gross_misc.misc_charge, 0.8);
});

// THE invariant. The Dashboard reads the cache when warm and the raw ledger when
// cold, so these two must be the same number — not close, the same.
const ROOM_COUNTS = { p1: 10, p2: 20 };
const liveMetrics = CalculationService.calculateOccupancyMetrics(OCC, ROOM_COUNTS);
const synthetic = buildSyntheticRows(DAYS);
const cachedMetrics = CalculationService.calculateOccupancyMetrics(synthetic.occRows, ROOM_COUNTS);

check("cached path and live path agree on revenue", () => {
  sameMoney(cachedMetrics.revenue, liveMetrics.revenue, "revenue");
});
check("cached path and live path agree on rooms sold and capacity", () => {
  assert.equal(cachedMetrics.roomsSold, liveMetrics.roomsSold, "roomsSold");
  assert.equal(cachedMetrics.capacity, liveMetrics.capacity, "capacity");
});

check("the property-rooms fallback is applied once per DAY, not once per row", () => {
  // Three occupancy rows for ONE date, none carrying an explicit inventory figure.
  // The per-row fallback bought three days of inventory (capacity 30), so occupancy
  // read 13.3% where the property was in fact 40% sold, and RevPAR read a third of
  // its true value. Nothing in the data looked wrong; the more complete the import,
  // the worse the understatement.
  const rows = [
    { property_id: "p1", date: "2026-07-01", room_revenue: 100, rooms_sold: 2, total_rooms: 0 },
    { property_id: "p1", date: "2026-07-01", room_revenue: 50, rooms_sold: 1, total_rooms: 0 },
    { property_id: "p1", date: "2026-07-01", room_revenue: 25, rooms_sold: 1, total_rooms: 0 },
  ];
  const m = CalculationService.calculateOccupancyMetrics(rows, { p1: 10 });
  assert.equal(m.capacity, 10, `three rows for one date bought ${m.capacity} rooms of inventory`);
  assert.ok(m.occupancy <= 1, `occupancy above 100%: ${m.occupancy}`);
  sameMoney(m.occupancy, 0.4, "occupancy");
  sameMoney(m.revpar, 17.5, "revpar");
});

check("an explicit total_rooms anywhere in a date beats the fallback", () => {
  const rows = [
    { property_id: "p1", date: "2026-07-01", room_revenue: 100, rooms_sold: 2, total_rooms: 88 },
    { property_id: "p1", date: "2026-07-01", room_revenue: 50, rooms_sold: 1, total_rooms: 0 },
  ];
  assert.equal(CalculationService.calculateOccupancyMetrics(rows, { p1: 10 }).capacity, 88);
});

check("per-property stats use the same per-day inventory rule as the portfolio total", () => {
  // Two copies of the capacity logic existed; the portfolio table and the portfolio
  // headline disagreed about the same property's occupancy.
  const perProp = CalculationService.calculatePerPropertyStats(OCC, [
    { id: "p1", name: "P1", rooms: 10 },
    { id: "p2", name: "P2", rooms: 20 },
  ]);
  const p1 = perProp.find((p) => p.property_id === "p1");
  assert.equal(p1.days, 2, `p1 spans 2 dates, reported ${p1.days}`);
  const p1Live = CalculationService.calculateOccupancyMetrics(
    OCC.filter((r) => r.property_id === "p1"),
    { p1: 10 },
  );
  sameMoney(p1.revenue, p1Live.revenue, "p1 revenue");
  assert.equal(D.toRate(p1.occupancy), D.toRate(p1Live.occupancy), "p1 occupancy");
  sameMoney(p1.revpar, p1Live.revpar, "p1 revpar");
});
check("cached path and live path agree on ADR", () => {
  sameMoney(cachedMetrics.adr, liveMetrics.adr, "adr");
});
check("cached path and live path agree on RevPAR", () => {
  sameMoney(cachedMetrics.revpar, liveMetrics.revpar, "revpar");
});
check("cached path and live path agree on occupancy", () => {
  assert.equal(
    D.toRate(cachedMetrics.occupancy),
    D.toRate(liveMetrics.occupancy),
    `occupancy: ${cachedMetrics.occupancy} vs ${liveMetrics.occupancy}`,
  );
});

check("cached path and live path agree on MoneyKept, field by field", () => {
  const range = { from: "2026-07-01", to: "2026-07-31" };
  const live = CalculationService.calculateMoneyKept(OCC, SRC, GROSS, PAY, EXP, [], range, null);
  const cached = CalculationService.calculateMoneyKept(
    synthetic.occRows, synthetic.srcRows, synthetic.grossRows, synthetic.payRows,
    synthetic.expenseRows, [], range, null,
  );
  for (const key of ["gross", "otaCommissions", "ccFees", "refunds", "operatingExpenses", "estimatedTaxes", "totalDeductions", "kept"]) {
    sameMoney(cached[key], live[key], `MoneyKept.${key} (cached vs live)`);
  }
});

check("only CARD_METHODS are charged a card processing fee", () => {
  // THE defect this section exists for. calculateMoneyKept derived card volume as
  // `total - cash - check`, so direct_bill, corpay, wire_transfer,
  // loyalty_certificate, loyalty_discount, vip_pass, other and closed_balance_folio
  // were all charged a credit-card fee. That overstates a deduction, which
  // understates the one number the widget exists to report.
  const kept = CalculationService.calculateMoneyKept(OCC, SRC, GROSS, PAY, EXP, [], RANGE, null);
  const cardVolume = D.fromCents(D.sumCents(PAY.flatMap((r) => CARD_METHODS.map((k) => r[k]))));
  sameMoney(cardVolume, PAY_CARD_VOLUME, "fixture card volume");
  sameMoney(kept.ccFees, D.fromCents(D.multiply(cardVolume, getCcFeeRate())), "ccFees basis");

  // And prove the fixture would have caught the old basis: $750 of direct_bill +
  // wire_transfer separates the two. Without this guard the assertion above would
  // pass on either implementation.
  const oldBasis = D.fromCents(
    D.sumCents(PAY.map((r) => r.total)) - D.sumCents(PAY.map((r) => r.cash)) - D.sumCents(PAY.map((r) => r.check)),
  );
  assert.notEqual(
    D.toCents(oldBasis),
    D.toCents(cardVolume),
    "fixture does not distinguish `total - cash - check` from the CARD_METHODS basis",
  );
  sameMoney(D.fromCents(D.toCents(oldBasis) - D.toCents(cardVolume)), 750, "non-card tender in the fixture");
});

check("calculatePaymentMetrics reports the same card basis and refunds as MoneyKept", () => {
  const pm = CalculationService.calculatePaymentMetrics(PAY);
  const kept = CalculationService.calculateMoneyKept(OCC, SRC, GROSS, PAY, EXP, [], RANGE, null);
  sameMoney(pm.cardTotal, PAY_CARD_VOLUME, "cardTotal");
  sameMoney(kept.ccFees, D.fromCents(D.multiply(pm.cardTotal, getCcFeeRate())), "ccFees vs cardTotal x rate");
  sameMoney(pm.refunds, kept.refunds, "refunds");
  sameMoney(pm.refunds, PAY_REFUNDS, "refund magnitude");
  assert.equal(
    cents(pm.netPaymentCollected),
    cents(pm.totalCollected) - cents(pm.refunds),
    "netPaymentCollected is not totalCollected - refunds to the cent",
  );
});

check("aggregation is idempotent (re-running yields identical rows)", () => {
  const again = aggregateDays({ occ: OCC, src: SRC, gross: GROSS, pay: PAY, exp: EXP });
  assert.deepEqual(again, DAYS, "second run differed from the first");
});

check("aggregateDays coerces string amounts from CSV imports", () => {
  const strung = aggregateDays({
    occ: [
      { property_id: "p9", date: "2026-07-01", room_revenue: "19.99", rooms_sold: "3", total_rooms: "10" },
      { property_id: "p9", date: "2026-07-01", room_revenue: "0.31", rooms_sold: "1", total_rooms: "0" },
    ],
  });
  sameMoney(strung[0].occ_revenue, 20.3, "string room_revenue");
  assert.equal(strung[0].occ_rooms_sold, 4, "string rooms_sold");
});

check("aggregateDays on empty input returns [] rather than throwing", () => {
  assert.deepEqual(aggregateDays(), []);
  assert.deepEqual(aggregateDays({}), []);
});

console.log("== §4 calculateProfitMetrics coerces, and reconciles with MoneyKept ==");


check("operating expenses survive STRING amounts (the concatenation bug)", () => {
  // Before the fix: `a + (e.amount || 0)` made the accumulator the string
  // "010.10.2", toCents() of which is not finite, which decimal.js maps to 0 — so
  // operating expenses vanished from operating profit entirely.
  const strung = [
    { property_id: "p1", expense_date: "2026-07-01", category: "utilities", amount: "10.1" },
    { property_id: "p1", expense_date: "2026-07-01", category: "utilities", amount: "0.2" },
  ];
  const m = CalculationService.calculateProfitMetrics(OCC, PAY, strung, [], RANGE);
  assert.equal(typeof m.operatingExpenses, "number", "operatingExpenses is not a number");
  sameMoney(m.operatingExpenses, 10.3, "operatingExpenses from strings");
});

check("payroll-category expenses excluded from operating expenses", () => {
  const m = CalculationService.calculateProfitMetrics(OCC, PAY, EXP, [], RANGE);
  sameMoney(m.operatingExpenses, 10.3, "operatingExpenses excludes the $500 payroll row");
});

check("profit metrics are all finite numbers", () => {
  const m = CalculationService.calculateProfitMetrics(OCC, PAY, EXP, RUNS, RANGE);
  for (const [k, v] of Object.entries(m)) {
    assert.ok(Number.isFinite(v), `${k} is not finite: ${v}`);
  }
});

check("the two profit entry points agree on the room-revenue component", () => {
  // UPDATED 2026-08-20. This used to assert profit.grossRevenue === kept.gross and
  // it passed — because calculateMoneyKept ignored the gross-charge ledger it was
  // handed and reported room revenue only, exactly like calculateProfitMetrics.
  // Agreeing by both being incomplete is not agreement. calculateMoneyKept now
  // routes through hotel.js#grossRevenueForPeriod, the same helper the dashboard
  // widget uses, so with GROSS rows present its gross is $1.10 higher here: the
  // misc_charge ($0.80) and food ($0.30) the owner also earned.
  //
  // The invariant worth pinning is that the two modules measure the SAME room
  // nights and that the extra dollars are fully explained by the ancillary ledger
  // — not that one silently drops a revenue stream to match the other.
  const profit = CalculationService.calculateProfitMetrics(OCC, PAY, EXP, RUNS, RANGE);
  const kept = CalculationService.calculateMoneyKept(OCC, SRC, GROSS, PAY, EXP, RUNS, RANGE, null);
  assert.equal(D.toCents(profit.grossRevenue), kept.grossBasis.roomCents, "room component must be identical");
  assert.equal(kept.grossBasis.cents, kept.grossBasis.roomCents + kept.grossBasis.ancillaryCents, "gross must be fully accounted for");
  assert.equal(kept.grossBasis.ancillaryCents, 110, `ancillary should be misc 0.80 + food 0.30, got ${kept.grossBasis.ancillaryCents}`);
  assert.equal(kept.grossBasis.basis, "total", "basis must be reported as total when gross rows are supplied");
  // And with no gross ledger the two are identical to the cent.
  const keptRoomOnly = CalculationService.calculateMoneyKept(OCC, SRC, [], PAY, EXP, RUNS, RANGE, null);
  sameMoney(profit.grossRevenue, keptRoomOnly.gross, "grossRevenue vs MoneyKept.gross on the room basis");
  assert.equal(keptRoomOnly.grossBasis.basis, "room");
});

check("committed payroll matches between the two entry points", () => {
  // UPDATED 2026-08-20. This used to assert profit.totalPayroll === sumCommittedPay(RUNS),
  // which encoded HALF a rule: both methods excluded payroll-category expense rows
  // from operating expenses (right — they would double-count a PayrollRun) and then
  // added them nowhere, so a contract cleaner filed under 'payroll' fell out of
  // totalCosts entirely and operating profit was overstated by its full amount.
  // EXP carries exactly such a $500 row.
  //
  // The invariant worth pinning is that the payroll line is committed runs PLUS
  // payroll-category expenses, and that the two entry points still agree — not that
  // one of them silently drops a real cost.
  const profit = CalculationService.calculateProfitMetrics(OCC, PAY, EXP, RUNS, RANGE);
  const kept = CalculationService.calculateMoneyKept(OCC, SRC, GROSS, PAY, EXP, RUNS, RANGE, null);
  sameMoney(profit.totalPayroll, kept.totalPayroll, "totalPayroll");
  const payrollExpenses = EXP
    .filter(e => String(e.category || "").toLowerCase() === "payroll")
    .reduce((acc, e) => acc + D.toCents(e.amount), 0);
  assert.ok(payrollExpenses > 0, "fixture must contain a payroll-category expense or this proves nothing");
  assert.equal(
    cents(profit.totalPayroll),
    cents(sumCommittedPay(RUNS)) + payrollExpenses,
    "totalPayroll must be committed runs + payroll-category expenses",
  );
});

check("totalCosts is exactly payroll + operating expenses", () => {
  const m = CalculationService.calculateProfitMetrics(OCC, PAY, EXP, RUNS, RANGE);
  assert.equal(cents(m.totalCosts), cents(m.totalPayroll) + cents(m.operatingExpenses));
});

check("operatingProfit is exactly netRevenue - totalCosts", () => {
  const m = CalculationService.calculateProfitMetrics(OCC, PAY, EXP, RUNS, RANGE);
  assert.equal(cents(m.operatingProfit), cents(m.netRevenue) - cents(m.totalCosts));
});

check("MoneyKept internal identity holds: gross - deductions = kept", () => {
  const k = CalculationService.calculateMoneyKept(OCC, SRC, GROSS, PAY, EXP, RUNS, RANGE, null);
  assert.equal(cents(k.kept), cents(k.gross) - cents(k.totalDeductions));
});

console.log("== §5 portfolio comparison diffs are cent-exact ==");

check("revenue/adr/revpar diffs equal the difference of the two sides", () => {
  const prev = [{ property_id: "p1", date: "2026-06-01", room_revenue: 0.1, rooms_sold: 1, total_rooms: 10 }];
  const c = CalculationService.calculatePortfolioComparison(OCC, prev, ROOM_COUNTS, []);
  for (const key of ["revenue", "adr", "revpar"]) {
    assert.equal(
      cents(c[key].diff),
      cents(c[key].current) - cents(c[key].previous),
      `${key}.diff is not current - previous to the cent`,
    );
  }
});

check("a zero-vs-zero comparison yields 0, not -0 or NaN", () => {
  const c = CalculationService.calculatePortfolioComparison([], [], ROOM_COUNTS, []);
  for (const key of ["revenue", "roomsSold", "occupancy", "adr", "revpar"]) {
    assert.ok(Number.isFinite(c[key].diff), `${key}.diff is not finite`);
    assert.equal(c[key].diff + 0, 0, `${key}.diff is not zero`);
  }
});

console.log("== §6 Action Center agrees with the Dashboard about the same month ==");

const AC = buildActionCenter({
  occRows: OCC,
  srcRows: SRC,
  payRows: PAY,
  expenses: EXP,
  payroll: RUNS.map((r) => ({ ...r, pay_period_start: "2026-07-05" })),
  roomCounts: ROOM_COUNTS,
  dateRange: RANGE,
  prevOccRows: [],
});

check("Action Center revenue equals CalculationService revenue", () => {
  sameMoney(AC.premise.revenue, liveMetrics.revenue, "premise.revenue");
});

check("Action Center card fees equal the Dashboard's card fees", () => {
  // The measured defect: actionCenter did `cardVolume * ccFee`, calculationService
  // did multiply(fromCents(cardTotalCents), ccFee). Same month, two figures.
  const kept = CalculationService.calculateMoneyKept(OCC, SRC, GROSS, PAY, EXP, [], RANGE, null);
  const expected = getCcFeeOnRefunds()
    ? D.fromCents(D.toCents(kept.ccFees) + D.toCents(kept.refundFees))
    : kept.ccFees;
  sameMoney(AC.premise.ccEstimated, expected, "ccEstimated vs MoneyKept ccFees(+refundFees)");
});

check("Action Center payroll equals sumCommittedPay for the same runs", () => {
  sameMoney(
    AC.premise.payrollTotal,
    D.fromCents(D.toCents(RUNS_COMMITTED) + D.toCents(500)),
    "payrollTotal (committed runs + payroll-category expenses)",
  );
});

check("Action Center refunds equal the Dashboard's refunds", () => {
  const kept = CalculationService.calculateMoneyKept(OCC, SRC, GROSS, PAY, EXP, [], RANGE, null);
  sameMoney(AC.premise.refunds, kept.refunds, "refunds");
});

check("every money figure in premise is a whole cent and finite", () => {
  const MONEY_KEYS = [
    "revenue", "adr", "revpar", "payrollTotal", "operatingExpenses", "expenseTotal",
    "otaCommission", "ccFees", "otaEstimated", "ccEstimated", "refunds", "oosLoss",
  ];
  for (const key of MONEY_KEYS) {
    const v = AC.premise[key];
    assert.ok(Number.isFinite(v), `premise.${key} is not finite: ${v}`);
    assert.equal(D.toCents(v) / 100, v, `premise.${key} is not a whole cent: ${v}`);
  }
});

check("every action's impact score is a whole cent (it orders the top-3 list)", () => {
  const all = [
    ...AC.buckets.fix, ...AC.buckets.investigate,
    ...AC.buckets.opportunity, ...AC.buckets.keepDoing,
  ];
  assert.ok(all.length > 0, "no action cards produced — fixture is not exercising the module");
  for (const a of all) {
    assert.ok(Number.isFinite(a.impact), `${a.key}: impact is not finite: ${a.impact}`);
    assert.equal(D.toCents(a.impact) / 100, a.impact, `${a.key}: impact is not a whole cent: ${a.impact}`);
  }
});

check("keepRate is a finite fraction, never Infinity or NaN", () => {
  assert.ok(Number.isFinite(AC.premise.keepRate), `keepRate: ${AC.premise.keepRate}`);
  assert.ok(AC.premise.keepRate <= 1, `keepRate above 1: ${AC.premise.keepRate}`);
  // A period that is entirely refunded used to divide by a zero base.
  const zero = buildActionCenter({ occRows: [], payRows: PAY, expenses: EXP, dateRange: RANGE });
  assert.equal(zero.premise.keepRate, 0, "zero-revenue period did not clamp keepRate to 0");
});

check("keepRate reconciles with the deductions it is derived from", () => {
  const p = AC.premise;
  const deductions =
    cents(p.otaCommission) + cents(p.ccFees) + cents(p.refunds) +
    cents(p.payrollTotal) + cents(p.operatingExpenses);
  // Quantised to basis points by divideRate, so compare at that precision rather
  // than asserting exact float equality on a division.
  const expected = 1 - D.fromRate(D.divideRate(D.fromCents(deductions), p.revenue));
  assert.equal(
    D.toRate(p.keepRate),
    D.toRate(expected),
    `keepRate ${p.keepRate} does not follow from the deductions shown alongside it`,
  );
});

check("Action Center is order-independent (rows may arrive in any order)", () => {
  const reversed = buildActionCenter({
    occRows: [...OCC].reverse(),
    srcRows: [...SRC].reverse(),
    payRows: [...PAY].reverse(),
    expenses: [...EXP].reverse(),
    payroll: RUNS.map((r) => ({ ...r, pay_period_start: "2026-07-05" })).reverse(),
    roomCounts: ROOM_COUNTS,
    dateRange: RANGE,
    prevOccRows: [],
  });
  assert.deepEqual(reversed.premise, AC.premise, "premise changed with input order");
});

check("Action Center built from the CACHE matches Action Center built live", () => {
  const fromCache = buildActionCenter({
    occRows: synthetic.occRows,
    srcRows: synthetic.srcRows,
    payRows: synthetic.payRows,
    expenses: synthetic.expenseRows,
    payroll: RUNS.map((r) => ({ ...r, pay_period_start: "2026-07-05" })),
    roomCounts: ROOM_COUNTS,
    dateRange: RANGE,
    prevOccRows: [],
  });
  for (const key of ["revenue", "payrollTotal", "operatingExpenses", "refunds", "ccEstimated"]) {
    sameMoney(fromCache.premise[key], AC.premise[key], `premise.${key} cached vs live`);
  }
});

console.log("== §7 the cc fee rate is read, not assumed ==");

check("getCcFeeRate returns a usable rate and multiply() applies it in cents", () => {
  const rate = getCcFeeRate();
  assert.ok(Number.isFinite(rate), `cc fee rate is not finite: ${rate}`);
  assert.ok(rate >= 0 && rate < 1, `cc fee rate outside 0..1: ${rate}`);
  // multiply(money, rate) must not be confused with money * count.
  assert.equal(D.multiply(100, 0.029), 290, "multiply(100, 0.029) should be 290 cents");
  assert.equal(D.multiply(19.99, 0.029), 58, "multiply rounds to the nearest cent");
});

console.log("");
console.log(`PASS ${pass}  FAIL ${failures.length}`);
console.log(`\n${failures.length === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
