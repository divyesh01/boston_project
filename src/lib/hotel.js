import { getCommissionRates } from "@/lib/commissionRates";
import { getAlertThresholds } from "@/lib/alertThresholds";
import { getRevenueColor, getRevenueGroup } from "@/lib/revenueThresholds";
export { getRevenueColor, getRevenueGroup };

import { toCents, fromCents, toRate, fromRate, add, subtract, multiply, divide, divideRate, sumCents, formatCents, formatRate, formatNumber, portfolioOccupancy, portfolioAdr, portfolioRevpar } from '@/lib/decimal';
import { neutralizeFormula } from '@/lib/securityUtils';

// Default property — used as fallback when no Property records exist yet
export const PROPERTY = { name: "Red Roof Inn & Suites Middleborough", code: "RRI1416", rooms: 100 };

export const C = {
  purple: "#6C63FF",
  cyan: "#00D4FF",
  green: "#00E096",
  amber: "#FFB547",
  coral: "#FF6B6B",
};

export const CHART_COLORS = [C.purple, C.cyan, C.green, C.amber, C.coral, "#9B8CFF", "#4FE3C1", "#FF9F7A"];

export function getOccThreshold() {
  return getAlertThresholds().occupancyThreshold ?? 0.60;
}

export function commissionFor(source = "") {
  const rates = getCommissionRates();
  const n = String(source).toUpperCase();
  let best = null;
  let bestLen = 0;
  for (const [key, info] of Object.entries(rates)) {
    if (n.includes(key) && key.length > bestLen) {
      best = info;
      bestLen = key.length;
    }
  }
  return best || { type: "none", rate: 0, taxExempt: false };
}

export const money = (v) => formatCents(toCents(v), 0);
export const money2 = (v) => formatCents(toCents(v), 2);
export const pct = (v, digits = 1) => formatRate(toRate(v), digits);
export const num = (v) => formatNumber(v);

export const sum = (rows, key) => fromCents(sumCents((rows || []).map(r => r[key])));
export const avg = (rows, key) => rows && rows.length ? sum(rows, key) / rows.length : 0;

export function inRange(dateStr, from, to) {
  if (!dateStr) return false;
  const d = String(dateStr).slice(0, 10);
  // An empty ('') or falsy bound means "unbounded on that side" — not a wall
  // that rejects every date. `d <= ''` is false for every real date string, so
  // the old `d >= from && d <= to` dropped ALL rows whenever the upper bound was
  // open (the default custom-range value and the cache-fallback path), zeroing
  // the page. Matches the guarded twin in dailyAggregates.js.
  if (from && d < from) return false;
  if (to && d > to) return false;
  return true;
}

// ─── Total revenue = room ledger + ancillary charges ───────────────────────
//
// WHY THIS EXISTS. "Gross revenue" had two different meanings in the codebase.
// The reconciler (financialReconciliation.js) measures the TOTAL the hotel
// collected — $1,020,598.17 on the Middleborough export — while the Money Kept
// widget was computing `sum(occRows, "room_revenue")`, which is ROOM revenue
// only ($1,011,258.67). The $9,339.50 gap is real ancillary income (pet fees,
// laundry, smoking, restaurant, property damage, early check-in, misc, AR
// adjustments): money the owner kept that the widget never counted, so its keep
// rate and every deduction percentage were measured against the wrong base.
//
// THE FIX IS NOT "MAKE OCCUPANCY BIGGER". OccupancyDay is a room ledger; adding
// pet fees to `room_revenue` would corrupt ADR and RevPAR and is explicitly
// forbidden by scripts/probe-financial-invariant.mjs. The invariant is a PAIR:
//     room ($1,011,258.67) + ancillary ($9,339.50) == total ($1,020,598.17)
// So the total is assembled from the two ledgers that own each half.
//
// WHY ROOM COMES FROM THE OCCUPANCY LEG AND NOT FROM `room_rent`. Both carry the
// same $1,011,258.67 (probe-money-kept-gross asserts the three agree), but the
// gross rows reaching the UI are not always raw GrossRevenueDay rows. The daily
// aggregate cache (dailyAggregates.js GROSS_MISC_FIELDS) carries only the MISC
// charge columns, deliberately — room revenue travels on the occupancy leg as
// `occ_revenue`. Summing `room_rent` off those rows yields 0, so a total built
// that way reads $9,339.50 on every screen fed by the cache, which is exactly
// the regression this comment exists to prevent. Room from the room ledger,
// ancillary from the charge ledger, and the two shapes behave identically.
//
// EXCLUSIONS ARE BY NAME, NOT BY VALUE. `non_revenue` is by definition not
// revenue, and `advance_deposit` is a liability until the stay is consumed —
// counting either would overstate what the owner earned. Both are $0.00 in the
// current export, so this changes no number today; it stops the total from
// silently inflating the first time a property posts one.

