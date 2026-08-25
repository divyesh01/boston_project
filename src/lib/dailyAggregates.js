// Materialized daily financial aggregates.
//
// The Dashboard turns four daily ledgers (occupancy / source / gross / payment)
// plus expenses into its headline metrics via CalculationService. At scale that
// means scanning tens of thousands of raw rows every time a metric view opens.
//
// This module pre-computes, on every import, one row per (property_id,
// business_date) carrying the additive daily totals (and the few per-day derived
// figures the charts read). The Dashboard reconstructs synthetic per-day rows
// from the cache and feeds them to the same renderers — the math is identical
// (the service only sums across rows), but it reads a few hundred pre-summed
// rows instead of the raw ledger. The raw rows remain the source of truth; this
// cache is recomputed, never edited by hand.
import { db } from '@/api/base44Client';
import localDb from '@/api/localDb';
import { CARD_METHODS } from '@/lib/paymentNorm';
import { toCents, fromCents } from '@/lib/decimal';

// Stored aggregates are a materialized cache, not the source of truth. Version
// the cache whenever its units or shape change so an old browser cannot render a
// cents-valued source_net as dollars and turn a normal commission into a six-figure
// deduction. The raw ledgers remain available as the honest fallback.
export const DAILY_AGGREGATE_VERSION = 2;

const PAYMENT_FIELDS = [
  ...CARD_METHODS, 'cash', 'check', 'direct_bill', 'corpay', 'wire_transfer',
  'loyalty_certificate', 'loyalty_discount', 'vip_pass', 'other', 'closed_balance_folio',
];

// Per-day misc charge columns on GrossRevenueDay that the misc-charges breakdown
// reads. Carried through so that panel works off the cache too.
const GROSS_MISC_FIELDS = [
  'misc_charge', 'system_charge', 'food', 'event', 'bar', 'laundry', 'phone', 'other', 'beverage',
];

function inRange(dateStr, from, to) {
  if (!dateStr) return false;
  const d = String(dateStr).slice(0, 10);
  if (from && d < from) return false;
  if (to && d > to) return false;
  return true;
}

// The date column differs per ledger, and the index is named after it, so the
// bound has to be attached under the right key or planQuery has nothing to plan.
const LEDGER_DATE_FIELD = {
  OccupancyDay: 'date',
  SourceDay: 'date',
  GrossRevenueDay: 'date',
  PaymentDay: 'date',
  Expense: 'expense_date',
};

/**
 * A date range expressed as a query condition, so the read is narrowed by an
 * index instead of by discarding rows afterwards.
 *
 * planQuery() in base44Client.js turns `{ property_id: 'X', date: {$gte,$lte} }`
 * into `[property_id+date].between(...)` and a bare `{ date: {$gte,$lte} }` into
 * `date.between(...)`; both indexes are declared (localDb v14 for the ledgers,
 * v20 for the aggregate cache). With no condition to plan it reads the table, so
 * a one-month view used to materialize every row the property has ever had and
 * then throw almost all of them away.
 *
 * The upper bound is padded because these columns are not guaranteed to be
 * date-only — `ensure()` below slices ten characters off them for exactly that
 * reason. A stored '2026-08-31T23:30:00Z' sorts ABOVE '2026-08-31', so an
 * unpadded between() would silently drop that day. U+FFFF sorts above every
 * character a timestamp suffix can begin with, which makes the index range a
 * strict superset of what inRange() accepts — and inRange() still runs on the
 * result, so the rows returned are identical either way. Narrowing must never be
 * the thing that decides which rows exist.
 *
 * Exported for scripts/probe-ledger-index.mjs, which asserts that superset
 * property directly rather than trusting the argument above.
 *
 * @param {string} from inclusive lower bound, 'YYYY-MM-DD' (empty = unbounded)
 * @param {string} to inclusive upper bound, 'YYYY-MM-DD' (empty = unbounded)
 * @returns {{$gte?: string, $lte?: string} | null} null when neither bound is set
 */
export function dateBound(from, to) {
  const cond = {};
  if (from) cond.$gte = String(from).slice(0, 10);
  if (to) cond.$lte = `${String(to).slice(0, 10)}\uffff`;
  return Object.keys(cond).length ? cond : null;
}

