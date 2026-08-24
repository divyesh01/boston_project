// Owner-facing data export and fast date filtering.
//
// WHY THIS MODULE EXISTS
// ─────────────────────────────────────────────────────────────────────────────
// Every page in this app could already *show* data. Getting it OUT — into a
// spreadsheet, an accountant's inbox, a lender's data request — went through
// hotel.js#toCsv, which has three defects that only appear on real data:
//
//   1. SILENT COLUMN LOSS. `Object.keys(rows[0])` decides the columns for the
//      whole file. Audit rows, transaction rows and payroll rows are all
//      heterogeneous: `device` is absent on server-side events, `detail` is
//      absent on most logins, `employee_id` is absent on non-payroll charges. If
//      the FIRST row happens to lack a field, that column vanishes from the
//      export for every row that had it — with no error and no count. An export
//      that quietly drops a column is worse than one that fails, because the
//      recipient reconciles against it.
//
//   2. NO UTF-8 BOM. Excel on Windows reads a BOM-less UTF-8 CSV as the local
//      ANSI code page, so "Nuñez" arrives as "NuÃ±ez" and "€" as "â‚¬". The
//      owner's staff names and any European channel names are exactly the data
//      that breaks.
//
//   3. LF LINE ENDINGS. RFC 4180 specifies CRLF. LF-only files import fine in
//      modern Excel but concatenate into one record in several older importers
//      and in Numbers' legacy path.
//
// It also downloaded via an anchor that was never attached to the document and
// revoked the blob URL on the same tick as .click(), which races the browser's
// own fetch of that URL.
//
// MIGRATION STATUS (updated 2026-08-20). When this module was written it lived
// alongside hotel.js#toCsv/downloadCsv/downloadExcel, and only new export surfaces
// used it. All five export surfaces now route here — AuditLog, Transactions,
// Statistics, ManualEntry, ChartBuilder — so hotel.js#downloadCsv and
// hotel.js#downloadExcel were deleted as orphans. hotel.js#toCsv still exists
// because scripts/verify-harness.mjs §6 asserts against it; no page calls it.
// There is exactly one download implementation in the app, and it is this one.
//
// THE SECOND HALF: DATE RANGES THAT AGREE WITH THE OWNER'S CALENDAR
// ─────────────────────────────────────────────────────────────────────────────
// Everything here derives dates from LOCAL calendar parts, never from
// toISOString(). The repo's timezone is America/New_York (UTC-4/-5), so
// `new Date().toISOString().slice(0, 10)` returns TOMORROW's date for anything
// after 8pm — a "Today" filter that hides the evening shift's own events, which
// is precisely when a night-audit clerk would be looking at them. Same trap for
// "This month" on the 31st at 9pm.
//
// BEST OUTCOME NOTE (2026-08-20): local-parts arithmetic is the correct approach
// here rather than a date library. There is a hard no-new-dependency rule in
// this repo, and the operation is genuinely small: build a Date from
// (year, month, day) integers and read the same three integers back. Every
// preset below is asserted in scripts/probe-export-data.mjs against a fixed
// clock, including the 9pm-local and Dec-31 boundaries where UTC diverges.

import * as XLSX from "xlsx";
import { neutralizeFormula } from "@/lib/securityUtils";

// A cell that is EXACTLY a decimal number, and nothing else.
//
// Deliberately strict: no leading "+", no surrounding whitespace, no thousands
// separators, no currency symbol. Anything looser starts admitting payloads.
// "-25.50" matches. "-2+3+cmd|' /C calc'!A0" — the canonical DDE payload that
// opens with a minus — does not, and is still neutralised.
const NUMERIC_TEXT = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;


// ─── Local calendar primitives ───────────────────────────────────────────────

/** Zero-padded local-date key, "YYYY-MM-DD", from a Date. Never UTC. */
export function toLocalDayKey(value) {
  // Guarded explicitly, because `new Date(null)` is NOT an invalid date — it is
  // the Unix epoch. scripts/probe-export-data.mjs caught this on the first run:
  // without these three lines, a row with `created_date: null` silently became
  // 31 Dec 1969 (in a UTC-negative zone), so undated rows would have been
  // *included* by any range starting before 1970 and counted as dated by
  // countUndated. An undated row must be visibly undated, never quietly
  // backdated. `new Date(false)` and `new Date("")` have the same behaviour, so
  // booleans and the empty string are rejected too. Numbers are left alone —
  // epoch milliseconds are a legitimate input.
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Local midnight, `n` days before the given day. Handles DST and month ends
 *  because Date normalises out-of-range day numbers. */
function shiftDays(base, n) {
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + n);
}

