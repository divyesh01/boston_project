# Gemini production-readiness implementation prompt

Copy this entire document into Gemini with access to the repository. Model requested by the owner: Gemini 3.8 Flash, High reasoning. This document does not verify that model's availability.

## Your assignment

You are implementing production-readiness repairs for Red Roof Intelligence.

- Repository: https://github.com/divyesh01/boston_project
- Local checkout: `C:\Users\Divyesh\Desktop\boston_project`
- Production: https://boston-project.divyesh-boston.workers.dev/
- Audit baseline: commit `4975c02256d4bfbbaee64b9a7e89dbeb0ba86d5b`, September 30, 2026.

I want working, trustworthy software, not another reassuring report. Fix the confirmed issues below at their root, investigate the explicitly unproven issues, and audit remaining workflows before claiming readiness. Quality matters more than token usage. Work in small, reviewable batches and continue through testing and review. Do not replace this application with a new design or rewrite unrelated modules.

The preceding audit changed no application source and deployed nothing. It inspected live Dashboard, OTA Channels, and Data Intelligence pages, reviewed source, ran local checks, and used isolated in-memory reproductions. It did not validate every page or production backend configuration. Local source and deployed revision have not been proven identical. Recheck evidence against your actual checkout before editing; line references below are baseline anchors, not immutable locations.

## Mandatory operating rules

1. Read `AGENTS.md`, `PROTECTED_FILES.md`, `.agents/rules/no-modify-protected.md`, `AI_CORE_RULES.md`, and `README.md`. Run `npm run verify:v3` and the V3 startup verification; stop with `SYSTEM_DRIFT = BLOCKED` if verification fails. Read the V3 kernel/router and load only relevant packs. Follow `QUALITY_FIRST_COMPUTE.md` for this complex financial/security work.
2. Inspect `git status` and preserve existing user changes. One logical writer owns each patch. Use independent read-only reviewers when available, with distinct financial, security, and test missions. Do not describe sequential self-review as independent review.
3. Protected files require explicit owner authorization naming the file. This prompt is NOT that authorization. Do not bypass protection through wrappers, replacement files, or monkey patches. When a protected-file repair is necessary, finish the investigation, provide the exact proposed change and tests, then request authorization for that file while continuing unrelated permitted work.
4. Keep credentials, customer data, payroll details, and raw reports out of logs and commits. Use anonymized fixtures. Do not run destructive tests against production, send real report emails, delete production data, rebuild live aggregates, migrate live data, or deploy without the required explicit authorization. Prepare the complete tested patch and rollback plan first.
5. Inspect actual runtime architecture before following old docs. The checkout includes Cloudflare Worker authentication, D1, GCS object storage, a Base44 compatibility client, and IndexedDB paths. README/comments contain older Base44/standalone descriptions. Do not migrate platforms or reactivate old auth modes based on stale comments. Read relevant installed Base44/Cloudflare skills and current official documentation before changing their integration code.
6. Financial arithmetic uses integer cents through the existing decimal utilities. Preserve legitimate zero values. Missing, loading, failed, partial, stale, estimated, and actual-zero are different states. Never fabricate data to make a card green.
7. Track each finding by ID below with evidence origin `OBSERVED`, `INFERRED`, `NOT_RUN`, or `UNKNOWN`; use `PASS`, `FAIL`, or `UNPROVEN` for gates. A passing build or a skipped suite is not proof of production correctness.

## Evidence already collected

Live YTD January 1–August 2, 2026, All Properties:

- Gross revenue $1,020,598.17 = room revenue $1,011,258.67 + ancillary $9,339.50; 12,362 rooms sold; 21,400 available; occupancy 57.8%; ADR $81.80; RevPAR $47.26.
- Dashboard estimated money kept $847,517.71; deductions $173,080.46, including card fees $17,963.20, estimated taxes $118,317.26, payroll $36,800.
- Dashboard channel matrix empty; OTA dependence says 0% Low; OTA simulator projects zero savings.
- OTA page also has zero channels, but payment distribution totals $824,877.04 and card fees $17,949.85. The $13.35 fee difference needs record-level explanation.
- Daily Revenue Trend dates jump July 22 → February 27 → May 13 instead of increasing chronologically.
- Cash audit says expected cash $0, actual deposits $60,354.38, and “Over by $60,354.38” with no receipt-coverage qualification.
- Data Intelligence says health 0/100, no data ingested, zero uploaded reports, and zero coverage across ledgers. Its reconciliation tab nevertheless says “Cent-Exact Financial Reconciliation Confirmed,” “100% exact ledger match,” and no orphan charges, with all three ledgers $0.
- Weather is explicitly labelled demo. Adjacent pricing says “live demand signals,” “Today's Rate” $197.78, and tonight occupancy 60%, despite data ending August 2.

These are observed UI states, not proof of underlying database contents. Do not change stored business data to force the UI to match these observations. Preserve the supplied revenue identity as a regression fixture, while tracing each metric's actual source and accounting basis.

## Batch 1 — Stop false financial assurance and unsafe maintenance

### R01 — P1: Empty/failed data becomes successful financial reconciliation

Evidence: `src/pages/DataIntelligence.jsx:70–85` catches each entity read error and substitutes `[]`; reads are capped at 5,000. At approximately 392–432 reconciliation does not filter by the selected date range, compares a row property ID directly with `property` even when property can be an array, and computes payment totals without including them in reconciliation. At 744–750 the UI claims settled merchant transactions match and that there are no orphan charges. `src/lib/dataHealth.js:223` treats default zero/zero as reconciled.

Local direct reproduction: `reconcileFinancialTotals()` returns reported 0, calculated 0, difference 0, `isBalanced:true`. Live reproduction: open Data Center → Financial Reconciliation; all ledgers are zero but it declares confirmed success.

Required repair:

- Fetch complete, authorized data with explicit pagination/coverage. Do not swallow fetch failures into empty successful results.
- Apply the same property selection, business-date range, and source revision to summaries, property rows, and exports. Handle single property, arrays, and authorized all-properties selection.
- Require source completeness before financial assurance. Separate “no data,” “incomplete,” “failed,” and genuinely reconciled zero activity.
- Define what is reconciled. Revenue accrual, channel revenue, gross charges, refunds, taxes, and payment settlements can have different bases/timing. Do not force them equal. Use a documented bridge for valid differences and claim only the comparisons actually performed.
- Trace why this live page sees zero records while the dashboard sees 214 days. The cause may involve raw versus aggregate authority/hydration; it is not yet proven.

Acceptance: empty ledgers and failed requests never produce verified success; >5,000 rows are complete; date/property changes alter all applicable results; multi-select works; a missing channel ledger is incomplete; a one-cent real discrepancy fails exact reconciliation; a payment mismatch cannot receive a statement claiming payments matched.

### R02 — P1: Workbook invents a perfect health score and audit assurance

Evidence: `src/lib/ownerPacketExport.js:257–279` uses `portfolioHealth.portfolioScore || 100`, defaulting an actual zero to 100, and emits “Integer Cent Balance & Rate Card Reconciliation Verified” unconditionally. `OwnerPacketPreview.jsx:21–22` advertises $0 discrepancy and immutable SHA-256 raw-file signatures. Sheet 5 currently contains metadata/control statements rather than the advertised raw-file hash inventory.

Local executable reproduction: build workbook with `portfolioHealth:{portfolioScore:0,criticalCount:0,properties:[]}`. Data Provenance sheet says `100/100`, `READY / AUDITED`, and invariant check verified.

Required repair: preserve zero; require valid coverage and passed controls before READY/AUDITED; represent unknown explicitly. Carry actual source identifiers, revisions and verified hashes if promising provenance, otherwise describe the actual metadata honestly. A hash alone does not establish immutable storage. Derive preview and workbook assertions from the same verified result.