async function fetchLedger(name, propertyId, from, to) {
  const query = {};
  const field = LEDGER_DATE_FIELD[name];
  const bound = field ? dateBound(from, to) : null;
  if (bound) query[field] = bound;

  let rows;
  if (propertyId && propertyId !== 'all') {
    query.property_id = propertyId;
    rows = await db.entities[name].filter(query);
  } else {
    // No 200000 cap. list() sorted by -created_date and then sliced, so once a
    // table passed that many rows the OLDEST rows fell out of the rebuild — and
    // because the Dashboard prefers this cache over the live ledgers, the days it
    // dropped would have shown as revenue that quietly went missing. The cap
    // never bounded memory either: the proxy materializes the whole table before
    // slicing it.
    rows = await db.entities[name].filter(query, '-created_date');
  }
  return rows.filter((r) => inRange(r.date || r.business_date || r.expense_date, from, to));
}

/**
 * One in-progress day bucket. Every MONEY field holds integer CENTS while it is
 * being accumulated; counts (`occ_rooms_sold`, `occ_capacity_rooms`, `stays`) hold
 * plain integers, which are already exact in floating point. `finalizeDay`
 * converts the money back to dollars once, at the end.
 *
 * @typedef {Object} DayAccumulator
 * @property {string} property_id
 * @property {string} business_date
 * @property {number} occ_revenue cents
 * @property {number} occ_rooms_sold count
 * @property {number} occ_capacity_rooms count
 * @property {Record<string, { net: number, stays: number }>} source_net net in cents
 * @property {number} gross_state_tax cents
 * @property {number} gross_city_tax cents
 * @property {number} gross_other_tax cents
 * @property {Record<string, number>} gross_misc cents
 * @property {Record<string, number>} payment cents
 * @property {number} payment_total cents
 * @property {Record<string, number>} expense_by_category cents
 */

/**
 * WHY THIS ACCUMULATES IN CENTS (2026-08-20)
 * ───────────────────────────────────────────────────────────────────────────────
 * Every field below used to be `+=` on a dollar value. That is not a rounding
 * nicety here: getDailyAggregates() below is PREFERRED by the Dashboard over the
 * live ledgers, and it falls back to the raw rows only when the cache is empty. So
 * a float residue did not merely make one number slightly wrong — it made the
 * cached path and the live path return different totals for the SAME period, which
 * is precisely the invariant CLAUDE.md requires to hold exactly ("must match
 * across all pages"). Whether the owner happened to look before or after an import
 * decided which of the two figures they saw, and no row could be blamed for the
 * difference.
 *
 * @returns {DayAccumulator}
 */
function newDay(pid, date) {
  return {
    property_id: pid,
    business_date: date,
    occ_revenue: 0, occ_rooms_sold: 0, occ_capacity_rooms: 0,
    source_net: {}, gross_state_tax: 0, gross_city_tax: 0, gross_other_tax: 0, gross_misc: {},
    payment: {}, payment_total: 0, expense_by_category: {},
  };
}

/**
 * Convert one accumulated day into the record that gets stored — money back to
 * dollars, counts untouched.
 *
 * The stored shape is unchanged (dollars), deliberately: buildSyntheticRows() and
 * every renderer downstream read these fields as dollars, and rows already sitting
 * in a user's IndexedDB from a previous build are dollars too. Changing the stored
 * unit would silently multiply every historical cached day by 100.
 *
 * BEST OUTCOME NOTE (2026-08-20): this is built key-by-key rather than by spreading
 * the accumulator and converting a list of known money keys. The two choices fail
 * in opposite directions. Key-by-key means a money field added to newDay and
 * forgotten here is simply ABSENT from the cache — a consumer reads 0 and a probe
 * that compares cached totals against the live ledger catches it. Spread-and-
 * convert means a forgotten field is stored in CENTS and rendered as a dollar
 * figure 100x too large, which looks like real revenue. Preferring the loud
 * failure is the point.
 *
 * @param {DayAccumulator} d
 */
function finalizeDay(d) {
  /** @param {Record<string, number>} obj */
  const centsToDollars = (obj) => {
    /** @type {Record<string, number>} */
    const out = {};
    for (const [k, v] of Object.entries(obj || {})) out[k] = fromCents(v);
    return out;
  };
  /** @type {Record<string, { net: number, stays: number }>} */
  const sourceNet = {};
  for (const [k, v] of Object.entries(d.source_net || {})) {
    sourceNet[k] = { net: fromCents(v.net), stays: v.stays };
  }
  return {
    aggregate_version: DAILY_AGGREGATE_VERSION,
    property_id: d.property_id,
    business_date: d.business_date,
    occ_revenue: fromCents(d.occ_revenue),
    occ_rooms_sold: d.occ_rooms_sold,
    occ_capacity_rooms: d.occ_capacity_rooms,
    source_net: sourceNet,
    gross_state_tax: fromCents(d.gross_state_tax),
    gross_city_tax: fromCents(d.gross_city_tax),
    gross_other_tax: fromCents(d.gross_other_tax),
    gross_misc: centsToDollars(d.gross_misc),
    payment: centsToDollars(d.payment),
    payment_total: fromCents(d.payment_total),
    expense_by_category: centsToDollars(d.expense_by_category),
  };
}

