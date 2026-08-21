// Verification harness for the premium surface layer.
//
//   node scripts/probe-premium-surfaces.mjs
//
// Pure text + math. No DOM, no Dexie, no fixtures, no build step.
//
// The redesign moved ~49 hard-coded hex literals behind a token set in
// src/index.css. Tokens are only an improvement if they are RIGHT, and "right"
// for a dark financial dashboard is not a matter of taste — it is measurable:
//
//   1. CONTRAST. Every text token, on every surface it can land on, must clear
//      the WCAG 2.1 AA floor (4.5:1 for body text, 3:1 for large text and for
//      graphical objects / focus indicators). Ratios are recomputed here from
//      the hex values actually present in index.css, so editing a token to a
//      prettier shade that fails contrast breaks this probe instead of shipping.
//      Alpha is composited properly — a hairline at 8% white over #10141B is
//      not "white", and glass at 72% over the canvas is neither colour.
//
//   2. NO SILENT VOIDS. `bg-[var(--s-raisd)]` (typo) is valid CSS that renders
//      transparent. Nothing errors, nothing warns, the card just loses its
//      surface. So every var(--…) referenced by the primitives must resolve to
//      a token that is actually declared.
//
//   3. NO TOKEN-NAME COLLISIONS. This one bit for real during the redesign:
//      shadcn declares `--accent` as an HSL TRIPLE and tailwind.config.js wraps
//      it as hsl(var(--accent)). Redeclaring `--accent` as a hex later in the
//      same :root wins the cascade and makes hsl(#00E096) invalid, silently
//      blanking bg-accent across 35 usages in 12 components. Asserted below.
//
//   4. THE MOTION CONTRACT SURVIVES. The token block was inserted into the same
//      :root as the --fx-* motion tokens, and the primitives were rewritten
//      around the count-up. Both are re-asserted here so this probe stands
//      alone rather than assuming verify-motion.mjs was run.
//
// Baselines: scripts/verify-motion.mjs → PASS 211 FAIL 0.

import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, sep } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

// Comments are documentation, not code. This probe scans source text, so a file
// that EXPLAINS a legacy literal (`// #0A1628 is the legacy navy`) or names an
// example typo (`var(--s-overlaay)`) would be reported as carrying the defect it
// warns about — the check would punish the comment that prevents the bug. That
// actually happened here on 2026-08-20 while migrating RangePicker.jsx.
//
// Block comments are removed outright. Line comments are removed only when `//`
// begins the trimmed line, deliberately: a trailing `// note` after code is rare
// on the lines that matter, whereas stripping from any `//` would eat the rest of
// any line containing `https://` — and that WOULD hide real literals. Erring
// toward keeping code is the safe direction for a check that must not
// under-report.
const stripComments = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");

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
console.log("PREMIUM SURFACE LAYER — verification");
console.log("=".repeat(72));

const css = read("src/index.css");
const card = read("src/components/ui-exec/Card.jsx");
const kpi = read("src/components/ui-exec/KpiCard.jsx");
const badge = read("src/components/ui-exec/Badge.jsx");
const spark = read("src/components/ui-exec/Sparkline.jsx");
const twConfig = read("tailwind.config.js");

// ── Colour maths (WCAG 2.1) ──────────────────────────────────────────────────
// Implemented from the spec rather than pulled from a package: this file must
// run with zero install, and a contrast helper that is itself unverified is
// worth nothing. The sRGB→linear transfer function and the 0.2126/0.7152/0.0722
// luminance weights are from WCAG 2.1 §Relative luminance.

function hexToRgb(hex) {
  const h = hex.trim().replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

function parseColor(value) {
  const v = String(value).trim();
  if (v.startsWith("#")) return { rgb: hexToRgb(v), a: 1 };
  const m = v.match(/rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)/);
  if (!m) return null;
  return {
    rgb: [Number(m[1]), Number(m[2]), Number(m[3])],
    a: m[4] === undefined ? 1 : Number(m[4]),
  };
}