Acceptance: zero stays zero; missing health is unknown; incomplete/mismatched fixture cannot claim audited; actual hash evidence is inspectable or clearly unavailable; spreadsheet values, filters, and accounting basis match the page to the cent. Test the generated workbook cells, not just a download-button click.

### R03 — P1: Aggregate rebuild crosses property authorization boundaries

Evidence: `worker/aggregates.js:171–190` permits manager/GM by role, then enumerates account-wide active manifests; processing/writing at 224–327 does not apply the normal property scope/capability checks. Local in-memory handler reproduction with an A-only manager, empty permissions, and active B bundle returned 200 and wrote a B summary.

The currently configured GCS shape blocks this path earlier because of R04. Fix authorization BEFORE or together with storage; do not expose the latent flaw by fixing storage alone. No cross-property production exploit was attempted.

Required repair: enforce the appropriate maintenance/import capability and explicit authorized property set before reading manifests, storage objects, or mutating aggregates. Require explicitly authorized portfolio scope for account-wide maintenance; reuse existing scope enforcement.

Acceptance: A-only actor cannot read, rebuild, mutate, or infer B; denied capability and empty scope fail; authorized portfolio owner rebuilds only their account; unauthorized requests have no storage/DB side effects. Preserve existing auth/session negative tests.

### R04 — P1: Rebuild does not support the configured storage path

Evidence: `worker/aggregates.js:177–178,228` demands `env.BULK_DATA`. `wrangler.jsonc` instead configures GCS through S3-compatible adapter variables and no BULK_DATA R2 binding. `worker/bulk-import.js:5,112–122` already uses `resolveR2S3Stores`. Local GCS-shaped handler invocation returned 503. Actual deployed bindings remain unverified.

Required repair: use the existing storage abstraction consistently; validate configuration and fail with an actionable error. Do not build a second competing storage adapter.

Acceptance: isolated GCS-shaped and R2-shaped configurations both rebuild valid fixtures; missing configuration fails clearly; R03 authorization checks still run correctly. Verify real deployed configuration read-only before asserting production success.

### R05 — P1: Rebuild skips corruption, leaves stale days, and can publish partial results

Evidence: `worker/aggregates.js:226–237,276–278` skips missing/malformed bundles or mismatched aliases. Local missing-object fixture returned `200 {ok:true,rebuilt_days:0}`. Upserts around 283–336 do not remove obsolete summary days; the no-active-manifest branch returns success without invalidating old data. Health is hard-coded 100 around 327. Multiple 40-statement batches can expose a partial update.

Required repair: validate all required inputs; preserve the last complete published result on failure; publish a coherent validated revision. Choose the smallest design that ensures atomic visibility, such as a generation plus publication pointer if necessary. Remove/invalidate obsolete days only within successfully rebuilt authorized scope. Handle property aliases consistently with ingestion. Prevent concurrent import/rebuild from publishing mixed revisions.

Acceptance: corrupt/missing bundle fails without publishing false success; removed/replaced report invalidates obsolete totals; later-batch injected failure preserves a complete readable prior version; concurrent rebuild/import has deterministic version semantics; health reflects actual coverage.

## Batch 2 — Restore one financial truth across data paths

### R06 — P1: Fast aggregate path lacks dimensions consumers require

Evidence: `worker/aggregates.js:85–90,130–148,249–274` lacks tax categories, payment-method splits, expenses and source-stay dimensions expected downstream. `src/lib/useHotelData.js:389` passes summaries into `buildSyntheticRows`; `src/lib/dailyAggregates.js:418–420,432–433` defaults missing tax/payment dimensions to zero. Dashboard selects aggregate source rows when aggregates exist even if channel coverage does not.