// Ancillary charge columns on a gross row. `room_rent` is deliberately NOT here:
// it is the room ledger's quantity, added separately, and is absent entirely from
// aggregate-cache rows. Keep in sync with dailyAggregates.js GROSS_MISC_FIELDS.
export const GROSS_ANCILLARY_COMPONENTS = Object.freeze([
  "misc_charge", "system_charge", "food", "event",
  "bar", "beverage", "laundry", "phone", "other",
]);

// Present on gross rows but never revenue. Listed so the drift guard in
// scripts/probe-money-kept-gross.mjs can prove every numeric column is classified.
export const GROSS_NON_REVENUE_COMPONENTS = Object.freeze([
  "non_revenue", "advance_deposit",
]);

/**
 * Ancillary (non-room) revenue on a single gross row, in integer cents.
 * @param {Object} row
 * @returns {number} cents
 */
export function rowAncillaryRevenueCents(row) {
  if (!row) return 0;
  return sumCents(GROSS_ANCILLARY_COMPONENTS.map((k) => row[k]));
}

/**
 * Ancillary revenue across gross rows, in integer cents.
 * @param {Array<Object>} rows
 * @returns {number} cents
 */
export function ancillaryRevenueCents(rows) {
  return (rows || []).reduce((acc, r) => acc + rowAncillaryRevenueCents(r), 0);
}

/**
 * Total revenue for a period, assembled from both ledgers, with provenance.
 *
 * Returns `basis: "total"` when ancillary charges could be included, and
 * `basis: "room"` when no gross rows cover the period so the figure is room
 * revenue alone. The basis is returned rather than hidden because the two
 * measure different quantities: a caller that silently swapped one for the
 * other is exactly the defect this helper replaces. UI should say which it is.
 *
 * @param {{grossRows?: Array<Object>, occRows?: Array<Object>}} params
 * @returns {{cents: number, dollars: number, basis: "total"|"room", roomCents: number, ancillaryCents: number}}
 */
export function grossRevenueForPeriod({ grossRows = [], occRows = [] } = {}) {
  const gRows = grossRows || [];
  const oRows = occRows || [];

  // Room revenue from the room ledger. Only when there is no occupancy data at
  // all does `room_rent` on the gross rows stand in for it — never both, or the
  // same room night would be counted twice.
  const roomCents = oRows.length
    ? sumCents(oRows.map((r) => r.room_revenue))
    : sumCents(gRows.map((r) => r.room_rent));

  const ancillaryCents = ancillaryRevenueCents(gRows);
  const cents = roomCents + ancillaryCents;
  return {
    cents,
    dollars: fromCents(cents),
    basis: gRows.length ? "total" : "room",
    roomCents,
    ancillaryCents,
  };
}

