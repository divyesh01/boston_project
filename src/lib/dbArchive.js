// Whole-database backup and restore.
//
// WHY THIS EXISTS. Every operational and financial record this app holds lives in
// one browser's storage under one origin. There is no server copy. Imported
// reports can be re-imported from the source CSVs, but the staff directory,
// posted payroll, expenses, manual entries, commission rates, tax periods and the
// audit chain exist in exactly one place. Clearing site data, resetting the
// machine, or moving to a new laptop destroys them with nothing to restore from.
// Before this module the only exports were per-page CSVs, none of which can
// rebuild a database.
//
// WHAT MAKES THIS DIFFERENT FROM "JSON.stringify the tables". Five things, each
// of which is a way a backup-shaped file can quietly not be a backup:
//
//   1. NOT ALL OF THE DATABASE IS IN DEXIE. Commission rates
//      (rri_commission_rates_v2), the credit-card fee, tax periods
//      (rri_tax_settings_v1), alert/revenue thresholds, pricing, weather and
//      housekeeping config, and the auto-saved manual-entry draft
//      (manual_draft_*) are plain localStorage. Import lifecycle history — what
//      the Import page lists and what "Undo import" reads — is an ENCRYPTED
//      localStorage slot. All three layers are archived: `stores`,
//      `secure_slots`, `local_slots`.
//   2. The Dexie store list is read from `localDb.tables` at RUNTIME, and every
//      table is archived unless it is named in EXCLUDED_STORES with a written
//      reason. A `version(24)` added next month is archived automatically; it
//      cannot slip out of the backup by omission.
//   3. Whole rows are copied. A Dexie schema string names only the INDEXED
//      fields, so anything built from the schema as a column list would drop
//      every unindexed column — which is where the money is.
//   4. Values are encoded losslessly. Plain JSON turns a Date into a string, NaN
//      and Infinity into null, and drops keys whose value is undefined. A restore
//      that changes types is a restore that changed the data. Anything that
//      cannot be represented faithfully (Blob, ArrayBuffer, Map, Set, RegExp,
//      BigInt, function) FAILS the export and names the store and field, rather
//      than being written out wrong.
//   5. The file carries a SHA-256 checksum over a canonical (recursively
//      key-sorted) serialization, plus a row count per store. A truncated or
//      hand-edited file is refused, not half-restored. This repo's convention is
//      that a checksum mismatch blocks.
//
// WHY THERE IS NO MERGE MODE. Restore replaces; it never merges. Cross-store
// references in this schema are Dexie auto-increment ids: ImportRecordIds holds
// arrays of row ids, and property_id / room_type_id are ids too. Merging two
// databases that each generated ids independently would need every id remapped in
// every referencing field, and one missed reference is a rollback ledger that
// deletes the wrong rows or an expense attached to the wrong hotel. Silent wrong
// data is worse than a refused button, so merge is refused by name. Replace also
// sidesteps the unique `&code` index on Property, which collides on merge.
//
// WHY RAW `localDb` AND NOT `db.entities`. Two reasons, both structural:
// `db.entities.AuditLog.clear()` is refused outright by the proxy's
// `throwIfProtected()` (audit rows are immutable by contract), and the proxy
// stamps created_date/property_id on writes — so a byte-faithful restore cannot
// go through it. No privilege is gained: every entry point here gates on the same
// all-property predicate the proxy's own `clear()` uses, and fails closed.

import localDb from "@/api/localDb";
import { db } from "@/api/base44Client";
import { hasAllPropertyAccess } from "@/lib/launchPolicy";
import { secureRetrieve, secureStore } from "@/lib/securityUtils";
import { downloadBlob, stampFilename } from "@/lib/exportData";

/** File-format identifier. A file without this exact string is not one of ours. */
export const ARCHIVE_FORMAT = "boston-hotel.db-archive";

/**
 * Bumped only for a BREAKING change to the envelope. A reader refuses a file
 * whose version is higher than this one — an older build must not half-read a
 * newer file and call the result a restore.
 */
export const ARCHIVE_FORMAT_VERSION = 1;

export const ARCHIVE_FILE_EXT = ".json";

