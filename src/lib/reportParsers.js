import { db, runInTransaction, createImportSession, completeImportSession, failImportSession, addImportRecordIds } from '@/api/base44Client';
import localDb from '@/api/localDb';

import {
  fetchCsvRows, rowsToObjects, convertDate, isIsoDate, parseAmount, isCsvFile, detectSections, parseCsvText,
} from "@/lib/csvParser";

import { parseHotelReport, makeFileDedupKey, generateFileHash } from '@/lib/universalParser';

import {
  TXN_SIGNATURE, TXN_COLUMN_MAP, mapTransactionRow, isTrailerRow, assignDedupeKeys,
} from '@/lib/transactionNorm';
import { toCents, fromCents, sumCents } from '@/lib/decimal';
import { neutralizeFormula } from '@/lib/securityUtils';
import { validateImport, makeFinding, recordCoercion, SEVERITY } from '@/lib/importValidation';
import { detectAnomalies, detectClerkAnomalies } from '@/lib/anomalyDetector';
// Statically imported on purpose. This used to be `await import()` at the point of
// use, inside the timecard import — which runs in a Dexie transaction zone. A
// dynamic import is a macrotask, so awaiting one leaves the zone and Dexie commits
// early: PrematureCommitError, mid-import, with rows already written (blocker B6).
// timecardCalc only pulls in @/lib/decimal, so there is no cycle to avoid here.
import { normalisePunch } from '@/lib/timecardCalc';
export { neutralizeFormula };

// Serialize report imports to prevent double-click/parallel duplicate writes.
let importQueue = Promise.resolve();
async function serial(target) {
  const run = importQueue.then(
    () => target,
    () => target
  );
  importQueue = run.catch(() => {});
  return run;
}

// Post-import integrity pass: remove duplicate rows (same entity key) within a
// property, keeping the earliest-created copy. Fixes duplicates from past
// imports, double-clicks, and files imported twice under different names.
async function dedupePropertyRows(entity, propertyId, keyFn) {
  try {
    // Reading the property's whole history is the point here — this pass also
    // clears duplicates left by earlier imports, so it cannot be narrowed to the
    // dates in the file just landed. It is index-driven either way: planQuery()
    // turns { property_id } into property_id.equals(). What is gone is the 100000
    // cap. Sorted ascending by created_date and then sliced, the rows it dropped
    // were the NEWEST ones — the rows this import just wrote. A property past that
    // many rows would have had the dedupe pass silently stop covering exactly the
    // rows it exists to check. The cap never bounded memory: the proxy
    // materializes the whole table before slicing it.
    const all = await db.entities[entity].filter(propertyId ? { property_id: propertyId } : {}, "created_date");
    const seen = new Map();
    const removeIds = [];
    for (const r of all) {
      const k = keyFn(r);
      const cur = seen.get(k);
      if (!cur) {
        seen.set(k, r);
        continue;
      }
      const curCreated = new Date(cur.created_date || 0).getTime();
      const rCreated = new Date(r.created_date || 0).getTime();
      if (rCreated < curCreated || (rCreated === curCreated && Number(r.id) < Number(cur.id))) {
        removeIds.push(cur.id);
        seen.set(k, r);
      } else {
        removeIds.push(r.id);
      }
    }
    if (removeIds.length) {
      await db.entities[entity].bulkDelete(removeIds);
    }
    return removeIds.length;
  } catch (e) {
    console.warn('[reportParsers] cleanup pass skipped:', e.message);
    return 0;
  }
}

// Track IDs of created records so rollback can delete exactly what an import
// wrote — no date-range guessing, no collateral damage to rows that were
// already there.
//
// Writes to ImportRecordIds, NOT to the lifecycle session in base44Client.js.
// Those were both called "ImportSession" until v11; see localDb.js for why.
//
// Failing to record ids would leave an import that cannot be undone, so this
// rethrows: the caller runs inside the import transaction, and losing the
// rollback ledger should abort the import rather than silently produce
// unremovable rows.
async function recordCreatedIds(entity, propertyId, importId, ids) {
  await addImportRecordIds(importId, entity, ids, propertyId || "");
}

// Run the anomaly engine over newly imported transaction rows and persist any
// flagged alerts for owner review. Idempotent: alerts carry a dedupe_key, so a
// force re-import never stacks a second copy. Created ids go into the rollback
// ledger, so an undo also removes the alerts the import produced.
async function persistAnomalyAlerts(rows, meta) {
  const propertyId = meta.propertyId || "";
  const alerts = detectAnomalies(rows || []);
  if (!alerts.length) return { count: 0, audit: null };

  const stamped = alerts.map((a) => ({
    ...a,
    property_id: propertyId,
    property_name: meta.propertyName || "",
    import_id: meta.importId || "",
    source_file: meta.sourceFile || "",
    status: "open",
  }));

  const existing = propertyId
    ? await db.entities.AnomalyAlert.filter({ property_id: propertyId })
    : [];
  const seen = new Set(existing.map((a) => a.dedupe_key));
  const fresh = stamped.filter((a) => !seen.has(a.dedupe_key));

  let createdIds = [];
  if (fresh.length) {
    for (let i = 0; i < fresh.length; i += 400) {
      const batch = fresh.slice(i, i + 400);
      const created = await db.entities.AnomalyAlert.bulkCreate(batch);
      createdIds.push(...created.map((r) => r.id));
    }
  }
  if (createdIds.length) {
    await recordCreatedIds("AnomalyAlert", propertyId, meta.importId, createdIds);
  }
  // Returns an audit descriptor so the HMAC audit-log entry is written by the
  // caller AFTER the import transaction commits — logging inside the transaction
  // would race Dexie's auto-commit and either roll back with the import or throw
  // a PrematureCommitError. A post-commit write only records what actually stuck.
  const types = [...new Set(fresh.map((a) => a.alert_type))].sort();
  return {
    count: createdIds.length,
    audit: createdIds.length
      ? { propertyId, propertyName: meta.propertyName || "", importId: meta.importId || "", count: createdIds.length, types }
      : null,
  };
}

export const REPORT_TYPES = [
  { key: "auto", label: "Auto-detect (recommended)" },
  { key: "occupancy", label: "Occupancy Summary" },
  { key: "source", label: "Source Summary" },
  { key: "gross", label: "Gross Revenue" },
  { key: "payments", label: "Payments Summary" },
  { key: "clerk", label: "Clerk Shift & Cash Audit" },
  { key: "hotel_statistics", label: "Hotel Statistics (Universal)" },
  { key: "transactions", label: "All Transactions (Ledger)" },
  { key: "adjustments_refunds", label: "Adjustments & Refunds Activity" },
  { key: "timecard", label: "Timecard (Clock In/Out)" },
  { key: "generic", label: "Any other spreadsheet" },
];

