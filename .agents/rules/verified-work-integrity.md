# Rule: Verified Work — Do Not Silently Rewrite

**Priority: HIGH.** This rule does not grant or replace anything in
[`PROTECTED_FILES.md`](../../PROTECTED_FILES.md) — that list is owner-only and
only the repository owner (Divyesh) can amend it. This rule covers a different
set: files whose current contents were arrived at by *measurement*, where the
measurement is cheap to re-run and expensive to rediscover.

Each entry below names a command that proves the file. **If you change one of
these files, re-run its command in the same turn and paste the output.** If you
cannot run it, say "Not run" and do not claim the change is safe.

## Files and their proofs

| File | Proof command | Expected |
| --- | --- | --- |
| `src/lib/uploadGuard.js` | `node scripts/probe-upload-guard.mjs` | `PASS 32 FAIL 0` |
| `scripts/probe-upload-guard.mjs` | as above | assertion count must not go DOWN |
| `src/lib/donutLabelLayout.js` | `node scripts/verify-donut-labels.mjs` | `PASS 738 FAIL 0` |
| `src/components/charts/PieDonut.jsx` | as above | as above |
| `src/components/charts/PieDonut.test.jsx` | as above (section 12 cross-checks its literals) | as above |
| `scripts/verify-all.mjs` | `node scripts/verify-all.mjs --list` | prints a list fingerprint + count |
| `vitest.config.js`, `tests/stubs/base44-runtime.js` | `npx vitest run tests/backend` | must not regress to a resolution error |
| `.github/workflows/security.yml` | `npm run typecheck` **and** `npm run audit:gate` | both exit 0 |
| `scripts/audit-gate.mjs` | `npm run audit:gate` | exit 0, prints `Audit gate passed` |
| `base44/functions/**/entry.{js,ts}` | `node --import ./scripts/_loader-boot.mjs scripts/probe-audit-chain.mjs` | `PASSED: 36 passed, 0 failed` |
| `src/components/dashboard/MoneyKept.jsx` | `node --import ./scripts/_loader-boot.mjs scripts/verify-money-kept.mjs` | `PASSED: 29 checks passed, 0 failed` |
| `src/lib/housekeepingConfig.js`, `src/lib/laborOptimization.js`, `src/pages/Housekeeping.jsx` | `node --import ./scripts/_loader-boot.mjs scripts/probe-settings-persistence.mjs` | `PASSED: 117 passed, 0 failed` |
| the storage key `rri_housekeeping_config_<propertyId>` | `node --import ./scripts/_loader-boot.mjs scripts/probe-db-archive.mjs` | `PASSED: 216 passed, 0 failed` |
| `src/lib/manualDraft.js`, `src/pages/ManualEntry.jsx` | `node --import ./scripts/_loader-boot.mjs scripts/probe-manual-entry-save.mjs` | `PASSED: 96 passed, 0 failed` |
| `src/pages/Settings.jsx`'s `handleDeleteAccount` | `node scripts/probe-delete-guard.mjs` | `PASSED: 96 passed, 0 failed` |
| `scripts/probe-db-archive.mjs`'s `MANIFEST` | as the row above it | also `storage writers classified: 21` |

## Invariants that must not be weakened

These were each established against a specific failure. Removing one re-opens
the defect it was written for.

1. **`PieDonut.test.jsx` keeps `expect(lines.join("")).not.toContain("…")`.**
   Long slice names wrapping to two lines with every character intact is the
   product requirement (`PieDonut.jsx:18`). If this assertion fails, fix the
   engine or the fixture geometry — never delete the assertion.
2. **The `WIDE` / `NARROW` literals in `PieDonut.test.jsx` stay in sync with the
   sizer.** They are cross-checked by section 12 of `verify-donut-labels.mjs`
   (WIDE = 560x320 → cx 280, cy 160, r 74; NARROW = 360x300 → cx 180, cy 150,
   r 39). The previous fixture claimed a 360px box with a 70px ring — a
   combination the sizer never produces — which left that test red from the day
   it was written and made a correct engine look broken. Do not hand-edit these
   numbers without re-running the harness.
3. **The upload gate stays in ONE module.** `src/lib/uploadGuard.js` is imported
   by `src/pages/Import.jsx` and `src/pages/DataIntelligence.jsx`. Do not
   re-inline the checks into either page. The reason this file exists is that the
   checks *were* inline in `Import.jsx` and the second door
   (`DataIntelligence.jsx`) only ever tested the filename extension — no size
   cap, no magic bytes — so a renamed executable or a 500MB file was refused at
   one door and accepted at the other.
