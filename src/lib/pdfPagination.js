/**
 * Page geometry for the PDF exporter.
 *
 * Deliberately dependency-free. `pdfExport.js` imports jsPDF and html2canvas,
 * neither of which loads under plain Node, so the arithmetic that decides where
 * one page ends and the next begins lives here, where
 * scripts/probe-pdf-pagination.mjs can execute it directly.
 *
 * Every length is in canvas pixels unless the name says otherwise.
 */

// Canvas coordinates arrive from getBoundingClientRect(), so they are fractional.
// Half a pixel of slack keeps a block whose bottom edge lands on 296.9999999 from
// being treated as straddling a cut at 297.
const EPS = 0.5;

// Chrome refuses a canvas whose width or height exceeds 16384px; Safari caps the
// total area near 16.7M px. html2canvas does not check either, it just hands back
// a blank canvas, which is how a long page currently exports as an empty PDF.
const MAX_CANVAS_DIM = 16384;
const MAX_CANVAS_AREA = 16777216;

// Smallest fraction of a page a break may advance. It bounds the page count and
// stops a cluster of thin blocks producing a document of near-empty pages.
const MIN_ADVANCE = 0.05;

/**
 * Largest render scale that still produces a canvas every browser will allocate.
 *
 * Returns `desired` when the element is small enough, and a reduced scale when it
 * is not. A slightly softer PDF is the correct trade against a blank one.
 *
 * @param {number} widthPx CSS width of the element being rendered
 * @param {number} heightPx CSS height of the element being rendered
 * @param {number} [desired] scale we would use if there were no limit
 * @param {number} [maxDim] per-axis pixel ceiling
 * @param {number} [maxArea] total pixel ceiling
 * @returns {number} scale in (0, desired]
 */
export function safeCanvasScale(
  widthPx,
  heightPx,
  desired = 2,
  maxDim = MAX_CANVAS_DIM,
  maxArea = MAX_CANVAS_AREA,
) {
  const w = Number(widthPx);
  const h = Number(heightPx);
  const want = Number.isFinite(desired) && desired > 0 ? desired : 1;
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return want;

  const byDim = Math.min(maxDim / w, maxDim / h);
  const byArea = Math.sqrt(maxArea / (w * h));
  return Math.min(want, byDim, byArea);
}

/**
 * Where each PDF page starts, in canvas pixels.
 *
 * The exporter used to advance by exactly one page height every time, so a page
 * boundary fell wherever it happened to fall: through the middle of a row of
 * text, a KPI card, or a chart. This picks boundaries that fall BETWEEN blocks
 * instead, by treating the top and bottom edge of every block as a candidate and
 * taking the lowest-risk one that still fits on the page.
 *
 * A block taller than a single page cannot be kept whole, so it is cut at the
 * page limit — the same behaviour as before, but now only where it is genuinely
 * unavoidable.
 *
 * @param {number} contentHeight total canvas height
 * @param {number} pageHeight how much canvas height fits on one page
 * @param {Array<{top:number,bottom:number}>} [blocks] intervals that must not be
 *   divided, in canvas pixels relative to the top of the content. May overlap
 *   and may arrive in any order.
 * @param {number} [minFill] preferred minimum fill fraction for a page; clamped
 *   to [0.05, 0.9]. It is a preference, not a guarantee — see the fallback below.
 * @returns {number[]} strictly increasing offsets, always starting at 0. Page i
 *   covers [result[i], result[i + 1]), and the last page runs to contentHeight.
 */
export function computePageBreaks(contentHeight, pageHeight, blocks = [], minFill = 0.2) {
  const total = Number(contentHeight);
  const page = Number(pageHeight);
  const cuts = [0];
  if (!Number.isFinite(total) || !Number.isFinite(page) || total <= 0 || page <= 0) {
    return cuts;
  }

  const fill = Math.min(0.9, Math.max(0.05, Number.isFinite(minFill) ? minFill : 0.2));

  // Only finite intervals are usable, and a zero-height block contributes a
  // candidate that equals its own top — harmless, because candidates at or below
  // the current offset are rejected below.
  const safe = [];
  const edges = [];
  for (const b of blocks || []) {
    const top = Number(b && b.top);
    const bottom = Number(b && b.bottom);
    if (!Number.isFinite(top) || !Number.isFinite(bottom) || bottom < top) continue;
    safe.push({ top, bottom });
    edges.push(top, bottom);
  }
  edges.sort((a, z) => a - z);

  // Which blocks a cut at `y` would divide. A cut divides a block when it lands
  // strictly inside it, so sibling cards sharing a row edge are fine; staggered
  // blocks are why every candidate is checked against every block rather than
  // trusted because it happens to be an edge.
  const dividedAt = (y) => safe.filter((b) => b.top < y - EPS && b.bottom > y + EPS);

  let cur = 0;
  // Every iteration advances by at least MIN_ADVANCE * page, which bounds the
  // page count. The guard is belt-and-braces against a future edit breaking that
  // property; section 8 of the probe asserts it is never what stops the loop.
  const guard = Math.ceil(total / (page * MIN_ADVANCE)) + 4;
  for (let i = 0; i < guard && total - cur > page + EPS; i += 1) {
    const limit = cur + page;
    const floor = cur + page * fill;
    const nearest = cur + page * MIN_ADVANCE;

    let best = 0; // best safe edge that also fills the page acceptably
    let fallback = 0; // best safe edge below the fill floor, still a real advance
    for (const y of edges) {
      if (y > limit + EPS) break; // sorted, so nothing further can fit
      if (y <= cur + EPS) continue;
      if (dividedAt(y).length) continue;
      if (y > floor) {
        if (y > best) best = y;
      } else if (y >= nearest && y > fallback) {
        fallback = y;
      }
    }

    let next;
    if (best > cur + EPS) {
      next = Math.min(best, limit);
    } else {
      // Nothing safe fills the page. Cutting at the hard limit is correct when it
      // damages nothing, and when everything it would divide is taller than a
      // page anyway (that block gets sliced whatever we choose, so spending a
      // short page to postpone the slice buys nothing). Otherwise a block that
      // WOULD have fitted is about to be cut in half — accept the short page.
      const casualties = dividedAt(limit);
      const unavoidable =
        casualties.length === 0 || casualties.every((b) => b.bottom - b.top > page + EPS);
      next = !unavoidable && fallback > cur + EPS ? fallback : limit;
    }
    cuts.push(next);
    cur = next;
  }
  return cuts;
}