const COLUMN_MAP = {
  Date: "date", date: "date",
  "Day Of Week": "day_of_week", "Day of Week": "day_of_week", "day_of_week": "day_of_week",
  Code: "code", code: "code",
  Source: "source", source: "source",
  "Net Revenue": "net_revenue", net_revenue: "net_revenue",
  Stays: "stays", stays: "stays",
  ADR: "adr", adr: "adr",
  "Occupancy Contribution": "occupancy_contribution", occupancy_contribution: "occupancy_contribution",
  "RevPAR Contribution": "revpar_contribution", "Revpar Contribution": "revpar_contribution",
  revpar_contribution: "revpar_contribution",
  "Room Revenue": "room_revenue", room_revenue: "room_revenue",
  "Other Room Revenue": "other_room_revenue", other_room_revenue: "other_room_revenue",
  "Total Revenue": "total_revenue_with_misc", total_revenue: "total_revenue_with_misc",
  "Total Rooms": "total_rooms", total_rooms: "total_rooms",
  "Total Sold Rooms": "rooms_sold", "Total Sold Rooms ": "rooms_sold",
  "Sold Rooms Without Comp": "rooms_sold_without_comp",
  "Down Rooms": "down_rooms", "Vacant Rooms": "vacant_rooms",
  "Clean Rooms": "clean_rooms", "Dirty Rooms": "dirty_rooms",
  "Stayover Rooms": "stayover_rooms", "Same Day Bookings": "same_day_bookings",
  "Comp Rooms": "comp_rooms", "House Rooms": "house_rooms",
  "Zero Rate Rooms": "zero_rate_rooms", "Day Use Rooms": "day_use_rooms",
  "Total No Shows": "no_shows", "Total Cancellations": "cancellations",
  "Total Guests": "total_guests",
  // The Occupancy Summary export prints FOUR occupancy columns, one per denominator
  // convention, all in percent form (19 means 19%). Only ONE is mapped, deliberately:
  //
  //   Occupancy Including OOO Comp and House Use            <- mapped
  //   Occupancy Excluding OOO Comp and House Use            <- not mapped
  //   Occupancy Including OOO Excluding Comp and House Use  <- not mapped
  //   Occupancy Excluding OOO Including Comp and House Use  <- not mapped
  //
  // Mapping more than one would be a silent bug rather than extra coverage: mapRow
  // iterates Object.entries, so the last matching column in the row would overwrite
  // the earlier ones and which definition "won" would depend on column order.
  //
  // The one chosen is the one that matches the audited room counts. Measured over
  // `scripts/data/Occupancy Summary midelboro.csv`: 214 rows compared,
  // `Total Sold Rooms / Total Rooms x 100` equals this column on every row, 0
  // mismatches at 2dp. The other three use denominators the data model does not carry
  // (out-of-order, comp and house-use rooms are separate columns), so importing them
  // as "occupancy" would mean four different numbers under one name.
  //
  // ADDED 2026-08-20. Before this, no header spelling mapped to `occupancy` at all,
  // even though `occupancy` is in NUMERIC_FIELDS and is a declared field on the
  // OccupancyDay entity. Consequences, in order of how quietly each one failed:
  //   1. Every import of a clean Occupancy Summary raised an `unknown_columns`
  //      warning naming all four columns. A warning that fires on every good file
  //      trains the owner to dismiss the one that matters.
  //   2. A file with sold rooms but no `Total Rooms` imported occupancy as 0 — a full
  //      hotel recorded as empty, and it propagates into ADR and RevPAR.
  //   3. The percent-form branch in scanReport was unreachable, so it could not be
  //      tested. See the DEFECT FIXED note there.
  // This mapping changes no imported value for the real file (room counts are present
  // and still take precedence); it only makes the fallback reachable and correct.
  "Occupancy Including OOO Comp and House Use": "occupancy",
  "Revpar With OOO Rooms": "revpar", "Revpar Without OOO Rooms": "revpar_without_ooo",
  "RevPAR With OOO Rooms": "revpar", "RevPAR Without OOO Rooms": "revpar_without_ooo",
  "Room Rent": "room_rent", "Misc Charge": "misc_charge",
  System: "system_charge", Food: "food", Event: "event", Bar: "bar",
  Laundry: "laundry", Phone: "phone", Other: "other",
  "State Tax": "state_tax", "state tax": "state_tax",
  "City Tax": "city_tax", "city tax": "city_tax",
  "City/County Tax": "city_tax", "Local Tax": "city_tax", "Local City Tax": "city_tax",
  "Other Tax": "other_tax", "other tax": "other_tax",
  "Non Revenue": "non_revenue", "Advance Deposit": "advance_deposit", Beverage: "beverage",
  CASH: "cash", CHECK: "check",
  "CLOSED BALANCE FOLIO": "closed_balance_folio", CORPAY: "corpay",
  "DIRECT BILL": "direct_bill", AMEX: "amex", DISCOVER: "discover",
  MASTER: "master", VISA: "visa",
  // The Payments Summary prints its tender columns in all-caps, so `OTHER` never
  // matched the `Other: "other"` entry above (this map is exact-match, not
  // case-folded). ADDED 2026-08-20: `other` is a DECLARED field on the PaymentDay
  // entity, so the schema always expected this column — only the mapping was missing,
  // and the tender was dropped from the method breakdown without a word.
  //
  // Measured impact on existing data: nil. Across all three real Payments Summary
  // files (217 rows) the OTHER column is 0.00 on every row, so no historical figure
  // moves. The defect was latent: the first day a guest settles through an "other"
  // tender, the per-method breakdown stops summing to the printed `Total` and the
  // difference has nowhere to show up.
  OTHER: "other",
  "LOYALTY CERTIFICATE": "loyalty_certificate", "LOYALTY DISCOUNT": "loyalty_discount",
  "VIP PASS": "vip_pass", "WIRE TRANSFER": "wire_transfer",
  Total: "total", TOTAL: "total",
};

const NUMERIC_FIELDS = new Set([
  "room_revenue", "other_room_revenue", "total_revenue", "total_rooms", "rooms_sold",
  // The occupancy export's "Total Revenue" column maps here (see COLUMN_MAP), so
  // this MUST be a numeric field or mapRow stores the raw CSV STRING — "$5,713.42"
  // as text — and every consumer summing the field silently reads 0. Found because
  // scripts/acceptance-harness.mjs compared this exact figure against the source
  // file and got dash=0 while every room-level metric passed. Anything added to
  // COLUMN_MAP that carries a number belongs in this set too.
  "total_revenue_with_misc",
  "rooms_sold_without_comp", "down_rooms", "vacant_rooms", "clean_rooms", "dirty_rooms",
  "stayover_rooms", "same_day_bookings", "comp_rooms", "house_rooms", "zero_rate_rooms",
  "day_use_rooms", "no_shows", "cancellations", "total_guests", "adr", "occupancy", "revpar",
  "revpar_without_ooo",
  "net_revenue", "stays", "room_rent", "misc_charge", "system_charge", "food", "event",
  "bar", "laundry", "phone", "other", "non_revenue", "advance_deposit", "beverage",
  "occupancy_contribution", "revpar_contribution",
  "actual", "adjusted", "net_today", "amount", "transaction_count",
  "cash", "check", "closed_balance_folio", "corpay", "direct_bill", "amex", "discover",
  "master", "visa", "loyalty_certificate", "loyalty_discount", "vip_pass", "wire_transfer",
  "state_tax", "city_tax", "other_tax",
  "total",
]);

// The report-type -> store map. EXPORTED 2026-08-20 so that the set of stores an
// import writes to is declared exactly once. src/lib/importReset.js derives what a
// "clear all imported data" must empty from these values, because the previous
// arrangement kept a second, hand-copied list of table names inside a React event
// handler in src/pages/Import.jsx — and that copy was already two entries short.
// Adding a report type here now also teaches clear-all about it.
export const ENTITY = {
  occupancy: "OccupancyDay",
  source: "SourceDay",
  gross: "GrossRevenueDay",
  payments: "PaymentDay",
  hotel_statistics: "HotelMetric",
  transactions: "TransactionLine",
  adjustments_refunds: "AdjustmentRefund",
};
const REVENUE_COL = {
  occupancy: "room_revenue",
  source: "net_revenue",
  gross: "room_rent",
  payments: "total",
};

function mapRow(obj, coercions) {
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined || value === "") continue;
    const fieldName = COLUMN_MAP[key];
    if (fieldName) {
      if (NUMERIC_FIELDS.has(fieldName)) {
        const raw = String(value).trim();
        const parsed = parseAmount(raw);
        // Logged through the shared classifier so this path and the transaction
        // ledger's mapper describe an identical value identically. Unparseable
        // values are still kept as 0 (matching the old behaviour) — the log is
        // what stops that 0 from looking like a real zero.
        recordCoercion(coercions, fieldName, raw, parsed);
        out[fieldName] = parsed === null ? 0 : parsed;
      } else {
        out[fieldName] = value;
      }
    }
  }
  return out;
}

function addMeta(obj, meta) {
  return {
    ...obj,
    property_id: meta.propertyId || "",
    property_name: meta.propertyName || "",
    import_id: meta.importId || "",
    source_file: meta.sourceFile || "",
    report_type: meta.type || "",
  };
}