4. **`EXECUTABLE_EXT` in `uploadGuard.js` stays even though it is unreachable.**
   Both patterns are anchored, so anything it matches already fails
   `ALLOWED_EXT`. It is defence in depth for the day someone unanchors the
   allowlist. Verified unreachable-but-harmless by the probe.
5. **`verify-all.mjs` must keep failing when its buckets do not sum.** The exit
   code is `notPassing.length || bucketed !== results.length`. A runner that
   reports `0 failed` while silently dropping suites is the worst outcome this
   script has; that check is what makes the number trustworthy.
6. **`verify-all.mjs` must keep printing real stderr for BROKEN suites**, not
   just which signature matched. A BROKEN suite verified nothing, and on
   2026-08-20 a bare signature line ("ENOENT: no such file or directory", no
   path, no importer) sent a whole session guessing.
7. **Probes must not be added without assertions.** Two `probe-donut-truncation*.mjs`
   scratch files matched the runner's discovery glob, contained only
   `console.log`, and would have reported a vacuous PASS — inflating the suite
   count from 78 to 80 and making the tally disagree with the fingerprint. They
   were deleted. Any `scripts/probe-*.mjs` or `scripts/verify-*.mjs` must exit
   non-zero on failure and print `PASS n FAIL n`.
8. **`uploadGuard.js` treats a non-finite `file.size` as "cap not applicable",
   not as a rejection**, and the probe asserts it. This is the pre-refactor
   behaviour of `Import.jsx` (`f.size > MAX_SIZE` is false for `NaN`) and the
   content checks still run, so nothing is admitted unchecked. Turning it into a
   fail-closed rejection would refuse valid uploads on any platform that hands us
   a `File` without a size — measure that before changing it.
9. **`DataIntelligence.jsx` keeps an empty-selection message distinct from the
   per-file rejection toasts.** An empty drop (a folder, a URL, a text selection)
   and "every file was refused" are different events; the pre-refactor code
   printed one message for both, and an earlier draft of this refactor printed
   nothing for the empty case — the same conflation in reverse. CLAUDE.md §4
   (`USER / UI: Truthful Experience`) is the reason.
10. **The CI typecheck step stays `npm run typecheck` — never a bare
    `npx tsc --noEmit`.** There is no root `tsconfig.json` in this repo, only
    `jsconfig.json`, so bare `tsc` finds no input files, prints its CLI help and
    exits 1. That is what the `verify` job did until 2026-08-21: it failed in 0s
    on every run while type-checking nothing, and it blocked the four steps after
    it. Keeping CI on the npm script keeps it identical to the local gate
    (`tsc -p ./jsconfig.json`) so the two cannot drift apart again.
11. **The audit step stays `npm run audit:gate`.** Do not "fix" a red audit with
    `--audit-level=critical` or `continue-on-error: true` — the first tolerates
    every future high advisory in every package, the second makes the step green
    whatever it finds, and both turn a security gate into decoration. The gate
    accepts advisories one at a time, by GHSA id, with a written argument for why
    that advisory is unreachable *in this codebase*; it fails on anything
    unaccepted, on an entry that has become stale, on an accepted advisory that
    gains a fix, and on its own inability to parse `npm audit --json`. That last
    one is deliberate: a gate that goes green because the registry was
    unreachable has verified nothing.
12. **`MoneyKept.jsx` computes `kept` and `netRevenueBase` in integer cents.**
    This looks like pointless ceremony — every deduction is already snapped to 2dp
    by `pushItem`, and the float residue was ~1e-10, invisible after formatting.
    That is exactly why it survived, and why a future "simplification" back to
    `gross - totalDeductions` will look harmless. It is the flagship figure on the
    card and the denominator of the displayed keep rate, and CLAUDE.md §4 forbids
    float arithmetic on dollars without exception. Section 6 of
    `verify-money-kept.mjs` asserts both expressions statically, so a revert turns
    the suite red instead of shipping quietly. The per-day `share` / `lumpTotal`
    revenue-share allocation is deliberately left fractional — it is an
    apportionment feeding a trend chart, not a stated amount.
