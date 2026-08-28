# RED ROOF INTELLIGENCE - MASTER BRAIN (HUB)

> [!IMPORTANT]
> **AI AGENTS:** You are currently in the HUB. To save tokens and maximize context window efficiency, this file only contains routing.
> Read the specific Spoke files below based on your exact task. NEVER scan the entire project.
>
> **RUNTIME FACT:** Base44 is retired. Do not query or deploy through Base44. The
> production site is a standalone Vite bundle deployed from GitHub `main` to the
> Cloudflare Worker `boston-project`; the active database is Dexie/IndexedDB in the
> user's browser. Names under `base44/` and `src/api/base44Client.js` are legacy
> compatibility artifacts. See `README.md` and the BACKEND spoke before diagnosing
> deployment or data issues.

## THE SPOKES (Context Segmentation)

Active repairs: [Owner repair checklist](docs/OWNER_REPAIR_CHECKLIST.md). Read it
before continuing owner-review work and have the checklist reviewer check each
batch. It is the persistent record of what is fixed and what is still missing.

| Domain | File | Use When... |
|--------|------|-------------|
| [FINANCE] | `docs/brain/BRAIN_FINANCE.md` | Math, formulas, CSV parsers, or reconciliation. |
| [SECURITY] | `docs/brain/BRAIN_SECURITY.md` | Auth, MFA, sessions, or audit logs. |
| [FRONTEND] | `docs/brain/BRAIN_FRONTEND.md` | React UI, pages, components, or hooks. |
| [BACKEND] | `docs/brain/BRAIN_BACKEND.md` | Current Cloudflare/Dexie runtime plus legacy Base44 artifacts. |
| [FIXES] | `docs/brain/BRAIN_TROUBLESHOOTING.md` | Diagnosing known problems or emergency playbook. |
| [INDEX] | `docs/brain/BRAIN_INDEX.md` | Verify file paths (422-file complete catalog). |
| [MAP] | `docs/brain/BRAIN_DEPENDENCIES.md`| See what breaks if you edit a file (Auto-Generated). |

## SYSTEM ARCHITECTURE
```mermaid
graph TD
    GitHub[GitHub main branch] -->|Cloudflare Workers Build| Host[Cloudflare Worker<br/>boston-project]
    Host -->|serves dist/| UI
    subgraph Browser [User's Browser]
        UI[React Frontend<br/>(34 Pages, 40+ Components)]
        DB_Local[(Dexie / IndexedDB<br/>Active Database)]
        UI <--> DB_Local
    end
    Legacy[Legacy only:<br/>base44 entities/functions/config]
    Legacy -.->|not deployed or connected| UI
```

## AI RULES (The 5-Step Workflow)
- [ ] 1. SCAN: Read this Hub, then read the relevant Spoke.
- [ ] 2. PROVE: Write a test.
- [ ] 3. FIX: Fix the core.
- [ ] 4. VERIFY: Run the test.
- [ ] 5. UPDATE: Update the relevant BRAIN_*.md file! (Enforced by Git Hook)

## HOW TO RUN THE SUITES (read this before writing a probe)

```bash
npm run verify:all              # auto-discovers every scripts/probe-*.mjs and verify-*.mjs
npm run verify:all -- --list    # what would run, and what is excluded and why
npm run verify:all -- --filter money   # one slice
npm run verify:all -- --shard 3/10     # the 3rd of 10 consecutive slices of the list
npm run lint                    # 0 errors expected
npm run typecheck               # tsc -p ./jsconfig.json with checkJs -- JSDoc is load-bearing
npm run brain:map               # regenerates BRAIN_DEPENDENCIES.md -- never hand-edit that file
```

A single suite: `node --import ./scripts/_loader-boot.mjs scripts/probe-<name>.mjs`.
The loader resolves the `@/` alias and extensionless imports; without it a suite that
imports from `src/` dies at import with `ERR_MODULE_NOT_FOUND`. **`npx tsc` downloads
the wrong package — always use `npm run typecheck`.**