/**
 * Roll five raw ledgers into finalized (dollars) day records. Pure — no database,
 * no auth, no clock.
 *
 * Exported and kept separate from rebuildDailyAggregates for the same reason
 * src/lib/auditView.js exists: this is the arithmetic the Dashboard's preferred
 * read path depends on, and while it lived inside the async DB function the only
 * way to test it was to stand up fake-indexeddb, seed five entities and read the
 * cache back — so in practice it was never tested at all. Now
 * scripts/probe-decimal-integration.mjs can feed it the same rows it feeds
 * CalculationService and assert the two agree to the cent, which is the invariant
 * that actually matters.
 *
 * @param {{ occ?: any[], src?: any[], gross?: any[], pay?: any[], exp?: any[] }} ledgers
 */
export function aggregateDays({ occ = [], src = [], gross = [], pay = [], exp = [] } = {}) {
  /** @type {Map<string, DayAccumulator>} */
  const byDay = new Map();
  const ensure = (pid, date) => {
    const key = `${pid}|${date}`;
    let day = byDay.get(key);
    if (!day) {
      day = newDay(pid, date);
      byDay.set(key, day);
    }
    return day;
  };

  for (const r of occ) {
    const d = ensure(r.property_id, String(r.date).slice(0, 10));
    d.occ_revenue += toCents(r.room_revenue);
    d.occ_rooms_sold += Number(r.rooms_sold) || 0;
    d.occ_capacity_rooms += Number(r.total_rooms) || 0;
  }

  for (const r of src) {
    const date = String(r.date).slice(0, 10);
    const d = ensure(r.property_id, date);
    const key = r.source || r.code || 'UNKNOWN';
    const cur = d.source_net[key] || { net: 0, stays: 0 };
    cur.net += toCents(r.net_revenue);
    cur.stays += Number(r.stays) || 0;
    d.source_net[key] = cur;
  }

  for (const r of gross) {
    const d = ensure(r.property_id, String(r.date).slice(0, 10));
    d.gross_state_tax += toCents(r.state_tax);
    d.gross_city_tax += toCents(r.city_tax);
    d.gross_other_tax += toCents(r.other_tax);
    for (const f of GROSS_MISC_FIELDS) {
      d.gross_misc[f] = (d.gross_misc[f] || 0) + toCents(r[f]);
    }
  }

  for (const r of pay) {
    const d = ensure(r.property_id, String(r.date).slice(0, 10));
    for (const f of PAYMENT_FIELDS) {
      d.payment[f] = (d.payment[f] || 0) + toCents(r[f]);
    }
    d.payment_total += toCents(r.total);
  }

  for (const r of exp) {
    const d = ensure(r.property_id, String(r.expense_date).slice(0, 10));
    const cat = r.category || 'other';
    d.expense_by_category[cat] = (d.expense_by_category[cat] || 0) + toCents(r.amount);
  }

  return [...byDay.values()].map(finalizeDay);
}

// Recompute every (property_id, business_date) aggregate for the given scope and
// upsert into localDb.DailyFinancialAggregate. Idempotent: re-running for the
// same days overwrites them. Returns the number of day-rows written.
export async function rebuildDailyAggregates({ propertyId = 'all', from = '', to = '' } = {}) {
  const occ = await fetchLedger('OccupancyDay', propertyId, from, to);
  const src = await fetchLedger('SourceDay', propertyId, from, to);
  const gross = await fetchLedger('GrossRevenueDay', propertyId, from, to);
  const pay = await fetchLedger('PaymentDay', propertyId, from, to);
  const exp = await fetchLedger('Expense', propertyId, from, to);

  const days = aggregateDays({ occ, src, gross, pay, exp });

  let written = 0;
  await localDb.transaction('rw', localDb.DailyFinancialAggregate, async () => {
    for (const agg of days) {
      const existing = await localDb.DailyFinancialAggregate
        .where('[property_id+business_date]')
        .equals([agg.property_id, agg.business_date])
        .first();
       if (existing) {
        await localDb.DailyFinancialAggregate.update(existing.id, agg);
      } else {
        await localDb.DailyFinancialAggregate.add(agg);
      }
      written++;
    }
  });

  return { written, days: days.length };
}

