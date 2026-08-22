// Probe for the shared upload gate — src/lib/uploadGuard.js
//
//   node scripts/probe-upload-guard.mjs
//
// Pure function over a File, so this runs in plain node with no DOM, no Dexie
// and no fixtures.
//
// WHY IT EXISTS: this gate is the hostile-input boundary for the whole import
// pipeline, and until 2026-08-21 it existed only inside Import.jsx's JSX where
// nothing could test it, while DataIntelligence.jsx checked the extension and
// nothing else. The logic now lives in one module and this probe is what proves
// both doors are shut.

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
const OLE = [0xd0, 0xcf, 0x11, 0xe0];
const MZ = [0x4d, 0x5a, 0x90, 0x00];

const file = (name, bytes, size) => {
  const f = new File([new Uint8Array(bytes)], name);
  if (size !== undefined) Object.defineProperty(f, "size", { value: size });
  return f;
};
const text = (s) => Array.from(new TextEncoder().encode(s));

async function accepts(name, bytes, size) {
  const v = await inspectUploadFile(file(name, bytes, size));
  return v.ok === true;
}
async function rejects(name, bytes, size) {
  const v = await inspectUploadFile(file(name, bytes, size));
  return v.ok === false && typeof v.reason === "string" && v.reason.length > 0;
}

// ── 1. The happy paths the app depends on ─────────────────────────────────
ok(await accepts("transactions.csv", text("Date,Amount\n")), "a plain CSV is accepted");
ok(await accepts("book.xlsx", ZIP), "a real .xlsx (ZIP container) is accepted");
ok(await accepts("legacy.xls", OLE), "a real legacy .xls (OLE2) is accepted");
ok(await accepts("UPPER.CSV", text("a,b\n")), "the extension test is case-insensitive");

// ── 2. Extension gate ─────────────────────────────────────────────────────
ok(await rejects("payload.exe", MZ), "an .exe is rejected");
ok(await rejects("notes.txt", text("hello")), "an unlisted extension (.txt) is rejected");
ok(await rejects("data", text("a,b")), "a file with no extension is rejected");
ok(await rejects("script.js", text("alert(1)")), ".js is rejected");
// A double extension cannot smuggle an executable through, because the allowlist
// is anchored at the end of the name: "report.csv.exe" does not END in an allowed
// extension, so it never reaches the denylist.
ok(await rejects("report.csv.exe", MZ), "a double extension (report.csv.exe) is rejected by the anchored allowlist");
// The mirror case is the one that documents WHY the anchor matters. This file is
// a genuine text CSV whose name merely contains ".exe"; it is accepted, and it
// must be, or a guest named e.g. "invoice.exe.csv" would be unimportable. It also
// shows Import.jsx's EXECUTABLE_EXT denylist is unreachable in practice: any name
// ending .exe already fails the allowlist. The denylist is kept as defence in
// depth for the day someone unanchors the allowlist — do not delete it.
ok(await accepts("payload.exe.csv", text("Date,Amount\n")), "a real CSV whose name contains .exe is accepted");

// ── 3. Size gate ──────────────────────────────────────────────────────────
ok(await accepts("big.csv", text("a,b\n"), UPLOAD_MAX_BYTES), "a file exactly at the 10MB cap is accepted");
ok(await rejects("huge.csv", text("a,b\n"), UPLOAD_MAX_BYTES + 1), "one byte over the cap is rejected");
ok(await rejects("massive.csv", text("a,b\n"), 500 * 1024 * 1024), "a 500MB file is rejected");
// Size is checked before the bytes are read, so an enormous file never gets sliced.
ok(await rejects("huge.xlsx", ZIP, UPLOAD_MAX_BYTES + 1), "the cap applies to spreadsheets too");

