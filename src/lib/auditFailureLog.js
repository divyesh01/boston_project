// A durable, visible record of audit events that could NOT be written.
//
// Three call sites — `logAuditEvent` (auditLogger.js), `db.audit.log`
// (base44Client.js) and `applyDynamicRateOverride` (pricingOverride.js) — caught a
// failed audit write and `console.error`d it. A console line in a browser is not a
// signal: nobody is watching it, it is gone on the next reload, and the operation
// that should have been recorded carried on as though it had been. That is the one
// failure mode an append-only trail cannot tolerate quietly, because the trail's
// whole value is that an absence means "nothing happened". A rate override, a
// payroll approval or a session revocation could complete unrecorded and the
// chain would still verify green — `audit_verify` checks that the rows present are
// linked, and it cannot know about a row that was never offered to it.
//
// Deliberately NOT solved by throwing. `AuthContext.jsx:222` awaits
// `logAuditEvent` during cross-tab session revocation, and six callers await
// `db.audit.log`, including the report import path; making a logging failure break
// the operation it merely observes would turn an audit outage into a hotel-wide
// one. The server-side writers already take this position for the same reason
// (see `base44/functions/autoPayroll/entry.ts#writeAudit`, and the note in
// `custom_auth_login` that a missing chain secret drops the event rather than
// locking every user out). So the contract here is: never throw, always record,
// and let the Audit Log page say so out loud.
//
// The counterpart to this is `custom_user_admin`, which refuses a privileged
// mutation *before* applying it when it cannot audit. That is the right call where
// the write has not happened yet. Everything routed through this module is the
// other case — the deed is done, and the honest thing left is to admit the gap.

const STORAGE_KEY = "rri_audit_write_failures_v1";

// Bounded so a persistent outage cannot grow without limit or blow the storage
// quota. Newest wins: during a sustained failure the most recent events are the
// ones an operator can still act on.
const MAX_ENTRIES = 50;

// Used only when localStorage is unavailable or refuses the write — private
// browsing, a full quota, or a hardened profile. Losing the record on reload is
// bad; throwing from the failure handler of a failure handler is worse, and would
// re-swallow the very thing this module exists to surface.
let memoryFallback = [];
let usedMemoryFallback = false;

// Resolved on every call rather than cached, because availability is not static:
// `localStorage` can be absent (Node, a worker), present but throwing on access
// (a blocked third-party context), or present and refusing writes (full quota).
//
// This must return null — not an optional-chained no-op — when there is no
// storage. `globalThis.localStorage?.setItem(...)` evaluates to `undefined`
// WITHOUT throwing when localStorage is missing, so a writer built on it reports
// success for a write that never happened, drops the entry from the memory
// fallback, and loses the record. That is the module's own failure mode
// reproducing the bug it was written to fix.
function storage() {
  try {
    const s = globalThis.localStorage;
    return s && typeof s.getItem === "function" && typeof s.setItem === "function" ? s : null;
  } catch {
    return null;
  }
}

function readRaw() {
  const s = storage();
  if (!s) return [];
  try {
    const text = s.getItem(STORAGE_KEY);
    if (!text) return [];
    const parsed = JSON.parse(text);
    // A hand-edited or half-written value must not poison every later read.
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeRaw(list) {
  const s = storage();
  if (!s) return false;
  try {
    s.setItem(STORAGE_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

// Whatever was thrown has to become a short string without ever throwing itself.
// `error.message` alone loses a non-Error rejection (a bare string, a Response),
// which is exactly what an offline fetch tends to produce; JSON.stringify alone
// throws on a circular object, which would drop the record of the very failure
// being reported.
function describeError(error) {
  if (error instanceof Error) return error.message || error.name || "Error";
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error ?? null);
  } catch {
    try {
      return String(error);
    } catch {
      return "unserialisable error";
    }
  }
}

/**
 * Record that an audit event could not be persisted.
 *
 * Never throws and never rejects — every caller is already inside a catch block
 * handling something that went wrong.
 *
 * @param {string} action  the audit action that was lost, e.g. "RATE_OVERRIDE_APPLIED"
 * @param {unknown} error  whatever the failed write threw
 * @param {object} [extra] optional context worth keeping (property, user, source)
 */
export function recordAuditFailure(action, error, extra = {}) {
  try {
    const entry = {
      action: String(action || "unknown"),
      reason: describeError(error),
      at: new Date().toISOString(),
      ...extra,
    };

    // Merge both halves, then order newest-first before truncating. Sorting is
    // not cosmetic: entries held in memory after a failed write are not
    // necessarily newer than what is already stored, and MAX_ENTRIES drops from
    // the tail — an unsorted merge could discard a newer failure than one it
    // keeps. ISO-8601 strings sort correctly as strings.
    const next = [entry, ...readRaw(), ...memoryFallback]
      .sort((a, b) => String(b?.at || "").localeCompare(String(a?.at || "")))
      .slice(0, MAX_ENTRIES);
    if (writeRaw(next)) {
      memoryFallback = [];
    } else {
      usedMemoryFallback = true;
      memoryFallback = next;
    }
  } catch {
    // Recording the failure must not itself fail loudly. If even this path
    // breaks, the operation being audited still proceeds untouched.
  }
}

/** Every recorded failure, newest first. Safe to call before anything was recorded. */
export function readAuditFailures() {
  const stored = readRaw();
  if (!stored.length) return [...memoryFallback];
  if (!memoryFallback.length) return stored;
  // Both halves are already newest-first; merge without trusting either to be
  // a superset of the other.
  return [...memoryFallback, ...stored].slice(0, MAX_ENTRIES);
}

/** How many audit events are known to have been lost. */
export function auditFailureCount() {
  return readAuditFailures().length;
}

/**
 * True when at least one failure could only be held in memory, so the count on
 * screen understates what has been lost across reloads. The UI says so rather
 * than presenting an incomplete number as complete.
 */
export function auditFailuresMayBeIncomplete() {
  return usedMemoryFallback;
}

/**
 * Clear the record. This is an acknowledgement by an operator, not a repair:
 * the audit rows themselves are gone and cannot be reconstructed from here.
 */
export function clearAuditFailures() {
  memoryFallback = [];
  usedMemoryFallback = false;
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    // Nothing further to do — the in-memory half is already cleared.
  }
}

// Exported for the probe, which asserts the stored shape directly rather than
// trusting the accessors it is testing.
export const AUDIT_FAILURE_STORAGE_KEY = STORAGE_KEY;
export const AUDIT_FAILURE_MAX_ENTRIES = MAX_ENTRIES;