Confirmed contract mismatch; exact production numerical impact is UNKNOWN. Do not invent a diagnosis without tracing inputs.

Required repair: document the summary contract, source revision, coverage, units, and supported dimensions. Supply complete dimensions or decline the fast path for unsupported metrics. Raw and aggregate paths must implement the same business definitions. Avoid joining mixed revisions or unrelated fallback data.

Acceptance: an identical fixture in a fresh browser, fully hydrated browser, post-refresh browser, and rebuilt aggregate path yields identical revenue/taxes/fees/commissions/refunds/payroll/expenses/channel/net-kept totals; missing dimensions display incomplete rather than zero; cache keys isolate account/property/date/version; offline state and failed refresh preserve honest freshness.

### R07 — P1: Cash audit uses one receipt row against all deposits

Evidence: `src/components/dashboard/ClerkAudit.jsx:13–24` uses `payments.find(CASH)` but sums all drops; `||` overrides legitimate zero. Around line 65 missing clerk receipts substitute that clerk's deposits as expected, manufacturing zero variance.

Required repair: share a cents-based reconciliation grouped by property, business date and clerk where available. Sum all applicable receipt rows; avoid double-counting totals and details. Never derive expected receipts from actual drops. Require receipt coverage before declaring over/short. Keep electronic payments separate.

Acceptance: receipts 100+200 and deposits 300 reconcile; zero remains zero; deposits-only is incomplete rather than over; clerks without receipt data have unknown variance; +/- one cent follows explicit tolerance; multi-property and date filters work.

### R08 — P1: Missing channel data appears to prove low OTA risk

Evidence: `OtaMatrix.jsx:17–33` renders empty channel input as zero totals; `src/lib/channelDictionary.js:196–205` returns 0%/Low for a nonpositive denominator. Dashboard source selection approximately 132–136 can choose an aggregate with absent channel map; `dailyAggregates.js:389–411` emits no rows. The live reason channels are absent is UNKNOWN.

Required repair: trace raw upload → parse → normalized source records → persistence → aggregate → chart. Show unavailable/partial when source coverage is missing. Only a complete ledger can support actual zero OTA dependence. Disable unsupported simulator savings claims. Do not allocate missing revenue to guessed channels or invent OTA bookings.

Acceptance: positive room revenue without channel coverage shows unavailable; complete all-direct fixture correctly shows zero OTA; partial summaries cannot silently override valid raw sources; simulator exposes assumptions and requires a supported baseline.

### R09 — P1: Fee settings and data sources disagree across pages

Evidence: `OtaChannels.jsx:34–39,66` uses property-specific configuration; `PaymentMethodChart.jsx:9`, `MoneyKept.jsx:85`, and `calculationService.js:365` use global card fee; `OtaMatrix.jsx:17` omits property when calculating channels. Service defaults property ID to `*` around line159. Live card fees differ by $13.35 between dashboard and OTA for the same period; raw versus aggregate inputs may contribute. Both paths use the same four card-method fields, so do not assume a legitimate refund distinction without proof.

Required repair: record exact included source IDs, revision, fee basis, rates, refunds, rounding boundaries and property scope for each figure. Centralize shared computation; apply each property's rates before portfolio aggregation. Preserve configured accounting policy and label estimates.

Acceptance: two properties with different rates produce matching component/page/export/drilldown totals; raw versus rebuilt aggregate is cent-exact; refund and negative-amount cases follow documented policy; the live discrepancy is explained or removed with evidence.

### R10 — P1: Financial estimates need explicit basis and completeness

The live app estimates taxes when report tax lines are absent and presents “Estimated Money Kept.” This audit does not establish that the configured tax rate or business-cost classification is legally/accountingly correct. Do not silently change either.

Required investigation: trace whether gross includes pass-through taxes, whether tax is an expense versus liability, whether fees use gross charges or net settlement, and whether missing commissions/expenses/refunds are being treated as actual zero. Show which components are actual, estimated, incomplete, or excluded. Reconcile totals without double-deducting tax/refunds. Ask for a business decision only where evidence cannot establish the intended policy; present the concrete alternatives.

