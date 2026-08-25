// Probe: the PDF exporter cut every page boundary through whatever happened to be
// there — a line of text, a KPI card, a chart — because it advanced by exactly one
// page height regardless of the content.
//
// The shipped code (src/lib/pdfExport.js, before this fix):
//
//     let heightLeft = imgHeight;
//     let position = 0;
//     pdf.addImage(imgData, "JPEG", 0, position, imgWidth, imgHeight);
//     heightLeft -= pageHeight;
//     while (heightLeft > 0) {
//       position -= pageHeight;          // <- fixed stride, content ignored
//       pdf.addPage();
//       pdf.addImage(imgData, "JPEG", 0, position, imgWidth, imgHeight);
//       heightLeft -= pageHeight;
//     }
//
// One tall canvas, placed on each page at a negative offset so the viewer clips
// everything but that page's band. The band edges land on arbitrary pixel rows.
// Section 3 measures it on a fixture shaped like the Dashboard: the fixed stride
// divides 4 blocks, the new geometry divides 0.
//
// Two further facts measured while fixing it, both of which changed the design:
//
//   A. jsPDF 4.2.1 deduplicates identical image data. Adding the same data URL to
//      five pages emits ONE image XObject, not five (measured: 1 xobject, 4942
//      bytes; five distinct images give 5). So the old code did not bloat the
//      file, and slicing per page does not shrink it. Slicing is done because it
//      is the only way to give each page its own band once the bands stop being
//      uniform — not for file size. Any comment claiming otherwise is wrong.
//
//   B. html2canvas 1.4.1 does not check the browser canvas limits. Chrome refuses
//      an axis over 16384px and Safari caps the area near 16.7M px; over either,
//      the canvas comes back blank and the export silently produces an empty PDF.
//      `scale: 2` reaches 16384px at 8192 CSS px of content, which a long
//      Statistics page passes. safeCanvasScale clamps instead (section 1).
//
// Root cause, one sentence: page height was treated as the only input to where a
// page ends, so the layout had no say in it.
//
// The pure geometry lives in src/lib/pdfPagination.js precisely so this probe can
// execute it — pdfExport.js imports jsPDF and html2canvas, neither of which loads
// under plain Node. Section 9 therefore pins the WIRING as a source fact, because
// a green geometry module wired to nothing would leave the defect shipping.
//
// Run: node scripts/probe-pdf-pagination.mjs

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computePageBreaks, safeCanvasScale } from "../src/lib/pdfPagination.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");

