import { getCommissionRates } from "@/lib/commissionRates";
import { getAlertThresholds } from "@/lib/alertThresholds";
import { getRevenueColor, getRevenueGroup } from "@/lib/revenueThresholds";
export { getRevenueColor, getRevenueGroup };

import { toCents, fromCents, toRate, fromRate, add, subtract, multiply, divide, divideRate, sumCents, formatCents, formatRate, formatNumber, portfolioOccupancy, portfolioAdr, portfolioRevpar } from '@/lib/decimal';
import { neutralizeFormula } from '@/lib/securityUtils';

// Default property — used as fallback when no Property records exist yet
import * as XLSX from 'xlsx';
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
export const num = (v) => formatNumber(v);

export const sum = (rows, key) => fromCents(sumCents((rows || []).map(r => r[key])));
export const avg = (rows, key) => rows && rows.length ? sum(rows, key) / rows.length : 0;

export function inRange(dateStr, from, to) {
  if (!dateStr) return false;
  const d = String(dateStr).slice(0, 10);
  return d >= from && d <= to;
}

export function aggregate(rows, groupKey, valueKey, agg) {
  const map = new Map();
  (rows || []).forEach((r) => {
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

// Neutralize CSV formula injection (cells beginning with =, +, -, @, tab, CR).
// Applied on every export regardless of sanitizeCsv so unsanitized historical
// database values cannot smuggle formulas into downloads.
function csvCell(value) {
  let s = neutralizeFormula(String(value ?? ""));
  return `"${s.replace(/"/g, '""')}"`;
}

export function toCsv(rows) {
  if (!rows || !rows.length) return "";
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

export function downloadExcel(rows, name = "export.xlsx") {
  if (!rows || rows.length === 0) return;
  const worksheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Sheet1");
  XLSX.writeFile(workbook, name);
}

// Normalize employee/clerk names — trim, collapse repeated spaces, consistent casing
export function normalizeName(name) {
  return String(name || "").trim().replace(/\s+/g, " ");
}

// Weighted portfolio calculations — never average property percentages
export function portfolioStats(occRows, roomCounts) {
  const safeRows = occRows || [];
  const revenue = sumCents(safeRows.map(r => r.total_revenue));
  const roomsSold = sumCents(safeRows.map(r => r.rooms_sold));

  // Calculate total capacity using per-row total_rooms (actual inventory per date)
  // Falls back to Property.rooms for legacy rows missing total_rooms.
  const rooms = roomCountsFrom(roomCounts); // normalizes both properties arrays and plain maps
  let capacity = 0;
  safeRows.forEach((r) => {
    const pid = r.property_id || "_default";
    const rowRooms = Number(r.total_rooms) || 0;
    if (rowRooms > 0) {
      capacity += rowRooms * 100; // Scale to cents
    } else {
      capacity += (rooms[pid] ?? PROPERTY.rooms) * 100;
    }
  });

  const occupancy = capacity ? divideRate(roomsSold, capacity) : 0;
  const adr = roomsSold ? divide(revenue, roomsSold) : 0;
  const revpar = capacity ? divide(revenue, capacity) : 0;
  return { revenue: fromCents(revenue), roomsSold: fromCents(roomsSold), capacity: fromCents(capacity), occupancy: fromRate(occupancy), adr: fromCents(adr), revpar: fromCents(revpar) };
}

// Room count for one property id, falling back to the default only when the
// property genuinely has no configured inventory.
export function roomsForProperty(propertyId, properties) {
  const found = (properties || []).find((p) => p.id === propertyId);
  return Number(found?.rooms) || PROPERTY.rooms;
}

// Build a { property_id: rooms } map once, for the capacity helpers below.
//
// Defensively normalizes either shape callers pass for room inventory:
//   - Array of property objects [{ id, rooms|room_count|total_rooms }, ...]
//   - Plain key-value map { property_id: rooms, ... }
// Unknown shapes degrade to {} so downstream `?? PROPERTY.rooms` guards keep
// legacy rows at the default inventory.
export function roomCountsFrom(input) {
  if (!input) return {};

  // Case 1: Array of property objects (e.g., [{ id: 'prop_1', rooms: 50 }, ...])
  if (Array.isArray(input)) {
    const map = {};
    for (const prop of input) {
      if (prop && prop.id) {
        map[prop.id] = Number(prop.rooms || prop.room_count || prop.total_rooms) || PROPERTY.rooms;
      }
    }
    return map;
  }

  // Case 2: Plain key-value map object (e.g., { 'prop_1': 50, 'prop_2': 100 })
  if (typeof input === 'object') {
    const map = {};
    for (const [key, val] of Object.entries(input)) {
      map[key] = Number(val) || 0;
    }
    return map;
  }

  return {};
}

// Total room-nights of capacity represented by a set of occupancy rows.
//
// Capacity is the sum of per-row total_rooms (which reflects actual inventory
// per property per date, accounting for renovations, closures, seasonal changes).
// Falls back to Property.rooms × days for legacy rows missing total_rooms.
export function capacityRoomNights(occRows, properties) {
  const rooms = roomCountsFrom(properties);
  let capacity = 0;
  (occRows || []).forEach((r) => {
    const pid = r.property_id || "_default";
    const rowRooms = Number(r.total_rooms) || 0;
    if (rowRooms > 0) {
      capacity += rowRooms;
    } else {
      capacity += rooms[pid] ?? PROPERTY.rooms;
    }
  });
  return capacity;
}

// Physical room inventory in scope: one property's rooms, or the sum across the
// properties the current selection covers.
export function inventoryInScope(property, properties) {
  const list = properties || [];
  if (Array.isArray(property)) {
    const ids = new Set(property);
    const sel = list.filter((p) => ids.has(p.id));
    return sel.reduce((a, p) => a + (Number(p.rooms) || PROPERTY.rooms), 0) || PROPERTY.rooms;
  }
  if (!property || property === "all") {
    return list.reduce((a, p) => a + (Number(p.rooms) || PROPERTY.rooms), 0) || PROPERTY.rooms;
  }
  return roomsForProperty(property, list);
}

// Revenue-weighted occupancy / ADR / RevPAR over a row set. One implementation,
// so Dashboard, Compare and MTD Growth cannot disagree for the same period.
export function occupancyStats(occRows, properties) {
  const rows = occRows || [];
  const revenue = sum(rows, "total_revenue");
  const roomsSold = sum(rows, "rooms_sold");
  const capacity = capacityRoomNights(rows, properties);
  return {
    revenue,
    roomsSold,
    capacity,
    days: rows.length,
    occupancy: capacity ? roomsSold / capacity : 0,
    adr: roomsSold ? revenue / roomsSold : 0,
    revpar: capacity ? revenue / capacity : 0,
  };
}

// Group occupancy rows by property_id and compute per-property stats
export function perPropertyStats(occRows = [], properties = []) {
  const byProp = new Map();
  (occRows || []).forEach((r) => {
    const pid = r.property_id || "_default";
    if (!byProp.has(pid)) byProp.set(pid, []);
    byProp.get(pid).push(r);
  });

  const results = [];
  byProp.forEach((rows, pid) => {
    const prop = properties.find((p) => p.id === pid);
    const fallbackRooms = prop?.rooms || PROPERTY.rooms;
    const revenue = sumCents(rows.map(r => r.total_revenue));
    const roomsSold = sumCents(rows.map(r => r.rooms_sold));
    // Sum per-row total_rooms (actual inventory per date), fallback to Property.rooms
    let capacity = 0;
    rows.forEach((r) => {
      const rowRooms = Number(r.total_rooms) || 0;
      capacity += rowRooms > 0 ? rowRooms : fallbackRooms;
    });
    capacity *= 100; // Scale to cents
    results.push({
      property_id: pid,
      property_name: prop?.name || rows[0]?.property_name || "Unknown",
      revenue: fromCents(revenue),
      roomsSold: fromCents(roomsSold),
      occupancy: capacity ? fromRate(divideRate(roomsSold, capacity)) : 0,
      adr: roomsSold ? fromCents(divide(revenue, roomsSold)) : 0,
      revpar: capacity ? fromCents(divide(revenue, capacity)) : 0,
      days: rows.length,
      rooms: fallbackRooms,
    });
  });
  return results.sort((a, b) => b.revenue - a.revenue);
}