Acceptance: fixtures covering tax-inclusive, tax-exclusive, explicit zero tax, missing tax, refunds, and incomplete expense coverage give transparent results. An unconfirmed assumption never becomes an assertion of actual profit.

## Batch 3 — Correct operational features and misleading presentation

### R11 — P1: Schedule Delivery is a fake success path

Evidence: `src/components/dashboard/ScheduleReportDialog.jsx:18–31` only writes localStorage and announces scheduling; around 164–166 calls `onSendTest` then announces email dispatch. `Dashboard.jsx:791` passes `handleExportPacket`, which downloads an XLSX. Search found no scheduler consumer of `scheduled_report_config` besides the dialog/test. No real email was sent during this audit.

Required repair: implement authorized server-persisted scheduling and delivery with recipient validation, property scope, America/New_York timezone/DST handling, idempotency, retry/failed status and audit history if the existing infrastructure supports it. Otherwise make the feature explicitly unavailable pending configuration; do not leave fake success. Downloads must say downloaded. Do not send real financial emails without recipient/destination authorization. A disabled feature is honest containment, not completion of email scheduling.

Acceptance: save/reload restores a persisted schedule; job execution tested with a fake transport delivers once, scoped correctly; failure never says sent; UI success follows server acknowledgement; test action uses delivery backend or is clearly a download preview.

### R12 — P1: Historical/default pricing is labelled current/live

Evidence: `src/lib/usePricing.js:48` anchors to latest imported date, while `PricingPanel.jsx:89–101` calls forecast[0] today/tonight. `pricingEngine.js:113–124` uses default occupancy when booked=0; at 260–261 empty inventory falls back to catalogue, and around285 assumes equal inventory per type. Panel58 says live demand signals without proving live inputs. Date-overlapping reservations need status filtering.

Required repair: separate business today from data cutoff and explicit historical simulation. Carry freshness, loading, source, and default/observed status. Count actual rooms by type; distinguish verified zero reservations from unavailable reservation coverage; exclude cancelled bookings under the documented status model. Do not forecast hotel revenue from invented inventory.

Acceptance: current Sep30/import cutoff Aug2 operational forecast starts Sep30 with stale-data notice; historical mode says Aug2, never today; 9 queen/1 king inventory remains 9/1; empty inventory cannot create a confident revenue forecast; known zero and missing reservations differ; loading does not show made-up live values.

### R13 — P2: Daily trend is unsorted and drops zero days

Evidence: `src/components/dashboard/RevenueTrend.jsx:10–17` filters `room_revenue > 0`, maps original order, and does not aggregate same-date property rows. Dashboard passes input around128–130,731. Live chronology is visibly wrong.

Required repair: group by full business date, sum cents across authorized selected properties, compute occupancy using sold/available room totals, sort ascending, preserve known zero days, distinguish missing days. Make tooltips/export match.

Acceptance: shuffled inputs produce chronological points; two properties on one date yield one weighted point; zero-revenue days remain; missing dates are not silently fabricated as real zeros.

### R14 — P2: Demo weather has no normalized daily forecast

Evidence: `weatherService.js:35–53` constructs current/hourly while normalizer around63 reads daily. `WeatherPanel.jsx:46` chooses demo for portfolio, even a one-property portfolio. Live forecast-high is blank. The demo label itself is present and honest.

Required repair: use an explicit unavailable state in operational production when no real feed is configured; document portfolio policy. Keep any explicit demo isolated and correctly normalized. Do not imply demo weather is measured demand evidence.

Acceptance: missing provider configuration never presents a real forecast; configured property reports source/timestamp; explicit demo has valid labelled daily rows; pricing does not silently consume fabricated weather as observed signals.

