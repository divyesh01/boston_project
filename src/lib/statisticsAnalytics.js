// Hotel Statistics analytics — reading HotelMetric snapshots.
//
// The mental model matters here, because this table is not shaped like the rest
// of the app. Everything else is a timeline: one row per day, sum them up. A
// Hotel Statistics export is a SNAPSHOT: one business date described from five
// angles at once — what happened today, month to date, year to date, and the
// same two windows a year earlier. Roughly 530 rows arrive per import and they
// all describe a single day.
//
// Two consequences drive every function below:
//
//   1. You never sum across periods. "Room Sold" actual_today (62) and mtd (155)
//      are the same rooms counted over different windows; adding them is
//      meaningless. Pick a period, then read across metrics.
//   2. You never sum across snapshots either. Two consecutive days' MTD figures
//      overlap almost entirely. A trend line is built from actual_today only.
//
// Getting either wrong produces numbers that look plausible and are wrong, which
// is worse than a visible error, so the accessors here are deliberately narrow.

import { sumCents, toCents, fromCents } from '@/lib/decimal';

export const PERIODS = [
  ["actual_today", "Today", "The business date itself"],
  ["mtd", "Month to date", "1st of the month through the business date"],
  ["ytd", "Year to date", "1 January through the business date"],
];

export const LY_OF = { mtd: "ly_mtd", ytd: "ly_ytd" };

export const PERIOD_LABEL = {
  actual_today: "Today",
  mtd: "Month to date",
  ytd: "Year to date",
  ly_mtd: "Last year, month to date",
  ly_ytd: "Last year, year to date",
};

// ─── Section vocabulary ───
//
// The canonical section names, exactly as they appear in the vendor export. The
// parser derives section names from content, so the ORDER below is a presentation
// preference, not a contract — unknown sections fall to the end in their natural
// order rather than being dropped. The NAMES, however, are a contract.
//
// Exported because a mistyped section is INVISIBLE: composition() below simply
// matches nothing and returns [], which sums to $0.00 and reads like "this
// property earned nothing" rather than "you spelled the section wrong". That is
// precisely how financialReconciliation.js came to pass 'revenue' (lowercase) and
// silently valued the whole statistics revenue leg at $0.00 — see BRAIN_FINANCE.md.
// Use these constants at call sites instead of bare string literals.
export const STAT_SECTIONS = Object.freeze({
  ROOM_INVENTORY: "Room Inventory",
  OCCUPANCY: "Occupancy",
  ADR_REVPAR: "ADR & RevPAR",
  REVENUE: "Revenue",
  TAX: "Tax",
  PAYMENTS: "Payments",
  GUESTS: "Guests",
  RESERVATIONS: "Reservations",
  FORECAST: "Forecast",
  GENERAL: "General",
});

// Derived from STAT_SECTIONS rather than repeated, so the display order and the
// canonical vocabulary cannot drift apart — maintaining the same names in two
// hand-written lists is the defect class this whole block exists to prevent.
const SECTION_ORDER = Object.values(STAT_SECTIONS);

export function orderSections(names) {
  const known = SECTION_ORDER.filter((s) => names.includes(s));
  const rest = names.filter((n) => !SECTION_ORDER.includes(n)).sort();
  return [...known, ...rest];
}

// ─── Snapshot selection ───

export function snapshotDates(rows = []) {
  const seen = new Set();
  for (const r of rows) {
    const d = String(r.business_date || "").slice(0, 10);
    if (d) seen.add(d);
  }
  return [...seen].sort();
}

// All rows belonging to one business date. Defaults to the most recent.
export function snapshotFor(rows = [], date = "") {
  const dates = snapshotDates(rows);
  const target = date || dates[dates.length - 1] || "";
  if (!target) return { date: "", rows: [] };
  return { date: target, rows: rows.filter((r) => String(r.business_date || "").slice(0, 10) === target) };
}

