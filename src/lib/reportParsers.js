import { db, runInTransaction, createImportSession, completeImportSession } from '@/api/base44Client';
import localDb from '@/api/localDb';

import {
  fetchCsvRows, rowsToObjects, convertDate, isIsoDate, parseAmount, isCsvFile, detectSections, parseCsvText,
} from "@/lib/csvParser";

import { parseHotelReport, makeFileDedupKey, generateFileHash } from '@/lib/universalParser';

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

// Track IDs of created records for precise rollback
async function recordCreatedIds(entity, propertyId, importId, ids) {
  try {
    await localDb.ImportSession.add({
      import_id: importId,
      property_id: propertyId || "",
      entity,
      record_ids: ids,
      created_date: new Date().toISOString(),
    });
  } catch (e) {
    console.warn('[reportParsers] failed to record import IDs:', e.message);
  }
}

export const REPORT_TYPES = [
  { key: "auto", label: "Auto-detect (recommended)" },
  { key: "occupancy", label: "Occupancy Summary" },
  { key: "source", label: "Source Summary" },
  { key: "gross", label: "Gross Revenue" },
  { key: "payments", label: "Payments Summary" },
  { key: "clerk", label: "Clerk Shift & Cash Audit" },
  { key: "hotel_statistics", label: "Hotel Statistics (Universal)" },
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

async function getRowsArray(type, fileUrl, meta) {
  // If CSV text was pre-read from the File object, parse it directly (no fetch needed)
  if (meta?.csvText) {
    const rawRows = parseCsvText(meta.csvText);
    const objects = rowsToObjects(rawRows);
    return { objects, rawRows };
  }
  // Use sourceFile for detection if available, fallback to fileUrl
  const checkUrl = meta?.sourceFile || fileUrl;
  if (isCsvFile(checkUrl)) {
    const rawRows = await fetchCsvRows(fileUrl);
    const objects = rowsToObjects(rawRows);
    return { objects, rawRows };
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
  return { objects: Array.isArray(res.output) ? res.output : [], rawRows: [] };
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
  if (/clerk|shift|cash audit/i.test(fileName)) return "clerk";
  if (/payments? summary/i.test(fileName)) return "payments";
  if (/source summary/i.test(fileName)) return "source";
  if (/gross revenue/i.test(fileName)) return "gross";
  if (/occupancy/i.test(fileName)) return "occupancy";

  return "generic";
}

export async function scanReport(type, fileUrl, meta = {}) {
  const { objects, rawRows } = await getRowsArray(type, fileUrl, meta);
  const resolvedType = !type || type === "auto" ? detectReportType(fileUrl, rawRows, meta) : type;
  const fullMeta = { ...meta, type: resolvedType };

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

  if (resolvedType === "hotel_statistics") {
    return scanHotelStatistics(rawRows, fileUrl, fullMeta);
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
    meta,
  };
}

function scanClerkReport(rawRows, meta, objects = []) {
  const payments = [];
  const drops = [];
  const clerkPayments = [];

  const sections = detectSections(rawRows || []);

  for (const section of sections) {
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

  // Payments repeat per stacked period — keep the latest block per payment type
  const seenPayments = new Map();
  for (const p of payments) seenPayments.set(p.payment_type, p);
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
    } else if (scanResult.type !== "generic") {
      rowCounts[ENTITY[scanResult.type]] = result.count;
    }
    
    await completeImportSession(importSession.importId, rowCounts);
    return result;
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
      if (r.record_type === "payment") return `payment|${r.payment_type}`;
      if (r.record_type === "drop") return `drop|${r.shift_date}|${r.clerk_name}|${r.amount}`;
      return `clerk_payment|${r.clerk_name}|${r.payment_type}|${r.amount}`;
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
        const ids = await db.entities.ClerkShiftRecord.bulkCreate(batch);
        createdIds.push(...ids);
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
    
    const fileHash = scanResult.fileHash;
    const businessDate = restMeta.businessDate || restMeta.business_date || '';
    const fileDedupKey = fileHash ? `${fileHash}|${restMeta.propertyId}|${businessDate}` : null;
    
    let newRows = deduped;
    if (fileDedupKey && !forceImport) {
      const existingImports = await db.entities.HotelMetric
        .filter({ file_hash: fileHash, property_id: restMeta.propertyId, business_date: businessDate });
      if (existingImports.length > 0) {
        newRows = [];
      }
    }
    
    let createdIds = [];
    if (newRows.length) {
      for (let i = 0; i < newRows.length; i += 400) {
        const batch = newRows.slice(i, i + 400);
        const ids = await db.entities.HotelMetric.bulkCreate(batch);
        createdIds.push(...ids);
      }
    }
    if (createdIds.length) {
      await recordCreatedIds("HotelMetric", restMeta.propertyId, importId, createdIds);
    }
    return { count: newRows.length, excluded: deduped.length - newRows.length, cleaned: 0 };
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
    const ids = await db.entities[ENTITY[type]].bulkCreate(batch);
    createdIds.push(...ids);
  }
  if (createdIds.length) {
    await recordCreatedIds(ENTITY[type], restMeta.propertyId, importId, createdIds);
  }
  const cleaned = await dedupePropertyRows(ENTITY[type], restMeta.propertyId, keyFn);
  return { count: newRows.length, excluded: deduped.length - newRows.length, cleaned };
}

// Rollback an import by deleting all records created during that import
export async function rollbackImport(importId) {
  try {
    const sessions = await localDb.ImportSession.where('import_id').equals(importId).toArray();
    if (!sessions.length) {
      return { success: false, error: 'Import session not found' };
    }

    let totalDeleted = 0;
    for (const session of sessions) {
      if (session.record_ids && session.record_ids.length) {
        await db.entities[session.entity].bulkDelete(session.record_ids);
        totalDeleted += session.record_ids.length;
      }
    }

    // Mark session as rolled back
    for (const session of sessions) {
      await localDb.ImportSession.update(session.id, { status: 'rolled_back', rolled_back_at: new Date().toISOString() });
    }

    return { success: true, deletedCount: totalDeleted, message: `Rolled back ${totalDeleted} records from import ${importId}` };
  } catch (e) {
    console.error('[reportParsers] rollback failed:', e);
    return { success: false, error: e.message };
  }
}

// Backward-compatible convenience: scan + import in one call
export async function parseReport(type, fileUrl, meta = {}) {
  const scan = await scanReport(type, fileUrl, meta);
  const result = await importReport(scan, meta);
  return { ...result, scan };
}// SENTINEL123