/**
 * Convert a date-only key ("YYYY-MM-DD") to its epoch day number, and back.
 *
 * These two are inverses and exist so that **date arithmetic never touches the
 * host calendar**. `formatDayLabel` below defuses the same ECMA-262 trap on the
 * display side; this pair defuses it on the arithmetic side.
 *
 * The trap: `new Date("2026-08-02")` is parsed as UTC midnight, but `getDate()`
 * and `setDate()` read and write LOCAL calendar fields. Every US zone is behind
 * UTC, so the day-of-month is already the previous day before any arithmetic
 * happens, and shifting by N days additionally absorbs any DST offset change
 * between the two endpoints. Measured in America/New_York, the expression
 *
 *     prevToDate.setDate(prevFrom.getDate() + elapsedDays - 1)
 *
 * turned a 214-day window starting 2025-01-01 into one ending 2025-08-01
 * instead of 2025-08-02 — the comparison period silently lost a day, which
 * inflates every growth percentage derived from it. Measured over the eight
 * windows `scripts/probe-mtd-growth.mjs` drives: wrong in 2, right in the other
 * 6 — and, run in UTC, wrong in 0 of 8. That is why it survived. A spot-check of
 * a single month finds nothing, and so does any test run in a UTC container.
 *
 * `Date.UTC` never consults the host zone, so `isoEpochDay` is timezone-
 * independent by construction rather than by careful use. Do NOT reimplement
 * either of these with a local accessor.
 *
 * Returns `NaN` for empty or unparseable input rather than 0 — day 0 is a real
 * date (1970-01-01), so a silent 0 would arithmetic-away into a plausible
 * window instead of failing.
 *
 * @param {string} dateStr date-only key; any trailing time component is ignored
 * @returns {number} whole days since 1970-01-01, or NaN
 */
