import fs from 'fs';
import { parseCsvText } from '../src/lib/csvParser.js';

function scanAdjustmentsRefunds(rawRows, _meta) {
  const adjustments = [];
  const refunds = [];
  const summary = {};
  let state = "IDLE";
  let adjHeaders = null;
  let refHeaders = null;
  const headerIndex = (headers, ...keywords) => {
    if (!headers) return -1;
    return headers.findIndex((h) => {
      const lower = h.toLowerCase().trim();
      return keywords.some((kw) => lower.includes(kw));
    });
  };
  const parseAmount = (val) => {
    if (!val) return null;
    const str = String(val).replace(/[^0-9.-]/g, '');
    const parsed = parseFloat(str);
    return isNaN(parsed) ? null : parsed;
  };
  const convertDate = (d) => d;
  for (let i = 0; i < rawRows.length; i++) {
    const row = rawRows[i];
    if (!row || row.length === 0 || row.every((c) => String(c).trim() === "")) {
      if (state !== "IDLE") state = "IDLE";
      continue;
    }
    const lower = row.map((c) => String(c).toLowerCase().trim());
    const has = (kw) => lower.some((h) => h.includes(kw));
    if (has("adjusted amount") && has("room number")) {
      state = "ADJUSTMENTS";
      adjHeaders = row.map((c) => String(c).trim());
      continue;
    }
    if (has("payment type refunded")) {
      state = "REFUNDS";
      refHeaders = row.map((c) => String(c).trim());
      continue;
    }
    if (has("total") && (has("grand") || row.length <= 5)) {
      state = "SUMMARY";
      const label = String(row[0] || "").trim();
      const value = parseAmount(row[row.length - 1]) ?? 0;
      summary[label] = value;
      continue;
    }
    if (state === "ADJUSTMENTS" && adjHeaders) {
      if (has("total") || has("sub-total") || has("subtotal")) {
        const label = String(row[0] || "").trim();
        summary[`adj_${label}`] = parseAmount(row[row.length - 1]) ?? 0;
        continue;
      }
      
      const dateIdx      = headerIndex(adjHeaders, "date");
      const timeIdx      = headerIndex(adjHeaders, "time");
      const txnNumIdx    = headerIndex(adjHeaders, "transaction number", "trans #", "trans no");
      const roomIdx      = headerIndex(adjHeaders, "room number", "room #", "room");
      const adjAmtIdx    = headerIndex(adjHeaders, "adjusted amount");
      const userIdx      = headerIndex(adjHeaders, "username", "user name", "user");
      const cell = (idx) => (idx >= 0 && idx < row.length) ? String(row[idx]).trim() : "";

      adjustments.push({
        record_type: "adjustment",
        date: convertDate(cell(dateIdx)),
        time: cell(timeIdx),
        transactionNumber: cell(txnNumIdx),
        roomNumber: cell(roomIdx),
        adjustedAmount: parseAmount(cell(adjAmtIdx)) ?? 0,
        username: cell(userIdx),
      });
      continue;
    }
    if (state === "REFUNDS" && refHeaders) {
      if (has("total") || has("sub-total") || has("subtotal")) {
        const label = String(row[0] || "").trim();
        summary[`ref_${label}`] = parseAmount(row[row.length - 1]) ?? 0;
        continue;
      }
      const dateIdx      = headerIndex(refHeaders, "date");
      const timeIdx      = headerIndex(refHeaders, "time");
      const txnNumIdx    = headerIndex(refHeaders, "transaction number", "trans #", "trans no");
      const roomIdx      = headerIndex(refHeaders, "room number", "room #", "room");
      const amtIdx       = headerIndex(refHeaders, "amount");
      const userIdx      = headerIndex(refHeaders, "username", "user name", "user");
      const cell = (idx) => (idx >= 0 && idx < row.length) ? String(row[idx]).trim() : "";

      refunds.push({
        record_type: "refund",
        date: convertDate(cell(dateIdx)),
        time: cell(timeIdx),
        transactionNumber: cell(txnNumIdx),
        roomNumber: cell(roomIdx),
        amount: parseAmount(cell(amtIdx)) ?? 0,
        username: cell(userIdx),
      });
      continue;
    }
    if (state === "SUMMARY") {
      const label = String(row[0] || "").trim();
      if (label) {
        summary[label] = parseAmount(row[row.length - 1]) ?? 0;
      }
    }
  }
  return { adjustments, refunds };
}

const path = 'C:/Users/divye/.gemini/antigravity/brain/5d90d1ef-fdb0-47c4-910f-65d86325beb5/.user_uploaded/media_1786512688834.csv';
const rawRows = parseCsvText(fs.readFileSync(path, 'utf8'));
const result = scanAdjustmentsRefunds(rawRows, {});
console.log('Adjustments:', result.adjustments.length);
console.log('Refunds:', result.refunds.length);

const all = [...result.adjustments, ...result.refunds];
const keyFn = (r) => [
  r.record_type || "adj",
  r.date || "",
  r.time || "",
  r.username || "",
  r.roomNumber || "",
  r.transactionNumber || "",
  r.adjustedAmount ?? r.amount ?? 0,
].join("|");

const seen = new Set();
const deduped = [];
for (const r of all) {
  const k = keyFn(r);
  if (!seen.has(k)) {
    seen.add(k);
    deduped.push(r);
  }
}
console.log('Deduped exactly:', deduped.length);
