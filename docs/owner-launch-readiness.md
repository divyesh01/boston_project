# Owner Launch Readiness Runbook (Release 2026-10-03)

> **Status:** `DRAFT` — **No claim of release readiness** until all final gates pass and the owner completes manual authenticated browser acceptance.

---

## 1. Verified Behavioral Repairs & Architectural Contracts

This release consolidates core financial, operational, worker aggregate, and frontend engine repairs:

### A. Financial Integrity & Uncertainty Propagation
- **Money Kept Uncertainty Propagation:** When tax jurisdictions lack configured rates or occupied room nights are missing, tax calculations fail closed with `incomplete: true`. Downstream, `Money Kept` explicitly qualifies the headline and line items as `(Partial Estimate)`, never misrepresenting partial numbers as complete net profit.
- **Deduction & Tax Preservation:** Known deductions (OTA commissions, credit card fees, operating expenses, and known percentage taxes) are strictly preserved using exact integer-cents arithmetic (`toCents`/`fromCents`); known financial totals continue using exact integer cents.
- **Pass-Through Tax Truth:** Pass-through taxes collected on behalf of municipalities remain deductions from gross revenue and are never inflated as owner's kept funds.
- **Simplified Line Item Qualification:** Tax line items are qualified once (`Business Taxes (partial estimate)` or `Business Taxes (incomplete · unknown)`), avoiding duplicate qualification tags and redundant inline badges.
- **Loss Warning:** The deductions-exceed-gross message appears only when money kept is negative. Empty and break-even periods do not display a loss warning; the underlying financial totals are unchanged.
- **Owner Performance Packet Export:** XLSX exports reflect identical data provenance; Executive Summary and Sheet 5 explicitly stamp `PARTIAL / TAX INCOMPLETE` warnings when partial analytical periods are selected.

- **Rooms per Reporting Night:** Dashboard's Occupancy subline uses unique reporting dates across the selected properties. For two properties with 40 and 35 rooms sold on the same date, it shows Avg 75 rooms/night. This display correction preserves the financial totals and filters; browser acceptance of the newly corrected label remains separate.

### B. Operational Scope & Ledger Isolation
- **RoomBoard Independent Querying:** Room stays and housekeeping tasks query strictly against `boardDate`. Multi-day stays overlapping `boardDate` (checked in prior, checking out after) are fully preserved. Loading states gate rendering to prevent false vacant room indicators.
- **Active Property Filtering:** Global filters (`useGlobalFilters`) filter out inactive properties (`p.active !== false`) across dashboards, property pickers, and comparisons, while keeping Settings unfiltered for property management.
- **Empty Property Selection:** Local Payroll, Expenses and Forecasting queries return no rows when no properties are selected. accepted scoped evidence is zero-active normal-auth rendering only: 26 checks that Payroll/Expenses/Forecast render empty selection (coordinator evidence at `independent-browser-zero-active/zero-active-ui-proof.json`). No mutation or all-controls claim is made.
- **Zero-Selection Guard:** Portfolio view passes an explicit array of active property IDs (`activePortfolioIds`), never the unscoped `"all"` sentinel, preventing inactive property data leakage.
- **Fail-Closed Portfolio Aggregates:** Daily financial aggregate cache (`useDailyFinancialAggregates`) is restricted to single properties (`typeof propertyId === 'string' && propertyId !== 'all'`). Multi-property or portfolio requests safely bypass cached aggregates and compute from raw authoritative ledgers to prevent partial cache totals.
- **Worker Aggregate Availability:** When both supported aggregate tables are absent or empty, the aggregate read returns an explicit unavailable result with empty summaries. The client uses raw ledgers unless it has nonempty, complete, current summaries for the selected property. Unexpected storage errors remain errors.

