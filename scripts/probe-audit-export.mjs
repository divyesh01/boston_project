// Probe: the audit log's view + export logic (src/lib/auditView.js).
//
// Run: node --import ./scripts/_loader-boot.mjs scripts/probe-audit-export.mjs
//
// WHAT THIS IS DEFENDING
// ─────────────────────────────────────────────────────────────────────────────
// The audit log is the one page whose output is handed to somebody outside the
// company — an auditor, a lender, an insurer, a lawyer. Every failure below is
// silent by construction, which is why it is asserted rather than eyeballed:
//
//   * A chip that says "Middleborough (41)" and then renders 60 rows. The count
//     and the filter must come from the same predicate or the number is a lie.
//   * A row with no property_id vanishing from the filter UI, so it is reachable
//     only through "All" and nobody can tell whether it is missing or unscoped.
//   * A field added to src/lib/auditLogger.js and forgotten in the export, so the
//     CSV is missing evidence with nothing on screen to say so. (This probe's
//     coverage assertion is what found `user_id` and `property_name` missing.)
//   * A sort that mutates the array React memoised, corrupting every memo keyed
//     on it.
//   * A sort that is non-deterministic on ties, so the same filters produce a
//     different row order — and therefore a different CSV — on each render.
//   * The hash pair dropped from the export, which turns the file from evidence
//     into a claim: the chain cannot be re-verified outside the app without it.
//
// WHY IT IMPORTS THE PRODUCT
// ─────────────────────────────────────────────────────────────────────────────
// Everything asserted here is imported from src/lib/auditView.js. Nothing is
// re-implemented. That is the whole reason those functions were moved out of the
// component: a probe that declares its own bucketing and then agrees with itself
// is the defect this repo keeps finding (scripts/probe-session-sliding.mjs used
// to declare its own touchSession and test that), and it passes forever while the
// product is broken.
//
// BEST OUTCOME NOTE (2026-08-20): the export-coverage assertion below is written
// against AUDIT_ROW_FIELDS, which is itself a hand-maintained list — so on its own
// it could drift from auditLogger.js. Section 6 therefore also reads
// src/lib/auditLogger.js as TEXT and extracts the keys of the db.audit.log({...})
// object literal, so the list is checked against the actual writer. A regex over
// source is normally a poor way to assert anything; here it is the only way to
// compare the export against the writer without executing a module that imports
// the protected base44Client, and the failure mode it prevents (evidence silently
// absent from an auditor's file) is worth the fragility. If auditLogger.js is
// restructured so the extraction stops finding fields, the assertion FAILS rather
// than passing vacuously.

process.env.TZ = process.env.TZ || "America/New_York";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

