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

## Deliberate non-changes

Do not "fix" these. Each was investigated and left alone on purpose.

- **`base44/functions/**` import specifiers** (`npm:@base44/sdk@0.8.40`,
  `npm:@base44/sdk@^0.8.41`, `base44:runtime`). Deno needs them exactly as
  written, and `custom_auth_login/entry.js:204` /
  `custom_user_admin/entry.js:311` both record that the signed audit payload
  depends on those import lines being byte-identical across copies. `vitest.config.js`
  aliases them instead. The three disagreeing SDK pins are a real defect, tracked
  in `LAUNCH_READINESS_CHECKLIST.md`, not fixed as a side effect of a test change.
- **`chooseOuterRadiusPct` returning `maxPct` when the box measures 0**
  (`donutLabelLayout.js:162`). This is the largest ring, i.e. the least room for
  labels, in exactly the state where nothing is known — the opposite of the
  function's stated purpose. It self-corrects when the ResizeObserver fires, so
  the visible cost is one frame, and the alternative (`minPct`) trades that for a
  ring that visibly grows on every mount. Left as-is because the UI outcome
  cannot be verified in the Linux VM (no browser, no `npm run build`). Recorded
  in `LAUNCH_READINESS_CHECKLIST.md`.
- **`base44/functions/validateUpload/`** is an empty directory; `entry.js` never
  existed in git history. Its orphan test was deleted, not "repaired" — there is
  nothing to point the import at, and the boundary it described is now enforced
  client-side by `uploadGuard.js`, which is where the CSV is actually read.
- **`DataIntelligence.jsx`'s `fileExt === 'txt'` branch** is unreachable (its own
  extension filter excludes `.txt`) and its two unused-variable lint warnings
  (`setActiveTab`, `format`) are pre-existing. Noted, not touched.

## Proposed addition to `PROTECTED_FILES.md` (owner action)

Only the owner may edit that file. If you want these locked at the same level as
the auth files, append:

```markdown
15. `src/lib/uploadGuard.js`
16. `scripts/probe-upload-guard.mjs`
17. `scripts/verify-donut-labels.mjs`
```
