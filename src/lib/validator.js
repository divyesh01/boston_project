// Centralized input validation.
//
// Single source of truth for format checks used by forms and the local API
// layer, so the same rules that gate the UI also gate the data layer and the
// two cannot drift. Every function is defensive by construction: non-string /
// null / undefined inputs return false instead of throwing.

// RFC 5322 internet address, practical subset: dot-separated local part, then a
// domain of dash-safe labels with a required top-level label. Covers every real
// address this app stores while rejecting the obviously malformed.
const EMAIL_RFC5322 =
  /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;

const USERNAME_RE = /^[A-Za-z0-9_]{3,30}$/;
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * RFC 5322 email check. Accepts strings only; whitespace is trimmed before the
 * check so " user@example.com " passes just like the sanitizer would store it.
 * @param {unknown} email
 * @returns {boolean}
 */
export function isValidEmail(email) {
  if (typeof email !== 'string') return false;
  const trimmed = email.trim();
  if (!trimmed || trimmed.length > 254) return false;
  return EMAIL_RFC5322.test(trimmed);
}

/**
 * Username check: 3-30 alphanumeric/underscore characters.
 * @param {unknown} username
 * @returns {boolean}
 */
export function isValidUsername(username) {
  if (typeof username !== 'string') return false;
  return USERNAME_RE.test(username.trim());
}

/**
 * Financial amount check: a finite number within [min, max]. Empty, null, NaN,
 * Infinity and non-numeric strings all fail fast.
 * @param {unknown} value
 * @param {number} [min]
 * @param {number} [max]
 * @returns {boolean}
 */
export function isValidAmount(value, min = 0, max = 10_000_000) {
  if (value === null || value === undefined || value === '') return false;
  if (typeof value !== 'number' && typeof value !== 'string') return false;
  const num = Number(value);
  if (!Number.isFinite(num)) return false;
  const lo = Number(min);
  const hi = Number(max);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return false;
  return num >= lo && num <= hi;
}

/**
 * ISO-8601 calendar date check (YYYY-MM-DD). The regex guarantees the shape;
 * the round-trip through Date.UTC guarantees it is a real calendar date, so
 * 2026-02-31 is rejected rather than silently normalised.
 * @param {unknown} dateStr
 * @returns {boolean}
 */
export function isValidIsoDate(dateStr) {
  if (typeof dateStr !== 'string') return false;
  const m = ISO_DATE_RE.exec(dateStr.trim());
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const dt = new Date(Date.UTC(year, month - 1, day));
  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() === month - 1 &&
    dt.getUTCDate() === day
  );
}
