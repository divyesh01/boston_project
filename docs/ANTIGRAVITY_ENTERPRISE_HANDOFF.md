# Verification Checklist for Antigravity

Implementation branch: `codex/report-date-merge`.
Implementation base: `60c7916`.
The commit containing this document is the implementation head.

Codex performed code changes and static source inspection only. Per the owner's
explicit coding-only instruction, no governance verifier, tests, probes, builds,
lint, typecheck, browser checks, or performance measurements were run. No remote
database migration was executed. Do not interpret this handoff as PASS or launch
approval. Git hooks that run verification are also deferred to Antigravity.

## Files Changed/Created

Paths below are relative to the repository root.

| Files | Change |
| --- | --- |
| `src/lib/enterpriseSchema.js` (new) | Shared validation for dated policies, profiles, templates, remittance evidence and service statements; configurable demand clusters. |
| `src/lib/enterpriseConfigEngine.js` (new) | Global, state, region and property precedence; dated resolution; property-scoped profiles; bulk preview and saves. |
| `src/lib/businessDate.js` (new) | Strict civil dates, IANA property time zones and explicit business-date advancement. |
| `src/lib/thresholdEngine.js` (new) | Capacity-scaled revenue bands and estimated room contribution with configurable CPOR and high-contribution target. |
| `src/lib/taxEngine.js` (new) | Percentage and occupied-room-night jurisdictions; evidence-dependent exemption/remitter handling. |
| `src/lib/taxRemittance.js` (new) | Allocate reviewed marketplace remittance against the exact property/date taxable base and jurisdiction amounts. |
| `src/lib/promotionStacking.js` (new) | Sequential discounts, discounted-base commission/card fees, and contribution in cents. |
| `src/lib/laborPolicy.js` (new) | Reviewed wage checks, dated overtime worksheet calculations and source-linked shared-service statement calculations. |
| `src/lib/pmsAdapters.js` (new) | Explicit supported flat daily-summary formats for canonical CSV, SynXis, Opera and Cloudbeds; HotelKey keeps its existing parser. |
| `src/lib/hotelDataQuery.js` (new) | Read all D1 pages through the existing entity API; detect incomplete/non-advancing responses and duplicate IDs. |
| `src/lib/settingsStore.js` | Preserve pending drafts on conflicts/errors, require a known revision, serialize flushes, expose save status and explicit conflict review, cache parsed property settings. |
| `src/lib/useHotelData.js`, `src/lib/dailyAggregates.js` | Paginated ledger reads; reject stale aggregate versions across the selected range. |
| `src/lib/reportParsers.js` | Select configured PMS adapter before existing normalization and validation; retain explicit property identity, including ID zero. |
| `src/lib/hotel.js` | Remove invented 100-room fallback from portfolio capacity calculations. |
| `src/lib/calculationService.js`, `src/lib/taxSettings.js`, `src/lib/taxLiability.js`, `src/lib/moneyKeptModel.js` | Resolve date/property tax policies, preserve actual imported tax totals, expose jurisdiction formulas/remittance, and avoid charging documented marketplace remittance again in estimates. |
| `src/lib/pricingEngine.js`, `src/lib/usePricing.js` | Apply dated property floor/ceiling after demand and competitor adjustments; use property clock; react to configuration updates. |
| `src/lib/useGlobalFilters.jsx` | Use the explicit business date for a single property's operational ranges. |
| `src/lib/actionCenter.js` | Missing-capacity and negative estimated contribution actions. |
| `src/components/settings/EnterpriseSettings.jsx` (new) | Property, threshold, tax, labor and PMS configuration tabs, dated periods, templates and bulk preview. |
| `src/components/settings/SettingsConflictNotice.jsx` (new) | Pending/error status, server-versus-draft review, and explicit discard or reapply decisions. |
| `src/components/channels/PromotionSimulator.jsx` (new) | Editable property scenario and permission-controlled save. |
| `src/components/payments/TaxRemittanceRecords.jsx` (new) | Reviewed statement reference/base/amount entry with permission-controlled writes. |
| `src/components/payroll/SharedServiceStatements.jsx` (new) | Employer-scoped staff/payroll reads, explicit source selection, draft allocation and CSV export; no automatic transfer or payroll payment. |
| `src/components/payroll/OvertimeWorksheet.jsx` (new) | Dated shift review across service locations using an explicit employee identity and reviewed employer group. |
| `src/components/dashboard/TaxCalculationBreakdown.jsx` | Visible jurisdiction formulas, remittance allocation and incomplete-data notices. |
| `src/pages/Settings.jsx`, `src/pages/MonthlyCalendar.jsx`, `src/pages/ActionCenter.jsx` | Integrate configuration/conflicts, per-property calendar thresholds/contribution and actions. |
| `src/pages/ChannelManager.jsx`, `src/pages/Payments.jsx`, `src/pages/Payroll.jsx` | Integrate the scenario, tax-evidence and shared-service/labor workflows. |
| `src/pages/RoomBoard.jsx` | Apply the selected property's dated pricing bounds to suggested rates. |
| `worker/enterprise-policy.js` (new) | Resolve reviewed labor configuration and reject below-policy hourly rates on supported server write paths. |
| `worker/entities.js` | Combined date comparisons, deterministic paging sort, property ID zero, awaited error handling and wage guard integration. |
| `worker/business-sync.js` | Wage guard on normal Staff/PayrollRun upserts with mapped server property identity. |
| `worker/settings.js` | Shared payload validators, strict permissions/property targets, payroll-source checks, and transactional expected-revision guard for settings/history writes. |
| `migrations-production/0009_enterprise_settings_guard.sql` (new) | Additive settings/history/transaction guard schema. |
| `docs/ANTIGRAVITY_ENTERPRISE_HANDOFF.md` (new) | This handoff. |