// ─── Quick ranges ────────────────────────────────────────────────────────────
// Ordered as an owner scans them: the narrowest window first, because the
// question is almost always "what happened just now".
//
// `days: null` means the preset computes its own start (period-to-date presets),
// and `all` deliberately returns nulls rather than a wide range so "no filter"
// is representable without inventing a floor date that would silently exclude
// older history.
export const QUICK_RANGES = [
  { id: "today", label: "Today" },
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
  { id: "mtd", label: "This month" },
  { id: "qtd", label: "This quarter" },
  { id: "ytd", label: "Year to date" },
  { id: "all", label: "All time" },
  { id: "custom", label: "Custom" },
];

const QUICK_RANGE_IDS = new Set(QUICK_RANGES.map((r) => r.id));
export const isQuickRange = (id) => QUICK_RANGE_IDS.has(id);

/**
 * Resolve a preset id to inclusive local-date bounds.
 * @returns {{ from: string|null, to: string|null }} "YYYY-MM-DD" or null for open-ended.
 */
export function resolveQuickRange(id, now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const to = toLocalDayKey(today);
  switch (id) {
    case "today":
      return { from: to, to };
    // 7 days means today plus the six before it — the week an owner means when
    // they say "the last week", not 7 days ending yesterday.
    case "7d":
      return { from: toLocalDayKey(shiftDays(today, -6)), to };
    case "30d":
      return { from: toLocalDayKey(shiftDays(today, -29)), to };
    case "mtd":
      return { from: toLocalDayKey(new Date(today.getFullYear(), today.getMonth(), 1)), to };
    case "qtd":
      return { from: toLocalDayKey(new Date(today.getFullYear(), Math.floor(today.getMonth() / 3) * 3, 1)), to };
    case "ytd":
      return { from: toLocalDayKey(new Date(today.getFullYear(), 0, 1)), to };
    case "all":
    default:
      return { from: null, to: null };
  }
}

/**
 * Is a timestamp inside [from, to] by LOCAL calendar day, inclusive at both ends?
 *
 * Inclusive-at-both-ends is the only behaviour an owner reads correctly from a
 * pair of date inputs: picking 1 Aug → 31 Aug must contain 31 August. A
 * half-open range would drop the last day, which reads as missing data.
 *
 * An unparseable or missing timestamp returns false when a range is active. It
 * is NOT passed through: a row whose date cannot be read has not been shown to
 * be inside the window, and quietly including it would let undated rows leak
 * into every filtered total. The caller is expected to surface the count of
 * excluded-undated rows if it matters (see countUndated).
 */
export function withinRange(value, from, to) {
  if (!from && !to) return true;
  const key = toLocalDayKey(value);
  if (!key) return false;
  if (from && key < from) return false;
  if (to && key > to) return false;
  return true;
}

/** How many rows carry no readable date — the rows a range filter must exclude. */
export function countUndated(rows, dateKey = "created_date") {
  return rows.reduce((n, r) => (toLocalDayKey(r?.[dateKey]) ? n : n + 1), 0);
}

// ─── CSV ─────────────────────────────────────────────────────────────────────

/**
 * A column spec. `key` reads the row; `label` is the header an owner reads;
 * `format` renders the cell (and receives the whole row, so a column can combine
 * fields).
 *
 * @typedef {Object} CsvColumn
 * @property {string} key
 * @property {string} [label]
 * @property {(value: any, row: Record<string, any>) => any} [format]
 */

/**
 * @typedef {Object} CsvOptions
 * @property {(CsvColumn|string)[]} [columns]
 * @property {boolean} [bom]
 */

/**
 * The options BOTH writers accept, so a caller can choose the writer at runtime —
 * `(isExcel ? downloadExcel : downloadCsv)(rows, opts)` — and hand it a single
 * options object.
 *
 * That call site is why this alias exists. TypeScript resolves a call on a union
 * of function types against one signature and applies its excess-property check,
 * so `sheetName` (which only the Excel writer reads) was reported as
 * "not assignable to CsvOptions & { filename?: string }" — the CSV signature. The
 * honest fix is one shape for both writers rather than two that nearly match.
 *
 * Each writer ignores what does not apply to it: `sheetName` is meaningless to a
 * CSV (one file, no sheets) and `bom` is meaningless to an .xlsx (SheetJS writes
 * the encoding itself). Ignoring beats rejecting here — a caller that switches
 * format on a boolean should not have to build a different object per branch.
 *
 * @typedef {CsvOptions & { filename?: string, sheetName?: string }} DownloadOptions
 */

