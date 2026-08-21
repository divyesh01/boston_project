# 14. KNOWN PROBLEMS (Status Tracker)

| # | Problem | Severity | Status | Fix Location | Commit |
|---|---------|----------|--------|-------------|--------|
| 1 | Duplicate CSV column names cause data loss | HIGH | FIXED | `src/lib/csvParser.js` line 183 | c50435c |
| 2 | Password sent in plaintext in welcome email | CRITICAL | FIXED | `base44/functions/custom_auth_register/entry.js` lines 209-217 | f07245e |
| 3 | Money Kept shows $0 (typo: total_revenue should be room_revenue) | HIGH | FIXED | `src/lib/dailyAggregates.js` line 183 | See docs |
| 4 | CSRF cookie not secure (missing __Host- prefix + Secure flag) | CRITICAL | FIXED | `src/lib/securityUtils.js` line 267-268 | efc79d9 |
| 5 | Revenue paths don't match (no reconciliation system) | HIGH | FIXED | `src/lib/RevenueReconciliation.js` (NEW file) | See docs |
| 6 | Float math precision errors ($0.1+$0.2 != $0.3) | HIGH | FIXED 2026-08-20 | `decimal.js` now integrated in `calculationService.js`, `dailyAggregates.js`, `actionCenter.js`, `financialReconciliation.js` — see section 21 | (Uncommitted) |
| 7 | Wrong error message for disabled accounts ("revoked" vs "disabled") | MEDIUM | FIXED | `custom_auth_me` returns 200 with inactive user | (Current) |
| 8 | Session never times out (infinite session = security risk) | CRITICAL | FIXED | `AuthContext.jsx` idle timeout of 15m | (Current) |
| 9 | Server-only code sits in frontend folder (config leak) | MEDIUM | FIXED | `corsConfig.js` moved to `base44/lib` | (Current) |
| 10 | RLS operators flipped in 9 entities: reads impossible, writes wide open (cross-property leak) | CRITICAL | FIXED 2026-08-19 | `base44/entities/*.jsonc` -- see BRAIN_BACKEND.md section 7 | (Uncommitted) |
| 11 | `__B44_DB__` fake-db shim in 7 serverless functions: all reads empty, all writes discarded | CRITICAL | FIXED 2026-08-19 | 7x `base44/functions/*/entry.ts` + `AGENTS.md` line 1 | (Uncommitted) |
| 12 | `public/manifest.json` began with a line of JS, so browsers discarded the whole manifest | HIGH | FIXED 2026-08-16 | `public/manifest.json`, guarded by `probe-deploy-config.mjs` | (See checklist) |
| 13 | One-shot root scripts re-run and destroyed 47KB of BRAIN docs | HIGH | FIXED 2026-08-19 (docs restored + both scripts now abort on re-run) | See section 20 below | (Uncommitted) |
| 14 | AuditLog page Category filter uses a vocabulary NO writer produces | MEDIUM | FIXED 2026-08-20 | `src/lib/auditFilter.js` — `AUDIT_CATEGORIES` rebuilt from the actions the 6 writers actually emit | (Uncommitted) |
| 15 | Concurrent audit writers can read the same last row and share a `previous_hash` | LOW | FIXED 2026-08-20 | `base44/functions/audit_log/entry.js` + `audit_verify/entry.js` — see BRAIN_SECURITY.md | (Uncommitted) |
| 16 | `calculateMoneyKept` reported a different gross than the widget that renders it | HIGH | FIXED 2026-08-20 | `src/lib/calculationService.js` now calls `hotel.js#grossRevenueForPeriod` | (Uncommitted) |
| 17 | Occupancy capacity fell back to per-row inventory, so a double import hid inside capacity instead of showing as >100% | HIGH | FIXED 2026-08-20 | `src/lib/actionCenter.js` + `calculationService.js#capacityCents` (per-day, not per-row) | (Uncommitted) |
| 18 | Row count used as day count, so period averages divided by rows | HIGH | FIXED 2026-08-20 | `src/lib/calculationService.js`, `src/lib/actionCenter.js` | (Uncommitted) |
| 19 | Card-processing fee charged on non-card tender (cash, check, direct bill) | MEDIUM | FIXED 2026-08-20 | `CARD_METHODS` basis in `src/lib/calculationService.js` | (Uncommitted) |
| 20 | `calculateProfitMetrics` concatenated strings instead of adding numbers | HIGH | FIXED 2026-08-20 | `src/lib/calculationService.js` (coerced `sum()`) | (Uncommitted) |
| 21 | Daily-aggregate cache stored floats, so the cached path and the live path disagreed by cents | HIGH | FIXED 2026-08-20 | `src/lib/dailyAggregates.js` | (Uncommitted) |
| 22 | A CSV column literally named `__proto__` silently dropped every row of the import | HIGH | FIXED 2026-08-20 | `src/lib/csvParser.js` (null-prototype row objects) | (Uncommitted) |
| 23 | `scanAdjustmentsRefunds` matched any header *containing* "total", swallowing real data columns | HIGH | FIXED 2026-08-20 | `src/lib/reportParsers.js` | (Uncommitted) |
| 24 | `audit_list` serverless function: unbounded read, no property scope, no result filter, no ordering guarantee | HIGH | FIXED 2026-08-20 | `base44/functions/audit_list/entry.js` — see BRAIN_SECURITY.md | (Uncommitted) |
| 25 | CSV export took its columns from `Object.keys(rows[0])`, so any field missing from row 0 vanished from the whole file | HIGH | FIXED 2026-08-20 | `src/lib/exportData.js` (NEW) — explicit column specs | (Uncommitted) |
| 26 | CSV export had no UTF-8 BOM and LF line endings, so Excel mangled accented names | MEDIUM | FIXED 2026-08-20 | `src/lib/exportData.js` (NEW) | (Uncommitted) |
| 27 | Formula-injection guard prefixed every negative amount with `'`, exporting refunds as text no spreadsheet could sum | HIGH | FIXED 2026-08-20 | `src/lib/exportData.js` `NUMERIC_TEXT` exemption — introduced and caught inside the same session | (Uncommitted) |
| 28 | `filterAuditLogs` ignored the active property filter, so one property's page listed another's events | HIGH | FIXED 2026-08-20 | `src/lib/auditView.js` (NEW) `filterByProperty` | (Uncommitted) |
| 29 | `MoneyKept.jsx` referenced `grossBasis` before defining it — the widget threw on render | CRITICAL | FIXED 2026-08-20 | `src/components/dashboard/MoneyKept.jsx` | (Uncommitted) |
| 30 | 11 verification suites exited 0 while printing a defect, or could not fail at all | HIGH | FIXED 2026-08-20 | see section 22 — all 11 closed | (Uncommitted) |
| 31 | `hotel.js` shipped a second, weaker CSV/Excel download implementation next to the new one | MEDIUM | FIXED 2026-08-20 | `src/lib/hotel.js` — `downloadCsv`/`downloadExcel` deleted as orphans once all 5 pages migrated | (Uncommitted) |
| 32 | No `COLUMN_MAP` key mapped to `occupancy`, so a printed occupancy percentage was discarded and every clean Occupancy Summary raised a false `unknown_columns` warning naming all four occupancy columns | HIGH | FIXED 2026-08-20 | `src/lib/reportParsers.js` `COLUMN_MAP` — one of the four mapped on purpose; BRAIN_FINANCE.md 12.7 | (Uncommitted) |
| 33 | An Occupancy Summary with neither an occupancy column nor `Total Rooms` imported every day as an empty hotel **with zero validation findings** — the branch's own `= 0` default made the field look present to `REQUIRED_FIELDS` | HIGH | FIXED 2026-08-20 | `src/lib/reportParsers.js` — new `occupancy_underivable` finding via `extraFindings`; ERROR when it affects every row, WARNING otherwise | (Uncommitted) |
| 34 | `parseAmount` returned `Infinity` for `"Infinity"` and `"1e999"`, and `Infinity - Infinity` is `NaN`, so one poisoned cell could void a whole period's total untraceably | MEDIUM | FIXED 2026-08-20 | `src/lib/csvParser.js` — `Number.isFinite` guard routes it through the normal `unparseable` coercion path | (Uncommitted) |
| 35 | The Payments Summary prints its tender columns in caps, so `OTHER` never matched the `Other` key — a declared `PaymentDay` field silently dropped. Latent only: measured $0.00 across all 217 real rows | LOW | FIXED 2026-08-20 | `src/lib/reportParsers.js` `COLUMN_MAP` — `OTHER: "other"` | (Uncommitted) |
| 36 | `probe-money-kept-fix.mjs` never exited: the imported module graph holds open Base44 SDK handles that keep the event loop alive, so the suite could only ever report TIMEOUT — never PASS, never FAIL. Its three checks were `console.assert`, so it could not have failed anyway | HIGH | FIXED 2026-08-20 | `scripts/probe-money-kept-fix.mjs` — synchronous `process.exit`, real assertions, and the values checked rather than just the field names. 170s hang → 8s, 17/0 | (Uncommitted) |
| 37 | A sharded `verify:all` re-reads `scripts/` per invocation, so a suite file written mid-run shifts every slice boundary — a suite can be run twice or not at all while all shards print "All green". Measured: the 2026-08-20 baseline reported 68+2=70 against 71 files on disk, missing `probe-audit-write-failure.mjs` (since run alone: 60/0) | MEDIUM | FIXED 2026-08-20 | `scripts/verify-all.mjs` — `LIST_ID` sha256 fingerprint of the full discovered list printed on every run and in `--json`, plus a shard-summary line telling the reader to match ids before summing. See 22.5 | (Uncommitted) |
| 38 | The Staff delete dialog asserted in prose that "payroll runs already recorded for this person are kept". True, but it could not say whether that meant one run or forty, and nothing kept the sentence honest if the schema changed | MEDIUM | FIXED 2026-08-20 | `src/lib/deleteGuard.js` — new `dependents` option folds the count and its integer-cent money value into the dialog; `src/pages/Payroll.jsx#handleDeleteStaff` supplies them. Guarded by `scripts/probe-delete-guard.mjs` (78/0), both branches mutation-tested | (Uncommitted) |

