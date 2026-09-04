// Transaction-ledger scanner, extracted verbatim from reportParsers.js.
//
// The All Transactions export is the single most financially load-bearing input in
// the system: it is where revenue enters. It moved out of the 1,839-line parser as
// one whole behaviour family — the section splitter, the file-identity hash and the
// scanner that consumes both — so the family's own invariants stay readable next to
// each other instead of buried mid-file.
//
// Guarded by src/lib/hotelKeyParserFixtures.test.js and by mutations M7 and M8 in
// scripts/probe-hotelkey-mutations.mjs, which resolve their anchors across both this
// module and reportParsers.js so the net followed the family across this move.

import { isIsoDate } from "@/lib/csvParser";
import { generateFileHash } from "@/lib/universalParser";
import {
  TXN_SIGNATURE, TXN_COLUMN_MAP, mapTransactionRow, isTrailerRow,
} from "@/lib/transactionNorm";
import { toCents, fromCents, sumCents } from "@/lib/decimal";
import { validateImport, makeFinding, SEVERITY } from "@/lib/importValidation";

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

export async function scanTransactions(rawRows, meta) {
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