// Read cached aggregates for a date range. Returns [] if the cache is empty
// (e.g. never built yet) so callers can fall back to live computation.
/**
 * @param {{ propertyId?: string | string[]; from?: string; to?: string }} [opts]
 */
export async function getDailyAggregates({ propertyId = 'all', from = '', to = '' } = {}) {
  // Read through db.entities, NOT the raw Dexie table. The proxy is what turns
  // `propertyId: 'all'` into "every property this account may see" rather than
  // "every property in the database", and what intersects an explicit list with
  // the caller's allowance instead of trusting it.
  //
  // This matters more than it looks: rebuildDailyAggregates() runs on every
  // import and the Dashboard PREFERS this cache over the live ledgers, falling
  // back only when it is empty. Reading raw here meant the numbers most people
  // look at first were the only ones with no property scoping at all.
  //
  // (rebuildDailyAggregates' writes above stay on raw localDb on purpose — they
  // run inside a localDb.transaction zone, and a proxy write there would await
  // the authorization lookup and kill the zone. See B6.)
  const query = {};
  if (propertyId && propertyId !== 'all') {
    query.property_id = Array.isArray(propertyId) ? { $in: propertyId } : propertyId;
  }
  // The date range belongs in the query, not in a .filter() afterwards. This is
  // the read the Dashboard makes on every metric view, and it used to materialize
  // every day the property had ever recorded in order to render one month of them.
  // With a single property selected planQuery() drives
  // [property_id+business_date].between(); with a list or the whole portfolio it
  // falls back to property_id.anyOf() / a scan, because `business_date` is not in
  // its single-field driver list — the cache is one row per property-day, so that
  // fallback reads hundreds of rows rather than the ledgers' tens of thousands.
  const bound = dateBound(from, to);
  if (bound) query.business_date = bound;
  const rows = await db.entities.DailyFinancialAggregate.filter(query);
  // Rows written before DAILY_AGGREGATE_VERSION used a different money-unit
  // contract. Do not guess whether a legacy row is dollars or cents: ignore it so
  // the caller falls back to raw ledgers. Guessing here is how the dashboard can
  // display an impossible commission larger than total revenue.
  return rows.filter((r) => r.aggregate_version === DAILY_AGGREGATE_VERSION)
    .filter((r) => inRange(r.business_date, from, to));
}

// Turn cached aggregates back into the synthetic per-day row shape the Dashboard
// and CalculationService expect, so no renderer math has to change.
export function buildSyntheticRows(aggregates) {
  const occRows = [];
  const srcRows = [];
  const grossRows = [];
  const payRows = [];
  const expenseRows = [];

  for (const a of aggregates) {
    const date = String(a.business_date).slice(0, 10);
    const roomsSold = a.occ_rooms_sold || 0;
    const capacity = a.occ_capacity_rooms || 0;
    const revenue = a.occ_revenue || 0;
    const occ = capacity > 0 ? roomsSold / capacity : 0;
    const adr = roomsSold > 0 ? revenue / roomsSold : 0;
    const revpar = capacity > 0 ? revenue / capacity : 0;

    if (revenue || roomsSold || capacity) {
      occRows.push({
        property_id: a.property_id,
        date,
        room_revenue: revenue,
        rooms_sold: roomsSold,
        total_rooms: capacity,
        occupancy: occ,
        adr,
        revpar,
      });
    }

    if (a.source_net) {
      for (const [key, v] of Object.entries(a.source_net)) {
        if (v.net || v.stays) {
          srcRows.push({ property_id: a.property_id, date, source: key, code: key, net_revenue: v.net, stays: v.stays });
        }
      }
    }

    if (a.gross_state_tax || a.gross_city_tax || a.gross_other_tax || (a.gross_misc && Object.values(a.gross_misc).some((x) => x))) {
      const g = { property_id: a.property_id, date, state_tax: a.gross_state_tax, city_tax: a.gross_city_tax, other_tax: a.gross_other_tax };
      for (const f of GROSS_MISC_FIELDS) g[f] = a.gross_misc?.[f] || 0;
      grossRows.push(g);
    }

    if (a.payment_total || (a.payment && Object.keys(a.payment).length)) {
      const pay = { property_id: a.property_id, date, total: a.payment_total };
      for (const f of PAYMENT_FIELDS) pay[f] = a.payment?.[f] || 0;
      payRows.push(pay);
    }

    if (a.expense_by_category) {
      for (const [cat, amt] of Object.entries(a.expense_by_category)) {
        if (amt) expenseRows.push({ property_id: a.property_id, expense_date: date, category: cat, amount: amt });
      }
    }
  }

  return { occRows, srcRows, grossRows, payRows, expenseRows };
}
