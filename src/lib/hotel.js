import { getCommissionRates } from "@/lib/commissionRates";
import { getAlertThresholds } from "@/lib/alertThresholds";
import { getRevenueColor, getRevenueGroup } from "@/lib/revenueThresholds";
export { getRevenueColor, getRevenueGroup };

import { toCents, fromCents, toRate, fromRate, add, subtract, multiply, divide, divideRate, sumCents, formatCents, formatRate, portfolioOccupancy, portfolioAdr, portfolioRevpar } from '@/lib/decimal';

// Default property — used as fallback when no Property records exist yet
export const PROPERTY = { name: "Red Roof Inn & Suites Middleborough", code: "RRI1416", rooms: 100 };

export const C = {
  purple: "#6C63FF",
  cyan: "#00D4FF",
  green: "#00E096",
  amber: "#FFB547",
  coral: "#FF6B6B",
};

export const CHART_COLORS = [C.purple, C.cyan, C.green, C.amber, C.coral, "#9B8CFF", "#4FE3C1", "#FF9F7A"];

export function getOccThreshold() {
  return getAlertThresholds().occupancyThreshold ?? 0.60;
}

export function commissionFor(source = "") {
  const rates = getCommissionRates();
  const n = String(source).toUpperCase();
  let best = null;
  let bestLen = 0;
  for (const [key, info] of Object.entries(rates)) {
    if (n.includes(key) && key.length > bestLen) {
      best = info;
      bestLen = key.length;
    }
  }
  return best || { type: "none", rate: 0, taxExempt: false };
}

export const money = (v) => formatCents(toCents(v), 0);
export const money2 = (v) => formatCents(toCents(v), 2);
export const pct = (v, digits = 1) => formatRate(toRate(v), digits);
export const num = (v) => Number(v || 0).toLocaleString("en-IN");

export const sum = (rows, key) => fromCents(sumCents(rows.map(r => r[key])));
export const avg = (rows, key) => rows.length ? sum(rows, key) / rows.length : 0;

export function inRange(dateStr, from, to) {
  if (!dateStr) return false;
  const d = String(dateStr).slice(0, 10);
  return d >= from && d <= to;
}

export function aggregate(rows, groupKey, valueKey, agg) {
  const map = new Map();
  rows.forEach((r) => {
    const k = r[groupKey] === undefined || r[groupKey] === null || r[groupKey] === "" ? "(blank)" : String(r[groupKey]).slice(0, 40);
    const v = toCents(r[valueKey]);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(v);
  });
  const out = [];
  map.forEach((vals, name) => {
    let value = 0;
    if (agg === "sum") value = fromCents(vals.reduce((a, b) => a + b, 0));
    else if (agg === "avg") value = fromCents(Math.round(vals.reduce((a, b) => a + b, 0) / vals.length));
    else if (agg === "count") value = vals.length;
    else if (agg === "max") value = fromCents(Math.max(...vals));
    else if (agg === "min") value = fromCents(Math.min(...vals));
    out.push({ name, value: Math.round(value * 100) / 100 });
  });
  return out.sort((a, b) => b.value - a.value);
}

// Neutralize CSV formula injection (cells beginning with =, +, -, @, tab, CR)
function csvCell(value) {
  let s = String(value ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}

export function toCsv(rows) {
  if (!rows.length) return "";
  const keys = Object.keys(rows[0]);
  return [keys.join(","), ...rows.map((r) => keys.map((k) => csvCell(r[k])).join(","))].join("\n");
}

export function downloadCsv(rows, name = "export.csv") {
  const blob = new Blob([toCsv(rows)], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

// Normalize employee/clerk names — trim, collapse repeated spaces, consistent casing
export function normalizeName(name) {
  return String(name || "").trim().replace(/\s+/g, " ");
}

// Weighted portfolio calculations — never average property percentages
export function portfolioStats(occRows, roomCounts) {
  const revenue = sumCents(occRows.map(r => r.total_revenue));
  const roomsSold = sumCents(occRows.map(r => r.rooms_sold));

  // Calculate total capacity using per-property room counts
  const daysPerProp = new Map();
  occRows.forEach((r) => {
    const pid = r.property_id || "_default";
    daysPerProp.set(pid, (daysPerProp.get(pid) || 0) + 1);
  });
  let capacity = 0;
  daysPerProp.forEach((days, pid) => {
    const rooms = roomCounts?.[pid] ?? PROPERTY.rooms;
    capacity += days * rooms * 100; // Scale to cents
  });

  const occupancy = capacity ? divideRate(roomsSold, capacity) : 0;
  const adr = roomsSold ? divide(revenue, roomsSold) : 0;
  const revpar = capacity ? divide(revenue, capacity) : 0;
  return { revenue: fromCents(revenue), roomsSold: fromCents(roomsSold), capacity: fromCents(capacity), occupancy: fromRate(occupancy), adr: fromCents(adr), revpar: fromCents(revpar) };
}

// Group occupancy rows by property_id and compute per-property stats
export function perPropertyStats(occRows, properties) {
  const byProp = new Map();
  occRows.forEach((r) => {
    const pid = r.property_id || "_default";
    if (!byProp.has(pid)) byProp.set(pid, []);
    byProp.get(pid).push(r);
  });

  const results = [];
  byProp.forEach((rows, pid) => {
    const prop = properties.find((p) => p.id === pid);
    const rooms = prop?.rooms || PROPERTY.rooms;
    const revenue = sumCents(rows.map(r => r.total_revenue));
    const roomsSold = sumCents(rows.map(r => r.rooms_sold));
    const capacity = rows.length * rooms * 100; // Scale to cents
    results.push({
      property_id: pid,
      property_name: prop?.name || rows[0]?.property_name || "Unknown",
      revenue: fromCents(revenue),
      roomsSold: fromCents(roomsSold),
      occupancy: capacity ? fromRate(divideRate(roomsSold, capacity)) : 0,
      adr: roomsSold ? fromCents(divide(revenue, roomsSold)) : 0,
      revpar: capacity ? fromCents(divide(revenue, capacity)) : 0,
      days: rows.length,
      rooms,
    });
  });
  return results.sort((a, b) => b.revenue - a.revenue);
}