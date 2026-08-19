// Verification harness for the shared motion system.
//
//   node scripts/verify-motion.mjs
//
// Pure math and text — no DOM, no Dexie, no fixtures, so it runs anywhere.
//
// The property that actually matters here is NOT that the animation looks nice;
// it is that animating a money figure cannot change the money figure. Every KPI
// in this app is handed to the UI already formatted by integer-cents math and is
// reconciled to the exact cent (BUSINESS.md). So the counter is held to three
// contracts, asserted below against the REAL formatters from src/lib/decimal.js:
//
//   1. The final frame is the caller's string, character for character.
//   2. Every intermediate frame keeps the same shape — same prefix, same
//      suffix, same decimal count, same grouping. No frame may imply a
//      different precision than the settled figure.
//   3. The figure never ticks backwards.
//
// It also asserts the CSS half of the token set in src/index.css matches the JS
// half in src/lib/motion.js, so the two cannot drift.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  DURATION,
  EASE_OUT,
  EASE_OUT_CSS,
  TRAVEL,
  LIMITS,
  clamp01,
  easeOutCubic,
  parseFormattedNumber,
  formatMagnitude,
  countUpFrame,
  shouldCountUp,
  fadeRise,
  fadeOnly,
  entrance,
} from "../src/lib/motion.js";

import { formatCents, formatRate, formatNumber, toCents, toRate } from "../src/lib/decimal.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

let pass = 0;
let fail = 0;
const failures = [];

