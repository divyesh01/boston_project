# Owner repair checklist

Started 2026-08-28. Scope: standalone React/Vite app, Cloudflare Git deployment,
browser-local Dexie data. No Base44 services are active.

## How the reviewer checks this list

The independent `checklist_reviewer` agent audits each implementation batch against
this file, current source, and actual test results. It calls out skipped items,
regressions, unsupported claims, and unfinished work. It does not change live data.
This file persists between sessions; the agent is not an unattended background
service. On resuming work, read this list and explicitly re-engage the reviewer.

Only mark an item verified with evidence. A passing unit test is not a production
deployment. Keep blocked/deferred items visible. Do not silently delete scope.

| ID | Priority | Work and acceptance check | Status | Evidence / remaining work |
|---|---|---|---|---|
| T01 | High | Data freshness: show selected-property report age; distinguish loading/error/no data; warn before current-day decisions without preventing historical analysis. | In progress | Implemented on Dashboard, Action Center, Pricing, Forecasting. Date/state, property-switch, retry, and midnight tests pass; synthetic desktop/375px preview checked. Newest occupancy date only, not complete report/property coverage. Signed-in page QA remains. |
| T02 | Critical | Stop simulated OTA connect/sync/rate push being represented as real; no fake reservations should be inserted by normal UI use. | In progress | ChannelManager reservation-writing handlers and Pricing push/audit calls removed. Disabled controls and no-call tests pass; reviewer inspected paths. Protected adapter still contains simulations and needs a named-file owner exception. Existing fake records, if any, have NOT been identified or deleted. |
| T03 | High | Label pricing as a local what-if scenario, not live market advice or automatic OTA updates. | In progress | Pricing and dashboard panel now disclose local inputs and actual scenario start date, suppress pending/error values; unsupported horizons say Not calculated. Full live-input provenance remains unfinished. Dormant PricingOverrideButton/helper is not imported into a live page, but still contains false success semantics. |
| T04 | High | Missing expense/payroll inputs must not look like complete profit; Dashboard, Action Center, Expenses, Forecasting must disclose missing costs. | In progress | Shared notice on all four pages; respects period, committed payroll and payroll expense categories. Presence never proves completeness. Loading/error notice tests pass. Accounting formulas/user edits preserved; full per-property completeness and signed-in QA remain. |
| T05 | High | Explain unsupported Google Drive import, remote review aggregation, automatic payroll, email delivery, and weather/demo data honestly. | Planned | Verify each path separately; local analysis is not necessarily broken just because it is called AI. Reviews save response locally, not to the source site. |
| T06 | Critical | Durable backups: manual full export/restore already exists; add reminder/status after imports and before risky actions. | Planned | Settings and dbArchive.js exist; do not recreate them. Verify restore using synthetic data only. |
| T07 | Critical | Backup sensitivity: warn that JSON contains private records/security fields; evaluate encryption and key recovery. | In progress | Plaintext/private-security-fields warning added to Settings. Existing archive probe passes 216 checks. Encryption, recovery design, and signed-in warning rendering remain. Checksum is not encryption; old backup format unchanged. |
| T08 | High | Guided setup: property → inventory/settings → report import → reconciliation → backup → first useful action. | Planned | Setup.jsx is protected; operational guidance can live on unprotected pages. |
| T09 | Medium | Group navigation into Today, Money, Operations, People, Data & Settings; retain deep links and permission checks. | Planned | No route removals without checking consumers; responsive/keyboard review needed. |
| T10 | High | Decide single-device tool vs shared server system; verify upstream access gate, server auth, authoritative audit and backup needs. | Blocked | Needs owner architecture decision. Cloud backend migration and protected auth edits are not authorized by this checklist. No claim that Cloudflare Access is verified. |
| T11 | Medium | UI trust: loading placeholders instead of temporary zeros, current property counts, accessible controls and mobile layout. | In progress | Action Center and pricing loading states added. Earlier 0-property observation resolved after load; do not report missing data from it. Expenses/Forecasting temporary numeric values, offline/paused queries (`isLoading` alone is insufficient), other page loaders, full keyboard/mobile app QA still open. |
| T12 | Medium | Reconcile cross-page metric definitions, incomplete reports, forecast horizons and cost coverage; document receipt after import. | In progress | Pricing partial-horizon mislabel fixed/tested. Remaining accounting reconciliation/import receipt work open. Existing uncommitted commission/math changes belong to user; preserved. |
| T13 | Medium | Keep documentation and tests honest; distinguish legacy test fixtures from real integrations; review claimed readiness. | In progress | Current README/BRAIN correction already exists. Graph is stale and missed backup implementation. |
| T14 | High | Verify final batch, independent review, then deploy only through agreed Git workflow. | In progress | Local tests/probes/build and independent review underway; see batch log. No production writes, account creation, commit, push, or deployment. Signed-in end-to-end QA is not replaced by component tests. |

## Batch log

- Batch 1 (2026-08-28): trust labels, stale-report warnings, cost coverage warnings,
  simulated-action removal, partial-horizon fix, and plaintext backup warning.
- Red/green evidence: original UI tests failed all 3 cases (false integration
  claims and 14-day total shown as 30/90 days); fixed. Reviewer caught payroll
  expense misclassification; 2 added regression cases failed, then passed after
  reusing the existing expense buckets. No accounting formula changes.
- Current focused suite: 32/32 tests in `tests/owner-trust*.test.*`. Includes
  invalid/future/DST/leap dates, property switch, retry, midnight/timer cleanup,
  incomplete cost records, loading/error states, disabled integration controls,
  and exact forecast horizons. Final full Vitest run: **45 files, 365 tests passed**.
- Narrowed probe runs: cents conversion 38, UI feedback 83, pricing 37, archive
  216, standalone deployment 57, deployment config 121 checks passed; Action
  Center scenarios passed. These are NOT a claim that all 133 probe suites ran.
- Browser: synthetic components checked at desktop, real 375px phone width, and
  812px landscape width with no horizontal overflow. Local app had no user
  account; no account was created.
  Signed-in full-page and production verification remain unfinished.
- Final typecheck, lint and production build passed (existing large-bundle and
  dependency annotation warnings). Temporary synthetic preview files removed.
  The staged-only brain gate was invoked with nothing staged; that is not a
  meaningful documentation validation result.
- No protected files or production records changed. Temporary synthetic preview
  is verification only, not a deployed feature. Preserve all pre-existing edits.
- Final independent reviewer verdict: no new blocking issue in this batch;
  independently reran 32/32 focused tests. Checklist retains all unfinished work.
  This is a verified local batch, not overall completion or deployment.
