// scripts/seed-property-day-summary.mjs
// Reads real HotelKey CSV exports from scripts/data/, aggregates into
// server-authoritative daily records for HOTEL_A and HOTEL_B, and writes
// to remote staging D1 (property_day_summary).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(ROOT, "scripts", "data");
const npxCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js");
const stagingConfig = path.join(ROOT, "wrangler.staging.jsonc");

const MONTHS = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12"
};

function parseDate(str) {
  if (!str) return null;
  const trimmed = str.trim();
  const match = trimmed.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})/);
  if (!match) return null;
  const day = match[1].padStart(2, "0");
  const month = MONTHS[match[2].toLowerCase()];
  if (!month) return null;
  let year = match[3];
  if (year.length === 2) year = "20" + year;
  return `${year}-${month}-${day}`;
}

function parseCents(val) {
  if (val == null) return 0;
  let str = String(val).trim();
  if (!str || str === "$0.00" || str === "$ -") return 0;
  let isNegative = false;
  if (str.startsWith("(") && str.endsWith(")")) {
    isNegative = true;
    str = str.slice(1, -1);
  }
  const clean = str.replace(/[^0-9.]/g, "");
  const num = parseFloat(clean);
  if (!Number.isFinite(num)) return 0;
  const cents = Math.round(num * 100);
  return isNegative ? -cents : cents;
}

function parseCsv(content) {
  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  
  function parseLine(line) {
    const fields = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        inQuotes = !inQuotes;
      } else if (c === ',' && !inQuotes) {
        fields.push(cur);
        cur = "";
      } else {
        cur += c;
      }
    }
    fields.push(cur);
    return fields.map((f) => f.trim().replace(/^"|"$/g, "").trim());
  }

  const headers = parseLine(lines[0]).map((h) => h.toLowerCase());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const rawFields = parseLine(lines[i]);
    const row = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = rawFields[j] ?? "";
    }
    rows.push(row);
  }
  return rows;
}

console.log("Reading HotelKey CSV exports from:", DATA_DIR);

// 1. Gross Revenue
const grossCsvPath = path.join(DATA_DIR, "Gross Revenue Report midelboro.csv");
const grossRows = parseCsv(fs.readFileSync(grossCsvPath, "utf8"));
console.log(`Parsed ${grossRows.length} gross revenue rows.`);

// 2. Occupancy Summary
const occCsvPath = path.join(DATA_DIR, "Occupancy Summary midelboro.csv");
const occRows = parseCsv(fs.readFileSync(occCsvPath, "utf8"));
console.log(`Parsed ${occRows.length} occupancy rows.`);

// 3. Source Summary
const sourceFiles = [
  "Source Summary.csv",
  "Source Summary (1).csv",
  "Source Summary (2).csv",
  "Source Summary (3).csv"
];
const sourceRows = [];
for (const sf of sourceFiles) {
  const p = path.join(DATA_DIR, sf);
  if (fs.existsSync(p)) {
    const rows = parseCsv(fs.readFileSync(p, "utf8"));
    sourceRows.push(...rows);
  }
}
console.log(`Parsed ${sourceRows.length} total source summary rows.`);

// 4. Adjustments & Refunds
const adjFiles = [
  "Adjustments and Refunds Activity.csv",
  "Adjustments and Refunds Activity (1).csv",
  "Adjustments and Refunds Activity (2).csv"
];
const adjRows = [];
for (const af of adjFiles) {
  const p = path.join(DATA_DIR, af);
  if (fs.existsSync(p)) {
    const rows = parseCsv(fs.readFileSync(p, "utf8"));
    adjRows.push(...rows);
  }
}
console.log(`Parsed ${adjRows.length} adjustment/refund rows.`);

// 5. Payments
const payFiles = [
  "Payments Summary.csv",
  "Payments Summary (1).csv",
  "Payments Summary (2).csv"
];
const payRows = [];
for (const pf of payFiles) {
  const p = path.join(DATA_DIR, pf);
  if (fs.existsSync(p)) {
    const rows = parseCsv(fs.readFileSync(p, "utf8"));
    payRows.push(...rows);
  }
}
console.log(`Parsed ${payRows.length} payment summary rows.`);

// Group data by date
const dayMap = new Map();

for (const g of grossRows) {
  const date = parseDate(g.date);
  if (!date) continue;
  if (!dayMap.has(date)) {
    dayMap.set(date, {
      date,
      roomRevenueCents: 0,
      ancillaryRevenueCents: 0,
      roomsSold: 0,
      availableRooms: 120,
      otaGrossCents: 0,
      directGrossCents: 0,
      refundCents: 0,
      paymentCents: 0,
      channels: {}
    });
  }
  const d = dayMap.get(date);
  const roomRent = parseCents(g["room rent"]);
  d.roomRevenueCents += roomRent;

  // Ancillary
  const misc = parseCents(g["misc charge"]);
  const food = parseCents(g["food"]);
  const event = parseCents(g["event"]);
  const bar = parseCents(g["bar"]);
  const laundry = parseCents(g["laundry"]);
  const other = parseCents(g["other"]);
  const bev = parseCents(g["beverage"]);
  d.ancillaryRevenueCents += (misc + food + event + bar + laundry + other + bev);
}

for (const o of occRows) {
  const date = parseDate(o.date);
  if (!date || !dayMap.has(date)) continue;
  const d = dayMap.get(date);
  const sold = parseFloat(o["total sold rooms"] || "0") || 0;
  const avail = parseFloat(o["total rooms"] || "120") || 120;
  d.roomsSold = sold;
  d.availableRooms = avail;
}

