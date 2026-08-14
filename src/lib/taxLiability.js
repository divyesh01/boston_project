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
}) {
  return {
    state: liabState,
    city: liabCity,
    other: liabOther,
    stateRecords: taxRecords["State Tax"],
    cityRecords: taxRecords["City/Local Tax"],
    otherRecords: taxRecords["Other Taxes"],
    passThrough,
    estimated: taxIsActual ? 0 : estimatedTaxFromRates,
    effectiveRate: effectiveTaxRate,
  };
}