function ok(cond, label, detail = "") {
  if (cond) {
    pass++;
  } else {
    fail++;
    failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("=".repeat(72));
console.log("MOTION SYSTEM — verification");
console.log("=".repeat(72));

// ── 1. Easing ────────────────────────────────────────────────────────────────
ok(easeOutCubic(0) === 0, "easeOutCubic(0) is exactly 0");
ok(easeOutCubic(1) === 1, "easeOutCubic(1) is exactly 1", `got ${easeOutCubic(1)}`);
{
  // Exactness at t=1 is what stops a counter finishing one cent short. Asserted
  // with === rather than a tolerance on purpose.
  let monotonic = true;
  let easeOutShaped = true;
  let prev = -1;
  const N = 2000;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const e = easeOutCubic(t);
    if (e < prev) monotonic = false;
    if (e < t - 1e-12) easeOutShaped = false; // ease-out is always ahead of linear
    prev = e;
  }
  ok(monotonic, `easeOutCubic is monotonic across ${N + 1} samples`);
  ok(easeOutShaped, "easeOutCubic front-loads progress (true ease-out, never ease-in)");
  ok(easeOutCubic(0.5) > 0.8, "easeOutCubic is 87.5% done at the halfway point",
    `got ${easeOutCubic(0.5)}`);
}
ok(clamp01(-5) === 0 && clamp01(5) === 1, "clamp01 clamps both ends");
ok(clamp01(NaN) === 0 && clamp01(Infinity) === 1, "clamp01 survives NaN and Infinity");

// ── 2. Reading the shape of real formatter output ────────────────────────────
{
  const cases = [
    // [formatted, prefix, suffix, magnitude, decimals, grouped]
    [formatCents(toCents(1020598.17), 2), "$", "", 1020598.17, 2, true],
    [formatCents(toCents(1020598.17), 0), "$", "", 1020598, 0, true],
    [formatCents(toCents(-16325.08), 2), "-$", "", 16325.08, 2, true],
    [formatCents(0, 2), "$", "", 0, 2, false],
    [formatCents(0, 0), "$", "", 0, 0, false],
    [formatCents(toCents(690.06), 2), "$", "", 690.06, 2, false],
    [formatRate(toRate(0.614), 1), "", "%", 61.4, 1, false],
    [formatRate(toRate(0.117), 2), "", "%", 11.7, 2, false],
    [formatNumber(1234), "", "", 1234, 0, true],
    [formatNumber(7), "", "", 7, 0, false],
  ];
  for (const [text, prefix, suffix, magnitude, decimals, grouped] of cases) {
    const s = parseFormattedNumber(text);
    ok(s !== null, `parses "${text}"`);
    if (!s) continue;
    ok(s.prefix === prefix, `"${text}" prefix is "${prefix}"`, `got "${s.prefix}"`);
    ok(s.suffix === suffix, `"${text}" suffix is "${suffix}"`, `got "${s.suffix}"`);
    ok(Math.abs(s.magnitude - magnitude) < 1e-9, `"${text}" magnitude is ${magnitude}`,
      `got ${s.magnitude}`);
    ok(s.decimals === decimals, `"${text}" has ${decimals} decimals`, `got ${s.decimals}`);
    ok(s.grouped === grouped, `"${text}" grouped=${grouped}`, `got ${s.grouped}`);
  }
}

// Values that must NOT animate — animating one number inside a string that
// holds two would state something false mid-flight.
{
  const rejects = ["—", "", "No data", "n/a", "3 of 12", "$0 · 4 categories",
    "61.4% of $1,020,598", null, undefined, NaN, Infinity, {}, []];
  for (const r of rejects) {
    ok(parseFormattedNumber(/** @type {any} */ (r)) === null,
      `refuses to animate ${JSON.stringify(r) ?? String(r)}`);
  }
  // ...and printing them is a pass-through at every t.
  for (const r of ["—", "3 of 12", "No data"]) {
    ok(countUpFrame(r, 0) === r && countUpFrame(r, 0.5) === r && countUpFrame(r, 1) === r,
      `"${r}" is printed unchanged at every t`);
  }
}

// Raw numbers (Forecasting.jsx passes one) are handled too.
{
  const s = parseFormattedNumber(412);
  ok(s !== null && s.magnitude === 412 && s.decimals === 0, "parses a raw number");
  const neg = parseFormattedNumber(-3.25);
  ok(neg !== null && neg.prefix === "-" && neg.magnitude === 3.25 && neg.decimals === 2,
    "parses a raw negative number");
}

// ── 3. formatMagnitude round-trips the real formatters ───────────────────────
{
  ok(formatMagnitude(1020598.17, { decimals: 2, grouped: true }) === "1,020,598.17",
    "formatMagnitude matches formatCents grouping and decimals");
  ok(formatMagnitude(61.4, { decimals: 1, grouped: false }) === "61.4",
    "formatMagnitude matches formatRate");
  ok(formatMagnitude(-500, { decimals: 0, grouped: true }) === "500",
    "formatMagnitude works on magnitudes only (sign lives in the prefix)");
}

// ── 4. THE CONTRACT: the final frame is the caller's exact string ────────────
{
  const figures = [
    // The reconciliation figure from BUSINESS.md — must survive to the character.
    formatCents(toCents(1020598.17), 2),
    formatCents(toCents(1020598.17), 0),
    formatCents(toCents(920829.51), 0),
    formatCents(toCents(-16325.08), 2),
    formatCents(toCents(33816.43), 2),
    formatCents(toCents(0.01), 2),
    formatCents(0, 0),
    formatRate(toRate(0.614), 1),
    formatRate(toRate(0.117), 2),
    formatNumber(1234),
    formatNumber(0),
    "-" + formatCents(toCents(250), 2),
    "1,020,598.17",
  ];
  for (const f of figures) {
    ok(countUpFrame(f, 1) === f, `settles on the exact string "${f}"`,
      `got "${countUpFrame(f, 1)}"`);
    ok(countUpFrame(f, 1.5) === f, `overshooting t still settles exactly on "${f}"`);
    ok(countUpFrame(f, 1, 999999) === f, `counting DOWN still settles exactly on "${f}"`);
  }
  ok(countUpFrame("$1,020,598.17", 1) === "$1,020,598.17",
    "the YTD reconciliation figure is byte-identical after animating");
}

// ── 5. THE CONTRACT: every frame keeps the same shape ────────────────────────
{
  const figures = [
    formatCents(toCents(1020598.17), 2),
    formatCents(toCents(-16325.08), 2),
    formatCents(toCents(920829), 0),
    formatRate(toRate(0.614), 1),
    formatNumber(48210),
  ];
  const N = 240; // ~4 frames per ms of the 620ms roll
  for (const f of figures) {
    const shape = parseFormattedNumber(f);
    let monotonic = true;
    let shapeHeld = true;
    let prevMag = -1;
    let badFrame = "";
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const frame = countUpFrame(f, t, 0);
      const fs = parseFormattedNumber(frame);
      if (!fs) { shapeHeld = false; badFrame = frame; break; }
      if (fs.prefix !== shape.prefix || fs.suffix !== shape.suffix ||
          fs.decimals !== shape.decimals) {
        shapeHeld = false;
        badFrame = frame;
        break;
      }
      if (fs.magnitude < prevMag - 1e-9) { monotonic = false; badFrame = frame; break; }
      prevMag = fs.magnitude;
    }
    ok(shapeHeld, `"${f}": every frame keeps prefix, suffix and decimal count`, badFrame);
    ok(monotonic, `"${f}": the figure never ticks backwards`, badFrame);
    ok(parseFormattedNumber(countUpFrame(f, 0, 0)).magnitude === 0,
      `"${f}": starts from zero, not from the final value`);
    ok(countUpFrame(f, 0, 0).startsWith(shape.prefix),
      `"${f}": the first frame already carries the currency/sign prefix`);
  }
  // A negative figure counts its magnitude up while the sign stays put — it
  // must never read as a positive number on the way.
  const neg = formatCents(toCents(-16325.08), 2);
  for (const t of [0, 0.1, 0.5, 0.9, 0.999]) {
    ok(countUpFrame(neg, t, 0).startsWith("-$"), `negative figure keeps its sign at t=${t}`);
  }
}

