// Donut label layout engine — pure geometry, no React and no DOM.
//
// PROBLEM THIS SOLVES
// A donut label placed at its slice's own angle sits at
// y = cy + r * sin(angle). Two slices that are small and adjacent have almost
// the same angle, so their labels land at almost the same y and the text
// collides. Lengthening the leader line does NOT fix this: moving a label
// further out along the same radius barely changes its y, so the text stays at
// the same height and still overlaps. (That was the old "staggered offsets"
// approach — 35/80/125px tiers — and it is why tiny adjacent slices such as
// Check 0.1% / Other 0.6% / Discover 1.7% still ran into each other.)
//
// THE FIX
// Labels keep their side (left/right) and their vertical ORDER, but their y is
// then pushed apart until every text block clears its neighbour by `rowGap`.
// The leader line becomes a 3-segment polyline (radial stub → diagonal →
// short horizontal run) so it still visibly ties the moved label to its slice.
//
// WHY IT CANNOT OVERLAP
// `fitFontSize` guarantees `sum(blockHeights) + rowGap * (n - 1) <= available`
// for each side before any placement happens — shrinking the font, then
// wrapping names, then (last resort) dropping the smallest labels until that
// inequality holds. `decollide` is then a standard two-pass sweep, which is
// exactly solvable whenever that inequality holds. See decollide() for the
// argument. Overlap is therefore impossible for ANY data mix.

const RAD = Math.PI / 180;

// ── Text measurement ──────────────────────────────────────────────────────
// Advance widths as a fraction of font size, for the app's sans-serif UI font
// (Inter / system-ui). Only used to budget horizontal room, so per-character
// averages are accurate enough — and far better than a flat "n * 0.5" guess,
// which badly misjudges strings like "$1,250,000.00 (44.3%)" that are mostly
// digits and punctuation.
const NARROW = new Set([" ", ",", ".", "'", "`", "|", "!", "i", "j", "l", "t", "f", "I", "(", ")", "[", "]", "-", "/", ":", ";"]);
const WIDE = new Set(["%", "@", "m", "M", "W", "w", "—", "–"]);

function charWidthEm(ch) {
  if (NARROW.has(ch)) return 0.3;
  if (WIDE.has(ch)) return 0.84;
  if (ch >= "0" && ch <= "9") return 0.56; // tabular figures
  if (ch === "$") return 0.56;
  if (ch >= "A" && ch <= "Z") return 0.68;
  return 0.53; // lowercase and anything else
}

/** Estimated rendered width of `text` in px. */
export function estimateTextWidth(text, fontSize, bold = false) {
  const s = String(text ?? "");
  let em = 0;
  for (const ch of s) em += charWidthEm(ch);
  return em * Number(fontSize || 0) * (bold ? 1.045 : 1);
}

/** Shorten `text` with a trailing ellipsis until it fits `maxWidth`. */
export function truncateToWidth(text, maxWidth, fontSize, bold = false) {
  const s = String(text ?? "");
  if (estimateTextWidth(s, fontSize, bold) <= maxWidth) return s;
  let out = s;
  while (out.length > 1 && estimateTextWidth(out + "…", fontSize, bold) > maxWidth) {
    out = out.slice(0, -1);
  }
  return out.replace(/[\s,.:;-]+$/, "") + "…";
}

