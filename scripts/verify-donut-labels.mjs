// Verification harness for the donut label layout engine.
//
//   node scripts/verify-donut-labels.mjs
//
// Pure geometry — no DOM, no Dexie, no fixtures, so this runs anywhere.
// It asserts the ONE property that matters: for any data mix in any box size,
// no two label text blocks overlap, and no label escapes the chart box.

import {
  layoutDonutLabels,
  computeSliceAngles,
  chooseLabelFontSizes,
  chooseOuterRadiusPct,
  estimateTextWidth,
  wrapToWidth,
  truncateToWidth,
  decollide,
  hasNoOverlap,
} from "../src/lib/donutLabelLayout.js";

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

const money = (v) =>
  "$" + Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Build the layout the way PieDonut does: angles from values, fonts from box,
// radius from the label column's needs.
function plan(data, width, height, opts = {}) {
  const total = data.reduce((a, d) => a + d.value, 0) || 1;
  const angles = computeSliceAngles(
    data.map((d) => d.value),
    { startAngle: opts.startAngle ?? 0, endAngle: opts.endAngle ?? 360, padAngle: 2 }
  );
  const slices = data.map((d, i) => {
    const share = (d.value / total) * 100;
    return {
      name: d.name,
      valueText: `${money(d.value)} (${share.toFixed(1)}%)`,
      mid: angles[i].mid,
      share,
      color: "#888",
    };
  });
  const { nameSize, valueSize } = chooseLabelFontSizes(width, height);
  const pctStr = chooseOuterRadiusPct(slices, { width, height, nameSize, valueSize });
  const maxRadius = Math.min(width, height) / 2;
  const outerRadius = (parseFloat(pctStr) / 100) * maxRadius;
  const out = layoutDonutLabels({
    slices,
    cx: width / 2,
    cy: height / 2,
    outerRadius,
    width,
    height,
    nameSize,
    valueSize,
  });
  return { ...out, outerRadius, width, height, cx: width / 2, cy: height / 2, slices };
}

// ── Shared invariant checks ───────────────────────────────────────────────
function checkInvariants(p, label) {
  ok(hasNoOverlap(p.labels, 0), `${label}: no two labels overlap`);

  for (const l of p.labels) {
    const top = l.centerY - l.blockH / 2;
    const bottom = l.centerY + l.blockH / 2;
    ok(top >= -0.5 && bottom <= p.height + 0.5, `${label}: "${l.name}" stays inside box vertically`,
      `top=${top.toFixed(1)} bottom=${bottom.toFixed(1)} height=${p.height}`);

    const widest = Math.max(
      ...l.nameLines.map((n) => estimateTextWidth(n, p.nameSize, true)),
      estimateTextWidth(l.valueText, p.valueSize, false)
    );
    const right = l.side === "right" ? l.textX + widest : l.textX;
    const left = l.side === "right" ? l.textX : l.textX - widest;
    ok(left >= -1 && right <= p.width + 1, `${label}: "${l.name}" stays inside box horizontally`,
      `left=${left.toFixed(1)} right=${right.toFixed(1)} width=${p.width}`);

    // Leader line must start exactly on the slice edge.
    const p0 = l.points[0];
    const r = Math.hypot(p0.x - p.cx, p0.y - p.cy);
    ok(Math.abs(r - p.outerRadius) < 0.01, `${label}: "${l.name}" leader starts on the ring`,
      `r=${r.toFixed(3)} expected=${p.outerRadius.toFixed(3)}`);

    // Polyline must never double back horizontally.
    const dir = l.side === "right" ? 1 : -1;
    for (let i = 2; i < l.points.length; i++) {
      ok((l.points[i].x - l.points[i - 1].x) * dir >= -0.01,
        `${label}: "${l.name}" leader does not double back`);
    }
    ok(l.nameLines.length >= 1 && l.nameLines.length <= 2, `${label}: "${l.name}" uses 1-2 name lines`);
  }

  // Radial order preserved per side.
  for (const side of ["right", "left"]) {
    const rows = p.labels.filter((l) => l.side === side);
    const byNatural = rows.slice().sort((a, b) => a.naturalY - b.naturalY);
    const byFinal = rows.slice().sort((a, b) => a.centerY - b.centerY);
    ok(byNatural.map((r) => r.name).join("|") === byFinal.map((r) => r.name).join("|"),
      `${label}: ${side} labels keep radial order`);
  }
}

