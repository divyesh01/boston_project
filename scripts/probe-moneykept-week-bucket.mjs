// Regression probe for MoneyKept bucketKey() week label (src/components/dashboard/MoneyKept.jsx).
//
// bucketKey parses the row date with a LOCAL parse (`new Date(`${d}T00:00:00`)`) and
// computes the week's Monday with local getDay()/setDate() — all correct. The OLD code
// then formatted that local-midnight Monday with `.toISOString().slice(0,10)`, which
// re-applies the UTC offset: for a viewer EAST of UTC (positive offset, e.g. Asia/Tokyo)
// local midnight is the PREVIOUS day in UTC, so the week label rolled back to Sunday.
// The grouping stayed self-consistent (every date in the week maps to the same key), so
// this was a label-only defect — but the label is drawn on a money chart's axis.
//
// The shipped fix formats the Monday from LOCAL parts, so the label is the actual Monday
// in every timezone. Run under both a west- and an east-of-UTC zone:
//   TZ=America/New_York node scripts/probe-moneykept-week-bucket.mjs
//   TZ=Asia/Tokyo       node scripts/probe-moneykept-week-bucket.mjs

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  if (got === want) { pass++; }
  else { fail++; console.log(`  FAIL ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
};

// Shared prefix: both classifiers compute the local Monday identically. They differ ONLY
// in how the resulting Date is formatted back to a YYYY-MM-DD string.
const localMonday = (dateStr) => {
  const dt = new Date(`${dateStr}T00:00:00`);
  const monday = new Date(dt);
  monday.setDate(dt.getDate() - ((dt.getDay() + 6) % 7));
  return monday;
};
const oldWeekKey = (dateStr) => localMonday(dateStr).toISOString().slice(0, 10);
const newWeekKey = (dateStr) => {
  const monday = localMonday(dateStr);
  const mm = String(monday.getMonth() + 1).padStart(2, "0");
  const dd = String(monday.getDate()).padStart(2, "0");
  return `${monday.getFullYear()}-${mm}-${dd}`;
};

console.log(`TZ = ${process.env.TZ || '(system default)'}`);
const offset = new Date("2026-02-04").getTimezoneOffset(); // minutes; >0 = west, <0 = east of UTC
console.log(`offset(min) at 2026-02-04 = ${offset}`);

// Each row date and the Monday of its week (ISO week, Monday start).
const cases = [
  ["2026-02-02", "2026-02-02"], // Monday itself
  ["2026-02-04", "2026-02-02"], // Wednesday
  ["2026-02-08", "2026-02-02"], // Sunday (end of the same ISO week)
  ["2026-02-09", "2026-02-09"], // next Monday
  ["2026-01-01", "2025-12-29"], // Thursday; week starts in the PREVIOUS year
  ["2026-12-31", "2026-12-28"], // Thursday; last week of the year
  ["2026-03-01", "2026-02-23"], // Sunday; week starts in the previous month
];

// The NEW formatter must return the correct local Monday in ANY timezone.
console.log("\n[new week key — must always be the actual local Monday]");
for (const [d, want] of cases) eq(`newWeekKey(${d})`, newWeekKey(d), want);

// Every date within one ISO week must collapse to a single key (grouping invariant).
const week = ["2026-02-02","2026-02-03","2026-02-04","2026-02-05","2026-02-06","2026-02-07","2026-02-08"];
const keys = new Set(week.map(newWeekKey));
eq("all 7 days of one ISO week share one key", keys.size, 1);
eq("that shared key is the Monday", [...keys][0], "2026-02-02");

// Demonstrate the bug the fix removes: EAST of UTC the OLD formatter rolls the label
// back to Sunday. WEST of UTC (the owner's America/New_York) it never manifested, so
// only assert the regression where the environment reproduces it.
const eastOfUtc = offset < 0;
console.log(`\n[old formatter — buggy only east of UTC: ${eastOfUtc}]`);
if (eastOfUtc) {
  eq("OLD rolls Wed's week label back to Sunday (bug reproduced)", oldWeekKey("2026-02-04"), "2026-02-01");
  eq("NEW keeps it on Monday (bug fixed)", newWeekKey("2026-02-04"), "2026-02-02");
} else {
  eq("OLD agrees with NEW west of UTC (bug dormant here)", oldWeekKey("2026-02-04"), newWeekKey("2026-02-04"));
}

console.log(`\n${fail === 0 ? "GREEN" : "RED"}  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