function dedupByKey(rows, keyFn) {
  const seen = new Set();
  return rows.filter((r) => {
    const key = keyFn(r);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function skipExisting(entity, rows, keyFn, propertyId) {
  if (!rows || rows.length === 0) return [];

  const filter = propertyId ? { property_id: propertyId } : {};
  
  // Optimization: Find the relevant date field used in this entity to limit the scan.
  const sample = rows[0];
  let dateField = null;
  if ('date' in sample) dateField = 'date';
  else if ('business_date' in sample) dateField = 'business_date';
  else if ('shift_date' in sample) dateField = 'shift_date';
  else if ('review_date' in sample) dateField = 'review_date';

  let existing = [];
  // No row cap on any of these three reads. `seen` below decides which incoming
  // rows are duplicates, so a truncated read does not merely slow things down —
  // it makes rows that ARE already stored look new and imports them a second
  // time. Both fallback branches sorted ascending and sliced, so the rows they
  // dropped were the most recent ones, which is where duplicates actually cluster.
  if (dateField) {
    const dates = [...new Set(rows.map(r => r[dateField]).filter(Boolean))];
    if (dates.length > 0) {
       // planQuery() plans this as date.anyOf(dates) for `date`/`shift_date`
       // entities. `business_date` and `review_date` are indexed but are not in
       // its driver list, so those two fall back to property_id.equals() — a
       // wider scan, same rows.
       filter[dateField] = { $in: dates };
       existing = await db.entities[entity].filter(filter, dateField);
    } else {
       existing = await db.entities[entity].filter(filter, "created_date");
    }
  } else {
    existing = await db.entities[entity].filter(filter, "created_date");
  }

  const seen = new Set(existing.map(keyFn));
  
  // Also track import_ids to prevent cross-session duplicates
  const seenImportIds = new Set(
    existing.filter(r => r.import_id).map(r => r.import_id)
  );
  
  return rows.filter((r) => {
    // Check business key duplicate
    if (seen.has(keyFn(r))) return false;
    // Check import_id duplicate (prevent re-importing same session)
    if (r.import_id && seenImportIds.has(r.import_id)) return false;
    return true;
  });
}

// Returns { rawRows, objects }. `objects` is a lazy getter: the header-keyed
// object form is derived on first access and cached. The transaction ledger has
// ~17k rows across five stacked sections with different headers, so building
// objects from section 1's headers would be both wrong for that report and a
// pure waste of a pass; its scanner works from rawRows directly and never
// touches the getter. Every other report type sees exactly what it saw before.
function withLazyObjects(rawRows, eager) {
  let cache = eager;
  return {
    rawRows,
    get objects() {
      if (cache === undefined) cache = rowsToObjects(rawRows);
      return cache;
    },
  };
}

// CSV injection defense (neutralizeFormula) belongs ONLY on export — see
// hotel.js csvCell. It must NEVER be applied on import: prefixing a value like
// '-12.50' with an apostrophe before parsing corrupts numeric data into NaN.
async function getRowsArray(type, fileUrl, meta) {
  // If CSV text was pre-read from the File object, parse it directly (no fetch needed)
  if (meta?.csvText) {
    return withLazyObjects(parseCsvText(meta.csvText));
  }
  // Use sourceFile for detection if available, fallback to fileUrl
  const checkUrl = meta?.sourceFile || fileUrl;
  if (isCsvFile(checkUrl)) {
    return withLazyObjects(await fetchCsvRows(fileUrl));
  }
  // Excel fallback — use AI extraction
  const schema = {
    type: "object",
    properties: Object.fromEntries(
      Object.keys(COLUMN_MAP).filter((k) => k === k).slice(0, 10).map((k) => [k, { type: "string" }])
    ),
  };
  const res = await db.integrations.Core.ExtractDataFromUploadedFile({
    file_url: fileUrl,
    json_schema: schema,
  });
  if (res.status !== "success") throw new Error(res.details || "Extraction failed");
  const eager = (Array.isArray(res.output) ? res.output : []).map((obj) => {
    const safe = {};
    for (const [k, v] of Object.entries(obj || {})) safe[k] = v;
    return safe;
  });
  return withLazyObjects([], eager);
}

function detectReportType(fileUrl, rawRows, meta) {
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

export async function scanReport(type, fileUrl, meta = {}) {
  // Note: `source.objects` is a lazy getter — destructuring it here would defeat
  // the point, so it is read only inside the branches that need object form.
  const source = await getRowsArray(type, fileUrl, meta);
  const rawRows = source.rawRows;
  const resolvedType = !type || type === "auto" ? detectReportType(fileUrl, rawRows, meta) : type;
  const fullMeta = { ...meta, type: resolvedType };

  if (resolvedType === "hotel_statistics") {
    return scanHotelStatistics(rawRows, fileUrl, fullMeta);
  }

  if (resolvedType === "transactions") {
    return scanTransactions(rawRows, fullMeta);
  }

  const objects = source.objects;

  // Debug info for troubleshooting
  const debugInfo = {
    rawRowCount: rawRows?.length || 0,
    objectCount: objects?.length || 0,
    detectedType: resolvedType,
    sampleHeaders: rawRows?.[0] || [],
    sampleObject: objects?.[0] || null,
  };

  if (resolvedType === "generic") {
    const rows = objects.filter((r) => Object.values(r).some((v) => v !== null && v !== ""));
    return {
      type: resolvedType,
      sections: [{ name: "Data", rows: rows.length, preview: rows.slice(0, 20) }],
      totalRows: rows.length,
      rowsToImport: rows,
      meta: fullMeta,
      debug: debugInfo,
    };
  }

  if (resolvedType === "clerk") {
    return scanClerkReport(rawRows, fullMeta, objects);
  }

  if (resolvedType === "adjustments_refunds") {
    return scanAdjustmentsRefunds(rawRows, fullMeta);
  }

  if (resolvedType === "timecard") {
    return scanTimecard(rawRows, fullMeta, objects);
  }

  // Occupancy, Source, Gross, Payments — flat tables
  const coercions = [];
  const mapped = objects.map((obj) => mapRow(obj, coercions)).filter((r) => Object.keys(r).length > 0);

  // Convert dates and fix occupancy
  const processed = mapped
    .map((r) => {
      if (r.date) {
        const converted = convertDate(r.date);
        if (!converted || !isIsoDate(converted)) {
          // Track failed date conversions for debugging
          r._dateParseError = r.date;
        }
        r.date = converted;
      }
      // Occupancy arrives in two forms depending on the PMS export: a ratio (0.85)
      // or a percentage (85). Room counts, when present, are two audited integers and
      // are preferred over either printed form.
      //
      // DEFECT FIXED 2026-08-20 — DO NOT COLLAPSE THESE BRANCHES BACK. The code was:
      //
      //     if (!r.occupancy || r.occupancy > 1) { ...sold/total, else 0... }
      //     else if (r.occupancy > 1) { r.occupancy = r.occupancy / 100; }
      //
      // The `else if` is unreachable: the `if` above it already caught every value
      // > 1. So an export that prints occupancy as `85` with no room-count columns
      // fell into the first branch, found total === 0, and was assigned **0** — the
      // percentage was thrown away and the day was recorded as an empty hotel. Silent,
      // no warning, and it survives into ADR and RevPAR because those read occupancy.
      //
      // Only the `printed > 1 && total === 0` case changes behaviour here. Every other
      // input produces exactly what it produced before, which is what makes this safe
      // to apply to historical re-imports.
      //
      // BEST OUTCOME NOTE: a ratio already in (0, 1] is left EXACTLY as imported even
      // when room counts are present. Recomputing it from the counts would silently
      // overwrite what the PMS printed, and a disagreement between the printed ratio
      // and sold/total is a data-quality signal the owner should see rather than one
      // this parser should paper over.
      if (resolvedType === "occupancy") {
        const printed = Number(r.occupancy);
        if (!printed || printed > 1) {
          const sold = Number(r.rooms_sold) || 0;
          const total = Number(r.total_rooms) || 0;
          if (total > 0) {
            r.occupancy = sold / total;
          } else if (printed > 1) {
            // Percent form with nothing to derive from. Values over 100 stay over 1
            // on purpose: >100% occupancy is the signal for a duplicated import.
            r.occupancy = printed / 100;
          } else {
            r.occupancy = 0;
          }
        }
      }
      return r;
    })
    .filter((r) => {
      const valid = r.date && isIsoDate(r.date);
      if (!valid && r._dateParseError) {
        debugInfo.dateParseErrors = (debugInfo.dateParseErrors || 0) + 1;
      }
      return valid;
    });

  // Validation runs on the raw grid + mapped rows so the scan preview can show
  // what would be corrupted before anything is imported. Errors block the
  // import unless force-imported; warnings only display.
  //
  // ADDED 2026-08-20 — the occupancy default disarmed a required-column check.
  //
  // `REQUIRED_FIELDS.occupancy` in importValidation.js demands one of `occupancy` or
  // `rooms_sold`, and it decides "present" by looking for the field on a mapped row.
  // The branch above always writes `r.occupancy`, including the `= 0` fallback — so a
  // file carrying neither an occupancy column nor room counts arrived at the
  // validator with `occupancy: 0` on every row, satisfied the requirement, and
  // imported with **no findings at all**. Every day recorded as an empty hotel, and
  // the one layer built to catch exactly that had been switched off by an upstream
  // default. Found by scripts/probe-validation-gaps.mjs, which asserts the finding.
  //
  // Reported through `extraFindings` rather than by removing the `= 0` default: the
  // default is what keeps `occupancy` a number for every downstream consumer, and
  // `extraFindings` is the sanctioned channel for "a problem only the parser that
  // owns this format can see". No imported value changes.
  //
  // The all-rows-affected escalation mirrors `unparseable_dates` in the same module
  // instead of inventing a second convention: a whole file of underivable rows is a
  // wrong-file error, while a handful is a warning that must not block the rest.
  const underivable = resolvedType === "occupancy"
    ? processed.filter((r) => Number(r.occupancy) === 0 && !(Number(r.total_rooms) > 0)).length
    : 0;
  const extraFindings = [];
  if (underivable) {
    const all = underivable === processed.length;
    extraFindings.push(makeFinding(
      "structural",
      all ? SEVERITY.ERROR : SEVERITY.WARNING,
      "occupancy_underivable",
      all
        ? `No occupancy could be determined for any of the ${underivable} row(s): the file has neither a recognised occupancy column nor "Total Rooms". Every day would import as an empty hotel. This may not be an Occupancy Summary.`
        : `${underivable} row(s) have no occupancy and no "Total Rooms" to derive it from, so they imported as 0% — an empty hotel for those days.`,
      { count: underivable, rows: processed.length },
    ));
  }

  const validation = validateImport({
    rawRows,
    rows: processed,
    type: resolvedType,
    knownColumns: new Set(Object.keys(COLUMN_MAP)),
    coercions,
    dateFailures: debugInfo.dateParseErrors || 0,
    extraFindings,
  });

  return {
    type: resolvedType,
    sections: [{ name: REPORT_TYPES.find((r) => r.key === resolvedType)?.label || resolvedType, rows: processed.length, preview: processed.slice(0, 20) }],
    totalRows: processed.length,
    rowsToImport: processed,
    meta: fullMeta,
    debug: debugInfo,
    validation,
  };
}

const CLERK_SKIP_LABELS = new Set([
  "TOTAL CASH DROPS",
  "CALCULATED DEPOSIT",
  "DUE BACK",
  "CASH OVER / SHORT",
  "PAID OUT",
  "CURRENCY EXCHANGE AMOUNT",
  "GRAND TOTAL",
  "TOTAL",
]);

const DROP_LINE_RE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2} [AP]M)\s*-\s*(.+)$/i;

async function scanHotelStatistics(rawRows, fileUrl, meta) {
  // Use pre-read CSV text if available, otherwise reconstruct from rawRows
  const csvText = meta.csvText || rawRows.map(row => row.map(cell => {
    if (cell === null || cell === undefined) return '';
    const str = String(cell);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  }).join(',')).join('\n');
  
  // Parse using universal parser
  const importId = meta.importId || `imp_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
  const parseResult = await parseHotelReport(csvText, {
    propertyId: meta.propertyId || '',
    propertyName: meta.propertyName || '',
    businessDate: meta.businessDate || '',
    sourceFile: meta.sourceFile || fileUrl,
    fileModified: meta.fileModified || null,
    importId,
  });
  
  // Convert metrics to preview format
  const preview = parseResult.metrics.slice(0, 20).map(m => ({
    section: m.section,
    metric: m.metric_name,
    category: m.metric_category,
    period: m.period_label,
    value: m.value,
    unit: m.unit,
    original: m.original_value,
  }));

  // Map parsed sections into the uniform { name, rows, preview } shape the UI renders.
  const sections = parseResult.sections.map(s => {
    const metrics = parseResult.metrics.filter(m => m.section === s.name);
    return {
      name: s.name,
      rows: s.rowCount,
      metricCount: metrics.length,
      periodHeaders: s.periodHeaders || [],
      preview: metrics.slice(0, 5).map(m => ({
        metric: m.metric_name,
        category: m.metric_category,
        period: m.period_label,
        value: m.value,
        unit: m.unit,
      })),
    };
  });

  // The snapshot's own integrity signals — metric names the parser did not
  // recognise, and anything parseHotelReport itself reported — used to be
  // returned and never read. Routed through validateImport they gate the import
  // like every other type: a file that yields no metrics is not imported, and a
  // renamed metric is named on screen instead of quietly arriving as `unknown`.
  //
  // `stackedSections` because this export is a column of section titles, each
  // with its own period headers and widths: the single-header raggedness and
  // unknown-column checks would report the file's normal shape as damage.
  const unknownNames = [...new Set((parseResult.unknownMetrics || []).map((u) => u.metricName))];
  const validation = validateImport({
    rawRows,
    rows: parseResult.metrics,
    type: "hotel_statistics",
    stackedSections: true,
    extraFindings: [
      unknownNames.length
        ? makeFinding("structural", SEVERITY.WARNING, "unknown_metrics",
          `${unknownNames.length} metric name(s) were not recognised and will import as uncategorised: ${unknownNames.slice(0, 8).join(", ")}${unknownNames.length > 8 ? "…" : ""}.`,
          { count: unknownNames.length, metrics: unknownNames })
        : null,
      ...(parseResult.errors || []).map((message) =>
        makeFinding("structural", SEVERITY.ERROR, "parser_error", String(message))),
    ],
  });

  return {
    type: "hotel_statistics",
    sections,
    totalRows: parseResult.metrics.length,
    rowsToImport: parseResult.metrics,
    metrics: parseResult.metrics,
    unknownMetrics: parseResult.unknownMetrics,
    errors: parseResult.errors,
    validation,
    fileHash: parseResult.fileHash,
    businessDate: parseResult.businessDate,
    businessDateSource: parseResult.businessDateSource,
    meta,
  };
}

// ─── All Transactions ledger ───
//
// The export stacks five grids in one file, separated by blank lines:
//   1. guest transactions          19 cols
//   2. group transactions          26 cols   (empty in every file seen)
//   3. house-account transactions  26 cols   (empty)
//   4. company-code transactions   12 cols   (empty)
//   5. guest transactions again    34 cols
// Section 5 holds the SAME transactions as section 1 with 15 extra columns, so
// importing both would double every revenue figure. We take the widest section
// that carries the transaction signature, which is 5 when present and 1 when the
// export was produced without it. `detectSections` in csvParser keys off known
// clerk-report headers, so it cannot see these grids — this splits on blank rows
// directly, which is the delimiter the file actually uses.
//
// Each grid ends with a trailer row: no Date, but the section total in the Amount
// column. It is a checksum, never a transaction. We drop it and compare it to the
// parsed sum so a truncated or mis-parsed file is reported rather than imported
// silently.
function splitTransactionSections(rawRows) {
  const sections = [];
  let current = null;

  for (const row of rawRows || []) {
    const blank = !row || row.length === 0 || row.every((c) => String(c).trim() === "");
    if (blank) { current = null; continue; }

    const looksLikeHeader = TXN_SIGNATURE.every((kw) =>
      row.some((c) => String(c).trim().toLowerCase().includes(kw))
    );

    if (!current) {
      // First non-blank row after a break defines the grid. If it is not a
      // recognisable header the grid is unusable, so record it and skip its rows
      // rather than guessing at column positions.
      current = { headers: looksLikeHeader ? row.map((c) => String(c).trim()) : null, rows: [] };
      sections.push(current);
      continue;
    }
    if (current.headers) current.rows.push(row);
  }

  return sections.filter((s) => s.headers);
}

// File identity for the re-import guard. Hashes the raw text when we have it,
// otherwise the section's own rows — either way the same file yields the same
// hash and a different file does not. Falls back to "" if the crypto API is
// unavailable (non-secure context), which just disables the file-level guard;
// the row-level dedupe_key guard still applies.
async function hashTransactionFile(meta, section) {
  try {
    const text = meta.csvText || section.rows.map((r) => r.join(",")).join("\n");
    return await generateFileHash(text);
  } catch (e) {
    console.warn("[reportParsers] transaction file hash unavailable:", e.message);
    return "";
  }
}

async function scanTransactions(rawRows, meta) {
  const sections = splitTransactionSections(rawRows);

  // Widest header wins: section 5's 34 columns are a strict superset of section
  // 1's 19, so this keeps the extra fields instead of discarding them, and still
  // works on an export that only has the narrow grid.
  let best = null;
  for (const s of sections) {
    if (!s.rows.length) continue;
    if (!best || s.headers.length > best.headers.length) best = s;
  }

  const sectionSummary = sections.map((s, i) => ({
    name: `Section ${i + 1} — ${s.headers.length} columns`,
    rows: s.rows.length,
    columns: s.headers.length,
    used: s === best,
  }));

  if (!best) {
    return {
      type: "transactions",
      sections: sectionSummary,
      totalRows: 0,
      rowsToImport: [],
      errors: ["No transaction rows found. The file has headers but no data rows."],
      // Every other exit from this function carries a validation object, so the
      // caller never has to ask which shape it got. An empty ledger blocks.
      validation: validateImport({ rawRows: [], rows: [], type: "transactions" }),
      meta,
    };
  }

  const rows = [];
  const trailers = [];
  const coercions = [];
  let skipped = 0;

  for (const cells of best.rows) {
    const mapped = mapTransactionRow(best.headers, cells, coercions);
    // Trailer: total but no date. Keep it for the checksum, never as data.
    if (isTrailerRow(mapped)) { trailers.push(mapped); continue; }
    if (!mapped.date || !isIsoDate(mapped.date)) { skipped++; continue; }
    rows.push(mapped);
  }

  // Checksum against the file's own declared total.
  const parsedCents = sumCents(rows.map((r) => r.amount));
  const trailerCents = trailers.length ? toCents(trailers[trailers.length - 1].amount) : null;
  const errors = [];
  const mismatch = trailerCents !== null && trailerCents !== parsedCents;
  if (mismatch) {
    errors.push(
      `Amount total does not match the file's own total: parsed ${fromCents(parsedCents).toFixed(2)}, file says ${fromCents(trailerCents).toFixed(2)}.`
    );
  }
  if (skipped) {
    errors.push(`${skipped} row(s) skipped: no readable date.`);
  }

  // These two signals used to end here, in a `scan.errors` array nothing read.
  // Running them through validateImport gives them the same gate as every other
  // report type: a ledger that disagrees with its own total is not imported
  // unless the operator explicitly forces it.
  //
  // The grid handed to the validator is the section actually being imported, not
  // the whole file — the other four sections have different widths and are
  // discarded, so validating against them would report raggedness that has no
  // bearing on what gets written.
  const validation = validateImport({
    rawRows: [best.headers, ...best.rows],
    rows,
    type: "transactions",
    knownColumns: new Set(Object.keys(TXN_COLUMN_MAP)),
    coercions,
    dateFailures: skipped,
    extraFindings: [
      mismatch
        ? makeFinding("semantic", SEVERITY.ERROR, "checksum_mismatch",
          `The amounts in this file do not add up to the total the file itself declares: parsed ${fromCents(parsedCents).toFixed(2)}, file says ${fromCents(trailerCents).toFixed(2)} (difference ${fromCents(parsedCents - trailerCents).toFixed(2)}). The download is incomplete or a column was misread.`,
          { parsed: fromCents(parsedCents), declared: fromCents(trailerCents) })
        : null,
      trailerCents === null
        ? makeFinding("structural", SEVERITY.WARNING, "no_checksum_row",
          "This file has no total row, so the parsed amounts could not be checked against the file's own total.")
        : null,
    ],
  });

  return {
    type: "transactions",
    sections: sectionSummary,
    totalRows: rows.length,
    rowsToImport: rows,
    fileHash: await hashTransactionFile(meta, best),
    checksum: {
      parsed: fromCents(parsedCents),
      declared: trailerCents === null ? null : fromCents(trailerCents),
      matches: trailerCents === null ? null : trailerCents === parsedCents,
    },
    errors,
    validation,
    meta,
    debug: {
      rawRowCount: rawRows?.length || 0,
      detectedType: "transactions",
      sectionsFound: sections.length,
      usedColumns: best.headers.length,
      sampleHeaders: best.headers,
      sampleObject: rows[0] || null,
    },
  };
}

