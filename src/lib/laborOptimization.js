// Historical defaults. These two numbers were hardcoded in the body until
// 2026-08-25, which made the owner's "Checkout (min)" and "Stayover (min)"
// settings decorative: housekeepingConfig.js read, clamped and persisted them,
// this function ignored them, and the Housekeeping page reported "N minutes
// required" plus an estimated labor cost that never moved when they changed.
// They are kept AS the defaults so a caller that passes no standards gets the
// same answer it always got.
const DEFAULT_MINUTES_PER_CHECKOUT = 30;
const DEFAULT_MINUTES_PER_STAYOVER = 15;

// One housekeeper-shift, in minutes. Not owner-configurable, and not presented
// as if it were.
const MINUTES_PER_SHIFT = 480;

/**
 * Minutes of housekeeping labor a day needs, and the shift count that covers it.
 *
 * @param {number} checkouts - rooms needing a full turnover
 * @param {number} stayovers - rooms needing a refresh
 * @param {{minutesPerCheckout?: number, minutesPerStayover?: number}} [standards]
 *   Owner-tuned productivity standards, normally from `getHousekeepingConfig`.
 *   A missing or non-finite entry falls back to the historical default rather
 *   than to zero, so a partial object cannot silently erase the workload.
 * @returns {{requiredMinutes: number, staffNeeded: number, schedule: string}}
 */
export function generateHousekeepingSchedule(checkouts, stayovers, standards = {}) {
  const perCheckout = Number(standards.minutesPerCheckout);
  const perStayover = Number(standards.minutesPerStayover);
  const minutes =
    (checkouts || 0) * (Number.isFinite(perCheckout) ? perCheckout : DEFAULT_MINUTES_PER_CHECKOUT) +
    (stayovers || 0) * (Number.isFinite(perStayover) ? perStayover : DEFAULT_MINUTES_PER_STAYOVER);
  const staffNeeded = Math.ceil(minutes / MINUTES_PER_SHIFT);
  return {
    requiredMinutes: minutes,
    staffNeeded,
    schedule: `Generate ${staffNeeded} shift(s) for tomorrow.`,
  };
}