### C. Frontend Engine & Security Hardening
- **Tailwind CSS v4 & LightningCSS:** Updated to `tailwindcss@4.3.3` with `@tailwindcss/postcss@4.3.3`. The installed candidate passed 68 compatibility checks in headless Chromium. Focus PNGs for the covered fixtures were byte-identical (1719B); raw shadow strings differ because v4 adds transparent layers. This evidence does not establish parity for every page or browser.
- **PDF Export:** The pinned `html2canvas-pro@2.5.0` renderer resolves the observed unsupported `oklab` failure. Normal synthetic downloads parse and render populated pages. Numeric figures now disable ellipsis only in the export clone; known populated figures pass independent page-one pixel review. Current accepted scoped PDF review (replacing the older current "8-only" gate statement; dated historical 8-page records are preserved as historical): original 8 (`exports/pdf-clone-repaired-proof.json`) plus larger 9 (`exports/larger-pdf-pixel-proof.json`) under coordinator evidence `page-fixture/schema-seven` — all 17 pages independent glyph/layout review with the known $1,234,567.89 figure with warnings; this is not an all-financial-math PASS. This is not production acceptance.
- **Dependency Security Clean:** Upgraded `dompurify` to `3.4.16` (deduplicated across dependencies including `jspdf`). Vulnerable braces dependency removed from the dependency tree. `npm run audit:gate` passes with 0 advisories (`ACCEPTED = {}` unchanged).

---

## 2. Standard Automated Verification Commands

Run these exact commands to verify system integrity:

```bash
# 1. DIVYESH V3 Canonical Governance Check
npm run verify:v3

# 2. Dependency Security Audit Gate (0 high / 0 critical)
npm run audit:gate

# 3. Financial Completeness & Uncertainty Propagation Probe (48 asserts)
node --import ./scripts/_loader-boot.mjs scripts/probe-money-kept-tax-completeness.mjs

# 4. Operational RoomBoard & Global Filters Probe (22 asserts)
node --import ./scripts/_loader-boot.mjs scripts/probe-roomboard-filters-aggregates.mjs

# 5. Worker Aggregate Availability & Storage Probe (11 scenario groups with nested assertions)
node --import ./scripts/_loader-boot.mjs scripts/probe-worker-aggregate-availability.mjs

# 6. Core Financial & Model Unit Suites
npx vitest run src/lib/moneyKeptModel.test.js src/lib/taxLiability.test.js
```

---

## 3. Owner Configuration & Truth Contracts

Before reviewing live numbers in the web application, ensure property configurations are reviewed:

1. **Property tax configuration (`/settings`):**
   - Verify each property has active tax rules for State, City/Local, and Flat fees with effective start dates.
   - For flat-per-night fees, occupied room night data must be present; otherwise, calculations mark taxes as `partial estimate`.
2. **Channel Commission Rates (`/channel-manager`):**
   - Confirm OTA commission percentages and credit card processing fee rates match actual merchant processor agreements.
3. **Property roster (`/settings`):**
   - Ensure inactive properties are marked `Active: false`. Inactive properties are omitted from dashboard summaries and portfolio aggregates.

---

**Local snapshots and recovery (/settings):** With server data sync active, Download local snapshot saves only data currently loaded in this browser; it is not a complete server backup. Local file restore is disabled in that mode. Do not use a browser snapshot as evidence of server recovery. Local-only mode retains its backup and confirmed replacement workflow.

## 4. Actionable Browser Operational Steps

### Flow 1: Import and review HotelKey data
1. Open **Import** (`/upload`) and select the intended property.
2. Upload a supported HotelKey report, such as Hotel Statistics or Source Summary.
3. Review validation results and any overlap or replacement warning before confirming an import.
4. Review the import result and resolve reported errors before relying on the dashboard totals.

### Flow 2: Review room activity
1. Open **Room Board** (`/rooms`) and select the property and board date.
2. Wait for loading to finish before interpreting vacancy.
3. Check overnight stays against the selected date and review the displayed housekeeping statuses.

### Flow 3: Review financial estimates
1. Open **Dashboard** (`/`, with `/dashboard` as an alias) and select the property and reporting period.
2. Review Estimated Money Kept and its deduction breakdown.
3. When tax configuration or room-night evidence is incomplete, retain the partial or unknown qualification and resolve the missing inputs before treating the estimate as complete.

### Flow 4: Review payroll
1. Open **Payroll** (`/payroll`).
2. Reconcile the recorded payroll for the reporting period before relying on payroll deductions in the financial review.

### Flow 5: Export the owner packet
1. On Dashboard, select the intended property and reporting period.
2. Click **Export Owner Packet (.xlsx)**.
3. Open the workbook and compare its Executive Summary with the dashboard for the same selection.
4. Review the data provenance and completeness notices. Incomplete tax evidence must remain qualified in the export.