// ── 6. Interrupting a roll mid-flight ────────────────────────────────────────
{
  // A filter change part-way through must continue from what is on screen, not
  // snap back to zero — that is the difference between "the number is tracking
  // my filter" and "the number is flickering".
  const target = formatCents(toCents(500000), 0);
  const midFrame = countUpFrame(target, 0.2, 300000);
  const mid = parseFormattedNumber(midFrame);
  ok(mid.magnitude > 300000 && mid.magnitude < 500000,
    "an interrupted roll resumes from the visible figure", `got ${mid.magnitude}`);
  // Counting DOWN (a filter that lowers revenue) is monotonically decreasing.
  let decreasing = true;
  let prev = Infinity;
  for (let i = 0; i <= 100; i++) {
    const m = parseFormattedNumber(countUpFrame(target, i / 100, 900000)).magnitude;
    if (m > prev + 1e-9) decreasing = false;
    prev = m;
  }
  ok(decreasing, "a figure that fell counts DOWN monotonically, never bouncing");
}

// ── 7. shouldCountUp ─────────────────────────────────────────────────────────
ok(shouldCountUp("$100", "$200") === true, "shouldCountUp: a changed figure rolls");
ok(shouldCountUp("$100", "$100") === false,
  "shouldCountUp: an unchanged figure does NOT re-roll (no animation on re-render)");
ok(shouldCountUp(null, "$100") === true, "shouldCountUp: first paint rolls");
ok(shouldCountUp("$100", "—") === false, "shouldCountUp: changing to non-numeric does not roll");
ok(shouldCountUp("$100", "3 of 12") === false, "shouldCountUp: ambiguous target does not roll");

// ── 8. Token discipline ──────────────────────────────────────────────────────
{
  const ambient = ["instant", "fast", "base", "slow"];
  for (const k of ambient) {
    ok(DURATION[k] >= LIMITS.minDuration && DURATION[k] <= LIMITS.maxAmbientDuration,
      `DURATION.${k} (${DURATION[k]}ms) is within the restrained 90-240ms band`);
  }
  ok(DURATION.instant < DURATION.fast && DURATION.fast < DURATION.base &&
     DURATION.base < DURATION.slow, "durations are strictly ordered");
  ok(DURATION.count > DURATION.slow && DURATION.count <= 800,
    "the count-up is the single deliberate exception, and still under 800ms");
  for (const k of Object.keys(TRAVEL)) {
    ok(TRAVEL[k] >= LIMITS.minTravel && TRAVEL[k] <= LIMITS.maxTravel,
      `TRAVEL.${k} (${TRAVEL[k]}px) is within the 6-12px band`);
  }
  ok(EASE_OUT.length === 4, "EASE_OUT is a 4-point cubic-bezier");
  ok(EASE_OUT[0] >= 0 && EASE_OUT[0] <= 1 && EASE_OUT[2] >= 0 && EASE_OUT[2] <= 1,
    "EASE_OUT control-point x values are in [0,1] (a valid CSS timing function)");
  ok(EASE_OUT[1] > EASE_OUT[0], "EASE_OUT leaves fast (true ease-out shape)");
}

