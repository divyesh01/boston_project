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
// Fixture units follow the real DB: room_revenue / total_revenue in DOLLARS,
// rooms_sold and down_rooms in ROOM COUNTS, payment fields in dollars with refunds
// signed negative. (The engine's calculateOccupancyMetrics scales internally.)
// See the note on occ() for why room_revenue is the field that matters.
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
let checks = 0;
// `cond` may be a boolean OR a thunk. A thunk that throws is recorded as a
// FAILURE rather than killing the process.
//
// WHY: this suite used to dereference `card.impact` straight after checking that
// `card` existed. When the card was missing (it was — see the occ() note) the
// TypeError terminated the run at section 3, so sections 4 through 14 never
// executed and their state was unknown while the summary line never printed. A
// verification suite that stops at the first surprise hides more than it reports.
const check = (label, cond, extra = "") => {
  checks++;
  let ok = false;
  let thrown = "";
  try {
    ok = typeof cond === "function" ? !!cond() : !!cond;
  } catch (err) {
    ok = false;
    thrown = ` threw ${err?.name || "Error"}: ${err?.message || err}`;
  }
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label} ${extra}${thrown}`);
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

// Occupancy row; sold/down are ROOM COUNTS, revenue in dollars. Occupied rooms =
// sold - down (down rooms are out of service and produce no revenue).
//
// FIELD CHOICE — this fixture used to write only `total_revenue`, and the engine
// reads `room_revenue`, so every revenue-derived assertion in this suite silently
// measured zero: revenue 0, ADR 0, and therefore no oos card and no direct
// keep-doing card. Four checks failed and a fifth crashed on `card.impact` of an
// absent card. The engine is the correct side: src/lib/calculationService.js
// (calculateOccupancyMetrics, calculatePerPropertyStats) and actionCenter's own
// weekend/day-rate paths all read `room_revenue`, and the cent-exact revenue
// invariant in scripts/probe-financial-invariant.mjs pins
// sum(OccupancyDay.room_revenue) = $1,011,258.67 as the ROOM revenue derivation.
//
// Both columns exist in base44/entities/OccupancyDay.jsonc, so both are populated
// here — with DIFFERENT values on purpose. total_revenue carries an extra
// `other_room_revenue` per night, so if anyone ever repoints the engine at
// total_revenue the revenue assertions below fail instead of drifting quietly.
function occ({ date, sold, down = 0, adr = 100, other = 7, property_id = "p1" }) {
  const occupied = sold - down;
  const roomRevenue = occupied * adr;
  return {
    property_id,
    date,
    rooms_sold: occupied,
    down_rooms: down,
    room_revenue: roomRevenue,              // what the engine reads
    other_room_revenue: other,
    total_revenue: roomRevenue + other,     // deliberately NOT equal to room_revenue
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

// Payroll run. `status` is explicit because only approved/paid runs are committed
// money (src/lib/payrollCalc.js COMMITTED_PAYROLL_STATUSES) — a run with no status
// is treated as a draft and must not move any profit figure. This fixture used to
// omit the field entirely, which made "payroll above guideline -> investigate"
// seed a draft run and then assert that a draft moves the number.
function payrollRun({ date, totalPay, status = "paid" }) {
  return { pay_period_start: date, employee_name: "Jane", department: "Front Desk", pay_type: "hourly", total_pay: totalPay, payroll_status: status };
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
  check("impact matches oosLoss", () => Math.abs(card.impact - oosLoss) < 1, `impact=${card?.impact}`);
}

console.log("\n— payroll above guideline -> investigate —");
{
  const occM = occSeries({ count: 28, sold: 80 }); // revenue 224k
  const payroll = [payrollRun({ date: "2025-02-01", totalPay: 224000 * 0.24 })];
  const m = buildActionCenter({ occRows: occM, payroll, roomCounts: ROOMS, dateRange: RANGE });
  const card = m.buckets.investigate.find((a) => a.key === "payroll");
  check("payroll investigate fires", !!card, `keys=${m.buckets.investigate.map((a) => a.key)}`);

  // The negative case for the same guideline: an identical run still in draft is
  // not committed money, so it must not raise a card. Without this, a half-typed
  // payroll entry would put an amber alarm on the owner's home screen.
  const draft = [payrollRun({ date: "2025-02-01", totalPay: 224000 * 0.24, status: "draft" })];
  const mDraft = buildActionCenter({ occRows: occM, payroll: draft, roomCounts: ROOMS, dateRange: RANGE });
  check("a DRAFT run above the guideline does not fire",
    !mDraft.buckets.investigate.some((a) => a.key === "payroll"),
    `keys=${mDraft.buckets.investigate.map((a) => a.key)}`);

  // And payroll from a different month must not be charged against this month.
  const stale = [payrollRun({ date: "2024-11-01", totalPay: 224000 * 0.9 })];
  const mStale = buildActionCenter({ occRows: occM, payroll: stale, roomCounts: ROOMS, dateRange: RANGE });
  check("payroll outside the window does not fire",
    !mStale.buckets.investigate.some((a) => a.key === "payroll"),
    `keys=${mStale.buckets.investigate.map((a) => a.key)}`);
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

console.log("\n— duplicate rows (double import) stay finite, and become VISIBLE —");
{
  const base = occSeries({ count: 28, sold: 80 });
  const single = buildActionCenter({ occRows: base, roomCounts: ROOMS, dateRange: RANGE });
  const m = buildActionCenter({ occRows: [...base, ...base], roomCounts: ROOMS, dateRange: RANGE });
  const rate = (x) => Math.round(x * 10000);

  check("duplicated revenue is finite", Number.isFinite(m.premise.revenue) && m.premise.revenue > 0);
  check(
    "occupancy is finite and non-negative",
    Number.isFinite(m.premise.occupancy) && m.premise.occupancy >= 0,
    `got ${m.premise.occupancy}`,
  );

  // WHY THIS NO LONGER ASSERTS occupancy <= 1 (changed 2026-08-20)
  // ───────────────────────────────────────────────────────────────────────────────
  // It used to, and it passed — but only because the defect it sat next to cancelled
  // itself out. calculateOccupancyMetrics applied the "this property has 100 rooms"
  // fallback ONCE PER ROW, so a doubled ledger also bought a doubled month of
  // inventory: 56 rows x 100 = 5600 room-nights for a 28-day February at a 100-room
  // hotel. Rooms sold doubled and capacity doubled in lockstep, so occupancy came out
  // 0.80 — indistinguishable from a clean single import. The old check was asserting
  // the PRESENCE of the defect, not a property of correct behaviour; note that these
  // fixture rows carry no total_rooms, and giving them one makes the bound hold for
  // real reasons (both sides double, 0.80 again).
  //
  // Physical inventory belongs to the DAY: 28 days x 100 rooms is 2800 room-nights
  // however many times the night-audit report was imported. So a doubled ledger now
  // reads 160% occupancy, which is the honest answer and the only visible evidence
  // the import ran twice. Silently absorbing duplicates into capacity is worse than
  // showing an impossible number, because it leaves nothing for anyone to notice.
  //
  // BEST OUTCOME NOTE: the two assertions below are strictly STRONGER than the bound
  // they replace — they pin the exact relationship (double the rows, double the
  // occupancy, same capacity) instead of a range, so a future change that re-absorbs
  // duplicates into inventory fails here rather than passing quietly.
  check(
    "a double import doubles occupancy instead of hiding inside capacity",
    rate(m.premise.occupancy) === 2 * rate(single.premise.occupancy) && m.premise.occupancy > 1,
    `single ${single.premise.occupancy}, doubled ${m.premise.occupancy}`,
  );
  check(
    "capacity is per-day, so it does not grow with row count",
    m.premise.capacity === single.premise.capacity,
    `single ${single.premise.capacity}, doubled ${m.premise.capacity}`,
  );
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

  // net_revenue $300000 is POST-commission NET (gross-up model): EXPEDIA (15%)
  // grosses up to $352,941.18, so the derived OTA commission = gross - net =
  // $52,941.18; CC fees = 100000*0.025 = 2500. With actual rows present, the
  // actual amounts (12000 / 5000) must win and the estimates must be discarded —
  // charging both would double the deduction.
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
  // net $300000 grosses up to $352,941.18 at 15%; commission = gross - net = $52,941.18.
  check("commission estimated 52941.18 (gross-up model)", Math.abs(m.premise.otaCommission - 52941.18) < 0.005, `got ${m.premise.otaCommission}`);
  check("cc fees estimated ~2500", Math.abs(m.premise.ccFees - 2500) < 1e-6, `got ${m.premise.ccFees}`);
}

console.log("\n— summary —");
console.log(`\n${failures === 0 ? "PASSED" : "FAILED"}: ${checks - failures} passed, ${failures} failed`);
console.log(failures ? `FAIL: ${failures} check(s) failed` : "PASS: all scenarios correct");
process.exit(failures ? 1 : 0);
