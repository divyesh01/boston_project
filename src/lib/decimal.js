// Fixed-decimal arithmetic for financial calculations
// Uses integer arithmetic with scaling to avoid floating-point errors
// All monetary values stored as integer cents (or basis points for rates)

export const SCALE = 100; // cents
export const RATE_SCALE = 10000; // basis points (0.01%)

export function toCents(value) {
  if (value == null) return 0;
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * SCALE);
}

export function fromCents(cents) {
  return cents / SCALE;
}

export function toRate(value) {
  if (value == null) return 0;
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * RATE_SCALE);
}

export function fromRate(rate) {
  return rate / RATE_SCALE;
}

export function add(a, b) {
  return toCents(a) + toCents(b);
}

export function subtract(a, b) {
  return toCents(a) - toCents(b);
}

export function multiply(a, b) {
  // a is monetary value, b is rate (as decimal, e.g., 0.15 for 15%)
  const aCents = toCents(a);
  const bRate = toRate(b);
  return Math.round((aCents * bRate) / RATE_SCALE);
}

export function divide(a, b) {
  const aCents = toCents(a);
  const bCents = toCents(b);
  if (bCents === 0) return 0;
  return Math.round((aCents * SCALE) / bCents);
}

export function divideRate(a, b) {
  // a and b are monetary values, return rate as basis points
  const aCents = toCents(a);
  const bCents = toCents(b);
  if (bCents === 0) return 0;
  return Math.round((aCents * RATE_SCALE) / bCents);
}

export function sumCents(values) {
  return values.reduce((sum, v) => sum + toCents(v), 0);
}

export function avgCents(values) {
  if (!values.length) return 0;
  return Math.round(sumCents(values) / values.length);
}

export function weightedAvg(values, weights) {
  if (!values.length || values.length !== weights.length) return 0;
  let weightedSum = 0;
  let weightSum = 0;
  for (let i = 0; i < values.length; i++) {
    const w = toCents(weights[i]);
    weightedSum += toCents(values[i]) * w;
    weightSum += w;
  }
  if (weightSum === 0) return 0;
  return Math.round(weightedSum / weightSum);
}

export function formatCents(cents, decimals = 2) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / SCALE);
  const centsPart = (abs % SCALE).toString().padStart(2, '0');
  if (decimals === 0) {
    return `${sign}$${dollars.toLocaleString('en-US')}`;
  }
  return `${sign}$${dollars.toLocaleString('en-US')}.${centsPart}`;
}

export function formatRate(rate, decimals = 2) {
  const pct = (rate / RATE_SCALE * 100).toFixed(decimals);
  return `${pct}%`;
}

// Canonical grouped-number formatter for the whole app.
// Locale is pinned to en-US so counters, staff counts and AI answers use the
// same thousands separators as formatCents (never the browser's locale).
//
// `decimals` may be 'auto' for values whose precision is not known ahead of time
// (generic chart series, which may hold counts, money or fractions). 'auto'
// keeps up to 3 decimals and pads none, matching a bare `toLocaleString()` so
// displayed precision is unchanged — it only pins the locale.
/**
 * @param {number} value
 * @param {number | 'auto'} [decimals]
 */
export function formatNumber(value, decimals = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0';
  if (decimals === 'auto') {
    return n.toLocaleString('en-US', { maximumFractionDigits: 3 });
  }
  return n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function roundCents(cents) {
  return Math.round(cents);
}

// Portfolio calculations using fixed decimal
export function portfolioOccupancy(occupancyRows, propertyRoomCounts) {
  // occupancyRows: array of { property_id, date, rooms_sold, total_rooms }
  // propertyRoomCounts: { [property_id]: number_of_rooms } (fallback for legacy rows)
  let totalSold = 0;
  let totalCapacity = 0;
  
  for (const row of occupancyRows) {
    const pid = row.property_id || '_default';
    totalSold += toCents(row.rooms_sold);
    const rowRooms = Number(row.total_rooms) || 0;
    totalCapacity += rowRooms > 0 ? rowRooms * SCALE : (propertyRoomCounts[pid] || 100) * SCALE;
  }
  
  if (totalCapacity === 0) return 0;
  return Math.round((totalSold * RATE_SCALE) / totalCapacity);
}

export function portfolioAdr(occupancyRows) {
  let totalRevenue = 0;
  let totalRoomsSold = 0;
  for (const row of occupancyRows) {
    totalRevenue += toCents(row.total_revenue);
    totalRoomsSold += toCents(row.rooms_sold);
  }
  if (totalRoomsSold === 0) return 0;
  return Math.round((totalRevenue * SCALE) / totalRoomsSold);
}

export function portfolioRevpar(occupancyRows, propertyRoomCounts) {
  const occupancy = portfolioOccupancy(occupancyRows, propertyRoomCounts);
  const adr = portfolioAdr(occupancyRows);
  return Math.round((occupancy * adr) / RATE_SCALE);
}