---

## 5. Deployment, Database & Migration Status

### Live Production Context (Root Sealed Metadata)
- **Production Base Git Commit:** `b3a8aa421e2ab8bec3d03cb440e2a44ea12cd077`
- **Current Active Deployment Version (100% Traffic):** `d11352f9`
- **Known Rollback Deployment Target:** `2fbd2cd4` (source commit: `b1512a23ad39024c930f9e3a6f03618b157946b7`)
- *Notice:* Full deployment version hashes are managed externally by the release controller; do not run deployment commands with truncated IDs.

### Database D1 Ledger Status
- **Active Production Ledger:** Migrations `0001` through `0007` are currently active.
- **Pending Migrations:** Migrations `0008` and `0009` are pending owner approval (separate from authenticated owner UI acceptance) and absent from the production migration ledger.
- **Live DDL Warning:** **NO LIVE DDL HAS RUN.** Migrations `0008` and `0009` require explicit written owner approval prior to execution; the current status is `DRAFT` and not ready until final gates pass and owner acceptance is completed.
- **Additive Schema Rollback Invariant:** If code or traffic rollback is initiated, additive DB schemas remain forward-compatible. Rolling back code/traffic reverts Worker routes and UI assets, but does NOT drop tables or user data. Database migration operations remain separate manual actions.

### Authentication & Acceptance Gate Boundary
- **Public Credential-Free Routes:** Public edge routes and 401 unauthenticated challenge probes pass root verification.
- **Authenticated Owner Routes:** End-to-end authenticated owner browser routes remain **UNPROVEN** in production until the owner performs live authenticated manual sign-in and acceptance.

---

## 6. Forthcoming Release Matrix
Repair verification matrix, updated 2026-10-04 (individual historical scopes retained):

| Gate | Result | Scope |
| --- | --- | --- |
| Standard Vitest | 100 files, 846 tests PASS at clean base `a273191be59ce78ac85f63d588c5d0b6466e5f94` | Historical provenance; type/lint/build/governance/remote all SUCCESS at that base |
| Weather full suite (root, actual) | 101 files, 852 PASS, 87.23s, run before type-only mocks | Actual status; retained type-corrected 6 PASS |
| Lint (Weather source/test) | PASS | Actual status |
| Typecheck (typed-mock fix) | PASS | Repository command after the typing-only correction |
| Production build | PASS, 21.07s | Current Weather source |
| Brain / map / V3 (post-Weather) | PASS | Brain exit 0; map 10 areas, 29 rows, 39 contracts, 194 references, 0 problems; V3 31 files and 6 adapters verified |
| Dependency audit | PASS: zero advisories | No accepted exceptions added |
| Financial / operations / aggregate / authorization probes | PASS in documented scopes | Synthetic fixtures and actual handlers; not production owner acceptance |
| Normal PDF / workbook | Scoped PASS as recorded | Accepted scoped review: 17 pages (original 8 + larger 9) glyph/layout with known $1,234,567.89 with warnings — not all-financial-math PASS; workbook reconciles 2,452,500 cents with completeness warnings |
| Route body coverage | 36 recorded PASS | Local synthetic normal-auth fixtures; historical public render and expected redirects distinguished |
| Primary browser actions | Scoped receipts PASS; full-matrix reconciliation PENDING | No aggregate math claimed beyond scoped receipts below; old R2 import failure is historical, superseded by R20 |
| Production owner acceptance | NOT_RUN | No production authenticated owner acceptance claimed |

The candidate is not an owner-ready declaration. Accepted scoped receipts: R20 import normal fix (3 rows Jan 1–3, 40000+30000+30000c=100000c with import and reload hydrate); Clerk 25-check resolution persists with same immutable amount and other-property 6 records unchanged; Staff R1 and Payroll R3 root-accepted normal-API full-record and cents proofs only; R30 Dashboard filters (single-A 1312500c / B 1140000c / All 2452500c / date-included 2452500c / date-excluded 0 with ten native snapshots unchanged); zero-active 26-check scoped rendering; 17-page scoped PDF review. Current action-matrix reconciliation remains pending. Older dated snapshots below are preserved as history. Production owner acceptance remains NOT_RUN. Production unchanged. Migrations 0008/0009 approval remaining unchanged.