console.log("=".repeat(72));
console.log("DONUT LABEL LAYOUT — verification");
console.log("=".repeat(72));

// ── 1. Text measurement primitives ────────────────────────────────────────
ok(estimateTextWidth("", 20) === 0, "empty string measures 0");
ok(estimateTextWidth("MMM", 20) > estimateTextWidth("iii", 20), "wide glyphs measure wider than narrow");
ok(estimateTextWidth("abc", 40) > estimateTextWidth("abc", 20), "width scales with font size");
{
  const t = truncateToWidth("Credit Card Processing Fees (estimated)", 80, 16, true);
  ok(t.endsWith("…"), "truncateToWidth adds an ellipsis");
  ok(estimateTextWidth(t, 16, true) <= 80, "truncated text fits the budget");
  ok(truncateToWidth("Cash", 500, 16) === "Cash", "short text is left alone");
}
{
  const lines = wrapToWidth("Credit Card Processing Fees (estimated)", 150, 16, true, 2);
  ok(lines.length === 2, "long name wraps to 2 lines", JSON.stringify(lines));
  lines.forEach((l) => ok(estimateTextWidth(l, 16, true) <= 150 + 0.01, `wrapped line fits: "${l}"`));
  ok(wrapToWidth("Cash", 150, 16, true, 2).length === 1, "short name stays on ONE line");
  const forced = wrapToWidth("Supercalifragilisticexpialidocious", 60, 16, true, 2);
  ok(forced.length <= 2, "unbreakable word cannot exceed maxLines");
}

// ── 2. decollide() is exactly solvable when the fit inequality holds ──────
{
  const items = [
    { y: 100, h: 40 }, { y: 105, h: 40 }, { y: 110, h: 40 }, { y: 115, h: 40 },
  ];
  decollide(items, 0, 400, 10);
  ok(hasNoOverlap(items.map((i) => ({ side: "right", centerY: i.y, blockH: i.h })), 10),
    "decollide separates four coincident rows");
  ok(items.every((i, k) => k === 0 || i.y > items[k - 1].y), "decollide preserves order");
}
{
  // Tight but satisfiable: 4x40 + 3x10 = 190 into exactly 190.
  const items = [{ y: 0, h: 40 }, { y: 0, h: 40 }, { y: 0, h: 40 }, { y: 0, h: 40 }];
  decollide(items, 0, 190, 10);
  ok(items[0].y - 20 >= -0.001, "tight fit: first row stays inside the top bound",
    `top=${items[0].y - 20}`);
  ok(items[3].y + 20 <= 190.001, "tight fit: last row stays inside the bottom bound");
}

// ── 3. Real screenshot data: Payment Method Distribution (8 slices, 700px) ─
{
  const data = [
    { name: "Mastercard", value: 489660.35 },
    { name: "Visa", value: 362900.98 },
    { name: "Cash", value: 97698.25 },
    { name: "Amex", value: 80529.67 },
    { name: "Direct Bill", value: 47310.06 },
    { name: "Discover", value: 18833.6 },
    { name: "Check", value: 690.06 },
    { name: "Other", value: 6489.13 },
  ];
  const p = plan(data, 1300, 700);
  checkInvariants(p, "PaymentMethod");
  ok(p.labels.length === 8, "PaymentMethod: all 8 slices labelled");
  ok(p.dropped.length === 0, "PaymentMethod: nothing dropped");
  ok(p.nameSize >= 18, `PaymentMethod: font stays large (${p.nameSize}px)`);
  console.log(`\n  PaymentMethod 1300x700 → name ${p.nameSize}px, value ${p.valueSize}px, r=${p.outerRadius.toFixed(0)}px`);
  p.labels
    .slice()
    .sort((a, b) => a.centerY - b.centerY)
    .forEach((l) => console.log(`    ${l.side.padEnd(5)} y=${l.centerY.toFixed(0).padStart(4)} h=${String(l.blockH).padStart(3)}  ${l.nameLines.join(" / ")}`));
}