// Every cell is quoted, unconditionally. Conditional quoting has to decide
// whether a value "needs" it, and that decision has been wrong in every CSV
// writer this repo has had: a leading zero, an embedded comma from a free-text
// detail field, a newline pasted into a note. Quoting everything costs two bytes
// per cell and removes the class.
export function csvCell(value) {
  if (value === null || value === undefined) return '""';
  const raw = value instanceof Date ? value.toISOString() : String(value);
  // Numbers are exempt from the formula guard.
  //
  // DEFECT FIXED 2026-08-20: neutralizeFormula() guards any cell whose first
  // character is one of = + - @ tab CR by prefixing a single quote — and "-25.50"
  // starts with a minus. Every negative amount this app exports therefore left as
  // the TEXT '-25.50: refunds, adjustments, loyalty discounts and closed-balance
  // folios are all stored signed-negative (see REFUND_FIELDS in paymentNorm.js),
  // so an owner who exported a payments view and tried to total the refund column
  // in Excel got 0 and a column of apostrophes. The export was unusable for the
  // exact figure most worth exporting.
  //
  // BEST OUTCOME NOTE: exempting exact numerics is the right fix rather than
  // dropping the guard or special-casing named "amount" columns. There is no
  // spreadsheet formula or DDE payload that is also a valid plain decimal number,
  // so the exemption cannot admit one; and it needs no list of column names to
  // stay in sync with, which means a new money column is safe on the day it is
  // added instead of on the day someone remembers to add it to a list.
  const guarded = NUMERIC_TEXT.test(raw) ? raw : neutralizeFormula(raw);
  return `"${guarded.replace(/"/g, '""')}"`;
}

/**
 * Column order for a heterogeneous row set: the union of every key, in the order
 * each key is first seen. Fixes the `Object.keys(rows[0])` data loss described
 * at the top of this file.
 */
export function unionColumns(rows) {
  const seen = [];
  const have = new Set();
  for (const row of rows || []) {
    if (!row || typeof row !== "object") continue;
    for (const k of Object.keys(row)) {
      if (!have.has(k)) { have.add(k); seen.push(k); }
    }
  }
  return seen;
}

/**
 * Build an RFC 4180 CSV.
 *
 * @param {Record<string, any>[]} rows array of plain objects
 * @param {CsvOptions} [options] `columns` is [{ key, label?, format? }] or
 *        ["key", ...]; when omitted, every key present on ANY row is exported.
 *        `bom` prepends a UTF-8 BOM (default true, for Excel).
 */
export function buildCsv(rows, { columns, bom = true } = /** @type {CsvOptions} */ ({})) {
  const list = Array.isArray(rows) ? rows : [];
  // Same resolver the Excel path uses, so the two exports cannot drift apart.
  const cols = resolveColumns(list, columns);
  if (!cols.length) return bom ? "﻿" : "";

  const header = cols.map((c) => csvCell(c.label ?? c.key)).join(",");
  const body = list.map((row) =>
    cols
      .map((c) => {
        const v = c.format ? c.format(row?.[c.key], row) : row?.[c.key];
        return csvCell(v);
      })
      .join(","),
  );
  // CRLF per RFC 4180, and a trailing CRLF so `wc -l` and naive line readers
  // agree on the record count.
  return `${bom ? "﻿" : ""}${[header, ...body].join("\r\n")}\r\n`;
}

/**
 * "audit-log_2026-08-20_2143.csv" — local date AND local time, because an owner
 * exporting the same view twice in a morning otherwise overwrites the first file
 * or ends up with "export (1).csv" and no idea which is which.
 */
export function stampFilename(base, ext = "csv", now = new Date()) {
  // Runs of dots collapse to one. `[^A-Za-z0-9._-]` alone keeps ".." intact, so
  // a base of "../../etc/passwd" became "..-..-etc-passwd": harmless as a
  // download name (no separators survive, so there is no traversal), but a
  // filename that LOOKS like a traversal attempt is a support ticket, and some
  // archive tools do re-interpret it once the file is repacked.
  const safe =
    String(base || "export")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/\.{2,}/g, ".")
      .replace(/^[-.]+|[-.]+$/g, "") || "export";
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  return `${safe}_${toLocalDayKey(now)}_${hh}${mm}.${ext}`;
}

