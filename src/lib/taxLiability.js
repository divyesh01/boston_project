import { toCents, fromCents, multiply } from "@/lib/decimal";

export function summarizeTaxCalculations(calculations = []) {
  const groups = new Map();
  for (const row of calculations) {
    const key = JSON.stringify([row.property_id,row.basis,row.rates]);
    const group = groups.get(key) || {
      property_id:row.property_id,basis:row.basis,rates:row.rates,
      baseCents:0,stateCents:0,cityCents:0,otherCents:0,dates:new Set(),
    };
    group.baseCents += toCents(row.base);
    for (const name of ['state','city','other']) group[name+'Cents'] += toCents(row[name]);
    if (row.date) group.dates.add(row.date);
    groups.set(key,group);
  }
  return [...groups.values()].map(group => {
    const dates = [...group.dates].sort();
    const base = fromCents(group.baseCents);
    return {
      property_id:group.property_id,basis:group.basis,rates:group.rates,base,
      from:dates[0],to:dates.at(-1),days:dates.length,
      ...Object.fromEntries(['state','city','other'].map(key=>[key,fromCents(group[key+'Cents'])])),
      rounding:Object.fromEntries(['state','city','other'].map(key=>[key,group.rates ? fromCents(group[key+'Cents']-multiply(base,group.rates[key])) : 0])),
    };
  });
}

/**
 * Builds the tax object consumed by the Money Kept UI.
 *
 * The dashboard reads tax as a structured object (tax.state / .city / .other,
 * matching .stateRecords / .cityRecords / .otherRecords, plus the imported
 * passThrough and the estimated tax + combined effectiveRate used for the
 * explanatory note). Keeping this pure makes the per-jurisdiction liability
 * calculation unit-testable and prevents regressions where `tax` is
 * accidentally returned as a bare number (which produces NaN/undefined in the
 * TaxRow rendering).
 */
export function buildTaxObject({
  liabState,
  liabCity,
  liabOther,
  taxRecords,
  passThrough,
  taxIsActual,
  estimatedTaxFromRates,
  effectiveTaxRate,
  calculations = [],
}) {
  const summaries = summarizeTaxCalculations(calculations);
  const estimates = summaries.filter(row=>row.basis==='estimated');
  const oneRate = key => {
    const values = new Set(estimates.map(row=>row.rates[key]));
    return values.size===1 ? [...values][0] : undefined;
  };
  const combined = new Set(estimates.map(row=>row.rates.state+row.rates.city+row.rates.other));
  return {
    state: liabState,
    city: liabCity,
    other: liabOther,
    stateRecords: taxRecords["State Tax"],
    cityRecords: taxRecords["City/Local Tax"],
    otherRecords: taxRecords["Other Taxes"],
    passThrough,
    estimated: taxIsActual ? 0 : estimatedTaxFromRates,
    effectiveRate: effectiveTaxRate ?? (combined.size===1 ? [...combined][0] : undefined),
    rates:{state:oneRate('state'),city:oneRate('city'),other:oneRate('other')},
    calculations:summaries,
  };
}
