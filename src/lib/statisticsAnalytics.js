// Hotel Statistics snapshot analytics. Portfolio values retain property, date and period boundaries.
// Currency values aggregate in cents; incomplete scopes and rates without weights stay unavailable.
// The optional expected property IDs come from the active accessible property selection.

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

// ─── Portfolio core (private): typed partitions + one additive classifier ───
//
// Valid IDs: non-empty strings (whitespace-only malformed, but ' 1' kept byte-
// exact and distinct from '1') and finite numbers (0 valid). Typed distinct.
function isValidPropertyId(pid) {
  if (typeof pid === "string") return pid.length > 0 && pid.trim().length > 0;
  if (typeof pid === "number") return Number.isFinite(pid);
  return false;
}
function propertyKey(pid) {
  return typeof pid === "number" ? `number:${String(pid)}` : `string:${pid}`;
}
function dateKeyOf(r) { return String(r.business_date || "").slice(0, 10); }
function metricKeyOf(n) { return String(n || "").toLowerCase(); }
function finiteNumberOrNull(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
// index[PARTITION]: {mode} for legacy/single/incomplete, full {mode,date,perProp,order} for portfolio.
const PARTITION = Symbol("stats.portfolio.partition");

// Modes: legacy (0 valid pids) | single (1 valid, 0 invalid) | incomplete (mixed)
// | portfolio (2+ distinct typed pids, 0 invalid; ONE latest date, per-prop last-row wins).
function partitionRows(rows, expectedPropertyIds) {
  const scorable = (rows || []).filter((r) => !r.is_total);
  const keys = new Set();
  let invalid = 0;
  for (const r of scorable) {
    if (isValidPropertyId(r.property_id)) keys.add(propertyKey(r.property_id));
    else invalid++;
  }
  const explicit = expectedPropertyIds !== undefined;
  const expected = explicit
    ? (Array.isArray(expectedPropertyIds) ? expectedPropertyIds : [expectedPropertyIds])
    : [];
  const expectedValid = expected.every(isValidPropertyId);
  const selected = explicit && expectedValid
    ? new Set(expected.map(propertyKey))
    : keys;
  if (!explicit && keys.size === 0) return { mode: "legacy", rows };
  const dates = snapshotDates(scorable);
  const date = dates.length ? dates[dates.length - 1] : "";
  const latestRows = (rows || []).filter((r) => !date || dateKeyOf(r) === date);
  const perProp = new Map();
  const order = [...selected];
  for (const r of scorable) {
    if (date && dateKeyOf(r) !== date) continue;
    const k = propertyKey(r.property_id);
    if (!isValidPropertyId(r.property_id)) continue;
    if (!perProp.has(k)) perProp.set(k, { pid: r.property_id, byMetric: new Map() });
    perProp.get(k).byMetric.set(`${metricKeyOf(r.metric_name)}|${r.period}`, r);
  }
  const incomplete = invalid > 0 || !expectedValid ||
    (explicit && [...keys].some((k) => !selected.has(k))) ||
    [...selected].some((k) => !perProp.has(k)) ||
    (selected.size === 0 && scorable.length > 0);
  return {
    mode: incomplete ? "incomplete" : selected.size > 1 ? "portfolio" : "single",
    date, rows: latestRows, perProp, order,
  };
}
// Source-justified additive literals (lowercase). Revenue sums in integer cents,
// counts numerically. Rates/percentages/unknown never sum across properties.
const REVENUE_NAMES = new Set(["taxable room revenue", "exempt room revenue"]);
const COUNT_NAMES = new Set(["room sold", "rooms sold excluding comp house use rooms", "total guests", "rooms available to sell", "total rooms", "out of order", "arrivals", "departures", "walk ins", "no shows"]);
const RATE_NAMES = new Set(["occupancy excluding down comp house use rooms", "occupancy excluding down rooms and including comp house use rooms", "occupancy including down comp house use rooms", "occupancy", "adr excluding comp house use rooms", "adr including comp house use rooms", "adr", "revpar", "revpar with out of order rooms"]);
function blankModeFor(mk) {
  if (REVENUE_NAMES.has(mk)) return "cents";
  if (COUNT_NAMES.has(mk)) return "num";
  return "";
}
// Single classifier shared by metricValue/firstValue/composition. Zero valid.
// blankMode covers unit-omitted legacy rows only for known literals.
function sumAdditive(list, blankMode) {
  for (const r of list) if (finiteNumberOrNull(r.value) === null) return null;
  const units = list.map((r) => String(r.unit ?? "").trim().toLowerCase());
  if (units.every((u) => u === "currency")) { let c = 0; for (const r of list) c += toCents(Number(r.value)); return fromCents(c); }
  if (units.every((u) => u === "count")) { let t = 0; for (const r of list) t += Number(r.value); return t; }
  if (units.every((u) => u === "" || u === "unknown")) {
    if (blankMode === "cents") { let c = 0; for (const r of list) c += toCents(Number(r.value)); return fromCents(c); }
    if (blankMode === "num") { let t = 0; for (const r of list) t += Number(r.value); return t; }
  }
  return null;
}
// One metric across all portfolio properties. 'ok' requires FULL coverage: a
// property missing the metric (or malformed/unsupported) yields 'bad', never a
// silent partial sum. 'missing' = no property has it.
function portfolioMetric(part, mk, period) {
  const hits = [];
  for (const k of part.order) {
    const row = part.perProp.get(k).byMetric.get(`${mk}|${period}`);
    if (row !== undefined) hits.push(row);
  }
  if (hits.length === 0) return { status: "missing" };
  if (hits.length < part.order.length) return { status: "bad" };
  const v = sumAdditive(hits, blankModeFor(mk));
  return v === null ? { status: "bad" } : { status: "ok", value: v };
}

// ─── Value access ───
//
// Metric names come straight from the PMS and are matched case-insensitively so
// a vendor changing "Room Sold" to "Rooms Sold" is a miss rather than a crash.
//
// indexSnapshot still returns a Map. Legacy/single keep verbatim metric|period
// rows (direct .get compatible). Portfolio keeps distinct typed partitions in
// index[PARTITION]; metricValue/firstValue aggregate through them, so the actual
// page fields work, not just headline.
export function indexSnapshot(rows = [], expectedPropertyIds) {
  const map = new Map();
  const part = partitionRows(rows, expectedPropertyIds);
  if (part.mode === "legacy" || part.mode === "single") {
    for (const r of (part.rows || [])) {
      if (r.is_total) continue;            // section aggregates: kept in the data, excluded from lookups
      map.set(`${String(r.metric_name || "").toLowerCase()}|${r.period}`, r);
    }
    map[PARTITION] = { mode: part.mode };
  } else map[PARTITION] = part.mode === "portfolio" ? part : { mode: "incomplete" };
  return map;
}

export function metricValue(index, name, period = "actual_today") {
  const part = index ? index[PARTITION] : undefined;
  if (!part || part.mode !== "portfolio") {
    if (part && part.mode === "incomplete") return null;
    const hit = index.get(`${String(name).toLowerCase()}|${period}`);
    return hit && hit.value !== null && hit.value !== undefined ? hit.value : null;
  }
  const mk = metricKeyOf(name);
  if (RATE_NAMES.has(mk)) return null; // multi rates: honest null, no invented denominators
  const s = portfolioMetric(part, mk, period);
  return s.status === "ok" ? s.value : null;
}

// First name that resolves, so a metric can be looked up under any of the
// aliases different PMS versions use without the caller writing fallback chains.
// Portfolio resolves the first alias WITHIN each property, then sums across
// properties (never double-counting two aliases of one property).
export function firstValue(index, names, period = "actual_today") {
  const part = index ? index[PARTITION] : undefined;
  if (!part || part.mode !== "portfolio") {
    if (part && part.mode === "incomplete") return null;
    for (const n of names) {
      const v = metricValue(index, n, period);
      if (v !== null) return v;
    }
    return null;
  }
  const lower = names.map((n) => String(n).toLowerCase());
  if (lower.some((n) => RATE_NAMES.has(n))) return null;
  const resolved = [];
  for (const k of part.order) {
    const byMetric = part.perProp.get(k).byMetric;
    for (let i = 0; i < names.length; i++) {
      const row = byMetric.get(`${lower[i]}|${period}`);
      if (row !== undefined && row.value !== null && row.value !== undefined) { resolved.push(row); break; }
    }
  }
  if (resolved.length < part.order.length) return null; // a property resolved no alias: unknown
  const keys = resolved.map((r) => metricKeyOf(r.metric_name));
  const mode = keys.every((k) => REVENUE_NAMES.has(k)) ? "cents" : keys.every((k) => COUNT_NAMES.has(k)) ? "num" : "";
  const units = resolved.map((r) => String(r.unit ?? "").trim().toLowerCase());
  if (units.every((u) => u === "currency") && mode !== "cents") return null; // ADR/RevPAR currency is not additive
  return sumAdditive(resolved, mode);
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
// compare against. Callers never need to pre-check. Portfolio-aware for free via
// metricValue (summed now/then, still null-safe, complete past kept).
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

const ADDITIVE_KEYS = new Set(["sold", "revenue", "guests"]);

function headlineValue(index, metric, period) {
  let value = firstValue(index, metric.names, period);
  if (finiteNumberOrNull(value) === null) return null;
  if (!metric.extra || value === null) return value;
  let cents = toCents(Number(value));
  const part = index[PARTITION];
  for (const name of metric.extra) {
    if (part?.mode === "portfolio") {
      const leg = portfolioMetric(part, metricKeyOf(name), period);
      if (leg.status === "bad") return null;
      if (leg.status === "ok") cents += toCents(Number(leg.value));
    } else {
      const leg = metricValue(index, name, period);
      if (leg !== null) {
        if (finiteNumberOrNull(leg) === null) return null;
        cents += toCents(Number(leg));
      }
    }
  }
  return fromCents(cents);
}

export function headline(rows = [], period = "actual_today", expectedPropertyIds) {
  const index = indexSnapshot(rows, expectedPropertyIds);
  const part = index[PARTITION];
  if (part?.mode === "incomplete") {
    return HEADLINE.map((m) => ({ ...m, value: null, change: null, incomplete: true }));
  }
  return HEADLINE.map((m) => {
    if (part?.mode === "portfolio" && !ADDITIVE_KEYS.has(m.key)) {
      return { ...m, value: null, change: null };
    }
    const value = headlineValue(index, m, period);
    const priorPeriod = LY_OF[period];
    const then = priorPeriod ? headlineValue(index, m, priorPeriod) : null;
    const nowNumber = finiteNumberOrNull(value);
    const thenNumber = finiteNumberOrNull(then);
    const delta = m.extra ? fromCents(toCents(nowNumber) - toCents(thenNumber)) : nowNumber - thenNumber;
    const change = nowNumber === null || thenNumber === null || thenNumber === 0 ? null : {
      now: value, then, delta,
      pct: (delta / Math.abs(thenNumber)) * 100,
    };
    return { ...m, value, change };
  });
}

// ─── Section tables ───
//
// Every metric in the file, grouped for display. Nothing is filtered out: the
// user asked to see all the data, and metrics the parser could not categorise
// are flagged rather than hidden.
export function sectionTable(rows = [], expectedPropertyIds) {
  const part = partitionRows(rows, expectedPropertyIds);
  const source = part.mode === "legacy" ? rows : part.rows;
  const bySection = new Map();
  const hits = new Map();
  for (const r of source) {
    if (!bySection.has(r.section)) bySection.set(r.section, new Map());
    const metrics = bySection.get(r.section);
    const metricKey = part.mode === "legacy" ? r.metric_name : `${metricKeyOf(r.metric_name)}|${!!r.is_total}`;
    if (!metrics.has(metricKey)) {
      metrics.set(metricKey, {
        name: r.metric_name,
        category: r.metric_category,
        unit: r.unit,
        isUnknown: !!r.is_unknown,
        isTotal: !!r.is_total,
        values: {},
        originals: {},
      });
    }
    const m = metrics.get(metricKey);
    if (part.mode === "legacy" || part.mode === "single") {
      m.values[r.period] = r.value;
      m.originals[r.period] = r.original_value;
    } else {
      if (!hits.has(m)) hits.set(m, new Map());
      const periods = hits.get(m);
      if (!periods.has(r.period)) periods.set(r.period, new Map());
      if (isValidPropertyId(r.property_id)) periods.get(r.period).set(propertyKey(r.property_id), r);
      m.values[r.period] = null;
      m.originals[r.period] = null;
    }
    // A metric's unit is whichever period parsed to something concrete; blank
    // forecast columns parse as "unknown" and must not overwrite a real unit.
    if (m.unit === "unknown" && r.unit !== "unknown") m.unit = r.unit;
  }
  if (part.mode === "portfolio") {
    for (const [m, periods] of hits) {
      for (const [period, byProperty] of periods) {
        if (byProperty.size !== part.order.length || RATE_NAMES.has(metricKeyOf(m.name))) continue;
        m.values[period] = sumAdditive([...byProperty.values()], blankModeFor(metricKeyOf(m.name)));
      }
    }
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
function legacyTrend(rows = [], names, period = "actual_today") {
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

function trendScope(rows, expectedPropertyIds) {
  if (expectedPropertyIds !== undefined) return expectedPropertyIds;
  const ids = new Map();
  for (const row of rows) {
    if (!row.is_total && isValidPropertyId(row.property_id)) ids.set(propertyKey(row.property_id), row.property_id);
  }
  return [...ids.values()];
}

export function trend(rows = [], names, period = "actual_today", expectedPropertyIds) {
  if (partitionRows(rows, expectedPropertyIds).mode === "legacy") return legacyTrend(rows, names, period);
  const scope = trendScope(rows, expectedPropertyIds);
  return snapshotDates(rows).map((date) => ({
    date,
    value: firstValue(indexSnapshot(snapshotFor(rows, date).rows, scope), names, period),
  }));
}

// Trend for every headline metric at once, so the chart can switch between them
// without refiltering the whole table on each toggle.
export function headlineTrends(rows = [], expectedPropertyIds) {
  const out = {};
  if (partitionRows(rows, expectedPropertyIds).mode === "legacy") {
    for (const m of HEADLINE) out[m.key] = legacyTrend(rows, m.names);
    return out;
  }
  for (const m of HEADLINE) out[m.key] = [];
  const scope = trendScope(rows, expectedPropertyIds);
  for (const date of snapshotDates(rows)) {
    for (const metric of headline(snapshotFor(rows, date).rows, "actual_today", scope)) {
      out[metric.key].push({ date, value: metric.value });
    }
  }
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

function legacyComposition(rows = [], section, period = "actual_today") {
  return rows
    .filter((r) => sameSection(r.section, section) && r.period === period && !r.is_total)
    .map((r) => ({ name: r.metric_name, value: Number(r.value) || 0 }))
    .filter((r) => r.value !== 0)
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
}

export function composition(rows = [], section, period = "actual_today", expectedPropertyIds) {
  const part = partitionRows(rows, expectedPropertyIds);
  if (part.mode === "legacy") return legacyComposition(rows, section, period);
  const inScope = part.rows.filter(
    (r) => sameSection(r.section, section) && r.period === period && !r.is_total
  );
  // Portfolio: latest snapshot only, same-property last-row wins, currency/count
  // via the shared classifier. NOTE: value:null lines (partial/non-additive)
  // need a null-check before arithmetic; revenueSplit already poisons on them.
  const perPropLast = new Map();
  const unknownNames = new Map();
  for (const r of inScope) {
    unknownNames.set(metricKeyOf(r.metric_name), r.metric_name);
    if (!isValidPropertyId(r.property_id)) continue;
    const pk = propertyKey(r.property_id);
    perPropLast.set(`${pk}|${metricKeyOf(r.metric_name)}`, r);
  }
  if (part.mode === "incomplete") {
    return [...unknownNames.values()].map((name) => ({ name, value: null }));
  }
  const grouped = new Map();
  for (const r of perPropLast.values()) {
    const mk = metricKeyOf(r.metric_name);
    if (!grouped.has(mk)) grouped.set(mk, { display: r.metric_name, list: [] });
    grouped.get(mk).list.push(r);
  }
  const out = [];
  for (const g of grouped.values()) {
    const mk = metricKeyOf(g.display);
    if (g.list.length < part.order.length) { out.push({ name: g.display, value: null }); continue; }
    const v = part.mode === "single" ? finiteNumberOrNull(g.list[0].value)
      : RATE_NAMES.has(mk) ? null : sumAdditive(g.list, blankModeFor(mk));
    if (v === null || v === 0) { if (v === null) out.push({ name: g.display, value: null }); continue; }
    out.push({ name: g.display, value: v });
  }
  return out.sort((a, b) => Math.abs(b.value || 0) - Math.abs(a.value || 0));
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
 * Portfolio: duplicates dedupe (last wins), room lines aggregate in integer
 * cents so `room` agrees with headline room. Mixed/malformed scope poisons
 * totals to honest null (never null=>0). Multi-date input takes the latest
 * snapshot, never summed.
 *
 * @param {Array<Object>} rows - snapshot rows (from snapshotFor)
 * @param {string} [period='ytd']
 * @param {string|number|Array<string|number>} [expectedPropertyIds] - selected accessible property identities
 * @returns {{room: number|null, ancillary: number|null, total: number|null,
 *            roomLines: Array<{name: string, value: number}>,
 *            ancillaryLines: Array<{name: string, value: number}>, incomplete?: boolean}}
 */
export function revenueSplit(rows = [], period = 'ytd', expectedPropertyIds) {
  const part = partitionRows(rows, expectedPropertyIds);
  const inScope = (rows || []).filter(
    (r) => sameSection(r.section, STAT_SECTIONS.REVENUE) && r.period === period && !r.is_total
  );
  const scopeHasValid = inScope.some((r) => isValidPropertyId(r.property_id));
  if (!scopeHasValid && part.mode === "legacy") {
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
  const scopeHasInvalid = inScope.some((r) => !isValidPropertyId(r.property_id));
  const lines = composition(rows, STAT_SECTIONS.REVENUE, period, expectedPropertyIds);
  const isRoom = (name) =>
    ROOM_REVENUE_LINES.some((r) => r.toLowerCase() === String(name ?? '').trim().toLowerCase());
  const roomLines = lines.filter((l) => isRoom(l.name));
  const ancillaryLines = lines.filter((l) => !isRoom(l.name));
  const hasNull = (ls) => ls.some((l) => l.value === null || !Number.isFinite(Number(l.value)));
  if (part.mode === "incomplete" || scopeHasInvalid || hasNull(roomLines) || hasNull(ancillaryLines)) {
    const cleanSum = (ls) => {
      if (ls.some((l) => l.value === null || !Number.isFinite(Number(l.value)))) return null;
      return fromCents(sumCents(ls.map((l) => l.value)));
    };
    const room = hasNull(roomLines) || scopeHasInvalid || part.mode === "incomplete" ? null : cleanSum(roomLines);
    const ancillary = hasNull(ancillaryLines) || scopeHasInvalid || part.mode === "incomplete" ? null : cleanSum(ancillaryLines);
    return { room, ancillary, total: null, roomLines, ancillaryLines, incomplete: true };
  }
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