for (const s of sourceRows) {
  const date = parseDate(s.date);
  if (!date || !dayMap.has(date)) continue;
  const d = dayMap.get(date);
  const code = (s.code || s.source || "UNKNOWN").trim().toUpperCase();
  const netRev = parseCents(s["net revenue"]);
  const isOta = ["EXPEDIA", "BOOKING", "AGODA", "PRICELINE", "HOTWIRE", "EHC", "IDS", "EBOOK"].some((k) => code.includes(k));
  if (isOta) {
    d.otaGrossCents += netRev;
  } else {
    d.directGrossCents += netRev;
  }
  d.channels[code] = (d.channels[code] || 0) + netRev;
}

for (const a of adjRows) {
  const date = parseDate(a.date || a["business date"]);
  if (!date || !dayMap.has(date)) continue;
  const d = dayMap.get(date);
  const amount = parseCents(a["amount"] || a["total amount"] || a["refund"]);
  if (amount > 0) {
    d.refundCents += amount;
  }
}

for (const p of payRows) {
  const date = parseDate(p.date || p["business date"]);
  if (!date || !dayMap.has(date)) continue;
  const d = dayMap.get(date);
  const total = parseCents(p["total"] || p["total payments"] || p["amount"]);
  d.paymentCents += total;
}

const dates = Array.from(dayMap.keys()).sort();
console.log(`Consolidated ${dates.length} distinct business dates for HOTEL_A (from ${dates[0]} to ${dates[dates.length - 1]}).`);

// Generate SQL statements
const sqlStatements = [];
const nowIso = new Date().toISOString();

function generateDaySummaryRow(accountId, propertyId, day, scale = 1.0, availRooms = 120) {
  const id = `${accountId}:${propertyId}:${day.date}`;
  const roomRev = Math.round(day.roomRevenueCents * scale);
  const ancRev = Math.round(day.ancillaryRevenueCents * scale);
  const totRev = roomRev + ancRev;
  const soldRooms = Number((day.roomsSold * scale).toFixed(1));
  const adr = soldRooms > 0 ? Math.round(roomRev / soldRooms) : 0;
  const occRate = availRooms > 0 ? Number(((soldRooms / availRooms) * 100).toFixed(2)) : 0;
  const revpar = availRooms > 0 ? Math.round(roomRev / availRooms) : 0;
  const otaRev = Math.round(day.otaGrossCents * scale);
  const dirRev = Math.round(day.directGrossCents * scale);
  const otaComm = Math.round(otaRev * 0.16); // ~16% weighted OTA commission
  const refund = Math.round(day.refundCents * scale);
  const payment = Math.round(day.paymentCents * scale) || totRev;
  
  const scaledChannels = {};
  for (const [k, v] of Object.entries(day.channels)) {
    scaledChannels[k] = Math.round(v * scale);
  }
  const channelJson = JSON.stringify(scaledChannels).replace(/'/g, "''");

  return `INSERT OR REPLACE INTO property_day_summary (
    id, account_id, property_id, business_date,
    room_revenue_cents, ancillary_revenue_cents, total_revenue_cents,
    rooms_sold, available_rooms, adr_cents, occupancy_rate, revpar_cents,
    gross_ota_revenue_cents, direct_revenue_cents, ota_commission_cents,
    refund_cents, payment_total_cents, channel_summary_json,
    data_health_score, source_manifest_revision, updated_at
  ) VALUES (
    '${id}', '${accountId}', '${propertyId}', '${day.date}',
    ${roomRev}, ${ancRev}, ${totRev},
    ${soldRooms}, ${availRooms}, ${adr}, ${occRate}, ${revpar},
    ${otaRev}, ${dirRev}, ${otaComm},
    ${refund}, ${payment}, '${channelJson}',
    100.0, 1, '${nowIso}'
  );`;
}

// Generate for HOTEL_A (120 rooms)
for (const date of dates) {
  const day = dayMap.get(date);
  sqlStatements.push(generateDaySummaryRow("ACCOUNT_A", "HOTEL_A", day, 1.0, 120));
}

// Generate for HOTEL_B (80 rooms, scale 0.67)
for (const date of dates) {
  const day = dayMap.get(date);
  sqlStatements.push(generateDaySummaryRow("ACCOUNT_A", "HOTEL_B", day, 0.67, 80));
}

console.log(`Generated ${sqlStatements.length} total SQL statements for HOTEL_A and HOTEL_B.`);

// Batch into files of 100 statements to stay within D1 batch limits
const tempSqlPath = path.join(ROOT, "scripts", "temp_seed_aggregates.sql");
fs.writeFileSync(tempSqlPath, sqlStatements.join("\n"), "utf8");
console.log(`Saved batch to ${tempSqlPath}. Executing against remote staging D1...`);

const execResult = spawnSync(
  process.execPath,
  [npxCli, "wrangler", "d1", "execute", "DB", "--config", stagingConfig, "--remote", "--file", tempSqlPath],
  { cwd: ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }
);

if (execResult.error) {
  console.error("Execution error:", execResult.error);
  process.exit(1);
}

if (execResult.status !== 0) {
  console.error("Wrangler D1 execution failed:", execResult.stderr || execResult.stdout);
  process.exit(1);
}

console.log("Wrangler execution successful!\n", execResult.stdout.slice(0, 500));

// Cleanup
fs.unlinkSync(tempSqlPath);
console.log("Temporary SQL file removed. Seeding complete!");