// ── 9. framer-motion helpers ─────────────────────────────────────────────────
{
  const r = fadeRise();
  ok(r.initial.y === TRAVEL.base && r.animate.y === 0, "fadeRise travels the token distance");
  ok(Object.keys(r.initial).every((k) => k === "opacity" || k === "y"),
    "fadeRise animates opacity and transform ONLY (never layout properties)");
  ok(Math.abs(r.transition.duration - DURATION.base / 1000) < 1e-9,
    "fadeRise duration is in seconds for framer-motion");
  const f = fadeOnly();
  ok(!("y" in f.initial) && f.initial.opacity === 0, "fadeOnly strips all travel");
  ok(!("y" in entrance(true).initial), "reduced motion gets no travel");
  ok("y" in entrance(false).initial, "normal motion gets travel");
}

// ── 10. CSS and JS tokens cannot drift ───────────────────────────────────────
{
  const css = readFileSync(join(ROOT, "src/index.css"), "utf8");
  const v = (name) => {
    const m = css.match(new RegExp(`--${name}:\\s*([^;]+);`));
    return m ? m[1].trim() : null;
  };
  const pairs = [
    ["fx-instant", `${DURATION.instant}ms`],
    ["fx-fast", `${DURATION.fast}ms`],
    ["fx-base", `${DURATION.base}ms`],
    ["fx-slow", `${DURATION.slow}ms`],
    ["fx-count", `${DURATION.count}ms`],
    ["fx-rise", `${TRAVEL.base}px`],
    ["fx-ease", EASE_OUT_CSS],
  ];
  for (const [name, expected] of pairs) {
    ok(v(name) === expected, `--${name} in index.css matches the JS token (${expected})`,
      `css has ${v(name)}`);
  }

  ok(/@media\s*\(prefers-reduced-motion:\s*reduce\)/.test(css),
    "index.css has a global prefers-reduced-motion kill switch");
  const rm = css.slice(css.search(/@media\s*\(prefers-reduced-motion/));
  ok(/animation-duration:\s*0\.01ms\s*!important/.test(rm),
    "the kill switch collapses animation durations");
  ok(/animation-iteration-count:\s*1\s*!important/.test(rm),
    "the kill switch stops infinite animations (status-pulse)");
  ok(/transition-duration:\s*0\.01ms\s*!important/.test(rm),
    "the kill switch collapses transition durations");
  ok(!/animation-duration:\s*(0s|none)/.test(rm),
    "the kill switch does NOT use 0s/none, which can leave Radix overlays mounted");

  ok(/@keyframes fxRise/.test(css), "the shared fxRise entrance keyframe exists");
  ok(/\.fx-enter\s*{[^}]*animation:\s*fxRise/.test(css), ".fx-enter uses fxRise");
  // `both` would keep the final keyframe applied at animation priority forever,
  // beating KpiCard's hover:-translate-y-0.5 and silently killing the hover.
  const enter = css.match(/\.fx-enter\s*{[^}]*}/)[0];
  ok(/backwards/.test(enter) && !/\bboth\b/.test(enter),
    ".fx-enter fills backwards, not both, so hover transforms still work",
    enter.replace(/\s+/g, " "));

  // A focus outline follows the element's own corners. Setting border-radius in
  // the :focus-visible rule would reshape the ELEMENT — a rounded-2xl card would
  // snap to small corners while focused.
  const focus = css.match(/:focus-visible\s*{[^}]*}/)?.[0] ?? "";
  ok(focus.length > 0, "index.css defines a :focus-visible indicator (keyboard quality floor)");
  ok(/outline:/.test(focus), ":focus-visible draws an outline");
  ok(!/border-radius/.test(focus),
    ":focus-visible does NOT set border-radius (that would reshape the element, not the outline)",
    focus.replace(/\s+/g, " "));

  // framer-motion drives whileHover/whileTap by writing `transform` to the
  // inline style each frame; a CSS transition on the same property fights it.
  const press = css.match(/button:not\(\[style\*="transform"\]\)[^{]*{[^}]*}/)?.[0] ?? "";
  ok(press.length > 0,
    "the global press transition excludes elements with an inline transform (framer-motion's)");
  ok(/transform var\(--fx-instant\)/.test(press),
    "press feedback uses the instant token for its transform");
}