function scanClerkReport(rawRows, meta, objects = []) {
  const payments = [];
  const drops = [];
  const clerkPayments = [];

  const sections = detectSections(rawRows || []);

  for (let sectionIdx = 0; sectionIdx < sections.length; sectionIdx++) {
    const section = sections[sectionIdx];
    // Create a section identifier from the header row for deduplication
    // This preserves data from each stacked period (month) separately
    const sectionKey = section.headerRow ? section.headerRow.join('|').slice(0, 100) : `section_${sectionIdx}`;

    if (section.type === "payment_summary") {
      for (const row of section.rows) {
        const label = String(row[0] || "").trim();
        if (!label) continue;
        const upper = label.toUpperCase();

        // Drop/shift line: "2026-03-07 03:21 PM - Sunny Shoaib,$481.00,..."
        const m = label.match(DROP_LINE_RE);
        if (m) {
          drops.push({
            record_type: "drop",
            shift_date: m[1],
            clerk_name: m[2],
            amount: parseAmount(row[3]) ?? parseAmount(row[1]) ?? 0,
          });
          continue;
        }

        // Skip audit summary labels (TOTAL CASH DROPS, CURRENCY EXCHANGE AMOUNT, ...)
        if (CLERK_SKIP_LABELS.has(upper)) continue;

        payments.push({
          record_type: "payment",
          payment_type: upper,
          actual: parseAmount(row[1]) ?? 0,
          adjusted: parseAmount(row[2]) ?? 0,
          net_today: parseAmount(row[3]) ?? 0,
          _sectionKey: sectionKey, // Preserve section context for deduplication
        });
      }
    }

    if (section.type === "employee_payments") {
      for (const row of section.rows) {
        const clerkName = String(row[0] || "").trim();
        const payType = String(row[1] || "").trim().toUpperCase();
        const amount = parseAmount(row[2]);
        if (!clerkName || !payType || amount === null) continue;
        clerkPayments.push({
          record_type: "clerk_payment",
          clerk_name: clerkName,
          payment_type: payType,
          amount,
          transaction_count: 1,
          _sectionKey: sectionKey,
        });
      }
    }
  }

  // Fallback for files without detectable stacked headers (e.g. Excel AI extraction)
  if (!sections.length && objects.length) {
    for (const obj of objects) {
      const clerkName = String(obj.clerk_name || obj.username || "").trim();
      const payType = String(obj.payment_type || "").trim().toUpperCase();
      const amount = parseAmount(obj.amount);
      if (clerkName && payType && amount !== null) {
        clerkPayments.push({
          record_type: "clerk_payment",
          clerk_name: clerkName,
          payment_type: payType,
          amount,
          transaction_count: Number(obj.transaction_count) || 1,
        });
        continue;
      }
      const label = String(obj["Payment Type"] || obj.payment_type || obj["Payment Type,Actual,Adjusted,Net Today"] || "").trim();
      const upper = label.toUpperCase();
      const m = label.match(DROP_LINE_RE);
      if (m) {
        drops.push({
          record_type: "drop",
          shift_date: m[1],
          clerk_name: m[2],
          amount: parseAmount(obj.net_today) ?? parseAmount(obj.amount) ?? 0,
        });
      } else if (label && !CLERK_SKIP_LABELS.has(upper)) {
        payments.push({
          record_type: "payment",
          payment_type: upper,
          actual: parseAmount(obj.actual) ?? 0,
          adjusted: parseAmount(obj.adjusted) ?? 0,
          net_today: parseAmount(obj.net_today) ?? 0,
        });
      }
    }
  }

  // Payments repeat per stacked period — preserve each period's data by including
  // the section key in the deduplication key. This prevents earlier months from
  // being silently overwritten by later ones (the "last block wins" bug).
  const seenPayments = new Map();
  for (const p of payments) {
    const key = `${p.payment_type}|${p._sectionKey || 'unknown'}`;
    seenPayments.set(key, p);
  }
  const uniquePayments = [...seenPayments.values()];

  return {
    type: "clerk",
    sections: [
      { name: "Payment Summary", rows: uniquePayments.length, preview: uniquePayments.slice(0, 20) },
      { name: "Deposit Drops", rows: drops.length, preview: drops.slice(0, 20) },
      { name: "Clerk Payments", rows: clerkPayments.length, preview: clerkPayments.slice(0, 20) },
    ],
    totalRows: uniquePayments.length + drops.length + clerkPayments.length,
    payments: uniquePayments,
    drops,
    clerkPayments,
    meta,
  };
}

