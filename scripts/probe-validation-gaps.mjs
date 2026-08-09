// Probe: do bad CSV values fail loudly, or become plausible-looking data?
//
// Testing three suspicions before building a validation pipeline on top of them.
// Each prints OBSERVED behaviour rather than asserting, because the point is to
// find out what actually happens, not to confirm what I assume.
//
// Usage: node --experimental-loader ./scripts/resolve-alias.mjs scripts/probe-validation-gaps.mjs
import { parseAmount, parseCsvText, rowsToObjects } from "../src/lib/csvParser.js";

console.log("=== 1. parseAmount on values a real export contains ===");
for (const v of ["N/A", "n/a", "-", "", "  ", "TOTAL", "1,234.50", "($100.00)", "abc", "12abc", "1.2.3", "Infinity", "1e5"]) {
  const r = parseAmount(v);
  console.log(`  ${JSON.stringify(v).padEnd(12)} -> ${JSON.stringify(r)}   (?? 0 yields ${JSON.stringify(r ?? 0)})`);
}

console.log("\n=== 2. unknown headers ===");
// A renamed or added PMS column. Does anything notice it was dropped?
const csv = "Date,Total Revenue,Mystery Column,Rooms Sold\n2026-01-01,100.00,999,5\n";
const objs = rowsToObjects(parseCsvText(csv));
console.log("  parsed object:", JSON.stringify(objs[0]));
console.log("  -> 'Mystery Column' is present in the object; the loss happens in mapRow's COLUMN_MAP lookup.");

console.log("\n=== 3. the occupancy branch ===");
// Mirrors reportParsers.js scanReport lines 369-377 exactly.
function occupancyBranch(r) {
  if (!r.occupancy || r.occupancy > 1) {
    const sold = Number(r.rooms_sold) || 0;
    const total = Number(r.total_rooms) || 0;
    r.occupancy = total > 0 ? sold / total : 0;
  } else if (r.occupancy > 1) {
    r.occupancy = r.occupancy / 100;
  }
  return r;
}
const cases = [
  { label: "percent form, no room counts", occupancy: 85 },
  { label: "percent form, with room counts", occupancy: 85, rooms_sold: 80, total_rooms: 100 },
  { label: "ratio form", occupancy: 0.85 },
  { label: "missing, with counts", rooms_sold: 80, total_rooms: 100 },
  { label: "missing, no counts", },
];
for (const c of cases) {
  const { label, ...row } = c;
  const before = row.occupancy;
  const after = occupancyBranch({ ...row }).occupancy;
  console.log(`  ${label.padEnd(30)} occupancy ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
}
console.log("  -> if 85 becomes 0, the /100 branch is unreachable and the percent case loses its data.");

console.log("\n=== 4. row-length mismatch ===");
// A truncated row: fewer cells than headers.
const ragged = "Date,Total Revenue,Rooms Sold\n2026-01-01,100.00\n2026-01-02,200.00,10,EXTRA\n";
for (const o of rowsToObjects(parseCsvText(ragged))) console.log("  ", JSON.stringify(o));
console.log("  -> missing cells become '' and extra cells are dropped, with no count of either.");