export function isoEpochDay(dateStr) {
  if (!dateStr) return NaN;
  const [y, m, d] = String(dateStr).slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return NaN;
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

/**
 * Inverse of {@link isoEpochDay}: an epoch day number back to "YYYY-MM-DD".
 *
 * @param {number} day whole days since 1970-01-01
 * @returns {string} date-only key, or "" when `day` is not a finite number
 */
export function epochDayToIso(day) {
  if (!Number.isFinite(day)) return "";
  return new Date(day * 86400000).toISOString().slice(0, 10);
}

/**
 * The weekday of an epoch day, as `Date.prototype.getUTCDay` numbers them:
 * 0 = Sunday … 6 = Saturday.
 *
 * WHY THIS EXISTS. `getDay()` reads a LOCAL calendar field, and a date-only
 * string parses as UTC midnight — so in every zone behind UTC, `new
 * Date("2026-09-05").getDay()` answers for September **4th**. The recurring
 * event expander tested that local weekday and then stamped the UTC date, so
 * every weekend event landed on Sunday and Monday instead of Saturday and
 * Sunday. Measured on King Richard's Faire (`dayOfWeek: [6, 0]`, from
 * 2026-09-05): it emitted 09-06, 09-07, 09-13, 09-14 where the truth is 09-05,
 * 09-06, 09-12, 09-13. See BRAIN_TROUBLESHOOTING.md 29.
 *
 * Iterating whole epoch days and deriving the weekday arithmetically also
 * removes the DST damage that `setDate(getDate() + 1)` caused on a UTC-midnight
 * instant: measured, spring-forward emitted 2026-03-08 **twice** and dropped
 * 03-12, and fall-back skipped 2026-11-18 while stamping 11-30, a Monday, for a
 * Wednesday-to-Sunday event.
 *
 * Epoch day 0 is 1970-01-01, which was a Thursday, hence the +4 phase. The extra
 * `+ 7` keeps the result in 0..6 for dates before 1970, where `%` would
 * otherwise yield a negative.
 *
 * @param {number} day whole days since 1970-01-01, as {@link isoEpochDay} returns
 * @returns {number} 0..6 with 0 = Sunday, or NaN when `day` is not finite
 */
export function epochDayWeekday(day) {
  if (!Number.isFinite(day)) return NaN;
  return ((Math.trunc(day) + 4) % 7 + 7) % 7;
}

/**
 * Today's date in the OPERATOR's calendar, as a "YYYY-MM-DD" key.
 *
 * Do NOT substitute `new Date().toISOString().slice(0, 10)`. That is today in
 * UTC, which in Middleborough rolls over at 8pm (7pm in winter) — so between
 * 8pm and midnight a "from today onward" horizon silently starts tomorrow and
 * drops the evening the owner is standing in.
 *
 * The inverse mistake is just as easy: comparing this key's parse against a
 * date-only event key. `new Date(y, m, d)` is LOCAL midnight while
 * `new Date("2026-08-24")` is UTC midnight, so `eventDate >= localMidnight` is
 * false for an event dated today and today's own events vanish. That is exactly
 * what the Action Center's upcoming-events horizon did. Compare the KEYS, or
 * compare epoch days — never a mix of the two frames.
 *
 * @returns {string} date-only key for the host's current local day
 */
export function localTodayIso() {
  const now = new Date();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${m}-${d}`;
}

/**
 * Format a date-only key ("YYYY-MM-DD") for display — "Thursday, August 6".
 *
 * Use this for ANY date that came from a business-date column or an event
 * schedule key. Do NOT call `new Date(key).toLocaleDateString()` on such a
 * string: ECMA-262 parses a date-only form as UTC midnight, and
 * toLocaleDateString then renders it in the host zone. Every US zone is behind
 * UTC, so the label silently names the PREVIOUS day — the calendar dialog for
 * 2026-08-06 read "Wednesday, August 5", and the Action Center printed a
 * mislabeled weekday directly above the correct raw date.
 *
 * Building the Date from the parts pins it to LOCAL midnight, so the weekday and
 * day-of-month can never drift regardless of the operator's timezone or DST.
 * Returns "" for empty or unparseable input rather than "Invalid Date" — a blank
 * label is honest, an invented one is not.
 *
 * `opts` is annotated because TypeScript widens the default object literal's
 * "long" to `string`, and Intl.DateTimeFormatOptions only accepts the union
 * "long" | "short" | "narrow" — so without this the file fails
 * `npm run typecheck` (TS2769) even though the call is correct at runtime.
 *
 * @param {string} dateStr
 * @param {Intl.DateTimeFormatOptions} [opts]
 */
export function formatDayLabel(dateStr, opts = { weekday: "long", month: "long", day: "numeric" }) {
  if (!dateStr) return "";
  const [y, m, d] = String(dateStr).slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return "";
  const date = new Date(y, m - 1, d);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-US", opts);
}

export function aggregate(rows, groupKey, valueKey, agg) {
  const map = new Map();
  (rows || []).forEach((r) => {
    const k = r[groupKey] === undefined || r[groupKey] === null || r[groupKey] === "" ? "(blank)" : String(r[groupKey]).slice(0, 40);
    const v = toCents(r[valueKey]);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(v);
  });
  const out = [];
  map.forEach((vals, name) => {
    let value = 0;
    if (agg === "sum") value = fromCents(vals.reduce((a, b) => a + b, 0));
    else if (agg === "avg") value = fromCents(Math.round(vals.reduce((a, b) => a + b, 0) / vals.length));
    else if (agg === "count") value = vals.length;
    else if (agg === "max") value = fromCents(Math.max(...vals));
    else if (agg === "min") value = fromCents(Math.min(...vals));
    out.push({ name, value: Math.round(value * 100) / 100 });
  });
  return out.sort((a, b) => b.value - a.value);
}

// Neutralize CSV formula injection (cells beginning with =, +, -, @, tab, CR).
// Applied on every export regardless of sanitizeCsv so unsanitized historical
// database values cannot smuggle formulas into downloads.
function csvCell(value) {
  let s = neutralizeFormula(String(value ?? ""));
  return `"${s.replace(/"/g, '""')}"`;
}