> [!CAUTION]
> **If your shell caps a command's wall clock, shard the LIST — never lower
> `--timeout`.** Measured 2026-08-25 at list `2f3a5c5a`: the 111 suites run serially in
> **519.8s of suite time — 8.7 minutes, mean 4.7s**, with a long tail of four
> (`probe-audit-write-failure` 54.7s, `probe-audit-export` 49.4s,
> `probe-user-form-validation` 45.0s, `probe-premium-surfaces` 25.7s). An earlier
> revision of this note estimated "12-25 minutes at 70 files, longer at the current
> 100" and that estimate is what made a full sweep look impossible in a sandbox — it is
> wrong by roughly 2-3x. **A complete sweep fits here**: 20 shards of 6, three shards
> per command at a 175s cap, is the recipe that produced the green run in the table
> below. Lowering `--timeout` to fit does not shorten the run, it kills slow suites and
> labels them `TIMEOUT`. That
> is exactly how this file came to claim "7 broken suites" on 2026-08-20 — six of the
> seven pass in 9-25s each when given a real budget. `--shard i/n` cuts on the correct
> axis: `for i in $(seq 1 10); do npm run verify:all -- --shard $i/10; done`, one
> shard per command. Shards are contiguous over the sorted list, so `1/n .. n/n`
> covers every suite exactly once, and a sharded run prints
> `This is ONE SHARD` so a green shard is never read as a green run.
>
> **A sharded total is only a total if every shard printed the same list
> fingerprint.** Each run prints `list <id> (<n> discovered)`; the id is a hash of the
> full discovered suite list. Adding a suite file mid-run changes `suites.length`, which
> changes every slice boundary — so a suite can be run twice or not at all while all
> shards still report green. That happened on 2026-08-20; see the NOTE under CURRENT
> STATE. Freeze `scripts/` for the duration of a sharded run and check the ids match
> before summing. Verified three times, on three file sets: 9 shards over 71 suites all
> printed `8c09a3eb`, 8 shards over 72 all printed `53aa539e`, and 20 shards over 111 all
> printed `2f3a5c5a` — each covering every file exactly once, and a trailing shard
> reports itself empty rather than green (`shard 20/20 is empty (111 suite(s) fit in 19
> shard(s) of 6). Nothing to run.`). The cheap way to prove exactly-once rather than
> assume it: collect every result line across the shards, then check
> `sort -u | wc -l` equals the discovered count and `uniq -d` prints nothing. (Counts
> are measurements with dates — the current one is in the table below, not here.)

> [!CAUTION]
> **A suite must exit non-zero when it fails.** `console.assert` prints and returns; it
> does not throw and does not set an exit code. On 2026-08-20 eleven suites were found
> that could not fail — some printed a defect and exited 0 for months. `verify-all.mjs`
> reports FAIL, BROKEN (could not start) and SKIP as three different outcomes for
> exactly this reason. Before trusting a repaired assertion, break the product on
> purpose and confirm the suite objects. See BRAIN_TROUBLESHOOTING.md section 22.

## CURRENT STATE (2026-08-25)

