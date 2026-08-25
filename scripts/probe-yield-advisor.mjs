// Probe: the Dashboard's yield panel must not invent numbers, and must not
// contradict the other panel on the same screen about the same occupancy.
//
// THE DEFECT (five of them, measured 2026-08-25 against YieldAdvisor.jsx at
// commit 22f3ab5). The panel titled "Yield & ADR Optimizer" optimized nothing. It
// computed its advice in three inline if-branches and every figure was fabricated
// or false: literal `$10–$15` / `$5–$8` rate moves derived from nothing, a target
// ADR from `money2(adr * 1.05)` (float math on dollars, and a 5% from nowhere), a
// caption reading "Occupancy vs 100-room capacity" on a page that already holds
// the real room-night capacity, a hardcoded `occupancy > 0.6` band while six other
// surfaces — `LowOccAlert` among them, on this same screen — gate on the owner's
// configured `getOccThreshold()`, and an empty database falling through to "Soft
// Occupancy (0.0%). Drop rate $5–$8", i.e. rate advice for a period with no rows.
//
// The logic now lives in `src/lib/yieldAdvice.js` so it can be asserted here
// rather than pattern-matched through JSX. Sections [1]-[4] exercise the real
// function; [5]-[6] are source contracts on the two .jsx files that cannot be
// imported into node, and are labelled as such.
//
// Run: node --import ./scripts/_loader-boot.mjs scripts/probe-yield-advisor.mjs

// Installed BEFORE the app modules load: section [2] proves the owner's saved
// occupancy target is read through settingsStore, and that read happens at call
// time against whatever `localStorage` exists then.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./_repo-root.mjs";

const ROOT = REPO_ROOT;
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");

const { buildYieldAdvice, STRONG_OCCUPANCY_MARGIN } = await import("@/lib/yieldAdvice");
const { getOccThreshold } = await import("@/lib/hotel");

let pass = 0;
let fail = 0;
const T = (label, cond, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
};

// A period with real inventory, so `capacity > 0` and only the band is in play.
const at = (occ, threshold) => buildYieldAdvice({
  occupancy: occ, capacity: 620, roomsSold: Math.round(620 * occ), threshold,
});

// ── 1. The bands are the owner's target, not 0.6 and 0.8 ────────────────────
console.log("\n[1] band boundaries follow the configured target");

T("default target is the shipped 0.60", getOccThreshold() === 0.60, String(getOccThreshold()));
T(`strong margin is ${STRONG_OCCUPANCY_MARGIN}, so the default strong band still starts at 0.80`,
  0.60 + STRONG_OCCUPANCY_MARGIN === 0.8, String(0.60 + STRONG_OCCUPANCY_MARGIN));

T("just under the target reads soft", at(0.5999, 0.60).band === "soft", at(0.5999, 0.60).band);
T("exactly AT the target is not soft", at(0.60, 0.60).band === "healthy", at(0.60, 0.60).band);
T("above the target reads healthy", at(0.75, 0.60).band === "healthy", at(0.75, 0.60).band);
T("target + margin reads strong", at(0.80, 0.60).band === "strong", at(0.80, 0.60).band);
T("a hair under target + margin is still healthy", at(0.7999, 0.60).band === "healthy", at(0.7999, 0.60).band);

// The whole point of reading the setting: raise the target and the same occupancy
// must change band. Under the old hardcoded 0.6 every one of these was "healthy".
T("at a 0.70 target, 0.65 occupancy is soft", at(0.65, 0.70).band === "soft", at(0.65, 0.70).band);
T("at a 0.70 target, 0.85 occupancy is not yet strong", at(0.85, 0.70).band === "healthy", at(0.85, 0.70).band);
T("at a 0.70 target, 0.90 occupancy is strong", at(0.90, 0.70).band === "strong", at(0.90, 0.70).band);
T("at a 0.40 target, 0.55 occupancy is healthy", at(0.55, 0.40).band === "healthy", at(0.55, 0.40).band);

// ── 2. The saved setting is actually read, not just accepted as an argument ──
console.log("\n[2] the owner's saved target reaches this function");

store.set("rri_alert_thresholds", JSON.stringify({ occupancyThreshold: 0.72 }));
T("getOccThreshold picks up the saved value", getOccThreshold() === 0.72, String(getOccThreshold()));
const noArg = buildYieldAdvice({ occupancy: 0.66, capacity: 620, roomsSold: 409 });
T("with no threshold argument the saved 0.72 is used", noArg.band === "soft", `${noArg.band} target=${noArg.target}`);
T("...and the target it compared against is reported back", noArg.target === 0.72, String(noArg.target));
store.delete("rri_alert_thresholds");
T("removing the setting returns the default", getOccThreshold() === 0.60, String(getOccThreshold()));

