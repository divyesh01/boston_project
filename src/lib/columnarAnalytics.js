/**
 * Columnar OLAP Analytics Cube (Step 3 — 100× Unified Engine)
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
