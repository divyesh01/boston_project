// Parsing for the Manual Data Entry grid (src/pages/ManualEntry.jsx).
//
// Extracted from the page so it can be probed headlessly
// (scripts/probe-manual-entry-import.mjs). The page previously parsed uploaded
// files inline with `text.split("\n")` + `line.split(",")` — the only naive split
// left on a live import path. What went wrong with it, all silently:
//
//   * a quoted field containing a comma ("Smith, John") shifted every later column
//   * a quoted field containing a newline tore one row into two
//   * a file exported for a different report imported as a full row of zeros,
//     because an unmatched numeric column defaulted to 0 rather than reporting
//   * the paste path never trimmed, so CRLF clipboard content kept a trailing \r
//     and a leading BOM stayed glued to the first cell
//
// Not a defect, for the record: a BOM did not break the *upload* path. The legacy
// code trimmed each header and String.trim() removes U+FEFF. Probe section 0 pins
// this so the earlier, incorrect note is not reintroduced.
//
// The rule here is that nothing is ever silently defaulted. Every column that
// could not be matched, and every cell that could not be read, comes back in
// `warnings` for the page to show.

import { parseCsvText, parseAmount, convertDate } from '@/lib/csvParser';

// "Total Rev", "total_revenue" and "TOTAL-REVENUE" all reduce to the same token,
// so a file exported from this app (headers are field keys) and one typed by hand
// (headers are the visible labels) both match.
function normalizeHeader(h) {
  return String(h ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// A field is addressable by its key or by the column label shown in the grid.
function headerAliases(field) {
  return [normalizeHeader(field.key), normalizeHeader(field.label)].filter(Boolean);
}

// One cell -> the value the grid stores. Numbers go through parseAmount so
// "$1,234.56" and "(50.00)" read correctly instead of failing Number() at save
// time; dates go through convertDate so "04/01/2026" normalises to ISO.
//
// An unreadable cell becomes "" (blank), never 0. A fake zero is indistinguishable
// from a real one on the dashboard; a blank is visibly missing and the paired
// warning says why.
function coerceCell(raw, field) {
  const val = String(raw ?? '').trim();
  if (!val) return { value: '' };
  if (field.type === 'number') {
    const n = parseAmount(val);
    if (n === null) return { value: '', problem: `"${val}" is not a number` };
    return { value: n };
  }
  if (field.type === 'date') {
    const iso = convertDate(val);
    if (!/^\d{4}-\d{2}-\d{2}/.test(iso)) return { value: val, problem: `"${val}" is not a recognisable date` };
    return { value: iso.slice(0, 10) };
  }
  return { value: val };
}

function pushProblem(warnings, problem, rowNumber) {
  if (!problem) return;
  warnings.push(`Row ${rowNumber}: ${problem}`);
}

/**
 * Parse an uploaded CSV into grid rows, matching columns by header name.
 *
 * @param {string} text     raw file contents
 * @param {Array<{key: string, label: string, type: string}>} fields  the active report's columns
 * @returns {{ rows: object[], warnings: string[], error: string|null, matched: string[], unmatched: string[], ignored: string[] }}
 *          `error` non-null means nothing was imported and the caller must say so.
 */
export function parseManualEntryCsv(text, fields = []) {
  const warnings = [];
  const table = parseCsvText(text).filter((r) => r.some((c) => String(c ?? '').trim() !== ''));
  if (!table.length) {
    return { rows: [], warnings, error: 'That file has no readable rows.', matched: [], unmatched: [], ignored: [] };
  }

  const headers = table[0].map((h) => String(h ?? '').trim());
  const headerIndex = new Map();
  headers.forEach((h, i) => {
    const k = normalizeHeader(h);
    // First occurrence wins, so a duplicated column cannot quietly overwrite the
    // value the user can see in the leftmost matching column.
    if (k && !headerIndex.has(k)) headerIndex.set(k, i);
  });

  const columnFor = new Map();
  const matched = [];
  const unmatched = [];
  for (const f of fields) {
    const hit = headerAliases(f).find((a) => headerIndex.has(a));
    if (hit === undefined) unmatched.push(f.label);
    else {
      columnFor.set(f.key, headerIndex.get(hit));
      matched.push(f.label);
    }
  }

  if (!matched.length) {
    return {
      rows: [],
      warnings,
      error: `None of the columns in that file match this report. Expected headers like: ${fields.slice(0, 4).map((f) => f.key).join(', ')}.`,
      matched, unmatched, ignored: headers,
    };
  }

  const claimed = new Set(columnFor.values());
  const ignored = headers.filter((h, i) => !claimed.has(i) && h !== '');

  const rows = [];
  table.slice(1).forEach((cells, i) => {
    const rowNumber = i + 2; // 1-based, and row 1 is the header
    const row = {};
    let anyValue = false;
    for (const f of fields) {
      if (!columnFor.has(f.key)) { row[f.key] = ''; continue; }
      const { value, problem } = coerceCell(cells[columnFor.get(f.key)], f);
      pushProblem(warnings, problem, rowNumber);
      row[f.key] = value;
      if (value !== '') anyValue = true;
    }
    if (!anyValue) return; // a row that produced nothing is not a row
    row._isNew = true;
    rows.push(row);
  });

  if (unmatched.length) {
    warnings.push(`Left blank — no matching column in the file: ${unmatched.join(', ')}.`);
  }
  if (ignored.length) {
    warnings.push(`Ignored column${ignored.length === 1 ? '' : 's'} in the file: ${ignored.join(', ')}.`);
  }
  if (!rows.length) {
    return { rows, warnings, error: 'That file has a header row but no data rows.', matched, unmatched, ignored };
  }
  return { rows, warnings, error: null, matched, unmatched, ignored };
}

/**
 * Parse clipboard text (a block copied out of Excel or Sheets) into grid rows.
 *
 * Tab-delimited and positional: cell 1 goes to field 1. If the first line looks
 * like a header row it is dropped, so pasting a block that includes its headings
 * does not create a junk row of column names.
 *
 * @returns {{ rows: object[], warnings: string[], error: string|null }}
 */
export function parseManualEntryPaste(text, fields = []) {
  const warnings = [];
  // Normalise CRLF and lone CR first: splitting on "\n" alone left a trailing \r
  // on the last cell of every row, which survives into text fields and breaks the
  // dedupe key comparison at save time.
  const lines = String(text ?? '')
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((l) => l.trim() !== '');
  if (!lines.length) return { rows: [], warnings, error: 'Nothing to paste.' };

  const aliases = new Set(fields.flatMap(headerAliases));
  const firstCells = lines[0].split('\t').map((c) => c.trim());
  const looksLikeHeader = firstCells.length > 1
    && firstCells.filter((c) => c && aliases.has(normalizeHeader(c))).length >= Math.min(2, firstCells.length);
  const body = looksLikeHeader ? lines.slice(1) : lines;
  if (looksLikeHeader) warnings.push('Skipped the pasted header row.');

  const rows = [];
  body.forEach((line, i) => {
    const cells = line.split('\t');
    const rowNumber = i + 1 + (looksLikeHeader ? 1 : 0);
    const row = {};
    let anyValue = false;
    fields.forEach((f, idx) => {
      const { value, problem } = coerceCell(cells[idx], f);
      pushProblem(warnings, problem, rowNumber);
      row[f.key] = value;
      if (value !== '') anyValue = true;
    });
    if (!anyValue) return;
    row._isNew = true;
    rows.push(row);
  });

  if (!rows.length) return { rows, warnings, error: 'Nothing in that paste could be read as data.' };
  return { rows, warnings, error: null };
}
