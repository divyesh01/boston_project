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

async function fetchLedger(name, propertyId, from, to) {
  let rows;
  if (propertyId && propertyId !== 'all') {
    rows = await db.entities[name].filter({ property_id: propertyId });
  } else {
    rows = await db.entities[name].list('-created_date', 200000);
  }
  return rows.filter((r) => inRange(r.date || r.business_date || r.expense_date, from, to));
}

function newDay(pid, date) {
  return {
    property_id: pid,
    business_date: date,
    occ_revenue: 0, occ_rooms_sold: 0, occ_capacity_rooms: 0,
    source_net: {}, gross_state_tax: 0, gross_city_tax: 0, gross_other_tax: 0, gross_misc: {},
    payment: {}, payment_total: 0, expense_by_category: {},
  };
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

  const byDay = new Map();
  const ensure = (pid, date) => {
    const key = `${pid}|${date}`;
    if (!byDay.has(key)) byDay.set(key, newDay(pid, date));
    return byDay.get(key);
  };

  for (const r of occ) {
    const d = ensure(r.property_id, String(r.date).slice(0, 10));
    d.occ_revenue += Number(r.total_revenue) || 0;
    d.occ_rooms_sold += Number(r.rooms_sold) || 0;
    d.occ_capacity_rooms += Number(r.total_rooms) || 0;
  }

  for (const r of src) {
    const date = String(r.date).slice(0, 10);
    const d = ensure(r.property_id, date);
    const key = r.source || r.code || 'UNKNOWN';
    const cur = d.source_net[key] || { net: 0, stays: 0 };
    cur.net += Number(r.net_revenue) || 0;
    cur.stays += Number(r.stays) || 0;
    d.source_net[key] = cur;
  }

  for (const r of gross) {
    const d = ensure(r.property_id, String(r.date).slice(0, 10));
    d.gross_state_tax += Number(r.state_tax) || 0;
    d.gross_city_tax += Number(r.city_tax) || 0;
    d.gross_other_tax += Number(r.other_tax) || 0;
    for (const f of GROSS_MISC_FIELDS) {
      d.gross_misc[f] = (d.gross_misc[f] || 0) + (Number(r[f]) || 0);
    }
  }

  for (const r of pay) {
    const d = ensure(r.property_id, String(r.date).slice(0, 10));
    for (const f of PAYMENT_FIELDS) {
      d.payment[f] = (d.payment[f] || 0) + (Number(r[f]) || 0);
    }
    d.payment_total += Number(r.total) || 0;
  }

  for (const r of exp) {
    const d = ensure(r.property_id, String(r.expense_date).slice(0, 10));
    const cat = r.category || 'other';
    d.expense_by_category[cat] = (d.expense_by_category[cat] || 0) + (Number(r.amount) || 0);
  }

  let written = 0;
  await localDb.transaction('rw', localDb.DailyFinancialAggregate, async () => {
    for (const agg of byDay.values()) {
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

  return { written, days: byDay.size };
}

// Read cached aggregates for a date range. Returns [] if the cache is empty
// (e.g. never built yet) so callers can fall back to live computation.
/**
 * @param {{ propertyId?: string | string[]; from?: string; to?: string }} [opts]
 */
export async function getDailyAggregates({ propertyId = 'all', from = '', to = '' } = {}) {
  let rows;
  if (propertyId && propertyId !== 'all') {
    if (Array.isArray(propertyId)) {
      rows = [];
      for (const pid of propertyId) {
        const part = await localDb.DailyFinancialAggregate.where('property_id').equals(pid).toArray();
        rows.push(...part);
      }
    } else {
      rows = await localDb.DailyFinancialAggregate.where('property_id').equals(propertyId).toArray();
    }
  } else {
    rows = await localDb.DailyFinancialAggregate.toArray();
  }
  return rows.filter((r) => inRange(r.business_date, from, to));
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
        total_revenue: revenue,
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
