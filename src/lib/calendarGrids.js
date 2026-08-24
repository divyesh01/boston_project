// Which calendar months a page should draw for the active global filter.
//
// WHY THIS IS ITS OWN MODULE
// MonthlyCalendar.jsx used to decide this inline with
//
//     const isMultiMonth = period === "monthly" && months.length > 1;
//     const displayMonths = isMultiMonth ? months : [month ?? new Date().getMonth()];
//
// which is false for every period except the multi-month picker. Under YTD the page
// therefore drew ONE grid, titled its header "for August 2026" and labelled its KPI
// card "Total Monthly Revenue" — while the KPIs underneath aggregated all 214 days
// of the range. The page described one month and measured eight. Deriving the grids
// from the same `dateRange` the KPIs are computed from is what keeps those two
// halves in agreement, and pulling the derivation out of the JSX is what lets
// scripts/probe-monthly-calendar.mjs assert it directly.
//
// `monthly` is the one period where `months` stays authoritative rather than the
// range: computeRangeFromMonths() in useGlobalFilters.jsx turns a non-contiguous
// pick (April + July) into a CONTIGUOUS range (Apr 1 - Jul 31) and the row filter
// then keeps only the picked months, so a range-derived list would draw two empty
// grids for May and June that the owner never asked for.

export const MAX_GRIDS = 24;

// Runaway guard, not a product limit. A mistyped custom "from" of 1900-01-01 would
// otherwise build a 1,500-element list on every keystroke.
const MAX_SPAN_MONTHS = 1200;

const isMonthIndex = (m) => Number.isInteger(m) && m >= 0 && m <= 11;

// Date-only strings must never go through `new Date(...)`: that parses them as UTC
// and, west of Greenwich, names the previous day — the trap formatDayLabel() in
// hotel.js exists to avoid. Slicing the ISO string cannot drift.
function parseYearMonth(iso) {
  if (typeof iso !== "string") return null;
  const m = /^(\d{4})-(\d{2})/.exec(iso.trim());
  if (!m) return null;
  const month = Number(m[2]) - 1;
  if (!isMonthIndex(month)) return null;
  return { year: Number(m[1]), month };
}

export function daysInMonth(year, month) {
  // Numeric local-time construction (no string parsing), so day 0 of the next
  // month is the last day of this one.
  return new Date(year, month + 1, 0).getDate();
}

// Every {year, month} touched by an inclusive ISO date range. The year travels with
// the month because a weekly or custom range can straddle a year boundary, and a
// grid titled "January" under a hardcoded calendar year is how Dec 2025 - Jan 2026
// used to render as two grids both labelled 2026.
export function monthsInRange(from, to) {
  const start = parseYearMonth(from);
  const end = parseYearMonth(to);
  if (!start || !end) return [];
  if (end.year < start.year || (end.year === start.year && end.month < start.month)) return [];

  const out = [];
  let { year, month } = start;
  while (out.length < MAX_SPAN_MONTHS) {
    out.push({ year, month });
    if (year === end.year && month === end.month) break;
    month += 1;
    if (month > 11) { month = 0; year += 1; }
  }
  return out;
}

// Mirrors the empty-selection rule in computeRangeFromMonths() (useGlobalFilters.jsx):
// the current year falls back to the current month, an earlier year to January. Used
// only when there is nothing to derive from at all — a custom period whose dates the
// owner has not filled in yet.
function fallbackMonth(year) {
  const today = new Date();
  const y = Number(year) || today.getFullYear();
  return { year: y, month: y === today.getFullYear() ? today.getMonth() : 0 };
}

// The full, UNCAPPED list of months the current filter covers. Callers cap what they
// render (MAX_GRIDS) and report the remainder, so the label describing the selection
// never disagrees with the KPIs measuring it.
/**
 * @param {{ period?: string, months?: number[], year?: number,
 *           dateRange?: { from?: string, to?: string } }} [filter]
 * @returns {{ year: number, month: number }[]}
 */
export function calendarMonths(filter = {}) {
  const { period, months, year, dateRange } = filter;

  if (period === "monthly" && Array.isArray(months)) {
    const picked = months.filter(isMonthIndex).sort((a, b) => a - b);
    if (picked.length) {
      const y = Number(year) || new Date().getFullYear();
      return picked.map((month) => ({ year: y, month }));
    }
  }

  const derived = monthsInRange(dateRange?.from, dateRange?.to);
  if (derived.length) return derived;
  return [fallbackMonth(year)];
}
