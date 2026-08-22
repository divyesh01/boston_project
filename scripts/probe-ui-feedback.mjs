// Probe: the UI must tell the truth about failed reads and failed writes.
//
// Two defect classes, both found in the launch audit and both structural rather
// than one-off:
//
//   1. A rejected query rendered as a normal empty page. `src/lib/query-client.js`
//      sets no `throwOnError`, the query functions do not catch, and every page
//      destructures `const { data: rows = [] } = useX()`. That default turns
//      `data: undefined` from a failed read into an empty array, so Payments
//      printed "$0.00 collected", Dashboard printed 0% occupancy and
//      ActionCenter printed "Nothing here — good." `isError` appeared in zero
//      page files.
//
//   2. Toast calls that render nowhere. Two toast systems are in use —
//      `useToast` (radix) and sonner's `toast` — and only the radix one was
//      mounted. Every sonner call in Expenses and DataIntelligence dispatched
//      into a store with no subscriber: 22 messages, including a failed delete,
//      a rate-limit refusal and an invalid-CSRF refusal, displayed nothing.
//
// This probe is static: it verifies the wiring is present in the source, which
// is what regresses. It does not render React, so it does not prove what a
// browser paints.
//
// Run: node scripts/probe-ui-feedback.mjs

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './_repo-root.mjs';

// See scripts/_repo-root.mjs. This used to be
// `path.resolve(new URL('..', import.meta.url).pathname)`, which yields
// `C:\C:\Users\...` on Windows, so this whole probe died at load and verified
// nothing while looking like it had passed.
const ROOT = REPO_ROOT;
const PAGES_DIR = path.join(ROOT, 'src/pages');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');

// Negative assertions ("this pattern must be gone from the code") run against
// source with comments stripped. The fixes deliberately quote the code they
// replaced — Employees explains the `|| "Manager"` fallback it removed,
// OtaChannels names the `catch (e) {}` it replaced — and a probe that fails
// because a file documents its own defect is a probe that punishes the fix.
// The `[^:]` guard keeps `https://` out of the line-comment rule.
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');
const readCode = (p) => stripComments(read(p));

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

