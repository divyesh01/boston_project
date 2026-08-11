import { db, runInTransaction, createImportSession, completeImportSession, addImportRecordIds } from '@/api/base44Client';
import localDb from '@/api/localDb';

import {
  fetchCsvRows, rowsToObjects, convertDate, isIsoDate, parseAmount, isCsvFile, detectSections, parseCsvText,
} from "@/lib/csvParser";

import { parseHotelReport, makeFileDedupKey, generateFileHash } from '@/lib/universalParser';

import {
  TXN_SIGNATURE, mapTransactionRow, isTrailerRow, assignDedupeKeys,
} from '@/lib/transactionNorm';
import { toCents, fromCents, sumCents } from '@/lib/decimal';
import { neutralizeFormula } from '@/lib/securityUtils';
import { detectAnomalies } from '@/lib/anomalyDetector';
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
    const all = await db.entities[entity].filter(propertyId ? { property_id: propertyId } : {}, "created_date", 100000);
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
  "Total Revenue": "total_revenue", total_revenue: "total_revenue",
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
  "LOYALTY CERTIFICATE": "loyalty_certificate", "LOYALTY DISCOUNT": "loyalty_discount",
  "VIP PASS": "vip_pass", "WIRE TRANSFER": "wire_transfer",
  Total: "total", TOTAL: "total",
};

const NUMERIC_FIELDS = new Set([
  "room_revenue", "other_room_revenue", "total_revenue", "total_rooms", "rooms_sold",
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

const ENTITY = {
  occupancy: "OccupancyDay",
  source: "SourceDay",
  gross: "GrossRevenueDay",
  payments: "PaymentDay",
  hotel_statistics: "HotelMetric",
  transactions: "TransactionLine",
};
const REVENUE_COL = {
  occupancy: "total_revenue",
  source: "net_revenue",
  gross: "room_rent",
  payments: "total",
};

function mapRow(obj) {
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined || value === "") continue;
    const fieldName = COLUMN_MAP[key];
    if (fieldName) {
      out[fieldName] = NUMERIC_FIELDS.has(fieldName) ? parseAmount(value) ?? 0 : value;
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
  const filter = propertyId ? { property_id: propertyId } : {};
  const existing = await db.entities[entity].filter(filter, "date", 100000);
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
  if (/hotel.?stat/i.test(fileName)) return "hotel_statistics";
  if (/all.?transactions?|transaction.?(list|ledger|detail)/i.test(fileName)) return "transactions";
  if (/clerk|shift|cash audit/i.test(fileName)) return "clerk";
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

  // Occupancy, Source, Gross, Payments — flat tables
  const mapped = objects.map((obj) => mapRow(obj)).filter((r) => Object.keys(r).length > 0);

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
      // For occupancy: calculate occupancy ratio from rooms_sold/total_rooms if occupancy not set or > 1
      if (resolvedType === "occupancy") {
        if (!r.occupancy || r.occupancy > 1) {
          const sold = Number(r.rooms_sold) || 0;
          const total = Number(r.total_rooms) || 0;
          r.occupancy = total > 0 ? sold / total : 0;
        } else if (r.occupancy > 1) {
          r.occupancy = r.occupancy / 100;
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

  return {
    type: resolvedType,
    sections: [{ name: REPORT_TYPES.find((r) => r.key === resolvedType)?.label || resolvedType, rows: processed.length, preview: processed.slice(0, 20) }],
    totalRows: processed.length,
    rowsToImport: processed,
    meta: fullMeta,
    debug: debugInfo,
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
  const importId = meta.importId || `imp_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
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

  return {
    type: "hotel_statistics",
    sections,
    totalRows: parseResult.metrics.length,
    rowsToImport: parseResult.metrics,
    metrics: parseResult.metrics,
    unknownMetrics: parseResult.unknownMetrics,
    errors: parseResult.errors,
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
      meta,
    };
  }

  const rows = [];
  const trailers = [];
  let skipped = 0;

  for (const cells of best.rows) {
    const mapped = mapTransactionRow(best.headers, cells);
    // Trailer: total but no date. Keep it for the checksum, never as data.
    if (isTrailerRow(mapped)) { trailers.push(mapped); continue; }
    if (!mapped.date || !isIsoDate(mapped.date)) { skipped++; continue; }
    rows.push(mapped);
  }

  // Checksum. A mismatch does not block the import — the parsed rows are still
  // the best available truth — but it is surfaced in the scan so a bad file is
  // never imported unnoticed.
  const parsedCents = sumCents(rows.map((r) => r.amount));
  const trailerCents = trailers.length ? toCents(trailers[trailers.length - 1].amount) : null;
  const errors = [];
  if (trailerCents !== null && trailerCents !== parsedCents) {
    errors.push(
      `Amount total does not match the file's own total: parsed ${fromCents(parsedCents).toFixed(2)}, file says ${fromCents(trailerCents).toFixed(2)}.`
    );
  }
  if (skipped) {
    errors.push(`${skipped} row(s) skipped: no readable date.`);
  }

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

export async function importReport(scanResult, meta = {}) {
  const { forceImport = false, sourceFile = "", propertyId = "", propertyName = "", ...restMeta } = meta;
  
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
    // Import failed - session remains as 'in_progress' for debugging
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
      const existing = await db.entities.TransactionLine.filter(
        restMeta.propertyId ? { property_id: restMeta.propertyId } : {},
        "date",
        1000000
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