## October 4 production metadata refresh

Read-only release-controller evidence records active version **308**,
2d2b18a4-a31f-465e-b43c-4916ee571c8a, at 100% traffic, created
2026-10-04T05:39:40Z. This activation was external to this repair task. Its
source commit remains **UNPROVEN**; neither the preceding UX release commit
nor this task's repair commits are asserted to be its deployed source.

The observed runtime uses ENABLE_BUSINESS_SYNC_API=true,
ENABLE_D1_DATA_API=false, and S3_ENABLED=true. S3/GCS secret names and
bindings were present; no native R2 bucket binding was present. The local
native-R2 upload failure establishes a portability defect in that storage
branch and does not prove a failure in production's preferred S3 branch.
At this metadata refresh (evidence E099), the isolated streaming candidate had not been accepted or deployed. The native repair described below has since been accepted and applied to the repair branch; it has not been deployed by this task.

The earlier October 4 browser snapshot recorded **7 PASS, 1 FAIL, 99 NOT_RUN**
primary actions. Selected-property Remove and zero-active-property supplements
remain scoped checks, not blanket coverage of every action. Authenticated
production owner acceptance remains **NOT_RUN**.
## Native R2 upload repair candidate

The native R2 path has been repaired with known-length streaming; the preferred
S3 path retains its existing 50 MiB bounded-stream contract. Native requests
without Content-Length return 411. The recorded normal browser request reached
the local Worker with Content-Length 184, so an explicit client size header was
not added. The local native regression has twelve passing groups, including
checksum, consumed limits, mismatch/abort and invalid-object absence checks.
The existing S3 adapter probe has 287 passing synthetic checks; cloud storage
credentials/access and authenticated production owner acceptance remain unproven.

Replay of the same normal Upload flow on this applied source is pending. The
historical import failure is retained until that actual browser replay completes.
The portable local-only fixture is documented in tests/fixtures/native-r2/README.md;
its mock scope/database is not authentication acceptance.

## 2026-10-04 — Deep Verification 411 incident: fixture correction and candidate verification note (append-only)

Root commit `2cbeaf97eb17f8b2056f0556f7180faac3905aca` repaired native R2
known-length streaming; the preferred S3 path is unchanged. Node synthetic
valid raw-upload Requests omitted wire Content-Length and Node had no native
FixedLengthStream, so 15 Deep Verification suites failed via 411 with
downstream missing archive/manifest cascades. Scripts were corrected to use
valid UTF8 actual encoded byte lengths only and install a scoped,
byte-enforcing, test-only fixture. Intentional no-length 411s,
malformed/oversize headers, and the original status/hash/scope/isolation/
idempotency/concurrency assertions remain. No production stream fallback was
added and the consuming R2 testkit put was not changed.

Baseline evidence (Observed): all 15 affected probes run 266 checks PASS. The
four affected verify:all shards 2/12, 3/12, 7/12, 8/12 exit 0 — 17PASS1SKIP,
17PASS1SKIP, 18PASS0SKIP, 18PASS0SKIP — i.e. 70 suites PASS and 2 SKIP (the
two skips are the absent local dist/build-chunk check and the absent
localhost5173 config-exposure check; this is not 72PASS). Discovered list 209,
list hash 2c9c1972. A canary `new URL(...).pathname` statement tripped the
unchanged repo-root static checker; local URL extraction was split into two
statements and canary182, repo-root28, and shard8 checks PASS. A shared
helper was guarded against invalid non-byte chunks, but only after a fresh
independent read-only review; keep that follow-up status separate until the
actual final MAIN shards complete (MAIN scripts are being copied by the sole
writer; the FINAL MAIN four shards have not yet been run). The prior
100files846 local unit pass is historical, not a current broad claim. Import
replay and Clerk product refinements remain pending in independent lanes.
Production was not changed by this task; authenticated production owner
acceptance is NOT_RUN and no owner-ready declaration is made. The baseline
source SHA above is a provenance coordinate, not deployed production source.