Protected authentication, security, SDK and governance files were not modified.
The owner's unrelated changes in the Desktop checkout were preserved.

## Expected Behavior / Invariants

1. Report replacement remains scoped to the same property, report type and
   overlapping business dates. A newer August report can revise August values
   downward for a refund; it must retain January-July and non-overlapping later
   dates. It must not add old and new values for the same daily record.
2. Configuration resolves global -> state -> region -> property for the date
   being calculated. Saving a new period must retain other non-overlapping
   periods. Different properties may use different clocks, capacity and policy.
3. Imported tax amounts, including explicit zero, remain authoritative. Estimated
   state/city/other taxes show their rates, bases and formulas. RRI274's existing
   owner-configured 5.75% state and 6% city split stays property-specific; these
   values are configuration, not a declaration of the statutory rate elsewhere.
4. A marketplace name alone does not establish exemption or remittance. Evidence
   must match the property/date, current taxable base and available tax amounts.
   Revised report bases make mismatched evidence stale instead of silently
   subtracting it. Flat fees need occupied-room-night data.
5. Calendar contribution is room revenue minus occupied rooms times configured
   CPOR. It is an operating estimate. Missing capacity/CPOR is not invented.
6. Promotion discounts stack sequentially. For $120, 15% then 10%, 18% commission
   and 3.4% card fees on discounted revenue, expected net retained is $72.16.
7. Shared-service drafts retain employer, receiving property, employee identity
   and original payroll references. Source hours/rates must reconcile and total
   allocations cannot exceed source regular/OT hours. No second payment is made.
8. Reviewed labor policies are user configuration. The worksheet requires dated
   shifts and an explicit employer group; daily OT is credited when allocating
   weekly OT. Unknown employment relationships are not inferred from names.
9. Settings writes require an expected revision, including revision zero. A stale
   revision aborts the entire D1 batch, including history. A 409 retains the local
   draft and pauses automatic retry until an explicit review decision.
10. Unauthorized property/global writes must fail at the server. UI write controls
    reflect the required permission, while server authorization remains decisive.
11. Pricing bounds apply after competitor blending and separately for every
    forecast date. A bad inherited floor/ceiling combination must not produce a
    silently out-of-policy recommendation.
12. Paginated reads must not silently return just the first 5,000 records. Old
    aggregate versions must fall back to the authoritative ledger path.

## Verification Commands

Antigravity runs these; Codex has not run them. Use synthetic fixtures and a local
database. Record commands, output, expected/observed results and exact commit SHA.

```powershell
Set-Location 'C:\Users\Divyesh\.codex\worktrees\report-date-merge\boston_project'
git rev-parse HEAD
npm run verify:v3
npm run typecheck
npm run lint
npm test -- src/tests/financials.test.js src/tests/aggregates.test.js src/tests/dataIntegrity.test.js src/tests/dataHealthAndAdapters.test.js
npm test -- src/pages/Import.test.jsx src/pages/ImportBatch18Regression.test.jsx src/pages/ImportHardening.test.jsx
npm test -- src/pages/Settings.test.jsx src/pages/PayrollStatusRegression.test.jsx src/api/autoPayroll.test.js src/api/businessSync.test.js src/api/businessSync.hydration.test.js
node scripts/probe-settings-persistence.mjs
node scripts/probe-tax-cent-exact.mjs
node scripts/probe-monthly-calendar.mjs
node scripts/probe-bulk-import-replacement-flow.mjs
node scripts/probe-bulk-import-property-identity.mjs
node scripts/probe-payroll-entry-parity.mjs
node scripts/probe-pricing.mjs
npm run build
npm run map:verify
```

These existing checks do not prove every new feature. Add focused synthetic
coverage for the scenarios below; do not weaken existing assertions to get PASS.

For the additive migration, review and exercise a disposable local database:

```powershell
npx wrangler d1 migrations list boston-project-production-auth --local --config wrangler.jsonc
npx wrangler d1 migrations apply boston-project-production-auth --local --config wrangler.jsonc
```

Check migration idempotency and existing history uniqueness before planning a
remote migration. No remote command is authorized by this handoff alone.

## Edge Cases & Regressions

- Create 25 synthetic properties across distinct accounts, states and time zones.
  Exercise single-property, several-property and all-authorized-property views;
  numeric/string ID zero; no assignments; forbidden property IDs and global writes.
- Import Jan-Sep, then a corrected partial August report. Confirm the union of all
  original dates, lower refund-adjusted values only where dates overlap, repeat
  import idempotency, and independence of occupancy/revenue/payment report types.
- Query more than 5,000 rows, identical sort dates, combined lower/upper bounds,
  empty `$in`, malformed filters, page failure and data changing during paging.
  Same-count concurrent mutations need particular scrutiny: the current reader
  has count/duplicate checks, not a server snapshot-generation token.
- Set two clients to the same settings revision and save simultaneously. Exactly
  one should commit when they share the affected visible scope. Check two edits
  to different keys, one rejected multi-property batch, revision zero, missing
  revision, malformed acknowledgements, network interruption and edits during a
  GET or POST. Verify history and settings commit or roll back together.
- Pending cloud edits are currently an in-memory queue. Local values persist, but
  reload/crash recovery of the queued write intent is not implemented. Exercise
  this explicitly; do not certify durable offline draft recovery. Confirmed server
  acknowledgement is required before treating a save as complete.
- Change dates across policy boundaries and DST. Closing the business date is an
  explicit clock operation; this implementation does not perform a full PMS night
  audit, close ledgers or post journal entries.
- Check percentage/flat/mixed taxes, missing occupied-room-night units, negative
  correction days, explicit imported zero, unknown-property configuration,
  overallocated remittance and stale evidence after a corrected import. Daily
  aggregate reports do not establish individual guests' exemption eligibility.
- Check inherited rate floors/ceilings, partial overrides, all demand clusters,
  unequal property capacity, missing inventory and negative contribution. Compare
  Room Board suggestions with Pricing forecast on the same property/date.
- Test unsupported PMS layouts, ambiguous dates, missing fields, duplicate mapped
  fields, timestamps offered as business dates and embedded foreign property IDs.
  The adapters cover supported flat daily exports, not every native PMS report.
- Check promotion rounding at every discount step, zero/100% discounts, zero
  revenue, invalid rates, and negative contribution without changing ledger data.
- Use duplicate employee names with different identities, stale/foreign/unpaid
  source runs, cumulative over-allocation, rate mismatch, cross-property source
  selection, daily/weekly overtime boundaries and mid-period policy transitions.
  Legacy runs without employee IDs require explicit source matching. Statement
  source validation occurs before the settings transaction; concurrent payroll
  edits require re-review. Draft statements are not an accounting ledger.
- Wage guards cover normal server Staff/PayrollRun mutations. They do not prove
  comprehensive labor compliance, every historical/import/background path, or
  policy transitions inside a pay period. Inspect these boundaries before launch.
- Production currently uses the business-record sync path. The optional direct
  entity D1 schema needs a separate field-parity review for tax metadata and
  PayrollRun employee references before enabling it. Do not enable the alternate
  backend merely because its paginated read path was improved.
- Measure cold and warm load time with 25 properties and Jan-Sep synthetic data.
  The requested 1-2 second load is a target, not a measured result. Record payload
  sizes, request timing, cache behavior and time until the page is usable.

## UI / Route Checks

- `/settings`: five configuration tabs, period selection, template precedence,
  property switch with drafts, bulk preview, save status and two-client conflict
  review. Verify keyboard labels, small screens and read-only permissions.
- `/calendar`, `/action-center`: all imported dates, contribution, gold target,
  unequal-property thresholds and missing-configuration notices.
- `/`, `/payments`: separate state/city calculation, actual versus estimated
  amounts, documented marketplace remittance and stale evidence notices.
- `/channel-manager`: promotion sequence, contribution and authorized save.
- `/payroll`: employer-specific source loading independently of the page filter,
  source errors/retry, statement allocation, CSV summary and overtime worksheet.
- `/pricing`, `/rooms`: dated floors/ceilings, property clock and forecast changes
  when configuration changes; portfolio selection must not price a fictitious hotel.
- `/upload`, `/statistics`, `/compare`, `/data-intelligence`: report history,
  multi-property isolation and corrected-overlap totals remain consistent.

Return PASS, FAIL or BLOCKED with exact evidence. For failures, include the
smallest reproduction, affected boundary and expected versus observed result so
Codex can make the code repair. Do not report the portfolio as launch-ready from
the implementation or from a passing build alone.