/**
 * Checked against `file.size` BEFORE the file is read, so a wrong pick (a video,
 * a disk image) is refused without pulling it into memory. Also re-checked
 * against the string length in parseArchive for callers that skip the file gate.
 */
export const ARCHIVE_MAX_BYTES = 300 * 1024 * 1024;

/**
 * Dexie stores deliberately left OUT of the archive. Anything not listed here is
 * archived — the default direction is "include", because the failure mode of
 * including too much is a bigger file, and the failure mode of excluding too much
 * is data loss that surfaces years later.
 */
export const EXCLUDED_STORES = Object.freeze({
  LocalSession:
    "live sign-in sessions. A session minted on another machine is worthless here, " +
    "and re-arming one would be a credential travelling inside a data file.",
  PasswordResetRequest:
    "in-flight password-reset tokens. Archiving them would re-arm tokens that had " +
    "been used, revoked or expired by the time the file is restored.",
});

/**
 * Encrypted localStorage slots (secureStore/secureRetrieve), archived DECRYPTED.
 *
 * The AES-GCM key is non-extractable and lives in a different IndexedDB database
 * per browser, so the ciphertext is unreadable anywhere else — copying the raw
 * `rri_enc_*` bytes would produce a slot that can never be decrypted again. The
 * plaintext travels instead and is re-encrypted with the target browser's own key
 * on restore.
 *
 * The literal is duplicated from `IMPORT_SESSION_KEY` in base44Client.js, which
 * keeps it module-private on purpose. scripts/probe-db-archive.mjs greps that
 * declaration and FAILS if the two strings ever disagree.
 */
export const SECURE_SLOT_KEYS = Object.freeze(["rri_import_sessions"]);

/**
 * Plain-localStorage keys are archived when they start with one of these.
 *
 * `rri_` covers every settings module (commission rates, tax, thresholds,
 * pricing, weather, housekeeping, saved filters, automation rules).
 * `manual_draft_` covers the auto-saved Manual Entry draft, which
 * ManualEntry.jsx keeps on disk deliberately because it is the only copy of what
 * the operator typed.
 *
 * A new key that matches neither prefix would NOT be archived, which is exactly
 * the kind of silent gap this module exists to prevent — so
 * scripts/probe-db-archive.mjs holds a reviewed manifest of every file in src/
 * that writes localStorage and fails when an unclassified writer appears.
 */
export const LOCAL_SLOT_PREFIXES = Object.freeze(["rri_", "manual_draft_"]);

/** Prefixes that match LOCAL_SLOT_PREFIXES but must never be archived. */
export const SKIPPED_LOCAL_SLOT_PREFIXES = Object.freeze({
  rri_enc_:
    "ciphertext of the encrypted slots. Unreadable on any other browser; the " +
    "plaintext travels in secure_slots instead.",
  rri_rate_limit_:
    "rate-limit counters. Restoring another machine's counters would either " +
    "lock this browser out or hand it a fresh allowance.",
});

/**
 * Exact keys that must never be archived, with the reason.
 *
 * Three of these can never reach the scan in the first place — the session record
 * and the rate-limit store are ENCRYPTED slots (so they appear under `rri_enc_`),
 * and the CSRF token lives in sessionStorage, which is not scanned at all. They
 * are named anyway, because "does my backup file contain my session token?" is a
 * question this list should answer without a reader having to trace three modules.
 */
export const SKIPPED_LOCAL_SLOTS = Object.freeze({
  rri_session_revocation: "cross-tab revocation signal, meaningful only in the tab that wrote it.",
  rri_realtime_change: "cross-tab change ping, consumed within milliseconds.",
  rri_audit_write_failures_v1:
    "machine-local record of audit writes that failed IN THIS BROWSER. Restoring " +
    "another machine's failures would misreport this one's health.",
  _rri_test_: "storage-availability probe; written and removed in the same call.",
  rr_local_session: "the live session token. Never travels in a data file.",
  rri_rate_limits_v1: "rate-limit counters (see rri_rate_limit_ above).",
  rri_csrf_token: "per-session CSRF token; a new one is minted on load.",
});

// ─── Value codec ─────────────────────────────────────────────────────────────
// Tag key chosen to be something no row in this schema uses. A plain object that
// happens to carry it is escaped rather than misread — see the "obj" tag.