export function toCsv(rows) {
  if (!rows || !rows.length) return "";
  const keys = Object.keys(rows[0]);
  return [keys.join(","), ...rows.map((r) => keys.map((k) => csvCell(r[k])).join(","))].join("\n");
}

// downloadCsv / downloadExcel USED TO LIVE HERE. Removed 2026-08-20 — do not restore.
//
// Every export button in the app now calls @/lib/exportData instead: AuditLog,
// Transactions, Statistics, ManualEntry and ChartBuilder. Once the last of those
// was migrated these two functions had no callers left, and leaving them in a
// module that nearly every page imports meant the next export button added would
// most likely pick up the weaker pair. They differed from exportData in four ways
// that the owner sees:
//   - headers were raw column keys (`other_room_revenue`), never display labels;
//   - `Object.keys(rows[0])` took the columns from the FIRST row, so any field
//     missing from row 0 was dropped from the whole file;
//   - an empty selection produced a silent zero-row download instead of throwing,
//     so a filter that matched nothing looked identical to a blocked download;
//   - they returned nothing, so no caller could report how much it exported.
// Deleting downloadExcel also took `import * as XLSX` out of this module. xlsx is
// the largest dependency in the bundle and hotel.js is imported by nearly every
// page; it now loads only with the export module that actually uses it.
//
// BEST OUTCOME NOTE: one export implementation, in one file, reached by one import
// path. Two implementations of a download cannot be kept in agreement by review —
// the CSV guard fix and the Excel column spec would have had to be applied twice.
//
// NOTE (unrelated dead code, deliberately left alone): `toCsv` and its private
// `csvCell` above are no longer used by any page either, but they are still the
// subject of scripts/verify-harness.mjs §6's formula-injection checks, so they are
// not mine to delete. exportData.js has its own guard with its own coverage in
// scripts/probe-export-data.mjs §4/§4b.

// Normalize employee/clerk names — trim, collapse repeated spaces, consistent casing
export function normalizeName(name) {
  return String(name || "").trim().replace(/\s+/g, " ");
}

// ─── Capacity: rooms per DAY, not rooms per ROW ─────────────────────────────
//
// WHY THIS HELPER EXISTS. Read this before "simplifying" it back to a loop.
//
// Capacity means "how many room-nights were available to sell". A property's
// inventory belongs to the DAY, not to a row in a spreadsheet. This PMS
// legitimately emits SEVERAL occupancy rows for one (property, business_date) —
// duplicate report sections are real data here, not corruption.
//
// The old code added a full property's inventory once PER ROW. Measured on a
// 30-day month for one 50-room property whose export carried two sections per
// date (60 rows):
//
//     TRUE      capacity 1500   occupancy 70.0%   RevPAR $70.00   days 30
//     REPORTED  capacity 3000   occupancy 35.0%   RevPAR $35.00   days 60
//
// Occupancy and RevPAR both divide BY capacity, so both read at HALF their true
// value — and the more complete the import, the worse the understatement, while
// no individual row looks wrong. Those two numbers drive the Compare page, the
// Monthly Calendar, MTD Growth and the Room Board.
//
// It was also a SPLIT BRAIN. src/lib/calculationService.js fixed this same bug in
// its own copy on 2026-08-20 (see capacityCents there), so calculationService
// reported 70% while hotel.js reported 35% for identical rows — two live read
// paths disagreeing about the same month. This helper is the shared rule; the two
// files now compute capacity the same way by construction.
//
// SUMMED, NOT MAXED, within a day. When several rows for one date DO carry an
// explicit `total_rooms`, their values are added. That is deliberate and it is the
// only choice that keeps the two read paths equal: src/lib/dailyAggregates.js:177
// has already collapsed those rows into a single `occ_capacity_rooms` by summing,
// and a max cannot be recovered from a sum. The FALLBACK is the thing that must
// not repeat per row, and now it does not — it is consulted only when NO row for
// that date states an inventory.
//
// Proven by scripts/probe-capacity-per-day.mjs.
/**
 * Room-nights of capacity for a set of occupancy rows.
 *
 * @param {Array<Object>} rows occupancy rows carrying `property_id`, `date`, `total_rooms`
 * @param {(propertyId: string) => number} roomsFor fallback inventory for a property
 * @returns {number} capacity in whole room-nights
 */
