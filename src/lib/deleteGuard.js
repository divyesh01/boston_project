// One gate in front of every destructive click.
//
// Before this existed, four handlers deleted financial records on a single
// unconfirmed click: `Payroll.jsx` (a staff member, a payroll run) had no
// confirmation, no CSRF check and no rate limit at all, and `Expenses.jsx` (an
// expense, a payroll run) had the security checks but still no confirmation.
// The Import page already did it properly — window.confirm, then CSRF, then a
// rate limit — so this lifts that pattern into one place instead of copying
// fifteen lines into each handler, where the next delete added would quietly
// omit them again.
//
// Order matters and is asserted by scripts/probe-delete-guard.mjs: the dialog
// comes FIRST. `sensitiveActionRateLimiter.check()` consumes budget every time
// it is called, so checking it before the dialog would let a few cancelled
// mis-clicks lock the operator out of a delete they actually want.

import {
  getCsrfToken,
  validateCsrfToken,
  rotateCsrfToken,
  sensitiveActionRateLimiter,
} from '@/lib/securityUtils';

/**
 * Assemble the text the operator reads before destroying a record.
 *
 * The title should name the specific record ("Delete the payroll run for Ann
 * Lee?"), and the lines should carry whatever makes a wrong row obvious — the
 * amount, the period, the status.
 *
 * @param {{title: string, lines?: Array<string|null|undefined|false>}} opts
 * @returns {string}
 */
export function buildDestructiveMessage({ title, lines = [] }) {
  const detail = (lines || []).filter((l) => typeof l === 'string' && l.trim());
  return [String(title || 'Delete this record?'), ...detail, 'This cannot be undone.'].join('\n\n');
}

function waitPhrase(retryAfterSeconds) {
  const secs = Number(retryAfterSeconds);
  if (!Number.isFinite(secs) || secs <= 0) return 'Try again shortly.';
  if (secs < 60) return 'Try again in less than a minute.';
  return `Try again in ${Math.ceil(secs / 60)} minutes.`;
}

/**
 * Confirm, rate limit and CSRF-check a destructive action.
 *
 * Returns a decision rather than performing the delete, so each page keeps its
 * own way of telling the user (toast, notice banner, inline message) and the
 * caller stays in control of what it deletes.
 *
 *   const gate = guardDestructiveAction({ title: `Delete ${name}?`, lines: [...] });
 *   if (!gate.ok) { if (gate.message) toast.error(gate.message); return; }
 *   try { await db.entities.X.delete(id); } catch { toast.error(...); return; }
 *   gate.complete();
 *
 * `complete()` rotates the CSRF token and is deliberately NOT called on the
 * guard's way out: rotating before the write would invalidate the token the
 * write is authorised by.
 *
 * The dialog, limiter and CSRF helpers are injectable so the probe can exercise
 * every branch without a browser.
 *
 * @param {{
 *   title: string,
 *   lines?: Array<string|null|undefined|false>,
 *   confirm?: (message: string) => boolean,
 *   rateLimiter?: {check: () => {allowed: boolean, retryAfter?: number}},
 *   csrf?: {get: () => string, validate: (t: string) => boolean, rotate: () => void},
 * }} opts
 * @returns {{ok: true, reason: 'allowed', message: '', complete: () => void}
 *          |{ok: false, reason: 'cancelled'|'rate_limited'|'bad_token', message: string}}
 */
export function guardDestructiveAction({
  title,
  lines = [],
  confirm,
  rateLimiter = sensitiveActionRateLimiter,
  csrf,
}) {
  const ask =
    confirm ||
    ((message) => (typeof window !== 'undefined' && typeof window.confirm === 'function'
      ? window.confirm(message)
      // No dialog available means no informed consent was obtained. Refusing is
      // the safe answer: the operator can retry somewhere the dialog works.
      : false));

  const tokens = csrf || { get: getCsrfToken, validate: validateCsrfToken, rotate: rotateCsrfToken };

  if (!ask(buildDestructiveMessage({ title, lines }))) {
    // A cancelled dialog is not an error — nothing to tell the user.
    return { ok: false, reason: 'cancelled', message: '' };
  }

  const limit = rateLimiter?.check?.() ?? { allowed: true };
  if (!limit.allowed) {
    return {
      ok: false,
      reason: 'rate_limited',
      message: `Too many sensitive actions. ${waitPhrase(limit.retryAfter)}`,
    };
  }

  const token = tokens.get();
  if (!tokens.validate(token)) {
    tokens.rotate();
    return {
      ok: false,
      reason: 'bad_token',
      message: 'Invalid security token. Please refresh the page and try again.',
    };
  }

  return { ok: true, reason: 'allowed', message: '', complete: () => tokens.rotate() };
}