Packet fixture correction (companion file `scripts/_worker-testkit.mjs`):
a minimal guard now rejects invalid non-byte chunks — strings, plain
objects, Blobs, or any chunk without a finite non-negative `byteLength` —
with `INVALID_STREAM_CHUNK` before any enqueue; valid ArrayBuffer and
typed-byte views pass through unconverted. Exact byte counting, oversize
rejection before enqueue, underrun flush rejection, closure state, and the
scoped wrapper save/restore (existing native global never overwritten) are
unchanged. Targeted Node guard proof passed 32 checks including forged byteLength rejection, exact UTF8 bytes, binary views, overrun/underrun, and global restoration.

#### Clerk Audit acceptance and retained regression

The Clerk Audit correction preserves approvals and resolution notes after reload, derives approval status from the current persisted records, and holds the signing lock until record refresh completes. The independent helper probe passed 11 cases. The actual-component probe passed eight steps while an await-stripped control failed after the same first five steps at the expected Signing lock assertion. Run the retained probes from the repository root with `node scripts/probe-clerk-persistence-helper.mjs` and `node scripts/probe-clerk-signoff-refetch.mjs`; both load the actual production source. Public-hook/sign-off mocks in the component probe are unit seams, not authentication or database proof.

A separate normal local Auth/server-sync browser replay passed 25 strict checks on the frozen candidate, including reload persistence, unchanged original amount/property/date/record identity fields, and six byte-identical captured raw records for the other property. The invalid HTTP-query delay attempt is preserved as failed harness evidence: this runtime refreshes Clerk records through a local query promise. Fresh review raised preexisting or unproven partial-write, malformed-record, and scope-change questions; none demonstrated an introduced critical or high defect in this patch. These results do not establish production deployment or complete owner acceptance.


## Current Weather status (2026-10-04, scoped)

In server-auth deployments (`import.meta.env.VITE_USE_SERVER_AUTH === "true"`), `WeatherPanel` omits the unsupported legacy live-weather connector. It still displays fresh cached weather; when the cache is empty, it displays the existing unavailable message. With the flag `false` or undefined, the prior legacy connector behavior is kept. No auth, role, worker-route, or provider configuration was changed. Applied source `1E354DA0B9C4088663428D9E5B5DC3A4C505C6DAFE4D597A1C9E39BCDC34492D`. Live provider and key configuration remain UNPROVEN.

Scoped evidence only: six retained actual component/service regression checks pass; seventeen actual query checks pass; the guard-removed control with the same empty cache is required to fail. Normal-auth browser replay R3 passed thirteen strict checks: single-A selection held with header and $13,125 for 3608 ms, reload shows unavailable, zero `getWeather` calls, ten native business snapshots identical, weather persist zero. Fresh-plan critique raised no HIGH/CRITICAL items. The existing DTO `feels_like` drop is separate existing behavior, follow-up only. Coordinator evidence basenames (artifacts under `rri-launch-20261003/readonly-ui-controls-20261004`, actual-result json inside `weather-capability-repair-r1`): `weather-panel-browser-r3-result.json`, `retained-r2-actual-results.json`. These are coordinator artifacts, not owner-portable deliverables.


# Final Validation Note — 2026-10-04
Production unchanged; owner acceptance NOT_RUN; no owner-ready claim.