const TAG = "$dba";

/**
 * @param {any} value
 * @param {string} path store/field path, used verbatim in the failure message
 * @param {string[]} hazards collects every unrepresentable value found
 * @returns {any} JSON-safe representation
 */
export function encodeValue(value, path, hazards) {
  if (value === undefined) return { [TAG]: "undefined" };
  if (value === null) return null;

  const t = typeof value;
  if (t === "string" || t === "boolean") return value;
  if (t === "number") {
    // JSON.stringify writes NaN/Infinity as `null` without complaint, which is a
    // silent type change in a money field. Refuse instead.
    if (!Number.isFinite(value)) {
      hazards.push(`${path} is ${String(value)}, which JSON cannot represent`);
      return null;
    }
    return value;
  }
  if (t === "bigint" || t === "function" || t === "symbol") {
    hazards.push(`${path} is a ${t}`);
    return null;
  }

  if (value instanceof Date) {
    const ms = value.getTime();
    if (!Number.isFinite(ms)) {
      hazards.push(`${path} is an Invalid Date`);
      return null;
    }
    return { [TAG]: "date", v: value.toISOString() };
  }

  if (Array.isArray(value)) {
    return value.map((v, i) => encodeValue(v, `${path}[${i}]`, hazards));
  }

  // Structured clone (what IndexedDB gives back) preserves Date, RegExp, Map,
  // Set, Blob, File, ArrayBuffer and typed arrays as those exact types and
  // flattens everything else to a plain object. Date is handled above; the rest
  // cannot survive a JSON round trip, so anything whose prototype is not
  // Object.prototype (or null) is refused by name rather than written as `{}`.
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    const kind = value?.constructor?.name || "a non-plain object";
    hazards.push(`${path} is ${kind}, which cannot be represented in JSON without loss`);
    return null;
  }

  /** @type {Record<string, any>} */
  const out = {};
  for (const key of Object.keys(value)) {
    out[key] = encodeValue(value[key], `${path}.${key}`, hazards);
  }
  // A real row that happens to have a `$dba` key would otherwise be decoded as a
  // tagged node. Wrap it so decode reads the payload's ENTRIES and never treats
  // the payload itself as a tag.
  if (Object.prototype.hasOwnProperty.call(out, TAG)) return { [TAG]: "obj", v: out };
  return out;
}

/** Inverse of encodeValue. Throws on a tag it does not know. */
export function decodeValue(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(decodeValue);

  const tag = /** @type {any} */ (value)[TAG];
  if (typeof tag === "string") {
    if (tag === "undefined") return undefined;
    if (tag === "date") return new Date(/** @type {any} */ (value).v);
    if (tag === "obj") {
      const payload = /** @type {any} */ (value).v || {};
      /** @type {Record<string, any>} */
      const out = {};
      for (const key of Object.keys(payload)) out[key] = decodeValue(payload[key]);
      return out;
    }
    throw new Error(`Unsupported encoded value "${tag}" in this archive`);
  }

  /** @type {Record<string, any>} */
  const out = {};
  for (const key of Object.keys(value)) out[key] = decodeValue(/** @type {any} */ (value)[key]);
  return out;
}

/**
 * JSON with object keys in sorted order at every depth, so the checksum depends
 * on the DATA and not on key insertion order — which differs between a row Dexie
 * just read and the same row rebuilt from a file.
 */
export function canonicalJson(value) {
  if (value === undefined) {
    // Unreachable through encodeValue (undefined becomes a tagged node). If it
    // ever fires, the encoder leaked and the checksum would be meaningless.
    throw new Error("canonicalJson: raw undefined leaked into the encoded payload");
  }
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(/** @type {any} */ (value)[k])}`).join(",")}}`;
}