// ── 11. The chart contract: containers animate, slices do not ────────────────
{
  const pie = readFileSync(join(ROOT, "src/components/charts/PieDonut.jsx"), "utf8");
  ok(/isAnimationActive=\{false\}/.test(pie),
    "PieDonut still disables slice animation (the label engine lays out against final geometry)");
  ok(!/framer-motion/.test(pie),
    "no motion was added inside PieDonut — the entrance belongs to the Card around it");

  const card = readFileSync(join(ROOT, "src/components/ui-exec/Card.jsx"), "utf8");
  ok(/fx-enter/.test(card), "Card carries the shared entrance, so every chart card fades and rises");
  ok(!/transition-all/.test(card),
    "Card no longer transitions ALL properties (transition-all animates layout too)");

  const kpi = readFileSync(join(ROOT, "src/components/ui-exec/KpiCard.jsx"), "utf8");
  ok(/useCountUp/.test(kpi), "KpiCard rolls its figure");
  ok(/tabular-nums/.test(kpi),
    "KpiCard keeps tabular-nums — without fixed-width digits the roll jitters");

  const uni = readFileSync(join(ROOT, "src/components/charts/UniversalChart.jsx"), "utf8");
  ok(/animationDuration:\s*DURATION\.slow/.test(uni),
    "UniversalChart's bars use the token duration, not recharts' 1500ms default");
  ok(/isAnimationActive:\s*!reduceMotion/.test(uni),
    "UniversalChart switches recharts animation off for reduced motion (CSS cannot reach it)");
  // The pie branch must not receive the animation props at all — check the
  // actual <PieDonut .../> element rather than the file as a whole.
  const pieEl = uni.match(/<PieDonut[^>]*\/>/)?.[0] ?? "";
  ok(pieEl.length > 0, "found the <PieDonut> element in UniversalChart");
  ok(!/anim|animation/i.test(pieEl),
    "the <PieDonut> element is handed no animation props — the ring appears at final geometry",
    pieEl);
}

// ── 12. Fuzz: random figures, random progress ────────────────────────────────
{
  let seed = 20260818;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const RUNS = 4000;
  let exact = 0;
  let shapeStable = 0;
  let monotonic = 0;
  let firstBad = null;

  for (let run = 0; run < RUNS; run++) {
    const decimals = [0, 1, 2][Math.floor(rnd() * 3)];
    const raw = Math.pow(rnd(), 3) * 2_000_000 * (rnd() < 0.15 ? -1 : 1);
    const kind = Math.floor(rnd() * 3);
    let text;
    if (kind === 0) text = formatCents(toCents(raw), decimals === 1 ? 2 : decimals);
    else if (kind === 1) text = formatRate(toRate(raw / 2_000_000), decimals);
    else text = formatNumber(Math.round(raw));

    const shape = parseFormattedNumber(text);
    if (!shape) { if (!firstBad) firstBad = { text, why: "unparseable" }; continue; }

    if (countUpFrame(text, 1, 0) === text) exact++;
    else if (!firstBad) firstBad = { text, why: "final frame differs", got: countUpFrame(text, 1, 0) };

    let stable = true;
    let up = true;
    let prev = -Infinity;
    const from = rnd() < 0.3 ? shape.magnitude * rnd() : 0;
    for (let i = 0; i <= 40; i++) {
      const frame = countUpFrame(text, i / 40, from);
      const fs = parseFormattedNumber(frame);
      if (!fs || fs.prefix !== shape.prefix || fs.suffix !== shape.suffix ||
          fs.decimals !== shape.decimals) { stable = false; break; }
      if (shape.magnitude >= from && fs.magnitude < prev - 1e-6) { up = false; break; }
      prev = fs.magnitude;
    }
    if (stable) shapeStable++;
    else if (!firstBad) firstBad = { text, why: "shape drifted" };
    if (up) monotonic++;
    else if (!firstBad) firstBad = { text, why: "went backwards" };
  }

  ok(exact === RUNS, `fuzz: all ${RUNS} figures settle on their exact string`,
    firstBad ? JSON.stringify(firstBad) : `${exact}/${RUNS}`);
  ok(shapeStable === RUNS, `fuzz: shape held across every frame of ${RUNS} rolls`,
    `${shapeStable}/${RUNS}`);
  ok(monotonic === RUNS, `fuzz: no roll ever ticked backwards (${RUNS} rolls)`,
    `${monotonic}/${RUNS}`);
  console.log(`\n  Fuzz: ${RUNS} figures × 41 frames = ${RUNS * 41} frames checked`);
}

console.log("\n" + "=".repeat(72));
console.log(`PASS ${pass}   FAIL ${fail}`);
if (failures.length) {
  console.log("\nFailures:");
  failures.slice(0, 40).forEach((f) => console.log("  ✗ " + f));
  if (failures.length > 40) console.log(`  ... and ${failures.length - 40} more`);
}
console.log("=".repeat(72));
process.exit(fail === 0 ? 0 : 1);
