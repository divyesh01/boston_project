// Transaction analytics — every rollup the transaction pages need, in one place.
//
// Pure functions over already-loaded rows: no DB access, no React. That keeps
// the math testable headlessly and stops a fifth copy of aggregation logic from
// appearing in a page component.
//
// Money is summed through decimal.js's integer-cents helpers, not by adding
// floats. With 16,921 rows, float drift is large enough to break agreement with
// the source file's own trailer checksums.
import { toCents, fromCents, sumCents } from "@/lib/decimal";
import { LEDGER_SIDE_CHARGE, LEDGER_SIDE_PAYMENT, displayEmployee, classifyAccount } from "@/lib/transactionNorm";

const sumAmount = (rows) => fromCents(sumCents(rows.map((r) => r.amount)));

export const chargeRows = (rows) => rows.filter((r) => r.ledger_side === LEDGER_SIDE_CHARGE);
export const paymentRows = (rows) => rows.filter((r) => r.ledger_side === LEDGER_SIDE_PAYMENT);

// ---------------------------------------------------------------------------
// Time bucketing
//
// Buckets are derived from the "YYYY-MM-DD" string, never from `new Date()`.
// Parsing a date-only string as a Date applies UTC, which shifts the day
// backwards for anyone west of Greenwich and would silently move transactions
// into the previous bucket.
// ---------------------------------------------------------------------------
export const GRAINS = [
  ["daily", "Daily"],
  ["weekly", "Weekly"],
  ["monthly", "Monthly"],
];

const MONTH_LABEL = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// ISO week start (Monday) for a YYYY-MM-DD string, returned in the same format.
export function weekStart(dateStr) {
  const d = String(dateStr || "").slice(0, 10);
  const [y, m, day] = d.split("-").map(Number);
  if (!y || !m || !day) return d;
  const utc = new Date(Date.UTC(y, m - 1, day));
  const dow = (utc.getUTCDay() + 6) % 7;            // Mon=0 … Sun=6
  utc.setUTCDate(utc.getUTCDate() - dow);
  return utc.toISOString().slice(0, 10);
}

export function bucketOf(dateStr, grain) {
  const d = String(dateStr || "").slice(0, 10);
  if (grain === "monthly") return d.slice(0, 7);     // YYYY-MM
  if (grain === "weekly") return weekStart(d);
  return d;
}

export function bucketLabel(bucket, grain) {
  if (!bucket) return "";
  if (grain === "monthly") {
    const [y, m] = bucket.split("-").map(Number);
    return `${MONTH_LABEL[(m || 1) - 1]} ${y}`;
  }
  const [, m, d] = bucket.split("-").map(Number);
  const base = `${MONTH_LABEL[(m || 1) - 1]} ${d}`;
  return grain === "weekly" ? `Wk of ${base}` : base;
}

// ---------------------------------------------------------------------------
// Core rollups
// ---------------------------------------------------------------------------

// Headline figures for a set of rows. `revenue` counts ONLY the charge side —
// see transactionNorm for why summing both sides overstates by ~31%.
export function summarize(rows = []) {
  const charges = chargeRows(rows);
  const payments = paymentRows(rows);
  const revenue = sumAmount(charges);
  const collected = sumAmount(payments);
  const days = new Set(charges.map((r) => String(r.date || "").slice(0, 10))).size;

  return {
    revenue,
    collected,
    chargeCount: charges.length,
    paymentCount: payments.length,
    txnCount: rows.length,
    avgTicket: charges.length ? revenue / charges.length : 0,
    days,
    avgPerDay: days ? revenue / days : 0,
    folios: new Set(rows.map((r) => r.folio_number).filter(Boolean)).size,
    guests: new Set(rows.map((r) => r.confirmation_number).filter(Boolean)).size,
  };
}