function capacityRoomNightsBy(rows, roomsFor) {
  /** @type {Map<string, { pid: string, explicit: number }>} */
  const byDay = new Map();
  (rows || []).forEach((r) => {
    const pid = r.property_id || "_default";
    // A row with no date cannot be grouped by date. It gets its own bucket keyed
    // on the row's position, which reproduces the old per-row behaviour for that
    // row alone — the honest answer when the data does not say which day it is.
    const day = r.date ? String(r.date).slice(0, 10) : `__nodate_${byDay.size}`;
    const key = `${pid}|${day}`;
    const rowRooms = Number(r.total_rooms) || 0;
    const cur = byDay.get(key);
    if (cur) cur.explicit += rowRooms > 0 ? rowRooms : 0;
    else byDay.set(key, { pid, explicit: rowRooms > 0 ? rowRooms : 0 });
  });

  let total = 0;
  byDay.forEach((day) => {
    total += day.explicit > 0 ? day.explicit : (Number(roomsFor(day.pid)) || 0);
  });
  return total;
}

/** Distinct business dates covered by a row set — NOT the row count. */
function distinctDays(rows) {
  const days = new Set();
  (rows || []).forEach((r, i) => {
    days.add(r.date ? String(r.date).slice(0, 10) : `__nodate_${i}`);
  });
  return days.size;
}

// Weighted portfolio calculations — never average property percentages
export function portfolioStats(occRows, roomCounts) {
  const safeRows = occRows || [];
  const revenue = sumCents(safeRows.map(r => r.room_revenue));
  const roomsSold = sumCents(safeRows.map(r => r.rooms_sold));

  // Capacity is per DAY, not per row. See capacityRoomNightsBy above for the
  // measured consequence of the per-row version this replaced.
  const rooms = roomCountsFrom(roomCounts); // normalizes both properties arrays and plain maps
  const capacity = capacityRoomNightsBy(safeRows, (pid) => rooms[pid] ?? PROPERTY.rooms) * 100;

  const occupancy = capacity ? divideRate(roomsSold, capacity) : 0;
  const adr = roomsSold ? divide(revenue, roomsSold) : 0;
  const revpar = capacity ? divide(revenue, capacity) : 0;
  return { revenue: fromCents(revenue), roomsSold: fromCents(roomsSold), capacity: fromCents(capacity), occupancy: fromRate(occupancy), adr: fromCents(adr), revpar: fromCents(revpar) };
}

// Room count for one property id, falling back to the default only when the
// property genuinely has no configured inventory.
export function roomsForProperty(propertyId, properties) {
  const found = (properties || []).find((p) => p.id === propertyId);
  return Number(found?.rooms) || PROPERTY.rooms;
}

// Build a { property_id: rooms } map once, for the capacity helpers below.
//
// Defensively normalizes either shape callers pass for room inventory:
//   - Array of property objects [{ id, rooms|room_count|total_rooms }, ...]
//   - Plain key-value map { property_id: rooms, ... }
// Unknown shapes degrade to {} so downstream `?? PROPERTY.rooms` guards keep
// legacy rows at the default inventory.
export function roomCountsFrom(input) {
  if (!input) return {};

  // Case 1: Array of property objects (e.g., [{ id: 'prop_1', rooms: 50 }, ...])
  if (Array.isArray(input)) {
    const map = {};
    for (const prop of input) {
      if (prop && prop.id) {
        map[prop.id] = Number(prop.rooms || prop.room_count || prop.total_rooms) || PROPERTY.rooms;
      }
    }
    return map;
  }

  // Case 2: Plain key-value map object (e.g., { 'prop_1': 50, 'prop_2': 100 })
  if (typeof input === 'object') {
    const map = {};
    for (const [key, val] of Object.entries(input)) {
      map[key] = Number(val) || 0;
    }
    return map;
  }

  return {};
}

