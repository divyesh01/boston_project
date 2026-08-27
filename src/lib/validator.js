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