/** Greedy word-wrap with no truncation. May return more than `maxLines` lines. */
function greedyLines(text, maxWidth, fontSize, bold) {
  const words = String(text ?? "").trim().split(/\s+/);
  const lines = [];
  let line = "";
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (!line || estimateTextWidth(next, fontSize, bold) <= maxWidth) line = next;
    else {
      lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

/**
 * Narrowest column width in which `text` greedy-wraps into at most `maxLines`
 * lines with nothing truncated. Binary search, because greedy wrapping is not
 * balanced — "Credit Card Processing Fees (estimated)" packs line 1 full and
 * then overflows line 2, so simply halving the single-line width is too
 * optimistic. Used to decide how much room the ring must give back.
 */
export function minWidthForLines(text, fontSize, bold = false, maxLines = 2) {
  const s = String(text ?? "").trim();
  const full = estimateTextWidth(s, fontSize, bold);
  if (maxLines <= 1 || !s) return full;
  // The widest single word can never be broken, so it is a hard floor.
  let lo = 1;
  for (const w of s.split(/\s+/)) lo = Math.max(lo, Math.ceil(estimateTextWidth(w, fontSize, bold)));
  let hi = Math.max(lo, Math.ceil(full));
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (greedyLines(s, mid, fontSize, bold).length <= maxLines) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * Greedy word-wrap into at most `maxLines` lines that each fit `maxWidth`.
 * Overflow beyond the last allowed line is ellipsis-truncated, so a label can
 * never silently run outside the chart box.
 */
export function wrapToWidth(text, maxWidth, fontSize, bold = false, maxLines = 2) {
  const s = String(text ?? "").trim();
  if (!s) return [""];
  if (estimateTextWidth(s, fontSize, bold) <= maxWidth) return [s];
  if (maxLines <= 1) return [truncateToWidth(s, maxWidth, fontSize, bold)];

  const lines = greedyLines(s, maxWidth, fontSize, bold);
  if (lines.length <= maxLines) {
    // A single over-long word can still exceed the budget; clip just that line.
    return lines.map((l) => truncateToWidth(l, maxWidth, fontSize, bold));
  }
  const keep = lines.slice(0, maxLines - 1);
  keep.push(truncateToWidth(lines.slice(maxLines - 1).join(" "), maxWidth, fontSize, bold));
  return keep;
}

// ── Slice angles ──────────────────────────────────────────────────────────
/**
 * Replicate recharts' sector layout so we know each slice's mid-angle without
 * waiting for a render. `padAngle` must match <Pie paddingAngle>.
 */
export function computeSliceAngles(values, { startAngle = 0, endAngle = 360, padAngle = 2 } = {}) {
  const nums = (values || []).map((v) => Number(v) || 0);
  const total = nums.reduce((a, v) => a + v, 0) || 1;
  const n = nums.length;
  const sign = Math.sign(endAngle - startAngle) || 1;
  const absSweep = Math.min(Math.abs(endAngle - startAngle), 360);
  const sweep = absSweep - (absSweep >= 360 ? n : Math.max(0, n - 1)) * padAngle;
  let prev = startAngle;
  return nums.map((v, i) => {
    const s = i === 0 ? startAngle : prev + sign * padAngle;
    const e = s + sign * ((v / total) * sweep);
    prev = e;
    return { start: s, end: e, mid: (s + e) / 2 };
  });
}

// ── Ring sizing ───────────────────────────────────────────────────────────
/**
 * Pick the donut's outer radius as a PERCENTAGE of min(width,height)/2, giving
 * back however much room the widest label column actually needs. This is what
 * stops a long name like "Credit Card Processing Fees (estimated)" from being
 * clipped at the box edge: the ring yields space instead of the text.
 * Returns a string such as "41%" so the pie still scales with its box.
 */
export function chooseOuterRadiusPct(labels, opts = {}) {
  const {
    width = 0, height = 0, nameSize = 16, valueSize = 14,
    maxPct = 46, minPct = 26, stub = 18, shelf = 16, textPad = 8, maxNameLines = 2,
  } = opts;
  const maxRadius = Math.min(Number(width) || 0, Number(height) || 0) / 2;
  if (!(maxRadius > 0)) return `${maxPct}%`;

  let need = 0;
  for (const l of labels || []) {
    // Exact narrowest column that fits the name in `maxNameLines` lines with
    // nothing clipped; the value line never wraps, so it sets a hard floor.
    const nameNeed = minWidthForLines(l.name, nameSize, true, maxNameLines);
    need = Math.max(need, nameNeed, estimateTextWidth(l.valueText, valueSize, false));
  }

  const room = Number(width) / 2 - need - stub - shelf - textPad;
  const pct = (Math.max(0, room) / maxRadius) * 100;
  return `${Math.round(Math.min(maxPct, Math.max(minPct, pct)))}%`;
}

/** Font sizes scaled to the box — big in a tall card, still legible in a small one. */
export function chooseLabelFontSizes(width, height, { min = 12, max = 22, divisor = 24 } = {}) {
  const box = Math.min(Number(width) || 0, Number(height) || 0);
  const nameSize = Math.round(Math.min(max, Math.max(min, box / divisor)));
  return { nameSize, valueSize: Math.max(min - 1, Math.round(nameSize * 0.86)) };
}

// ── Vertical de-collision ─────────────────────────────────────────────────
/**
 * Push a side's label blocks apart, in place, preserving their order.
 * `items` must be sorted by y ascending; each is { y (centre), h (height) }.
 *
 * Correctness: pass 1 makes every gap >= rowGap, so the only way to fail is
 * running past `bottom`. Pass 2 pins the last block to `bottom` and walks
 * upward. The topmost block then ends at
 *   bottom - (sum(h) - h[0]/2 + rowGap*(n-1))
 * which is >= top exactly when sum(h) + rowGap*(n-1) <= bottom - top. The
 * caller guarantees that inequality via fitFontSize(), so pass 2 always fits.
 */
export function decollide(items, top, bottom, rowGap) {
  const n = items.length;
  if (!n) return items;

  items[0].y = Math.max(items[0].y, top + items[0].h / 2);
  for (let i = 1; i < n; i++) {
    const minY = items[i - 1].y + items[i - 1].h / 2 + rowGap + items[i].h / 2;
    if (items[i].y < minY) items[i].y = minY;
  }

  const last = items[n - 1];
  if (last.y + last.h / 2 > bottom) {
    last.y = bottom - last.h / 2;
    for (let i = n - 2; i >= 0; i--) {
      const maxY = items[i + 1].y - items[i + 1].h / 2 - rowGap - items[i].h / 2;
      if (items[i].y > maxY) items[i].y = maxY;
    }
  }
  return items;
}

// ── Main entry point ──────────────────────────────────────────────────────
/**
 * A slice as the caller describes it: pre-formatted text plus its mid-angle.
 * @typedef {object} DonutSlice
 * @property {string} name          Category name (may be wrapped onto 2 lines).
 * @property {string} valueText     Pre-formatted "$1,234.00 (12.3%)" — never wrapped.
 * @property {number} mid           Slice mid-angle in degrees, recharts' convention.
 * @property {number} [share]       Percent of total; smallest are dropped first.
 * @property {string} [color]       Leader line / dot colour.
 * @property {number} [sliceIndex]  Caller's own index, echoed back untouched.
 */

/**
 * Lay out every donut label so that no two text blocks overlap.
 *
 * @param {object} o
 * @param {DonutSlice[]} [o.slices]      Slices to label, in data order.
 * @param {number} [o.cx]                Pie centre x, in px.
 * @param {number} [o.cy]                Pie centre y, in px.
 * @param {number} [o.outerRadius]       Ring outer radius, in px.
 * @param {number} [o.width]             Chart box width, in px.
 * @param {number} [o.height]            Chart box height, in px.
 * @param {number} [o.nameSize]          Preferred name font size; may be scaled down.
 * @param {number} [o.valueSize]         Preferred value font size.
 * @param {number} [o.maxNameLines]      Max lines a name may wrap onto (default 2).
 * @param {number} [o.stub]              Radial leader stub length, in px.
 * @param {number} [o.shelf]             Gap between stub and the text column.
 * @param {number} [o.textPad]           Gap between the anchor dot and the text.
 * @param {number} [o.hRun]              Length of the final horizontal leader run.
 * @param {number} [o.rowGap]            Minimum clear space between two blocks.
 * @param {number} [o.edgePad]           Keep-out margin at the top/bottom of the box.
 * @param {number} [o.minNameSize]       Floor for the name font size.
 * @returns {{ nameSize:number, valueSize:number, labels:Array<any>, dropped?:string[] }}
 */
export function layoutDonutLabels(o) {
  const {
    slices = [],
    cx = 0, cy = 0, outerRadius = 0,
    width = 0, height = 0,
    nameSize: baseNameSize = 16,
    valueSize: baseValueSize = 14,
    maxNameLines = 2,
    stub = 18, shelf = 16, textPad = 8, hRun = 10,
    rowGap = 10, edgePad = 4, minNameSize = 11,
  } = o;

  if (!slices.length) return { nameSize: baseNameSize, valueSize: baseValueSize, labels: [] };

  const sideOf = (mid) => (Math.cos(-mid * RAD) >= 0 ? "right" : "left");
  const anchorXFor = (side) =>
    side === "right" ? cx + outerRadius + stub + shelf : cx - outerRadius - stub - shelf;
  const budgetFor = (side) =>
    side === "right" ? width - anchorXFor("right") - textPad : anchorXFor("left") - textPad;

  const available = Math.max(0, height - 2 * edgePad);

  // Build the text blocks for a candidate font size / wrap allowance.
  const build = (ns, vs, lines) =>
    slices.map((s, i) => {
      const side = sideOf(s.mid);
      const budget = Math.max(24, budgetFor(side));
      const nameLines = wrapToWidth(s.name, budget, ns, true, lines);
      const lineH = Math.round(ns * 1.28);
      const valueH = Math.round(vs * 1.42);
      return {
        ...s,
        index: i,
        side,
        nameLines,
        lineH,
        valueLineH: valueH,
        h: nameLines.length * lineH + valueH,
        naturalY: cy + (outerRadius + stub) * Math.sin(-s.mid * RAD),
        dropped: false,
      };
    });

  const heightsFit = (blocks) =>
    ["right", "left"].every((side) => {
      const side_ = blocks.filter((b) => b.side === side && !b.dropped);
      if (!side_.length) return true;
      const need = side_.reduce((a, b) => a + b.h, 0) + rowGap * (side_.length - 1);
      return need <= available;
    });

  // No name lost a character to the ellipsis. Horizontal fit has to be part of
  // the sizing decision too: with a long name in a narrow column the ring can
  // only give back so much room before hitting its floor, and past that point
  // the font — not the text — must yield.
  const norm = (s) => String(s ?? "").trim().replace(/\s+/g, " ");
  const widthsFit = (blocks) =>
    blocks.every((b) => b.dropped || norm(b.nameLines.join(" ")) === norm(b.name));

  // Wrapping is decided per name by HORIZONTAL room: wrapToWidth() returns a
  // single line whenever the name fits its column, and only breaks onto a
  // second line when it would otherwise overflow.
  let blocks = null;
  let nameSize = baseNameSize;
  let valueSize = baseValueSize;
  for (const scale of [1, 0.94, 0.88, 0.82, 0.76, 0.7]) {
    const ns = Math.max(minNameSize, Math.round(baseNameSize * scale));
    const vs = Math.max(minNameSize - 2, Math.round(baseValueSize * scale));
    blocks = build(ns, vs, maxNameLines);
    nameSize = ns;
    valueSize = vs;
    if (heightsFit(blocks) && widthsFit(blocks)) break;
  }

  // Still too tall at the smallest size: drop the least significant labels
  // (smallest share first) until the remainder provably fits. Dropped slices
  // keep their slice, tooltip and legend entry — only the callout goes.
  if (!heightsFit(blocks)) {
    for (const side of ["right", "left"]) {
      const order = blocks
        .filter((b) => b.side === side)
        .sort((a, b) => (a.share ?? 0) - (b.share ?? 0));
      for (const victim of order) {
        if (heightsFit(blocks)) break;
        victim.dropped = true;
      }
    }
  }

  // Place each side independently: sort by the slice's own vertical position,
  // then push apart. Sorting by naturalY keeps labels in radial order.
  const placed = [];
  for (const side of ["right", "left"]) {
    const items = blocks
      .filter((b) => b.side === side && !b.dropped)
      .sort((a, b) => a.naturalY - b.naturalY)
      .map((b) => ({ ...b, y: b.naturalY }));
    decollide(items, edgePad, height - edgePad, rowGap);
    placed.push(...items);
  }

  const labels = placed.map((b) => {
    const dir = b.side === "right" ? 1 : -1;
    const anchorX = anchorXFor(b.side);
    const cos = Math.cos(-b.mid * RAD);
    const sin = Math.sin(-b.mid * RAD);

    const p0 = { x: cx + outerRadius * cos, y: cy + outerRadius * sin };
    const p1 = { x: cx + (outerRadius + stub) * cos, y: cy + (outerRadius + stub) * sin };
    // Start of the horizontal run. Clamped so the polyline never doubles back
    // on itself when the stub already reached past the shelf.
    const runX = dir > 0 ? Math.max(p1.x, anchorX - hRun) : Math.min(p1.x, anchorX + hRun);
    const p2 = { x: runX, y: b.y };
    const p3 = { x: anchorX, y: b.y };

    return {
      name: b.name,
      index: b.index,
      sliceIndex: b.sliceIndex,
      valueText: b.valueText,
      color: b.color,
      share: b.share,
      side: b.side,
      nameLines: b.nameLines,
      lineH: b.lineH,
      valueLineH: b.valueLineH,
      blockH: b.h,
      centerY: b.y,
      naturalY: b.naturalY,
      // First name line's text baseline, derived from the block centre.
      firstBaselineY: b.y - b.h / 2 + Math.round(nameSize * 1.0),
      textX: anchorX + dir * textPad,
      textAnchor: b.side === "right" ? "start" : "end",
      dotX: anchorX,
      dotY: b.y,
      points: [p0, p1, p2, p3],
    };
  });

  return {
    nameSize,
    valueSize,
    labels,
    dropped: blocks.filter((b) => b.dropped).map((b) => b.name),
  };
}

/** True when no two laid-out labels overlap vertically on the same side. */
export function hasNoOverlap(labels, rowGap = 0) {
  for (const side of ["right", "left"]) {
    const rows = labels
      .filter((l) => l.side === side)
      .sort((a, b) => a.centerY - b.centerY);
    for (let i = 1; i < rows.length; i++) {
      const prevBottom = rows[i - 1].centerY + rows[i - 1].blockH / 2;
      const top = rows[i].centerY - rows[i].blockH / 2;
      if (top < prevBottom + rowGap - 0.001) return false;
    }
  }
  return true;
}