// Total room-nights of capacity represented by a set of occupancy rows.
//
// Capacity is inventory per (property, DAY) — see capacityRoomNightsBy above for
// why, and for the measurement showing the old per-ROW version halved occupancy
// and RevPAR on any export with more than one section per date.
export function capacityRoomNights(occRows, properties) {
  const rooms = roomCountsFrom(properties);
  return capacityRoomNightsBy(occRows, (pid) => rooms[pid] ?? PROPERTY.rooms);
}

// Physical room inventory in scope: one property's rooms, or the sum across the
// properties the current selection covers.
export function inventoryInScope(property, properties) {
  const list = properties || [];
  if (Array.isArray(property)) {
    const ids = new Set(property);
    const sel = list.filter((p) => ids.has(p.id));
    return sel.reduce((a, p) => a + (Number(p.rooms) || PROPERTY.rooms), 0) || PROPERTY.rooms;
  }
  if (!property || property === "all") {
    return list.reduce((a, p) => a + (Number(p.rooms) || PROPERTY.rooms), 0) || PROPERTY.rooms;
  }
  return roomsForProperty(property, list);
}

// Revenue-weighted occupancy / ADR / RevPAR over a row set. One implementation,
// so Dashboard, Compare and MTD Growth cannot disagree for the same period.
export function occupancyStats(occRows, properties) {
  const rows = occRows || [];
  const revenue = sum(rows, "room_revenue");
  const roomsSold = sum(rows, "rooms_sold");
  const capacity = capacityRoomNights(rows, properties);
  return {
    revenue,
    roomsSold,
    capacity,
    // Distinct business dates, not row count. Same root cause as the capacity bug
    // above: this PMS emits several rows per date, so `rows.length` reported 60
    // "days" for a 30-day month — and it sat in the same object as the occupancy
    // figure it was helping to halve.
    days: distinctDays(rows),
    occupancy: capacity ? roomsSold / capacity : 0,
    adr: roomsSold ? revenue / roomsSold : 0,
    revpar: capacity ? revenue / capacity : 0,
  };
}

// Group occupancy rows by property_id and compute per-property stats
export function perPropertyStats(occRows = [], properties = []) {
  const byProp = new Map();
  (occRows || []).forEach((r) => {
    const pid = r.property_id || "_default";
    if (!byProp.has(pid)) byProp.set(pid, []);
    byProp.get(pid).push(r);
  });

  const results = [];
  byProp.forEach((rows, pid) => {
    const prop = properties.find((p) => p.id === pid);
    const fallbackRooms = prop?.rooms || PROPERTY.rooms;
    const revenue = sumCents(rows.map(r => r.room_revenue));
    const roomsSold = sumCents(rows.map(r => r.rooms_sold));
    // Inventory per DAY, not per row — see capacityRoomNightsBy above. This
    // function carried its own copy of the per-row fallback, so the per-property
    // table under-reported occupancy for the same reason the portfolio total did.
    const capacity = capacityRoomNightsBy(rows, () => fallbackRooms) * 100;
    results.push({
      property_id: pid,
      property_name: prop?.name || rows[0]?.property_name || "Unknown",
      revenue: fromCents(revenue),
      roomsSold: fromCents(roomsSold),
      occupancy: capacity ? fromRate(divideRate(roomsSold, capacity)) : 0,
      adr: roomsSold ? fromCents(divide(revenue, roomsSold)) : 0,
      revpar: capacity ? fromCents(divide(revenue, capacity)) : 0,
      // Distinct business dates, not row count.
      days: distinctDays(rows),
      rooms: fallbackRooms,
    });
  });
  return results.sort((a, b) => b.revenue - a.revenue);
}