// ─── Value access ───
//
// Metric names come straight from the PMS and are matched case-insensitively so
// a vendor changing "Room Sold" to "Rooms Sold" is a miss rather than a crash.
export function indexSnapshot(rows = []) {
  const map = new Map();
  for (const r of rows) {
    if (r.is_total) continue;            // section aggregates: kept in the data, excluded from lookups
    map.set(`${String(r.metric_name || "").toLowerCase()}|${r.period}`, r);
  }
  return map;
}

export function metricValue(index, name, period = "actual_today") {
  const hit = index.get(`${String(name).toLowerCase()}|${period}`);
  return hit && hit.value !== null && hit.value !== undefined ? hit.value : null;
}

// First name that resolves, so a metric can be looked up under any of the
// aliases different PMS versions use without the caller writing fallback chains.
export function firstValue(index, names, period = "actual_today") {
  for (const n of names) {
    const v = metricValue(index, n, period);
    if (v !== null) return v;
  }
  return null;
}

// ─── Prior-year availability ───
//
// The sharpest trap in this format. Last-year columns are always present and are
// mostly 0.00 — the property has no prior-year history loaded in the PMS, not a
// year in which it earned nothing. Treating those zeros as real makes every
// year-over-year figure read "+100%": a fabricated result stated confidently.
//
// It is not uniform, either. In the real exports the only metrics carrying
// non-zero last-year values are room-inventory counts (Total Rooms, Clean, Rooms
// Available To Sell); every revenue, occupancy, ADR and guest metric is zero. So
// "does this file have prior-year data" has no useful single answer, and the
// question is only ever asked per metric.
//
// `yoy` is therefore the gate: it returns null whenever the prior-year figure is
// missing or zero, so a comparison appears only where there is something real to
// compare against. Callers never need to pre-check.
export function priorYearMetrics(rows = []) {
  const names = new Set();
  for (const r of rows) {
    if (r.period !== "ly_mtd" && r.period !== "ly_ytd") continue;
    if (r.value === null || Number(r.value) === 0) continue;
    names.add(r.metric_name);
  }
  return [...names].sort();
}

export function hasPriorYear(rows = []) {
  return priorYearMetrics(rows).length > 0;
}

export function yoy(index, name, period) {
  const lyPeriod = LY_OF[period];
  if (!lyPeriod) return null;
  const now = metricValue(index, name, period);
  const then = metricValue(index, name, lyPeriod);
  if (now === null || then === null || then === 0) return null;
  return { now, then, delta: now - then, pct: ((now - then) / Math.abs(then)) * 100 };
}

// ─── Headline metrics ───
//
// Alias lists rather than single names: HotelKey ships several occupancy and ADR
// variants and which one is "the" number differs by property configuration. The
// order is the house preference — excluding comp/house-use rooms first, since
// that is the figure that reflects rooms actually sold to paying guests.
const HEADLINE = [
  {
    key: "occupancy",
    label: "Occupancy",
    unit: "percentage",
    names: [
      "Occupancy Excluding Down Comp House Use Rooms",
      "Occupancy Excluding Down Rooms and Including Comp House Use Rooms",
      "Occupancy Including Down Comp House Use Rooms",
      "Occupancy",
    ],
    hint: "Excludes out-of-order, comp and house-use rooms",
  },
  {
    key: "adr",
    label: "ADR",
    unit: "currency",
    names: ["ADR Excluding Comp House Use Rooms", "ADR Including Comp House Use Rooms", "ADR"],
    hint: "Average rate on rooms sold",
  },
  {
    key: "revpar",
    label: "RevPAR",
    unit: "currency",
    names: ["RevPAR", "RevPar With Out Of Order Rooms"],
    hint: "Revenue per available room",
  },
  {
    key: "sold",
    label: "Rooms sold",
    unit: "count",
    names: ["Room Sold", "Rooms Sold Excluding Comp House Use Rooms"],
    hint: "Rooms occupied on the business date",
  },
  {
    key: "revenue",
    label: "Room revenue",
    unit: "currency",
    names: ["Taxable Room Revenue"],
    extra: ["Exempt Room Revenue"],
    hint: "Taxable plus exempt room revenue",
  },
  {
    key: "guests",
    label: "Guests",
    unit: "count",
    names: ["Total Guests"],
    hint: "Adults plus children in house",
  },
];

