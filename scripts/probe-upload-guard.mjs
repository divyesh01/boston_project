// Probe for the shared upload gate — src/lib/uploadGuard.js
//
//   node scripts/probe-upload-guard.mjs
//
// Pure function over a File, so this runs in plain node with no DOM, no Dexie
// and no fixtures.

import { inspectUploadFile, UPLOAD_MAX_BYTES } from "../src/lib/uploadGuard.js";

let pass = 0;
let fail = 0;
const failures = [];

function ok(cond, label, detail = "") {
  if (cond) {
    pass += 1;
  } else {
    fail += 1;
    failures.push(detail ? `${label} — ${detail}` : label);
  }
}

const ZIP = [0x50, 0x4b, 0x03, 0x04];
const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const MZ_PE = [
  0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0xff, 0xff, 0x00, 0x00,
  0xb8, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x40, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x40, 0x00, 0x00, 0x00,
  0x50, 0x45, 0x00, 0x00, 0x4c, 0x01, 0x01, 0x00,
];
const ELF = [0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00];
const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10];
const GIF = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];
const SEVEN_ZIP = [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c];
const RAR = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07];

const file = (name, bytes, size, type) => {
  const f = new File([new Uint8Array(bytes)], name, type ? { type } : undefined);
  if (size !== undefined) Object.defineProperty(f, "size", { value: size });
  return f;
};
const text = (s) => Array.from(new TextEncoder().encode(s));

async function accepts(name, bytes, size, type) {
  const v = await inspectUploadFile(file(name, bytes, size, type));
  return v.ok === true;
}
async function rejects(name, bytes, size, type) {
  const v = await inspectUploadFile(file(name, bytes, size, type));
  return v.ok === false && typeof v.reason === "string" && v.reason.length > 0;
}

// ── 1. The happy paths ───────────────────────────────────────────────────
ok(await accepts("transactions.csv", text("Date,Amount\n1/1/2026,100\n")), "a plain CSV is accepted");
ok(await accepts("book.xlsx", ZIP), "a real .xlsx (ZIP container) is accepted");
ok(await accepts("legacy.xls", OLE), "a real legacy .xls (OLE2) is accepted");
ok(await accepts("UPPER.CSV", text("a,b\n")), "the extension test is case-insensitive");
ok(await accepts("with-mime.csv", text("a,b\n"), undefined, "text/csv"), "CSV with valid text/csv MIME is accepted");
ok(await accepts("utf8-bom.csv", [0xef, 0xbb, 0xbf, ...text("col1,col2\n")]), "CSV with UTF-8 BOM is accepted");
ok(await accepts("utf16-le.csv", [0xff, 0xfe, 0x61, 0x00, 0x2c, 0x00, 0x62, 0x00, 0x0a, 0x00]), "CSV with UTF-16 LE BOM is accepted");

// ── 2. Extension gate ─────────────────────────────────────────────────────
ok(await rejects("payload.exe", MZ_PE), "an .exe is rejected");
ok(await rejects("notes.txt", text("hello")), "an unlisted extension (.txt) is rejected");
ok(await rejects("data", text("a,b")), "a file with no extension is rejected");
ok(await rejects("script.js", text("alert(1)")), ".js is rejected");
ok(await rejects("report.csv.exe", MZ_PE), "a double extension (report.csv.exe) is rejected");
ok(await accepts("payload.exe.csv", text("Date,Amount\n")), "a real CSV whose name contains .exe is accepted");

// ── 3. Size gate & Empty file gate ─────────────────────────────────────────
ok(await accepts("big.csv", text("a,b\n"), UPLOAD_MAX_BYTES), "a file exactly at the 10MB cap is accepted");
ok(await rejects("huge.csv", text("a,b\n"), UPLOAD_MAX_BYTES + 1), "one byte over the cap is rejected");
ok(await rejects("massive.csv", text("a,b\n"), 500 * 1024 * 1024), "a 500MB file is rejected");
ok(await rejects("huge.xlsx", ZIP, UPLOAD_MAX_BYTES + 1), "the cap applies to spreadsheets too");
ok(await rejects("zero.csv", [], 0), "a 0-byte empty CSV is rejected");
ok(await rejects("zero.xlsx", [], 0), "a 0-byte empty XLSX is rejected");

// ── 4. MIME type gate ─────────────────────────────────────────────────────
ok(await rejects("malicious.csv", text("a,b\n"), undefined, "application/x-msdownload"), "CSV with executable MIME is rejected");
ok(await rejects("image.csv", text("a,b\n"), undefined, "image/png"), "CSV with image/png MIME is rejected");
ok(await rejects("doc.csv", text("a,b\n"), undefined, "application/pdf"), "CSV with PDF MIME is rejected");

// ── 5. Magic-byte & Renamed binary gate (SEC-10) ──────────────────────────
ok(await rejects("fake_pe.csv", MZ_PE), "Windows PE executable renamed to .csv is rejected");
ok(await rejects("fake_elf.csv", ELF), "ELF executable renamed to .csv is rejected");
ok(await rejects("fake_pdf.csv", PDF), "PDF renamed to .csv is rejected");
ok(await rejects("fake_png.csv", PNG), "PNG image renamed to .csv is rejected");
ok(await rejects("fake_jpg.csv", JPEG), "JPEG image renamed to .csv is rejected");
ok(await rejects("fake_gif.csv", GIF), "GIF image renamed to .csv is rejected");
ok(await rejects("fake_7z.csv", SEVEN_ZIP), "7-Zip archive renamed to .csv is rejected");
ok(await rejects("fake_rar.csv", RAR), "RAR archive renamed to .csv is rejected");
ok(await rejects("fake_zip.csv", ZIP), "ZIP container renamed to .csv is rejected");
ok(await rejects("fake.xlsx", MZ_PE), "an executable renamed .xlsx is rejected on magic bytes");
ok(await rejects("fake.xlsx", text("Date,Amount")), "a CSV renamed .xlsx is rejected on magic bytes");
ok(await rejects("fake.xls", text("<html>")), "an HTML file renamed .xls is rejected");
ok(await rejects("xlsx_as_xls.xls", ZIP), "ZIP/XLSX file renamed to .xls is rejected on OLE mismatch");
ok(await rejects("xls_as_xlsx.xlsx", OLE), "OLE/XLS file renamed to .xlsx is rejected on ZIP mismatch");
ok(await rejects("binary.csv", [0x00, 0x01, 0x02, 0x03]), "a CSV holding null bytes is rejected");
ok(await rejects("control.csv", [0x61, 0x01, 0x62, 0x02]), "a CSV with binary control characters is rejected");
ok(await accepts("mzansi.csv", text("MZansi,1\n2,3\n")), "a CSV whose text merely starts with MZ is accepted");
ok(await accepts("short.csv", text("a")), "a short valid CSV text is accepted");

// ── 6. Error message quality ──────────────────────────────────────────────
{
  const v = await inspectUploadFile(file("payload.exe", MZ_PE));
  ok(v.ok === false && v.reason.includes("payload.exe"), "rejection reason explicitly names the file");
}
{
  const v = await inspectUploadFile(file("fake.csv", MZ_PE));
  ok(v.ok === false && v.reason.toLowerCase().includes("executable"), "rejection reason clearly identifies executable binary");
}

console.log("\n" + "=".repeat(72));
console.log(`PASS ${pass}   FAIL ${fail}`);
if (failures.length) {
  console.log("\nFailures:");
  failures.forEach((f) => console.log("  ✗ " + f));
}
console.log("=".repeat(72));
console.log(`\n${fail === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

