// Shared grid / header / row helpers for the HotelKey report parsers.
//
// Extracted VERBATIM from reportParsers.js with zero behaviour change: these three
// helpers carry no report-specific business logic, touch no database, and do no
// money math. They are the pure part of the parser - report-type detection from a
// header signature, a key-based row de-duplicator, and the lazy object-form wrapper.

import { rowsToObjects } from '@/lib/csvParser';
import { TXN_SIGNATURE } from '@/lib/transactionNorm';

export function dedupByKey(rows, keyFn) {
  const seen = new Set();
  return rows.filter((r) => {
    const key = keyFn(r);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Returns { rawRows, objects }. `objects` is a lazy getter: the header-keyed
// object form is derived on first access and cached. The transaction ledger has
// ~17k rows across five stacked sections with different headers, so building
// objects from section 1's headers would be both wrong for that report and a
// pure waste of a pass; its scanner works from rawRows directly and never
// touches the getter. Every other report type sees exactly what it saw before.
export function withLazyObjects(rawRows, eager) {
  let cache = eager;
  return {
    rawRows,
    get objects() {
      if (cache === undefined) cache = rowsToObjects(rawRows);
      return cache;
    },
  };
}

export function detectReportType(fileUrl, rawRows, meta) {
  const checkUrl = meta?.sourceFile || fileUrl;
  const fileName = decodeURIComponent(String(checkUrl || "").split("#").pop() || "").toLowerCase();
  
  // Scan the first 20 rows for signature headers
  for (let i = 0; i < Math.min(20, (rawRows || []).length); i++) {
    const row = rawRows[i];
    if (!row || !row.length) continue;
    
    const header = row.map((c) => String(c).trim().toLowerCase());
    const has = (kw) => header.some((h) => h.includes(kw));

    // Adjustments & Refunds Activity — checked early because its header may
    // overlap with the transactions ledger (both have "transaction type").
    if (has("adjustment reason code") || has("payment type refunded")) {
      return "adjustments_refunds";
    }

    // All Transactions ledger. Checked before the flat-table types below because
    // its header also contains "transaction description", which the payments and
    // gross checks would otherwise claim. Requires the full signature, so a
    // single overlapping word is not enough to misroute a file here.
    if (TXN_SIGNATURE.every((kw) => header.some((h) => h === kw || h.includes(kw)))) {
      return "transactions";
    }

    // Hotel Statistics (universal parser)
    if (has("description") && (has("actual today") || has("m-t-d") || has("mtd") || has("y-t-d") || has("ytd"))) {
      return "hotel_statistics";
    }

    // Clerk Shift & Cash Audit
    if (has("payment type") && has("actual") && has("net today")) return "clerk";
    if (has("username") && has("start time")) return "clerk";

    // Timecard / clock-in-clock-out export. Requires a clock pin plus a
    // date-ish column so a generic employee spreadsheet is not misrouted.
    if ((has("clock in") || has("clock_in") || has("time in") || has("time_in"))) {
      if (has("clock out") || has("clock_out") || has("time out") || has("time_out")) {
        return "timecard";
      }
    }

    // Payments Summary
    if ((has("cash") && (has("check") || has("amex") || has("visa") || has("master")))) {
      return "payments";
    }

    // Source Summary
    if (has("code") && has("source") && has("net revenue")) return "source";

    // Gross Revenue
    if (has("room rent") && (has("misc charge") || has("advance deposit") || has("beverage"))) return "gross";

    // Occupancy Summary
    if (has("total sold rooms") || (has("room revenue") && (has("revpar") || has("occupancy")))) return "occupancy";
  }

  // Fallbacks by filename
  if (/adjust.*refund|refund.*adjust/i.test(fileName)) return "adjustments_refunds";
  if (/hotel.?stat/i.test(fileName)) return "hotel_statistics";
  if (/all.?transactions?|transaction.?(list|ledger|detail)/i.test(fileName)) return "transactions";
  if (/clerk|shift|cash audit/i.test(fileName)) return "clerk";
  if (/timecard|timesheet|clock.?in|punch/i.test(fileName)) return "timecard";
  if (/payments? summary/i.test(fileName)) return "payments";
  if (/source summary/i.test(fileName)) return "source";
  if (/gross revenue/i.test(fileName)) return "gross";
  if (/occupancy/i.test(fileName)) return "occupancy";

  return "generic";
}
