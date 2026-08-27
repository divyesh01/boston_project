// Direct CSV parser — handles date formats like "1-Jan-26", currency "$1,337.80", negatives "($100.00)"

// Single source of truth for the import file-size ceiling. Every parse-path
// gate (fetchCsvRows, getRowsArray's pre-read text branch, uploadGuard,
// ManualEntry) reads THIS constant so the app never enforces two different
// limits on the same upload. Sized to admit a real ~100k-row transactions
// export (~15–30 MB) with headroom while still rejecting absurd files.
export const MAX_IMPORT_BYTES = 50 * 1024 * 1024; // 50 MB

const MONTH_MAP = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

// A date can be perfectly well-formed and still be a date that does not exist.
//
// convertDate used to assemble whatever digits it found: "13/45/2026" became
// "2026-13-45", and because every guard in the codebase is only the shape test
// /^\d{4}-\d{2}-\d{2}/, that string passed as a valid date. The row imported and its
// revenue was filed under a month no report will ever total. Same for "2026-02-31",
// "29-Feb-26" (2026 is not a leap year) and "31/01/2026" — a D/M/Y export read as
// M/D/Y, which yields month 31.
//
// The Date.UTC round-trip does the work: JS normalises Feb 31 to Mar 3, so if the
// fields come back changed, the date was not real. No month-length table needed.
function isRealCalendarDate(year, month, day) {
  const y = Number(year), m = Number(month), d = Number(day);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  // A hotel's books do not reach outside this range; anything that does is a parse
  // artefact, not a record.
  if (y < 1900 || y > 2200) return false;
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// "" means "this cell holds no usable date". Callers already treat that as a skip with
// a reason (reportParsers.js:489 counts it, :1173 rejects the punch, manualEntryImport
// raises a named warning), so refusing here surfaces loudly instead of silently.
function isoOrEmpty(year, month, day) {
  const y = String(year);
  const m = String(month).padStart(2, "0");
  const d = String(day).padStart(2, "0");
  return isRealCalendarDate(y, m, d) ? `${y}-${m}-${d}` : "";
}

export function convertDate(s) {
  if (!s) return "";
  s = String(s).trim();
  // "1-Jan-26" or "01-Jan-2026"
  const m1 = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
  if (m1) {
    const day = m1[1].padStart(2, "0");
    const mon = MONTH_MAP[m1[2].toLowerCase()];
    let year = m1[3];
    if (year.length === 2) year = "20" + year;
    if (mon) return isoOrEmpty(year, mon, day);
  }
  // ISO "2026-01-01"
  const m2 = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m2) return isoOrEmpty(m2[1], m2[2], m2[3]);
  // US "1/1/2026"
  const m3 = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m3) {
    let year = m3[3];
    if (year.length === 2) year = "20" + year;
    return isoOrEmpty(year, m3[1], m3[2]);
  }
  // "Apr 01, 2026" / "Apr 1, 2026" / "Jul 01, 2026"
  const m4 = s.match(/^([A-Za-z]{3})\s+(\d{1,2}),\s+(\d{4})$/);
  if (m4) {
    const mon = MONTH_MAP[m4[1].toLowerCase()];
    if (mon) return isoOrEmpty(m4[3], mon, m4[2]);
  }
  // "Apr 01, 2026" with day of week prefix like "Wed, Apr 01, 2026"
  const m5 = s.match(/^[A-Za-z]{3},\s*([A-Za-z]{3})\s+(\d{1,2}),\s+(\d{4})$/);
  if (m5) {
    const mon = MONTH_MAP[m5[1].toLowerCase()];
    if (mon) return isoOrEmpty(m5[3], mon, m5[2]);
  }
  // "2026-03-07 03:21 PM" - datetime format
  const m6 = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m6) return isoOrEmpty(m6[1], m6[2], m6[3]);
  return s;
}

// Guards a value that is already in ISO shape. This is the last line of defence for
// rows written before the calendar check existed, and for the call sites that test
// r.date without re-converting it (reportParsers.js:509, :747).
export function isIsoDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ""));
  if (!m) return false;
  return isRealCalendarDate(m[1], m[2], m[3]);
}