let pass = 0;
let fail = 0;
const failures = [];
const T = (name, cond, detail = "") => {
  let ok = false;
  let thrown = "";
  try {
    ok = typeof cond === "function" ? !!cond() : !!cond;
  } catch (err) {
    thrown = ` threw ${err?.name}: ${err?.message}`;
  }
  if (ok) { pass++; } else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ""}${thrown}`); }
};

// securityUtils (reached transitively via auditFilter -> sanitizeInput) touches
// crypto and localStorage at module scope.
if (!globalThis.crypto?.getRandomValues) {
  globalThis.crypto = {
    ...globalThis.crypto,
    getRandomValues: (a) => { for (let i = 0; i < a.length; i++) a[i] = (i * 7) % 256; return a; },
  };
}
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

// A REAL DOM, before any app module is imported.
//
// src/lib/securityUtils.js#sanitizeText calls DOMPurify.sanitize, and dompurify
// exports its factory (not an instance) when no `window` exists at import time —
// so under the plain-Node harness `DOMPurify.sanitize` is undefined and the first
// search assertion dies with "DOMPurify.sanitize is not a function".
//
// The tempting fix is a stub that returns its input. That would be wrong in the
// way this repo keeps finding: the search assertions below exist to prove a query
// still matches the text it was aimed at AFTER sanitisation, and a pass-through
// stub makes them prove nothing. jsdom is already a declared devDependency
// (package.json), so the real sanitiser can run — no new dependency, and the
// assertion is about the product.
//
// Only `window` is replaced. _loader-boot.mjs's `document`/`location` shims are
// left in place because axios and the base44 SDK are already keyed to them, and
// DOMPurify reads window.document rather than the global.
if (typeof globalThis.window?.document?.createElement !== "function") {
  let JSDOM;
  try {
    ({ JSDOM } = await import("jsdom"));
  } catch (err) {
    console.log("\nFATAL: jsdom could not be loaded, so the real DOMPurify-backed");
    console.log("sanitiser cannot run and the search assertions would be vacuous.");
    console.log("jsdom is a declared devDependency — run `npm install`.");
    console.log(`  ${err?.message}`);
    process.exit(1);
  }
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
  globalThis.window = dom.window;
}

const V = await import("../src/lib/auditView.js");
const X = await import("../src/lib/exportData.js");
const F = await import("../src/lib/auditFilter.js");

// Proves the sanitiser is the real one before anything relies on it. A
// pass-through stub would satisfy every search assertion below while silently
// removing the guarantee they exist to check.
const S = await import("../src/lib/securityUtils.js");

console.log("=".repeat(72));
console.log("AUDIT LOG VIEW + EXPORT — verification");
console.log("=".repeat(72));

console.log("\n=== 0. The sanitiser under test is the real one ===");
{
  T("sanitizeText strips a script tag rather than passing input through",
    S.sanitizeText("<script>alert(1)</script>ok") === "ok", JSON.stringify(S.sanitizeText("<script>alert(1)</script>ok")));
  T("and leaves an ordinary search term intact",
    S.sanitizeText("carl") === "carl", JSON.stringify(S.sanitizeText("carl")));
}

// A row set that carries every shape the real table has to survive: a clear
// busiest property, two properties TIED on count (so the label tiebreak is
// actually exercised rather than assumed), a property whose name is missing on
// one row, rows with no property at all, a row with no result, a row with no
// timestamp, and a detail field containing a comma, a quote, a newline and a
// leading "=".
const ROWS = [
  { id: "e1",  created_date: "2026-08-20T21:40:00.000Z", action: "Failed Login",       username: "amy",  property_id: "p1", property_name: "Middleborough", result: "failed",  device: "Chrome", ip_address: "10.0.0.1", performed_by: "amy",  performed_by_id: "u1", user_id: "u1", detail: 'tried 3x, "twice" from\nnew IP', previous_hash: "aaa", hash: "bbb" },
  { id: "e2",  created_date: "2026-08-20T13:00:00.000Z", action: "Login",              username: "bob",  property_id: "p1",                                 result: "success", device: "Safari", ip_address: "10.0.0.2", performed_by: "bob",  performed_by_id: "u2", user_id: "u2", detail: "",                              previous_hash: "bbb", hash: "ccc" },
  { id: "e3",  created_date: "2026-08-19T13:00:00.000Z", action: "User Created",        username: "carl", property_id: "p2", property_name: "Brockton",      result: "success", device: "",       ip_address: "10.0.0.3", performed_by: "amy",  performed_by_id: "u1", user_id: "u3", detail: "=cmd|' /c calc'!A1",            previous_hash: "ccc", hash: "ddd" },
  { id: "e4",  created_date: "2026-08-18T13:00:00.000Z", action: "Password Changed",    username: "carl", property_id: "p2", property_name: "Brockton",      result: "pending", device: "Edge",   ip_address: "10.0.0.4", performed_by: "carl", performed_by_id: "u3", user_id: "u3", detail: "self-service",                  previous_hash: "ddd", hash: "eee" },
  { id: "e5",  created_date: "2026-08-17T13:00:00.000Z", action: "Settings Changed",    username: "amy",                                                     result: "success", device: "Chrome", ip_address: "10.0.0.5", performed_by: "amy",  performed_by_id: "u1", user_id: "u1", detail: "commission rate, 15% -> 12%",   previous_hash: "eee", hash: "fff" },
  { id: "e6",  created_date: "2026-08-16T13:00:00.000Z", action: "Data Imported",       username: "amy",  property_id: "",                                   result: "success", device: "Chrome", ip_address: "10.0.0.6", performed_by: "amy",  performed_by_id: "u1", user_id: "u1", detail: "412 rows",                      previous_hash: "fff", hash: "ggg" },
  { id: "e7",  created_date: null,                        action: "Login",              username: "dana", property_id: "p3", property_name: "Taunton",       result: "",        device: "Firefox",ip_address: "10.0.0.7", performed_by: "dana", performed_by_id: "u4", user_id: "u4", detail: "no timestamp written",          previous_hash: "ggg", hash: "hhh" },
  { id: "e8",  created_date: "2026-08-15T13:00:00.000Z", action: "Data Imported",       username: "amy",  property_id: "p1", property_name: "Middleborough", result: "success", device: "Chrome", ip_address: "10.0.0.8", performed_by: "amy",  performed_by_id: "u1", user_id: "u1", detail: "1,204 rows",                    previous_hash: "hhh", hash: "iii" },
  { id: "e9",  created_date: "2026-08-14T13:00:00.000Z", action: "Settings Changed",    username: "erin", property_id: "p3", property_name: "Taunton",       result: "success", device: "Chrome", ip_address: "10.0.0.9", performed_by: "erin", performed_by_id: "u5", user_id: "u5", detail: "threshold 60% -> 55%",          previous_hash: "iii", hash: "jjj" },
];

// ── 1. Property bucketing ────────────────────────────────────────────────────
console.log("\n=== 1. A property chip's count is the number of rows it yields ===");
{
  const groups = V.groupPropertyCounts(ROWS);
  const byId = new Map(groups.map((g) => [g.id, g]));

  T("every distinct property is offered", byId.has("p1") && byId.has("p2") && byId.has("p3"),
    groups.map((g) => g.id).join(","));
  T("rows with no property get one explicit bucket, not one per falsy shape",
    byId.get(V.NO_PROPERTY)?.count === 2, JSON.stringify(byId.get(V.NO_PROPERTY)));
  T("an empty-string property_id buckets as unscoped, not as its own property",
    !byId.has(""), groups.map((g) => g.id).join(","));
  T("the counts sum to the total, so no row is unreachable",
    groups.reduce((n, g) => n + g.count, 0) === ROWS.length,
    `${groups.reduce((n, g) => n + g.count, 0)} vs ${ROWS.length}`);

  // THE assertion. Everything else about the chip row is cosmetic; this is the
  // one that makes the number on it true.
  for (const g of groups) {
    T(`chip "${g.label}" (${g.count}) yields exactly ${g.count} rows`,
      V.filterByProperty(ROWS, g.id).length === g.count,
      `filter returned ${V.filterByProperty(ROWS, g.id).length}`);
  }

  T("the unscoped bucket is forced last, because it is a data-quality bucket",
    groups[groups.length - 1].id === V.NO_PROPERTY, groups.map((g) => g.id).join(","));
  T("busiest property first", groups[0].id === "p1", groups.map((g) => `${g.id}:${g.count}`).join(","));
  T("p2 and p3 are tied on count in this fixture, so ordering falls to the label",
    byId.get("p2").count === byId.get("p3").count,
    `p2:${byId.get("p2").count} p3:${byId.get("p3").count}`);
  T("a tie orders by displayed label (Brockton before Taunton), not by Map insertion",
    groups.findIndex((g) => g.id === "p2") < groups.findIndex((g) => g.id === "p3"),
    groups.map((g) => g.label).join(" < "));

  // Reversing the input must not reorder the chips: insertion-order-dependent
  // output is what makes a filter row jump around between loads.
  const reversed = V.groupPropertyCounts([...ROWS].reverse()).map((g) => g.id).join(",");
  T("chip order does not depend on the order the server returned rows",
    reversed === groups.map((g) => g.id).join(","), `${reversed} vs ${groups.map((g) => g.id).join(",")}`);
}

console.log("\n=== 2. Chips are labelled with the hotel's name, not its database id ===");
{
  const groups = V.groupPropertyCounts(ROWS);
  const byId = new Map(groups.map((g) => [g.id, g]));
  T("a property with a name on ANY row is labelled with that name",
    byId.get("p1").label === "Middleborough", byId.get("p1").label);
  T("the newest row wins the label, so a renamed property shows its current name",
    V.groupPropertyCounts([
      { property_id: "p9", property_name: "New Name" },
      { property_id: "p9", property_name: "Old Name" },
    ])[0].label === "New Name");
  T("a blank name does not become the label",
    V.groupPropertyCounts([
      { property_id: "p9", property_name: "   " },
      { property_id: "p9", property_name: "Real Name" },
    ])[0].label === "Real Name");
  T("a property with no name anywhere falls back to its id rather than rendering blank",
    V.groupPropertyCounts([{ property_id: "p9" }])[0].label === "p9");
  T("the unscoped bucket's label is the sentinel, for the page to translate",
    byId.get(V.NO_PROPERTY).label === V.NO_PROPERTY);
  T("the sentinel cannot collide with a real id a human would type",
    !["none", "(none)", "-", "", "null", "undefined", "all"].includes(V.NO_PROPERTY), V.NO_PROPERTY);
}

// ── 3. Filters ───────────────────────────────────────────────────────────────
console.log("\n=== 3. Filters select exactly, and 'all' is not a filter ===");
{
  T("property 'all' is a pass-through, not a match on the string 'all'",
    V.filterByProperty(ROWS, "all").length === ROWS.length);
  T("an absent property filter is a pass-through",
    V.filterByProperty(ROWS, "").length === ROWS.length && V.filterByProperty(ROWS, null).length === ROWS.length);
  T("result 'all' is a pass-through", V.filterByResult(ROWS, "all").length === ROWS.length);
  T("result matches exactly", V.filterByResult(ROWS, "failed").every((r) => r.result === "failed"));
  T("only the one failed row is returned", V.filterByResult(ROWS, "failed").length === 1);
  T("a row with an empty result is reachable as 'unknown', not silently dropped",
    V.filterByResult(ROWS, "unknown").length === 1 && V.filterByResult(ROWS, "unknown")[0].id === "e7");
  T("'pending' is its own result, never folded into failure",
    V.filterByResult(ROWS, "pending").length === 1 && V.filterByResult(ROWS, "pending")[0].id === "e4");
  T("filters do not mutate their input", () => {
    const before = ROWS.map((r) => r.id).join(",");
    V.filterByProperty(ROWS, "p1");
    V.filterByResult(ROWS, "failed");
    return ROWS.map((r) => r.id).join(",") === before;
  });

  // The documented divergence from auditFilter.js. This is asserted, not
  // commented, because the page's per-chip counts depend on it: filterAuditLogs
  // lets an unscoped row pass EVERY property filter, so a chip count taken from
  // one and rows taken from the other would disagree.
  const viaShared = F.filterAuditLogs(ROWS, { propertyId: "p1" }).length;
  const viaView = V.filterByProperty(ROWS, "p1").length;
  T("auditFilter's property test admits unscoped rows (the reason the page does its own)",
    viaShared > viaView, `filterAuditLogs ${viaShared} vs filterByProperty ${viaView}`);
  console.log(`  filterAuditLogs(propertyId 'p1') -> ${viaShared} rows; filterByProperty -> ${viaView}. ` +
    `The ${viaShared - viaView} extra are the unscoped rows, which no chip counts.`);
}

// ── 4. Sorting ───────────────────────────────────────────────────────────────
console.log("\n=== 4. Sorting is a copy, total, and deterministic on ties ===");
{
  T("sortAuditLogs returns a new array", V.sortAuditLogs(ROWS) !== ROWS);
  T("sortAuditLogs does not sort in place", () => {
    const before = ROWS.map((r) => r.id).join(",");
    V.sortAuditLogs(ROWS, { key: "username", dir: "asc" });
    return ROWS.map((r) => r.id).join(",") === before;
  });
  T("no row is lost or duplicated by sorting", V.sortAuditLogs(ROWS).length === ROWS.length);
  T("default is newest first", V.sortAuditLogs(ROWS)[0].id === "e1", V.sortAuditLogs(ROWS)[0].id);
  T("a row with no timestamp sorts to the end of a descending date sort, not the start",
    V.sortAuditLogs(ROWS)[ROWS.length - 1].id === "e7",
    V.sortAuditLogs(ROWS).map((r) => r.id).join(","));

  const byUser = V.sortAuditLogs(ROWS, { key: "username", dir: "asc" }).map((r) => r.username);
  // Asserted as "non-decreasing" rather than by naming the first and last value:
  // a hard-coded endpoint is a snapshot of the fixture, and adding a row to the
  // fixture would then fail the product's sort. This form cannot.
  T("text sorts ascending A-Z",
    byUser.every((v, i) => i === 0 || byUser[i - 1].localeCompare(v) <= 0), byUser.join(","));
  T("descending is the same order reversed",
    V.sortAuditLogs(ROWS, { key: "username", dir: "desc" }).map((r) => r.username)
      .every((v, i, arr) => i === 0 || arr[i - 1].localeCompare(v) >= 0));
  T("text sort is case-insensitive", () => {
    const out = V.sortAuditLogs([{ username: "zoe" }, { username: "Adam" }], { key: "username", dir: "asc" });
    return out[0].username === "Adam";
  });

  // Ties: amy appears three times. Their relative order must be fixed, because
  // the CSV is written in exactly this order and two exports of the same view
  // must be diffable.
  const tie1 = V.sortAuditLogs(ROWS, { key: "username", dir: "asc" }).map((r) => r.id).join(",");
  const tie2 = V.sortAuditLogs([...ROWS].reverse(), { key: "username", dir: "asc" }).map((r) => r.id).join(",");
  T("equal sort keys break on created_date, so the order is stable across input orders",
    tie1 === tie2, `${tie1} vs ${tie2}`);

  T("an unknown sort key falls back to created_date instead of returning an arbitrary order",
    V.sortAuditLogs(ROWS, { key: "not_a_column", dir: "desc" }).map((r) => r.id).join(",")
      === V.sortAuditLogs(ROWS, { key: "created_date", dir: "desc" }).map((r) => r.id).join(","));
  T("asc and desc are exact reverses when there are no ties", () => {
    const rows = [{ created_date: "2026-01-01" }, { created_date: "2026-01-02" }, { created_date: "2026-01-03" }];
    const a = V.sortAuditLogs(rows, { key: "created_date", dir: "asc" }).map((r) => r.created_date);
    const d = V.sortAuditLogs(rows, { key: "created_date", dir: "desc" }).map((r) => r.created_date);
    return a.join(",") === [...d].reverse().join(",");
  });
  T("every column the table offers as sortable has an accessor",
    ["created_date", "username", "action", "performed_by", "device", "result"]
      .every((k) => typeof V.AUDIT_SORT_KEYS[k] === "function"),
    Object.keys(V.AUDIT_SORT_KEYS).join(","));
  T("accessors coerce, so a missing field cannot make a comparison non-deterministic",
    Object.values(V.AUDIT_SORT_KEYS).every((get) => typeof get({}) === "string"));
  T("sorting tolerates an empty and a null row set",
    V.sortAuditLogs([]).length === 0 && V.sortAuditLogs(null).length === 0);
}

// ── 5. The export is the view ────────────────────────────────────────────────
console.log("\n=== 5. The CSV is exactly what is on screen, in the order it is on screen ===");
{
  const sorted = V.sortAuditLogs(V.filterByResult(ROWS, "all"), { key: "created_date", dir: "desc" });
  const csv = X.buildCsv(sorted, { columns: V.AUDIT_EXPORT_COLUMNS });
  const lines = csv.replace(/^﻿/, "").trimEnd().split("\r\n");

  T("one header plus one line per row", lines.length === sorted.length + 1, `${lines.length} lines for ${sorted.length} rows`);
  T("the file carries a UTF-8 BOM so Excel does not mangle non-ASCII names", csv.charCodeAt(0) === 0xfeff);
  T("records are CRLF-terminated per RFC 4180", csv.includes("\r\n"));

  // Row order in the file must match row order on screen. Asserted by reading the
  // Event ID column back out rather than by trusting that buildCsv iterates in
  // order.
  const idCol = V.AUDIT_EXPORT_COLUMNS.findIndex((c) => c.label === "Event ID");
  const idsInFile = lines.slice(1).map((l) => l.split('","')[idCol]?.replace(/^"|"$/g, ""));
  T("the file's row order is the screen's row order",
    idsInFile.join(",") === sorted.map((r) => r.id).join(","),
    `${idsInFile.join(",")} vs ${sorted.map((r) => r.id).join(",")}`);

  T("a detail containing a comma does not become two columns",
    lines.every((l) => l.split('","').length === V.AUDIT_EXPORT_COLUMNS.length),
    lines.map((l) => l.split('","').length).join(","));
  T("an embedded newline stays inside its quoted cell", csv.includes('new IP"'));
  T("an embedded quote is doubled", csv.includes('""twice""'));
  T("a cell beginning = is neutralised so it cannot execute on open",
    !/,"=cmd/.test(csv) && csv.includes("cmd|"), (csv.match(/"'?=?cmd[^"]*/) || [""])[0]);

  T("the hash pair is exported, so the chain can be re-verified outside the app",
    V.AUDIT_EXPORT_COLUMNS.some((c) => c.key === "hash") && V.AUDIT_EXPORT_COLUMNS.some((c) => c.key === "previous_hash"));
  T("severity is exported as a word, so a spreadsheet can filter on it",
    V.AUDIT_EXPORT_COLUMNS.find((c) => c.label === "Severity").format("Failed Login") === "danger");
  T("a missing result exports as 'unknown', not as an empty cell",
    V.AUDIT_EXPORT_COLUMNS.find((c) => c.label === "Result").format("") === "unknown");

  const tsCols = V.AUDIT_EXPORT_COLUMNS.filter((c) => c.key === "created_date");
  T("the timestamp is exported both localised and as UTC ISO", tsCols.length >= 2);
  T("the ISO timestamp is a real ISO string",
    /^\d{4}-\d\d-\d\dT/.test(tsCols.find((c) => /ISO/.test(c.label)).format("2026-08-20T21:40:00.000Z")));
  T("a null timestamp exports as blank in every timestamp column, never as 1969 or 'Invalid Date'",
    tsCols.every((c) => c.format(null) === ""), tsCols.map((c) => JSON.stringify(c.format(null))).join(","));
  T("every column label is unique, so no two columns collide in a spreadsheet",
    new Set(V.AUDIT_EXPORT_COLUMNS.map((c) => c.label)).size === V.AUDIT_EXPORT_COLUMNS.length,
    V.AUDIT_EXPORT_COLUMNS.map((c) => c.label).join(","));
  T("no column label is blank", V.AUDIT_EXPORT_COLUMNS.every((c) => c.label && c.label.trim() !== ""));

  // An export of a filtered view must contain the filtered rows and nothing else.
  const failedOnly = V.sortAuditLogs(V.filterByResult(ROWS, "failed"), { key: "created_date", dir: "desc" });
  const failedCsv = X.buildCsv(failedOnly, { columns: V.AUDIT_EXPORT_COLUMNS });
  T("exporting a filtered view exports the filtered rows only",
    failedCsv.replace(/^﻿/, "").trimEnd().split("\r\n").length === 2);
  T("and does not contain a row the filter excluded", !failedCsv.includes("Password Changed"));
}

// ── 6. Coverage against the actual writer ────────────────────────────────────
console.log("\n=== 6. Every field the audit writer produces reaches the CSV ===");
{
  const exported = new Set(V.AUDIT_EXPORT_COLUMNS.map((c) => c.key));
  const missing = V.AUDIT_ROW_FIELDS.filter((f) => !exported.has(f));
  T("AUDIT_EXPORT_COLUMNS covers every field in AUDIT_ROW_FIELDS",
    missing.length === 0, `missing: ${missing.join(", ")}`);

  const stray = [...exported].filter((k) => !V.AUDIT_ROW_FIELDS.includes(k));
  T("and exports no column that is not a real audit field",
    stray.length === 0, `stray: ${stray.join(", ")}`);

  // Cross-check the hand-maintained list against the writer's source. Deliberately
  // not "import auditLogger and inspect it": that module imports the PROTECTED
  // base44Client (see PROTECTED_FILES.md) and its shape is a call argument, not an
  // exported value.
  const src = readFileSync(resolve(ROOT, "src/lib/auditLogger.js"), "utf8");
  const call = src.match(/db\.audit\.log\(\{([\s\S]*?)\}\);/);
  T("the db.audit.log({...}) call is still findable in src/lib/auditLogger.js",
    !!call, "extraction failed — auditLogger.js was restructured, so this section is no longer checking anything");
  if (call) {
    const written = [...call[1].matchAll(/^\s*([a-z_][a-z0-9_]*)\s*:/gim)].map((m) => m[1]);
    T("the extraction found a plausible number of written fields", written.length >= 10, `found ${written.length}`);
    const notInList = written.filter((f) => !V.AUDIT_ROW_FIELDS.includes(f));
    T("every field the writer persists is declared in AUDIT_ROW_FIELDS",
      notInList.length === 0, `writer writes but export does not know about: ${notInList.join(", ")}`);
    const notWritten = V.AUDIT_ROW_FIELDS.filter((f) => !written.includes(f) && !["id", "created_date"].includes(f));
    T("and AUDIT_ROW_FIELDS claims no field the writer does not persist",
      notWritten.length === 0, `declared but never written: ${notWritten.join(", ")}`);
    console.log(`  writer persists ${written.length} fields: ${written.join(", ")}`);
    console.log(`  export has ${V.AUDIT_EXPORT_COLUMNS.length} columns covering all ${written.length}, ` +
      `plus id and created_date from the database.`);
  }
}

// ── 7. The whole pipeline, in the page's order ───────────────────────────────
console.log("\n=== 7. The page's pipeline composes without losing or inventing rows ===");
{
  // Exactly the composition in src/pages/AuditLog.jsx: date -> property ->
  // result -> category/search -> sort. Asserted end to end because each stage is
  // individually correct above and the failure this catches is in the joining.
  const { from, to } = X.resolveQuickRange("all");
  const dateFiltered = from || to ? ROWS.filter((l) => X.withinRange(l.created_date, from, to)) : ROWS;
  const scoped = V.filterByResult(V.filterByProperty(dateFiltered, "all"), "all");
  const filtered = F.filterAuditLogs(scoped, { category: "ALL", searchQuery: "" });
  const sorted = V.sortAuditLogs(filtered, { key: "created_date", dir: "desc" });

  T("'All time' with no filters yields every loaded row", sorted.length === ROWS.length,
    `${sorted.length} of ${ROWS.length}`);

  // A dated range must exclude the undated row, and the page must be able to SAY
  // how many it excluded. Silent exclusion is how an undated audit row stays
  // unnoticed forever.
  const range = { from: "2026-08-01", to: "2026-08-31" };
  const dated = ROWS.filter((l) => X.withinRange(l.created_date, range.from, range.to));
  T("a date range excludes the row with no timestamp", dated.length === ROWS.length - 1,
    `${dated.length} of ${ROWS.length}`);
  T("and the count of excluded-undated rows is reportable",
    X.countUndated(ROWS) === 1, String(X.countUndated(ROWS)));

  // Search + property + result together. The specific trap: filterAuditLogs
  // sanitizes the query, so a search that arrives with markup must still match
  // the plain text it was aimed at rather than matching nothing.
  const found = F.filterAuditLogs(V.filterByProperty(ROWS, "p2"), { category: "ALL", searchQuery: "carl" });
  T("search composes with a property filter", found.length === 2, `${found.length} rows`);
  T("search is case-insensitive",
    F.filterAuditLogs(ROWS, { searchQuery: "CARL" }).length === F.filterAuditLogs(ROWS, { searchQuery: "carl" }).length);
  T("a category selects a real subset rather than everything or nothing", () => {
    const auth = F.filterAuditLogs(ROWS, { category: "AUTH" });
    return auth.length > 0 && auth.length < ROWS.length;
  }, `AUTH -> ${F.filterAuditLogs(ROWS, { category: "AUTH" }).length} of ${ROWS.length}`);

  // Nothing-matches must produce an empty result, and the export must refuse
  // rather than write a header-only file the owner would hand over as evidence.
  const none = V.filterByResult(ROWS, "no_such_result");
  T("an impossible filter yields zero rows, not everything", none.length === 0);
  let threw = false;
  try { X.downloadCsv(none, { columns: V.AUDIT_EXPORT_COLUMNS }); } catch { threw = true; }
  T("exporting zero rows throws instead of writing a header-only file", threw);
}

console.log("\n" + "=".repeat(72));
console.log(`PASS ${pass}   FAIL ${fail}`);
if (failures.length) {
  console.log("\nFailures:");
  failures.forEach((f) => console.log("  ✗ " + f));
}
console.log("=".repeat(72));
console.log(`\n${fail === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