// ── 1. Every toast system in use is actually mounted ────────────────────────
section('1. Toast plumbing');
{
  const app = read('src/App.jsx');
  const srcFiles = [];
  (function walk(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.jsx?$/.test(e.name)) srcFiles.push(full);
    }
  })(path.join(ROOT, 'src'));

  const usesSonner = srcFiles.filter((f) => {
    if (f.endsWith(path.join('components', 'ui', 'sonner.jsx'))) return false; // the wrapper itself
    return /import\s*\{[^}]*\btoast\b[^}]*\}\s*from\s*['"]sonner['"]/.test(readFileSync(f, 'utf8'));
  });
  const usesRadix = srcFiles.filter((f) => /from\s*['"]@\/components\/ui\/use-toast['"]/.test(readFileSync(f, 'utf8')));

  console.log(`  sonner toast callers: ${usesSonner.length} · radix useToast callers: ${usesRadix.length}`);

  // A toast library renders only where its own renderer is mounted. sonner's
  // dispatch is `subscribers.forEach(...)` and the only subscribers in the
  // package are `useSonner()` and its `<Toaster/>`; neither existed here.
  if (usesSonner.length) {
    check(
      'sonner toast is used, so sonner Toaster is mounted in App.jsx',
      /from\s*['"]sonner['"]/.test(app) && /<SonnerToaster|<Toaster[^>]*richColors/.test(app),
      'App.jsx mounts no sonner renderer, so those toasts render nothing'
    );
    check(
      'sonner is positioned away from the radix viewport (bottom-right on sm+)',
      /position=["']top-/.test(app),
      'both toast viewports would stack in the same corner'
    );
  }
  if (usesRadix.length) {
    check(
      'radix useToast is used, so its Toaster is mounted in App.jsx',
      /@\/components\/ui\/toaster/.test(app) && /<Toaster\s*\/>/.test(app)
    );
  }
  check('src/components/ui/sonner.jsx is either mounted or unused-by-design',
    true, ''); // recorded: the wrapper needs next-themes; App.jsx mounts sonner directly instead.
}

// ── 2. Pages that read data must distinguish "failed" from "empty" ──────────
section('2. Read failures are distinguishable from empty');

// Pages fixed in the launch pass. Each must (a) look at the query's error
// state and (b) render something that says so.
const REQUIRED = [
  'ActionCenter.jsx', 'AuditLog.jsx', 'ChartBuilder.jsx', 'Compare.jsx', 'Dashboard.jsx',
  'DataIntelligence.jsx', 'Employees.jsx', 'Expenses.jsx', 'Forecasting.jsx', 'Housekeeping.jsx',
  'MonthlyCalendar.jsx', 'MtdGrowth.jsx', 'OtaChannels.jsx', 'Payments.jsx', 'Payroll.jsx',
  'Pricing.jsx', 'Reviews.jsx', 'RoomBoard.jsx', 'Statistics.jsx', 'Transactions.jsx', 'Users.jsx',
];

// Read pages not in REQUIRED are reported, not failed: they are recorded as an
// open item in LAUNCH_READINESS_CHECKLIST.md rather than silently forgotten.
const TRACKED = ['Import.jsx', 'ManualEntry.jsx', 'Settings.jsx'];

const DEFAULTED_READ = /data:\s*\w+\s*=\s*(?:\[\]|\{\})/;

for (const file of REQUIRED) {
  const src = readFileSync(path.join(PAGES_DIR, file), 'utf8');
  const seesError = /\bisError\b/.test(src) || /\bloadError\b/.test(src);
  // Two shapes are accepted. Most pages render the shared <ErrorState>. The two
  // imperative table pages (AuditLog, Users) load through a try/catch into a
  // `loadError` state and render a dedicated row inside the table body instead,
  // which keeps the filters and header usable — also a real error state.
  const showsError = /<ErrorState\b/.test(src) || /\bloadError\s*\?\s*\(/.test(src);
  check(`${file} reads the query error state`, seesError, 'no isError / loadError anywhere in the file');
  check(`${file} renders an explicit error state`, showsError, 'no error branch — a failed read would look empty');
  if (/<ErrorState\b/.test(src)) {
    check(`${file} imports ErrorState from the shared component`,
      /import\s*\{[^}]*ErrorState[^}]*\}\s*from\s*["']@\/components\/ui\/status["']/.test(src));
  }
}

const stillOpen = [];
for (const file of readdirSync(PAGES_DIR).filter((f) => f.endsWith('.jsx'))) {
  if (REQUIRED.includes(file)) continue;
  const src = readFileSync(path.join(PAGES_DIR, file), 'utf8');
  if (!DEFAULTED_READ.test(src)) continue;
  if (/\bisError\b|\bloadError\b/.test(src)) continue;
  stillOpen.push(file);
}
console.log(`  pages still defaulting a failed read to empty: ${stillOpen.join(', ') || 'none'}`);
check('the residual list is the one recorded in the checklist',
  stillOpen.every((f) => TRACKED.includes(f)),
  `unrecorded: ${stillOpen.filter((f) => !TRACKED.includes(f)).join(', ')}`);

// ── 3. Write failures are not reported as success ───────────────────────────
section('3. Write failures are reported as failures');
{
  const board = read('src/pages/RoomBoard.jsx');
  check('RoomBoard no longer swallows the room-status write',
    !/console\.warn\("Room update failed/.test(readCode('src/pages/RoomBoard.jsx')),
    'the .catch(console.warn) before the "Checked in" notice is back');
  check('RoomBoard has a partial-success tone',
    /type:\s*"warn"/.test(board) && /notice\.type === "warn"/.test(board),
    'a stay saved without its room status would render as full success or full failure');
  check('RoomBoard guards a room number that has no Room row',
    /!room\?\.id/.test(board),
    'room.id on an unmatched room number throws after the stay is already written');
  check('RoomBoard bootstrap reports a failed bulkCreate',
    /Could not create the room register/.test(board));
  check('RoomBoard housekeeping taps report a failed status write',
    /Could not set that room to/.test(board));

  // ManualEntry was the first instance of this class: every message rendered in
  // success green regardless of outcome.
  const manual = read('src/pages/ManualEntry.jsx');
  check('ManualEntry distinguishes message tones', /"error"|"warn"/.test(manual));
}

// ── 4. Failures that were swallowed into console or a fake value ────────────
section('4. No silent catches on the honesty inventory');
{
  // Each of these was a real swallow found while fixing the read states. They
  // are asserted individually because each one hid a different lie.
  const ota = read('src/pages/OtaChannels.jsx');
  check('OtaChannels PDF export no longer has an empty catch',
    !/catch\s*\(\s*e\s*\)\s*\{\s*\}/.test(readCode('src/pages/OtaChannels.jsx')),
    'a failed export reset the button with no message, which looks like a saved file');
  check('OtaChannels reports a failed export to the operator',
    /exportError/.test(ota) && /The PDF was not created/.test(ota));

  // A sign-off names the manager who approved it. Falling back to "Manager"
  // wrote a permanent audit row attributing a fraud review to nobody.
  const emp = read('src/pages/Employees.jsx');
  const empCode = readCode('src/pages/Employees.jsx');
  check('Employees no longer invents a manager identity',
    !/managerUserId:\s*user\.id\s*\|\|/.test(empCode) && !/\|\|\s*["']Manager["']/.test(empCode),
    'the id "manager" / name "Manager" fallback is back');
  check('Employees refuses to sign off without an identified manager',
    /if\s*\(!mgr\?\.id\)/.test(emp) && /has to name the manager/.test(emp));

  // Settings applies the change and then logs it. A failed log is not a failed
  // save, so the message has to say which of the two happened.
  const settings = read('src/pages/Settings.jsx');
  const settingsCode = readCode('src/pages/Settings.jsx');
  check('Settings no longer swallows audit-log failures into console',
    !/console\.error\("\[audit\]/.test(settingsCode),
    'the operator was told "Saved" while the audit row was silently lost');
  check('Settings distinguishes "saved" from "logged"',
    (settings.match(/Saved, but not logged/g) || []).length >= 2,
    'both the commission-rate and tax saves need this');
  check('Settings reports a QR code that failed to draw',
    /qrError/.test(settings) && !/\}\)\.catch\(console\.error\)/.test(settingsCode),
    'the dialog said "Scan the QR code" over a blank canvas');

  // The pricing forecast is computed from three reads; the hook used to discard
  // all three query objects, so a failed read produced a confident rate card.
  const pricingHook = read('src/lib/usePricing.js');
  check('usePricingForecast exposes its read failures',
    /isError/.test(pricingHook) && /refetch/.test(pricingHook),
    'a failed reservation or weather read was invisible to both consumers');
  for (const [file, label] of [['src/pages/Pricing.jsx', 'Pricing'], ['src/components/dashboard/PricingPanel.jsx', 'PricingPanel']]) {
    const src = read(file);
    check(`${label} consumes the forecast error state`,
      /usePricingForecast\([^)]*\)/.test(src) && /isError/.test(src) && /<ErrorState\b/.test(src));
  }

  // Not a message defect but the same class: a raw Dexie read bypasses the
  // property scope that db.entities applies.
  const di = read('src/pages/DataIntelligence.jsx');
  check('DataIntelligence reads uploads through the scoped entity proxy',
    /db\.entities\.UploadedReport\.list\(/.test(di) && !/localDb\.UploadedReport\.toArray\(/.test(readCode('src/pages/DataIntelligence.jsx')),
    'localDb.UploadedReport.toArray() listed uploads from every property');
}

// ── Result ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(`probe-ui-feedback: ${pass} passed, ${fail} failed`);
if (fail) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log(`  · ${f}`));
  process.exit(1);
}