- Current committed base: a273191be59ce78ac85f63d588c5d0b6466e5f94; Weather source and regression follow-up pending commit.
- Root: historical base `a273191` 100 files, 846 tests PASS with type/lint/build/governance/remote SUCCESS. Weather full suite (root, actual): 101 files, 852 PASS, 87.23s, run before type-only mocks. Retained type-corrected 6 PASS. Lint PASS on Weather source/test. Typecheck PASS after typed mock correction; production build PASS, 21.07s. Final brain/map/V3 governance checks PASS: brain exit 0; map 10 areas, 29 rows, 39 contracts, 194 references, 0 problems; V3 31 files and 6 adapters verified with SHA256 8998c0c8b7363198bd601111a088dee96b526583b5fdbc47b6e9a0f7212ce003. Refreshed typecheck and lint both exit 0.
- Native: 15 probes, 266 checks PASS after scoped fix; helper guard 32 PASS; no native/S3 production fallback.
- Portable Clerk helper 11 PASS; component actual 8 PASS / expected-mutant lock reject-after-5 PASS via verify-all runner.
- Only the component probe forks isolated dev React (helper does not) under production parent; PASSED after assertions; no weakening.
- Manifest helper 13 PASS via --only runner.
- syncBulkBundles post-alias hydration PASS 1 ($12000/$7000, no uploads); R20 alias UI/native Jan1-3 proof preserved.
- Retained 13-case probe exercises the actual helper strict canonical/server-published/typed-alias/foreign/wrong-type/malformed, NOT standalone service integration. Cloned alias-service probe withdrawn; do not promote copy.
- Caller review: false-guard throw before download/commit, static-only.
- CURRENT 212/99cc2842 shard3 17PASS 1SKIP, no 5173, exit 0. MAIN 211/c3388821 shard2 17PASS 1SKIP stale-dist, 7/8 18PASS each; after-build 11PASS recovers stale-dist. Baseline 2cbe 209/2c9c1972 4-shard 70PASS 2SKIP historical. Do not sum or claim all-212 PASS; remote all-12 Deep Verification shards and aggregate gate SUCCESS at a273191; this does not convert skipped checks to PASS.
- Clerk NODE_ENV act error + NO_VERDICT failures resolved harness-only; keep failure evidence. Filter/Chart recovery ongoing; weather scoped checks pass per Current Weather status, live provider/key UNPROVEN.
- Supersedes only prior MAIN-shards-not-run / pending-Clerk / probe-being-added phrases; preserves historical source/unit/production facts.
## R80 readiness update (ModuleCards universal manual copy)

- Universal manual tile (see BRAIN_FRONTEND.md); current Cloudflare Worker
  verified fetch-only / zero cron; legacy provider config UNPROVEN.
- Confirmed HIGH normal-UI twins: OWN001/2 total 27700, expected 55400.
  Owner-AUTHORIZED narrow protected fix E139 is an OWN candidate under
  review/tests; MAIN not fixed yet.
- Single-person manual R1 normal native 27700 repeat/reload ROOT PASS.
  Broad owner production/function acceptance NOT_RUN. 6b72 remote 2 CI
  all SUCCESS.


## Payroll identity update — 2026-10-07

Payroll identity verification now covers duplicate employee names, stable and typed IDs, ambiguous historical records, raw timecard ID provenance, numeric zero, mixed helper groups, and staff without a pay rate. The final candidate passed 49 function/helper checks and 24 API/localDb regression tests. Normal authenticated browser use created two same-name staff members and paid each $277; repeating and reloading preserved exactly two runs and all unrelated native records.

A separate concurrency diagnostic found duplicate runs when two function calls overlap. Its synthetic seam reproduced four runs/$1,108 versus the sequential two runs/$554. A subsequent normal-login test with two independent browser contexts confirmed the duplication, as detailed below; authoritative atomic creation remains unresolved. Do not treat the identity fix or these test results as an owner-ready production release; production migration, authenticated runtime acceptance, and resolution of confirmed release blockers still apply.


## Statistics validation update — 2026-10-07

Statistics candidate validation: actual Vite-loaded exports passed 41/41 checks and the unmodified baseline failed all five financial negative controls. The durable `src/lib/statisticsAnalytics.test.js` imports the actual production module; the equivalent isolated candidate import passed 41/41 Vitest regressions. Typed IDs (including numeric zero), per-property aliases, last-row duplicates, date/period separation, cent arithmetic, legacy missing-ID compatibility, incomplete selections and missing prior-year values were covered.

A fresh synthetic local runtime authenticated through the existing public login and served sealed candidate bytes at the original analytics, Statistics and MetricExplorer module IDs. The browser passed 12/12 additional checks: individual A $105, B $307 and portfolio $412; detail table taxable $400/exempt $12; MTD current $500 versus prior $400 with +25.0%; incomplete-date cards/table/revenue lines unavailable and zero revenue bars; single-property partial-date $120; complete-date restoration; zero UI writes. All 24 full business records across 11 entities remained identical during UI interactions. Native D1 reads also proved the original four HotelMetric records unchanged through the original A/B/All control phase. Ten further synthetic MTD/prior/partial-date rows were setup records, separated from UI writes.

Evidence limitations: this is the scoped Statistics regression gate, rather than a claim that all project functions or production owner flows passed. The narrow old control's September date-exclusion case remained explicitly NOT_RUN; no acceptance claim relies on it. Production was not modified or deployed by this lane. Owner acceptance and the root release gates remain separate.

