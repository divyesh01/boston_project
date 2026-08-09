// Verification suite for the Owner Action engine (src/lib/actionCenter.js).
//
// Runs the REAL production module against synthetic fixture rows, pinning the
// engine's behaviour over the failure modes an owner will actually hit over the
// coming years:
//   - OOS down rooms -> "Fix Today" card weights lost revenue correctly
//   - revenue decline vs a complete prior window -> red fix fires
//   - PARTIAL prior window (delayed import) -> delta cards must NOT mislead
//   - payroll above the 20% guideline -> amber investigate fires
//   - refunds stored SIGNED (negative) -> refund magnitude stays correct
//   - channel mix -> OTA leak investigation + direct-book keep-doing quietly fire
//   - empty/null input -> no exceptions, sane zeros
//
// Fixture units follow the real DB: total_revenue in DOLLARS, rooms_sold and
// down_rooms in ROOM COUNTS, payment fields in dollars with refunds signed
// negative. (The engine's calculateOccupancyMetrics scales internally.)
//
// Expected numbers are derived by hand, not from the code, so a regression that
// changes the outputs fails loudly.
//
// Run: node scripts/verify-actioncenter.mjs

import { register } from "node:module";
register(new URL("./resolve-alias.mjs", import.meta.url));

// The module graph reads settings from localStorage; give Node a working shim.
const __store = new Map();
globalThis.localStorage ??= {
  getItem: (k) => (__store.has(k) ? __store.get(k) : null),
  setItem: (k, v) => __store.set(k, String(v)),
  removeItem: (k) => __store.delete(k),
  clear: () => __store.clear(),
};
globalThis.window ??= globalThis;
globalThis.document ??= { cookie: "", querySelectorAll: () => [], createElement: () => ({ style: {} }) };

const { buildActionCenter } = await import("../src/lib/actionCenter.js");

