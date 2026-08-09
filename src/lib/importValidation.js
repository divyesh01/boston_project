// Deterministic validation for report imports.
//
// The import path was built to never fail: unparseable numbers became 0,
// unknown columns were dropped, short rows were padded with "". Every one of
// those choices turns a broken file into plausible-looking data, which is worse
// than a rejected file — a hotel that reports $0 revenue looks like a bad night,
// not a bad import.
//
// This module only *describes* what it finds. It does not mutate rows or throw.
// The caller decides what blocks an import, so the same findings can be shown in
// the scan preview before anything is written.
//
// Four layers, cheapest and most fundamental first. A file that fails
// structurally produces nonsense at every later layer, so callers should show
// the earliest non-empty layer rather than a wall of downstream noise.
//
//   structural — is this the right shape of file at all?
//   type       — did individual values survive conversion?
//   constraint — are values inside their own field's legal range?
//   semantic   — do the values agree with each other and with reality?

// Severity drives UI treatment and gating.
//   error   — near-certain data corruption; import is blocked unless forced.
//   warning — suspicious but legitimately possible; import proceeds.
//   info    — worth showing, never alarming.
export const SEVERITY = { ERROR: "error", WARNING: "warning", INFO: "info" };

function finding(layer, severity, code, message, detail = {}) {
  return { layer, severity, code, message, ...detail };
}

// Columns that must be present for a type's rows to mean anything. Absence is
// structural: the file is probably not the report the user thinks it is.
//
// `oneOf` groups alternatives — occupancy can be expressed as a ratio or
// derived from room counts, and either is fine, but neither is not.
const REQUIRED_FIELDS = {
  occupancy: {
    all: ["date"],
    oneOf: [["occupancy", "rooms_sold"]],
  },
  source: { all: ["date"], oneOf: [] },
  gross: { all: ["date"], oneOf: [] },
  payments: { all: ["date"], oneOf: [] },
};

// Upper bounds that indicate a unit error rather than an unusual day. These are
// deliberately loose: the aim is to catch a percentage stored as a ratio or a
// cents value stored as dollars, not to second-guess a good night.
const FIELD_RANGES = {
  occupancy: { min: 0, max: 1, unit: "ratio (0-1)" },
  adr: { min: 0, max: 10000, unit: "dollars" },
  revpar: { min: 0, max: 10000, unit: "dollars" },
  rooms_sold: { min: 0, max: 10000, unit: "rooms" },
  total_rooms: { min: 0, max: 10000, unit: "rooms" },
};

// Fields where a negative value is a real, expected occurrence rather than a
// sign error — refunds, adjustments and corrections all post negative.
const NEGATIVE_OK = new Set([
  "amount", "net_today", "adjusted", "actual", "total",
  "loyalty_discount", "non_revenue",
]);

