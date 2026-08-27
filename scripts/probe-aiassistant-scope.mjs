// Probe for Fix (audit finding 1.5): "aiAssistant server-side scoping is dead
// code — it computes allowedIds/propFilter but never applies them; the summary
// is built entirely from client-supplied rows."
//
// Root cause (before fix):
//   base44/functions/aiAssistant/entry.ts computed `allowedIds` and a
//   `makeFilter()` that were NEVER applied. The `denied` 403 guard only checked
//   the requested `propertyId` param — not the `synthetic` rows in the body. A
//   restricted user could request a property they ARE allowed to see while
//   posting ANOTHER property's rows in `synthetic`, and the summary would report
//   the other property's money. Server-side isolation was theatre.
//
// Fix:
//   base44/utils/aiScope.js exports resolveAllowedIds(user) + scopeSyntheticRows
//   (synthetic, allowedIds). entry.ts now scopes body.synthetic through it before
//   summarising, so the allowed-property set is enforced on the rows themselves.
//
// This probe proves the pure enforcement: unrestricted callers pass through
// unchanged, restricted callers keep only their allowed rows, cross-property
// smuggling is dropped, and rows with a missing property_id fail closed.
//
// Run: node scripts/probe-aiassistant-scope.mjs

import { resolveAllowedIds, scopeSyntheticRows } from "../base44/utils/aiScope.js";

let pass = 0;
let fail = 0;
const T = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`); }
};

// ─── resolveAllowedIds ───────────────────────────────────────────────────────
console.log("\n=== resolveAllowedIds ===");
T("owner is unrestricted (null)", resolveAllowedIds({ role: "owner" }) === null);
T("admin is unrestricted (null)", resolveAllowedIds({ role: "admin" }) === null);
T("property_access 'all' is unrestricted (null)",
  resolveAllowedIds({ role: "clerk", property_access: "all" }) === null);
const setA = resolveAllowedIds({ role: "clerk", property_access: ["A", "B"] });
T("array property_access -> Set of those ids", setA instanceof Set && setA.has("A") && setA.has("B") && setA.size === 2);
T("numeric ids are stringified", resolveAllowedIds({ role: "clerk", property_access: [1, 2] }).has("1"));
const failClosed = resolveAllowedIds({ role: "clerk" });
T("missing property_access on non-root fails closed (empty Set, not null)",
  failClosed instanceof Set && failClosed.size === 0);
T("non-array property_access on non-root fails closed",
  resolveAllowedIds({ role: "clerk", property_access: "A" }).size === 0);

// ─── scopeSyntheticRows: unrestricted passthrough ───────────────────────────
console.log("\n=== scopeSyntheticRows: unrestricted passthrough ===");
const synthetic = {
  occRows: [{ property_id: "A", total_revenue: 100 }, { property_id: "B", total_revenue: 999 }],
  payRows: [{ property_id: "A", total: 50 }, { property_id: "B", total: 500 }],
  expenseRows: [{ property_id: "B", amount: 42 }],
  payroll: [{ property_id: "A", total_pay: 10 }],
  clerkRecords: [{ property_id: "B", record_type: "payment" }],
  srcRows: [{ property_id: "A", net_revenue: 5 }],
  uploads: [{ property_id: "B", file_name: "b.csv" }],
};
const passthrough = scopeSyntheticRows(synthetic, null);
T("unrestricted (null) returns the exact same object reference", passthrough === synthetic);

// ─── scopeSyntheticRows: restricted filtering (the security fix) ─────────────
console.log("\n=== scopeSyntheticRows: restricted caller only sees allowed rows ===");
const onlyA = scopeSyntheticRows(synthetic, new Set(["A"]));
T("occRows keeps only property A", onlyA.occRows.length === 1 && onlyA.occRows[0].property_id === "A");
T("property B revenue row is dropped (no cross-property leak)",
  !onlyA.occRows.some((r) => r.property_id === "B"),
  JSON.stringify(onlyA.occRows));
T("payRows scoped to A", onlyA.payRows.length === 1 && onlyA.payRows[0].property_id === "A");
T("expenseRows (only B) becomes empty for an A-only caller", onlyA.expenseRows.length === 0);
T("clerkRecords (only B) dropped", onlyA.clerkRecords.length === 0);
T("uploads (only B) dropped", onlyA.uploads.length === 0);
T("payroll (A) kept", onlyA.payroll.length === 1);
T("original synthetic object is not mutated", synthetic.occRows.length === 2);

// The exact smuggling attack: caller allowed only A posts B's high-revenue rows.
const smuggle = {
  occRows: [{ property_id: "B", total_revenue: 1_000_000 }],
  payRows: [{ property_id: "B", total: 1_000_000 }],
};
const blocked = scopeSyntheticRows(smuggle, new Set(["A"]));
T("smuggled cross-property rows are fully stripped",
  blocked.occRows.length === 0 && blocked.payRows.length === 0,
  JSON.stringify(blocked));

// ─── Fail-closed on missing / blank property_id ──────────────────────────────
console.log("\n=== scopeSyntheticRows: fail-closed on missing property_id ===");
const noProp = { occRows: [{ total_revenue: 5 }, { property_id: "", total_revenue: 6 }, { property_id: null }] };
const scopedNoProp = scopeSyntheticRows(noProp, new Set(["A"]));
T("rows with missing/blank/null property_id are dropped for a restricted caller",
  scopedNoProp.occRows.length === 0, JSON.stringify(scopedNoProp.occRows));

// A restricted caller with an EMPTY allowed set (fail-closed) sees nothing.
const none = scopeSyntheticRows(synthetic, new Set());
T("empty allowed set (no access) yields zero rows across every field",
  none.occRows.length === 0 && none.payRows.length === 0 && none.uploads.length === 0);

// Undefined synthetic must not throw.
let threw = false;
try { scopeSyntheticRows(undefined, new Set(["A"])); } catch { threw = true; }
T("undefined synthetic does not throw", !threw);

console.log(`\n${fail === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
