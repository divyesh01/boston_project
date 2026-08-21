// The audit log's view logic: property bucketing, sorting, and the export column
// set. Pure functions, deliberately OUTSIDE src/pages/AuditLog.jsx.
//
// WHY THESE LIVE HERE AND NOT IN THE PAGE
// ─────────────────────────────────────────────────────────────────────────────
// They started as inline helpers inside the component. Nothing was wrong with
// them as code, but nothing could test them either: a probe cannot reach a
// closure inside a React component without rendering the component, and
// rendering this one drags in @tanstack/react-virtual, the toast provider and
// base44Client. The alternative — a probe that re-implements the same bucketing
// and asserts its own copy — is the exact defect this repo keeps finding
// (scripts/probe-session-sliding.mjs used to declare its own touchSession and
// test that). Moving the pure parts out is what makes the assertion in
// scripts/probe-audit-export.mjs an assertion about the product.
//
// BEST OUTCOME NOTE (2026-08-20): extracting these is better than adding a
// rendering harness. The functions are pure, they have no React dependency, and
// two of them (property bucketing, export columns) are the ones a future change
// is most likely to get wrong silently — a new field on an audit row that never
// reaches the CSV, or a property chip whose count disagrees with the rows it
// shows.

import { auditActionSeverity } from "@/lib/auditFilter";
import { toLocalDayKey } from "@/lib/exportData";

/**
 * Bucket key for rows that carry no property_id.
 *
 * Rows with no property are given an explicit bucket rather than being dropped
 * from the filter UI. If they were dropped they would be reachable only through
 * "All", so the per-chip counts would not sum to the total and an owner could not
 * tell whether a row was missing or merely unscoped. Double-underscored so it
 * cannot be mistaken for a real id — ids arrive from the database and from CSV
 * imports, where "none", "(none)" and "-" are all values a human could type.
 */
export const NO_PROPERTY = "__no_property__";

/** Normalised property bucket for one row. Empty string counts as absent. */
export function propertyKeyOf(row) {
  const raw = row?.property_id;
  if (raw === undefined || raw === null || raw === "") return NO_PROPERTY;
  return String(raw);
}

/**
 * [{ id, label, count }, ...] for the chip row: busiest property first, with the
 * unscoped bucket forced last because it is a data-quality bucket, not a place.
 *
 * `label` is the property_name carried on the rows themselves, falling back to
 * the id. Deriving it here rather than joining against the Property entity is
 * deliberate: this page already holds the rows, a second read would make the
 * chips depend on a fetch that can fail independently of the log, and a chip
 * reading "prop_2" is a filter an owner cannot use — the id is a database
 * detail, the hotel's name is the thing they recognise. The FIRST non-empty
 * name wins, and rows arrive newest-first, so a renamed property shows its
 * current name rather than whatever it was called in the oldest row.
 */
export function groupPropertyCounts(rows) {
  const counts = new Map();
  const labels = new Map();
  for (const row of rows || []) {
    const key = propertyKeyOf(row);
    counts.set(key, (counts.get(key) || 0) + 1);
    if (key !== NO_PROPERTY && !labels.has(key)) {
      const name = row?.property_name;
      if (name !== undefined && name !== null && String(name).trim() !== "") {
        labels.set(key, String(name).trim());
      }
    }
  }
  return [...counts.entries()]
    .map(([id, count]) => ({ id, label: labels.get(id) || id, count }))
    .sort((a, b) => {
      if (a.id === NO_PROPERTY) return 1;
      if (b.id === NO_PROPERTY) return -1;
      if (b.count !== a.count) return b.count - a.count;
      // Alphabetical by the DISPLAYED text within an equal count, so the chip
      // order is both stable between loads (rather than following Map insertion
      // order, i.e. whatever order the server happened to return) and matches
      // what an owner scanning the row actually reads.
      return a.label.localeCompare(b.label);
    });
}

/** Rows in the selected property bucket. `"all"` means no property filter. */
export function filterByProperty(rows, property) {
  if (!property || property === "all") return rows;
  return rows.filter((row) => propertyKeyOf(row) === property);
}

/** Rows with the selected result. `"all"` means no result filter. */
export function filterByResult(rows, result) {
  if (!result || result === "all") return rows;
  return rows.filter((row) => (row?.result || "unknown") === result);
}

