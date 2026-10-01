import { getSettingsVersion } from './settingsBus.js';
import { getEnterpriseConfig } from './enterpriseConfigEngine.js';
import { getRevenueThresholds } from './revenueThresholds.js';
import { toCents, fromCents } from './decimal.js';

let thresholdVersion = -1;
const legacyThresholds = new Map();
function legacyThreshold(propertyId) {
  const version = getSettingsVersion();
  if (version !== thresholdVersion) { legacyThresholds.clear(); thresholdVersion = version; }
  const key = String(propertyId);
  if (!legacyThresholds.has(key)) legacyThresholds.set(key, getRevenueThresholds(propertyId));
  return legacyThresholds.get(key);
}
export function classifyPropertyDay(row, property = {}) {
  const cfg = getEnterpriseConfig(row.property_id, String(row.date).slice(0, 10), property);
  const capacity = Number(row.total_rooms) > 0 ? Number(row.total_rooms) : cfg.capacity;
  const legacy = legacyThreshold(row.property_id);
  const high = cfg.high_revpar != null && capacity > 0 ? fromCents(toCents(cfg.high_revpar) * capacity) : legacy.highRevenueThreshold;
  const medium = cfg.medium_revpar != null && capacity > 0 ? fromCents(toCents(cfg.medium_revpar) * capacity) : legacy.mediumRevenueThreshold;
  const revenue = toCents(row.room_revenue);
  const group = revenue >= toCents(high) ? 'high' : revenue >= toCents(medium) ? 'medium' : 'low';
  const roomsSold = Number(row.rooms_sold);
  const contribution = cfg.cpor != null && row.rooms_sold != null && row.rooms_sold !== '' && Number.isFinite(roomsSold) && roomsSold >= 0 ? fromCents(revenue - Math.round(toCents(cfg.cpor) * roomsSold)) : null;
  return { high, medium, capacity, group, contribution, marginHigh: contribution != null && cfg.margin_high != null && contribution >= cfg.margin_high };
}
export function classifyPortfolioDay(rows, properties) {
  const groups = new Map();
  for (const row of rows) {
    const key = JSON.stringify([row.property_id,String(row.date).slice(0,10)]);
    const cur = groups.get(key) || { ...row,revenueCents:0,rooms_sold:0,total_rooms:0,unitsKnown:true };
    cur.revenueCents += toCents(row.room_revenue);
    cur.unitsKnown &&= row.rooms_sold != null && row.rooms_sold !== '' && Number.isFinite(Number(row.rooms_sold));
    cur.rooms_sold += Number(row.rooms_sold) || 0;
    if (Number(row.total_rooms) > 0) cur.total_rooms += Number(row.total_rooms);
    groups.set(key,cur);
  }
  const classified = [...groups.values()].map(row => classifyPropertyDay({...row,room_revenue:fromCents(row.revenueCents),rooms_sold:row.unitsKnown ? row.rooms_sold : null}, properties.find(p => String(p.id) === String(row.property_id)) || {}));
  const high = classified.reduce((n, r) => n + toCents(r.high), 0), medium = classified.reduce((n, r) => n + toCents(r.medium), 0);
  const revenue = rows.reduce((n, r) => n + toCents(r.room_revenue), 0);
  return { high: fromCents(high), medium: fromCents(medium), group: revenue >= high ? 'high' : revenue >= medium ? 'medium' : 'low',
    contribution: classified.every(r => r.contribution != null) ? fromCents(classified.reduce((n, r) => n + toCents(r.contribution), 0)) : null,
    marginHigh: classified.length > 0 && classified.every(r => r.marginHigh) };
}
