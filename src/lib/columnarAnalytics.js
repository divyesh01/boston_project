/**
 * SCAFFOLD — NOT WIRED, AND CANNOT RETURN A NON-ZERO NUMBER AS WRITTEN.
 *
 * This file described itself as the "Columnar OLAP Analytics Cube (Step 3 — 100×
 * Unified Engine)" until 2026-08-24. Measured on that date, the description was
 * wrong in both halves, so it is replaced with what the code actually is.
 *
 * Reachability: `grep -rn columnarAnalytics src base44 scripts backend tests`
 * returns NOTHING. `ColumnarCube` and `portfolioRevPar` are referenced only by
 * lines 4, 75 and 76 of this file. No page, library, probe or test imports it.
 * docs/brain/BRAIN_FRONTEND.md claimed Statistics.jsx depended on it and that
 * removing it would break Data Intelligence; Statistics.jsx imports
 * statisticsAnalytics.js and DataIntelligence.jsx imports dataScanner.js +
 * aiInsights.js. Both claims were false and are corrected there.
 *
 * Why it can only return zeros: every metric array is constructed at length 0
 * (`new Float64Array(0)` / `new Int32Array(0)`) and nothing ever reassigns them.
 * There is no ingestion method — `_ordinalForDate` is the only code that would
 * populate `dateOrdinal`, and nothing calls it. So `aggregate()`'s loop is
 * `for (i = 0; i < 0; i++)`, `count` stays 0, and every average falls through the
 * `results.count ? … : 0` guard. `portfolioRevPar()` therefore returns an
 * all-zero summary for any input, including a full portfolio. A caller wiring
 * this into a page would get a dashboard of zeros with no error to explain them,
 * which is worse than the missing feature: it looks like the hotel earned nothing.
 *
 * Also latent, and the reason this must not be wired up as-is: the property
 * bitmask is `1 << idx` on a 32-bit signed int. Property 31 sets the sign bit and
 * property 32 wraps to the same bit as property 0 — i.e. past 31 properties the
 * mask silently aggregates the wrong hotel. `propertyIndex` is built as
 * `Map(i => i)` by portfolioRevPar, discarding the property identities it was
 * handed, so the result could not be attributed to a property even if it had data.
 *
 * Left in place rather than deleted: deleting a file cascades into BRAIN_INDEX's
 * file catalogue and the anti-rot commit hook, and that is the owner's call.
 * Recommendation on record — delete it. Nothing reads it, and statisticsAnalytics.js
 * already does the job for the page this was supposedly built for.
 */
export class ColumnarCube {
  constructor(properties = []) {
    this.propertyIndex = new Map(properties.map((p, i) => [i, p]));
    this.dateIndex = new Map();
    this.dateOrdinal = new Map();
    this.metrics = {
      adrCents: new Float64Array(0),
      revParCents: new Float64Array(0),
      occupancyRate: new Float64Array(0),
      keepRate: new Float64Array(0),
      grossRevenueCents: new Float64Array(0),
      roomsSold: new Int32Array(0),
      capacityRooms: new Int32Array(0),
    };
    this.dimPropIndex = new Int32Array(0);
    this.dimDateOrdinal = new Int32Array(0);
  }

  static buildPropertyBitmask(indices) {
    let mask = 0;
    for (const idx of indices) mask |= (1 << idx);
    return mask;
  }

  static buildDateRangeBitmask(fromOrd, toOrd) {
    const mask = new Map();
    for (let d = fromOrd; d <= toOrd; d++) mask.set(d, true);
    return mask;
  }

  _ordinalForDate(dateStr) {
    if (!this.dateOrdinal.has(dateStr)) {
      const ord = this.dateOrdinal.size;
      this.dateOrdinal.set(dateStr, ord);
      this.dateIndex.set(ord, dateStr);
    }
    return this.dateOrdinal.get(dateStr);
  }

  /**
   * @param {{ propBitmask?: number, dateRangeMask?: any, dateFromOrd?: number, dateToOrd?: number }} [param]
   */
  aggregate(param = {}) {
    const { propBitmask = 0, dateRangeMask = null, dateFromOrd, dateToOrd } = param;
    const results = { totalAdrCents: 0, totalRevParCents: 0, totalOccupancyRate: 0, totalKeepRate: 0, totalGrossRevenueCents: 0, count: 0, propertiesMatched: new Set() };
    const adr = this.metrics.adrCents;
    for (let i = 0; i < adr.length; i++) {
      const propBit = 1 << this.dimPropIndex[i];
      if ((propBitmask & propBit) === 0) continue;
      const ord = this.dimDateOrdinal[i];
      if (dateRangeMask && !dateRangeMask.has(ord)) continue;
      if (dateFromOrd !== undefined && ord < dateFromOrd) continue;
      if (dateToOrd !== undefined && ord > dateToOrd) continue;
      results.totalAdrCents += adr[i];
      results.totalRevParCents += this.metrics.revParCents[i];
      results.totalOccupancyRate += this.metrics.occupancyRate[i];
      results.totalKeepRate += this.metrics.keepRate[i];
      results.totalGrossRevenueCents += this.metrics.grossRevenueCents[i];
      results.count += 1;
      results.propertiesMatched.add(this.dimPropIndex[i]);
    }
    return {
      ...results,
      avgAdrCents: results.count ? results.totalAdrCents / results.count : 0,
      avgRevParCents: results.count ? results.totalRevParCents / results.count : 0,
      avgOccupancyRate: results.count ? results.totalOccupancyRate / results.count : 0,
      avgKeepRate: results.count ? results.totalKeepRate / results.count : 0,
    };
  }
}

export function portfolioRevPar(propertiesData) {
  const cube = new ColumnarCube(propertiesData ? propertiesData.map((d, i) => i) : []);
  return cube.aggregate({ propBitmask: 0xFFFFFFFF, dateFromOrd: 0, dateToOrd: 9999 });
}