// Sort accessors. Every one coerces, because an audit row may be missing any
// field: comparing undefined with < silently returns false in both directions,
// which makes a sort non-deterministic rather than merely wrong.
export const AUDIT_SORT_KEYS = {
  created_date: (l) => l?.created_date || "",
  username: (l) => String(l?.username || "").toLowerCase(),
  action: (l) => String(l?.action || "").toLowerCase(),
  performed_by: (l) => String(l?.performed_by || "").toLowerCase(),
  device: (l) => String(l?.device || "").toLowerCase(),
  result: (l) => String(l?.result || "unknown").toLowerCase(),
};

/**
 * Sort a copy. Never sorts in place: the caller's array is memoised upstream and
 * mutating it would corrupt the inputs of the memos keyed on it.
 *
 * Ties break on created_date descending, so rows with an equal sort key keep a
 * deterministic order between renders instead of shuffling.
 */
export function sortAuditLogs(rows, { key = "created_date", dir = "desc" } = {}) {
  const get = AUDIT_SORT_KEYS[key] || AUDIT_SORT_KEYS.created_date;
  const sign = dir === "asc" ? 1 : -1;
  return [...(rows || [])].sort((a, b) => {
    const av = get(a);
    const bv = get(b);
    if (av < bv) return -1 * sign;
    if (av > bv) return 1 * sign;
    return String(b?.created_date || "").localeCompare(String(a?.created_date || ""));
  });
}

/**
 * Every field src/lib/auditLogger.js writes, plus the two the database adds
 * (`id`, `created_date`). Declared here so scripts/probe-audit-export.mjs can
 * assert the export covers all of them: a field added to the writer and forgotten
 * in the export produces a CSV that is missing evidence, with nothing on screen to
 * say so.
 *
 * That is not hypothetical — writing this list against the actual
 * `db.audit.log({...})` call in src/lib/auditLogger.js#logAuditEvent is what found
 * `user_id` and `property_name` missing from the export below. `property_name`
 * mattered most: an export scoped to one property that identifies it only as
 * "prop_2" is not evidence anyone outside the app can read.
 */
export const AUDIT_ROW_FIELDS = [
  "id",
  "created_date",
  "action",
  "user_id",
  "username",
  "performed_by",
  "performed_by_id",
  "ip_address",
  "device",
  "property_id",
  "property_name",
  "result",
  "detail",
  "previous_hash",
  "hash",
];

/**
 * Export columns, in the order an auditor reads them.
 *
 * Explicit rather than "every key on the first row": audit rows are
 * heterogeneous (server-side events carry no device, most logins carry no
 * detail), and a first-row-derived column list silently drops those columns for
 * every row that had them.
 *
 * The timestamp appears four ways on purpose. A spreadsheet cannot recover a
 * local date from an ISO string without a formula, and an auditor cannot recover
 * the true instant from a localised string. Both are cheap; being unable to
 * reconcile the file against the screen is not.
 *
 * previous_hash and hash are included deliberately: this file is the artefact
 * handed to an auditor or a lender, and without the hash pair the chain cannot be
 * re-verified outside the app, which would make the export a claim rather than
 * evidence.
 */
export const AUDIT_EXPORT_COLUMNS = [
  { key: "created_date", label: "Timestamp (local)", format: (v) => (v ? new Date(v).toLocaleString() : "") },
  { key: "created_date", label: "Date", format: (v) => toLocalDayKey(v) || "" },
  { key: "created_date", label: "Time (local)", format: (v) => (v ? new Date(v).toLocaleTimeString() : "") },
  { key: "created_date", label: "Timestamp (UTC ISO)", format: (v) => (v ? new Date(v).toISOString() : "") },
  { key: "username", label: "User" },
  { key: "action", label: "Action" },
  { key: "action", label: "Severity", format: (v) => auditActionSeverity(v) },
  { key: "result", label: "Result", format: (v) => v || "unknown" },
  { key: "performed_by", label: "Performed By" },
  { key: "performed_by_id", label: "Performed By (id)" },
  { key: "device", label: "Device" },
  { key: "ip_address", label: "IP Address" },
  // Name first, id second: the name is what the reader recognises, the id is what
  // reconciles against the database.
  { key: "property_name", label: "Property" },
  { key: "property_id", label: "Property (id)" },
  { key: "detail", label: "Detail" },
  { key: "id", label: "Event ID" },
  { key: "user_id", label: "Subject User (id)" },
  { key: "previous_hash", label: "Previous Hash" },
  { key: "hash", label: "Hash" },
];