// Time series at the requested grain. Returns ascending buckets with both
// ledger sides, so one pass feeds every chart on the page.
export function seriesByGrain(rows = [], grain = "daily") {
  const map = new Map();
  for (const r of rows) {
    const b = bucketOf(r.date, grain);
    if (!b) continue;
    let e = map.get(b);
    if (!e) { e = { bucket: b, charges: [], payments: [] }; map.set(b, e); }
    (r.ledger_side === LEDGER_SIDE_PAYMENT ? e.payments : e.charges).push(r);
  }
  return [...map.values()]
    .sort((a, b) => (a.bucket < b.bucket ? -1 : 1))
    .map((e) => ({
      bucket: e.bucket,
      name: bucketLabel(e.bucket, grain),
      revenue: sumAmount(e.charges),
      collected: sumAmount(e.payments),
      txns: e.charges.length + e.payments.length,
      avgTicket: e.charges.length ? sumAmount(e.charges) / e.charges.length : 0,
    }));
}

// Group by an arbitrary field, ranked by revenue desc.
export function rankBy(rows = [], field, { limit = 0 } = {}) {
  const map = new Map();
  for (const r of rows) {
    const k = r[field] === undefined || r[field] === null || r[field] === "" ? "(none)" : String(r[field]);
    let e = map.get(k);
    if (!e) { e = { key: k, rows: [] }; map.set(k, e); }
    e.rows.push(r);
  }
  const out = [...map.values()]
    .map((e) => ({ name: e.key, value: sumAmount(chargeRows(e.rows)), count: e.rows.length, rows: e.rows }))
    .sort((a, b) => b.value - a.value);
  return limit ? out.slice(0, limit) : out;
}

// Revenue mix for donut/pie charts — {name, value} is UniversalChart's shape.
export function revenueMix(rows = [], field = "charge_category") {
  return rankBy(rows, field).map(({ name, value }) => ({ name, value }));
}

// Payment-method mix from the settlement side.
export function paymentMix(rows = []) {
  const map = new Map();
  for (const r of paymentRows(rows)) {
    const k = r.payment_method || r.transaction_description || "Other";
    map.set(k, (map.get(k) || 0) + toCents(r.amount));
  }
  return [...map.entries()]
    .map(([name, cents]) => ({ name, value: fromCents(cents) }))
    .sort((a, b) => b.value - a.value);
}

// ---------------------------------------------------------------------------
// Employees
// ---------------------------------------------------------------------------

// One row per username, ranked by revenue. System/automation accounts are
// excluded by default: they post more than any human and would otherwise top
// every leaderboard. They are never excluded from revenue totals — only from
// people comparisons.
export function employeeStats(rows = [], { includeSystem = false } = {}) {
  const map = new Map();
  for (const r of rows) {
    const u = r.username || "";
    const cls = r.account_class || classifyAccount(u);
    if (!includeSystem && cls === "system") continue;
    let e = map.get(u);
    if (!e) { e = { username: u, label: r.employee_label || displayEmployee(u), account_class: cls, rows: [] }; map.set(u, e); }
    e.rows.push(r);
  }
  return [...map.values()]
    .map((e) => ({ ...e, ...summarize(e.rows) }))
    .sort((a, b) => b.revenue - a.revenue);
}

