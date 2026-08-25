// One gate for every file the user hands this app.
//
// WHY THIS FILE EXISTS
// Import.jsx and DataIntelligence.jsx are both upload doors into the same
// pipeline (both end at db.integrations.Core.UploadFile and then parse the
// bytes), but only one of them was guarded. Measured 2026-08-21:
//
//   Import.jsx            extension allowlist, executable denylist,
//                         10MB size cap, magic-byte inspection
//   DataIntelligence.jsx  extension regex. Nothing else.
//
// Neither line is quoted on purpose. The checks MOVED into this file, so any
// number here would send a reader to unrelated code — as the numbers this
// comment used to carry (Import.jsx:280-330, DataIntelligence.jsx:119) now do.
// `git log -S EXECUTABLE_EXT -- src/pages/Import.jsx` finds the original.
//
// So a renamed executable (payload.csv), a 500MB file, or an .xlsx that is not
// actually a ZIP container was rejected at one door and accepted at the other.
// Copying the checks into the second page would have made a third copy destined
// to drift apart again — this repo already carries that scar elsewhere (four
// separate copies of publicUser()). Hence one function, imported twice.
//
// DESIGN NOTE: this returns a verdict, it does not talk to the user. Import.jsx
// reports with alert(), DataIntelligence.jsx with toast.error(); keeping the
// presentation at the call site is what lets both share the logic.
//
// The checks below are the ones Import.jsx already performed, moved verbatim so
// the hardened door's behaviour is preserved exactly. This is a client-side gate
// and it runs BEFORE the file is read or uploaded, which is the point: the CSV
// text is consumed locally (Import.jsx calls `await item.file.text()` in two
// places, one per report shape), so a server-side validator interposed at the
// upload call would arrive after the hostile bytes had already reached the
// parser. Validate first, then read.

/** Largest file we will accept. Matches csvParser.js:302/307, which reject a
 *  larger payload later anyway — enforcing it here fails fast and cheaply. */
export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

/** The only extensions the import pipeline can parse. */
const ALLOWED_EXT = /\.(csv|xlsx|xls)$/i;

/** Defence in depth only. Both patterns are anchored at the end of the name, so
 *  anything matching this ALREADY fails ALLOWED_EXT — "report.csv.exe" does not
 *  end in .csv. Kept (it came from Import.jsx:286) so that unanchoring the
 *  allowlist one day does not silently open an executable path. Verified
 *  unreachable-but-harmless by scripts/probe-upload-guard.mjs. */
const EXECUTABLE_EXT = /\.(exe|sh|bat|cmd|msi|ps1|js|vbs|jar)$/i;

const SPREADSHEET_EXT = /\.(xlsx|xls)$/i;
const CSV_EXT = /\.csv$/i;

/**
 * Inspect one file before it is read, parsed, or uploaded.
 *
 * @param {File|Blob & {name?: string, size?: number}} file
 * @returns {Promise<{ok: boolean, reason: string}>}
 *   `reason` is a complete, user-presentable sentence naming the file, and is ""
 *   when `ok` is true. It is always present rather than optional so callers can
 *   read it without narrowing — a two-member union discriminated on a boolean
 *   does not narrow reliably under checkJs, which cost two typecheck errors the
 *   first time this was written.
 */
export async function inspectUploadFile(file) {
  const name = String(file?.name ?? "");

  if (!ALLOWED_EXT.test(name) || EXECUTABLE_EXT.test(name)) {
    return { ok: false, reason: `File ${name} has an invalid or unsafe extension.` };
  }

  if (Number(file.size) > UPLOAD_MAX_BYTES) {
    return { ok: false, reason: `File ${name} exceeds the 10MB limit and will not be processed.` };
  }

  // Magic-byte inspection. Only the first four bytes are needed, so this never
  // pulls a large file into memory.
  let view;
  try {
    view = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  } catch {
    // A file the browser cannot read (removed from disk, permission revoked
    // mid-pick) is rejected rather than passed through unchecked.
    return { ok: false, reason: `Could not verify the integrity of ${name}.` };
  }

  if (SPREADSHEET_EXT.test(name)) {
    // A real .xlsx is a ZIP container (50 4B 03 04); legacy .xls is OLE2
    // (D0 CF 11 E0). Anything else with that extension is mislabelled.
    const isZip = view.length >= 4 && view[0] === 0x50 && view[1] === 0x4b && view[2] === 0x03 && view[3] === 0x04;
    const isOle = view.length >= 4 && view[0] === 0xd0 && view[1] === 0xcf && view[2] === 0x11 && view[3] === 0xe0;
    if (!isZip && !isOle) {
      return {
        ok: false,
        reason: `File ${name} failed security inspection (invalid magic bytes). This is not a genuine Excel file.`,
      };
    }
    return { ok: true, reason: "" };
  }

  if (CSV_EXT.test(name)) {
    if (view.includes(0x00)) {
      return {
        ok: false,
        reason: `File ${name} failed security inspection. CSV cannot contain binary null bytes.`,
      };
    }
    return { ok: true, reason: "" };
  }

  // Unreachable while ALLOWED_EXT is the union of the two branches above. Kept
  // as an explicit rejection so that widening ALLOWED_EXT without adding a
  // content check fails closed instead of silently admitting the new type.
  return { ok: false, reason: `File ${name} is not a supported upload type.` };
}
