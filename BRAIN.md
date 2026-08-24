# RED ROOF INTELLIGENCE - MASTER BRAIN (HUB)

> [!IMPORTANT]
> **AI AGENTS:** You are currently in the HUB. To save tokens and maximize context window efficiency, this file only contains routing.
> Read the specific Spoke files below based on your exact task. NEVER scan the entire project.

## THE SPOKES (Context Segmentation)
| Domain | File | Use When... |
|--------|------|-------------|
| [FINANCE] | `docs/brain/BRAIN_FINANCE.md` | Math, formulas, CSV parsers, or reconciliation. |
| [SECURITY] | `docs/brain/BRAIN_SECURITY.md` | Auth, MFA, sessions, or audit logs. |
| [FRONTEND] | `docs/brain/BRAIN_FRONTEND.md` | React UI, pages, components, or hooks. |
| [BACKEND] | `docs/brain/BRAIN_BACKEND.md` | Base44 entities, serverless functions, configs. |
| [FIXES] | `docs/brain/BRAIN_TROUBLESHOOTING.md` | Diagnosing known problems or emergency playbook. |
| [INDEX] | `docs/brain/BRAIN_INDEX.md` | Verify file paths (422-file complete catalog). |
| [MAP] | `docs/brain/BRAIN_DEPENDENCIES.md`| See what breaks if you edit a file (Auto-Generated). |

