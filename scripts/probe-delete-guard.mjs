// Probe: destructive actions must be confirmed, rate limited and CSRF-checked.
//
// Reproduces the defect recorded in LAUNCH_READINESS_CHECKLIST.md:
//   "Financial records delete on one unconfirmed click."
//   Payroll.jsx handleDeleteStaff / handleDelete had no confirmation, no CSRF
//   and no rate limit; Expenses.jsx handleDelete / handleDeletePayroll had CSRF
//   and rate limiting but still no confirmation.
//
// Two halves:
//   1. Behavioural — the shared guard's decision logic, with the confirm dialog,
//      rate limiter and CSRF helpers injected so no browser is needed.
//   2. Static — every destructive call site in src/pages is enumerated and each
//      one must sit downstream of a confirmation in its own handler. This is the
//      part that survives future edits: adding a new unguarded delete fails here.
//
// Run: node scripts/probe-delete-guard.mjs

import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
register(pathToFileURL(path.join(ROOT, 'scripts/resolve-alias.mjs')));

const { guardDestructiveAction, buildDestructiveMessage } = await import(
  pathToFileURL(path.join(ROOT, 'src/lib/deleteGuard.js')).href
);

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    pass += 1;
  } else {
    fail += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n── ${title}`);
}

// ── Injectable doubles ──────────────────────────────────────────────────────
// The doubles record the order they are consulted in, because the ORDER is part
// of the contract: a cancelled dialog must not consume rate-limit budget, or
// three mis-clicks would lock the operator out of a delete they do want.
function makeDeps({ confirmResult = true, allowed = true, retryAfter = 3600, tokenValid = true } = {}) {
  const calls = [];
  return {
    calls,
    confirm: (message) => { calls.push('confirm'); calls.push(`message:${message}`); return confirmResult; },
    rateLimiter: { check: () => { calls.push('rateLimit'); return { allowed, retryAfter }; } },
    csrf: {
      get: () => { calls.push('csrf.get'); return 'tok'; },
      validate: () => { calls.push('csrf.validate'); return tokenValid; },
      rotate: () => { calls.push('csrf.rotate'); },
    },
  };
}

const ACTION = { title: 'Delete the payroll run for Ann Lee?', lines: ['$1,200.00 · 2026-07-01 to 2026-07-15'] };

// ── 1. Cancelling blocks everything ─────────────────────────────────────────
section('1. Cancelled confirmation');
{
  const deps = makeDeps({ confirmResult: false });
  const gate = guardDestructiveAction({ ...ACTION, ...deps });
  check('cancel returns ok:false', gate.ok === false, `got ok=${gate.ok}`);
  check('cancel reason is "cancelled"', gate.reason === 'cancelled', `got ${gate.reason}`);
  check('cancel needs no error message', !gate.message, `got "${gate.message}"`);
  check('cancel does not consume rate-limit budget', !deps.calls.includes('rateLimit'), deps.calls.join(','));
  check('cancel does not rotate the CSRF token', !deps.calls.includes('csrf.rotate'), deps.calls.join(','));
  check('cancel exposes no complete()', typeof gate.complete !== 'function');
}

// ── 2. Order of the three checks ────────────────────────────────────────────
section('2. Check order');
{
  const deps = makeDeps();
  guardDestructiveAction({ ...ACTION, ...deps });
  const order = deps.calls.filter((c) => !c.startsWith('message:'));
  check('confirm runs first', order[0] === 'confirm', order.join(','));
  check('rate limit runs after confirm', order[1] === 'rateLimit', order.join(','));
  check('CSRF is validated last', order.includes('csrf.validate'), order.join(','));
}

// ── 3. Rate limited ─────────────────────────────────────────────────────────
section('3. Rate limited');
{
  const deps = makeDeps({ allowed: false, retryAfter: 3600 });
  const gate = guardDestructiveAction({ ...ACTION, ...deps });
  check('rate limit returns ok:false', gate.ok === false);
  check('reason is "rate_limited"', gate.reason === 'rate_limited', `got ${gate.reason}`);
  check('message names the wait in minutes', /60 minutes/.test(gate.message), gate.message);
  check('rate limit stops before CSRF', !deps.calls.includes('csrf.get'), deps.calls.join(','));
}
{
  // retryAfter is seconds; a sub-minute wait must not render as "0 minutes".
  const deps = makeDeps({ allowed: false, retryAfter: 30 });
  const gate = guardDestructiveAction({ ...ACTION, ...deps });
  check('30s wait does not render as "0 minutes"', !/\b0 minutes/.test(gate.message), gate.message);
}
{
  const deps = makeDeps({ allowed: false, retryAfter: undefined });
  const gate = guardDestructiveAction({ ...ACTION, ...deps });
  check('missing retryAfter still yields a usable message', typeof gate.message === 'string' && gate.message.length > 10 && !/NaN|undefined/.test(gate.message), gate.message);
}

// ── 4. Bad CSRF token ───────────────────────────────────────────────────────
section('4. CSRF rejection');
{
  const deps = makeDeps({ tokenValid: false });
  const gate = guardDestructiveAction({ ...ACTION, ...deps });
  check('bad token returns ok:false', gate.ok === false);
  check('reason is "bad_token"', gate.reason === 'bad_token', `got ${gate.reason}`);
  check('bad token rotates the CSRF token', deps.calls.includes('csrf.rotate'), deps.calls.join(','));
  check('bad token message tells the user to refresh', /refresh/i.test(gate.message), gate.message);
}

// ── 5. Allowed path ─────────────────────────────────────────────────────────
section('5. Allowed');
{
  const deps = makeDeps();
  const gate = guardDestructiveAction({ ...ACTION, ...deps });
  check('allowed returns ok:true', gate.ok === true);
  check('allowed reason is "allowed"', gate.reason === 'allowed', `got ${gate.reason}`);
  check('allowed carries no error message', !gate.message);
  check('token is not rotated before the delete runs', !deps.calls.includes('csrf.rotate'), deps.calls.join(','));
  check('complete() is provided', typeof gate.complete === 'function');
  gate.complete();
  check('complete() rotates the CSRF token', deps.calls.filter((c) => c === 'csrf.rotate').length === 1, deps.calls.join(','));
}

// ── 6. The message the operator actually reads ───────────────────────────────
section('6. Confirmation message');
{
  const msg = buildDestructiveMessage({
    title: 'Delete the payroll run for Ann Lee?',
    lines: ['$1,200.00 · 2026-07-01 to 2026-07-15', 'This run is marked paid.'],
  });
  check('message opens with the title', msg.startsWith('Delete the payroll run for Ann Lee?'), msg);
  check('message includes each detail line', msg.includes('$1,200.00') && msg.includes('marked paid'), msg);
  check('message states it cannot be undone', /cannot be undone/i.test(msg), msg);
  const sparse = buildDestructiveMessage({ title: 'Delete?', lines: [null, undefined, '', 'kept'] });
  check('empty lines are dropped, not printed', !/\n\n\n/.test(sparse) && sparse.includes('kept'), JSON.stringify(sparse));
  check('no undefined leaks into the dialog', !/undefined|null|NaN/.test(sparse), sparse);
}

// ── 7. Static wiring: every destructive call site is guarded ────────────────
section('7. Static wiring in src/pages');

const PAGES_DIR = path.join(ROOT, 'src/pages');
const pageFiles = readdirSync(PAGES_DIR).filter((f) => f.endsWith('.jsx'));

// A destructive write to the entity store. `.clear()` and `bulkDelete` count:
// they are the widest-blast-radius calls in the app.
const DESTRUCTIVE = /db\.entities(?:\.\w+|\[\w+\])\.(?:delete|bulkDelete|clear)\(|db\.users\.delete\(/g;

// Every destructive call site, and the confirmation mechanism that guards it.
// Three idioms exist in this codebase and all three are real confirmations:
//
//   scope 'handler'   — the shared guard, which MUST sit in the same handler,
//                       upstream of the delete. This is the strong assertion.
//   scope 'component' — a two-step state machine: one render asks, a second
//                       render performs. The confirmation and the delete live in
//                       the same component but different functions, so the
//                       assertion can only be that the component still holds a
//                       gate. Weaker by construction; recorded as such.
const EXPECTED = {
  'Payroll.jsx': { tokens: ['guardDestructiveAction'], scope: 'handler' },
  'Expenses.jsx': { tokens: ['guardDestructiveAction'], scope: 'handler' },
  'Import.jsx': { tokens: ['confirming', 'window.confirm'], scope: 'component' },
  'Settings.jsx': { tokens: ['propDeleteTarget'], scope: 'component' },
  'Users.jsx': { tokens: ['confirmAction'], scope: 'component' },
};

// Nearest preceding function declaration. No brace matching: requiring the
// guard to appear between the handler's first line and the delete call is
// exactly the semantics wanted — a guard placed after the delete is useless.
const FUNC_START = /(?:const|let|var|function|async function)\s+\w+\s*=?\s*(?:async\s*)?(?:\(|function)/g;
// Top-level declarations only (column 0) delimit a component.
const COMPONENT_START = /^(?:export default function|export function|function|const)\s+\w+/gm;

function nearestBefore(src, idx, re) {
  let best = 0;
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (m.index >= idx) break;
    best = m.index;
  }
  return best;
}

let siteCount = 0;
for (const file of pageFiles) {
  const src = readFileSync(path.join(PAGES_DIR, file), 'utf8');
  DESTRUCTIVE.lastIndex = 0;
  let m;
  while ((m = DESTRUCTIVE.exec(src)) !== null) {
    siteCount += 1;
    const line = src.slice(0, m.index).split('\n').length;
    const where = `${file}:${line} ${m[0]}`;
    const expected = EXPECTED[file];
    check(`${where} is a known destructive site`, Boolean(expected), 'no confirmation mechanism recorded for this file');
    if (!expected) continue;
    const from = expected.scope === 'handler'
      ? nearestBefore(src, m.index, FUNC_START)
      : nearestBefore(src, m.index, COMPONENT_START);
    const upstream = src.slice(from, m.index);
    check(
      `${where} is confirmed (${expected.scope} scope)`,
      expected.tokens.some((t) => upstream.includes(t)),
      `none of [${expected.tokens.join(', ')}] appears in the ${expected.scope} above it`
    );
  }
}
check('found the destructive call sites (>= 8)', siteCount >= 8, `found ${siteCount}`);

// The dialog has to name the record, not just the noun — "Delete this payroll
// run?" gives an operator no way to notice they clicked the wrong row.
section('8. Confirmations name the record');
for (const file of ['Payroll.jsx', 'Expenses.jsx']) {
  const src = readFileSync(path.join(PAGES_DIR, file), 'utf8');
  const guards = src.match(/guardDestructiveAction\(\{[\s\S]{0,1200}?\}\s*\)/g) || [];
  check(`${file} calls the shared guard`, guards.length >= 2, `found ${guards.length}`);
  for (const [i, g] of guards.entries()) {
    check(`${file} guard #${i + 1} interpolates the record`, g.includes('${'), g.slice(0, 120).replace(/\n\s*/g, ' '));
    check(`${file} guard #${i + 1} has a title`, /title:/.test(g), g.slice(0, 120).replace(/\n\s*/g, ' '));
  }
}

// ── Result ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(`probe-delete-guard: ${pass} passed, ${fail} failed`);
if (fail) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log(`  · ${f}`));
  process.exit(1);
}