---


# 🚨 19. EMERGENCY PLAYBOOK (For Humans)
> [!TIP]
> **Hotel Owners & Managers:** If something goes wrong in real life, follow this guide before calling a developer.

### Scenario A: "The Dashboard Revenue Doesn't Match My Bank Account"
1. **Check the CSVs:** Did the front desk upload yesterday's HotelKey report? Go to `Import` and check the history.
2. **Check the "Drift":** Look at the **Money Kept** widget. If Path 1, 2, and 3 don't match, an employee might have manually altered a folio after the night audit.
3. **Look for Cash Variances:** Go to `Employees` -> `Clerk Audit Matrix`. Did a clerk have a large cash drop variance? 

### Scenario B: "An Employee is Locked Out"
1. **DO NOT delete their account.**
2. Go to `Users` (you must be an Owner/Admin).
3. Find their name and check if the **Lockout Flag** is triggered (happens automatically after 5 bad passwords).
4. Click "Unlock" or "Send Password Reset".
5. If they lost their MFA phone, click "Reset MFA".

### Scenario C: "The App is Super Slow or Freezing"
1. You likely have too many raw CSV previews stuck in your local browser cache.
2. Press `Ctrl + Shift + R` (Hard Refresh) to clear the IndexedDB cache and pull fresh data.