// ── 3. An unmeasured period says so instead of advising a rate cut ──────────
console.log("\n[3] no rows means no advice");

const empty = buildYieldAdvice({ occupancy: 0, capacity: 0, roomsSold: 0 });
T("zero capacity reads as unknown, not soft", empty.band === "unknown", empty.band);
T("the headline says there is nothing to read", /no occupancy/i.test(empty.headline), empty.headline);
T("the action asks for data, and does not name a rate move",
  /import|date range/i.test(empty.action) && !/\$/.test(empty.action), empty.action);
T("the basis says the period is empty rather than printing a fake denominator",
  /no occupancy rows/i.test(empty.basis), empty.basis);

const noArgs = buildYieldAdvice();
T("called with nothing at all it still returns unknown, and does not throw", noArgs.band === "unknown", noArgs.band);
const junk = buildYieldAdvice({ occupancy: NaN, capacity: undefined, roomsSold: "x" });
T("non-numeric inputs read as unknown", junk.band === "unknown", junk.band);

// A real period at 0% occupancy is NOT the same state as an empty one: rooms were
// available and none sold. That must still advise, or a genuine zero-sales week
// would be reported as "no data".
const zeroSold = buildYieldAdvice({ occupancy: 0, capacity: 620, roomsSold: 0 });
T("0% occupancy WITH inventory is soft, not unknown", zeroSold.band === "soft", zeroSold.band);
T("...and its basis counts the unsold room-nights", /0 of 620 room-nights/.test(zeroSold.basis), zeroSold.basis);

// ── 4. Nothing this panel says may be a fabricated number ───────────────────
console.log("\n[4] no invented figures in any branch");

const GRID = [0, 0.05, 0.2, 0.42, 0.5999, 0.6, 0.61, 0.7, 0.7999, 0.8, 0.95, 1, 1.4];
const TARGETS = [0.4, 0.5, 0.6, 0.7, 0.85];
const outputs = [];
for (const t of TARGETS) for (const o of GRID) outputs.push(at(o, t));
outputs.push(empty, zeroSold);

// A dollar sign in advice from a panel that computes no rate is the defect, in any
// form: `$10`, `$5–$8`, or a formatted `$156.75` from float math.
const withMoney = outputs.filter((r) => /\$/.test(`${r.headline} ${r.action}`));
T(`no branch prints a dollar amount (${outputs.length} outputs checked)`, withMoney.length === 0,
  withMoney.slice(0, 3).map((r) => r.action).join(" | "));

// The specific fabrications that shipped.
const joined = outputs.map((r) => `${r.headline} ${r.action} ${r.basis}`).join("\n");
for (const gone of ["10–15", "10-15", "5–8", "5-8", "Rack Rate", "100-room"]) {
  T(`no output contains "${gone}"`, !joined.includes(gone));
}

T("every band reports the target it was measured against",
  outputs.every((r) => Number.isFinite(r.target)));
T("every band carries a basis line", outputs.every((r) => typeof r.basis === "string" && r.basis.length > 0));
T("only the four known bands are ever returned",
  outputs.every((r) => ["strong", "healthy", "soft", "unknown"].includes(r.band)),
  [...new Set(outputs.map((r) => r.band))].join(","));

// Above 100% occupancy is real in this data (overbooking, or a day whose
// `total_rooms` is missing and falls back low). It must not read as an error.
T("occupancy above 1.0 is strong, not broken", at(1.4, 0.6).band === "strong", at(1.4, 0.6).band);

// The basis is the panel's only quantitative claim, so it must be the numbers it
// was handed — not a rounded or hardcoded stand-in.
const b = buildYieldAdvice({ occupancy: 0.7, capacity: 1240, roomsSold: 868, threshold: 0.6 });
T("the basis quotes the real room-nights sold and available",
  b.basis.includes("868") && b.basis.includes("1,240"), b.basis);
const frac = buildYieldAdvice({ occupancy: 0.5, capacity: 620.5, roomsSold: 310.25, threshold: 0.6 });
T("a fractional room-night count is shown, not silently rounded away",
  frac.basis.includes("310.25") && frac.basis.includes("620.5"), frac.basis);