// ── Layer 1: structural ────────────────────────────────────────────────────
//
// Operates on the raw grid, before any column mapping, because mapping is
// exactly where structural damage becomes invisible.
export function validateStructure({ rawRows = [], rows = [], type, knownColumns }) {
  const out = [];

  if (!rawRows.length) {
    out.push(finding("structural", SEVERITY.ERROR, "empty_file",
      "The file contains no rows at all."));
    return out;
  }

  const header = rawRows[0] || [];
  const headerWidth = header.length;

  if (headerWidth === 0) {
    out.push(finding("structural", SEVERITY.ERROR, "no_header",
      "The first row is blank, so no column names could be read."));
    return out;
  }

  // Ragged rows. Short rows silently gain empty cells and long rows silently
  // lose their tail, so without this the damage never surfaces.
  //
  // Blank rows are excluded: they are section delimiters in these exports, not
  // malformed data.
  let short = 0;
  let long = 0;
  for (let i = 1; i < rawRows.length; i++) {
    const r = rawRows[i];
    if (!r || r.length === 0) continue;
    if (r.every((c) => String(c ?? "").trim() === "")) continue;
    if (r.length < headerWidth) short++;
    else if (r.length > headerWidth) long++;
  }
  // Stacked-section files (the clerk report) legitimately mix widths, so this is
  // a warning everywhere rather than an error that would reject a valid file.
  if (short) {
    out.push(finding("structural", SEVERITY.WARNING, "short_rows",
      `${short} row(s) have fewer cells than the header; the missing fields were read as empty.`,
      { count: short }));
  }
  if (long) {
    out.push(finding("structural", SEVERITY.WARNING, "long_rows",
      `${long} row(s) have more cells than the header; the extra values were discarded.`,
      { count: long }));
  }

  // Unrecognised column names. A PMS that renames a column ships a file that
  // still imports, minus one field — this is how a metric quietly becomes 0.
  if (knownColumns) {
    const unknown = header
      .map((h) => String(h ?? "").trim())
      .filter((h) => h && !knownColumns.has(h));
    if (unknown.length) {
      out.push(finding("structural", SEVERITY.WARNING, "unknown_columns",
        `${unknown.length} column(s) were not recognised and will not be imported: ${unknown.slice(0, 8).join(", ")}${unknown.length > 8 ? "…" : ""}.`,
        { columns: unknown }));
    }
  }

  // Required fields are checked against mapped rows, not headers, because a
  // field can arrive under several different header spellings.
  const req = REQUIRED_FIELDS[type];
  if (req && rows.length) {
    const present = new Set();
    // A field counts as present if any row carries it — some exports leave the
    // first rows blank.
    for (const r of rows) {
      for (const k of Object.keys(r)) {
        if (r[k] !== "" && r[k] !== null && r[k] !== undefined) present.add(k);
      }
    }
    for (const f of req.all) {
      if (!present.has(f)) {
        out.push(finding("structural", SEVERITY.ERROR, "missing_required_column",
          `No "${f}" column was found. This may not be a ${type} report.`,
          { field: f }));
      }
    }
    for (const group of req.oneOf) {
      if (!group.some((f) => present.has(f))) {
        out.push(finding("structural", SEVERITY.ERROR, "missing_required_column",
          `None of these columns were found: ${group.join(", ")}. At least one is needed for a ${type} report.`,
          { fields: group }));
      }
    }
  }

  if (!rows.length) {
    out.push(finding("structural", SEVERITY.ERROR, "no_data_rows",
      "The file has column names but no readable data rows."));
  }

  return out;
}

// ── Layer 2: type ──────────────────────────────────────────────────────────
//
// Takes the coercion log built during mapping. This cannot be recomputed after
// the fact: once "N/A" has become 0 it is indistinguishable from a real zero,
// which is the whole reason the log exists.
export function validateTypes({ coercions = [], dateFailures = 0, totalRows = 0 }) {
  const out = [];

  if (dateFailures) {
    // Rows without a usable date are dropped entirely, so this is loss, not noise.
    const severity = dateFailures >= totalRows && totalRows > 0
      ? SEVERITY.ERROR
      : SEVERITY.WARNING;
    out.push(finding("type", severity, "unparseable_dates",
      `${dateFailures} row(s) had a date that could not be read and were skipped.`,
      { count: dateFailures }));
  }

  if (!coercions.length) return out;

  // Group by field so the message names the column an operator can go look at,
  // rather than listing hundreds of individual cells.
  const byField = new Map();
  for (const c of coercions) {
    if (!byField.has(c.field)) byField.set(c.field, []);
    byField.get(c.field).push(c);
  }

  for (const [field, list] of byField) {
    const samples = [...new Set(list.map((c) => c.raw))].slice(0, 5);
    const truncating = list.filter((c) => c.kind === "truncated");
    const blanked = list.filter((c) => c.kind === "unparseable");

    if (blanked.length) {
      out.push(finding("type", SEVERITY.WARNING, "unparseable_numbers",
        `"${field}": ${blanked.length} value(s) could not be read as a number and were treated as 0 — e.g. ${samples.map((s) => JSON.stringify(s)).join(", ")}.`,
        { field, count: blanked.length, samples }));
    }
    // Partial parses are more dangerous than total failures: "12abc" becomes 12,
    // a number that looks entirely legitimate downstream.
    if (truncating.length) {
      out.push(finding("type", SEVERITY.ERROR, "truncated_numbers",
        `"${field}": ${truncating.length} value(s) were only partly numeric and were silently truncated — e.g. ${truncating.slice(0, 5).map((c) => `${JSON.stringify(c.raw)}→${c.parsed}`).join(", ")}.`,
        { field, count: truncating.length }));
    }
  }

  return out;
}