### Scenario D: "I Accidentally Imported the Wrong Date's Data"
1. Go to the `Import` page.
2. Find the bad import in the "Recent Imports" list.
3. Click the **Undo/Rollback** button. (The system treats imports as atomic ledgers, so clicking undo instantly wipes the data safely without leaving ghost records).

---


# 20. DANGEROUS ONE-SHOT SCRIPTS AT THE REPO ROOT (DO NOT RUN)

> [!CAUTION]
> These are dead, single-use generators from earlier documentation sessions. They are NOT
> part of the build, nothing imports them, and **running any of them again destroys work.**
> They are kept only as a record of how the current docs were produced.

| Script | What happens if you run it |
|--------|---------------------------|
| `upgrade_system.cjs` | Rewrites `BRAIN.md`, all 7 spokes, `scripts/generate-brain-map.mjs`, `scripts/verify-brain.mjs`, `.git/hooks/pre-commit` **and `package.json`** -- and overwrites `BRAIN.md`, its own input |
| `upgrade_system2.cjs` | Same set minus `BRAIN_INDEX.md`, plus it inlines its own copy of the emergency playbook into `BRAIN_TROUBLESHOOTING.md` |
| `enhance.js` | Regexes target the OLD monolithic BRAIN.md. Against the current hub every replace no-ops and it appends a duplicate section 19 |
| `enhance.py`, `fix_brain.py`, `fix_brain2.py`, `fix_brain3.py` | Same class. Dead generators for the monolith |
| `fix_entities.py` | **Caused known problem #10.** Naive positional string replacement on RLS operators |
| `rename_functions.py` | One-shot rename, already applied |

> [!NOTE]
> `verify-brain.mjs` and `package.json` came out of the 2026-08-19 run byte-identical, so
> they are absent from the damaged-file list. That was luck -- the regenerated content
> happened to match -- not evidence that those two writes are safe.


### What went wrong on 2026-08-19 (known problem #13)

`upgrade_system.cjs` and `upgrade_system2.cjs` were re-run against a `BRAIN.md` that was
ALREADY the hub. Their extractor is:

```js
function getSec(regex) {
    const s = sections.find(x => regex.test(x));
    return s ? '# ' + s : '';        // <-- returns EMPTY STRING on no match
}
```

The hub contains none of the `# 12. THE MONEY MATH` style sections, so every `getSec`
returned `''`, and each spoke was written with only the newlines used to join them. The
byte sizes prove it exactly: FINANCE 0 bytes (one empty section), SECURITY 2 bytes (two
joined by `\n\n`), FRONTEND 4 bytes (three), BACKEND 6 bytes (four). **940 lines / ~47KB**
of documentation across 6 spokes became whitespace. The same run also reverted commit
`4dfd4e2` ("Fix mojibake and missing index in Hub") by re-injecting emoji into the hub and
`generate-brain-map.mjs`, and dropped the `BRAIN_INDEX.md` routing row entirely.

**Root cause:** a non-idempotent script that overwrites its own input, combined with an
extractor that treats "not found" as "empty" instead of an error.

### Fixed at the source 2026-08-19: both scripts now abort instead of destroying

Restoring the documents repaired only the symptom, so both scripts were given a two-layer
fail-fast guard. Neither can silently gut a document again:

1. **Before the first write**, the guard checks `BRAIN.md` for three sentinel sections
   (`12. THE MONEY MATH`, `13. SECURITY ARCHITECTURE`, `7. ALL 16 DATABASE TABLES`). If any
   is missing the repo is already migrated, so the script prints `ABORTED: BRAIN.md is not
   the pre-migration monolith` and exits 1 having written nothing.
2. `getSec()` now **throws** on a non-matching regex instead of returning `''`, so even a
   monolith with one section missing cannot produce an empty spoke.