let failures = 0;
const check = (label, cond, extra = "") => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label} ${extra}`);
  }
};

const RANGE = { from: "2025-02-01", to: "2025-02-28" }; // 28 days
const ROOMS = { p1: 100 };

function dates(count, start = "2025-02-01") {
  const out = [];
  const t = Date.parse(start);
  for (let i = 0; i < count; i++) out.push(new Date(t + i * 864e5).toISOString().slice(0, 10));
  return out;
}

// Occupancy row; sold/down are ROOM COUNTS, total_revenue in dollars. Occupied
// rooms = sold - down (down rooms are out of service and produce no revenue).
function occ({ date, sold, down = 0, adr = 100, property_id = "p1" }) {
  const occupied = sold - down;
  return {
    property_id,
    date,
    rooms_sold: occupied,
    down_rooms: down,
    total_revenue: occupied * adr, // dollars
  };
}

function occSeries({ count = 28, sold = 80, down = 0, adr = 100, start = "2025-02-01" } = {}) {
  return dates(count, start).map((date) => occ({ date, sold, down, adr }));
}

function src({ date, source, gross }) {
  return { date, source, code: source, net_revenue: gross, stays: gross / 100 };
}

// Payment rows: visa in dollars, refund fields SIGNED negative (project convention).
function pay({ date, visa = 0, refund = 0 }) {
  return {
    date,
    visa,
    master: 0, amex: 0, discover: 0, cash: 0, check: 0, direct_bill: 0,
    closed_balance_folio: refund ? -refund : 0,
    loyalty_discount: 0,
  };
}

function expenseRow({ date, amount, category = "housekeeping", name = "Linen" }) {
  return { expense_date: date, expense_name: name, vendor: "CO", category, amount };
}

function payrollRun({ date, totalPay }) {
  return { pay_period_start: date, employee_name: "Jane", department: "Front Desk", pay_type: "hourly", total_pay: totalPay };
}

console.log("— smoke: empty/null input must not throw —");
{
  const m = buildActionCenter({});
  check("returns object", !!m && Array.isArray(m.top3));
  check("premise zeros", m.premise.revenue === 0 && m.premise.occupancy === 0);
  check("buckets empty", m.buckets.fix.length === 0 && m.buckets.investigate.length === 0);
}

console.log("\n— baseline healthy property —");
{
  const occRows = occSeries({ count: 28, sold: 80 }); // revenue 80*100*28 = 224,000
  const srcRows = [
    src({ date: "2025-02-01", source: "WALK-IN", gross: 168000 }),
    src({ date: "2025-02-01", source: "EXPEDIA", gross: 56000 }),
  ];
  const payRows = [pay({ date: "2025-02-15", visa: 1000 })];
  const expenses = [expenseRow({ date: "2025-02-05", amount: 500 })];
  const payroll = [payrollRun({ date: "2025-02-01", totalPay: 3000 })];

  const m = buildActionCenter({ occRows, srcRows, payRows, expenses, payroll, roomCounts: ROOMS, dateRange: RANGE });

  check("revenue = 80*100*28", Math.abs(m.premise.revenue - 224000) < 0.01, `got ${m.premise.revenue}`);
  check("occupancy = 0.8", Math.abs(m.premise.occupancy - 0.8) < 1e-9, `got ${m.premise.occupancy}`);
  check("adr = 100", Math.abs(m.premise.adr - 100) < 0.01, `got ${m.premise.adr}`);
  check("no prior window -> comparedToPrev false", m.meta.comparedToPrev === false);
  check("no occ-target alarm (0.8 > 0.6)", !m.buckets.fix.some((a) => a.key === "occ-target"));
  check("keepDoing direct present", m.buckets.keepDoing.some((a) => a.key === "direct"));
}

console.log("\n— OOS down rooms produce a red fix with correct math —");
{
  const downSeries = occSeries({ count: 28, sold: 80, down: 15 });
  const m = buildActionCenter({ occRows: downSeries, roomCounts: ROOMS, dateRange: RANGE });
  const card = m.buckets.fix.find((a) => a.key === "oos");
  check("oos fix present", !!card, `keys=${m.buckets.fix.map((a) => a.key)}`);
  const oosLoss = 15 * 28 * 100; // downNights(420) * adr(100)
  check("oosLoss = downNights * ADR", Math.abs(m.premise.oosLoss - oosLoss) < 1, `got ${m.premise.oosLoss}`);
  check("impact matches oosLoss", Math.abs(card.impact - oosLoss) < 1, `impact=${card.impact}`);
}

console.log("\n— payroll above guideline -> investigate —");
{
  const occM = occSeries({ count: 28, sold: 80 }); // revenue 224k
  const payroll = [payrollRun({ date: "2025-02-01", totalPay: 224000 * 0.24 })];
  const m = buildActionCenter({ occRows: occM, payroll, roomCounts: ROOMS, dateRange: RANGE });
  const card = m.buckets.investigate.find((a) => a.key === "payroll");
  check("payroll investigate fires", !!card, `keys=${m.buckets.investigate.map((a) => a.key)}`);
}

console.log("\n— revenue down vs FULL prior window -> red fix —");
{
  const occRows = occSeries({ count: 28, sold: 80 }); // 224k
  const prior = occSeries({ count: 28, sold: 95, start: "2025-01-04" }); // 266k -> down ~15.8%
  const m = buildActionCenter({ occRows, prevOccRows: prior, roomCounts: ROOMS, dateRange: RANGE });
  const card = m.buckets.fix.find((a) => a.key === "rev-drop");
  check("rev-drop fires", !!card, `keys=${m.buckets.fix.map((a) => a.key)}`);
  check("comparedToPrev true", m.meta.comparedToPrev === true);
}

console.log("\n— PARTIAL prior window must NOT fire deltas —");
{
  const occRows = occSeries({ count: 28, sold: 80 }); // 28 days current
  const prior = occSeries({ count: 4, sold: 10, start: "2025-01-25" }); // 4 days -> far < 50% of 28
  const m = buildActionCenter({ occRows, prevOccRows: prior, roomCounts: ROOMS, dateRange: RANGE });
  check("comparedToPrev false on partial", m.meta.comparedToPrev === false, `${m.meta.comparedToPrev}`);
  check("no rev-drop on partial", !m.buckets.fix.some((a) => a.key === "rev-drop"));
  check("no rev-up keepDoing on partial", !m.buckets.keepDoing.some((a) => a.key === "rev-up"));
}

console.log("\n— refunds computed correctly (signed) —");
{
  const payRows = [pay({ date: "2025-02-01", visa: 500, refund: 30 }), pay({ date: "2025-02-02", refund: 20 })];
  const m = buildActionCenter({ dateRange: RANGE, payRows });
  check("refunds = |sum signed| = 50", Math.abs(m.premise.refunds - 50) < 1e-6, `got ${m.premise.refunds}`);
  check("ccFees positive from visa", m.premise.ccFees > 0, `ccFees=${m.premise.ccFees}`);
}

console.log("\n— no OTA -> no ota-leak; direct keep-doing present —");
{
  const srcRows = [src({ date: "2025-02-01", source: "WALK-IN", gross: 100000 })];
  const m = buildActionCenter({ occRows: occSeries({ count: 28 }), srcRows, roomCounts: ROOMS, dateRange: RANGE });
  check("no ota-leak when no OTA", !m.buckets.investigate.some((a) => a.key === "ota-leak"));
  check("direct keep-doing present", m.buckets.keepDoing.some((a) => a.key === "direct"));
}

console.log("\n— multi-property portfolio sums without double counting capacity —");
{
  const p1 = dates(28, "2025-02-01").map((date) => occ({ date, sold: 80, property_id: "p1" }));
  const p2 = dates(28, "2025-02-01").map((date) => occ({ date, sold: 60, property_id: "p2" }));
  const m = buildActionCenter({ occRows: [...p1, ...p2], roomCounts: { p1: 100, p2: 150 }, dateRange: RANGE });
  // revenue = p1 (80*100*28=224000) + p2 (60*100*28=168000)
  check("portfolio revenue = 392000", Math.abs(m.premise.revenue - 392000) < 1, `got ${m.premise.revenue}`);
  // capacity = 28*100 + 28*150 = 7000; sold = 28*80 + 28*60 = 3920; occupancy 0.56
  check("portfolio occupancy 0.56", Math.abs(m.premise.occupancy - 0.56) < 1e-6, `got ${m.premise.occupancy}`);
}

console.log("\n— missing/invalid fields (null dates, negative, string amounts) must not throw —");
{
  const messy = [
    occ({ date: "2025-02-01", sold: 80 }),
    { date: null, rooms_sold: "x", total_revenue: null, down_rooms: undefined, property_id: "p1" },
    { rooms_sold: -5, total_revenue: "-100", down_rooms: "1", property_id: "p1" },
    { total_revenue: 5000, rooms_sold: 50, property_id: "p1" }, // no date
  ];
  const srcMessy = [src({ date: "2025-02-01", source: "WALK-IN", gross: 999 }), { net_revenue: 1, stays: "1" }];
  const payMessy = [pay({ date: "2025-02-01", visa: 100, refund: 5 }), { visa: "50" }, { date: null, visa: 10 }];
  const expMessy = [expenseRow({ date: "2025-02-05", amount: 100 }), { amount: "0" }];
  const m = buildActionCenter({ occRows: messy, srcRows: srcMessy, payRows: payMessy, expenses: expMessy, roomCounts: ROOMS, dateRange: RANGE });
  check("no throw on messy rows", !!m);
  check("refunds magnitude is sane", m.premise.refunds >= 0 && Number.isFinite(m.premise.refunds));
  check("keepRate finite", Number.isFinite(m.premise.keepRate));
}

console.log("\n— duplicate rows (double import) still produce finite, non-negative numbers —");
{
  const base = occSeries({ count: 28, sold: 80 });
  const m = buildActionCenter({ occRows: [...base, ...base], roomCounts: ROOMS, dateRange: RANGE });
  check("duplicated revenue is finite", Number.isFinite(m.premise.revenue) && m.premise.revenue > 0);
  check("occupancy still bounded", m.premise.occupancy >= 0 && m.premise.occupancy <= 1.001, `got ${m.premise.occupancy}`);
}

console.log("\n— actual OTA/CC invoices beat the rate-card estimate (no double charge) —");
{
  const occRows = occSeries({ count: 28, sold: 80 }); // revenue 224k
  const srcRows = [src({ date: "2025-02-01", source: "EXPEDIA", gross: 300000 })];
  const payRows = [pay({ date: "2025-02-15", visa: 100000 })];
  const expenses = [
    expenseRow({ date: "2025-02-05", amount: 12000, category: "ota_commission" }),
    expenseRow({ date: "2025-02-10", amount: 5000, category: "credit_card_fees" }),
  ];
  const m = buildActionCenter({ occRows, srcRows, payRows, expenses, roomCounts: ROOMS, dateRange: RANGE });

  // Derived estimates would be: OTA 300000*0.15 = 45000; CC fees 100000*0.025 = 2500.
  // With actual rows present, the actual amounts (12000 / 5000) must win and the
  // estimates must be discarded — charging both would double the deduction.
  check("ota uses ACTUAL 12000", Math.abs(m.premise.otaCommission - 12000) < 1e-6, `got ${m.premise.otaCommission}`);
  check("cc uses ACTUAL 5000", Math.abs(m.premise.ccFees - 5000) < 1e-6, `got ${m.premise.ccFees}`);
  check("estimated OTA still visible for the OTA-leak card", m.premise.otaEstimated > 12000);
  check("operatingExpenses excludes ota/cc rows", m.premise.operatingExpenses === 0, `got ${m.premise.operatingExpenses}`);
}

console.log("\n— no actual rows: rate-card estimate stands in —");
{
  const occRows = occSeries({ count: 28, sold: 80 });
  const srcRows = [src({ date: "2025-02-01", source: "EXPEDIA", gross: 300000 })];
  const payRows = [pay({ date: "2025-02-15", visa: 100000 })];
  const m = buildActionCenter({ occRows, srcRows, payRows, roomCounts: ROOMS, dateRange: RANGE });
  check("commission estimated ~45000", Math.abs(m.premise.otaCommission - 45000) < 1e-6, `got ${m.premise.otaCommission}`);
  check("cc fees estimated ~2500", Math.abs(m.premise.ccFees - 2500) < 1e-6, `got ${m.premise.ccFees}`);
}

console.log("\n— summary —");
console.log(failures ? `FAIL: ${failures} check(s) failed` : "PASS: all scenarios correct");
process.exit(failures ? 1 : 0);