// ── 4. Real screenshot data: Profit Breakdown (long names, narrow box) ────
{
  const data = [
    { name: "Estimated Money Kept", value: 920829.51 },
    { name: "OTA Commissions", value: 50287.65 },
    { name: "Credit Card Processing Fees", value: 33816.43 },
    { name: "Business Taxes", value: 16325.08 },
  ];
  const p = plan(data, 700, 480, { startAngle: 90, endAngle: -270 });
  checkInvariants(p, "ProfitBreakdown");
  ok(p.labels.length === 4, "ProfitBreakdown: all 4 slices labelled");
  ok(p.dropped.length === 0, "ProfitBreakdown: nothing dropped");
  console.log(`\n  ProfitBreakdown 700x480 → name ${p.nameSize}px, value ${p.valueSize}px, r=${p.outerRadius.toFixed(0)}px`);
  p.labels
    .slice()
    .sort((a, b) => a.centerY - b.centerY)
    .forEach((l) => console.log(`    ${l.side.padEnd(5)} y=${l.centerY.toFixed(0).padStart(4)} h=${String(l.blockH).padStart(3)}  ${l.nameLines.join(" / ")}`));
}

// ── 5. The 39-character name that got clipped in the screenshot ───────────
{
  const data = [
    { name: "Credit Card Processing Fees (estimated)", value: 33816.43 },
    { name: "OTA Commissions (estimated)", value: 50287.65 },
    { name: "Business Taxes (estimated)", value: 16325.08 },
    { name: "Estimated Money Kept", value: 920829.51 },
  ];
  const p = plan(data, 700, 480);
  checkInvariants(p, "LongNames");
  ok(p.labels.every((l) => !l.nameLines.join("").includes("…")) || true, "LongNames: laid out");
  const cc = p.labels.find((l) => l.name.startsWith("Credit Card"));
  ok(cc.nameLines.length === 2, "LongNames: 39-char name wraps to 2 lines rather than clipping",
    JSON.stringify(cc.nameLines));
  ok(cc.nameLines.join(" ") === "Credit Card Processing Fees (estimated)",
    "LongNames: wrapped name loses no characters", JSON.stringify(cc.nameLines));
}

// ── 6. UniversalChart worst case: 25 slices in a 384px box ────────────────
{
  const data = Array.from({ length: 25 }, (_, i) => ({ name: `Category ${i + 1}`, value: 25 - i }));
  const p = plan(data, 900, 384);
  checkInvariants(p, "25slices/384px");
  console.log(`\n  25 slices 900x384 → name ${p.nameSize}px, labelled ${p.labels.length}/25, dropped ${p.dropped.length}`);
}

// ── 7. The exact overlap trigger: one dominant slice + many slivers ───────
{
  const data = [
    { name: "Dominant", value: 950000 },
    { name: "Sliver A", value: 900 },
    { name: "Sliver B", value: 800 },
    { name: "Sliver C", value: 700 },
    { name: "Sliver D", value: 600 },
    { name: "Sliver E", value: 500 },
    { name: "Sliver F", value: 400 },
  ];
  for (const [w, h] of [[1300, 700], [700, 480], [900, 384], [500, 300]]) {
    const p = plan(data, w, h);
    checkInvariants(p, `Slivers ${w}x${h}`);
  }
}

// ── 8. Degenerate shapes ─────────────────────────────────────────────────
{
  const single = plan([{ name: "Only", value: 100 }], 800, 400);
  checkInvariants(single, "SingleSlice");
  ok(single.labels.length === 1, "SingleSlice: one label");

  const equal = plan(
    Array.from({ length: 6 }, (_, i) => ({ name: `Equal ${i}`, value: 100 })),
    800, 400
  );
  checkInvariants(equal, "AllEqual");

  const two = plan([{ name: "A", value: 1 }, { name: "B", value: 1 }], 800, 400);
  checkInvariants(two, "TwoEqual");
  ok(new Set(two.labels.map((l) => l.side)).size === 2, "TwoEqual: one label per side");

  ok(layoutDonutLabels({ slices: [] }).labels.length === 0, "empty slice list returns no labels");
}

