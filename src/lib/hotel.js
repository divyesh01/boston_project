import { getCommissionRates } from "@/lib/commissionRates";
import { getAlertThresholds } from "@/lib/alertThresholds";
import { getRevenueColor, getRevenueGroup } from "@/lib/revenueThresholds";
export { getRevenueColor, getRevenueGroup };

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

export const money = (v) =>
  `$${Number(v || 0).toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
export const money2 = (v) =>
  `$${Number(v || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const pct = (v, digits = 1) => `${(Number(v || 0) * 100).toFixed(digits)}%`;
export const num = (v) => Number(v || 0).toLocaleString("en-IN");

export const sum = (rows, key) => rows.reduce((a, r) => a + (Number(r[key]) || 0), 0);
export const avg = (rows, key) => (rows.length ? sum(rows, key) / rows.length : 0);

export function inRange(dateStr, from, to) {
  if (!dateStr) return false;
  const d = String(dateStr).slice(0, 10);
  return d >= from && d <= to;
}

export function aggregate(rows, groupKey, valueKey, agg) {
  const map = new Map();
  rows.forEach((r) => {
    const k = r[groupKey] === undefined || r[groupKey] === null || r[groupKey] === "" ? "(blank)" : String(r[groupKey]).slice(0, 40);
    const v = Number(r[valueKey]);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(Number.isFinite(v) ? v : 0);
  });
  const out = [];
  map.forEach((vals, name) => {
    let value = 0;
    if (agg === "sum") value = vals.reduce((a, b) => a + b, 0);
    else if (agg === "avg") value = vals.reduce((a, b) => a + b, 0) / vals.length;
    else if (agg === "count") value = vals.length;
    else if (agg === "max") value = Math.max(...vals);
    else if (agg === "min") value = Math.min(...vals);
    out.push({ name, value: Math.round(value * 100) / 100 });
  });
  return out.sort((a, b) => b.value - a.value);
}

export function toCsv(rows) {
  if (!rows.length) return "";
  const keys = Object.keys(rows[0]);
  return [keys.join(","), ...rows.map((r) => keys.map((k) => `"${String(r[k] ?? "")}"`).join(","))].join("\n");
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
  // roomCounts: { [property_id]: number_of_rooms } — fallback to total_rooms from rows
  const revenue = sum(occRows, "total_revenue");
  const roomsSold = sum(occRows, "rooms_sold");

  // Calculate total capacity using per-property room counts
  const daysPerProp = new Map();
  occRows.forEach((r) => {
    const pid = r.property_id || "_default";
    daysPerProp.set(pid, (daysPerProp.get(pid) || 0) + 1);
  });
  let capacity = 0;
  daysPerProp.forEach((days, pid) => {
    const rooms = roomCounts?.[pid] ?? PROPERTY.rooms;
    capacity += days * rooms;
  });

  const occupancy = capacity ? roomsSold / capacity : 0;
  const adr = roomsSold ? revenue / roomsSold : 0;
  const revpar = capacity ? revenue / capacity : 0;
  return { revenue, roomsSold, capacity, occupancy, adr, revpar };
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
    const revenue = sum(rows, "total_revenue");
    const roomsSold = sum(rows, "rooms_sold");
    const capacity = rows.length * rooms;
    results.push({
      property_id: pid,
      property_name: prop?.name || rows[0]?.property_name || "Unknown",
      revenue,
      roomsSold,
      occupancy: capacity ? roomsSold / capacity : 0,
      adr: roomsSold ? revenue / roomsSold : 0,
      revpar: capacity ? revenue / capacity : 0,
      days: rows.length,
      rooms,
    });
  });
  return results.sort((a, b) => b.revenue - a.revenue);
}