// ─── Adjustments & Refunds Activity ────────────────────────────────────
//
// HotelKey "Adjustments and Refunds Activity" CSV exports contain TWO stacked
// tables separated by blank lines:
//   1. Adjustments table — header contains "Adjustment Reason Code"
//   2. Refunds table     — header contains "Payment Type Refunded"
// After those, a totals/summary section may follow.
//
// The parser uses a state machine over rawRows (already tokenized by parseCsvText)
// to detect section boundaries and extract every cell without loss.

// Exported so scripts/probe-adjustments.mjs can drive it directly against a real
// CSV fixture. It was module-private, so that probe died at import with
// "does not provide an export named 'scanAdjustmentsRefunds'" and had never run.
// Exporting is the honest fix: the alternative — copying the parser into the probe
// — is what scripts/test-parser.mjs already did, and that copy has since drifted
// from this one, so it proves nothing about shipped behaviour.
export function scanAdjustmentsRefunds(rawRows, meta) {
  const adjustments = [];
  const refunds = [];
  const summary = {};

  // State: IDLE → scanning for section headers
  //        ADJUSTMENTS → inside adjustments table
  //        REFUNDS → inside refunds table
  //        SUMMARY → inside summary/totals section
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

  // Is this row a totals/subtotal line rather than a record?
  //
  // THIS USED TO BE A SUBSTRING TEST AND IT LOST MONEY. The old code asked
  // `has("total")`, which is true when ANY cell of the row contains the substring
  // anywhere, and it asked before the data-row branches ran. Measured 2026-08-20
  // with scripts/probe-adjustments.mjs §3, against this function:
  //
  //   Date,...,Guest Name,...,Adjusted Amount,...,Remarks
  //   01-Feb-26,...,"Smith, John",...,-25.00,...,total comp approved
  //     -> adjustments: []                              (the row is GONE)
  //     -> summary: { "adj_01-Feb-26": 0 }              (filed as a subtotal of 0)
  //
  // A guest surname, a remark, a charge type — any cell mentioning a total erased
  // that row from the import. Worse on a table narrow enough to reach the old
  // `row.length <= 5` arm: the same match set state = "SUMMARY", so every REMAINING
  // row of the table was swallowed too. Silent row loss on a financial import is
  // exactly what this project forbids; nothing surfaced, no count, no warning.
  //
  // A totals line is now identified by three structural properties, all required:
  //   1. its first populated cell READS as a total label ("Total", "Sub-Total",
  //      "Grand Total", "Total Adjustments", "Room Total"),
  //   2. that cell sits at the left edge — in or before the date column, where
  //      labels live; a record's first populated cell is its date, so a guest
  //      literally named "Total Wine & More" can never qualify, and
  //   3. the row carries no usable transaction date.
  // Text in a remark is now just text, while a real "Sub-Total" line is still
  // recognised and still kept out of the record arrays.
  const TOTAL_LABEL = /^(?:grand\s+|sub[-\s]?)?totals?\b|\btotals?\s*:?\s*$/;
  const isTotalsLine = (cells, headers) => {
    const firstIdx = cells.findIndex((c) => String(c).trim() !== "");
    if (firstIdx < 0) return false;
    if (!TOTAL_LABEL.test(String(cells[firstIdx]).toLowerCase().trim())) return false;
    const dIdx = headerIndex(headers, "date");
    if (dIdx >= 0 && firstIdx > dIdx) return false;
    const dateCell = dIdx >= 0 && dIdx < cells.length ? String(cells[dIdx]).trim() : "";
    return !isIsoDate(convertDate(dateCell));
  };

  // What number does a totals line carry?
  //
  // This used to be `parseAmount(row[row.length - 1])`, which assumes the amount is
  // the final cell. It frequently is not: "Total,,,-48.00," — a totals line on a
  // table whose last column is Username — recorded 0, so the summary silently
  // disagreed with the rows it was meant to be summarising. Prefer the table's own
  // amount column, and fall back to the last cell that actually parses as money.
  // The label cell never parses as money, so the fallback cannot mistake it for a
  // value.
  const totalsValue = (cells, headers) => {
    const amtIdx = headerIndex(headers, "adjusted amount", "amount");
    if (amtIdx >= 0 && amtIdx < cells.length) {
      const v = parseAmount(cells[amtIdx]);
      if (v != null) return v;
    }
    for (let c = cells.length - 1; c >= 0; c--) {
      const v = parseAmount(cells[c]);
      if (v != null) return v;
    }
    return 0;
  };

  for (let i = 0; i < rawRows.length; i++) {
    const row = rawRows[i];

    // Blank row → reset state
    if (!row || row.length === 0 || row.every((c) => c.trim() === "")) {
      // If we were in a table, the blank line ends it. Next header will re-enter.
      if (state !== "IDLE") state = "IDLE";
      continue;
    }

    const lower = row.map((c) => String(c).toLowerCase().trim());
    const has = (kw) => lower.some((h) => h.includes(kw));

    // Detect Adjustments header (some tables have "adjustment reason code", others omit it, but both have "adjusted amount" and "room number")
    if (has("adjusted amount") && has("room number")) {
      state = "ADJUSTMENTS";
      adjHeaders = row.map((c) => String(c).trim());
      continue;
    }

    // Detect Refunds header
    if (has("payment type refunded")) {
      state = "REFUNDS";
      refHeaders = row.map((c) => String(c).trim());
      continue;
    }

    // Totals / subtotal line. One branch handles all three positions (top level,
    // inside the adjustments table, inside the refunds table) so the "is this a
    // total?" question is answered in exactly one place — isTotalsLine above.
    //
    // Only a TOP-LEVEL totals line opens the SUMMARY section. A subtotal printed
    // inside a table must not put the scanner into a state that then eats the rest
    // of that table, which is how the old `row.length <= 5` arm behaved.
    const activeHeaders = state === "ADJUSTMENTS" ? adjHeaders : state === "REFUNDS" ? refHeaders : null;
    if (isTotalsLine(row, activeHeaders)) {
      // Label the value by where it was found, preserving the existing key scheme
      // (`adj_`/`ref_` inside a table, bare label at top level) that the preview
      // in the import UI reads.
      const label = String(row[0] || "").trim() || "Total";
      const value = totalsValue(row, activeHeaders);
      if (state === "ADJUSTMENTS") summary[`adj_${label}`] = value;
      else if (state === "REFUNDS") summary[`ref_${label}`] = value;
      else {
        state = "SUMMARY";
        summary[label] = value;
      }
      continue;
    }

    // Parse adjustment row
    if (state === "ADJUSTMENTS" && adjHeaders) {
      // No subtotal test here any more — isTotalsLine already ran above for this
      // state and consumed the row if it was one. The old test at this point was a
      // second `has("total")` substring scan, so it dropped the same data rows.
      const dateIdx      = headerIndex(adjHeaders, "date");
      const timeIdx      = headerIndex(adjHeaders, "time");
      const txnTypeIdx   = headerIndex(adjHeaders, "transaction type");
      const chargeIdx    = headerIndex(adjHeaders, "charge type");
      const guestIdx     = headerIndex(adjHeaders, "guest name", "name");
      const txnNumIdx    = headerIndex(adjHeaders, "transaction number", "trans #", "trans no");
      const roomIdx      = headerIndex(adjHeaders, "room number", "room #", "room");
      const reasonIdx    = headerIndex(adjHeaders, "adjustment reason code", "reason code");
      const adjAmtIdx    = headerIndex(adjHeaders, "adjusted amount");
      const adjTaxIdx    = headerIndex(adjHeaders, "adjusted tax");
      const userIdx      = headerIndex(adjHeaders, "username", "user name", "user");
      const remarksIdx   = headerIndex(adjHeaders, "remarks", "remark", "notes", "comment");

      const cell = (idx) => (idx >= 0 && idx < row.length) ? String(row[idx]).trim() : "";

      adjustments.push({
        record_type: "adjustment",
        date: convertDate(cell(dateIdx)),
        time: cell(timeIdx),
        transactionType: cell(txnTypeIdx),
        chargeType: cell(chargeIdx),
        guestName: cell(guestIdx),
        transactionNumber: cell(txnNumIdx),
        roomNumber: cell(roomIdx),
        reasonCode: cell(reasonIdx),
        adjustedAmount: parseAmount(cell(adjAmtIdx)) ?? 0,
        adjustedTax: parseAmount(cell(adjTaxIdx)) ?? 0,
        username: cell(userIdx),
        remarks: cell(remarksIdx),
      });
      continue;
    }

    // Parse refund row
    if (state === "REFUNDS" && refHeaders) {
      // Same as the adjustments branch: isTotalsLine above already consumed a real
      // subtotal line, and the substring test that used to sit here dropped refunds
      // whose remarks mentioned a total.
      const dateIdx      = headerIndex(refHeaders, "date");
      const timeIdx      = headerIndex(refHeaders, "time");
      const guestIdx     = headerIndex(refHeaders, "guest name", "name");
      const txnNumIdx    = headerIndex(refHeaders, "transaction number", "trans #", "trans no");
      const roomIdx      = headerIndex(refHeaders, "room number", "room #", "room");
      const payDetailIdx = headerIndex(refHeaders, "payment detail");
      const refCodeIdx   = headerIndex(refHeaders, "refund code");
      const payTypeIdx   = headerIndex(refHeaders, "payment type refunded");
      const amtIdx       = headerIndex(refHeaders, "amount");
      const userIdx      = headerIndex(refHeaders, "username", "user name", "user");
      const remarksIdx   = headerIndex(refHeaders, "remarks", "remark", "notes", "comment");

      const cell = (idx) => (idx >= 0 && idx < row.length) ? String(row[idx]).trim() : "";

      refunds.push({
        record_type: "refund",
        date: convertDate(cell(dateIdx)),
        time: cell(timeIdx),
        guestName: cell(guestIdx),
        transactionNumber: cell(txnNumIdx),
        roomNumber: cell(roomIdx),
        paymentDetail: cell(payDetailIdx),
        refundCode: cell(refCodeIdx),
        paymentTypeRefunded: cell(payTypeIdx),
        amount: parseAmount(cell(amtIdx)) ?? 0,
        username: cell(userIdx),
        remarks: cell(remarksIdx),
      });
      continue;
    }

    // Summary state — capture any remaining totals rows
    if (state === "SUMMARY") {
      const label = String(row[0] || "").trim();
      if (label) {
        summary[label] = parseAmount(row[row.length - 1]) ?? 0;
      }
    }
  }

  const totalRows = adjustments.length + refunds.length;

  return {
    type: "adjustments_refunds",
    sections: [
      { name: "Adjustments", rows: adjustments.length, preview: adjustments.slice(0, 20) },
      { name: "Refunds", rows: refunds.length, preview: refunds.slice(0, 20) },
    ],
    totalRows,
    rowsToImport: [...adjustments, ...refunds],
    adjustments,
    refunds,
    summary,
    meta,
  };
}

