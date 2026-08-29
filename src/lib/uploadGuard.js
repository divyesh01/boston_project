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

/** Largest file we will accept. Re-exported from csvParser's MAX_IMPORT_BYTES,
 *  the single source of truth the parser itself enforces later — so this
 *  fail-fast door and the parse-time ceiling can never drift to two different
 *  limits on the same upload. */
import { MAX_IMPORT_BYTES } from "./csvParser.js";
export const UPLOAD_MAX_BYTES = MAX_IMPORT_BYTES;

/** The only extensions the import pipeline can parse. */
const ALLOWED_EXT = /\.(csv|xlsx|xls)$/i;

/** Defence in depth only. Both patterns are anchored at the end of the name, so
 *  anything matching this ALREADY fails ALLOWED_EXT — "report.csv.exe" does not
 *  end in .csv. Kept (it came from Import.jsx:286) so that unanchoring the
 *  allowlist one day does not silently open an executable path. Verified
 *  unreachable-but-harmless by scripts/probe-upload-guard.mjs. */
const EXECUTABLE_EXT = /\.(exe|sh|bat|cmd|msi|ps1|js|vbs|jar)$/i;

const SPREADSHEET_EXT = /\.(xlsx|xls)$/i;
const XLSX_EXT = /\.xlsx$/i;
const XLS_EXT = /\.xls$/i;
const CSV_EXT = /\.csv$/i;

// Sample size for deep content inspection (up to 4KB)
const INSPECTION_SAMPLE_BYTES = 4096;

/** Known binary signatures that must NEVER appear in a CSV file */
const DANGEROUS_BINARY_SIGNATURES = [
  { name: "ELF executable", check: (v) => v.length >= 4 && v[0] === 0x7f && v[1] === 0x45 && v[2] === 0x4c && v[3] === 0x46 },
  { name: "PDF document", check: (v) => v.length >= 4 && v[0] === 0x25 && v[1] === 0x50 && v[2] === 0x44 && v[3] === 0x46 },
  { name: "PNG image", check: (v) => v.length >= 4 && v[0] === 0x89 && v[1] === 0x50 && v[2] === 0x4e && v[3] === 0x47 },
  { name: "JPEG image", check: (v) => v.length >= 3 && v[0] === 0xff && v[1] === 0xd8 && v[2] === 0xff },
  { name: "GIF image", check: (v) => v.length >= 4 && v[0] === 0x47 && v[1] === 0x49 && v[2] === 0x46 && v[3] === 0x38 },
  { name: "7-Zip archive", check: (v) => v.length >= 6 && v[0] === 0x37 && v[1] === 0x7a && v[2] === 0xbc && v[3] === 0xaf && v[4] === 0x27 && v[5] === 0x1c },
  { name: "RAR archive", check: (v) => v.length >= 4 && v[0] === 0x52 && v[1] === 0x61 && v[2] === 0x72 && v[3] === 0x21 },
  { name: "Mach-O binary", check: (v) => v.length >= 4 && ((v[0] === 0xfe && v[1] === 0xed && v[2] === 0xfa && (v[3] === 0xce || v[3] === 0xcf)) || (v[0] === 0xca && v[1] === 0xfe && v[2] === 0xba && v[3] === 0xbe) || (v[0] === 0xce && v[1] === 0xfa && v[2] === 0xed && v[3] === 0xfe) || (v[0] === 0xcf && v[1] === 0xfa && v[2] === 0xed && v[3] === 0xfe)) },
];

/** Incompatible MIME types that should be rejected immediately */
const DISALLOWED_MIME_PATTERNS = /^(application\/(x-msdownload|x-executable|x-dosexec|x-sharedlib|pdf|x-sh|x-bat|javascript|x-7z-compressed|vnd\.rar)|image\/|audio\/|video\/|text\/(javascript|html))/i;

/**
 * Inspect one file before it is read, parsed, or uploaded.
 *
 * @param {File|Blob & {name?: string, size?: number, type?: string}} file
 * @returns {Promise<{ok: boolean, reason: string}>}
 *   `reason` is a complete, user-presentable sentence naming the file, and is ""
 *   when `ok` is true.
 */