Verified in a disposable `/tmp` mirror, not against the real tree:

| Test | Result |
|------|--------|
| Re-run both scripts against the current hub | exit 1, `ABORTED`, **all 12 candidate files byte-identical** |
| Run against a synthetic monolith missing one needed section | guard passes, `getSec` throws, pre-existing spoke untouched, the one spoke it did write holds real content |
| **Mutation self-test:** strip the guard back out and re-run | destruction reproduces with the *identical* fingerprint -- FINANCE 0, SECURITY 2, FRONTEND 4, BACKEND 6, TROUBLESHOOTING 1518 bytes |

That third row is the important one: it reproduces the original incident byte-for-byte, which
proves the guard is what prevents it rather than some unrelated change.

### Recovery procedure (if it happens again)

The spokes are committed, so HEAD is the source of truth. Nothing needs regenerating.

```powershell
# 1. Confirm the damage is a pure deletion (sizes near zero, all deletions in the diff)
git diff --stat -- BRAIN.md docs/brain

# 2. Restore byte-exact from HEAD -- do NOT re-run any generator
git checkout HEAD -- BRAIN.md docs/brain/ scripts/generate-brain-map.mjs

# 3. Regenerate ONLY the auto-generated danger map
npm run brain:map

# 4. Prove it: worktree blob hash must equal the HEAD blob hash
git hash-object docs/brain/BRAIN_BACKEND.md
git rev-parse HEAD:docs/brain/BRAIN_BACKEND.md
```

> [!NOTE]
> On the OneDrive mount, `git status` may keep reporting these files as modified even after
> a byte-exact restore. That is a stale index stat cache -- the mount forbids the `unlink`
> git needs to rewrite its index. Trust `git hash-object` vs `git rev-parse`, not the `M`
> flag. For the same reason, **never run `git stash` on this repo** -- it fails halfway and
> leaves a `.git/index.lock` that blocks every later git command.


---


# 21. WHY THE MONEY MATH DRIFTED (root cause behind known problem #6)

> [!IMPORTANT]
> Known problem #6 was filed as "float math precision errors". Precision was the
> smallest part of it. `decimal.js` already existed and was correct; the defect was
> that four modules each computed the owner's headline numbers their own way. Fixing
> the rounding without collapsing the duplicate routes would have produced four
> figures that were each exact and still disagreed.

### 21.1 The pattern: two modules, one number, two routes

`CalculationService.calculateMoneyKept` computed gross revenue as
`sumCents(occRows.map(r => r.room_revenue))`. `MoneyKept.jsx` — the widget that
renders that number — computed it with `hotel.js#grossRevenueForPeriod`, which adds
ancillary charges (food, bar, event, laundry, phone, misc, system, other) on top of
room revenue. Both were "right" in isolation. Together they meant the service
deducted taxes and expenses that ancillary revenue helped pay for while refusing to
count that revenue.

The service already **received** `grossRows`. It used them for the tax basis and
then ignored them for the gross figure. So the data was in the function; only the
route was wrong.

**Fix:** `calculationService.js` now calls the same exported helper the widget calls,
and returns the provenance alongside the number:

```js
const grossBasis = grossRevenueForPeriod({ grossRows, occRows });
const grossCents = grossBasis.cents;
// returned as `grossBasis` so a caller can see WHICH basis produced the figure
// { cents, dollars, basis: "total" | "room", roomCents, ancillaryCents }
```

> [!TIP]
> **BEST OUTCOME NOTE.** Returning the basis is what makes this durable. A shared
> helper makes divergence unlikely; a returned `basis` field makes it *visible*. Any
> future probe or panel can assert "this figure came from the total-charge ledger",
> which is a claim you cannot make about a bare number.

### 21.2 The same pattern, four more times

| Where | Two routes to one number | Resolution |
|-------|--------------------------|------------|
| Occupancy capacity | Per-row `total_rooms` fallback vs. per-day inventory | `capacityCents()` — capacity is days x rooms, never rows x rooms |
| Period averages | `rows.length` used as the day count | Distinct dates in range |
| Card fee basis | All tender vs. card tender | `CARD_METHODS = ["visa","master","amex","discover"]` |
| Daily aggregates | Cached floats vs. live integer cents | Cache stores cents |

### 21.3 Why the capacity fallback mattered more than it looks

A per-row capacity fallback means a **double import is invisible**. Import the same
28-day month twice and you get 56 rows; occupancy sums to 2x, but capacity also sums
to 2x, so the ratio stays plausible and nothing looks wrong. A hotel has 28 x 100 =
2800 room-nights in August however many times the report was imported. With per-day
capacity the same double import reports >100% occupancy, which is the signal the
owner needs.

`scripts/verify-actioncenter.mjs` previously asserted `occupancy <= 1.001` on
exactly this fixture and passed — the assertion had encoded the defect. It now
asserts the strictly stronger pair: a double import **doubles** occupancy, and
capacity does not grow with row count.


# 22. SUITES THAT COULD NOT FAIL (verification integrity)

> [!CAUTION]
> A suite that cannot fail is worse than no suite. It converts "untested" into
> "verified" in every report that counts exit codes — including this document's own
> status column.

