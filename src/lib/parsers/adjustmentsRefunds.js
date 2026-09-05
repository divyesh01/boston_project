// Adjustments / refunds scanner, extracted verbatim from reportParsers.js.
//
// It moved as one whole behaviour family: `scanAdjustmentsRefunds` is the entire
// family. Every helper it uses -- headerIndex, isTotalsLine, totalsValue, has and
// both `cell` accessors -- is declared inside the function body, so it references
// no constant or helper defined elsewhere in reportParsers.js and nothing had to
// be split or duplicated to move it.
//
// Unlike the two families that moved before it, this one was already exported, so
// the moved bytes needed no change at all -- not even an added `export` keyword.
// reportParsers.js keeps a re-export because scripts/probe-adjustments.mjs
// destructures the name from a dynamic import of that module.
//
// Guarded by scripts/probe-adjustments.mjs (44 assertions driven against a real
// CSV fixture through this scanner directly) and by scripts/verify-coexistence.mjs.
//
// No mutation in scripts/probe-hotelkey-mutations.mjs anchors inside this family.
// The net's only refund-side coverage is M11 on transactionNorm.js's ledger_side
// classification, which is a different code path; the harness's 11 anchors all
// resolve elsewhere and needed no change for this move.

import { convertDate, isIsoDate, parseAmount } from "@/lib/csvParser";

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