// ─── Timecard (Clock In/Out) ───────────────────────────────────────────
//
// HotelKey / payroll timecard exports, regardless of the exporter, carry one
// row per shift: an employee, a date, and a clock-in/clock-out pair. Column
// names vary wildly ("Clock In", "Time In", "clock_in", "Start Time"), but the
// values are always readable time-of-day strings. The parser keeps the times
// verbatim so the reconciler (src/lib/timecardCalc.js) can normalise them and
// compute hours/OT; only the date is normalised to ISO at scan time.

function scanTimecard(rawRows, meta, objects) {
  const punches = [];
  const rejected = [];

  // Column-name normalisation mirrors COLUMN_MAP: map synonyms to canonical keys.
  const TIME_CANON = {
    "employee name": "employee_name", "employee": "employee_name", "name": "employee_name",
    "employee id": "employee_id", "emp id": "employee_id", "id": "employee_id", "employee number": "employee_id",
    "department": "department", "dept": "department",
    "date": "shift_date", "shift date": "shift_date", "day": "shift_date", "work date": "shift_date",
    "clock in": "clock_in", "clock_in": "clock_in", "time in": "clock_in", "time_in": "clock_in",
    "start time": "clock_in", "start": "clock_in", "in": "clock_in",
    "clock out": "clock_out", "clock_out": "clock_out", "time out": "clock_out", "time_out": "clock_out",
    "end time": "clock_out", "end": "clock_out", "out": "clock_out",
    "break": "break_minutes", "break minutes": "break_minutes", "break time": "break_minutes",
    "overtime": "overtime_hours", "ot": "overtime_hours", "overtime hours": "overtime_hours",
  };

  const canonical = (h) => TIME_CANON[String(h || "").trim().toLowerCase()];

  // Prefer AI-extracted objects (Excel path); fall back to header+rows mapping.
  const rows = Array.isArray(objects) && objects.length
    ? objects
    : rowsToObjects(rawRows);

  for (const obj of rows) {
    const out = {};
    for (const [srcKey, value] of Object.entries(obj)) {
      const key = canonical(srcKey);
      if (key) out[key] = value;
    }
    if (!out.employee_name && !out.shift_date) {
      // Not a punch row (section label, totals line, empty row).
      if (Object.values(out).some((v) => v !== undefined && v !== null && String(v).trim() !== "")) rejected.push(out);
      continue;
    }

    const employee = String(out.employee_name || "").trim();
    const date = convertDate(out.shift_date);
    const inTime = String(out.clock_in || "").trim();
    const outTime = String(out.clock_out || "").trim();

    if (!employee || !date || !inTime || !outTime) {
      rejected.push({ ...out, _reason: "missing employee, date, or in/out time" });
      continue;
    }

    punches.push({
      employee_name: employee,
      employee_id: String(out.employee_id || "").trim(),
      department: String(out.department || "").trim(),
      shift_date: date,
      clock_in: inTime,
      clock_out: outTime,
      break_minutes: Number(out.break_minutes) > 0 ? Number(out.break_minutes) : undefined,
      overtime_hours: Number(out.overtime_hours) > 0 ? Number(out.overtime_hours) : undefined,
    });
  }

  return {
    type: "timecard",
    sections: [
      { name: "Clock In/Out Shifts", rows: punches.length, preview: punches.slice(0, 20) },
      { name: "Skipped", rows: rejected.length, preview: rejected.slice(0, 20) },
    ],
    totalRows: punches.length + rejected.length,
    rowsToImport: punches,
    skipped: rejected,
    meta,
  };
}