/** SHA-256 of the canonical serialization of `payload`, lowercase hex. */
export async function archiveChecksum(payload) {
  const bytes = new TextEncoder().encode(canonicalJson(payload));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ─── Classification ──────────────────────────────────────────────────────────

/**
 * Split the live Dexie tables into archived and deliberately-excluded.
 * Sorted so two exports of the same database produce byte-identical files.
 *
 * @param {string[]} tableNames
 */
export function classifyStores(tableNames) {
  /** @type {string[]} */
  const included = [];
  /** @type {string[]} */
  const excluded = [];
  for (const name of [...tableNames].sort()) {
    if (Object.prototype.hasOwnProperty.call(EXCLUDED_STORES, name)) excluded.push(name);
    else included.push(name);
  }
  return { included, excluded };
}

/** @param {string} key */
export function shouldArchiveLocalKey(key) {
  if (typeof key !== "string" || !key) return false;
  if (Object.prototype.hasOwnProperty.call(SKIPPED_LOCAL_SLOTS, key)) return false;
  for (const prefix of Object.keys(SKIPPED_LOCAL_SLOT_PREFIXES)) {
    if (key.startsWith(prefix)) return false;
  }
  return LOCAL_SLOT_PREFIXES.some((prefix) => key.startsWith(prefix));
}

// ─── Permission gate ─────────────────────────────────────────────────────────

/**
 * Fails CLOSED: an auth error, a missing user or a user without portfolio-wide
 * access is refused. Same predicate the entity proxy's own clear() uses.
 * @param {string} verb
 */
async function requireAllPropertyAccess(verb) {
  let me = null;
  try {
    me = await db.auth.me();
  } catch {
    me = null;
  }
  if (!me || !hasAllPropertyAccess(me)) {
    throw new Error(
      `Only an owner or admin with access to every property can ${verb} a database backup.`,
    );
  }
  return me;
}

// ─── Export ──────────────────────────────────────────────────────────────────

/**
 * @typedef {object} Archive
 * @property {string} format
 * @property {number} format_version
 * @property {string} database
 * @property {number} schema_version
 * @property {string} exported_at
 * @property {string|null} exported_by
 * @property {string|null} origin
 * @property {Record<string, number>} counts
 * @property {number} total_rows
 * @property {Record<string, string>} excluded_stores
 * @property {string} checksum
 * @property {{ stores: Record<string, any[]>, secure_slots: Record<string, any>, local_slots: Record<string, string> }} payload
 */

/**
 * Read the whole database into an archive object. Nothing is written and nothing
 * is downloaded — serializeArchive/downloadArchive do that.
 *
 * @param {{ now?: Date }} [options]
 * @returns {Promise<Archive>}
 */
export async function buildArchive({ now = new Date() } = {}) {
  const me = await requireAllPropertyAccess("export");
  const { included } = classifyStores(localDb.tables.map((t) => t.name));

  /** @type {string[]} */
  const hazards = [];
  /** @type {Record<string, any[]>} */
  const stores = {};
  /** @type {Record<string, number>} */
  const counts = {};

  for (const name of included) {
    const rows = await localDb[name].toArray();
    stores[name] = rows.map((row, i) => encodeValue(row, `${name}[${i}]`, hazards));
    counts[name] = rows.length;
  }

  /** @type {Record<string, any>} */
  const secureSlots = {};
  for (const key of SECURE_SLOT_KEYS) {
    // secureRetrieve returns null both for "never written" and for "could not be
    // decrypted" — it cannot tell them apart, and neither can this module. Either
    // way there is nothing readable to archive, and the Dexie-side import ledger
    // (ImportRecordIds) travels intact, so undo survives even when the display
    // history does not.
    const value = await secureRetrieve(key);
    secureSlots[key] = encodeValue(value === null ? [] : value, `secure_slots.${key}`, hazards);
  }

  /** @type {Record<string, string>} */
  const localSlots = {};
  const ls = safeLocalStorage();
  if (ls) {
    for (let i = 0; i < ls.length; i += 1) {
      const key = ls.key(i);
      if (!key || !shouldArchiveLocalKey(key)) continue;
      const raw = ls.getItem(key);
      // Stored verbatim as the string localStorage holds. Re-parsing it here
      // would mean re-serializing on restore, and a value the app wrote with its
      // own quirks (a bare "0.025", a "1" flag) would come back subtly different.
      if (typeof raw === "string") localSlots[key] = raw;
    }
  }

  if (hazards.length) {
    throw new Error(
      `Export refused: ${hazards.length} value(s) cannot be stored in a backup without ` +
        `changing them.\n- ${hazards.slice(0, 10).join("\n- ")}` +
        (hazards.length > 10 ? `\n- ...and ${hazards.length - 10} more` : ""),
    );
  }

  const payload = { stores, secure_slots: secureSlots, local_slots: localSlots };
  const checksum = await archiveChecksum(payload);

  return {
    format: ARCHIVE_FORMAT,
    format_version: ARCHIVE_FORMAT_VERSION,
    database: localDb.name,
    schema_version: localDb.verno,
    exported_at: now.toISOString(),
    exported_by: me?.email || me?.username || null,
    origin: typeof location !== "undefined" ? location.origin : null,
    counts,
    total_rows: Object.values(counts).reduce((sum, n) => sum + n, 0),
    excluded_stores: { ...EXCLUDED_STORES },
    checksum,
    payload,
  };
}

/** @param {Archive} archive */
export function serializeArchive(archive) {
  // Indented on purpose: this file is the last copy of the data, and a human
  // being with a text editor is a legitimate recovery path.
  return JSON.stringify(archive, null, 2);
}

/** @param {Date} [now] */
export function archiveFilename(now = new Date()) {
  return stampFilename("hotel-backup", "json", now);
}

/**
 * Build, serialize and download in one step.
 * @returns {Promise<{ filename: string, bytes: number, total_rows: number, stores: number, local_slots: number }>}
 */
export async function downloadArchive({ now = new Date() } = {}) {
  const archive = await buildArchive({ now });
  const text = serializeArchive(archive);
  const filename = archiveFilename(now);
  downloadBlob(new Blob([text], { type: "application/json" }), filename);
  return {
    filename,
    bytes: text.length,
    total_rows: archive.total_rows,
    stores: Object.keys(archive.payload.stores).length,
    local_slots: Object.keys(archive.payload.local_slots).length,
  };
}

// ─── Restore ─────────────────────────────────────────────────────────────────

/**
 * The restore door's own file gate. Deliberately NOT uploadGuard.js: that gate
 * guards the report importer and allows only .csv/.xlsx/.xls, and widening its
 * allowlist to admit .json would also let a .json file into the report path.
 *
 * @param {{ name?: string, size?: number }} file
 * @returns {{ ok: boolean, reason?: string }}
 */
export function inspectArchiveFile(file) {
  if (!file) return { ok: false, reason: "No file selected." };
  const name = String(file.name || "");
  if (!name.toLowerCase().endsWith(ARCHIVE_FILE_EXT)) {
    return { ok: false, reason: `A backup is a ${ARCHIVE_FILE_EXT} file. "${name}" is not.` };
  }
  const size = Number(file.size || 0);
  if (!(size > 0)) return { ok: false, reason: "That file is empty." };
  if (size > ARCHIVE_MAX_BYTES) {
    return {
      ok: false,
      reason: `That file is ${Math.round(size / (1024 * 1024))} MB, past the ${Math.round(
        ARCHIVE_MAX_BYTES / (1024 * 1024),
      )} MB limit for a backup.`,
    };
  }
  return { ok: true };
}

/**
 * @typedef {object} ParsedArchive
 * @property {Archive} archive
 * @property {string[]} storeNames stores present in the file
 * @property {string[]} missingStores live stores the file does not carry (a warning)
 * @property {number} totalRows
 * @property {string[]} localSlotKeys
 * @property {string[]} secureSlotKeys
 */

/**
 * Validate a backup file end to end WITHOUT touching the database, so the UI can
 * show what a restore would do before anything is destroyed. Every failure path
 * throws with a sentence an operator can act on.
 *
 * @param {string} text
 * @returns {Promise<ParsedArchive>}
 */
export async function parseArchive(text) {
  if (typeof text !== "string" || !text.trim()) throw new Error("That file is empty.");
  if (text.length > ARCHIVE_MAX_BYTES) throw new Error("That file is too large to be a backup.");

  /** @type {any} */
  let archive;
  try {
    archive = JSON.parse(text);
  } catch {
    throw new Error("That file is not valid JSON, so it is not a backup this app wrote.");
  }
  if (!archive || typeof archive !== "object" || Array.isArray(archive)) {
    throw new Error("That file does not contain a backup.");
  }
  if (archive.format !== ARCHIVE_FORMAT) {
    throw new Error(
      `That file is not a hotel database backup (expected format "${ARCHIVE_FORMAT}", found ` +
        `${archive.format ? `"${archive.format}"` : "nothing"}).`,
    );
  }
  const version = Number(archive.format_version);
  if (!Number.isInteger(version) || version < 1) {
    throw new Error("That backup does not say which format version it uses.");
  }
  if (version > ARCHIVE_FORMAT_VERSION) {
    throw new Error(
      `That backup was written by a newer version of this app (format ${version}, this build ` +
        `reads ${ARCHIVE_FORMAT_VERSION}). Update the app before restoring it.`,
    );
  }
  if (archive.database && archive.database !== localDb.name) {
    throw new Error(
      `That backup is from a different database ("${archive.database}", not "${localDb.name}").`,
    );
  }

  const payload = archive.payload;
  if (!payload || typeof payload !== "object" || !payload.stores || typeof payload.stores !== "object") {
    throw new Error("That backup has no table data in it.");
  }

  // Checksum FIRST among the content checks: every later message would otherwise
  // describe a file we already know to be damaged.
  const recomputed = await archiveChecksum({
    stores: payload.stores,
    secure_slots: payload.secure_slots || {},
    local_slots: payload.local_slots || {},
  });
  if (recomputed !== archive.checksum) {
    throw new Error(
      "That backup's checksum does not match its contents — the file was truncated, edited or " +
        "corrupted in transit. Restoring it could load partial records, so it is refused.",
    );
  }

  const liveNames = new Set(localDb.tables.map((t) => t.name));
  const storeNames = Object.keys(payload.stores).sort();

  const unknown = storeNames.filter((name) => !liveNames.has(name));
  if (unknown.length) {
    // Catches a Transaction/ImportSession-era file (both stores were dropped)
    // instead of restoring the rest and silently discarding those rows.
    throw new Error(
      `That backup contains table(s) this version of the app no longer has: ${unknown.join(", ")}. ` +
        "Restoring it would silently discard them.",
    );
  }
  const excludedPresent = storeNames.filter((name) =>
    Object.prototype.hasOwnProperty.call(EXCLUDED_STORES, name),
  );
  if (excludedPresent.length) {
    throw new Error(
      `That backup contains table(s) a backup is never supposed to carry: ${excludedPresent.join(", ")}.`,
    );
  }

  const schemaVersion = Number(archive.schema_version);
  if (Number.isFinite(schemaVersion) && schemaVersion > localDb.verno) {
    throw new Error(
      `That backup is from schema version ${schemaVersion}; this build is at ${localDb.verno}. ` +
        "Update the app before restoring it.",
    );
  }

  let totalRows = 0;
  for (const name of storeNames) {
    const rows = payload.stores[name];
    if (!Array.isArray(rows)) throw new Error(`Table "${name}" in that backup is not a list of rows.`);
    const declared = archive.counts ? Number(archive.counts[name]) : NaN;
    if (Number.isFinite(declared) && declared !== rows.length) {
      throw new Error(
        `Table "${name}" says it has ${declared} row(s) but carries ${rows.length}. The file is inconsistent.`,
      );
    }
    totalRows += rows.length;
  }

  const { included } = classifyStores([...liveNames]);
  const missingStores = included.filter((name) => !storeNames.includes(name));

  return {
    archive: /** @type {Archive} */ (archive),
    storeNames,
    missingStores,
    totalRows,
    localSlotKeys: Object.keys(payload.local_slots || {}).sort(),
    secureSlotKeys: Object.keys(payload.secure_slots || {}).sort(),
  };
}

/**
 * Replace the contents of this database with the archive's.
 *
 * All-or-nothing for the Dexie side: every clear and every insert runs inside ONE
 * transaction, so a failure anywhere leaves the existing data exactly as it was.
 * A half-restored hotel database is the one outcome worse than a failed restore.
 *
 * @param {ParsedArchive} parsed the return value of parseArchive
 * @param {{ confirm?: string }} [options] must be `{ confirm: "REPLACE" }`
 */
export async function restoreArchive(parsed, { confirm } = {}) {
  if (confirm !== "REPLACE") {
    throw new Error(
      "Restore replaces this database; it cannot merge two of them (row ids would collide and " +
        "cross-references would point at the wrong rows). Pass confirm: \"REPLACE\" to proceed.",
    );
  }
  await requireAllPropertyAccess("restore");

  const { archive } = parsed;
  const { included } = classifyStores(localDb.tables.map((t) => t.name));

  // Decode everything BEFORE opening the transaction. Dexie's transaction zone
  // ends the moment a non-Dexie promise is awaited inside it, and a zone that has
  // silently ended is how a previous change broke every import.
  /** @type {Record<string, any[]>} */
  const decoded = {};
  for (const name of included) {
    const rows = archive.payload.stores[name];
    decoded[name] = Array.isArray(rows) ? rows.map(decodeValue) : [];
  }

  /** @type {Record<string, number>} */
  const restoredByTable = {};
  await localDb.transaction(
    "rw",
    included.map((name) => localDb[name]),
    async () => {
      for (const name of included) {
        await localDb[name].clear();
        const rows = decoded[name];
        if (rows.length) {
          // bulkPut, not bulkAdd, and uniform across every store: all 31 live
          // stores have an INBOUND primary key (30 x `++id`, IdSequence on
          // `prefix`), so the key rides inside the object and both the ids and
          // every cross-store reference to them survive the restore unchanged.
          await localDb[name].bulkPut(rows);
        }
        restoredByTable[name] = rows.length;
      }
    },
  );

  // AFTER the commit, for the zone reason above: localStorage is not Dexie.
  /** @type {string[]} */
  const warnings = [];

  for (const key of SECURE_SLOT_KEYS) {
    const encoded = archive.payload.secure_slots ? archive.payload.secure_slots[key] : undefined;
    const value = encoded === undefined ? [] : decodeValue(encoded);
    // secureStore reports false instead of throwing. Unchecked, a failure here
    // would leave the Import page's history empty with no explanation.
    const ok = await secureStore(key, value);
    if (!ok) warnings.push(`Import history could not be written back (${key}).`);
  }

  const ls = safeLocalStorage();
  let localSlots = 0;
  if (!ls) {
    warnings.push("Settings (commission rates, tax periods, thresholds) could not be restored: this browser blocked local storage.");
  } else {
    const incoming = archive.payload.local_slots || {};
    // Replace, not merge, for the same reason the tables are replaced: keys the
    // archive predates are removed so the result is the backup, not a blend of
    // the backup and whatever this browser happened to hold. Skipped keys
    // (sessions, rate limits, ciphertext) are never touched.
    for (let i = ls.length - 1; i >= 0; i -= 1) {
      const key = ls.key(i);
      if (key && shouldArchiveLocalKey(key) && !Object.prototype.hasOwnProperty.call(incoming, key)) {
        ls.removeItem(key);
      }
    }
    for (const key of Object.keys(incoming)) {
      if (!shouldArchiveLocalKey(key)) {
        warnings.push(`Skipped "${key}" from the backup: it is not a setting a backup may write.`);
        continue;
      }
      ls.setItem(key, String(incoming[key]));
      localSlots += 1;
    }
  }

  return {
    total_rows: Object.values(restoredByTable).reduce((sum, n) => sum + n, 0),
    restoredByTable,
    stores: included.length,
    local_slots: localSlots,
    missing_stores: parsed.missingStores,
    exported_at: archive.exported_at || null,
    checksum: archive.checksum,
    warnings,
    // The signed-in account came from the database that was just replaced. Its
    // row may not exist any more, so the caller must reload rather than carry on
    // with a user object that no longer has a record behind it.
    requiresReauth: true,
  };
}

/**
 * Same shape as securityUtils' private helper: a browser with storage disabled
 * throws on ACCESS, not just on write, so every use has to be guarded.
 */
function safeLocalStorage() {
  try {
    if (typeof localStorage === "undefined") return null;
    localStorage.setItem("_rri_test_", "_test_");
    localStorage.removeItem("_rri_test_");
    return localStorage;
  } catch {
    return null;
  }
}
