import { getOccThreshold } from '@/lib/hotel';

// The decision logic behind the Dashboard's "Yield & ADR" panel, extracted so it
// can be asserted in node. `src/components/dashboard/YieldAdvisor.jsx` renders
// what this returns and adds nothing to it. Same split as
// src/lib/actionCenter.js / src/pages/ActionCenter.jsx, and for the same reason:
// JSX cannot be imported by the probe harness, so logic that lives inside a .jsx
// file can only ever be checked by matching its source text.
//
// WHAT THIS REPLACES (measured 2026-08-25, YieldAdvisor.jsx at commit 22f3ab5).
// The panel used to compute its advice inline, in three if-branches, and every
// number in it was wrong in a different way:
//
//   "Increase Rack Rate by $10–$15/night"  and  "Drop rate $5–$8"
//       Literal dollar amounts, presented as the output of a panel titled
//       "Yield & ADR Optimizer", derived from nothing at all — not from ADR, not
//       from the room register, not from the pricing engine. The one panel on the
//       same screen that DOES compute a rate is `PricingPanel` (Dashboard.jsx
//       renders it directly above this one), which runs the real pricingEngine in
//       integer cents. Two rate recommendations on one screen, one measured and
//       one invented, free to disagree by any amount.
//
//   "lift ADR above ${money2(adr * 1.05)}"
//       Float multiplication on a dollar value, which CLAUDE.md's BUSINESS
//       directive forbids outright, and the 5% came from nowhere.
//
//   "Occupancy vs 100-room capacity"
//       A hardcoded inventory, on a page whose `capacity` is already the real
//       room-night total summed across the selected properties. 100 is only the
//       per-property FALLBACK when a row carries no `total_rooms`
//       (CalculationService.js#capacityCents), so this caption was false for any
//       property that is not exactly 100 rooms and for every multi-property
//       selection.
//
//   `occupancy > 0.6`
//       A hardcoded band boundary, while six other surfaces — including
//       `LowOccAlert` and `Dashboard.jsx` itself, on this same screen — gate on
//       the owner's configured `getOccThreshold()`. Set the target to 70% and the
//       alert flagged a 65% day as low occupancy while this panel called it
//       "Healthy Occupancy".
//
//   the empty database
//       With nothing imported, `occupancy` and `capacity` are both 0, which fell
//       through to the last branch: the panel advised cutting rates because no
//       report had been uploaded yet. An unmeasured period must read as
//       unmeasured (CLAUDE.md §4, UI: Truthful Experience).
//
// WHAT THIS DOES NOT DO. It does not recommend a rate. There is one rate
// recommender in this app and it is `pricingEngine.js`; adding a second here
// would recreate the disagreement above with better arithmetic. This returns a
// band, the target it was compared against, and the room-night basis — all
// measured — and points the reader at the panel that owns the number.

// How far above the owner's occupancy target counts as demand outrunning supply.
// This is an editorial band boundary, not a measurement, and it is expressed
// relative to the target so the panel moves when the owner moves the target. At
// the default target of 0.60 it reproduces the 0.80 boundary the panel shipped
// with, so no owner sees their bands shift because of this change.
export const STRONG_OCCUPANCY_MARGIN = 0.20;

/** @typedef {'strong'|'healthy'|'soft'|'unknown'} YieldBand */

/**
 * @param {object} input
 * @param {number} [input.occupancy] 0..1, from CalculationService.calculateOccupancyMetrics
 * @param {number} [input.capacity] room-NIGHTS available in the selected period
 * @param {number} [input.roomsSold] room-nights sold in the same period
 * @param {number} [input.threshold] the occupancy target; defaults to getOccThreshold()
 * @returns {{band: YieldBand, target: number, occupancy: number, capacity: number,
 *            roomsSold: number, headline: string, action: string, basis: string}}
 */
export function buildYieldAdvice({ occupancy, capacity, roomsSold, threshold } = {}) {
  // `Number(x) || fallback` would turn a legitimate 0 into the fallback, and 0 is
  // a meaningful value for all three of these.
  const occ = Number.isFinite(Number(occupancy)) ? Number(occupancy) : 0;
  const cap = Number.isFinite(Number(capacity)) ? Number(capacity) : 0;
  const sold = Number.isFinite(Number(roomsSold)) ? Number(roomsSold) : 0;
  const target = Number.isFinite(Number(threshold)) ? Number(threshold) : getOccThreshold();

  // Basis first, so the caption states what was actually counted even when there
  // is nothing to advise on.
  const basis = cap > 0
    ? `${fmtNights(sold)} of ${fmtNights(cap)} room-nights sold in the selected period`
    : 'No occupancy rows in the selected period';

  if (cap <= 0) {
    return {
      band: 'unknown', target, occupancy: occ, capacity: cap, roomsSold: sold, basis,
      headline: 'No occupancy to read yet',
      action: 'Import a hotel statistics report for this period, or widen the date range. Until there are room-nights to count, any rate advice here would be about a hotel with no rooms in it.',
    };
  }

  // `< target` is LowOccAlert's own test (`Number(r.occupancy) < threshold`), so a
  // day the alert flags cannot be called healthy here and vice versa.
  if (occ < target) {
    return {
      band: 'soft', target, occupancy: occ, capacity: cap, roomsSold: sold, basis,
      headline: 'Occupancy is below your target',
      action: 'Rooms are going unsold, so the room-nights are the constraint, not the rate. Open the low-occupancy days listed on this page and work the cheapest levers first — same-day and direct promotions, then OTA visibility. The Dynamic Pricing panel holds the engine\'s recommended rate; this panel does not set one.',
    };
  }

  if (occ >= target + STRONG_OCCUPANCY_MARGIN) {
    return {
      band: 'strong', target, occupancy: occ, capacity: cap, roomsSold: sold, basis,
      headline: 'Occupancy is well ahead of your target',
      action: 'Rooms are the scarce side of this period, so discounting gives away inventory that was selling anyway. Hold or lift rate on the tightest days and close the deepest discount channels. The Dynamic Pricing panel holds the engine\'s recommended rate.',
    };
  }

  return {
    band: 'healthy', target, occupancy: occ, capacity: cap, roomsSold: sold, basis,
    headline: 'Occupancy is at or above your target',
    action: 'Neither rate nor volume is obviously wrong here. The cheapest gain is mix rather than price: a night moved from an OTA to a direct booking keeps the commission, at the same rate. The Dynamic Pricing panel holds the engine\'s recommended rate.',
  };
}

// Room-nights are whole rooms on whole nights. They arrive here already summed in
// integer cents and divided back (CalculationService returns `fromCents(...)`), so
// a fractional value means the inventory itself was fractional — show it rather
// than hide it behind a round number.
function fmtNights(n) {
  const v = Number(n) || 0;
  return Number.isInteger(v) ? v.toLocaleString('en-US') : v.toLocaleString('en-US', { maximumFractionDigits: 2 });
}