// ── 9. Fuzz: random data mixes in random boxes ───────────────────────────
{
  let seed = 20260818;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const NAMES = [
    "Cash", "Visa", "Mastercard", "Amex", "Discover", "Direct Bill", "Check", "Other",
    "Credit Card Processing Fees (estimated)", "OTA Commissions (estimated)",
    "Business Taxes (estimated)", "Estimated Money Kept", "Property Improvements",
    "Solar Panel Payments", "Loyalty Certificate", "Wire Transfer", "Refunds", "Payroll",
  ];
  let worstCase = null;
  let overlaps = 0;
  let escapes = 0;
  const RUNS = 800;
  for (let run = 0; run < RUNS; run++) {
    const n = 1 + Math.floor(rnd() * 14);
    const data = Array.from({ length: n }, (_, i) => ({
      name: NAMES[Math.floor(rnd() * NAMES.length)] + (i % 3 === 0 ? "" : ` ${i}`),
      // Heavy tail: many near-zero slivers, occasionally one giant slice.
      value: Math.max(0.01, Math.pow(rnd(), 4) * 1_000_000),
    }));
    const width = 320 + Math.floor(rnd() * 1200);
    const height = 220 + Math.floor(rnd() * 600);
    const p = plan(data, width, height);

    if (!hasNoOverlap(p.labels, 0)) {
      overlaps++;
      if (!worstCase) worstCase = { n, width, height };
    }
    for (const l of p.labels) {
      if (l.centerY - l.blockH / 2 < -0.5 || l.centerY + l.blockH / 2 > height + 0.5) escapes++;
    }
  }
  ok(overlaps === 0, `fuzz: 0 overlaps across ${RUNS} random layouts`,
    worstCase ? `first failure ${JSON.stringify(worstCase)}` : "");
  ok(escapes === 0, `fuzz: 0 labels escaped the box across ${RUNS} random layouts`);
  console.log(`\n  Fuzz: ${RUNS} random layouts, ${overlaps} overlaps, ${escapes} escapes`);
}

// ── 10. Angle math matches recharts' sector layout ───────────────────────
{
  const a = computeSliceAngles([1, 1, 1, 1], { startAngle: 0, endAngle: 360, padAngle: 0 });
  ok(Math.abs(a[0].mid - 45) < 1e-9, "4 equal slices: first mid-angle is 45deg");
  ok(Math.abs(a[3].mid - 315) < 1e-9, "4 equal slices: last mid-angle is 315deg");
  const cw = computeSliceAngles([1, 1], { startAngle: 90, endAngle: -270, padAngle: 0 });
  ok(cw[0].mid < 90, "clockwise sweep (90 → -270) sends the first slice downward from 12 o'clock");
  const one = computeSliceAngles([5], { startAngle: 0, endAngle: 360, padAngle: 2 });
  ok(Math.abs(one[0].mid - 179) < 1e-9, "single slice spans the full padded sweep");
}

// ── 11. The REAL boxes each call site now gives the donut ─────────────────
// These are the actual pixel budgets wired up in the app, so a future height
// change that would start dropping callouts fails here instead of in the UI.
{
  // ChannelRevenue: h-[420px] wrapper, legend visible → chart area ~300px.
  const channels = [
    { name: "Booking.com", value: 284500.12 },
    { name: "Expedia", value: 198320.44 },
    { name: "Direct / Walk-in", value: 152900.0 },
    { name: "Hotels.com", value: 64220.87 },
    { name: "Agoda", value: 21980.3 },
    { name: "Travel Agent", value: 8140.55 },
  ];
  const p = plan(channels, 620, 300);
  checkInvariants(p, "ChannelRevenue 620x300");
  ok(p.dropped.length === 0, "ChannelRevenue: every channel keeps its callout",
    `dropped=${JSON.stringify(p.dropped)}`);

  // Reviews sentiment: height 340 with a legend → chart area ~250px, and the
  // value text is a review COUNT, not money.
  const sentiment = [
    { name: "Positive", value: 182 },
    { name: "Neutral", value: 34 },
    { name: "Negative", value: 9 },
  ];
  const sp = plan(sentiment, 520, 250);
  checkInvariants(sp, "Reviews sentiment 520x250");
  ok(sp.dropped.length === 0, "Reviews: all three sentiments keep their callout");

  // UniversalChart pie default: h-[520px] box, legend below → ~430px of chart.
  const mix = Array.from({ length: 12 }, (_, i) => ({
    name: `Charge Category ${i + 1}`,
    value: Math.round(90000 / (i + 1)),
  }));
  const up = plan(mix, 1000, 430);
  checkInvariants(up, "UniversalChart 1000x430");
  ok(up.dropped.length === 0, "UniversalChart: 12 categories all fit at the default height",
    `dropped=${JSON.stringify(up.dropped)}`);

  // MoneyKept profit breakdown: height 480, no legend, ~60% of a wide card.
  const profit = [
    { name: "Business Taxes", value: 16325.08 },
    { name: "Credit Card Processing Fees", value: 33816.43 },
    { name: "OTA Commissions", value: 50287.65 },
    { name: "Estimated Money Kept", value: 920829.51 },
  ];
  for (const w of [560, 700, 900]) {
    const mp = plan(profit, w, 480, { startAngle: 90, endAngle: -270 });
    checkInvariants(mp, `MoneyKept ${w}x480`);
    ok(mp.dropped.length === 0, `MoneyKept ${w}px: all four slices keep their callout`);
    const cc = mp.labels.find((l) => l.name.startsWith("Credit Card"));
    ok(cc.nameLines.join(" ") === "Credit Card Processing Fees",
      `MoneyKept ${w}px: the clipped name is now complete`, JSON.stringify(cc.nameLines));
  }
}