Do not treat “16 paid” versus “automation lands Approved” as a proven bug. The card counts actual statuses; manually recorded paid runs can validly coexist with approved automatic runs. Verify payroll lifecycle before changing it.

## Batch 4 — Security dependencies and release gates

### R15 — P1: Workbook vulnerability exception has a false premise

Evidence: `scripts/audit-gate.mjs:40–60` accepts xlsx advisories GHSA-4r6h-8v6p-xvw6 and GHSA-5pgg-2g8v-p4x9 because it claims WRITE-ONLY use. `src/lib/reportParsers.js:377–386` calls `XLSX.read(meta.rawBytes)`; `scanReport` uses this helper and `Import.jsx:471–477` supplies raw bytes on the archive/resume path. Installed xlsx is 0.18.5. This proves a read path, not a reproduced exploit.

Required repair: reassess reachability; use a vetted patched distribution or maintained compatible replacement, with verified origin/version/integrity and import/export regression coverage. Remove the false exception. Do not downgrade the audit threshold, invent a new “not reachable” claim, or assume a compressed-byte limit prevents parse-time resource exhaustion. Add workbook parsing isolation/time and dimension limits where appropriate.

Acceptance: archive/resume and normal import fixtures still work; malformed/adversarial workbook input is bounded; export round-trip remains correct; audit policy matches actual code paths and fails for new unaccepted advisories.

### R16 — P1 release gate: Dependency audit currently fails

Observed `npm run audit:gate` failure: summary 0 critical, 3 high, 3 moderate; additional unaccepted advisory IDs include brace-expansion GHSA-qhr7-859c-m2p7 / GHSA-6j4f-fj2g-mc7p and undici GHSA-rfgv-xxqx-mfg5 / GHSA-w293-vg96-wgc3 / GHSA-vp8m-p9jh-q5pm. Installed paths observed: brace-expansion 1.1.21 through eslint-plugin-react/minimatch; undici 8.11.2 through jsdom. Distinguish development/tooling exposure from deployed browser/server exposure; this is not proof all these are remotely exploitable in production.

Required repair: rerun current audit, trace dependency paths, update compatible dependencies/lockfile, and test. Do not blindly run force-fix or suppress errors. Preserve evidence-based exceptions only where currently valid.

### R17 — P2: CI omits broad probe and V3 verification gates

Evidence: `.github/workflows/security.yml` runs lint, typecheck, map verification, unit tests, audit and build, but not `verify:all` or explicit V3 bootstrap verification. Many worker/data contracts live in standalone probes. `vitest.config.js` retains removed `poolOptions`; test execution warned that Vitest4 ignores it.

Required repair: add safe deterministic probe/V3 coverage with clear pass/fail/skip reporting and appropriate build/server ordering. Keep mutation/destructive/remote tests isolated and explicitly authorized. Update test-worker configuration using supported Vitest APIs. Ensure the real Cloudflare deployment path is gated by the validated revision; inspect provider settings rather than assuming GitHub checks block deployment.

Acceptance: an intentionally broken scope/aggregate invariant fails CI; skips cannot masquerade as passes; CI uses supported Node/dependency versions; build artifact and deployed revision are traceable; release rollback is documented and tested in nonproduction.

## Remaining production-readiness audit — required, not yet proven

After these repairs, enumerate real routes, menus, API handlers, jobs and storage paths. Use a coverage matrix: workflow, role/property scope, happy path, failure path, evidence, status. Cover:

- Login/logout, session expiry/revocation, MFA, password reset, setup closure, user management and protected-route/API negative cases using isolated accounts. Do not weaken existing security to simplify testing.
- Property isolation across reads/writes/cache/export/upload/object download/rebuild, including A-only managers, no scope, owners, and two accounts.
- Imports: CSV/Excel/report variants, duplicates/retries, partial writes, concurrent imports, archive/resume, cancellations, malformed headers, Unicode, CRLF, quoted commas, large files, row rejection diagnostics, raw-file lineage, rollback and retention. No silent row loss.
- Payroll, expenses, manual entry, room board, housekeeping, channels, refunds, transactions and audit history: persistence after reload/new browser, role restrictions, failure recovery and source consistency.
- Global filters and compare: single/multiple/all properties, custom ranges, YTD/month/day, leap days/DST/business dates, employee/payment/channel/report filters, reset/apply, empty states. Every chart/card/export must either respect a filter or explicitly state why it is inapplicable.
- Exports: XLSX/PDF/PNG contain correct dates/properties/units/coverage, readable pagination, no clipped charts, no false assurance, no spreadsheet formula execution from user text, and accurate failure notifications.
- Offline/cache: fresh versus warm browser, failed refresh, logout/account switch, cross-tab changes, stale cache and rehydration. Never erase the only copy of data to fix a screen.
- UI: keyboard navigation, labelled controls, dialog focus/escape, readable contrast, 200% zoom, narrow mobile layouts, loading/error/empty states. Maintain the existing visual style; correctness precedes cosmetic changes.
- Operations: actual storage permissions and secret boundaries, backups plus demonstrated restore in staging, dependency/secret scans, CSP/security headers on the live target, logs without sensitive contents, actionable errors, monitoring, rate limiting, deployed version stamp and rollback. Do not claim these passed without evidence.

## Verification baseline and required finish

Observed during this audit:

- V3 normal/startup verification: PASS.
- Lint and typecheck: PASS.
- Vitest: 80 files, 702 tests PASS.
- Production build: PASS in 58.73 seconds, with chunk/dynamic-import warnings; warnings are not measured performance failures.
- Repo map: PASS, 10 areas / 28 matrix rows / 39 contracts / 193 references.
- Worker scope probe: 9/9 PASS; worker app auth probe: 16/16 PASS. These passing local checks do not invalidate R03's uncovered rebuild case.
- Audit gate: FAIL as above.
- Full verify sweep: final results were not available for this handoff; UNPROVEN. A final process inspection found no running verify-all/probe Node process, but process exit alone does not establish success. Rerun and record the complete summary yourself.
- Production destructive/security mutation tests, full route acceptance, restore drill, email delivery and deployed configuration parity: NOT_RUN/UNKNOWN.

For every repaired bug: establish a meaningful failing regression or deterministic reproduction, fix the root, prove the test passes, review the diff and adjacent callers. Do not delete or weaken assertions to make the suite green. Tests should expose business invariants, including negative/error cases, rather than mirror implementation details.

Run the applicable package checks: `npm run verify:v3`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run audit:gate`, `npm run build`, `npm run map:verify`, and `npm run verify:all` with required prerequisites. Inspect scripts before executing mutation or remote suites. Keep final command outputs/exit codes and explicitly disposition every skipped/failed suite. Run browser acceptance against the built app with isolated test data, then authorized read-only production smoke checks once a release is approved.

Maintain a durable task ledger and finish with:

1. Each R01–R17 disposition: fixed with proof, disproven with proof, or blocked with exact requirement. Separate temporary containment from completed functionality.
2. Files changed, source-to-display explanation for material finance fixes, and before/after deterministic examples.
3. Exact checks and outcomes; no invented coverage percentages or blanket “all bugs fixed.”
4. Remaining production risks, protected-file authorization requests, external setup requirements and untested workflows.
5. A release decision: NOT READY until the material financial/security issues and required gates are resolved. If evidence supports readiness, state the validated scope and remaining limitations rather than promising absolute absence of bugs.
6. A concrete staged deployment/rollback plan for owner approval; do not deploy merely because this prompt says production readiness.

Start by validating the baseline and reporting the first bounded repair batch. Then implement, test, review, and proceed. Explain progress in plain language: what was wrong, what changed, and what proves it works.