## SYSTEM ARCHITECTURE
```mermaid
graph TD
    subgraph Browser [User's Browser]
        UI[React Frontend<br/>(36 Pages, 40+ Components)]
        DB_Local[(Local IndexedDB<br/>Offline Cache)]
        UI <--> DB_Local
    end
    subgraph Cloud [Base44 Cloud Server]
        API[19 Serverless Functions]
        DB_Cloud[(16 Database Entities)]
        API <--> DB_Cloud
    end
    subgraph External [Integrations]
        Drive[Google Drive Backups]
        Weather[OpenWeather API]
    end
    UI <-->|HTTPS / WSS| API
    API <-->|OAuth| Drive
    API <-->|REST| Weather
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
> `--timeout`.** The suites run serially and take 12-25 minutes at 70 files, longer at
> the current 100; the Linux
> sandbox agents use here kills any single command at ~178s. Lowering `--timeout` to
> fit does not shorten the run, it kills slow suites and labels them `TIMEOUT`. That
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
> before summing. Verified twice, on both file sets: 9 shards over 71 suites all printed
> `8c09a3eb` and 8 shards over 72 all printed `53aa539e`, each covering every file exactly
> once, and a trailing shard reports itself empty rather than green. (Counts are
> measurements with dates — the current one is in the table below, not here.)

> [!CAUTION]
> **A suite must exit non-zero when it fails.** `console.assert` prints and returns; it
> does not throw and does not set an exit code. On 2026-08-20 eleven suites were found
> that could not fail — some printed a defect and exited 0 for months. `verify-all.mjs`
> reports FAIL, BROKEN (could not start) and SKIP as three different outcomes for
> exactly this reason. Before trusting a repaired assertion, break the product on
> purpose and confirm the suite objects. See BRAIN_TROUBLESHOOTING.md section 22.

## CURRENT STATE (2026-08-24)

| Area | Status |
|------|--------|
| Known problems tracker | 53 filed, **53 fixed, 0 OPEN** — BRAIN_TROUBLESHOOTING.md section 14. #53 closed 2026-08-24: **payroll paid people from a display rounding.** A punch pair is an integer number of minutes, but `hours` was rounded to 2 decimals *for a label* and the rate was multiplied by that label — so 2,243 minutes at $15.00/h paid $560.70 instead of $560.75, and 140 overtime minutes at $22.50/h paid $52.43 instead of $52.50. Systematic, always downward. The file that actually pays people (`runLocalAutoPayroll`) is **protected**, and was made correct **without being touched**: it recomputes pay from `hours` itself, so feeding it an exact quotient instead of a 2-dp one lands it on the right cent. Section 31. #49–#52 closed the same day from ONE screenshot of the Add User dialog with five stacked red toasts: the form validated as a chain of early returns and complained about input that only needed trimming (#49), promised a generated password it never generated while understating a 7-rule policy as 3 (#50), shipped a decorative "require password change" switch (#51), and — the reason the five were still on screen — **no toast this app had ever shown could be dismissed or could expire** (#52). Section 30. Problem #30 covered 12 suites that could not fail; **all 12 are closed.** **This tracker is not the owner’s 30-item review playbook.** They are two separate lists, and a closed tracker says nothing about the playbook. Per-item playbook verdicts: BRAIN_TROUBLESHOOTING.md section 23. |
| `npm run verify:all` — discovery | **106 discovered, list fingerprint `781af269`** (measured 2026-08-24 via `--list`). `probe-payroll-minute-rounding` was added that day at list position 56. Nine suites were added on 2026-08-24 in all: `probe-db-archive`, `probe-monthly-calendar`, `probe-sdk-analytics-off`, `probe-mtd-growth`, `probe-ci-node-version`, `probe-recurring-events`, `probe-toast-lifecycle`, `probe-user-form-validation`, then this one. The ids before them were `466f06d8` at 100, `26268ca8` at 101, `82bc3362` at 102, `d3091dab` at 103 and `25ba9bcf` at 105. |
| `npm run verify:all` — full sweep | **Not Run at the current file set.** The last complete green run was **72 suites, 70 PASS / 0 FAIL / 0 BROKEN / 0 TIMEOUT / 0 BAD-EXIT / 2 SKIP** on 2026-08-20 at fingerprint `53aa539e`, from an 8-shard run whose per-shard logs were each read and which all printed the same id. **Do not sum shards across `53aa539e`, `466f06d8`, `26268ca8`, `82bc3362`, `d3091dab`, `25ba9bcf` and `781af269`** — the list has changed six times, so every slice boundary moved. That is precisely what the fingerprint exists to make visible. A full sweep at `781af269` needs a Windows run. |
| Targeted slices at `781af269` (2026-08-24) | All Observed green: `probe-payroll-minute-rounding` **61/0** (rc=0, measured with a redirect — `cmd \| tail` reports *tail's* status) · `verify-timecard` **47/0** · `src/lib/timecardCalc.test.js` **21/21** and `src/api/autoPayroll.test.js` **6/6** (vitest). Carried forward from `25ba9bcf`: `probe-toast-lifecycle` **68/0** · `probe-user-form-validation` **95/0** · `src/components/ui/toast.test.jsx` **17/17**. From `d3091dab`: `probe-recurring-events` 107/0 · `verify-actioncenter` 39/0 · `probe-ci-node-version` 61/0 · `probe-mtd-growth` 58/0 · `probe-monthly-calendar` 67/0 · `probe-db-archive` 216/0 · `probe-sdk-analytics-off` 53/0 · `probe-hotel` 40/0 · `probe-money-kept-gross` 49/0 · `probe-money-kept-double-count` 65/0 · `probe-capacity-per-day` 68/0 · `probe-cents-unit-mismatch` 38/0 · `probe-calendar-day-modal` 30/0 · `verify-transactions` 115/0 · `--filter calendar` 2/2 · `verify-revenue` 50/0 · `verify-statistics` 84/0 · `probe-premium-surfaces` 131/0 · `probe-ui-feedback` 83/0. Section 31 changes `timecardCalc.js`, whose only consumers are `verify-timecard` and the two vitest files above — all three were re-run. |
| CI — "Security and Quality Assurance" | **32 consecutive non-successful runs, 2026-08-13 → 2026-08-24, all for one environment reason.** The job pinned Node 20; jsdom@30's transitive undici@8 throws at import there, so all 36 vitest files failed to START and **not one test had ever executed in CI**. Fixed: `package.json` now declares `engines.node`, the workflow pins `'24'`, and `probe-ci-node-version.mjs` keeps them in lockstep. Reproduced whole off-mount on Node 22.23.2: **all six steps exit 0, `npm test` 36 files / 291 tests / 0 failures.** BRAIN_TROUBLESHOOTING.md section 28. Dependabot's separate failures are legitimate major-bump breaks and should be closed, not merged. |
| `npm run lint` | 0 errors (warnings pre-existing) |
| `npm run typecheck` | 0 errors |
| Cannot run in a Linux VM (SKIP, = **Not Run**, not verified) | `verify-harness.mjs` — `import('vite')`, and `node_modules` here was installed on Windows, so Rollup's native binding is missing. `acceptance-harness.mjs` has the same dependency and is not even auto-discovered (its name matches neither `probe-*` nor `verify-*`). `probe-config-exposure.mjs` needs a dev server on `localhost:5173`. Run all three on Windows or in CI. |
| **Deployed bundle is STALE** | `dist/index.html` dates from 2026-08-23 21:16 and at least 12 tracked files are newer. `vite build` **cannot** run in the Linux VM (`Cannot find module '@rollup/rollup-linux-x64-gnu'`), so the live Worker does not contain tracker **#41–#47**. The owner must build on Windows and redeploy before any live-site claim is made. |
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