// Money cell -> Number, sign preserved. null means "nothing numeric here", which
// importValidation.js:87 relies on to tell an empty cell from a real 0.
//
// The sign is read AFTER the currency symbol and separators are stripped. Reading
// it off the raw string let a leading "$" hide the sign that followed it, so
// "$-50.00" and "$(50.00)" both parsed as +50 — an imported refund became a charge
// of the same size, and reportParsers.js:230 feeds this straight into
// TransactionLine.amount.
export function parseAmount(s) {
  if (s == null) return null;
  const raw = String(s).trim();
  if (!raw) return null;

  let body = raw.replace(/[$,\s]/g, "");

  // Three negative conventions turn up in real PMS and ledger exports: accounting
  // parentheses, a leading minus, and a trailing minus.
  let negative = false;
  if (body.startsWith("(") && body.endsWith(")")) {
    negative = true;
    body = body.slice(1, -1);
  }
  if (body.startsWith("-")) { negative = true; body = body.slice(1); }
  else if (body.endsWith("-")) { negative = true; body = body.slice(0, -1); }

  // Unbalanced parens are ambiguous; drop them and let parseFloat decide, which is
  // what this function did before and keeps a malformed cell importable.
  body = body.replace(/[()]/g, "");

  const n = parseFloat(body);
  if (isNaN(n)) return null;
  // Non-finite values are rejected the same way garbage is. ADDED 2026-08-20:
  // parseFloat("Infinity") is Infinity and parseFloat("1e999") overflows to it, so
  // both used to be returned as if they were money. There is no infinite dollar
  // amount, and Infinity is the one bad value that cannot be traced afterwards:
  // Infinity - Infinity is NaN, so a single poisoned cell takes the whole period's
  // total with it and no later check can point at which cell did it. Returning null
  // routes it through the normal path — logged as an `unparseable` coercion by
  // importValidation.js#recordCoercion, stored as 0, visible in the scan preview.
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

// Character-level scanner over the whole text.
//
// A quoted field may legally contain commas AND newlines, so the text cannot be
// split into lines before tokenizing. Real PMS exports do this: a transaction
// whose Remarks field is "SS\n" used to be torn into two rows, which shifted
// every field after it and silently produced a corrupt record plus a junk one.
// A leading UTF-8 BOM is also stripped here — left in place it becomes part of
// the first header name ("﻿Date"), which breaks every header lookup.
//
// Blank lines still yield `[]`: both section detectors (`detectSections` here and
// the one in universalParser) use that empty-array sentinel as their delimiter.
export function parseCsvText(text) {
  const src = String(text ?? "").replace(/^﻿/, "");
  const rows = [];
  let fields = [];
  let current = "";
  let inQuote = false;
  // Quote characters are content: a line holding only `""` is a row with one
  // empty field, not a blank line. Tracked so that distinction survives.
  let sawQuote = false;

  const endField = () => {
    fields.push(current.trim());
    current = "";
  };
  const endRow = () => {
    endField();
    const blank = !sawQuote && fields.length === 1 && fields[0] === "";
    rows.push(blank ? [] : fields);
    fields = [];
    sawQuote = false;
  };

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"') {
      sawQuote = true;
      if (inQuote && src[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuote = !inQuote;
      }
    } else if (c === "," && !inQuote) {
      endField();
    } else if ((c === "\n" || c === "\r") && !inQuote) {
      if (c === "\r" && src[i + 1] === "\n") i++;
      endRow();
    } else {
      current += c;
    }
  }
  // Trailing text with no final newline is still a row; a trailing newline must
  // not invent an extra empty one.
  if (current !== "" || fields.length || sawQuote) endRow();
  return rows;
}

export function rowsToObjects(rawRows) {
  if (rawRows.length < 2) return [];
  const headers = rawRows[0].map((h) => h.trim());
  return rawRows
    .slice(1)
    .filter((r) => r.length > 0 && r.some((c) => c !== ""))
    .map((row) => {
      // NULL PROTOTYPE, deliberately. With a plain `{}`, a column literally named
      // `__proto__` is not a data key — `obj["__proto__"] = "500.00"` sets the
      // object's prototype instead of storing a value, and because the value is a
      // string the assignment is silently ignored. Measured before this change:
      //
      //   rowsToObjects([['Date','__proto__','Amount'],
      //                  ['2026-01-01','SILENTLY_LOST','42']])
      //     -> {"Date":"2026-01-01","Amount":"42"}      // the cell is GONE
      //   two `__proto__` columns  -> {}                 // BOTH cells gone
      //
      // No key, no value, no error — exactly the silent import data loss this
      // project forbids, on input the directives class as hostile. A null
      // prototype makes every header an ordinary own property, so nothing is lost
      // and nothing has to be renamed or rejected. It also removes prototype
      // pollution as a category rather than blocklisting one key.
      const obj = Object.create(null);
      headers.forEach((h, i) => {
        // Object.prototype.hasOwnProperty.call, not obj.hasOwnProperty: `obj` has
        // no prototype now, so the method form would throw.
        if (Object.prototype.hasOwnProperty.call(obj, h)) {
          // Duplicate header. Suffix with the 1-BASED COLUMN NUMBER, so the key
          // says where the value came from and two duplicates can never collide.
          obj[h + "_" + (i + 1)] = row[i] || "";
        } else {
          obj[h] = row[i] || "";
        }
      });
      // Cells past the end of the header row. Real PMS exports emit these; naive
      // header-driven mapping drops them.
      for (let i = headers.length; i < row.length; i++) {
        obj["_extra_" + (i + 1)] = row[i] || "";
      }
      return obj;
    });
}

