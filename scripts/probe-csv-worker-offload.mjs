// Probe for Fix #5: "the pre-read CSV text path parsed on the main thread with no
// size cap, and the report-import ceiling was 10MB — too small for a real
// ~100k-row export."
//
// Root cause (before fix):
//   - reportParsers.getRowsArray took `parseCsvText(meta.csvText)` SYNCHRONOUSLY
//     on the main thread whenever Import.jsx pre-read the file (the primary path),
//     so the Worker in csvParser was dead for real uploads and a 100k-row paste
//     froze the tab. That branch also had NO size guard.
//   - The cap enforced by fetchCsvRows/uploadGuard was 10MB, which rejects a
//     legitimate ~15-30MB transactions export.
//
// Fix (owner-approved: "offload to the worker" + "raise to 50MB"):
//   - csvParser exports MAX_IMPORT_BYTES = 50MB as the SINGLE SOURCE OF TRUTH and
//     a parseTextInWorker(text) helper. fetchCsvRows, getRowsArray's csvText
//     branch, uploadGuard and ManualEntry all read the one constant, and the
//     pre-read branch now routes through the worker with a 50MB guard.
//
// This probe proves: (a) worker offload returns byte-identical rows to the old
// synchronous parseCsvText, (b) the cap is 50MB, (c) uploadGuard re-exports the
// SAME constant (no drift), and (d) the size gate trips above the cap and passes
// below it.
//
// Run: node --import ./scripts/_loader-boot.mjs scripts/probe-csv-worker-offload.mjs

let pass = 0;
let fail = 0;
const T = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`); }
};

const { parseCsvText, parseTextInWorker, MAX_IMPORT_BYTES } = await import("@/lib/csvParser");
const { UPLOAD_MAX_BYTES, inspectUploadFile } = await import("@/lib/uploadGuard");

// (a) Worker offload preserves the exact tokenised rows. A quoted field with an
// embedded newline and comma is the case the character scanner exists for.
const csv = 'Date,Amount,Remarks\r\n2026-01-01,"$1,337.80","SS\nnote"\r\n2026-01-02,($50.00),ok\r\n';
const direct = parseCsvText(csv);
const viaWorker = await parseTextInWorker(csv);
T("parseTextInWorker returns an array of rows", Array.isArray(viaWorker) && Array.isArray(viaWorker[0]));
T("worker rows are byte-identical to synchronous parseCsvText",
  JSON.stringify(viaWorker) === JSON.stringify(direct),
  `direct=${JSON.stringify(direct)}\n          worker=${JSON.stringify(viaWorker)}`);
T("embedded newline kept the quoted field as one cell (no torn row)",
  viaWorker.length === 3 && viaWorker[1].length === 3,
  `got ${viaWorker.length} rows, row2 len ${viaWorker[1]?.length}`);

// (b) The cap is 50MB, not the old 10MB.
T("MAX_IMPORT_BYTES is 50MB", MAX_IMPORT_BYTES === 50 * 1024 * 1024, `got ${MAX_IMPORT_BYTES}`);
T("cap is strictly larger than the old 10MB limit", MAX_IMPORT_BYTES > 10 * 1024 * 1024);

// (c) uploadGuard reads the SAME constant — no second limit can exist.
T("uploadGuard UPLOAD_MAX_BYTES === csvParser MAX_IMPORT_BYTES (single source)",
  UPLOAD_MAX_BYTES === MAX_IMPORT_BYTES, `guard=${UPLOAD_MAX_BYTES} parser=${MAX_IMPORT_BYTES}`);

// (d) The upload gate trips above the cap and passes a file below it. A minimal
// File-like object: valid .csv name, controllable size, and a slice() that yields
// clean (non-null) magic bytes so a below-cap file reaches ok:true.
const makeFile = (size) => ({
  name: "transactions.csv",
  size,
  slice() { return { async arrayBuffer() { return new Uint8Array([0x44, 0x61, 0x74, 0x65]).buffer; } }; },
});

const tooBig = await inspectUploadFile(makeFile(MAX_IMPORT_BYTES + 1));
T("file 1 byte over the cap is rejected", tooBig.ok === false, JSON.stringify(tooBig));
T("rejection names the 50MB limit", /50MB/.test(tooBig.reason), tooBig.reason);

const under = await inspectUploadFile(makeFile(30 * 1024 * 1024));
T("a legitimate 30MB csv (over the old 10MB cap) is now accepted",
  under.ok === true, JSON.stringify(under));

console.log(`\n${fail === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
