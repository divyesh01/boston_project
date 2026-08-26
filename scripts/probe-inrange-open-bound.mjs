// Probe: hotel.js inRange() must treat an empty ('') bound as "open", not as a
// wall that rejects every date.
//
// Root cause under test (src/lib/hotel.js): `return d >= from && d <= to;`
// When the upper bound is '' (the default custom-range value from
// useGlobalFilters, and the cache-fallback path), `d <= ''` is false for every
// real date string, so EVERY row is dropped and the page reads $0. The correct
// contract matches the already-guarded twin in dailyAggregates.js:36-42 —
// a missing bound is skipped, not enforced.
//
// RED before the fix (open-bound cases return false); GREEN after.
import { register } from "node:module";
register(new URL("./resolve-alias.mjs", import.meta.url));

const { inRange } = await import("../src/lib/hotel.js");

let pass = 0, fail = 0;
function T(name, cond) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

console.log("=== inRange: closed range (both bounds set) ===");
T("date inside the range is kept", inRange("2026-08-15", "2026-08-01", "2026-08-31") === true);
T("the first day is inclusive", inRange("2026-08-01", "2026-08-01", "2026-08-31") === true);
T("the last day is inclusive", inRange("2026-08-31", "2026-08-01", "2026-08-31") === true);
T("a date before the range is dropped", inRange("2026-07-31", "2026-08-01", "2026-08-31") === false);
T("a date after the range is dropped", inRange("2026-09-01", "2026-08-01", "2026-08-31") === false);
T("a datetime string is compared date-only", inRange("2026-08-15T23:59:00", "2026-08-01", "2026-08-31") === true);

console.log("=== inRange: open bounds ('' means unbounded) — THE BUG ===");
T("open upper bound keeps a date at/after 'from'", inRange("2026-08-15", "2026-08-01", "") === true);
T("open upper bound keeps a far-future date", inRange("2030-01-01", "2026-08-01", "") === true);
T("open upper bound still drops a date before 'from'", inRange("2025-01-01", "2026-08-01", "") === false);
T("open lower bound keeps a date at/before 'to'", inRange("2026-08-15", "", "2026-08-31") === true);
T("open lower bound keeps a far-past date", inRange("2000-01-01", "", "2026-08-31") === true);
T("open lower bound still drops a date after 'to'", inRange("2027-01-01", "", "2026-08-31") === false);
T("both bounds open keeps any real date", inRange("2026-08-15", "", "") === true);

console.log("=== inRange: invalid input ===");
T("empty date string is rejected", inRange("", "2026-08-01", "2026-08-31") === false);
T("null date is rejected", inRange(null, "", "") === false);
T("undefined date is rejected", inRange(undefined, "", "") === false);

console.log(`\n${fail === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