// Detect stacked CSV sections by scanning for header rows
const SECTION_HEADERS = {
  payment_summary: ["payment type", "actual", "adjusted", "net today"],
  shift_log: ["username", "start time", "end time", "closed by"],
  adjustments_detail: ["adjusted amount"],
  refunds_detail: ["payment type refunded", "refund code"],
  employee_payments: ["username", "payment type", "amount"],
  expenses: ["expense type", "amount"],
  currency_conversion: ["type", "converted from", "conversion rate", "converted value"],
  deposit_drop: ["time", "username"],
};


function headerMatches(rowCells, headerKeywords) {
  const lower = rowCells.map((c) => c.toLowerCase().trim());
  return headerKeywords.every((kw) => lower.some((l) => l === kw || l.includes(kw)));
}

export function detectSections(rawRows) {
  const sections = [];
  let current = null;
  let currentRows = [];

  const flush = () => {
    if (current) {
      current.rows = currentRows;
      sections.push(current);
    }
    current = null;
    currentRows = [];
  };

  for (const row of rawRows) {
    const isEmpty = row.length === 0 || row.every((c) => c.trim() === "");

    if (isEmpty) {
      flush();
      continue;
    }

    // Check if this row matches a section header
    let matchedType = null;
    for (const [type, keywords] of Object.entries(SECTION_HEADERS)) {
      if (headerMatches(row, keywords)) {
        matchedType = type;
        break;
      }
    }

    if (matchedType) {
      flush();
      current = { type: matchedType, headerRow: row, detectedColumns: row };
      currentRows = [];
    } else {
      currentRows.push(row);
    }
  }

  flush();
  return sections;
}

// Offload a CSV string to the parse worker and resolve its tokenised rows.
//
// This is the ONE place a Worker is constructed for CSV parsing, shared by
// fetchCsvRows (fetched files) and reportParsers.getRowsArray (files the UI
// pre-read into meta.csvText). Routing the pre-read path here too is what keeps
// a 100k-row import off the main thread — parsing a string of that size inline
// froze the tab. The worker's handler is synchronous, so the test harness runs
// it in-process (scripts/_dom-shims.mjs) with identical row output.
export function parseTextInWorker(text) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./parser.worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      if (e.data.error) reject(new Error(e.data.error));
      else resolve(e.data.rows);
      worker.terminate();
    };
    worker.onerror = (e) => {
      reject(e);
      worker.terminate();
    };
    worker.postMessage({ text });
  });
}

export async function fetchCsvRows(fileUrl) {
  // Strip the hash fragment from the URL before fetching to prevent fetch errors with blob URLs in some environments
  const cleanUrl = fileUrl.split('#')[0];
  const res = await fetch(cleanUrl);
  if (!res.ok) throw new Error(`Failed to fetch CSV: ${res.statusText}`);

  const contentLength = res.headers.get('content-length');
  if (contentLength && parseInt(contentLength, 10) > MAX_IMPORT_BYTES) {
    throw new Error(`File exceeds ${MAX_IMPORT_BYTES / (1024 * 1024)}MB size limit`);
  }

  const text = await res.text();
  if (text.length > MAX_IMPORT_BYTES) {
    throw new Error(`File exceeds ${MAX_IMPORT_BYTES / (1024 * 1024)}MB size limit`);
  }

  return parseTextInWorker(text);
}

export function isCsvFile(fileUrl) {
  if (!fileUrl) return false;
  // Check both the URL path and the hash fragment (blob URLs encode filename in hash)
  return /\.csv(\?|#|$)/i.test(fileUrl) || /\.csv$/i.test(decodeURIComponent(fileUrl.split('#').pop() || ''));
}