Twelve suites were found in this state on 2026-08-20. The failure modes, in order of
how convincingly each one lied:

| # | Failure mode | Example | Why it read as green |
|---|--------------|---------|----------------------|
| 1 | Printed a defect, exited 0 | `probe-money-kept.mjs` printed `PRECISION LOSS DETECTED!` then fell off the end of the function | No `process.exit(1)`; runners count exit codes |
| 2 | `console.assert` used as an assertion | several | `console.assert` prints and returns; it does not throw and does not set an exit code |
| 3 | Fixture never reached the code under test | `probe-money-kept.mjs` fed `{ total_revenue: 2.05 }` to a function that reads `room_revenue` | Gross came back $0, so the arithmetic under test never ran |
| 4 | Probe re-implemented the product, then agreed with itself | `probe-revenue-reconciliation.mjs` | Both sides shared the same wrong assumption |
| 5 | Assertion anchored to a hand-typed snapshot | several | The snapshot was transcribed from the defective output |
| 6 | Assertion encoded the defect | `verify-actioncenter.mjs` occupancy bound | See 21.3 |
| 7 | Suite tested a function with no production callers | `verify-money-kept.mjs` (23 green checks) | `CalculationService.calculateMoneyKept` is not called by any page — which is how the `grossBasis` ReferenceError in `MoneyKept.jsx` shipped uncaught |
| 8 | Suite could not finish, so it reported nothing | `probe-money-kept-fix.mjs` | Its module graph held open SDK handles and it had no `process.exit`, so it hung forever and could only ever be labelled TIMEOUT. Tracker #36 |