let pass = 0;
let fail = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) {
    pass += 1;
    console.log(`  ok   ${label}${detail ? `  (${detail})` : ""}`);
  } else {
    fail += 1;
    failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${label}${detail ? `  (${detail})` : ""}`);
  }
}

// How many blocks does a set of cuts divide? A cut divides a block when it lands
// strictly inside it. This is the metric the whole fix exists to drive to zero.
function dividedBy(cuts, blocks) {
  return blocks.filter((b) => cuts.some((c) => c > b.top + 0.5 && c < b.bottom - 0.5)).length;
}
// What the shipped code did: cut every `page` pixels until the content runs out.
function uniformCuts(total, page) {
  const out = [0];
  while (total - out[out.length - 1] > page) out.push(out[out.length - 1] + page);
  return out;
}

// A fixture shaped like the Dashboard: a header, a row of three KPI cards that
// share one interval, two charts, and a 20-row table. Heights are canvas pixels.
const PAGE = 1000;
const DASHBOARD = [
  { top: 0, bottom: 120 }, // page header
  { top: 140, bottom: 260 }, // KPI card 1
  { top: 140, bottom: 260 }, // KPI card 2  (same row)
  { top: 140, bottom: 260 }, // KPI card 3  (same row)
  { top: 280, bottom: 700 }, // revenue chart
  { top: 720, bottom: 1180 }, // occupancy chart
  { top: 1200, bottom: 1320 }, // section heading + filters
];
for (let i = 0; i < 20; i += 1) DASHBOARD.push({ top: 1340 + i * 44, bottom: 1340 + i * 44 + 40 });
const DASH_HEIGHT = 2260;

console.log("\n1. safeCanvasScale clamps to what the browser will actually allocate");
ok("a small element keeps the requested scale", safeCanvasScale(1200, 900, 2) === 2);
ok("a tall element is clamped instead of overflowing the axis limit",
  safeCanvasScale(1200, 9000, 2) < 2 && 9000 * safeCanvasScale(1200, 9000, 2) <= 16384,
  `scale ${safeCanvasScale(1200, 9000, 2).toFixed(3)} -> ${Math.round(9000 * safeCanvasScale(1200, 9000, 2))}px`);
ok("…and the area limit is honoured too",
  1200 * 5000 * safeCanvasScale(1200, 5000, 2) ** 2 <= 16777216 + 1,
  `scale ${safeCanvasScale(1200, 5000, 2).toFixed(3)}`);
ok("the clamp never exceeds the requested scale", safeCanvasScale(10, 10, 1.5) === 1.5);
ok("the clamp is always positive", safeCanvasScale(16000, 16000, 2) > 0);
ok("garbage dimensions fall back to the requested scale rather than 0",
  safeCanvasScale(NaN, 100, 2) === 2 && safeCanvasScale(0, 0, 2) === 2 && safeCanvasScale(-5, 10, 2) === 2);
ok("a garbage scale falls back to 1", safeCanvasScale(100, 100, NaN) === 1 && safeCanvasScale(100, 100, -2) === 1);

console.log("\n2. structural invariants of computePageBreaks");
const cuts = computePageBreaks(DASH_HEIGHT, PAGE, DASHBOARD);
ok("the first page starts at 0", cuts[0] === 0);
ok("offsets strictly increase", cuts.every((c, i) => i === 0 || c > cuts[i - 1]), cuts.join(" "));
ok("the last page starts before the content ends", cuts[cuts.length - 1] < DASH_HEIGHT);
ok("no page is taller than one page",
  cuts.every((c, i) => (i === cuts.length - 1 ? DASH_HEIGHT - c : cuts[i + 1] - c) <= PAGE + 0.5));
ok("the pages cover the content exactly once, with no gap",
  cuts.every((c, i) => i === 0 || c === cuts[i]) && cuts.length >= Math.ceil(DASH_HEIGHT / PAGE),
  `${cuts.length} pages for ${DASH_HEIGHT}px at ${PAGE}px/page`);

console.log("\n3. the defect: a fixed stride divides content, the new geometry does not");
const old = uniformCuts(DASH_HEIGHT, PAGE);
const oldDivided = dividedBy(old, DASHBOARD);
ok("the shipped fixed-stride cuts divide blocks", oldDivided > 0,
  `${oldDivided} of ${DASHBOARD.length} blocks cut, at ${old.slice(1).join(" ")}`);
ok("…and the new cuts divide none of them", dividedBy(cuts, DASHBOARD) === 0,
  `cuts at ${cuts.slice(1).join(" ")}`);
ok("…every cut lands on a block edge", cuts.slice(1).every((c) =>
  DASHBOARD.some((b) => Math.abs(b.top - c) < 0.5 || Math.abs(b.bottom - c) < 0.5)));
ok("…and it costs at most one extra page", cuts.length <= old.length + 1,
  `${old.length} -> ${cuts.length}`);

console.log("\n4. a block taller than a page is cut, because it cannot not be");
const TALL = [{ top: 0, bottom: 100 }, { top: 120, bottom: 2600 }];
const tallCuts = computePageBreaks(2600, PAGE, TALL);
ok("the oversized block is divided", dividedBy(tallCuts, TALL) === 1, `cuts ${tallCuts.join(" ")}`);
ok("…and the block that fits is not", tallCuts.every((c) => !(c > 0.5 && c < 99.5)));
ok("…and the cuts still advance a full page each time, wasting no space",
  tallCuts.slice(1).every((c, i) => c - tallCuts[i] === PAGE), tallCuts.join(" "));

console.log("\n5. staggered blocks: an edge is not automatically a safe cut");
// b2's bottom (900) sits inside b1 (200..1150). Choosing it because it is an edge
// would slice b1 in half. The candidate has to be validated against every block.
// b1 is 950px against a 1000px page, so it CAN be kept whole — but only by ending
// page 1 at 200px, far below the fill floor. That trade is the point of the case.
const STAGGERED = [{ top: 200, bottom: 1150 }, { top: 300, bottom: 900 }, { top: 1170, bottom: 1600 }];
const stagCuts = computePageBreaks(2400, PAGE, STAGGERED);
ok("no cut lands inside the overlapping block",
  !stagCuts.some((c) => c > 200.5 && c < 1149.5), stagCuts.join(" "));
ok("…and the block that could be kept whole was kept whole",
  dividedBy(stagCuts, [STAGGERED[2]]) === 0);
ok("…and a short page is accepted when that is the only way to keep it whole",
  stagCuts[1] === 200 && dividedBy(stagCuts, STAGGERED) === 0,
  `page 1 is ${stagCuts[1]}px of ${PAGE}px, 0 of ${STAGGERED.length} blocks divided`);

console.log("\n6. degenerate input degrades to the old behaviour instead of throwing");
ok("content shorter than a page is one page", computePageBreaks(500, PAGE, DASHBOARD).length === 1);
ok("content exactly one page high is one page", computePageBreaks(PAGE, PAGE, DASHBOARD).length === 1);
const noBlocks = computePageBreaks(DASH_HEIGHT, PAGE, []);
ok("no blocks at all reproduces the fixed stride exactly",
  noBlocks.join(",") === uniformCuts(DASH_HEIGHT, PAGE).join(","), noBlocks.join(" "));
ok("a missing blocks argument is treated as no blocks",
  computePageBreaks(DASH_HEIGHT, PAGE).join(",") === noBlocks.join(","));
ok("zero and negative heights return a single page",
  computePageBreaks(0, PAGE).length === 1 && computePageBreaks(-10, PAGE).length === 1
  && computePageBreaks(DASH_HEIGHT, 0).length === 1);
ok("NaN heights return a single page",
  computePageBreaks(NaN, PAGE).length === 1 && computePageBreaks(DASH_HEIGHT, NaN).length === 1);
ok("malformed blocks are skipped, not trusted",
  computePageBreaks(DASH_HEIGHT, PAGE, [null, {}, { top: NaN, bottom: 5 }, { top: 900, bottom: 100 }])
    .join(",") === noBlocks.join(","));
ok("zero-height blocks cannot produce a zero-width page",
  computePageBreaks(2500, PAGE, [{ top: 0, bottom: 0 }, { top: 0, bottom: 0 }])
    .every((c, i, a) => i === 0 || c - a[i - 1] > 0));

console.log("\n7. the minimum-fill floor stops a tall block emitting a nearly empty page");
// The only safe cut below the limit is at 60px — accepting it would print a page
// holding one 60px strip and then cut the tall block anyway.
const THIN = [{ top: 0, bottom: 60 }, { top: 60, bottom: 3000 }];
const thinCuts = computePageBreaks(3000, PAGE, THIN);
ok("no page is filled less than the floor",
  thinCuts.slice(1).every((c, i) => c - thinCuts[i] >= PAGE * 0.2 - 0.5), thinCuts.join(" "));
ok("a floor of 0 is clamped up rather than allowing a 1px page",
  computePageBreaks(3000, PAGE, THIN, 0).slice(1).every((c, i, a) =>
    c - (i === 0 ? 0 : a[i - 1]) >= PAGE * 0.05 - 0.5));
ok("a floor above 0.9 is clamped down rather than forcing the stride",
  computePageBreaks(3000, PAGE, THIN, 5).length > 1);

console.log("\n8. termination is bounded, not merely hoped for");
// 2000 identical zero-height edges plus a page floor: the loop must still finish
// and must not be rescued by its own guard.
const MANY = Array.from({ length: 2000 }, (_, i) => ({ top: i, bottom: i + 0.2 }));
const t0 = Date.now();
const manyCuts = computePageBreaks(50000, PAGE, MANY);
ok("2000 blocks over 50 pages terminates quickly", Date.now() - t0 < 4000, `${Date.now() - t0}ms`);
ok("…with a page count inside the theoretical bound",
  manyCuts.length <= Math.ceil(50000 / PAGE) + 2, `${manyCuts.length} pages`);
ok("…and every page still respects the page height",
  manyCuts.every((c, i) => (i === manyCuts.length - 1 ? 50000 - c : manyCuts[i + 1] - c) <= PAGE + 0.5));

console.log("\n9. the product is wired to this module (a green module wired to nothing ships the bug)");
const src = read("src/lib/pdfExport.js");
// Search code only: this probe's own header quotes the old loop, and so does
// pdfExport.js's comment explaining what it replaced.
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
ok("pdfExport.js imports the geometry", /from\s+["']\.\/pdfPagination(\.js)?["']/.test(code));
ok("…and calls computePageBreaks", /computePageBreaks\s*\(/.test(code));
ok("…and calls safeCanvasScale", /safeCanvasScale\s*\(/.test(code));
ok("…and no longer advances by a fixed page stride",
  !/position\s*-=\s*pageHeight/.test(code) && !/heightLeft\s*-=\s*pageHeight/.test(code),
  "the shipped `position -= pageHeight` loop must be gone");
ok("…and draws each page from its own slice rather than one image per page",
  /drawImage\s*\(/.test(code), "each band is cropped onto a slice canvas");
ok("…and leaves a printable margin instead of bleeding to the paper edge",
  /MARGIN_MM/.test(code) && !/addImage\([^)]*,\s*0,\s*0,\s*pageWidth/.test(code));
ok("…and asks html2canvas for the clamped scale, not a hardcoded 2",
  !/scale:\s*2\b/.test(code) && /=\s*safeCanvasScale\s*\(/.test(code),
  "scale must come from safeCanvasScale");
const pag = read("src/lib/pdfPagination.js");
ok("the geometry module stays dependency-free so this probe can run it",
  !/^\s*import\s/m.test(pag), "any import here breaks plain-node execution");

console.log("\n10. every export button tells the operator when nothing was saved");
// A silent failure is worse here than a crash: the button stops saying
// "Generating…", which is exactly what a successful save looks like, and the
// operator goes looking in their downloads folder for a file that is not there.
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const dash = strip(read("src/pages/Dashboard.jsx"));
const gcb = strip(read("src/components/GlobalControlBar.jsx"));
const ota = strip(read("src/pages/OtaChannels.jsx"));
ok("Dashboard records the failure in state instead of the console",
  /catch\s*\(\s*e\s*\)\s*\{\s*setExportError\(/.test(dash) && !/console\.error/.test(dash));
ok("…and renders it where the operator is already looking",
  /\{exportError\s*&&/.test(dash) && /The PDF was not created/.test(dash));
ok("GlobalControlBar reports the failure too", /toast\.error\(/.test(gcb) && !/console\.error/.test(gcb));
ok("…and treats a missing content area as a failure, not as success",
  /if\s*\(!content\)\s*throw/.test(gcb),
  "querySelector returning null used to exit the try block having done nothing");
ok("…and imports a toast that is actually mounted",
  /from\s+["']sonner["']/.test(gcb) && /SonnerToaster|Toaster as SonnerToaster/.test(read("src/App.jsx")),
  "sonner dispatched into a store with no subscriber until App.jsx mounted it");
ok("OtaChannels keeps the surface it already had", /setExportError\(e\?\.message/.test(ota));


console.log(`PASS ${pass}   FAIL ${fail}`);
if (fail > 0) {
  console.log(`\nFAILED: ${pass} passed, ${fail} failed`);
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
console.log(`\nPASSED: ${pass} passed, 0 failed`);
process.exit(0);
