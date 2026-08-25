import jsPDF from "jspdf";
import html2canvas from "html2canvas";
import { computePageBreaks, safeCanvasScale } from "./pdfPagination.js";

// This exporter used to render the page to one tall canvas and then place that
// same canvas on every page at a negative offset, stepping by exactly one page
// height each time. The page boundary therefore fell wherever the arithmetic put
// it — through a line of text, a KPI card, or a chart — and the reader lost the
// row that straddled the seam. Now the boundaries are chosen to fall between
// blocks (src/lib/pdfPagination.js) and each page is drawn from its own crop.
//
// Two things measured while changing it, so they do not get "optimised" back:
//
//   * jsPDF 4.2.1 deduplicates identical image data — the old code embedded ONE
//     image no matter how many pages referenced it (measured: 1 XObject, not 5).
//     Cropping per page is done because the bands are no longer uniform, NOT to
//     save bytes. It does not save bytes.
//   * html2canvas 1.4.1 does not check browser canvas limits, so a long page used
//     to come back blank and export as an empty PDF. safeCanvasScale clamps.

// Most printers reserve a few millimetres they physically cannot mark. The old
// code drew from 0,0 at full page width, so the outer edge was clipped on paper.
const MARGIN_MM = 6;
const BACKGROUND = "#040D1A";
const JPEG_QUALITY = 0.92;
// Descend into a block once it occupies most of a page, so a long table gives up
// its rows instead of being one indivisible slab. Six levels reaches <tr> from a
// section wrapper with room to spare.
const SPLIT_AT = 0.9;
const MAX_DEPTH = 6;

/**
 * Intervals a page break must not divide, in canvas pixels measured from the top
 * of `root`.
 *
 * @param {HTMLElement} root element being exported
 * @param {number} scale canvas pixels per CSS pixel
 * @param {number} maxHeightPx how much canvas height fits on one page
 * @returns {Array<{top:number,bottom:number}>}
 */
function collectBlocks(root, scale, maxHeightPx) {
  const originY = root.getBoundingClientRect().top;
  const out = [];
  const visit = (el, depth) => {
    for (const child of el.children) {
      const rect = child.getBoundingClientRect();
      if (rect.height <= 0) continue; // hidden, collapsed, or zero-height
      const top = (rect.top - originY) * scale;
      const bottom = (rect.bottom - originY) * scale;
      if (bottom - top > maxHeightPx * SPLIT_AT && child.children.length && depth < MAX_DEPTH) {
        visit(child, depth + 1);
      } else {
        out.push({ top, bottom });
      }
    }
  };
  visit(root, 0);
  return out;
}

export async function exportToPdf(element, fileName = "executive-summary.pdf") {
  if (!element) throw new Error("No content to export");

  const scale = safeCanvasScale(element.scrollWidth, element.scrollHeight, 2);
  const canvas = await html2canvas(element, {
    backgroundColor: BACKGROUND,
    scale,
    useCORS: true,
    logging: false,
    windowWidth: element.scrollWidth,
  });
  // A canvas over the browser's limit comes back empty rather than throwing. Say
  // so instead of saving a blank PDF the operator would only discover on paper.
  if (!canvas.width || !canvas.height) {
    throw new Error("This page is too long to render for export");
  }

  const pdf = new jsPDF("p", "mm", "a4");
  const usableWidthMm = pdf.internal.pageSize.getWidth() - MARGIN_MM * 2;
  const usableHeightMm = pdf.internal.pageSize.getHeight() - MARGIN_MM * 2;
  const pxPerMm = canvas.width / usableWidthMm;
  const pageHeightPx = usableHeightMm * pxPerMm;

  const breaks = computePageBreaks(
    canvas.height,
    pageHeightPx,
    collectBlocks(element, scale, pageHeightPx),
  );

  const crop = document.createElement("canvas");
  const ctx = crop.getContext("2d");
  for (let i = 0; i < breaks.length; i += 1) {
    // Round to whole source pixels so consecutive pages stay exactly contiguous:
    // page i ends on the pixel page i + 1 begins with, no seam and no repeat.
    const top = Math.round(breaks[i]);
    const next = Math.min(canvas.height, Math.round(i + 1 < breaks.length ? breaks[i + 1] : canvas.height));
    const height = next - top;
    if (height <= 0) continue;

    crop.width = canvas.width;
    crop.height = height;
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, crop.width, crop.height);
    ctx.drawImage(canvas, 0, top, canvas.width, height, 0, 0, canvas.width, height);

    if (i > 0) pdf.addPage();
    // A short final page draws at its true height, leaving the rest of the sheet
    // blank — stretching it to fill the page would distort the chart aspect.
    pdf.addImage(
      crop.toDataURL("image/jpeg", JPEG_QUALITY),
      "JPEG",
      MARGIN_MM,
      MARGIN_MM,
      usableWidthMm,
      height / pxPerMm,
    );
  }

  pdf.save(fileName);
}