export function headline(rows = [], period = "actual_today") {
  const index = indexSnapshot(rows);
  return HEADLINE.map((m) => {
    let value = firstValue(index, m.names, period);
    // Room revenue is split taxable/exempt in the export; the owner wants the total.
    if (m.extra && value !== null) {
      for (const name of m.extra) {
        const v = metricValue(index, name, period);
        if (v !== null) value += v;
      }
    }
    // Per-metric, not per-file: yoy already returns null when the prior-year
    // figure is missing or zero, which is the case for every headline metric in
    // the exports seen so far.
    const change = yoy(index, m.names[0], period);
    return { ...m, value, change };
  });
}

// ─── Section tables ───
//
// Every metric in the file, grouped for display. Nothing is filtered out: the
// user asked to see all the data, and metrics the parser could not categorise
// are flagged rather than hidden.
export function sectionTable(rows = []) {
  const bySection = new Map();
  for (const r of rows) {
    if (!bySection.has(r.section)) bySection.set(r.section, new Map());
    const metrics = bySection.get(r.section);
    if (!metrics.has(r.metric_name)) {
      metrics.set(r.metric_name, {
        name: r.metric_name,
        category: r.metric_category,
        unit: r.unit,
        isUnknown: !!r.is_unknown,
        isTotal: !!r.is_total,
        values: {},
        originals: {},
      });
    }
    const m = metrics.get(r.metric_name);
    m.values[r.period] = r.value;
    m.originals[r.period] = r.original_value;
    // A metric's unit is whichever period parsed to something concrete; blank
    // forecast columns parse as "unknown" and must not overwrite a real unit.
    if (m.unit === "unknown" && r.unit !== "unknown") m.unit = r.unit;
  }
  return orderSections([...bySection.keys()]).map((name) => ({
    name,
    metrics: [...bySection.get(name).values()],
  }));
}

// ─── Trend across snapshots ───
//
// Built from actual_today only. MTD and YTD from consecutive snapshots overlap
// by construction, so plotting them as a series draws a line that always rises
// and means nothing.
export function trend(rows = [], names, period = "actual_today") {
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  const byDate = new Map();
  for (const r of rows) {
    if (r.period !== period || r.is_total) continue;
    if (!wanted.has(String(r.metric_name || "").toLowerCase())) continue;
    const d = String(r.business_date || "").slice(0, 10);
    if (!d) continue;
    if (!byDate.has(d)) byDate.set(d, { date: d });
    // Alias lists are ordered by preference, so an earlier name wins.
    const slot = byDate.get(d);
    const rank = names.findIndex((n) => n.toLowerCase() === String(r.metric_name).toLowerCase());
    if (slot._rank === undefined || rank < slot._rank) {
      slot.value = r.value;
      slot._rank = rank;
    }
  }
  return [...byDate.values()]
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .map(({ _rank, ...rest }) => rest);
}

// Trend for every headline metric at once, so the chart can switch between them
// without refiltering the whole table on each toggle.
export function headlineTrends(rows = []) {
  const out = {};
  for (const m of HEADLINE) out[m.key] = trend(rows, m.names);
  return out;
}

export { HEADLINE };

// ─── Revenue composition ───
//
// The Revenue section carries room revenue alongside ~40 ancillary codes, most
// of them zero on any given day. Sorting by magnitude and dropping the zeros is
// what makes the section readable; the full list stays available in the section
// table, so nothing is hidden, only deprioritised.
//
// The canonical section vocabulary lives in STAT_SECTIONS at the top of this file.
//
// The two Revenue lines that are room revenue. Everything else in the section is
// ancillary (pet fee, laundry, property damage, restaurant, ...). This split is
// what makes the OccupancyDay path comparable to the statistics path at all:
// OccupancyDay.room_revenue is ROOM-ONLY, so comparing it against the section
// total is an apples-to-oranges comparison that reports the ancillary sum as
// bogus "drift".
export const ROOM_REVENUE_LINES = Object.freeze(['Taxable Room Revenue', 'Exempt Room Revenue']);