export async function inspectUploadFile(file) {
  const name = String(file?.name ?? "");

  // 1. Extension validation
  if (!ALLOWED_EXT.test(name) || EXECUTABLE_EXT.test(name)) {
    return { ok: false, reason: `File ${name} has an unsupported file type. Allowed formats: .csv, .xlsx, .xls.` };
  }

  // 2. Empty file check
  if (file?.size === 0) {
    return { ok: false, reason: `File ${name} is empty (0 bytes) and cannot be imported.` };
  }

  // 3. File size cap
  if (Number(file?.size) > UPLOAD_MAX_BYTES) {
    return { ok: false, reason: `File ${name} exceeds the ${UPLOAD_MAX_BYTES / (1024 * 1024)}MB limit and will not be processed.` };
  }

  // 4. MIME type validation (when browser/OS supplies an explicit non-generic MIME type)
  const mimeType = String(file?.type ?? "").trim().toLowerCase();
  if (mimeType && DISALLOWED_MIME_PATTERNS.test(mimeType)) {
    return { ok: false, reason: `File ${name} has an unsupported MIME type (${mimeType}). Allowed formats: .csv, .xlsx, .xls.` };
  }

  // 5. Sample content & magic-byte inspection (up to 4KB sample)
  let view;
  try {
    const buffer = await file.slice(0, INSPECTION_SAMPLE_BYTES).arrayBuffer();
    view = new Uint8Array(buffer);
  } catch {
    return { ok: false, reason: `Could not verify the integrity of ${name}.` };
  }

  if (view.length === 0) {
    return { ok: false, reason: `File ${name} is empty (0 bytes) and cannot be imported.` };
  }

  // 6. Spreadsheet validation
  if (SPREADSHEET_EXT.test(name)) {
    const isZip = view.length >= 4 && view[0] === 0x50 && view[1] === 0x4b && view[2] === 0x03 && view[3] === 0x04;
    const isOle = view.length >= 4 && view[0] === 0xd0 && view[1] === 0xcf && view[2] === 0x11 && view[3] === 0xe0;

    if (XLSX_EXT.test(name) && !isZip) {
      return {
        ok: false,
        reason: `File ${name} does not appear to be a genuine Excel (.xlsx) file — its contents do not match the .xlsx format.`,
      };
    }

    if (XLS_EXT.test(name) && !isOle) {
      return {
        ok: false,
        reason: `File ${name} does not appear to be a genuine Excel (.xls) file — its contents do not match the legacy .xls format.`,
      };
    }

    if (!isZip && !isOle) {
      return {
        ok: false,
        reason: `File ${name} does not appear to be a genuine Excel spreadsheet.`,
      };
    }

    return { ok: true, reason: "" };
  }

  // 7. CSV validation
  if (CSV_EXT.test(name)) {
    // Check known dangerous binary signatures
    for (const sig of DANGEROUS_BINARY_SIGNATURES) {
      if (sig.check(view)) {
        return {
          ok: false,
          reason: `File ${name} appears to be a ${sig.name} and cannot be imported as a CSV spreadsheet.`,
        };
      }
    }

    // Rejection of ZIP/OLE containers masquerading as CSV
    const isZip = view.length >= 4 && view[0] === 0x50 && view[1] === 0x4b && view[2] === 0x03 && view[3] === 0x04;
    const isOle = view.length >= 4 && view[0] === 0xd0 && view[1] === 0xcf && view[2] === 0x11 && view[3] === 0xe0;
    if (isZip || isOle) {
      return {
        ok: false,
        reason: `File ${name} is a binary spreadsheet container disguised as .csv. Please rename or export as standard CSV.`,
      };
    }

    // DOS / Windows PE Header check: "MZ" (0x4D, 0x5A)
    if (view.length >= 2 && view[0] === 0x4d && view[1] === 0x5a) {
      let isPEBinary = false;
      if (view.length >= 64) {
        const peOffset = view[0x3c] | (view[0x3d] << 8) | (view[0x3e] << 16) | (view[0x3f] << 24);
        if (peOffset > 0 && peOffset + 4 <= view.length) {
          if (view[peOffset] === 0x50 && view[peOffset + 1] === 0x45 && view[peOffset + 2] === 0x00 && view[peOffset + 3] === 0x00) {
            isPEBinary = true;
          }
        }
      }
      if (isPEBinary || view.includes(0x00)) {
        return {
          ok: false,
          reason: `File ${name} appears to be an executable program and cannot be imported as a CSV file.`,
        };
      }
    }

    // Check for UTF-16 BOM
    const isUtf16LE = view.length >= 2 && view[0] === 0xff && view[1] === 0xfe;
    const isUtf16BE = view.length >= 2 && view[0] === 0xfe && view[1] === 0xff;

    if (!isUtf16LE && !isUtf16BE) {
      // Standard UTF-8 / ASCII CSV cannot contain null bytes
      if (view.includes(0x00)) {
        return {
          ok: false,
          reason: `File ${name} contains binary null bytes and is not a valid text CSV.`,
        };
      }

      // Check for excessive non-printable control characters (excluding \t, \n, \r, \f)
      let controlCount = 0;
      for (let i = 0; i < view.length; i++) {
        const b = view[i];
        if (b < 32 && b !== 9 && b !== 10 && b !== 13 && b !== 12) {
          controlCount++;
        }
      }
      if (controlCount > 0) {
        return {
          ok: false,
          reason: `File ${name} contains binary control characters and is not a valid text CSV.`,
        };
      }
    }

    return { ok: true, reason: "" };
  }

  return { ok: false, reason: `File ${name} is not a supported upload type.` };
}