**All eleven are closed as of 2026-08-20** — twelve, counting the hang found while
verifying the other eleven (mode 8 above, tracker #36). The last two of the original
eleven were the most instructive, because each printed a sentence that was true and
useless:

- **`probe-validation-gaps.mjs`** ended with `-> if 85 becomes 0, the /100 branch is
  unreachable and the percent case loses its data.` That was correct, and it had been
  printed on every run for months, because a printed defect and a passing suite are
  the same exit code. Acting on the sentence found **two real defects** in
  `src/lib/reportParsers.js`: no `COLUMN_MAP` key mapped to `occupancy` at all (so the
  printed-percentage branch was unreachable, every clean import raised a false
  `unknown_columns` warning, and a file without room counts imported the hotel as
  empty), and the branch's own `= 0` default made `occupancy` look *present* to
  `REQUIRED_FIELDS`, so such a file imported with **zero findings**. See
  BRAIN_FINANCE.md 12.7. Now 56 assertions driven through the real `scanReport`.
- **`probe-ui-disabled-reason.mjs`** printed `❌ DEFECT CONFIRMED` from line 72,
  outside every conditional, and exited 0 — so it announced a defect and success on
  the same run. **The product was already correct.** The probe had re-declared
  AuthContext's logic in two local variables instead of reading it, so when the real
  fix landed the copy stayed broken. `git log` settles which was stale: the product
  file was fixed in `ee79a64` (2026-08-17, subject *"fix: Disabled user shown wrong
  reason"*) and `b8f7334` (2026-08-19); the probe's only commit is `4dbebbf`, the
  docs migration. Now 22 source-contract assertions and **no product change** —
  `AuthContext.jsx` is protected and `ProtectedRoute.jsx` was not broken.

> [!IMPORTANT]
> **A probe is not automatically the spec.** When a suite and the product disagree,
> decide which one is stale *from `git log` on both files* and write the commit hashes
> into the probe header. Two of the eleven suites here described defects that had
> already been fixed; "make the product match the probe" would have re-introduced
> them. The reverse error — trusting the product because the probe looks old — is just
> as easy, which is why the evidence goes in the file rather than in a commit message.

### 22.1 Every fix was mutation-tested

A repaired assertion is itself an untested claim. Each fix in this session was proved
capable of failing by reverting the product change and confirming the suite goes red:

| Mutation | Suite | Result |
|----------|-------|--------|
| Restore `sumCents(occRows.map(r => r.room_revenue))` as the gross basis | `probe-decimal-integration.mjs` | CAUGHT |
| Restore the per-row capacity fallback | `verify-actioncenter.mjs` | CAUGHT |
| Remove the `NUMERIC_TEXT` exemption from `csvCell` | `probe-export-data.mjs` | CAUGHT — reproduces `'-25.5`, 5 checks red |
| Restore the unreachable `else if (printed > 1)` occupancy branch | `probe-validation-gaps.mjs` | CAUGHT — 4 red |
| Unmap `"Occupancy Including OOO Comp and House Use"` from `COLUMN_MAP` | `probe-validation-gaps.mjs` | CAUGHT — 7 red |
| Drop `extraFindings` from the `validateImport` call | `probe-validation-gaps.mjs` | CAUGHT |
| Drop the `Number.isFinite` guard in `parseAmount` | `probe-validation-gaps.mjs` | CAUGHT |
| `setUser(null)` in the cross-tab `'disabled'` branch | `probe-ui-disabled-reason.mjs` | CAUGHT — 2 red |
| `me.is_active === false` → `status: 'revoked'` | `probe-ui-disabled-reason.mjs` | CAUGHT — 2 red |
| Remove the locally-known-inactive short-circuit | `probe-ui-disabled-reason.mjs` | CAUGHT |
| Let `'disabled'` into `isWarning` (amber instead of red) | `probe-ui-disabled-reason.mjs` | CAUGHT |
| Banner titles a disabled account `'Account Restricted'` | `probe-ui-disabled-reason.mjs` | CAUGHT |

> [!TIP]
> **BEST OUTCOME NOTE — how to mutation-test a PROTECTED file.** Three of the
> mutations above target `src/lib/AuthContext.jsx`, which PROTECTED_FILES.md forbids
> writing to *at all* — a temporary edit that gets restored is still an edit, and a
> crash between the two leaves a protected file modified. Instead, mirror the sources
> into a throwaway tree and run the probe there:
>
> ```bash
> mkdir -p /tmp/fr/scripts /tmp/fr/src/lib /tmp/fr/src/components
> cp scripts/probe-ui-disabled-reason.mjs /tmp/fr/scripts/
> cp src/lib/AuthContext.jsx /tmp/fr/src/lib/
> cp src/components/ProtectedRoute.jsx /tmp/fr/src/components/
> node /tmp/fr/scripts/probe-ui-disabled-reason.mjs   # 22/0 on the mirror
> ```
>
> This works because the probe resolves its own root with
> `path.resolve(new URL("..", import.meta.url).pathname)` rather than `process.cwd()`,
> so the copy reads the copies. Mutate inside `/tmp/fr` freely; the repo is never
> written, and `git hash-object` on both files still matches
> `git rev-parse HEAD:<path>` afterwards. **Prefer this over backup-and-restore for
> any file you are not allowed to touch, and write probes that derive their root from
> `import.meta.url` so the technique stays available.**

> [!TIP]
> **BEST OUTCOME NOTE.** "The suite is green" and "the suite would notice" are
> different claims. Only the second one is worth writing down, and the only way to
> earn it is to break the product on purpose and watch the suite object.

### 22.2 The runner now makes a non-running suite visible

`scripts/verify-all.mjs` auto-discovers `probe-*.mjs` and `verify-*.mjs` — convention
over configuration, so a new suite cannot be forgotten by omission from a list. It
distinguishes three outcomes that all used to look alike:

- **FAIL** — ran, asserted, disagreed.
- **BROKEN** — could not start (`ERR_MODULE_NOT_FOUND`, `Cannot find module`, missing
  export). Reported separately, because a suite that cannot start reports nothing.
- **SKIP** — printed `SKIP:` and exited 0. Stays visible in the summary even on a
  green run, so missing coverage is never laundered into a pass.

Exclusions live in one `EXCLUDE` map, each with a factual reason. A suite must never
be excluded for failing; that is the one thing the runner exists to surface.

> [!NOTE]
> **Not verifiable in the Linux VM — these are Not Run, not verified.** Measured
> 2026-08-20:
> - `verify-harness.mjs` — `import('vite')` fails with
>   `Cannot find module @rollup/rollup-linux-x64-gnu`, because `node_modules` here was
>   installed on Windows and Rollup's platform-native binding is absent. Reports SKIP
>   rather than crashing, and stays visible in the summary.
> - `acceptance-harness.mjs` — same vite dependency, but note it is **not even
>   auto-discovered**: its name matches neither `probe-*` nor `verify-*`, so it never
>   appears in `--list` and cannot report SKIP. It is invisible to the runner, which is
>   worse than skipping. Run it by hand.
> - `probe-config-exposure.mjs` — needs a dev server on `localhost:5173`; SKIPs with
>   `ECONNREFUSED`.
>
> Run all three on the owner's Windows machine, or in CI after that platform's own
> `npm install`.

### 22.3 A reduced `--timeout` manufactures failures (my own mistake, 2026-08-20)

The 70 suites run serially and take 12-25 minutes end to end. The sandbox used to
drive them kills any single command at ~178s **and discards its output**. Faced with
that, I lowered `--timeout` so a whole run would fit. It does not work that way: the
per-suite budget is not the run length, so all that changed was which suites got
killed. Seven came back `TIMEOUT` and I recorded them in BRAIN.md as broken suites.

Re-run individually with a real budget, six of the seven pass, and none is slow enough
to have been in danger:

| Suite | Result | Time |
|-------|--------|------|
| `probe-property-isolation.mjs` | 47 passed, 0 failed | 8.5s |
| `verify-anomaly-ingestion.mjs` | 9 passed, 0 failed | 10.0s |
| `verify-source-contributions.mjs` | 12 passed, 0 failed | 25.6s |
| `verify-statistics.mjs` | 84 passed, 0 failed | 12.5s |
| `verify-import-rollback.mjs` | 11/11 passed | 16.0s |
| `verify-coexistence.mjs` | 23 passed, 0 failed | 15.2s |
| `probe-money-kept-fix.mjs` | **genuine defect** — infinite hang | fixed, now 9.7s |

So one real defect was hiding behind six fabricated ones, and the fabrication was
mine. `scripts/verify-all.mjs` now takes `--shard i/n`, which cuts the SUITE LIST into
contiguous slices instead of squeezing each suite's budget:

```bash
for i in $(seq 1 10); do npm run verify:all -- --shard $i/10; done   # one shard per command
```

`1/n .. n/n` covers every suite exactly once — verified by concatenating all ten
`--list --shard` outputs and diffing against the unsharded list: 70 lines, 70 distinct,
no overlap, no gap. Bad input (`9/7`, `0/7`, `3/0`, `banana`) exits 1 rather than
silently running a wrong subset, and every sharded run prints
`This is ONE SHARD. The other shards are unverified by this run.`

> [!TIP]
> **BEST OUTCOME NOTE.** When a measurement will not fit the harness, change the
> harness's *axis of division*, never its *tolerances*. Loosening a tolerance to make a
> run fit converts "I did not measure this" into "this failed" — the same class of
> error as a suite that cannot fail, just pointed the other way. And when the false
> finding has already been written down, correct the document in place and say whose
> error it was: a status table that quietly stops mentioning seven broken suites is
> indistinguishable from one that never noticed them.

### 22.4 Full-suite baseline, 2026-08-20 — CORRECTED

> [!IMPORTANT]
> **Superseded later the same day — see 22.6.** The numbers below are the honest
> record of *this* run and are kept for the audit trail, not as the current state.

**71 suites — 69 PASS, 0 FAIL, 0 BROKEN, 0 TIMEOUT, 0 BAD-EXIT, 2 SKIP.**
Suite list fingerprint `8c09a3eb`.

70 of those came from a 10-shard `npm run verify:all`, every shard's log read
individually. The 71st, `probe-audit-write-failure.mjs`, was run on its own afterwards:
**60 passed, 0 failed**. Why it was not in the sharded run is 22.5 below.

The 2 SKIPs are `verify-harness.mjs` and `probe-config-exposure.mjs`, both for
environment reasons listed in the NOTE above, and both **Not Run** rather than passed.
Largest suites in the set: `verify-donut-labels` 728 checks, `probe-export-data` 149,
`probe-auth-hardening` 132, `probe-premium-surfaces` 131, `verify-transactions` 115,
`verify-statistics` 84, `probe-ui-feedback` 83, `probe-audit-export` 76,
`probe-audit-write-failure` 60.

### 22.5 A sharded run over a moving file set (tracker #37)

This section previously claimed **70 suites, 68 PASS, 2 SKIP**. Those numbers are
internally consistent — 68 + 2 = 70 — and `scripts/` contained **71** suites.

A sharded run is several separate invocations, and each one re-reads the directory.
`probe-audit-write-failure.mjs` was written at 11:39 while the run was in progress, so
the shards launched before that saw 70 names and the ones after saw 71. Slice boundaries
come from `suites.length`, so every boundary moved mid-run: a suite can land in two
shards, or in none, while **every shard still prints "All green."**

Nothing was actually broken here — the missing suite passes 60/0 — but the run could not
demonstrate that, and a run that cannot demonstrate coverage has not provided it.

The fix is in the runner, because arithmetic is not a control:

```
Running 8 suite(s) [shard 1/9 of 71], 240s timeout each — list 8c09a3eb (71 discovered)
...
This is ONE SHARD. The other shards are unverified by this run.
Before summing shards, confirm every shard printed list 8c09a3eb (71 discovered) —
a different id means a different file set.
```

`LIST_ID` is a sha256 over the full discovered list, taken **before** `--filter` and
`--shard` narrow it, so every shard of one honest run prints the same id. Measured:
adding one file to a mirrored `scripts/` moves the id from `8c09a3eb` to `d1514c06`;
two consecutive invocations of the real list agree; all 9 shards of `n=9` print
`8c09a3eb` and together cover 71 distinct files with no duplicates.

> [!TIP]
> **BEST OUTCOME NOTE.** Check a green report's arithmetic against the number of things
> that were supposed to run, then make the report carry the evidence so the next reader
> does not have to. Both of the wrong suite counts written into BRAIN.md on 2026-08-20
> survived a reading of every per-shard log; addition caught them both. Freezing
> `scripts/` for the duration of a sharded run is the discipline, and the fingerprint is
> what makes a breach of it visible rather than merely unlikely.

---

### 22.6 Re-measured after the 72nd suite, 2026-08-20

**72 suites — 70 PASS, 0 FAIL, 0 BROKEN, 0 TIMEOUT, 0 BAD-EXIT, 2 SKIP.**
Suite list fingerprint `53aa539e`.

An 8-shard run, every shard log read individually, every shard printing
`list 53aa539e (72 discovered)`. The count moved from 71 because
`probe-csrf-default-closed.mjs` was written after 22.4 was measured. That is the
fingerprint doing its job: the id changing is the visible signal that two runs are
not summable, which is precisely the failure 22.5 was built to catch.

The 2 SKIPs are unchanged and are **Not Run**, not passes:
`verify-harness.mjs` (needs Vite; `node_modules` here was installed on Windows so
Rollup's Linux binding is absent) and `probe-config-exposure.mjs` (needs a dev server
on `localhost:5173`). `acceptance-harness.mjs` and `npm test` share the Rollup limit
and are not auto-discovered at all.

---

# 23. THE §14 TRACKER IS NOT THE OWNER’S REVIEW PLAYBOOK

> [!CAUTION]
> Section 14 closing at 38/38 does **not** mean the owner’s 30-item review playbook is
> closed. They are two independent lists. On 2026-08-20 the tracker read 37/37 while
> nine playbook items were still open — reading the tracker as a proxy for the playbook
> is how they stayed open. Check the playbook against this table, not against §14.

Every verdict below is a measurement, not a reading of the playbook’s own wording.
Two of the nine are **false as written** and a third is a non-defect — the playbook is a
set of claims to be tested, not a set of instructions to be executed.

| Playbook # | Claim | Verdict | Evidence |
|---|---|---|---|
| 13 | Delete dialogs do not disclose what the delete keeps | **REAL — FIXED** | §14 row 38. `deleteGuard.js` `dependents`; `probe-delete-guard.mjs` 78/0; both branches mutation-tested (weakening the zero-drop filter fails 3 assertions, disabling the refusal fails 8) |
| 15 | Overtime hours are not rounded, so pay drifts | **FALSE AS STATED** | `src/lib/timecardCalc.js:291-292` already rounds both `overtime_hours` and `hours` to 2dp before `toCents`, and pay is composed from integer cents. No change made |
| 20 | `VITE_BASE44_APP_ID` has a hardcoded production fallback | **REAL — DOCUMENTED, NOT REMOVED** | `src/api/base44Client.js:33`. The id is not a secret (it is also in `base44/.app.jsonc`); the hazard is silently defaulting to the wrong tenant. No `.env` file in the repo sets the variable today, so removing the fallback would break a build that **cannot be built in this VM** (`npm run build` needs the Windows Rollup binding). `.env.example` now documents setting it explicitly in every environment. Removing the fallback is a one-line change that must be paired with a real build |
| 23 | `@types/qrcode` is an unnecessary dependency | **KEEP — measured, not assumed** | `qrcode` is imported in 3 files and ships no types of its own. Removing the stub does not error (`skipLibCheck: true`, `maxNodeModuleJsDepth: 0`), so the playbook is technically right that nothing breaks — but it is a devDependency with zero bundle cost, so removal is a pure loss of editor and typecheck signal. Kept deliberately |
| 24 | `moment` is unused | **REAL — FIXED** | Zero imports anywhere in `src`, `base44` or `scripts`. Removed from `dependencies`. `date-fns` (the actual date library) untouched |
| 26 | `rollup-plugin-sri` is unused | **REAL — FIXED** | Never referenced by `vite.config.js` or any script. Removed from `devDependencies`; regenerating the lock pruned its whole transitive tree (cheerio, parse5, undici, domhandler, iconv-lite and ~15 more) — **-482 lock lines, pure deletions**. A real supply-chain reduction, not just tidying |
| 27 | There is no `tsconfig.json` | **NON-DEFECT** | `jsconfig.json` *is* the typecheck config and `npm run typecheck` runs `tsc -p ./jsconfig.json` against it. Adding a `tsconfig.json` would make the effective config ambiguous, because bare `tsc` prefers `tsconfig.json` over `jsconfig.json` — two configs is strictly worse than one. No change made |
| 29 | `vite.config.js` uses `__dirname`, which breaks under ESM | **FALSE — and it names the wrong file** | `vite.config.js` contains no `__dirname` at all; the only occurrence in either config file is `vitest.config.js:9`. It resolves there anyway: the installed Vite 6.4.3's `bundleConfigFile()` passes esbuild `define: { __dirname: "__vite_injected_original_dirname" }` and injects that variable, so a bundled config never meets the ESM gap. Read out of `node_modules/vite/dist/node/chunks/dep-Dm0c1Wj2.js`, not inferred from the ESM rule. No change made *(citation corrected 2026-08-20: this row first repeated the playbook's `vite.config.js` instead of checking which file it meant)* |
| 30 | No `.env.example`, so required variables are undocumented | **REAL — FIXED** | Created, with every variable annotated by the `file:line` that reads it. `.gitignore` needed an explicit `!.env.example` negation because `.env.*` swallowed it: proven with `git check-ignore` exit codes against a `.env.local` control, then `git status --untracked-files=all` showing `?? .env.example` |

> [!TIP]
> **BEST OUTCOME NOTE.** Test the claim before doing the work. Two of these nine items
> were false, one was a non-defect, one was best left alone, and one could not be done
> safely without a build this VM cannot run — so **five of nine would have been damage
> if executed as written**, including a `tsconfig.json` that would have made the
> typecheck config ambiguous and a removed `@types` stub that only costs signal.
> The two genuine dependency removals were worth far more than they looked:
> deleting two lines from `package.json` removed roughly twenty packages from the lock.
> Measure first, and record the measurement next to the verdict so the next reader does
> not have to re-derive it — the verdict alone is not evidence.