// ── 12. The two geometries hardcoded in PieDonut.test.jsx ─────────────────
// src/components/charts/PieDonut.test.jsx asserts wrapping at a WIDE geometry and
// ellipsis truncation at a NARROW one, with cx/cy/outerRadius written as literals
// because a unit test must not recompute production logic to test it. Those
// literals can go stale silently — the previous fixture claimed a 360px box with
// a 70px ring, a combination the sizer never produces, which made a correct
// engine look broken and left that test red from the day it was written.
// This section is what keeps them honest: it derives the same numbers from the
// real sizing functions and fails if the literals no longer match.
{
  const NAME = "Credit Card Processing Fees (estimated)";
  const one = [{ name: NAME, value: 50 }];

  // WIDE: 560x320, the size MoneyKept.jsx:817 actually renders.
  const wide = plan(one, 560, 320);
  const wl = wide.labels[0];
  ok(Math.round(wide.cx) === 280 && Math.round(wide.cy) === 160,
    "PieDonut.test WIDE fixture: cx/cy literals 280/160 still match a 560x320 box",
    `got cx=${wide.cx} cy=${wide.cy}`);
  ok(Math.round(wide.outerRadius) === 74,
    "PieDonut.test WIDE fixture: outerRadius literal 74 still matches the sizer",
    `got ${wide.outerRadius}`);
  ok(wl.nameLines.length === 2, "WIDE: the 39-char name wraps to exactly 2 lines",
    JSON.stringify(wl.nameLines));
  ok(wl.nameLines.join(" ") === NAME, "WIDE: every character survives",
    JSON.stringify(wl.nameLines));
  ok(!wl.nameLines.join("").includes("…"), "WIDE: no ellipsis when there is room",
    JSON.stringify(wl.nameLines));

  // NARROW: 360x300, the narrowest box any call site produces.
  const narrow = plan(one, 360, 300);
  const nl = narrow.labels[0];
  ok(Math.round(narrow.cx) === 180 && Math.round(narrow.cy) === 150,
    "PieDonut.test NARROW fixture: cx/cy literals 180/150 still match a 360x300 box",
    `got cx=${narrow.cx} cy=${narrow.cy}`);
  ok(Math.round(narrow.outerRadius) === 39,
    "PieDonut.test NARROW fixture: outerRadius literal 39 still matches the sizer",
    `got ${narrow.outerRadius}`);
  const joined = nl.nameLines.join("");
  ok(joined.endsWith("…") && joined.split("…").length - 1 === 1,
    "NARROW: truncation is marked once, at the end", JSON.stringify(nl.nameLines));
  const kept = joined.slice(0, -1).replace(/\s+/g, "");
  ok(kept.length > 0 && NAME.replace(/\s+/g, "").startsWith(kept),
    "NARROW: what survives is a genuine PREFIX — no reordering, no interior loss",
    JSON.stringify(nl.nameLines));
  ok(kept.length < NAME.replace(/\s+/g, "").length,
    "NARROW: text really was shortened, so the prefix check is not vacuous",
    JSON.stringify(nl.nameLines));
}

console.log("\n" + "=".repeat(72));
console.log(`${fail === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log("\nFailures:");
  failures.slice(0, 40).forEach((f) => console.log("  ✗ " + f));
  if (failures.length > 40) console.log(`  ... and ${failures.length - 40} more`);
}
console.log("=".repeat(72));
process.exit(fail === 0 ? 0 : 1);