// Section matching is case- and whitespace-insensitive on purpose. An exact ===
// makes the vendor's capitalisation part of our contract: if a future HotelKey
// export ships 'REVENUE' instead of 'Revenue', an exact match returns [] and the
// revenue section silently reads $0 rather than failing loudly. Metric names are
// already compared case-insensitively elsewhere in this file (see trend()), so
// this makes section matching consistent with metric matching.
const sameSection = (a, b) =>
  String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

export function composition(rows = [], section, period = "actual_today") {
  return rows
    .filter((r) => sameSection(r.section, section) && r.period === period && !r.is_total)
    .map((r) => ({ name: r.metric_name, value: Number(r.value) || 0 }))
    .filter((r) => r.value !== 0)
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
}

/**
 * Split the Revenue section into its room and ancillary halves.
 *
 * Measured against the real Middleborough export: Taxable Room Revenue
 * ($637,805.60) + Exempt Room Revenue ($373,453.07) = $1,011,258.67, which is
 * EXACTLY sum(OccupancyDay.room_revenue). The remaining ten lines total
 * $9,339.50 and make up the difference to the $1,020,598.17 section total. So the
 * three revenue derivations do not disagree — two of them measure total revenue
 * and one measures room revenue. Compare `room` against the occupancy path and
 * `total` against the transaction ledger.
 *
 * @param {Array<Object>} rows - snapshot rows (from snapshotFor)
 * @param {string} [period='ytd']
 * @returns {{room: number, ancillary: number, total: number,
 *            roomLines: Array<{name: string, value: number}>,
 *            ancillaryLines: Array<{name: string, value: number}>}}
 */
export function revenueSplit(rows = [], period = 'ytd') {
  const lines = composition(rows, STAT_SECTIONS.REVENUE, period);
  const isRoom = (name) =>
    ROOM_REVENUE_LINES.some((r) => r.toLowerCase() === String(name ?? '').trim().toLowerCase());
  const roomLines = lines.filter((l) => isRoom(l.name));
  const ancillaryLines = lines.filter((l) => !isRoom(l.name));
  // Integer cents: these figures are reconciled to the exact cent, so a float
  // reduce would introduce the very drift the reconciler is built to detect.
  const sumOf = (ls) => fromCents(sumCents(ls.map((l) => l.value)));
  const room = sumOf(roomLines);
  const ancillary = sumOf(ancillaryLines);
  return { room, ancillary, total: fromCents(toCents(room) + toCents(ancillary)), roomLines, ancillaryLines };
}

// ─── Data-quality summary ───
//
// Surfaced on the page rather than buried, because a silent import is how the
// statistics path went unnoticed in the first place.
export function quality(rows = []) {
  const dates = snapshotDates(rows);
  const unknown = rows.filter((r) => r.is_unknown);
  const inferredDates = [
    ...new Set(
      rows
        .filter((r) => r.business_date_source && r.business_date_source !== "explicit")
        .map((r) => String(r.business_date || "").slice(0, 10))
    ),
  ];
  return {
    snapshots: dates.length,
    firstDate: dates[0] || "",
    lastDate: dates[dates.length - 1] || "",
    metrics: rows.length,
    unknownCount: unknown.length,
    unknownNames: [...new Set(unknown.map((r) => r.metric_name))],
    inferredDates,
    // The names, not a yes/no. Prior-year coverage is partial in these exports
    // and the page has to say which metrics it covers — "no prior-year data"
    // would be false, and "prior-year data available" would be misleading.
    priorYearMetrics: priorYearMetrics(rows),
  };
}
