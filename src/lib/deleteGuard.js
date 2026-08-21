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
//
// The referential advisory (`dependents`) is folded in before the dialog because
// it is part of what the dialog says. The operator's real question when removing
// a person or a record is "does this erase the history too?", and the prose that
// used to answer it ("runs are kept") could not say whether that meant one run
// or forty.

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

/**
 * A record that points at the thing being deleted.
 *
 * A `count` of 0 is not an omission. A caller usually cannot know a count is
 * zero until it has already queried, so it passes the whole list every time and
 * the guard drops the empty entries — otherwise a dialog would read "0 payroll
 * runs" and teach the operator to ignore the section.
 *
 * These are advisory by design. No entity in this schema links to another by id
 * (PayrollRun stores employee_name, not a staff id), so no delete here is
 * refusable on referential grounds — the purpose is disclosure, not veto. If a
 * real foreign key ever appears, that is the moment to add a refusing branch,
 * with a caller to justify it.
 *
 * @typedef {{label: string, count: number, detail?: string}} Dependent
 */

/** Drop dependents that say nothing: no label, or a count that is not a real number above zero. */
function activeDependents(dependents) {
  return (dependents || []).filter((d) => {
    if (!d || typeof d.label !== 'string' || !d.label.trim()) return false;
    const n = Number(d.count);
    return Number.isFinite(n) && n > 0;
  });
}

/** One line per dependent, count first so the numbers align when skimmed. */
function dependentLines(dependents) {
  return dependents.map((d) => {
    const head = `• ${Number(d.count)} ${String(d.label).trim()}`;
    const detail = typeof d.detail === 'string' && d.detail.trim() ? ` — ${d.detail.trim()}` : '';
    return head + detail;
  });
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
 *   dependents?: Array<Dependent|null|undefined>,
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
  dependents = [],
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

  // Referential reality, ahead of the dialog — see the header note.
  const linked = activeDependents(dependents);

  // Folded in as ONE paragraph with internal newlines: buildDestructiveMessage
  // joins with blank lines, which would otherwise scatter the list down the page.
  const advisory = linked.length
    ? [['Related records that stay behind (these are NOT deleted):', ...dependentLines(linked)].join('\n')]
    : [];

  if (!ask(buildDestructiveMessage({ title, lines: [...lines, ...advisory] }))) {
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