// ── Layer 3: constraint ────────────────────────────────────────────────────
//
// Per-field legality, independent of any other row.
export function validateConstraints({ rows = [], type }) {
  const out = [];
  if (!rows.length) return out;

  const violations = new Map();
  const noteViolation = (key, row, extra) => {
    if (!violations.has(key)) violations.set(key, []);
    violations.get(key).push({ date: row.date, ...extra });
  };

  for (const r of rows) {
    for (const [field, range] of Object.entries(FIELD_RANGES)) {
      const v = r[field];
      if (v === undefined || v === null || v === "") continue;
      const n = Number(v);
      if (!Number.isFinite(n)) continue;
      if (n < range.min || n > range.max) {
        noteViolation(`range:${field}`, r, { value: n, range });
      }
    }

    for (const [field, v] of Object.entries(r)) {
      if (typeof v !== "number" || NEGATIVE_OK.has(field)) continue;
      if (field.startsWith("_")) continue;
      if (v < 0) noteViolation(`negative:${field}`, r, { value: v });
    }
  }

  for (const [key, list] of violations) {
    const [kind, field] = key.split(":");
    const sample = list[0];
    if (kind === "range") {
      const range = sample.range;
      // The classic case: occupancy stored as a percentage. Naming the likely
      // cause turns an opaque rejection into something an operator can act on.
      const looksLikePercent = field === "occupancy" && list.every((v) => v.value > 1 && v.value <= 100);
      out.push(finding("constraint", SEVERITY.ERROR, "out_of_range",
        looksLikePercent
          ? `"occupancy": ${list.length} value(s) are above 1 — this file appears to store occupancy as a percentage (e.g. ${sample.value}) rather than a ratio.`
          : `"${field}": ${list.length} value(s) fall outside the expected ${range.unit} range ${range.min}–${range.max} — e.g. ${sample.value}${sample.date ? ` on ${sample.date}` : ""}.`,
        { field, count: list.length }));
    } else {
      out.push(finding("constraint", SEVERITY.WARNING, "unexpected_negative",
        `"${field}": ${list.length} negative value(s) — e.g. ${sample.value}${sample.date ? ` on ${sample.date}` : ""}.`,
        { field, count: list.length }));
    }
  }

  return out;
}