External review: exact `gemini-3.8-flash-high --effort high` completed a fresh financial attack (conversation `af2da5ba-3383-4b21-9755-67c55ddd48d7`) and a source-backed critique (`a20cdc98-7d76-4e40-9b84-41efe50880a2`). The attack's two claims were refuted by the dated snapshot contract and actual per-property helper/test evidence. The critique retracted the single-property/partial-exempt assumptions and returned NO CONFIRMED HIGH FINDING. Three earlier bounded implementation/test-authoring Gemini requests returned empty after 90-second limits. OpenCode model discovery was refreshed; Nemotron Ultra returned 503 overload, Mimo2.6 Flash nonce passed, its write-capable test packet stalled without changes and was terminated, and its no-tools retry exhausted output length without any answer. The lead's explicitly authorized stubborn financial corrections and mechanical accepted-oracle-to-Vitest conversion produced the final artifacts. No model was silently substituted inside Antigravity.

Post-integration type annotations declare optional expected property identities, the optional incomplete result marker and the regression oracle tuple type. Current analytics byte hash `6c4bd02e66547b389a0543f25ca27dc726e73472a3ed2bcb7c8e4a465b7aa612` differs from browser-tested `22e43f14cd5a806501224046a238cb8f6d490d72062933d5bdde1872080fdd24` solely in JSDoc comments. Babel-parsed executable AST equality was verified for both analytics and test files (`STATISTICS_COMMENT_ONLY_GATE_PASS`); current exact bytes again passed 41/41 actual-module checks and 41/41 Vitest tests. The earlier browser receipt remains attached to its original byte hash, with this explicit executable-equivalence proof; no new browser execution is claimed.


## Chart Builder workflow evidence — 2026-10-07

Normal synthetic owner login completed the actual Excel download, Count CSV download, and Bar-to-Line-to-Bar interactions on the current Chart Builder source. The actual workbook parsed to property totals of 1312500 and 1140000 cents (2452500 cents overall); the actual count export contained one source row for each property. Ten full business records stayed unchanged in every phase and no entity mutation requests occurred. The parent binary/native-record oracle passed and deliberately forged one-cent workbook evidence was rejected. These scoped results preserve separate earlier SUM CSV evidence; property-filter acceptance and the remaining functions are still separate checks. No Chart source was modified and production was unchanged.


### Confirmed concurrent payroll release blocker — 2026-10-07

A fresh normal-login local test with two independent browser contexts reproduced four generated payroll records totaling 110800 cents for two employees who should receive two records totaling 55400 cents. Each employee ID appeared twice. Independent native reads from both contexts matched; Staff and the existing paid payroll record for the other property were unchanged. This confirms the earlier function-seam race in the actual runtime; the single shared-context attempt that did not duplicate payments does not establish concurrency safety. The employee-identity correction remains verified, while authoritative atomic creation across clients is a separate unresolved release blocker. No concurrency correction or production change is included in this batch.

## Payments workflow evidence — 2026-10-07

Normal owner UI checks passed for the payment tender breakdown, the downloaded reconciliation CSV, and read-only tax inspection using isolated synthetic data. The actual 354-byte CSV reconciles to 2,452,500 cents total, 2,402,425 cents card, and 50,075 cents cash, and correctly identifies unavailable bank and merchant evidence. The selected property's imported tax liability, tax configuration modal, and marketplace remittance details matched the native records; all ten full business records remained unchanged, with zero mutation requests after the baseline. A trusted pull gesture triggered an actual Payments query fetch and advanced its data timestamp. Tax configuration Save, remittance Store, and the complete compound pull-to-refresh/query-invalidation action remain untested; these receipts do not establish production readiness.

## Integrated verification, first sweep — 2026-10-07

Current source passed typecheck, lint, the production build, Brain, project-map and V3 verification. All 913 tests across 103 files passed; a separate default-config receipt confirms all 41 Statistics and 24 payroll tests on the integrated files. The full 212-suite verification sweep returned 195 PASS, one FAIL and 16 SKIP, including one partial PASS. The AI-context probe's post-edit check returned status 2 instead of 0 (22 checks passed, one failed); this must be resolved before this batch can pass its release gate. These results do not establish all-functions or production acceptance.

