// Owner-facing analysis must be deterministic. This module deliberately turns
// imported facts into an explanation before any optional language model is
// involved, so a fluent response can never invent a financial cause.

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DOMAIN_WORDS = [
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "money", "revenue", "profit", "occupancy", "expedia", "booking", "booking.com",
  "channel", "payment", "refund", "payroll", "expense", "rooms", "sold", "low", "high",
];
const ALIASES = new Map([
  ["whi", "why"], ["wat", "what"],
  ["mony", "money"], ["munny", "money"], ["revinue", "revenue"], ["revenu", "revenue"],
  ["occupncy", "occupancy"], ["ocupancy", "occupancy"], ["expida", "expedia"],
  ["bookng", "booking"], ["fridy", "friday"], ["mondayy", "monday"],
]);

function distance(a, b) {
  const left = String(a || "");
  const right = String(b || "");
  const row = Array.from({ length: right.length + 1 }, (_, i) => i);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const previous = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (left[i - 1] === right[j - 1] ? 0 : 1));
      diagonal = previous;
    }
  }
  return row[right.length];
}

/**
 * Correct only well-known business vocabulary. Property names, dates and
 * amounts are never fuzzy-corrected because a silent financial interpretation
 * is worse than a clarification question.
 */
export function normalizeOwnerQuestion(question) {
  const corrections = [];
  const normalized = String(question || "").replace(/\b[\p{L}.]+\b/gu, (token) => {
    const original = token.toLowerCase();
    let replacement = ALIASES.get(original);
    if (!replacement && original.length >= 4) {
      const candidates = DOMAIN_WORDS.filter((word) => Math.abs(word.length - original.length) <= 1 && distance(original, word) <= 1);
      if (candidates.length === 1) replacement = candidates[0];
    }
    if (replacement && replacement !== original) {
      corrections.push({ from: token, to: replacement });
      return replacement;
    }
    return token;
  });
  return { normalized, corrections };
}

export function requestedWeekdays(question) {
  const q = String(question || "").toLowerCase();
  return DAY_NAMES.filter((day) => new RegExp(`\\b${day.toLowerCase()}\\b`, "i").test(q));
}

function dateFor(row) {
  return String(row?.date || row?.business_date || row?.expense_date || "").slice(0, 10);
}

function weekdayOf(row) {
  const value = dateFor(row);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  // T12 prevents a local timezone offset from moving the business date.
  return DAY_NAMES[new Date(`${value}T12:00:00`).getDay()];
}

function datesFor(rows, weekday) {
  return new Set((rows || []).filter((row) => weekdayOf(row) === weekday).map(dateFor));
}

function averageByWeekday(rows, weekday, field, dates) {
  const total = (rows || [])
    .filter((row) => weekdayOf(row) === weekday)
    .reduce((sum, row) => sum + (Number(row[field]) || 0), 0);
  return dates.size ? total / dates.size : 0;
}

function channelAverage(rows, weekday, dates) {
  const out = new Map();
  (rows || []).filter((row) => weekdayOf(row) === weekday).forEach((row) => {
    const name = String(row.source || row.code || "Unknown").trim() || "Unknown";
    out.set(name, (out.get(name) || 0) + (Number(row.net_revenue) || 0));
  });
  return [...out.entries()].map(([name, revenue]) => ({ name, revenue: dates.size ? revenue / dates.size : 0 }));
}

function percent(change, baseline) {
  return baseline ? (change / baseline) * 100 : null;
}

/**
 * Produces facts, data gaps, and safe follow-up questions for an owner asking
 * why one weekday is low and another is high. It intentionally does not claim
 * why a channel changed: inventory, rate parity and cancellations need separate
 * data before they can become facts.
 */
export function weekdayPerformanceAnalysis({ occupancyRows = [], sourceRows = [], paymentRows = [], firstDay, secondDay }) {
  const firstDates = datesFor(occupancyRows, firstDay);
  const secondDates = datesFor(occupancyRows, secondDay);
  if (!firstDates.size || !secondDates.size) {
    return { available: false, missing: "occupancy", firstDates: firstDates.size, secondDates: secondDates.size };
  }

  const metric = (weekday, dates) => {
    const revenue = averageByWeekday(occupancyRows, weekday, "room_revenue", dates);
    const rooms = averageByWeekday(occupancyRows, weekday, "rooms_sold", dates);
    const capacity = averageByWeekday(occupancyRows, weekday, "total_rooms", dates);
    const refunds = Math.abs(averageByWeekday(paymentRows, weekday, "closed_balance_folio", dates))
      + Math.abs(averageByWeekday(paymentRows, weekday, "loyalty_discount", dates));
    return { revenue, rooms, capacity, occupancy: capacity ? rooms / capacity : 0, adr: rooms ? revenue / rooms : 0, refunds };
  };

  const first = metric(firstDay, firstDates);
  const second = metric(secondDay, secondDates);
  const channelDeltas = new Map();
  channelAverage(sourceRows, firstDay, firstDates).forEach((item) => channelDeltas.set(item.name, { name: item.name, first: item.revenue, second: 0 }));
  channelAverage(sourceRows, secondDay, secondDates).forEach((item) => {
    const current = channelDeltas.get(item.name) || { name: item.name, first: 0, second: 0 };
    current.second = item.revenue;
    channelDeltas.set(item.name, current);
  });
  const channels = [...channelDeltas.values()]
    .map((item) => ({ ...item, change: item.second - item.first }))
    .sort((a, b) => Math.abs(b.change) - Math.abs(a.change));

  return {
    available: true,
    firstDay,
    secondDay,
    firstDates: firstDates.size,
    secondDates: secondDates.size,
    first,
    second,
    delta: {
      revenue: second.revenue - first.revenue,
      rooms: second.rooms - first.rooms,
      occupancy: second.occupancy - first.occupancy,
      adr: second.adr - first.adr,
      refunds: second.refunds - first.refunds,
    },
    channels,
    sourceDataAvailable: sourceRows.some((row) => weekdayOf(row) === firstDay || weekdayOf(row) === secondDay),
    refundDataAvailable: paymentRows.some((row) => weekdayOf(row) === firstDay || weekdayOf(row) === secondDay),
    percent,
  };
}