| Area | Status |
|------|--------|
| Known problems tracker | 60 filed, **60 fixed, 0 OPEN** — BRAIN_TROUBLESHOOTING.md section 14. #60 closed 2026-08-25: **the launch checklist's top blocker was "set a secret in a dashboard that is not the host", and nothing in the shipped build reads that secret.** `LAUNCH_READINESS_CHECKLIST.md` named **Vercel on 14 lines (20 occurrences)** and **Cloudflare zero times**, while `wrangler.jsonc:20`/`:23` have shipped a Cloudflare Worker serving `./dist` since section 33. Not a behaviour defect — the same class as #58, and dangerous for the same reason: this is the one artifact in the repo that instructs a human to change something *outside* the repo, so when it is wrong the code stays correct, the deployment stays broken, and **no gate can tell.** Four defects. The most-emphasised step, repeated in four places, is **void rather than relocated**: `AUDIT_CHAIN_SECRET` appears in exactly one place tree-wide, `secrets.get()` inside `base44/functions/**` (eight call sites, `audit_log/entry.js:70` through `deleteAccount/entry.ts:126`) and **never in `src/`** — that backend is gone and `wrangler.jsonc` declares no vars or secrets at all, so there is no field to fill and no code left to read it. The obvious repair was to rewrite "in Vercel" as "in Cloudflare", which would have replaced one wrong instruction with another. Two more were **inverted, and following either breaks the live site**: *"confirm `VITE_USE_LOCAL_AUTH` is absent from production"* — `src/main.jsx:26` refuses to boot a build carrying only that flag, the standalone shape needs **both** it and `VITE_STANDALONE_LOCAL`, and `.env.production` is committed on purpose after two deploys died from their absence; and *"`dist/` is a build artifact, do not trust it"* — `wrangler.jsonc:23` serves the site **from** `./dist`. The fourth is the counter-intuitive one: `vercel.json` looks like deletable dead config and is now the canonical **spec** that `probe-deploy-config.mjs` §1 parses and §10/§11 diff `base44/config.jsonc` and `public/_headers` against key by key, so removing it breaks a passing gate and un-pins every security header. The replacement top blocker is **Cloudflare Access on the `boston-project` Worker**, recorded as **UNKNOWN** rather than guessed: with auth verified in the browser, an upstream identity gate is the only real boundary. B9's checkbox is VOID and **left unticked on purpose** — nobody performed the step, so ticking it would falsify the record; the consequence now stated for the owner to accept knowingly is that the shipped build has **no server-side audit hash chain**, because the client-side chain in `securityUtils.js` is computed and stored in the same browser it protects. Three `dist/` staleness symptoms the document asserted had **already been fixed** and were replaced with what is measurably stale: 8 tracked inputs newer than the build, 4 of them bundled. One character of it was my own error arriving twice — `probe-standalone-deploy.mjs` §7, not §6, owns `ENV_PROD_ALLOWED`, and `.env.production:11` carried the same wrong number. Section 39. #59 closed 2026-08-25: **the Dashboard card titled "Yield & ADR Optimizer" optimized nothing, and every figure in it was invented.** Five defects in three `if` branches: literal `$10–$15` / `$5–$8` rate moves derived from nothing at all, presented as output on a card that says *Optimizer*; `money2(adr * 1.05)` — **float math on a dollar value**, forbidden outright by the BUSINESS directive, with a 5% from nowhere; a caption reading *"Occupancy vs 100-room capacity"* on a page that already holds the real room-night total, where 100 is only the per-property **fallback** for a row with no `total_rooms`; a hardcoded `occupancy > 0.6` band while six other surfaces — `LowOccAlert` among them, **on this same screen** — gate on the owner's `getOccThreshold()`, so at a 70% target the alert flagged a 65% day as low while this panel called it *Healthy*; and an **empty database** falling through both `>` tests into *"Soft Occupancy (0.0%). Drop rate $5–$8"* — rate advice for a period with no rows. The decision moved to `src/lib/yieldAdvice.js` because `_loader-boot.mjs` has no JSX transform, so logic left inside a `.jsx` can only be checked by matching source text — which is exactly how the self-contradiction survived. It deliberately **recommends no rate**: `pricingEngine.js` is the only wired recommender of three that exist, they disagree by up to $25.60/night, and adding a second live one recreates the defect with better arithmetic. Two probe-authoring rules came out of it: a source contract must be anchored on **structure**, not a word (`/capacity/` PASSED against the file it was written to condemn, because the false caption contained the word), and comments must be stripped first, or a probe fails *because the file documents its own fix*. Section 38. #58 closed 2026-08-25: **four documentation clusters sent a reader to code that had nothing to do with what they were reading, and one pointed past the end of the file.** Citation rot has two classes and only one is mechanically detectable: *out of range* is objective, *in range but wrong* needs an anchor and no machine can find it. Measured tree-wide: **722 citations, 697 resolvable, 5 out of range** — 4 of them in `.superbrain/explore-reports/` dated snapshots, which are left alone because re-pointing them would falsify the record they exist to keep. The live one cited line 406 of a **342-line** `ActionCenter.jsx`, and the defect that comment described was already fixed. Following the nested citations found the undetectable class: `uploadGuard.js`'s "Measured 2026-08-21" table quoted line ranges for checks that had **moved into `uploadGuard.js` itself**, and `probe-audit-write-failure.mjs` quoted three pre-fix ranges that had all drifted — one now lands inside `ServerRateLimiter`, so a reader hunting an audit writer arrives at a rate limiter. Two citations were measured **correct** and deliberately not rewritten; one is unfixable here because `src/api/base44Client.js` is **PROTECTED**. All four fixable clusters became **symbol** citations that name the number they used to carry and why it rotted. The convention is now enforced: `scripts/verify-brain.mjs` (16 → 141 lines) gained a **citation range gate** scoped to the staged diff's added lines — a hook this repo never bypasses must never false-block, or the tree cannot be committed at all — with `no-cite-check` as the escape hatch and a **loud exit-0** on its own internal failure, the deliberate opposite of `audit-gate.mjs`. It runs on every commit, and because that file is already excluded from discovery in both `verify-all.mjs` and `probe-suite-integrity.mjs`, discovery stays **111** and the fingerprint stays `2f3a5c5a`. Section 37. #57 closed 2026-08-25: **deleting your own account navigated to `<origin>/true`, and could report "could not be deleted" after the account was already gone.** Three defects in one 16-line handler, all of them only reachable *after* the irreversible step, which is why nobody ever saw them. `db.auth.logout(true)` — that parameter is a **redirect URL**, not a flag, so the assignment was `window.location.href = true`; `wrangler.jsonc`'s SPA `not_found_handling` serves `index.html` at `/true`, so it looks like an ordinary logged-out screen at a strange URL. **Two functions named `logout` are in scope in that file with one parameter each and opposite meanings** — the AuthContext one takes a boolean and builds `/login?returnTo=…` itself, and the file's three other logout sites already call it. Two `localStorage.removeItem` calls were dead (the protected `invokeBackend` already runs `localDb.tables.map(t => t.clear())` **and** `localStorage.clear()` on a successful `deleteAccount`, on both dispatch routes), incomplete (2 of the 3 keys `commissionRates.js` owns), and unguarded — so on a browser that refuses storage they threw into the handler's only catch, which says *"Your account could not be deleted. You are still signed in, and no logout was performed."* Reached that way, **every clause is false**. Deleting them, rather than wrapping them, is what makes that sentence true again: the only statement left after the resolved invoke is the logout. Section 36. #56 closed 2026-08-25: **the Manual Data Entry draft — the only copy of hand-typed money rows until Save lands — could be destroyed, refused, or left behind in total silence, and one of those paths took the whole page down.** Five raw `localStorage` calls, none able to report a failure to the person typing: `getItem` sat **outside** its own `try`, and React re-throws an exception from a `useEffect`, so on a browser that refuses storage (private browsing, blocked site data) `LazyErrorBoundary` replaced the entire page over an optional draft; a stored draft that parsed but was not a usable list was deleted with **no message at all**; the auto-save's only failure path was `console.warn` while the page went on drawing its amber "● Unsaved draft" dot; and the clear after a **successful** save was unguarded and sits before `setSaving(false)` and `rotateCsrfToken()`, so a refused remove left a committed save with the button spinning on a stale CSRF token. `src/lib/manualDraft.js` (NEW) now owns every access — and deliberately **not** via `settingsStore.js`, because a draft's failures have to reach the screen and it needs a guarded remove. Section 35. #55 closed 2026-08-25: **the owner could type 45 into a housekeeping standard, be told it was saved, and watch the page keep using 30.** `generateHousekeepingSchedule` hardcoded `* 30` and `* 15` — *the exact defaults of the two settings it was supposed to read* — which is why it was invisible: at the defaults the page is right, and only a changed setting exposes it. Same class as #51's decorative switch and #54's decorative flag. Three more defects sat on the same path: an unguarded `setItem` that threw out of a click handler (so Save looked inert at quota or in private browsing) while the function returned success unconditionally, `Number(x) \|\| fallback` making the clamp floors unreachable because `Number("")` is `0`, and a save that updated one of two states so the page showed figures derived from a value it had never stored. Section 34. #54 closed 2026-08-24: **a 49-hour shift was paid one hour, and the flag that should have stopped it did nothing.** Three stacked defects: `parseTime`'s AM/PM branch reduced the hour mod 12 *before* range-checking anything, so `"11:99 PM"` returned **1479** minutes-of-day against a legal max of 1439 (and `"25:00 AM"` returned 60); `shift_exceeds_24h` was **decorative** in the client path, which paid a 1,449-minute pair **$362.25 with the flag attached** while the backend copy skipped it — cron and Payroll page disagreeing on identical rows; and a full-datetime punch had its **date parsed then discarded**, so `2026-03-07 09:00 → 2026-03-09 10:00` (2,940 real minutes) read as `paid_minutes 60, total_pay 15, flags []`. Section 32. #53 closed the same day: **payroll paid people from a display rounding.** A punch pair is an integer number of minutes, but `hours` was rounded to 2 decimals *for a label* and the rate was multiplied by that label — so 2,243 minutes at $15.00/h paid $560.70 instead of $560.75, and 140 overtime minutes at $22.50/h paid $52.43 instead of $52.50. Systematic, always downward. The file that actually pays people (`runLocalAutoPayroll`) is **protected**, and was made correct **without being touched**: it recomputes pay from `hours` itself, so feeding it an exact quotient instead of a 2-dp one lands it on the right cent. Section 31. #49–#52 closed the same day from ONE screenshot of the Add User dialog with five stacked red toasts: the form validated as a chain of early returns and complained about input that only needed trimming (#49), promised a generated password it never generated while understating a 7-rule policy as 3 (#50), shipped a decorative "require password change" switch (#51), and — the reason the five were still on screen — **no toast this app had ever shown could be dismissed or could expire** (#52). Section 30. Problem #30 covered 12 suites that could not fail; **all 12 are closed.** **This tracker is not the owner’s 30-item review playbook.** They are two separate lists, and a closed tracker says nothing about the playbook. Per-item playbook verdicts: BRAIN_TROUBLESHOOTING.md section 23. |
| `npm run verify:all` — discovery | **112 discovered, list fingerprint `c1952cea`** (measured 2026-08-25 via `--list`). `probe-yield-advisor` was added 2026-08-25 for tracker #59, taking 111 → 112 and moving the id off `2f3a5c5a`. Discovery is by **filename prefix**, so a new `probe-*.mjs` joins the sweep with no registration — and **every shard boundary measured at `2f3a5c5a` is therefore invalid.** Four suites were added earlier the same day, taking 107 → 111: `probe-settings-persistence`, `probe-float-money`, `probe-pdf-pagination`, `probe-ledger-index` — each confirmed present in the `--list` output, so the delta is fully accounted for. Before them, `probe-timecard-shift-span` was added 2026-08-24 at list position 82, taking 106 → 107, and `probe-payroll-minute-rounding` the same day at position 56. Ten suites were added on 2026-08-24 in all: `probe-db-archive`, `probe-monthly-calendar`, `probe-sdk-analytics-off`, `probe-mtd-growth`, `probe-ci-node-version`, `probe-recurring-events`, `probe-toast-lifecycle`, `probe-user-form-validation`, `probe-payroll-minute-rounding`, then that one. The ids before them were `466f06d8` at 100, `26268ca8` at 101, `82bc3362` at 102, `d3091dab` at 103, `25ba9bcf` at 105, `781af269` at 106 and `28e9ea65` at 107. |
| `npm run verify:all` — full sweep | **Observed green at the current file set, 2026-08-25, fingerprint `c1952cea`: 112 suites, 109 PASS / 0 FAIL / 0 BROKEN / 0 TIMEOUT / 0 BAD-EXIT / 0 DIAGNOSTIC / 3 SKIP.** Run as 16 shards of 7 in a Linux sandbox; every shard printed the same `list c1952cea (112 discovered)`, so no slice straddled a list change, and 16×7 = 112 reconciles against discovery exactly. The 3 SKIPs are the environment ones in the row below (`probe-build-chunks` — `dist/` older than 4 of 287 inputs; `probe-config-exposure` — no dev server at localhost:5173; `verify-harness` — vite/`@rollup/rollup-linux-x64` absent in the VM), not failures — they are **Not Run**, so 109 is what was actually verified. `probe-audit-export` is the slow suite (~60 s under fake-indexeddb) but PASSED **76/0**; an early shard clipped it at 100 s and mislabelled it TIMEOUT, so it was re-run standalone (rc=0, 79 s then 59.8 s) and its shard re-run with `--timeout 200` before this line was written — the timeout was the harness budget, not the suite. The **previous** full sweep was 111 suites at `2f3a5c5a` (108 PASS / 3 SKIP, 20 shards) earlier the same day, before `probe-yield-advisor` moved the id 111 → 112; and 72 suites / 70 PASS / 2 SKIP on 2026-08-20 at `53aa539e`. **Do not sum shards across `53aa539e`, `2f3a5c5a` and `c1952cea`** — the list changed between each, so every slice boundary moved. That is precisely what the fingerprint exists to make visible; this is the first full sweep at `c1952cea`, and it closes the gap left when the `2f3a5c5a` shard boundaries were declared invalid. |
| Targeted slices at `c1952cea` (2026-08-25) | **Tracker #59, the Dashboard yield panel.** All Observed green: `probe-yield-advisor` **55/0** (rc=0 — and **RED first**: run against the unmodified `.jsx` files it reported **44 passed, 10 failed**, rc=1, with all ten failures being the source contracts, which is what makes the fix Observed rather than asserted) · `probe-mtd-growth` **58/0** · `probe-pdf-pagination` **50/0** · `probe-suite-integrity` **110 → 111/0** (it asserts one thing per discovered suite, so the new probe adds exactly one) · `probe-float-money` **28/0**, re-run because the change deletes a float-dollar expression (`money2(adr * 1.05)`) · `eslint .` **223 problems (0 errors)** and `tsc -p ./jsconfig.json` rc=0, both **identical** to #56/#57/#58 · discovery **111 → 112**, fingerprint **`2f3a5c5a` → `c1952cea`**. The slice set was chosen by grepping `scripts/` and the vitest files for `YieldAdvisor`, `yieldAdvice` and `pages/Dashboard.jsx`: **exactly three** suites name that set, and all three ran. Two traps are recorded in the probe itself. A source-contract assertion must be anchored on **structure**, not on a word: `/capacity/` PASSED against the very file it was meant to condemn, because the false caption read "Occupancy vs 100-room **capacity**" — it was replaced by regexes on `function YieldAdvisor({ … })` and on `buildYieldAdvice({ … capacity … roomsSold … })`. And `YieldAdvisor.jsx` has **no trailing newline**, so an `Edit` whose `old_string` ended `}\n` failed with "String to replace not found" while the visible text matched exactly (diagnosed with `tail -c 24 \| od -c`). BRAIN_TROUBLESHOOTING.md section 38. |
| Targeted slices at `2f3a5c5a` (2026-08-25) | All Observed green: `probe-settings-persistence` **117/0** (rc=0 — it was **80/0** at the previous commit; section 8 for tracker #55 added 37 assertions, and the file was **extended rather than added**, which is why discovery stays at 111 and the fingerprint stays `2f3a5c5a`) · `probe-float-money` **28/0** · `probe-suite-integrity` **110/0** · `probe-db-archive` **216/0**. Tracker #55 changes `src/lib/laborOptimization.js`, `src/lib/housekeepingConfig.js`, `src/pages/Housekeeping.jsx` and the dead `src/components/HousekeepingSettingsModal.jsx`. **Two** suites touch that set, not one: `probe-settings-persistence` imports the config module, and `probe-db-archive` asserts the storage key `rri_housekeeping_config_<propertyId>` is backed up — which is why the rewrite kept that key byte-identical. `probe-float-money` was re-run because the change removes a float-dollar expression; note it never *named* `Housekeeping.jsx`, because the old code had no `Math.round`/`toFixed`/`parseFloat` for its patterns to match. `laborOptimization.js` has exactly one product consumer (`Housekeeping.jsx:15`). **Tracker #56, same fingerprint:** `probe-manual-entry-save` **96/0** (rc=0 — the HEAD copy of the same file measures **37/0**, so section 9 contributes 59; extended, not added, so discovery stays 111) · `probe-db-archive` **216/0** with "storage writers classified: 21" **unchanged**, because its MANIFEST lost the `src/pages/ManualEntry.jsx` row and gained `src/lib/manualDraft.js` — that manifest is a two-way gate, and an entry naming a file that no longer writes storage fails it as `gone` · `probe-suite-integrity` **110/0** · two mutations caught (**87/9** and **95/1**) and both restorations `md5sum`-verified. `eslint .` reads **223 problems (0 errors)** rather than 224: the −1 was traced by mutation test to the unused `e` in the swallowing `catch` this change deleted, not to a warning being suppressed. **Tracker #57, same fingerprint:** `probe-delete-guard` **96/0** (rc=0 — **74/0** at the HEAD copy, so section 10 contributes 22; extended, not added) · one mutation restoring all three defects verbatim → **90/9 → 90 passed, 6 failed**, restoration `md5sum -c` OK · the five assertions that pin the **protected** `src/api/base44Client.js` and `src/lib/AuthContext.jsx` were mutation-tested in memory (regex applied to a copy with the defended line deleted) rather than on disk, because those files must not be written even transiently — all four content pins go false and the "exactly one `deleteAccount` branch" count fails when the branch text is broken · neighbours `probe-auth-hardening` **143/0**, `probe-ui-feedback` **83/0** (the other two suites that name `Settings.jsx`), `probe-db-archive` **216/0** with writers still 21 — the page never was a classified writer, because its two `removeItem` calls were cleanup, not persistence · `eslint .` **223 problems (0 errors)** and `tsc -p ./jsconfig.json` rc=0, both unchanged from #56. · **#58 (the citation gate)** touches no runtime code, so the slices exist to prove exactly that: `probe-calendar-day-modal` **30/0** · `probe-audit-write-failure` **60/0** · `probe-suite-integrity` **110/0** · `eslint .` **223 problems (0 errors)** · `tsc -p ./jsconfig.json` rc=0 — every one identical to #56, which is the whole claim. The gate was proved instead by refusing its own commit three times on three real out-of-range citations, then passing at 20 checked, plus a restore-verified two-case mutation (out-of-range caught on an added line; `no-cite-check` skips the line before it is counted). BRAIN_TROUBLESHOOTING.md section 37.7. |
| Targeted slices at `28e9ea65` (2026-08-24) | All Observed green: `probe-timecard-shift-span` **73/0** (rc=0) · `probe-payroll-minute-rounding` **61/0** (rc=0, measured with a redirect — `cmd \| tail` reports *tail's* status) · `verify-timecard` **47/0** · `src/lib/timecardCalc.test.js` **28/28** and `src/api/autoPayroll.test.js` **6/6** (vitest, `--pool=threads` — the default `forks` pool times out in a Linux VM and reports *no tests*). Carried forward from `25ba9bcf`: `probe-toast-lifecycle` **68/0** · `probe-user-form-validation` **95/0** · `src/components/ui/toast.test.jsx` **17/17**. From `d3091dab`: `probe-recurring-events` 107/0 · `verify-actioncenter` 39/0 · `probe-ci-node-version` 61/0 · `probe-mtd-growth` 58/0 · `probe-monthly-calendar` 67/0 · `probe-db-archive` 216/0 · `probe-sdk-analytics-off` 53/0 · `probe-hotel` 40/0 · `probe-money-kept-gross` 49/0 · `probe-money-kept-double-count` 65/0 · `probe-capacity-per-day` 68/0 · `probe-cents-unit-mismatch` 38/0 · `probe-calendar-day-modal` 30/0 · `verify-transactions` 115/0 · `--filter calendar` 2/2 · `verify-revenue` 50/0 · `verify-statistics` 84/0 · `probe-premium-surfaces` 131/0 · `probe-ui-feedback` 83/0. Section 31 changes `timecardCalc.js`, whose only consumers are `verify-timecard` and the two vitest files above — all three were re-run. Section 32 changes the same file plus `base44/functions/autoPayroll/entry.ts`; the same three suites plus the new probe were re-run, and `src/api/base44Client.js` (**protected, untouched**) inherits the fix through its `reconcileTimecards` import. |
| CI — "Security and Quality Assurance" | **32 consecutive non-successful runs, 2026-08-13 → 2026-08-24, all for one environment reason.** The job pinned Node 20; jsdom@30's transitive undici@8 throws at import there, so all 36 vitest files failed to START and **not one test had ever executed in CI**. Fixed: `package.json` now declares `engines.node`, the workflow pins `'24'`, and `probe-ci-node-version.mjs` keeps them in lockstep. Reproduced whole off-mount on Node 22.23.2: **all six steps exit 0, `npm test` 36 files / 291 tests / 0 failures.** BRAIN_TROUBLESHOOTING.md section 28. Dependabot's separate failures are legitimate major-bump breaks and should be closed, not merged. |
| `npm run lint` | 0 errors (warnings pre-existing) |
| `npm run typecheck` | 0 errors |
| Cannot run in a Linux VM (SKIP, = **Not Run**, not verified) | `verify-harness.mjs` — `import('vite')`, and `node_modules` here was installed on Windows, so Rollup's native binding is missing. `acceptance-harness.mjs` has the same dependency and is not even auto-discovered (its name matches neither `probe-*` nor `verify-*`). `probe-config-exposure.mjs` needs a dev server on `localhost:5173`. `probe-build-chunks.mjs` needs a fresh `dist/`, and self-skips when it is stale — on 2026-08-25 it reported `dist/ is older than 45 of its 285 inputs`. These are the 3 SKIPs in the full sweep above (`acceptance-harness` is the fourth file but is never discovered). Run all four on Windows or in CI. Note the order: a Windows `vite build` refreshes `dist/` on this OneDrive mount and makes later VM calls stall for minutes, so run it **last**. |
| **Deployed bundle is STALE** | `dist/index.html` dates from **2026-08-24 06:10**, and **44 of the 334 tracked build inputs** (`src`, `base44`, `backend`, `public`, `index.html`, `vite.config.js`, `package.json`) are newer than it — measured 2026-08-25. `probe-build-chunks.mjs` reaches the same verdict from its own input set (`dist/ is older than 45 of its 285 inputs`) and self-SKIPs rather than assert against a stale bundle. `vite build` **cannot** run in the Linux VM (`Cannot find module '@rollup/rollup-linux-x64-gnu'` — still true, and it is why `verify-harness.mjs` SKIPs), so everything committed after that timestamp is absent from the live Worker. The owner must build on Windows and redeploy before any live-site claim is made. Rebuild last in any batch: writing `dist/` onto this OneDrive mount makes subsequent repo operations stall for minutes. |
| YTD gross benchmark | RESOLVED 2026-08-20 — total $1,020,598.17 = room $1,011,258.67 + ancillary $9,339.50, measured by `probe-money-kept-gross.mjs`. BRAIN_FINANCE.md 12.6. Which occupancy field carries which figure: **12.8**. |

> [!NOTE]
> **Correction, 2026-08-20.** An earlier revision of this table listed 7 suites as
> timing out. That was a measurement error, not a defect: the runs had been given a
> reduced `--timeout` so a full pass would fit inside a 178s command cap. Six of the
> seven pass in 9-25s each (`probe-property-isolation` 76/0, `verify-anomaly-ingestion`

> 9/0, `verify-source-contributions` 12/0, `verify-statistics` 84/0,
> `verify-import-rollback` 11/11, `verify-coexistence` 23/0). The seventh,
> `probe-money-kept-fix.mjs`, was a genuine defect and is fixed — see tracker #36.
> The lesson is recorded as a rule in the suite-running section above, because the
> same shortcut will be tempting to the next reader.

> [!NOTE]
> **Second correction, same day: the count was 70, and it was 71.** The table above
> briefly read "70 suites, 68 PASS / 2 SKIP". 68 + 2 = 70, but `scripts/` held **71**
> suites. The missing one is `probe-audit-write-failure.mjs`, which was written at
> 11:39 *while* the 10-shard run was in progress — so the early shards partitioned 70
> names and the later ones partitioned 71, and the arithmetic was the only visible
> trace. It has since been run on its own: **60 passed, 0 failed**. Nothing was
> actually broken, but the run could not prove that, which is the same thing as not
> having run it.
>
> Two things changed so this is caught rather than inferred from a sum. `verify-all.mjs`
> now prints a `list <id> (<n> discovered)` fingerprint on every run, and the sharded
> summary tells the reader to confirm the ids match before adding shards up. Tracker #37.
>
> **BEST OUTCOME NOTE.** Check the arithmetic of a green report against the number of
> things that were supposed to run. Both of this file's wrong claims about the suite
> count survived a reading of every per-shard log and were caught only by addition.

> [!WARNING]
> **Never `git stash` on this mount.** It fails halfway and leaves a `.git/index.lock`
> that blocks every later git command. `git status` also over-reports modification on
> this OneDrive mount — verify with `git hash-object <path>` against
> `git rev-parse HEAD:<path>`. Check `PROTECTED_FILES.md` before editing anything.

> [!NOTE]
> **Audit remediation batch, 2026-08-26 → 2026-08-27.** An owner-directed sweep of the
> read-only audit problem-list landed, most-critical first, each fix root-caused
> upstream and pinned by a standalone probe in `scripts/`. Money-math (integer-cents
> per the BUSINESS directive): `Expenses.jsx`, `Payments.jsx` and `Payroll.jsx` re-did
> inline float `reduce` aggregation over persisted dollar fields — string amounts like
> `"1250.00"` silently collapsed operating expenses toward zero and IEEE-754 residue
> leaked into KPIs and reconciliation — all replaced with `sumCents`/`fromCents`/
> `subtract` from `decimal.js` (probes `probe-expenses-profit-cents`,
> `probe-payments-cent-aggregation`, `probe-payroll-cent-aggregation`).
> `ownerIntelligence.detectProfitLeakage` was already cent-exact and left intact.
> Property isolation: `reportParsers.importReport` now fails closed on a missing/blank
> `propertyId` before any row is written (empty id degraded `skipExisting` to a
> cross-property scan), and the dormant cloud `aiAssistant` function gained real
> server-side row scoping via the new Node-testable `base44/utils/aiScope.js`
> (`resolveAllowedIds` + `scopeSyntheticRows`), which the live local `aiEngine.js` path
> already enforced (probes `probe-import-property-guard`, `probe-aiassistant-scope`).
> Ingestion: CSV parsing was offloaded to the worker via `parseTextInWorker` with a
> single-source `MAX_IMPORT_BYTES` (10MB → 50MB, owner-chosen) threaded through
> `csvParser.js`, `reportParsers.js`, `uploadGuard.js` and `ManualEntry.jsx`; the
> timecard punch path now rejects non-ISO dates with `isIsoDate` (matching the ledger
> and flat-table paths); and `manualEntryImport.coerceCell` stopped silently truncating
> partial numbers like `"12abc"` (probes `probe-csv-worker-offload`,
> `probe-timecard-date-guard`, `probe-manual-entry-import`). Tax: the `Payments.jsx`
> "Tax Management" card was rebuilt on `CalculationService.calculateTaxLiability` — the
> same per-property, date-windowed engine Money Kept deducts from — replacing a
> divergent flat per-source model (probe `probe-payments-tax-liability`). Performance:
> the `TransactionLine` import dedupe read stopped materializing the whole property
> ledger, now issuing a date-windowed indexed lookup via `existingTxnDedupeKeys` with a
> full-scan fallback for non-ISO dates (probe `probe-dedupe-indexed-lookup`, regression
> gate built first). Dead code: `validator.js` shed the unused `isValidAmount`/
> `isValidIsoDate` exports (test-only importer updated). UI: `MtdGrowth.jsx` KPI cards
> gained a 3-state flat indicator and `Pricing.jsx` got its wired base-rate editor.
> Hygiene: the hidden lint warnings were unhidden and burned down 214 → 48 with 0
> errors — the residual 48 are 32 in PROTECTED files plus 16 `react-hooks/exhaustive-deps`
> left by standing instruction — via behaviour-neutral `_`-prefixing of genuinely-unused
> bindings (ESLint allows `/^_/`), which accounts for the many small 2–4 line diffs in
> this batch; and `graphify-out/` (399 tracked scratch files, already git-ignored) was
> untracked. Owner-decision items left open and surfaced, not blind-edited: reviving
> User/Session RLS (cloud backend retired), the accepted browser-trust boundary, the
> `--quiet` flag still on the `package.json` lint script, and root doc consolidation
> (the CLAUDE.md directive hierarchy references the root `*.md` files by path). Verified
> across the batch (Observed): `npm run typecheck` 0 errors, `eslint .` 0 errors,
> `npx vitest run` 42 files/333 tests, and the money/ingestion/isolation regression
> suites (`verify-transactions`, `verify-coexistence`, `verify-statistics`,
> `verify-anomaly-ingestion`, `probe-money-kept*`, `probe-float-money`,
> `probe-decimal-integration`) green.

PHASE 4.5: SECURITY VALIDATION (INSERT BEFORE LAUNCH)

Input: The complete codebase + the security checklist
Output: A JSON report with PASS/FAIL for each check

[Each check must have a TEST, not just code inspection]

Example structure:
{
  "checks": [
    {
      "id": "SECRETS_001",
      "name": "No hardcoded secrets in frontend",
      "status": "PASS",
      "evidence": "Scanned all .jsx/.tsx files, found 0 instances of STRIPE_KEY, OPENAI_KEY, etc.",
      "action_if_fail": "Move secrets to .env, add .env to .gitignore"
    },
    {
      "id": "RATE_LIMIT_001", 
      "name": "Auth endpoints have rate limiting",
      "status": "FAIL",
      "evidence": "Login route has no rate-limit middleware attached",
      "action_if_fail": "Add express-rate-limit to /api/auth/login, set to 5/15min per IP"
    }
  ],
  "pass_rate": "9/10",
  "blockers": ["RATE_LIMIT_001"], // Must fix before launch
  "warnings": [] // Nice to fix
}