## AI-context repair — 2026-10-07

The path parser and probe contract were corrected after the first integrated sweep exposed a failure. Raw Git status now preserves filename/status boundaries, and normalized protected-path comparisons retain canonical names. Eight parser and 93 CLI contract checks passed; the original parser failed the protected-file control. Actual imports are safe, and the current post-edit report accurately remains blocked for protected-file and mapped-scope review. The payroll-only authorization and the intended project-wide scope are reviewed separately; probe success grants no policy waiver. The corrected full sweep has its own receipts. Native payroll concurrency remains a separate launch blocker, and production is unchanged.

An independent review then exposed missing protection for staged renames, committed renames and committed deletions. All three were reproduced against the actual CLI before repair. Rename entries now retain their original path alongside the destination, and committed changes retain deleted paths. The integrated repair passed 13 parser and 157 CLI contract checks; the prior version failed all three protection controls. Safe imports, canonical protected names and the actual blocked review decision remain intact. Targeted lint passed, and a fresh Gemini review found no serious defect. The preceding full sweep passed 197 of 213 suites with 16 skips and one partial pass; final verification of this additional repair is recorded separately.

## Action Center read orchestration — 2026-10-07

Normal synthetic owner UI at `/action-center` performed an actual trusted Refresh click, after which all five current ledger families fetched and settled with advanced data timestamps. The original Action Center and supporting modules were served successfully; all ten full native records across nine entities stayed unchanged, with zero mutation requests. The parent verifier passed, and removing the sources-family events from a separate proof caused it to fail. SourceDay, Expense and PayrollRun were empty, so this qualifies five-way read orchestration only. Populated calculations, unified error/retry dispatch, action buckets and schedule horizon expansion remain untested. Production was unchanged.

## Verified source batch — 2026-10-07
The integrated employee-identity, portfolio Statistics and AI-context repairs pass their current source gates. The unchanged product source passed 913 unit tests across 103 files, typecheck and production build. After the final review-gate repair, current lint, Brain, repository map and V3 checks passed; the full 213-suite sweep returned 197 PASS and 16 SKIP, with one partial PASS and no failing or timed-out suites. The skipped checks require an unavailable local service or uncommitted report fixtures; these results do not convert them to PASS. The parent receipt oracle verified the exact source hashes and retained earlier failures separately.

This batch includes no server concurrency repair or production deployment. Authoritative payroll creation across clients, remaining website functions, pending production migrations and authenticated production owner acceptance remain release requirements. Current qualified function evidence covers 17 of the historical 107 primary actions; 89 remain untested and one is inapplicable. A ready-to-use handoff is not established.

## Dependency audit and upload inspection — 2026-10-07

The security workflow for commit `97ca3c3` passed lint, typecheck, map verification and all 913 unit tests, then failed on `source-map-js` 1.2.1 advisory GHSA-68fv-2mgg-jv7q. Deep Verification passed. The 1.2.2 correction changes only three lockfile fields and passed a fresh isolated install, actual npm audit and the existing audit gate with zero vulnerabilities. The integrated project install passed. The integrated project passed typecheck, lint, production build, Brain, repository map, V3 and the unchanged audit gate. Its initial unit run passed 817 tests but failed four forks-worker startup handshakes; the subsequent full, unchanged npm test passed 913 tests across 103 files. The original failure is retained and its cause remains unproven. The full script sweep returned 197 PASS and 16 SKIP out of 213 suites, including one partial PASS, with no failing suites. Skipped local-service and report-fixture checks remain unverified. New remote CI is pending until the correction is pushed; these local results do not certify it.

Normal upload inspection produced the expected valid CSV preview and rejected malformed XLSX, XLS, CSV and executable files. All ten full native business records stayed unchanged. The parent verifier passed and deliberately forged alert evidence was rejected. This qualifies the existing first-four-byte file guard; queue property confirmation, rollback and raw archive recovery remain untested.

Current qualified coverage is 18 PASS, 88 NOT_RUN and one inapplicable action out of 107 historical primary actions. Prior action inventories are preserved. Authoritative payroll atomicity, remaining functions, production migrations and authenticated owner acceptance remain open release requirements. A ready-to-use handoff is not established.