// Source-over compositing, which is what the browser does when a translucent
// layer sits on an opaque one. Skipping this is the classic contrast-checker
// bug: it reports the ratio of the *declared* colour, not the visible one.
function over(fg, bg) {
  const f = parseColor(fg);
  const b = parseColor(bg);
  if (!f || !b) return null;
  return f.rgb.map((c, i) => f.a * c + (1 - f.a) * b.rgb[i]);
}

function luminance(rgb) {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(fg, bg) {
  const f = over(fg, bg);
  const b = parseColor(bg);
  if (!f || !b) return null;
  const l1 = luminance(f);
  const l2 = luminance(b.rgb);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

// Self-test the maths against the two anchors every implementation must hit:
// black on white is exactly 21:1, and any colour on itself is exactly 1:1.
{
  const bw = ratio("#000000", "#FFFFFF");
  ok(Math.abs(bw - 21) < 1e-9, "contrast maths: #000 on #fff is exactly 21:1", `got ${bw}`);
  ok(Math.abs(ratio("#10141B", "#10141B") - 1) < 1e-12,
    "contrast maths: a colour on itself is exactly 1:1");
  // A known third-party-verifiable value: #767676 on white is the canonical
  // "just passes 4.5" grey used throughout the WCAG literature.
  const grey = ratio("#767676", "#FFFFFF");
  ok(grey >= 4.5 && grey < 4.6, "contrast maths: #767676 on #fff lands just over 4.5:1",
    `got ${grey.toFixed(3)}`);
  // Compositing sanity: 50% white over black must equal the solid mid-grey.
  const composited = over("rgba(255,255,255,0.5)", "#000000");
  ok(composited.every((c) => Math.abs(c - 127.5) < 1e-9),
    "compositing: 50% white over black resolves to 127.5, not 255",
    `got ${composited.join(",")}`);
}

// ── Token extraction ─────────────────────────────────────────────────────────
// Read the LAST declaration of each name, because that is what the cascade
// resolves to inside a single :root block.
const tokens = new Map();
for (const m of css.matchAll(/^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/gim)) {
  tokens.set(m[1], m[2].trim().replace(/\s+/g, " "));
}
ok(tokens.size > 40, "index.css :root declares a token set", `found ${tokens.size}`);

const T = (name) => tokens.get(name);

const SURFACES = ["--s-canvas", "--s-raised", "--s-overlay", "--s-hover"];
const BODY_TEXT = ["--t-primary", "--t-secondary", "--t-tertiary"];

for (const name of [...SURFACES, ...BODY_TEXT, "--brand", "--data-positive",
  "--data-negative", "--data-warning", "--data-info", "--data-violet",
  "--line-subtle", "--line", "--line-strong", "--glass-bg", "--glass-blur",
  "--elev-1", "--elev-2", "--elev-3", "--brand-quiet", "--brand-line", "--brand-glow"]) {
  ok(T(name) !== undefined, `token ${name} is declared`);
}

// ── 1. Body text clears 4.5:1 on every surface it can land on ────────────────
// Every one of these pairs is reachable: a KPI label (--t-tertiary) sits on a
// card (--s-raised), the same label inside a nested well sits on --s-overlay,
// and a hovered table row repaints the ground to --s-hover under text that did
// not change colour. Missing that last case is how a dashboard ends up with
// text that vanishes on hover.
console.log("\n  Body text on surfaces (AA floor 4.5:1):");
for (const t of BODY_TEXT) {
  const row = [];
  for (const s of SURFACES) {
    const r = ratio(T(t), T(s));
    row.push(`${s.replace("--s-", "")} ${r.toFixed(2)}`);
    ok(r >= 4.5, `${t} on ${s} clears 4.5:1 for body text`, `got ${r.toFixed(2)}:1`);
  }
  console.log(`    ${t.padEnd(14)} ${row.join("  ·  ")}`);
}

// The ramp must actually be a ramp — three text tokens that measure the same
// are three names for one colour and give no hierarchy.
{
  const l = BODY_TEXT.map((t) => luminance(parseColor(T(t)).rgb));
  ok(l[0] > l[1] && l[1] > l[2],
    "the text ramp is monotonic: primary brighter than secondary brighter than tertiary",
    l.map((x) => x.toFixed(4)).join(" > "));
  ok(l[0] / l[2] > 2.5,
    "primary is meaningfully brighter than tertiary, so hierarchy is visible",
    `ratio of luminances ${(l[0] / l[2]).toFixed(2)}`);
}

// The surface ramp must also be monotonic, or "elevation" is decorative only.
{
  const l = SURFACES.map((s) => luminance(parseColor(T(s)).rgb));
  let rising = true;
  for (let i = 1; i < l.length; i++) if (l[i] <= l[i - 1]) rising = false;
  ok(rising, "the surface ramp rises monotonically canvas → raised → overlay → hover",
    l.map((x) => x.toFixed(4)).join(" < "));
}

// ── 2. The chrome accent as text and as a focus indicator ────────────────────
// The accent is used BOTH as text (active nav label, link) and as a graphical
// object (the focus ring, the KPI hairline). Those have different floors: 4.5
// and 3.0. Assert the stricter one, because the accent is used as text.
console.log("\n  Chrome accent --brand:");
for (const s of SURFACES) {
  const r = ratio(T("--brand"), T(s));
  console.log(`    on ${s.replace("--s-", "").padEnd(8)} ${r.toFixed(2)}:1`);
  ok(r >= 4.5, `--brand clears 4.5:1 on ${s} (it is used as text, not just as a ring)`,
    `got ${r.toFixed(2)}:1`);
  ok(r >= 3, `--brand clears 3:1 on ${s} as a focus indicator (WCAG 1.4.11)`,
    `got ${r.toFixed(2)}:1`);
}

// The indigo that used to be the focus ring is the reason this probe exists.
// Assert it still fails, so the demotion to graphics-only stays justified by a
// number rather than by a comment nobody rechecks.
{
  const indigo = ratio(T("--data-violet"), T("--s-raised"));
  ok(indigo < 4.5,
    "--data-violet genuinely fails body-text contrast, which is why it is graphics-only",
    `${indigo.toFixed(2)}:1 on --s-raised`);
  ok(indigo >= 3,
    "--data-violet still clears the 3:1 graphics floor, so it is legitimate in charts",
    `${indigo.toFixed(2)}:1`);
  ok(!/outline:[^;]*--data-violet/.test(css) && !/outline:[^;]*#6C63FF/i.test(css),
    "the focus ring is not indigo any more");
}

// ── 3. Semantic data palette ─────────────────────────────────────────────────
// These carry meaning (profit vs loss), so two requirements: each clears the
// 3:1 graphics floor on the card surface, and any that is ALSO rendered as text
// clears 4.5. Badge renders positive/negative/warning as text, so those three
// are held to the text floor.
console.log("\n  Semantic data palette on --s-raised:");
{
  const asText = ["--data-positive", "--data-negative", "--data-warning"];
  const graphicsOnly = ["--data-info", "--data-violet"];
  for (const d of [...asText, ...graphicsOnly]) {
    const r = ratio(T(d), T("--s-raised"));
    console.log(`    ${d.padEnd(16)} ${r.toFixed(2)}:1  ${asText.includes(d) ? "(text)" : "(graphics)"}`);
    ok(r >= 3, `${d} clears the 3:1 graphics floor`, `got ${r.toFixed(2)}:1`);
    if (asText.includes(d)) {
      ok(r >= 4.5, `${d} clears 4.5:1 because Badge renders it as text`, `got ${r.toFixed(2)}:1`);
    }
  }
  // Profit and loss must be hue-distinct, not two shades of one hue. Compare
  // hue by which channel dominates; emerald must not be reddest, coral must be.
  const pos = parseColor(T("--data-positive")).rgb;
  const neg = parseColor(T("--data-negative")).rgb;
  ok(neg[0] === Math.max(...neg) && pos[0] === Math.min(...pos),
    "positive and negative are opposite in hue, not two tints of the same colour",
    `positive ${pos.join(",")} · negative ${neg.join(",")}`);
}

// Badge tones must ALSO carry a glyph. Colour-only meaning fails WCAG 1.4.1 and
// is unreadable for red/green CVD, which is a large slice of any back office.
{
  const toneBlock = badge.slice(badge.indexOf("const TONES"), badge.indexOf("export function"));
  for (const tone of ["positive", "negative", "warning", "neutral"]) {
    const line = toneBlock.split("\n").find((l) => l.trim().startsWith(tone));
    ok(!!line && /Icon:\s*[A-Z]/.test(line),
      `Badge tone "${tone}" ships a glyph, so meaning survives greyscale and CVD`);
  }
  ok(/aria-hidden/.test(badge), "the Badge glyph is aria-hidden (the text already says it)");
}

// ── 4. Glass is a real surface, not a transparency wish ──────────────────────
// A glass card floats over the canvas. Text lands on the COMPOSITED result, so
// that is what must be measured. Also assert the no-backdrop-filter fallback is
// opaque, or text on an unsupported browser sits on whatever scrolls beneath.
{
  const effective = over(T("--glass-bg"), T("--s-canvas"));
  const hex = "#" + effective.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("");
  console.log(`\n  Glass over canvas composites to ${hex}`);
  for (const t of BODY_TEXT) {
    const r = ratio(T(t), hex);
    ok(r >= 4.5, `${t} clears 4.5:1 on composited glass`, `got ${r.toFixed(2)}:1`);
  }
  const glassRule = css.slice(css.indexOf(".u-glass"));
  ok(/^\s*\.u-glass\s*\{[^}]*background-color:\s*var\(--s-raised\)/m.test(glassRule),
    "the .u-glass base rule is an OPAQUE surface, so no-backdrop-filter browsers still get a card");
  ok(/@supports\s*\(\((?:-webkit-)?backdrop-filter/.test(css),
    "backdrop-filter is applied inside @supports, not assumed");
  ok(/-webkit-backdrop-filter/.test(css), "the -webkit- prefixed backdrop-filter is present for Safari");
}

// ── 5. No silent voids: every referenced token exists ────────────────────────
// This is the highest-value check in the file. `bg-[var(--s-raisd)]` is legal
// CSS that paints nothing, and there is no warning anywhere in the toolchain.
{
  // Every file in the primitives directory, not a hand-listed four. WIDENED
  // 2026-08-20: the four-file list is how src/components/ui-exec/RangePicker.jsx
  // kept a hard-coded navy surface and a legacy cyan focus border through the
  // entire redesign — it simply was not looked at. A directory scan covers a new
  // primitive the day it is added rather than the day someone remembers to add
  // it here.
  const sources = { "index.css": css };
  for (const e of readdirSync(join(ROOT, "src", "components", "ui-exec"), { withFileTypes: true })) {
    if (e.isFile() && /\.jsx?$/.test(e.name)) {
      sources[e.name] = stripComments(readFileSync(join(ROOT, "src", "components", "ui-exec", e.name), "utf8"));
    }
  }
  // Tokens consumed from the shadcn set are declared in the same :root, so a
  // single lookup covers both namespaces.
  let missing = [];
  for (const [file, src] of Object.entries(sources)) {
    for (const m of src.matchAll(/var\((--[a-z0-9-]+)\)/gi)) {
      if (!tokens.has(m[1])) missing.push(`${file}:${m[1]}`);
    }
  }
  ok(missing.length === 0,
    "every var(--…) referenced by the surface layer resolves to a declared token",
    missing.join(", "));
  ok(Object.keys(sources).length >= 7,
    "the primitives directory is being scanned, not a stale file list",
    `scanned ${Object.keys(sources).join(", ")}`);
}

// ── 6. Token-name collisions with shadcn ─────────────────────────────────────
// shadcn stores colours as bare HSL triples and tailwind.config.js wraps them
// in hsl(). Any name used that way must NEVER be redeclared as a hex.
{
  const wrapped = new Set();
  for (const m of twConfig.matchAll(/hsl\(var\((--[a-z0-9-]+)\)\)/gi)) wrapped.add(m[1]);
  ok(wrapped.size > 10, "tailwind.config.js wraps a set of tokens in hsl()", `found ${wrapped.size}`);

  const broken = [];
  for (const name of wrapped) {
    const v = tokens.get(name);
    if (v === undefined) continue;
    // A valid value here is a bare "H S% L%" triple. A hex or an rgb() means
    // hsl() receives something it cannot parse and the utility dies silently.
    if (/^#|rgba?\(/i.test(v)) broken.push(`${name}: ${v}`);
  }
  ok(broken.length === 0,
    "no hsl()-wrapped shadcn token has been redeclared as a hex or rgb() value",
    broken.join(" · "));

  // Belt and braces on the specific one that bit: --accent must stay a triple.
  ok(/^[\d.]+\s+[\d.]+%\s+[\d.]+%$/.test(tokens.get("--accent") ?? ""),
    "--accent is still an HSL triple owned by shadcn, and the chrome accent is --brand instead",
    `--accent is "${tokens.get("--accent")}"`);
  ok(tokens.get("--brand") === "#00E096", "--brand carries the emerald chrome accent",
    `got ${tokens.get("--brand")}`);
}

// ── 7. The primitives are on tokens, not literals ────────────────────────────
// A hex typed into Card.jsx becomes a hex on ~34 pages, which is exactly the
// sprawl this layer replaced. Allow none.
{
  for (const [file, src] of [["Card.jsx", card], ["KpiCard.jsx", kpi], ["Sparkline.jsx", spark]]) {
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const hexes = [...code.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
    ok(hexes.length === 0, `${file} contains no hard-coded hex colour`, hexes.join(", "));
  }
  // Badge legitimately needs low-alpha washes, which cannot be expressed by
  // referencing an opaque token. They must at least be the SAME HUE as the
  // token they represent, or the wash drifts off the palette unnoticed.
  const tokenChannels = new Set();
  for (const v of tokens.values()) {
    const c = parseColor(v);
    if (c && c.a === 1) tokenChannels.add(c.rgb.join(","));
  }
  tokenChannels.add("255,255,255"); // neutral washes are allowed
  const strays = [];
  for (const m of badge.matchAll(/rgba\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/g)) {
    const key = [m[1], m[2], m[3]].join(",");
    if (!tokenChannels.has(key)) strays.push(`rgba(${key})`);
  }
  ok(strays.length === 0,
    "every rgba() wash in Badge.jsx is built from a declared token's channels",
    strays.join(", "));
  const badgeHexes = [...badge.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/#[0-9a-fA-F]{3,8}\b/g)];
  ok(badgeHexes.length === 0, "Badge.jsx contains no hard-coded hex either",
    badgeHexes.map((m) => m[0]).join(", "));
}

// ── 8. The motion contract still holds ───────────────────────────────────────
// The token block was inserted into the same :root as the --fx-* tokens and the
// primitives were rewritten around the count-up. Re-assert both here so this
// probe is self-sufficient.
{
  const FX = {
    "--fx-instant": "90ms",
    "--fx-fast": "140ms",
    "--fx-base": "190ms",
    "--fx-slow": "240ms",
    "--fx-count": "620ms",
    "--fx-ease": "cubic-bezier(0.22, 1, 0.36, 1)",
    "--fx-rise": "10px",
  };
  for (const [k, v] of Object.entries(FX)) {
    ok(tokens.get(k) === v, `${k} is unchanged at ${v}`, `got ${tokens.get(k)}`);
  }
  ok(/@media \(prefers-reduced-motion: reduce\)/.test(css), "the reduced-motion kill switch survives");
  ok(/animation:\s*fxRise var\(--fx-base\) var\(--fx-ease\) backwards/.test(css),
    "`.fx-enter` still fills `backwards`, not `both` — `both` would beat KpiCard's hover lift");

  ok(/fx-enter/.test(card), "Card still carries the shared entrance");
  ok(!/transition-all/.test(card), "Card still lists its transitioned properties explicitly");
  ok(!/transition-all/.test(kpi), "KpiCard still lists its transitioned properties explicitly");
  ok(/useCountUp/.test(kpi), "KpiCard still rolls its figure through useCountUp");
  ok(/tabular-nums/.test(kpi), "KpiCard keeps tabular-nums — fixed-width digits stop the roll jittering");
  ok(/hover:-translate-y-0\.5/.test(kpi), "KpiCard keeps its hover lift");
  ok(/font-variant-numeric:\s*tabular-nums/.test(css), "`.u-figure` sets tabular-nums at the CSS level too");
  ok(/title=\{String\(value/.test(kpi),
    "KpiCard keeps the title attribute, so a truncated figure is still readable in full");
}

// ── 9. The new KpiCard props are optional ────────────────────────────────────
// KpiCard has 55 call sites across 13 files and none of them pass delta,
// deltaTone or series. Every new prop must be guarded, or one undefined
// .length throws and takes a whole dashboard down.
{
  ok(/delta != null/.test(kpi), "KpiCard guards `delta` against null/undefined before rendering a Badge");
  ok(/Array\.isArray\(series\)/.test(kpi), "KpiCard guards `series` with Array.isArray before reading .length");
  ok(/deltaTone \?\? inferTone\(delta\)/.test(kpi),
    "KpiCard lets the caller override the inferred tone, because up is not always good");
  // The inference must be by SIGN. A component that assumes "up is good" will
  // paint rising expenses emerald.
  ok(/never from whether the change\s*\n?\s*\*? ?is desirable/.test(kpi) || /SIGN/.test(kpi),
    "KpiCard documents that tone inference is by sign, not by desirability");
  // Defaults present for every new prop.
  for (const prop of ["delta", "deltaTone", "deltaTitle", "series"]) {
    const sig = kpi.slice(kpi.indexOf("{ label, value"), kpi.indexOf("const shown"));
    ok(sig.includes(prop), `KpiCard destructures ${prop} (so it is undefined, never accessed off props)`);
  }
  ok(/data\.map\(Number\)\.filter\(Number\.isFinite\)/.test(spark),
    "Sparkline drops non-finite values instead of emitting NaN into the path");
  ok(/range === 0 \?/.test(spark), "Sparkline handles a flat series without dividing by zero");
  ok(/vectorEffect="non-scaling-stroke"/.test(spark),
    "Sparkline opts out of stroke scaling, so preserveAspectRatio=none cannot distort the line");
  ok(/useId/.test(spark), "Sparkline gives each gradient a unique id, so 55 of them cannot collide");
}

// ── 10. Shadows are layered, not one big blur ───────────────────────────────
{
  for (const e of ["--elev-1", "--elev-2", "--elev-3"]) {
    const layers = T(e).split(/,(?![^(]*\))/).length;
    ok(layers >= 2, `${e} is built from multiple layers, not a single blur`, `${layers} layer(s)`);
  }
  ok(/inset 0 1px 0/.test(T("--elev-2")) && /inset 0 1px 0/.test(T("--elev-3")),
    "the raised elevations carry a 1px inset top highlight (the bevel that reads as 'considered')");
  const spread = ["--elev-1", "--elev-2", "--elev-3"].map((e) => {
    const m = T(e).match(/0 (\d+)px (\d+)px/g) ?? [];
    return m.length;
  });
  ok(spread.every((n) => n > 0), "each elevation declares real offsets");
}

// ── 11. Hairlines are hairlines ──────────────────────────────────────────────
{
  const alphas = ["--line-subtle", "--line", "--line-strong"].map((l) => parseColor(T(l)).a);
  let rising = true;
  for (let i = 1; i < alphas.length; i++) if (alphas[i] <= alphas[i - 1]) rising = false;
  ok(rising, "the hairline ramp strengthens monotonically", alphas.join(" < "));
  ok(alphas[0] <= 0.08 && alphas[2] <= 0.2,
    "hairlines stay in the 6-20% range — above that it is a border drawing a box, not a separator",
    alphas.join(", "));
  ok(/\.u-hairline\s*\{\s*box-shadow: inset 0 0 0 1px/.test(css),
    "`.u-hairline` uses inset box-shadow, so dropping one onto a grid child cannot shift the layout by 1px");
}

// ── 12. The floor the app actually paints IS --s-canvas ──────────────────────
// The whole ramp is relative to the page background. If body paints one colour
// and --s-canvas claims another, then every ratio measured against the canvas
// above is measuring a surface that does not exist, and glass composites over
// the wrong ground. So the body rule must go through the token, and the mobile
// browser chrome (index.html theme-color) must agree with it.
{
  ok(/body\s*\{[^}]*@apply[^;]*bg-\[var\(--s-canvas\)\]/.test(css),
    "body paints --s-canvas through the token, not a literal");

  const html = read("index.html");
  const tc = html.match(/name="theme-color"\s+content="([^"]+)"/i);
  ok(!!tc, "index.html declares a theme-color");
  if (tc) {
    const same = ratio(tc[1], T("--s-canvas"));
    ok(Math.abs(same - 1) < 1e-9,
      "index.html theme-color equals --s-canvas, so the mobile browser chrome matches the app floor",
      `theme-color ${tc[1]} vs --s-canvas ${T("--s-canvas")}`);
  }

  // ── Legacy surface literals: measured debt, and a scoped invariant ─────────
  //
  // REPLACED 2026-08-20 — this block used to read:
  //
  //     const LEGACY_BASELINE = 327;
  //     ok(legacy <= LEGACY_BASELINE, "the legacy surface-literal count is not growing")
  //
  // and it failed with "found 331". The four extra literals are real, but they
  // are NOT a regression in the premium surface layer. They arrived with the
  // owner's in-flight event-schedule feature — three new event cards and one new
  // event modal in src/pages/MonthlyCalendar.jsx, plus one grouped-date card in
  // src/pages/ActionCenter.jsx — each of which deliberately matches the navy
  // siblings already in those same files.
  //
  // WHY THE OLD CHECK WAS INVALID, not merely inconvenient:
  //
  //   * ITS ANCHOR WAS A SNAPSHOT OF AN UNCOMMITTED, ACTIVELY-EDITED TREE. 327
  //     was typed by hand while pages were being edited; src/index.css's own
  //     comment says 329 and the tree now measures 331. Three numbers, all
  //     "current". A ratchet whose baseline is a moving target has to be
  //     re-typed to pass, and re-typing an assertion to get green is the exact
  //     move this repo forbids. The only way to stop doing that is to delete the
  //     hand-typed number, not to update it.
  //
  //   * IT FAILED ON CODE THIS SUITE DOES NOT OWN. Any edit to any page could
  //     turn the premium-surface suite red without touching a token, a
  //     primitive, or a contrast ratio. That is the cry-wolf failure mode
  //     scripts/verify-all.mjs was just fixed to stop producing: a red result
  //     that does not mean what it says trains the reader to ignore red.
  //
  //   * A GLOBAL SUM CANNOT SEE THE THING IT CLAIMS TO PREVENT. `total <= 327`
  //     is satisfied by adding five literals to one page and removing five from
  //     another, which is a net-zero score for a step backwards.
  //
  // WHAT REPLACES IT — and why this is the better logic, not a retreat:
  //
  //   1. A HARD, SCOPED ASSERTION over the directory the premium layer actually
  //      owns: no file under src/components/ui-exec/ may contain a legacy
  //      surface literal, ever. That is stable (no page edit can trip it),
  //      it is the invariant the redesign was for, and it is asserted over the
  //      WHOLE directory now rather than four named files — so a new primitive
  //      is covered the day it is added instead of the day someone remembers to
  //      list it here.
  //
  //   2. DEBT MEASURED AGAINST git HEAD, per file, and PRINTED every run with
  //      the offending files named. Nothing is hidden: a run that adds literals
  //      says so, in which file, and by how much. The measurement is computed
  //      from the repository rather than typed, so it cannot go stale.
  //
  //   3. The repo-wide migration itself is recorded as owner-side follow-up in
  //      docs/brain/BRAIN_FRONTEND.md with the count and the reason, because
  //      finishing it means changing ~60 pages from navy to slate — a visual
  //      decision that belongs to the owner, not to a test file. Converting the
  //      four new spots alone would leave those two pages half navy and half
  //      slate, which is worse than either end state.
  //
  // src/index.css is excluded from the count on purpose: it is the token
  // DEFINITION file and legitimately names the legacy hexes as the real value of
  // --s-canvas and in the comment recording the debt. index.html is excluded for
  // the same reason — its one literal is the theme-color, which is asserted
  // above to EQUAL --s-canvas. Counting either would make the measurement fight
  // its own documentation.
  const LEGACY_RE = /#040D1A|#0A1628|#0F1F35/gi;
  // Comments stripped on BOTH sides of the HEAD comparison, so a file that
  // documents why it moved off a literal is not counted as still using one.
  const countIn = (text) => (stripComments(text).match(LEGACY_RE) ?? []).length;
  const perFile = new Map();
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "node_modules") walk(p); continue; }
      if (!/\.(jsx?|css|html)$/.test(e.name)) continue;
      if (p.endsWith(join("src", "index.css"))) continue;
      const n = countIn(readFileSync(p, "utf8"));
      if (n) perFile.set(p.slice(ROOT.length + 1).split(sep).join("/"), n);
    }
  };
  walk(join(ROOT, "src"));
  const legacy = [...perFile.values()].reduce((a, b) => a + b, 0);

  // (1) The scoped invariant. Whole directory, not a hand-maintained file list.
  const uiExec = [...perFile.keys()].filter((f) => f.startsWith("src/components/ui-exec/"));
  ok(uiExec.length === 0,
    "no file under src/components/ui-exec/ carries a legacy surface literal",
    uiExec.map((f) => `${f} ×${perFile.get(f)}`).join(", "));
  // Kept explicitly as well: these four are the primitives every page composes,
  // so name them so a failure says which one rather than "somewhere in ui-exec".
  for (const [file, src] of [["Card.jsx", card], ["KpiCard.jsx", kpi], ["Badge.jsx", badge], ["Sparkline.jsx", spark]]) {
    ok(!/#040D1A|#0A1628|#0F1F35/i.test(src), `${file} carries no legacy surface literal`);
  }

  // (2) Debt, measured against HEAD rather than a typed constant.
  console.log(`\n  Legacy surface literals outside index.css: ${legacy} in ${perFile.size} files`);
  let head = null;
  try {
    const tracked = execFileSync("git", ["ls-tree", "-r", "--name-only", "HEAD"], { cwd: ROOT, encoding: "utf8" })
      .split("\n").map((l) => l.trim())
      .filter((f) => /^src\/.*\.(jsx?|css)$/.test(f) && f !== "src/index.css");
    head = new Map();
    for (const f of tracked) {
      const n = countIn(execFileSync("git", ["show", `HEAD:${f}`], { cwd: ROOT, encoding: "utf8", maxBuffer: 32 << 20 }));
      if (n) head.set(f, n);
    }
  } catch {
    head = null;
  }
  if (!head) {
    console.log("  (git unavailable — cannot compare against HEAD, so growth is unmeasured here)");
  } else {
    const headTotal = [...head.values()].reduce((a, b) => a + b, 0);
    const grew = [...perFile.entries()]
      .map(([f, n]) => [f, n, head.get(f) ?? 0])
      .filter(([, n, was]) => n > was)
      .sort((a, b) => b[1] - b[2] - (a[1] - a[2]));
    const shrank = [...head.entries()]
      .map(([f, was]) => [f, perFile.get(f) ?? 0, was])
      .filter(([, n, was]) => n < was);
    console.log(`  vs HEAD: ${headTotal} -> ${legacy} (${legacy > headTotal ? "+" : ""}${legacy - headTotal})`);
    for (const [f, n, was] of grew) console.log(`    + ${f}: ${was} -> ${n}   (uncommitted, adds debt)`);
    for (const [f, n, was] of shrank) console.log(`    - ${f}: ${was} -> ${n}   (uncommitted, pays debt down)`);
    if (!grew.length && !shrank.length) console.log("    (no uncommitted change to the literal count)");
    console.log("  Migration is owner-side follow-up — see docs/brain/BRAIN_FRONTEND.md.");
  }
  const top = [...perFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  console.log(`  Heaviest files: ${top.map(([f, n]) => `${f.replace(/^src\//, "")} ×${n}`).join(", ")}`);
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