// ─── CSV report importer ────────────────────────────────────────────────
export async function importReport(scanResult, meta = {}) {
  const { forceImport = false, sourceFile = "", propertyId = "", propertyName = "", ...restMeta } = meta;

  // Block corrupting imports unless the user explicitly forces them. The scan
  // already showed these errors in the preview; without force, a file that
  // fails validation is rejected before any session or row is created, so no
  // `in_progress` session is left behind for an import that never happened.
  const validation = scanResult?.validation;
  if (validation && !validation.ok && !forceImport) {
    const layer = validation.firstFailingLayer || "validation";
    const detail = validation.errors.map((f) => `${f.code}: ${f.message}`).join(" | ");
    const err = /** @type {Error & { code: string, validation: typeof validation }} */ (new Error(`Import blocked by ${layer} validation (${validation.errors.length} error(s)): ${detail}`));
    err.code = "IMPORT_VALIDATION_BLOCKED";
    err.validation = validation;
    throw err;
  }
  
  // Create import session for tracking and rollback capability
  const importSession = await createImportSession({
    sourceFile,
    propertyId,
    propertyName,
    reportType: scanResult.type,
  });
  
  try {
    const [result] = await runInTransaction([async () => {
      return await doImport(scanResult, { ...restMeta, forceImport, sourceFile, propertyId, propertyName }, importSession.importId);
    }]);
    
    // Track row counts per table for potential rollback
    const rowCounts = {};
    if (scanResult.type === "clerk") {
      rowCounts["ClerkShiftRecord"] = result.count;
    } else if (scanResult.type === "adjustments_refunds") {
      rowCounts["AdjustmentRefund"] = result.count;
    } else if (scanResult.type === "timecard") {
      rowCounts["TimecardPunch"] = result.count;
    } else if (ENTITY[scanResult.type]) {
      rowCounts[ENTITY[scanResult.type]] = result.count;
    }
    
    await completeImportSession(importSession.importId, rowCounts);
    // The anomaly alerts were persisted inside the import transaction; their
    // HMAC audit-log entry is written here, after commit, so the log only ever
    // records detections that actually stuck. audit.log swallows its own errors,
    // so a failed log write cannot turn a successful import into a failure.
    if (result.anomalyAudit) {
      await db.audit.log({
        action: "Anomaly Detection",
        username: "system",
        performed_by: "system",
        property_id: result.anomalyAudit.propertyId,
        property_name: result.anomalyAudit.propertyName || "",
        result: "success",
        detail: `Flagged ${result.anomalyAudit.count} financial anomaly alert(s) during import ${importSession.importId} (${result.anomalyAudit.types.join(", ")})`,
      });
      if (db.integrations && db.integrations.Email) {
        await db.integrations.Email.SendEmail({
          to: "alerts@hotel-operator.com",
          subject: `[ALERT] ${result.anomalyAudit.count} Financial Anomalies Detected`,
          body: `During the import of file ${importSession.importId}, ${result.anomalyAudit.count} anomalies were detected.\nTypes: ${result.anomalyAudit.types.join(", ")}\nProperty ID: ${result.anomalyAudit.propertyId}\nProperty Name: ${result.anomalyAudit.propertyName || "Unknown"}\n\nPlease review the Anomaly report in your dashboard immediately.`,
        }).catch(e => console.error('Failed to send anomaly email', e));
      }
    }
    // Return the session's importId, not the caller's. Callers pass their own
    // meta.importId for row tagging, but the rollback ledger is keyed by the
    // session id — a caller that recorded its own would look up an import that
    // has no ledger and be told it cannot be undone.
    return { ...result, importId: importSession.importId };
  } catch (e) {
    // Attach the SESSION id to the error. Callers mint their own `meta.importId`
    // for their queue bookkeeping, but the rollback ledger is keyed by the id
    // that createImportSession minted here — a caller rolling back with its own
    // id looks up an import that has no ledger and is told, wrongly, that the
    // undo is impossible. Surfacing the real id is the only way the caller can
    // clean up. Non-enumerable so the id never leaks into a serialised error.
    if (importSession?.importId) {
      Object.defineProperty(e, 'importId', {
        value: importSession.importId,
        enumerable: false,
        configurable: true,
        writable: true,
      });
      // Mark the session failed so it is not left indistinguishable from an
      // import that is still running, and so rollback can tell an atomic
      // no-rows-committed failure from rows it can no longer identify.
      await failImportSession(importSession.importId, e?.message).catch(() => {});
    }
    throw e;
  }
}