/**
 * Hand a Blob to the browser as a download.
 *
 * Shared rather than inlined per caller because both details below were found the
 * hard way and a second copy of this logic is one copy that will be missing one
 * of them:
 *
 *  - the anchor is APPENDED to the document, because Firefox ignores `.click()`
 *    on a detached element;
 *  - the object URL is revoked on a LATER task, because revoking it synchronously
 *    races the browser's own read of the blob and yields an empty file.
 *
 * @param {Blob} blob
 * @param {string} filename used verbatim — stamp it before calling
 */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 0);
}

/**
 * Trigger a download. Returns the number of data rows written so the caller can
 * report "Exported 412 rows" instead of a silent no-op — a click that appears to
 * do nothing is indistinguishable from a broken button.
 *
 * Throws when there is nothing to export, so the caller must decide what to tell
 * the user rather than silently returning.
 *
 * @param {Record<string, any>[]} rows
 * @param {DownloadOptions} [options] `sheetName` is accepted and ignored.
 * @returns {number} rows written
 */
export function downloadCsv(rows, { filename = "export", columns, bom = true } = /** @type {DownloadOptions} */ ({})) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) throw new Error("Nothing to export — no rows match the current filters.");
  const csv = buildCsv(list, { columns, bom });
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  downloadBlob(blob, filename.endsWith(".csv") ? filename : stampFilename(filename, "csv"));
  return list.length;
}

// ─── Excel ───────────────────────────────────────────────────────────────────
// The CSV and XLSX buttons must produce the SAME columns, labels and values.
// Before this existed, CSV went through buildCsv (labels, union of keys, guarded
// cells) while XLSX went through hotel.js#downloadExcel → XLSX.utils.json_to_sheet
// on the raw rows: raw snake_case keys as headers, and a silent `return` on an
// empty row set. Two buttons side by side produced two different files, and one of
// them did nothing at all when the filters matched nothing.

/** Normalise a column spec (string | {key,label,format}) into {key,label,format}. */
function resolveColumns(rows, columns) {
  const source = columns && columns.length ? columns : unionColumns(rows);
  return source.map((c) => (typeof c === "string" ? { key: c, label: c } : { label: c.key, ...c }));
}

/**
 * One spreadsheet cell. Numbers stay numbers so Excel can total the column;
 * everything else is text with the formula guard applied.
 *
 * The guard is applied here too even though a string written by SheetJS lands in
 * a cell typed `s` (text) and is not evaluated: "Save As → CSV" and every
 * xlsx→csv converter re-emit that text into a context where it IS evaluated, and
 * a re-export is exactly what happens to a file sent to an accountant.
 */
function excelCell(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? value : "";
  if (typeof value === "boolean") return value;
  if (value instanceof Date) return value;
  const raw = String(value);
  if (NUMERIC_TEXT.test(raw)) return Number(raw);
  return neutralizeFormula(raw);
}

/**
 * Header row + data rows, as an array of arrays. Exported for the probe.
 * @param {Record<string, any>[]} rows
 * @param {CsvOptions} [options]
 */
export function buildSheetRows(rows, { columns } = /** @type {CsvOptions} */ ({})) {
  const list = Array.isArray(rows) ? rows : [];
  const cols = resolveColumns(list, columns);
  if (!cols.length) return [];
  return [
    cols.map((c) => c.label ?? c.key),
    ...list.map((row) => cols.map((c) => excelCell(c.format ? c.format(row?.[c.key], row) : row?.[c.key]))),
  ];
}

// Excel rejects a sheet name over 31 chars or containing : \ / ? * [ ], and
// throws on an empty one. Sanitised rather than trusted: these names are built
// from page state ("Transactions 2026-08-01..2026-08-31" contains slashes in
// other locales).
function safeSheetName(name) {
  const cleaned = String(name || "Export").replace(/[:\\/?*[\]]+/g, "-").slice(0, 31).trim();
  return cleaned || "Export";
}

/**
 * Trigger an .xlsx download. Same contract as downloadCsv: throws when there is
 * nothing to export, returns the number of data rows written.
 *
 * @param {Record<string, any>[]} rows
 * @param {DownloadOptions} [options] `bom` is accepted and ignored.
 * @returns {number} rows written
 */