// ── 4. Magic-byte gate ────────────────────────────────────────────────────
ok(await rejects("fake.xlsx", MZ), "an executable renamed .xlsx is rejected on magic bytes");
ok(await rejects("fake.xlsx", text("Date,Amount")), "a CSV renamed .xlsx is rejected on magic bytes");
ok(await rejects("empty.xlsx", []), "a truncated/empty .xlsx is rejected (fewer than 4 bytes)");
ok(await rejects("fake.xls", text("<html>")), "an HTML file renamed .xls is rejected");
ok(await rejects("binary.csv", [0x00, 0x01, 0x02, 0x03]), "a CSV whose header holds a null byte is rejected");
ok(await rejects("nulls.csv", [0x61, 0x00, 0x62, 0x63]), "a null byte anywhere in the header is rejected");
// A .csv starting with the letters "MZ" is still just text and cannot execute;
// the executable-extension gate is what stops real binaries. Asserted so nobody
// "hardens" this into rejecting a legitimate CSV whose first cell begins MZ.
ok(await accepts("mzansi.csv", text("MZansi,1\n")), "a CSV whose text merely starts with MZ is accepted");
ok(await accepts("short.csv", text("a")), "a CSV shorter than 4 bytes is accepted");

// ── 5. Fails closed ──────────────────────────────────────────────────────
{
  // A file the browser cannot read must be rejected, never waved through.
  const unreadable = { name: "gone.csv", size: 10, slice: () => ({ arrayBuffer: () => Promise.reject(new Error("NotReadableError")) }) };
  const v = await inspectUploadFile(unreadable);
  ok(v.ok === false, "an unreadable file is rejected, not admitted unchecked", JSON.stringify(v));
}
{
  const v = await inspectUploadFile({});
  ok(v.ok === false, "a file with no name at all is rejected", JSON.stringify(v));
}
{
  // Every rejection names the file, because both call sites put `reason`
  // straight in front of the user.
  const v = await inspectUploadFile(file("payload.exe", MZ));
  ok(v.reason.includes("payload.exe"), "the rejection reason names the offending file", v.reason);
}

// ── 6. Hostile / malformed metadata ──────────────────────────────────────
// These document decisions rather than defend against a live exploit: a real
// browser File always carries a string name and a finite numeric size, so the
// cases below are only reachable through a synthetic object. They are asserted
// so nobody "hardens" the guard into rejecting a legitimate file, and so the one
// soft spot (a non-finite size skipping the cap) cannot flip silently.
{
  // The allowlist is anchored, so a trailing space means the name does not end
  // in an allowed extension. Same as the pre-refactor regex — preserved.
  ok(await rejects("data.csv ", text("a,b\n")), "a trailing space after the extension is rejected");
  ok(await rejects("data.csv\n", text("a,b\n")), "a trailing newline in the name is rejected");
  // A non-string name is coerced, not trusted: String(42) has no extension.
  const numeric = { name: 42, size: 10, slice: () => ({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) }) };
  ok((await inspectUploadFile(numeric)).ok === false, "a non-string name is rejected after coercion");
}
{
  // DELIBERATE: a size that is not a finite number passes the cap, because
  // `Number(x) > max` is false for NaN. This is exactly what Import.jsx did
  // before the checks moved here, and it is safe — the magic-byte read still
  // runs, and csvParser.js:302/307 re-checks the real length downstream. Do not
  // "fix" this into a fail-closed rejection without checking that no platform
  // hands us a File with an absent size; that would refuse valid uploads.
  ok(await accepts("odd.csv", text("a,b\n"), NaN), "a NaN size does not bypass the CONTENT checks (cap is skipped by design)");
  ok(await rejects("odd.xlsx", MZ, NaN), "...proved: a NaN-size spreadsheet is still caught on magic bytes");
  ok(await accepts("neg.csv", text("a,b\n"), -1), "a negative size is not treated as over-cap");
  // A string size is coerced numerically, so the cap still bites.
  ok(await rejects("str.csv", text("a,b\n"), String(UPLOAD_MAX_BYTES + 1)), "a numeric-string size over the cap is still rejected");
}

console.log("\n" + "=".repeat(72));
console.log(`PASS ${pass}   FAIL ${fail}`);
if (failures.length) {
  console.log("\nFailures:");
  failures.forEach((f) => console.log("  ✗ " + f));
}
console.log("=".repeat(72));
process.exit(fail === 0 ? 0 : 1);