// ── Layer 4: semantic ──────────────────────────────────────────────────────
//
// Cross-field and cross-row agreement. These are the checks that catch a file
// that is individually valid everywhere and collectively impossible.
export function validateSemantics({ rows = [], type, today = new Date() }) {
  const out = [];
  if (!rows.length) return out;

  const dated = rows.filter((r) => r.date);

  // Future dates. A PMS export describing nights that have not happened yet is
  // almost always a wrong-year parse (a two-digit year read as the wrong century).
  const todayIso = today.toISOString().slice(0, 10);
  const future = dated.filter((r) => r.date > todayIso);
  if (future.length) {
    out.push(finding("semantic", SEVERITY.WARNING, "future_dates",
      `${future.length} row(s) are dated in the future — e.g. ${future[0].date}. Check the file's date format.`,
      { count: future.length, sample: future[0].date }));
  }

  // Implausibly old dates catch the same failure in the other direction.
  const ancient = dated.filter((r) => r.date < "2000-01-01");
  if (ancient.length) {
    out.push(finding("semantic", SEVERITY.WARNING, "implausible_dates",
      `${ancient.length} row(s) are dated before 2000 — e.g. ${ancient[0].date}.`,
      { count: ancient.length, sample: ancient[0].date }));
  }

  // Duplicate dates within a single file. For daily reports this means the file
  // contains the same day twice, which double-counts revenue on import.
  if (type === "occupancy" || type === "gross" || type === "payments") {
    const seen = new Map();
    for (const r of dated) seen.set(r.date, (seen.get(r.date) || 0) + 1);
    const dupes = [...seen.entries()].filter(([, n]) => n > 1);
    if (dupes.length) {
      out.push(finding("semantic", SEVERITY.WARNING, "duplicate_dates",
        `${dupes.length} date(s) appear more than once in this file — e.g. ${dupes[0][0]} (${dupes[0][1]}×).`,
        { count: dupes.length, sample: dupes[0][0] }));
    }
  }

  // Rooms sold cannot exceed the rooms that exist.
  const oversold = rows.filter((r) => {
    const sold = Number(r.rooms_sold);
    const total = Number(r.total_rooms);
    return Number.isFinite(sold) && Number.isFinite(total) && total > 0 && sold > total;
  });
  if (oversold.length) {
    out.push(finding("semantic", SEVERITY.ERROR, "rooms_exceed_inventory",
      `${oversold.length} row(s) sell more rooms than the hotel has — e.g. ${oversold[0].rooms_sold} of ${oversold[0].total_rooms} on ${oversold[0].date}.`,
      { count: oversold.length }));
  }

  // Revenue without occupancy, and vice versa. Either alone is usually a column
  // that failed to map rather than a genuine zero.
  const revenueField = { occupancy: "total_revenue", gross: "room_rent", payments: "total" }[type];
  if (revenueField) {
    const soldNoRevenue = rows.filter((r) =>
      Number(r.rooms_sold) > 0 && Number(r[revenueField] || 0) === 0);
    if (soldNoRevenue.length) {
      out.push(finding("semantic", SEVERITY.WARNING, "rooms_without_revenue",
        `${soldNoRevenue.length} row(s) sold rooms but recorded no ${revenueField.replace(/_/g, " ")} — e.g. ${soldNoRevenue[0].date}.`,
        { count: soldNoRevenue.length }));
    }
  }

  return out;
}

// ── Orchestration ──────────────────────────────────────────────────────────
//
// Runs every layer and returns the findings plus a decision. Layers all run even
// when an earlier one fails, so the preview can show the full picture — but
// `firstFailingLayer` lets the UI lead with the root cause instead of the noise
// it cascades into.
export function validateImport({
  rawRows = [],
  rows = [],
  type,
  knownColumns,
  coercions = [],
  dateFailures = 0,
  today,
} = {}) {
  const findings = [
    ...validateStructure({ rawRows, rows, type, knownColumns }),
    ...validateTypes({ coercions, dateFailures, totalRows: rows.length + dateFailures }),
    ...validateConstraints({ rows, type }),
    ...validateSemantics({ rows, type, ...(today ? { today } : {}) }),
  ];

  const errors = findings.filter((f) => f.severity === SEVERITY.ERROR);
  const warnings = findings.filter((f) => f.severity === SEVERITY.WARNING);
  const order = ["structural", "type", "constraint", "semantic"];

  return {
    findings,
    errors,
    warnings,
    // The caller decides what to do with this; nothing here blocks by itself.
    ok: errors.length === 0,
    firstFailingLayer: order.find((l) => errors.some((f) => f.layer === l)) || null,
    summary: errors.length
      ? `${errors.length} problem(s) that will corrupt imported data`
      : warnings.length
        ? `${warnings.length} thing(s) worth checking`
        : "No problems found",
  };
}