async function doImport(scanResult, meta, importId) {
  const { type } = scanResult;
  const { forceImport = false, ...restMeta } = meta;
  const addMetaFn = (obj) => addMeta(obj, { ...restMeta, type, importId });

  if (type === "clerk") {
    const all = [];
    for (const p of (scanResult.payments || [])) all.push(addMetaFn(p));
    for (const d of (scanResult.drops || [])) all.push(addMetaFn(d));
    for (const c of (scanResult.clerkPayments || [])) all.push(addMetaFn(c));

    const keyFn = (r) => {
      if (r.record_type === "payment") return `payment|${r.payment_type}|${r._sectionKey || 'unknown'}`;
      if (r.record_type === "drop") return `drop|${r.shift_date}|${r.clerk_name}|${r.amount}`;
      return `clerk_payment|${r.clerk_name}|${r.payment_type}|${r.amount}|${r._sectionKey || 'unknown'}`;
    };

    const deduped = dedupByKey(all, keyFn);
    const existing = restMeta.propertyId
      ? await db.entities.ClerkShiftRecord.filter({ property_id: restMeta.propertyId })
      : [];
    const seen = new Set(existing.map(keyFn));
    const newRows = forceImport ? deduped : deduped.filter((r) => !seen.has(keyFn(r)));

    let createdIds = [];
    if (newRows.length) {
      for (let i = 0; i < newRows.length; i += 400) {
        const batch = newRows.slice(i, i + 400);
        const created = await db.entities.ClerkShiftRecord.bulkCreate(batch);
        createdIds.push(...created.map((r) => r.id));
      }
    }
    if (createdIds.length) {
      await recordCreatedIds("ClerkShiftRecord", restMeta.propertyId, importId, createdIds);
    }
    const cleaned = await dedupePropertyRows("ClerkShiftRecord", restMeta.propertyId, keyFn);
    return { count: newRows.length, excluded: deduped.length - newRows.length, cleaned };
  }

  // ─── Adjustments & Refunds Activity ───
  if (type === "adjustments_refunds") {
    const adjustments = (scanResult.adjustments || []).map(addMetaFn);
    const refunds = (scanResult.refunds || []).map(addMetaFn);
    const all = [...adjustments, ...refunds];

    const keyFn = (r) => [
      r.record_type || "adj",
      r.date || "",
      r.time || "",
      r.username || "",
      r.roomNumber || "",
      r.transactionNumber || "",
      r.adjustedAmount ?? r.amount ?? 0,
    ].join("|");

    const deduped = dedupByKey(all, keyFn);
    const existing = restMeta.propertyId
      ? await db.entities.AdjustmentRefund.filter({ property_id: restMeta.propertyId })
      : [];
    const seen = new Set(existing.map(keyFn));
    const newRows = forceImport ? deduped : deduped.filter((r) => !seen.has(keyFn(r)));

    let createdIds = [];
    if (newRows.length) {
      for (let i = 0; i < newRows.length; i += 400) {
        const batch = newRows.slice(i, i + 400);
        const created = await db.entities.AdjustmentRefund.bulkCreate(batch);
        createdIds.push(...created.map((r) => r.id));
      }
    }
    if (createdIds.length) {
      await recordCreatedIds("AdjustmentRefund", restMeta.propertyId, importId, createdIds);
    }

    // Run clerk-specific anomaly detection on imported adjustments/refunds
    const anomalyInput = { adjustments, refunds };
    const { flaggedAnomalies } = detectClerkAnomalies(anomalyInput);
    let anomalyAudit = null;
    if (flaggedAnomalies.length) {
      const alertRows = flaggedAnomalies.map((a) => ({
        ...a,
        alert_type: a.ruleId,
        severity: a.severity.toLowerCase(),
        property_id: restMeta.propertyId || "",
        property_name: restMeta.propertyName || "",
        import_id: importId,
        source_file: restMeta.sourceFile || "",
        status: "open",
        dedupe_key: a.id,
      }));
      const existingAlerts = restMeta.propertyId
        ? await db.entities.AnomalyAlert.filter({ property_id: restMeta.propertyId })
        : [];
      const seenAlerts = new Set(existingAlerts.map((a) => a.dedupe_key));
      const freshAlerts = alertRows.filter((a) => !seenAlerts.has(a.dedupe_key));
      let alertIds = [];
      if (freshAlerts.length) {
        for (let i = 0; i < freshAlerts.length; i += 400) {
          const batch = freshAlerts.slice(i, i + 400);
          const created = await db.entities.AnomalyAlert.bulkCreate(batch);
          alertIds.push(...created.map((r) => r.id));
        }
      }
      if (alertIds.length) {
        await recordCreatedIds("AnomalyAlert", restMeta.propertyId, importId, alertIds);
      }
      const types = [...new Set(freshAlerts.map((a) => a.alert_type))].sort();
      anomalyAudit = alertIds.length
        ? { propertyId: restMeta.propertyId, propertyName: restMeta.propertyName || "", importId, count: alertIds.length, types }
        : null;
    }

    const cleaned = await dedupePropertyRows("AdjustmentRefund", restMeta.propertyId, keyFn);
    return {
      count: newRows.length,
      excluded: deduped.length - newRows.length,
      cleaned,
      anomalies: flaggedAnomalies.length,
      anomalyAudit,
    };
  }

  // ─── Timecard (Clock In/Out) ───
  if (type === "timecard") {
    const punches = (scanResult.rowsToImport || []).map(addMetaFn);

    const keyFn = (r) => [
      r.employee_name || "",
      r.shift_date || "",
      r.clock_in || "",
      r.clock_out || "",
    ].join("|");

    const deduped = dedupByKey(punches, keyFn);
    const existing = restMeta.propertyId
      ? await db.entities.TimecardPunch.filter({ property_id: restMeta.propertyId })
      : [];
    const seen = new Set(existing.map(keyFn));
    const newRows = forceImport ? deduped : deduped.filter((r) => !seen.has(keyFn(r)));

    let createdIds = [];
    if (newRows.length) {
      for (let i = 0; i < newRows.length; i += 400) {
        const batch = newRows.slice(i, i + 400);
        const created = await db.entities.TimecardPunch.bulkCreate(batch);
        createdIds.push(...created.map((r) => r.id));
      }
    }
    if (createdIds.length) {
      await recordCreatedIds("TimecardPunch", restMeta.propertyId, importId, createdIds);
    }

    // Flag impossible/likely-error shifts so payroll review sees them immediately.
    const flagged = [];
    for (const p of newRows) {
      const n = normalisePunch(p);
      if (!n || !n.flags?.length) continue;
      for (const flag of n.flags) {
        flagged.push({
          id: `timecard_${flag}`,
          severity: "high",
          title: `Timecard flag: ${flag.replace(/_/g, " ")}`,
          message: `${n.employeeName || "Unknown employee"} shift on ${n.date || p.shift_date || ""} (${p.clock_in || ""} - ${p.clock_out || ""})`,
          dedupe_key: `timecard_${flag}|${n.employeeName || ""}|${n.date || ""}`,
          property_id: restMeta.propertyId || "",
          property_name: restMeta.propertyName || "",
        });
      }
    }
    let anomalyAudit = null;
    if (flagged.length) {
      const alertRows = flagged.map((a) => ({
        ...a,
        alert_type: a.id,
        import_id: importId,
        source_file: restMeta.sourceFile || "",
        status: "open",
      }));
      const existingAlerts = restMeta.propertyId
        ? await db.entities.AnomalyAlert.filter({ property_id: restMeta.propertyId })
        : [];
      const seenAlerts = new Set(existingAlerts.map((a) => a.dedupe_key));
      const freshAlerts = alertRows.filter((a) => !seenAlerts.has(a.dedupe_key));
      let alertIds = [];
      if (freshAlerts.length) {
        for (let i = 0; i < freshAlerts.length; i += 400) {
          const batch = freshAlerts.slice(i, i + 400);
          const created = await db.entities.AnomalyAlert.bulkCreate(batch);
          alertIds.push(...created.map((r) => r.id));
        }
      }
      if (alertIds.length) {
        await recordCreatedIds("AnomalyAlert", restMeta.propertyId, importId, alertIds);
      }
      const types = [...new Set(freshAlerts.map((a) => a.alert_type))].sort();
      anomalyAudit = alertIds.length
        ? { propertyId: restMeta.propertyId, propertyName: restMeta.propertyName || "", importId, count: alertIds.length, types }
        : null;
    }

    const cleaned = await dedupePropertyRows("TimecardPunch", restMeta.propertyId, keyFn);
    return {
      count: newRows.length,
      excluded: deduped.length - newRows.length,
      cleaned,
      anomalies: flagged.length,
      anomalyAudit,
    };
  }

  if (type === "hotel_statistics") {
    const metrics = scanResult.metrics || scanResult.rowsToImport || [];

    const keyFn = (r) => `${r.property_id}|${r.business_date}|${r.section}|${r.metric_name}|${r.period}|${r.import_id}`;

    const deduped = dedupByKey(metrics, keyFn);

    // File-level guard: same bytes, same property = already imported.
    //
    // This used to also match on business_date, which worked only because the
    // date was permanently "" — every statistics file agreed with every other.
    // Now that a real date is derived per import, keeping it in the key would
    // mean re-importing the same file tomorrow derives a different date, misses
    // the guard, and duplicates all 510 metrics. The file hash already identifies
    // the snapshot uniquely (a statistics export whose every figure across five
    // periods is byte-identical to another day's is not a thing), so hash plus
    // property is both narrower and safer. Same shape the transactions branch uses.
    const fileHash = scanResult.fileHash;
    let newRows = deduped;
    if (fileHash && !forceImport) {
      const existingImports = await db.entities.HotelMetric
        .filter({ file_hash: fileHash, property_id: restMeta.propertyId });
      if (existingImports.length > 0) {
        newRows = [];
      }
    }
    
    let createdIds = [];
    if (newRows.length) {
      for (let i = 0; i < newRows.length; i += 400) {
        const batch = newRows.slice(i, i + 400);
        const created = await db.entities.HotelMetric.bulkCreate(batch);
        createdIds.push(...created.map((r) => r.id));
      }
    }
    if (createdIds.length) {
      await recordCreatedIds("HotelMetric", restMeta.propertyId, importId, createdIds);
    }
    return { count: newRows.length, excluded: deduped.length - newRows.length, cleaned: 0 };
  }

  if (type === "transactions") {
    // Stamp property/import metadata first, then assign dedupe keys — the key
    // includes property_id, so the order matters.
    const rows = assignDedupeKeys((scanResult.rowsToImport || []).map((r) => addMetaFn(r)));

    // Two guards, cheapest first.
    //
    // 1. File-level: the same file re-imported for the same property is a no-op.
    //    This is the common case (a user clicking Import twice) and costs one
    //    indexed lookup instead of reading 17k rows.
    // 2. Row-level: a partial overlap — e.g. a re-export covering an extra week —
    //    is filtered by dedupe_key so the new days import and the old ones do not
    //    duplicate.
    //
    // Neither guard ever deletes: an existing row always wins over an incoming
    // copy of itself.
    const fileHash = scanResult.fileHash || meta.fileHash || "";
    if (fileHash && !forceImport) {
      const priorFile = await db.entities.TransactionLine.filter({
        file_hash: fileHash,
        property_id: restMeta.propertyId || "",
      });
      if (priorFile.length) {
        return { count: 0, excluded: rows.length, cleaned: 0, reason: "already-imported" };
      }
    }
    if (fileHash) for (const r of rows) r.file_hash = fileHash;

    let newRows = rows;
    if (!forceImport) {
      // No row cap. `seen` below is what decides whether an incoming row is a
      // duplicate, so truncating this read does not make the import faster — it
      // makes rows that ARE already stored look new and imports them a second
      // time, on the ledger whose totals have to reconcile to the cent. The old
      // 1000000 cap sorted by "date" ASCENDING and then sliced, so the rows it
      // dropped were the most recent ones: exactly where a re-export overlaps.
      // It never bounded memory either — the proxy materializes the whole table
      // before slicing it.
      const existing = await db.entities.TransactionLine.filter(
        restMeta.propertyId ? { property_id: restMeta.propertyId } : {},
        "date"
      );
      const seen = new Set(existing.map((r) => r.dedupe_key));
      newRows = rows.filter((r) => !seen.has(r.dedupe_key));
    }

    const createdIds = [];
    for (let i = 0; i < newRows.length; i += 400) {
      const batch = newRows.slice(i, i + 400);
      const created = await db.entities.TransactionLine.bulkCreate(batch);
      createdIds.push(...created.map((r) => r.id));
    }
    if (createdIds.length) {
      await recordCreatedIds("TransactionLine", restMeta.propertyId, importId, createdIds);
    }
    // Automated anomaly & fraud detection: scan the newly imported ledger rows
    // and persist flagged alerts for owner review. Runs after the rows are
    // committed so the import transaction owns both sides consistently.
    const anomalyResult = await persistAnomalyAlerts(newRows, {
      ...restMeta,
      importId,
      propertyId: restMeta.propertyId,
      propertyName: restMeta.propertyName,
      sourceFile: restMeta.sourceFile,
    });
    // No dedupePropertyRows pass here: dedupe_key is exact and already applied
    // above, so a second full-table scan would cost a 17k-row read to find
    // nothing. Byte-identical rows in this export are legitimate (one posting
    // action per night of a stay) and the occurrence index in the key keeps
    // them — a key-collapsing cleanup would silently delete real revenue.
    return {
      count: newRows.length,
      excluded: rows.length - newRows.length,
      cleaned: 0,
      anomalies: anomalyResult.count,
      anomalyAudit: anomalyResult.audit,
    };
  }

  if (type === "generic") {
    return { count: scanResult.rowsToImport?.length || 0, excluded: 0 };
  }

  // Occupancy, Source, Gross
  const keyFn = type === "source"
    ? (r) => `${r.property_id}|${r.date}|${r.code || r.source}`
    : (r) => `${r.property_id}|${r.date}`;

  const rows = (scanResult.rowsToImport || []).map((r) => addMetaFn(r));
  const deduped = dedupByKey(rows, keyFn);
  const newRows = forceImport ? deduped : await skipExisting(ENTITY[type], deduped, keyFn, restMeta.propertyId);

  let createdIds = [];
  for (let i = 0; i < newRows.length; i += 400) {
    const batch = newRows.slice(i, i + 400);
    const created = await db.entities[ENTITY[type]].bulkCreate(batch);
    createdIds.push(...created.map((r) => r.id));
  }
  if (createdIds.length) {
    await recordCreatedIds(ENTITY[type], restMeta.propertyId, importId, createdIds);
  }
  const cleaned = await dedupePropertyRows(ENTITY[type], restMeta.propertyId, keyFn);
  return { count: newRows.length, excluded: deduped.length - newRows.length, cleaned };
}

// Rollback an import by deleting exactly the records it created.
//
// Re-export, not a reimplementation. There were briefly two rollback functions
// with the same purpose and different behaviour — this one deleted through the
// entity proxy, the other through the raw Dexie table, so whether a rollback
// enforced property isolation and refreshed cached KPIs depended on which one
// the caller happened to import. Keeping the name as an alias preserves the
// existing import sites without reintroducing the fork.
export { rollbackImportSession as rollbackImport } from '@/api/base44Client';

// Backward-compatible convenience: scan + import in one call
export async function parseReport(type, fileUrl, meta = {}) {
  const scan = await scanReport(type, fileUrl, meta);
  const result = await importReport(scan, meta);
  return { ...result, scan };
}// SENTINEL123