export function downloadExcel(rows, { filename = "export", columns, sheetName = "Export" } = /** @type {DownloadOptions} */ ({})) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) throw new Error("Nothing to export — no rows match the current filters.");
  const sheet = XLSX.utils.aoa_to_sheet(buildSheetRows(list, { columns }));
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, safeSheetName(sheetName));
  XLSX.writeFile(book, filename.endsWith(".xlsx") ? filename : stampFilename(filename, "xlsx"));
  return list.length;
}

// ─── Filter persistence ──────────────────────────────────────────────────────
// A dashboard that forgets the filters you set is a dashboard you re-configure
// on every visit. Persisted per page key.
//
// Everything is wrapped: localStorage throws outright in Safari private mode and
// when a storage quota is exceeded, and a filter preference is never worth
// taking a page down for.

const FILTER_PREFIX = "rri_filters_";

/**
 * Restore this page's saved filters, keeping the shape of `fallback`.
 *
 * The @template is not decoration: without it the return type is `{}` and every
 * caller that reads `stored.range` fails `npm run typecheck`. Declaring the
 * return as T also means a caller gets a type error when it reads a filter key it
 * never declared a default for — which is the same class of bug the key filtering
 * below prevents at runtime.
 *
 * @template {Record<string, any>} T
 * @param {string} pageKey
 * @param {T} [fallback]
 * @returns {T}
 */
export function readStoredFilters(pageKey, fallback = /** @type {T} */ ({})) {
  try {
    if (typeof localStorage === "undefined") return { ...fallback };
    const raw = localStorage.getItem(FILTER_PREFIX + pageKey);
    if (!raw) return { ...fallback };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ...fallback };
    // Only keys the caller declared are restored. Without this, a stale or
    // hand-edited entry can inject arbitrary state into the page's filter object.
    // Assembled as a plain record and cast once at the end: writing through a
    // generic T is not assignable (TS2862), and widening T to `any` here would
    // throw away the caller-side checking the @template exists to provide.
    const out = /** @type {Record<string, any>} */ ({ ...fallback });
    for (const k of Object.keys(fallback)) {
      if (parsed[k] !== undefined) out[k] = parsed[k];
    }
    return /** @type {T} */ (out);
  } catch {
    return { ...fallback };
  }
}

export function writeStoredFilters(pageKey, value) {
  try {
    if (typeof localStorage === "undefined") return false;
    localStorage.setItem(FILTER_PREFIX + pageKey, JSON.stringify(value ?? {}));
    return true;
  } catch {
    return false;
  }
}

export function clearStoredFilters(pageKey) {
  try {
    if (typeof localStorage !== "undefined") localStorage.removeItem(FILTER_PREFIX + pageKey);
  } catch { /* nothing to do — a failed clear leaves the old preference, not a broken page */ }
}

// ─── Active-filter summary ───────────────────────────────────────────────────
/**
 * Human-readable description of what is currently being excluded, e.g.
 *   ["Aug 1 – Aug 20", "2 properties", "search “refund”"]
 *
 * The point is not decoration. The failure this prevents is an owner reading a
 * filtered total as a portfolio total — the same class of mistake as an empty
 * table that means "read failed". If a filter is on, it has to be visible
 * without opening a menu.
 */
export function describeFilters(parts) {
  return Object.entries(parts || {})
    .filter(([, v]) => v !== null && v !== undefined && v !== "" && v !== false)
    .map(([label, v]) => (v === true ? label : `${label}: ${v}`));
}

/** "Aug 1 – Aug 20, 2026", or "Aug 20, 2026" when both ends are the same day. */
export function describeRange(from, to) {
  if (!from && !to) return null;
  const fmt = (key, withYear) => {
    if (!key) return null;
    const [y, m, d] = key.split("-").map(Number);
    const date = new Date(y, m - 1, d);
    return date.toLocaleDateString(undefined, withYear
      ? { month: "short", day: "numeric", year: "numeric" }
      : { month: "short", day: "numeric" });
  };
  if (from && to && from === to) return fmt(from, true);
  if (from && to) {
    const sameYear = from.slice(0, 4) === to.slice(0, 4);
    return `${fmt(from, !sameYear)} – ${fmt(to, true)}`;
  }
  return from ? `from ${fmt(from, true)}` : `until ${fmt(to, true)}`;
}
