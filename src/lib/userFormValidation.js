/**
 * Identity-field validation for the Users admin screen.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `Users.jsx` used to sanitize each field and then treat ANY difference between
 * the raw input and the sanitized value as proof of invalid input:
 *
 *     const sanitizedEmail = sanitizeEmail(form.email);
 *     if (sanitizedUsername !== form.username || sanitizedEmail !== form.email) {
 *       toast({ description: "Invalid characters in username or email." });
 *       return;
 *     }
 *
 * But `sanitizeEmail` (securityUtils.js) *normalizes*: it trims and lowercases.
 * So `Divyesh@Example.com`, or an address with a trailing space picked up from a
 * copy-paste, differed from its sanitized form and was rejected as containing
 * "invalid characters" — a message that is not true, does not say which of the
 * two fields is at fault, and cannot be acted on, because the thing the admin
 * would have to "fix" is capitalisation that every other login form accepts.
 *
 * Normalisation is not a validity signal. This module normalizes first, then
 * validates the normalized value, and returns EVERY failure at once so one
 * round trip tells the admin everything that is wrong.
 *
 * WHAT THIS MODULE DOES NOT DO
 * ----------------------------
 * It does not reimplement, relax or override any rule. `isValidUsername`,
 * `isValidEmail`, `sanitizeEmail`, `sanitizeText` and `sanitizeCsvCell` all live
 * in protected files and remain the only deciders. This module only fixes the
 * ORDER (normalize, then judge) and the WORDING, both of which live in the page.
 *
 * The value the caller persists is always `values.*` — never the raw input — so
 * the stored username is trimmed and the stored email is lowercase, exactly as
 * before. Two admins can no longer create `Bob@x.com` and `bob@x.com` as
 * separate accounts by accident.
 *
 * On username format: `sanitizeAlphanumeric` strips anything outside
 * `[A-Za-z0-9_-]`, while `isValidUsername`'s `USERNAME_RE` is `[A-Za-z0-9_]{3,30}`.
 * For an ALREADY-TRIMMED string the second is strictly stronger than the first,
 * so one check covers both and no input can be silently rewritten into a
 * DIFFERENT account name than the admin typed.
 *
 * "Already-trimmed" is load-bearing, not a hedge. `" abc"` is changed by the
 * sanitizer and accepted by `isValidUsername`, which trims before testing — so
 * the dominance claim is false for untrimmed input and true for trimmed input.
 * That is exactly why this module trims first and validates second.
 * `scripts/probe-user-form-validation.mjs` section 6 proves the trimmed case by
 * sweeping every code point in 0x00-0x2FF, and pins the untrimmed exception as a
 * measured counterexample rather than trusting this paragraph.
 *
 * Passwords are deliberately absent. `validatePasswordStrength` is called by the
 * page and its message is appended by the caller, so no secret ever enters this
 * module.
 */

import { sanitizeEmail, sanitizeText, sanitizeCsvCell } from "@/lib/securityUtils";
import { isValidEmail, isValidUsername } from "@/lib/validator";

/** Message reused by both the create and the edit dialog. */
export const USERNAME_RULE = "Username must be 3-30 characters, using only letters, numbers and underscores.";
export const EMAIL_RULE = "Enter a valid email address.";

/**
 * Plain-language statement of the password policy, for field placeholders and
 * help text.
 *
 * The two dialogs in `Users.jsx` used to read "At least 8 characters,
 * upper/lowercase + number" while `validatePasswordStrength` in security.js
 * demanded twelve characters, a symbol, and no character repeated three times in
 * a row. An admin following the placeholder exactly was refused, with the real
 * rule revealed one clause per attempt.
 *
 * `security.js` is a protected file and cannot export this string, so it lives
 * here — which means it can drift out of step again. That is what
 * `scripts/probe-user-form-validation.mjs` section 4 exists for: it feeds
 * `validatePasswordStrength` a password that satisfies exactly what this sentence
 * promises and asserts it is accepted, then one counter-example per clause and
 * asserts each is refused. Tighten the policy without updating this string and
 * the suite goes red.
 */
export const PASSWORD_HELP =
  "At least 12 characters, with an uppercase letter, a lowercase letter, a number and a symbol, and no character three times in a row.";

/**
 * Normalize and validate the identity fields of the user create/edit form.
 *
 * @param {{ username?: unknown, email?: unknown, full_name?: unknown }} raw
 *        The form state, exactly as typed.
 * @param {{ previousUsername?: string | null }} [options]
 *        `previousUsername` grandfathers an already-stored username: the edit
 *        dialog must not refuse to save an unrelated change (a new email, say)
 *        just because the account's existing name predates the current rule.
 *        Any actual CHANGE to the username is validated in full.
 * @returns {{ ok: boolean, errors: string[], values: { username: string, email: string, full_name: string } }}
 *        `errors` is in field order and empty when `ok`. `values` is always
 *        populated with the normalized forms, so a caller that has checked `ok`
 *        never needs to touch the raw input again.
 */
export function validateUserForm(raw = {}, { previousUsername = null } = {}) {
  const errors = [];

  // Normalize FIRST. Trimming and lowercasing are corrections, not complaints.
  const username = String(raw.username ?? "").trim();
  const email = String(raw.email ?? "").trim().toLowerCase();
  const full_name = sanitizeCsvCell(sanitizeText(String(raw.full_name ?? "")));

  const usernameUnchanged =
    previousUsername !== null && username === String(previousUsername ?? "").trim();

  if (!username) {
    errors.push("Username is required.");
  } else if (!usernameUnchanged && !isValidUsername(username)) {
    errors.push(USERNAME_RULE);
  }

  if (!email) {
    errors.push("Email is required.");
  } else if (!isValidEmail(email)) {
    errors.push(EMAIL_RULE);
  } else if (sanitizeEmail(email) !== email) {
    // Fail closed, as a backstop rather than as a live guard. `isValidEmail` uses
    // an RFC-5322 subset and `sanitizeEmail` a much looser `[^\s@]+@[^\s@]+\.[^\s@]+`,
    // and `email` is already trimmed and lowercased — so on today's two patterns
    // this branch is UNREACHABLE, measured over the corpus in
    // scripts/probe-user-form-validation.mjs section 3. It stays because the
    // sanitizer is what decides what may be stored, both patterns live in
    // protected files this module cannot follow, and if either is ever narrowed
    // the disagreement must surface as a refusal rather than as a stored address
    // the rest of the app would reject.
    errors.push(EMAIL_RULE);
  }

  return { ok: errors.length === 0, errors, values: { username, email, full_name } };
}