// ── 5. The panel renders this and computes nothing itself ───────────────────
// SOURCE CONTRACT. YieldAdvisor.jsx cannot be imported here (JSX), so this checks
// the wiring, not what a browser paints. Comments are stripped first: the module
// header quotes the strings it replaced, and a probe that fails because a file
// documents its own fix punishes the fix. Same technique as probe-ui-feedback.mjs.
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/.*$/gm, "$1");
const panel = stripComments(read("src/components/dashboard/YieldAdvisor.jsx"));

T("the panel imports the advice module", /from ['"]@\/lib\/yieldAdvice['"]/.test(panel));
T("the panel calls buildYieldAdvice", /buildYieldAdvice\(/.test(panel));
T("the panel no longer hardcodes the 0.8 band", !/occupancy\s*>\s*0?\.8/.test(panel));
T("the panel no longer hardcodes the 0.6 band", !/occupancy\s*>\s*0?\.6/.test(panel));
T("the fabricated rate moves are gone", !/\$10|\$15|\$5|\$8/.test(panel));
T("the float-dollar ADR target is gone", !/adr\s*\*/.test(panel));
T('the "100-room capacity" caption is gone', !/100-room/.test(panel));
T("the panel renders the measured basis instead", /\.basis/.test(panel));
// Asserted on the DESTRUCTURING, not on the word: the old caption contained the
// string "capacity", so a bare /capacity/ passed against the file this replaced.
T("the panel destructures the real capacity and roomsSold props",
  /function YieldAdvisor\(\{[^}]*\bcapacity\b[^}]*\}\)/.test(panel) &&
  /function YieldAdvisor\(\{[^}]*\broomsSold\b[^}]*\}\)/.test(panel));
T("...and hands them straight to buildYieldAdvice",
  /buildYieldAdvice\(\{[^}]*capacity[^}]*roomsSold[^}]*\}\)/.test(panel));

// ── 6. The Dashboard hands it the real capacity ──────────────────────────────
console.log("\n[6] Dashboard wiring");

const dash = stripComments(read("src/pages/Dashboard.jsx"));
const tag = /<YieldAdvisor\b[^>]*\/>/.exec(dash);
T("the Dashboard still renders the panel", !!tag, "no <YieldAdvisor /> found");
if (tag) {
  T("it passes capacity", /capacity=\{capacity\}/.test(tag[0]), tag[0]);
  T("it passes roomsSold", /roomsSold=\{roomsSold\}/.test(tag[0]), tag[0]);
  T("it still passes occupancy", /occupancy=\{occupancy\}/.test(tag[0]), tag[0]);
}
// `capacity` and `roomsSold` come from calculateOccupancyMetrics, which returns
// fromCents(capacityCents(...)) — i.e. room-NIGHTS, the unit the caption claims.
T("both props come from the destructured currentStats",
  /const \{[^}]*\bcapacity\b[^}]*\}\s*=\s*currentStats;/.test(dash) &&
  /const \{[^}]*\broomsSold\b[^}]*\}\s*=\s*currentStats;/.test(dash));

// ── 7. It cannot contradict LowOccAlert about the same number ───────────────
console.log("\n[7] agreement with LowOccAlert");

// LowOccAlert's own test, transcribed from src/components/dashboard/LowOccAlert.jsx:
//   occRows.filter((r) => Number(r.occupancy || 0) < threshold)
// Both panels render on the Dashboard at once, so "flagged as a low day" and
// "called soft here" must be the same predicate or the screen contradicts itself.
const alert = read("src/components/dashboard/LowOccAlert.jsx");
T("LowOccAlert's predicate is still `< threshold`",
  /Number\(r\.occupancy \|\| 0\) < threshold/.test(alert));
T("LowOccAlert still reads the same setting", /getOccThreshold\(\)/.test(alert));

let disagreements = 0;
for (const t of TARGETS) {
  for (const o of GRID) {
    const flaggedLow = o < t;
    const soft = at(o, t).band === "soft";
    if (flaggedLow !== soft) {
      disagreements++;
      console.log(`          occ=${o} target=${t}: alert=${flaggedLow ? "low" : "ok"} panel=${at(o, t).band}`);
    }
  }
}
T(`the two agree on all ${TARGETS.length * GRID.length} combinations`, disagreements === 0,
  `${disagreements} disagreement(s)`);

// The old code's exact contradiction, kept as a named regression: target 0.70,
// occupancy 0.65 — LowOccAlert flagged the day, the panel said "Healthy".
T("the shipped contradiction at target 0.70 / occ 0.65 is closed",
  at(0.65, 0.70).band === "soft", at(0.65, 0.70).band);

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
console.log(`\n${fail === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