13. **`generateHousekeepingSchedule` keeps its third `standards` parameter, and
    `Housekeeping.jsx` keeps passing `hkConfig` to it.** Dropping the argument
    "because the defaults are the same numbers" is precisely the bug that was
    fixed on 2026-08-25 (tracker #55): the function hardcoded `* 30` and `* 15`,
    which are *exactly* the defaults of `minutesPerCheckout` and
    `minutesPerStayover`, so both settings were read, clamped, persisted and then
    ignored — and the page was correct for anyone who never changed them. The
    constants remain the parameter defaults on purpose, which makes a revert look
    harmless in every fixture that uses defaults. Section 8b of
    `probe-settings-persistence.mjs` is the guard: it asserts that the untuned
    result is still 450 **and** that a tuned 45/20 pair is not 450. A round-trip
    or persistence assertion cannot see this class of defect; only an assertion on
    the *derived figure* can.
14. **`saveHk` reads the config back with `getHousekeepingConfig` instead of
    trusting what it submitted, and both derived figures read `hkConfig`, never
    `hkEdited`.** `saveHousekeepingConfig` clamps every field, so
    `setHkConfig(hkEdited)` would render minutes and a labor cost computed from a
    value the store rejected — and mixing a typed wage with saved turnover times
    would state a cost true of no configuration at all. The collapse to one
    `setState` will look like a simplification; it is the defect.
15. **`housekeepingConfig.js` coerces with `coerceNumber`, not
    `Number(x) || fallback`.** `0` is falsy and the editors report
    `Number(e.target.value)`, where `Number("")` is `0`, so the falsy form
    silently restored the previous value and made the clamp floors (10, 5, 7.25,
    5) unreachable from the UI. Any settings module that accepts a numeric field
    where 0 is a legal input has this trap.
16. **`ManualEntry.jsx` holds zero web-storage calls and zero copies of the draft
    key template.** Both are asserted statically by section 9 of
    `probe-manual-entry-save.mjs`. `src/lib/manualDraft.js` exists because the
    page's five raw `localStorage` calls could not report a failure to the person
    typing, and one of them — a `getItem` **outside** its own `try`, inside a
    `useEffect` — blanked the entire page behind `LazyErrorBoundary` on any
    browser that refuses storage. Note the second half: a grep for `localStorage`
    returning nothing does **not** prove the page is decoupled. The literal
    `manual_draft_${propId}_${reportType}` survived my own rewrite and only the
    key-template assertion caught it, which is the state from which the next edit
    reintroduces a raw call. `manual_draft_` is also a `LOCAL_SLOT_PREFIXES` entry
    in `dbArchive.js`, so a rename silently drops drafts out of every backup.
17. **The clear after a successful save neither overwrites the success message nor
    throws.** `clearDraft(draftKey)` in `handleSave` sits **before**
    `setSaving(false)` and `rotateCsrfToken()`, and the records are already
    committed when it runs. So a refused remove must (a) return rather than throw
    — an unguarded `removeItem` there left a completed save with the Save button
    spinning on a stale CSRF token — and (b) *append* to "N records saved" under
    the `warn` tone rather than replace it, because that sentence is true. The
    **discard** button inverts the second half deliberately: when its remove
    fails the draft is still stored, so the recovery banner stays open. Closing it
    would tell the operator the draft was discarded when it was not.
18. **`handleDeleteAccount` does no local cleanup of its own, and calls the
    AuthContext `logout`, not `db.auth.logout`.** Both halves look like they
    could be tidied and both are the fix.

    The cleanup: `invokeBackend` in the protected `src/api/base44Client.js`
    already runs `localDb.tables.map((t) => t.clear())` **and**
    `localStorage.clear()` on a successful `deleteAccount`, and **both** dispatch
    routes reach it (`:2116` when the local-auth flag is off, the `:2235`
    fall-through when it is on — there is no `deleteAccount` shim). The two
    `localStorage.removeItem` calls that used to sit here were therefore dead;
    they also named 2 of the 3 keys `commissionRates.js` owns, and being
    unguarded they threw into the handler's only `catch`, which reports *"Your
    account could not be deleted. You are still signed in, and no logout was
    performed."* — false in all three clauses once the server delete has
    succeeded. **Do not "harden" this by wrapping the removes in a `try`.**
    Deleting them is what makes that catch reachable only from the invoke, which
    is the case its wording describes. Section 10 of `probe-delete-guard.mjs`
    pins the tail statement-by-statement (`['await logout(true);']`), because a
    "does not contain localStorage" check passes the moment a *different*
    throwing statement is added there.

    The logout: `db.auth.logout(redirect)` assigns its argument to
    `window.location.href`, so the previous `db.auth.logout(true)` navigated to
    `<origin>/true` — served as `index.html` by `wrangler.jsonc:24`'s SPA
    `not_found_handling`, on an account that no longer exists. The AuthContext
    `logout(shouldRedirect = true)` takes a boolean, builds
    `/login?returnTo=…` itself, and clears the React auth state; the file's
    three other logout sites (`:392`, `:637`, `:1217`) already call it. Two
    same-named functions are in scope with one parameter each and opposite
    meanings, and `true` is legal-looking to both — that is the whole defect, so
    the probe pins **both** signatures on the protected files (read-only, as
    `PROTECTED_FILES.md` rule 1 permits). If `db.auth.logout` ever becomes a
    boolean flag, section 10 goes red and this invariant is what explains why.

## Deliberate non-changes

Do not "fix" these. Each was investigated and left alone on purpose.

- **`base44/functions/**` import specifiers** (`npm:@base44/sdk@^0.8.41`,
  `base44:runtime`). Deno needs them exactly as written; `vitest.config.js`
  aliases them instead of resolving them. Do not rewrite them to bare
  `@base44/sdk` to make a bundler happy.

  **Corrected 2026-08-22.** An earlier version of this bullet said the signed
  audit payload depends on *the import lines* being byte-identical across copies.
  It does not. What `custom_auth_login/entry.js:204` and
  `custom_user_admin/entry.js:311` actually record is that the **canonical field
  list** (`AUDIT_CANONICAL_V1 = user_id,action,performed_by_id,performed_by,`
  `property_id,result,detail,created_date,previous_hash`) must be identical in all
  seven copies, because the host offers no way to share a module. Line 1 is not
  part of the hash. That misreading is why the version split below survived as a
  "deliberate non-change" for as long as it did — so re-read the source comment
  before treating any line as frozen.

  The split itself is **fixed**, not deferred: seven `entry.ts` files pinned exact
  `0.8.40` while eleven `entry.js` files — the entire auth, session and audit path —
  pinned `^0.8.41`, which is also `package.json:25` and the installed version.
  All eighteen now read `^0.8.41`. Safe because those seven import exactly one SDK
  export, `createClientFromRequest`, which is present and documented at 0.8.41, and
  because `probe-audit-chain.mjs` (36/0 after the change) proves the payload copies
  did not move. Two of the seven — `autoPayroll` and `deleteAccount` — write audit
  rows, so running them against a different SDK build than the verifier was the
  actual risk. Runtime behaviour on the base44 Deno host is **Not Run** from the
  Linux VM.
- **`chooseOuterRadiusPct` returns `minPct` when the box measures 0**
  (`donutLabelLayout.js:173`). **This bullet said the opposite until 2026-08-22 —
  do not "restore" `maxPct`.** A zero box means the ResizeObserver has not
  reported, so nothing is known about the space; the largest ring leaves the least
  label room, which inverts the function's purpose. `minPct` makes the first frame
  safe by construction and the ring settles outward once the observer fires —
  growth reads as settling, shrink reads as breakage. Verified by
  `verify-donut-labels.mjs`; the *visual* outcome is still unverifiable here (no
  browser, no `npm run build`). Recorded
  in `LAUNCH_READINESS_CHECKLIST.md`.
- **`base44/functions/validateUpload/`** is an empty directory; `entry.js` never
  existed in git history. Its orphan test was deleted, not "repaired" — there is
  nothing to point the import at, and the boundary it described is now enforced
  client-side by `uploadGuard.js`, which is where the CSV is actually read.
- **`DataIntelligence.jsx`'s `fileExt === 'txt'` branch** is unreachable (its own
  extension filter excludes `.txt`) and its two unused-variable lint warnings
  (`setActiveTab`, `format`) are pre-existing. Noted, not touched.
- **`formatCents(cents, 0)` truncates rather than rounds** (`decimal.js:85` is
  `Math.floor(abs / SCALE)`), so `$123.75` displays as `$123`. This is the
  app-wide display convention — `money()` in `hotel.js` is defined in terms of it
  — and `probe-settings-persistence.mjs` section 8f now pins both that and
  `formatCents(12400, 0) === "$124"`. Do not "fix" it to round: every whole-dollar
  figure in the app would move at once, and the two pinned assertions would go red
  without telling the next reader why.
- **`src/components/HousekeepingSettingsModal.jsx`** has zero importers and is
  duplicated by the live inline editor in `Housekeeping.jsx`; it is stale enough
  to edit only 3 of the 4 fields. It was updated on 2026-08-25 **solely** so it
  would not call a contract that had changed under it (the saver now returns a
  boolean), and it carries a header note saying so. Do not revive it as "the"
  editor, and do not delete it as part of an unrelated change.

## Proposed addition to `PROTECTED_FILES.md` (owner action)

Only the owner may edit that file. If you want these locked at the same level as
the auth files, append:

```markdown
15. `src/lib/uploadGuard.js`
16. `scripts/probe-upload-guard.mjs`
17. `scripts/verify-donut-labels.mjs`
```