// Head-to-head for exactly two employees, with per-metric deltas.
export function compareEmployees(rows = [], usernameA, usernameB, grain = "monthly") {
  const rowsA = rows.filter((r) => r.username === usernameA);
  const rowsB = rows.filter((r) => r.username === usernameB);
  const a = { username: usernameA, label: displayEmployee(usernameA), account_class: classifyAccount(usernameA), ...summarize(rowsA) };
  const b = { username: usernameB, label: displayEmployee(usernameB), account_class: classifyAccount(usernameB), ...summarize(rowsB) };

  const METRICS = [
    ["revenue", "Revenue written"],
    ["collected", "Payments taken"],
    ["chargeCount", "Charges posted"],
    ["avgTicket", "Average ticket"],
    ["days", "Active days"],
    ["avgPerDay", "Revenue per active day"],
    ["folios", "Folios touched"],
  ];

  // Comparing across account classes is usually meaningless — an on-property
  // clerk and a contact-centre agent do different jobs. Flag it, don't block it.
  const mismatch = a.account_class !== b.account_class;

  const sA = seriesByGrain(rowsA, grain);
  const sB = seriesByGrain(rowsB, grain);
  const buckets = [...new Set([...sA, ...sB].map((p) => p.bucket))].sort();
  const series = buckets.map((bk) => ({
    name: bucketLabel(bk, grain),
    [a.label]: sA.find((p) => p.bucket === bk)?.revenue || 0,
    [b.label]: sB.find((p) => p.bucket === bk)?.revenue || 0,
  }));

  return {
    a,
    b,
    mismatch,
    series,
    metrics: METRICS.map(([key, label]) => ({
      key,
      label,
      a: a[key],
      b: b[key],
      delta: (a[key] || 0) - (b[key] || 0),
      pct: b[key] ? ((a[key] - b[key]) / Math.abs(b[key])) * 100 : null,
    })),
  };
}

// ---------------------------------------------------------------------------
// Period comparison (multi-month / period-over-period)
// ---------------------------------------------------------------------------
export function comparePeriods(rows = [], periodA, periodB) {
  const inP = (r, p) => {
    const d = String(r.date || "").slice(0, 10);
    return d >= p.from && d <= p.to;
  };
  const a = summarize(rows.filter((r) => inP(r, periodA)));
  const b = summarize(rows.filter((r) => inP(r, periodB)));
  const METRICS = [
    ["revenue", "Revenue"],
    ["collected", "Collected"],
    ["chargeCount", "Charges"],
    ["avgTicket", "Avg ticket"],
    ["avgPerDay", "Revenue / day"],
  ];
  return {
    a,
    b,
    metrics: METRICS.map(([key, label]) => ({
      key,
      label,
      a: a[key],
      b: b[key],
      delta: (a[key] || 0) - (b[key] || 0),
      pct: b[key] ? ((a[key] - b[key]) / Math.abs(b[key])) * 100 : null,
    })),
  };
}

// Month-by-month table for the multi-month view.
export function monthlyBreakdown(rows = []) {
  return seriesByGrain(rows, "monthly");
}

// ---------------------------------------------------------------------------
// Card processing fees
//
// The one cost this ledger can attribute on its own. Channel/OTA commissions
// cannot: the export has no channel column at all (Outlet Name, Group Name and
// House Account Name are empty on every row), so there is nothing to join a
// commission rate to. Card fees are different — the settlement side names its
// own instrument, so a card fee is a direct multiplication.
//
// `feeRate` is passed in rather than read from settings here, to keep this
// module free of localStorage and testable headlessly.
// ---------------------------------------------------------------------------
export function cardFeeBreakdown(rows = [], feeRate = 0, { byEmployee = false } = {}) {
  const cards = paymentRows(rows).filter((r) => r.payment_method === "Card");
  const settled = sumAmount(cards);
  const rate = Number(feeRate) || 0;
  const fee = fromCents(Math.round(toCents(settled) * rate));

  const result = {
    rate,
    settled,
    fee,
    net: fromCents(toCents(settled) - toCents(fee)),
    count: cards.length,
    byEmployee: [],
  };

  if (byEmployee) {
    const map = new Map();
    for (const r of cards) {
      const u = r.username || "";
      let e = map.get(u);
      if (!e) { e = { username: u, label: r.employee_label || displayEmployee(u), cents: 0, count: 0 }; map.set(u, e); }
      e.cents += toCents(r.amount);
      e.count += 1;
    }
    result.byEmployee = [...map.values()]
      .map((e) => ({
        username: e.username,
        label: e.label,
        settled: fromCents(e.cents),
        fee: fromCents(Math.round(e.cents * rate)),
        count: e.count,
      }))
      .sort((a, b) => b.settled - a.settled);
  }

  return result;
}
