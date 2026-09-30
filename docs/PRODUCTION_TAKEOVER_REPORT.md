# Production takeover ? 30 September 2026

## Release decision

The local repair is implemented and suitable for staging review. **Production sign-off is blocked** on the running-backend error-response check and the external staging/restore checks below. No production deployment, data modification, or push was performed by this takeover.

## Repairs and evidence

| Finding | Disposition | Evidence / limit |
|---|---|---|
| R01 Financial reconciliation | Fixed locally | Empty/failed ledgers cannot claim a balanced audit; reported and calculated ledger presence required. |
| R02 Workbook assurance | Fixed locally | Missing take-home is UNAVAILABLE; genuine zero preserved; reconciliation does not claim verified hashes/rate controls. |
| R03 Property rebuild authorization | Fixed locally | Scope/capability checks plus live permission guard in atomic batch; aggregate probe 16/16. |
| R04 Configured storage | Adapter implemented | R2 and configured S3-compatible adapter supported; real deployed bindings/credentials still require staging validation. |
| R05 Aggregate corruption/atomicity | Fixed locally | Hash/count/entity/date validation, bounded decode, revision guard; 214-day success and late-insert rollback fixtures passed. |
| R06 Cache dimension parity | Fixed locally | Versioned cache, unsupported-summary fallback, live expenses, all tenders/ancillary, zero-ledger presence, OOO inventory and source refunds retained. |
| R07 Cash audit | Fixed locally | Property/day receipt coverage required; deposits-only is incomplete; report totals/details not double counted. |
| R08 OTA absence | Contained locally | Missing source baseline displays unavailable and cannot manufacture direct-booking savings; actual live missing channel origin requires owner source-file trace. |
| R09 Fee consistency | Fixed locally | Shared cents calculations, property-specific card/refund/commission rates, daily rounding and property-level actual/estimate selection. A actual fee 1/0/-1 plus B estimate 3 produces 4/3/2 respectively. |
| R10 Estimate truthfulness | Improved, limited by inputs | Imported zero tax retained; estimated versus actual cost basis shown; missing expense completeness cannot prove actual profit. |
| R11 Schedule delivery | Containment complete | Fake scheduler removed; truthful unavailable dialog with manual download. Automated delivery is not implemented. |
| R12 Current pricing | Fixed locally | NY business today, real type inventory, cancelled bookings excluded, zero bookings gives zero projected revenue, weighted ADR and input freshness/loading notice. |
| R13 Revenue chronology | Fixed locally | Group/sort business dates, weighted occupancy, preserve measured zero days. |
| R14 Weather | Fixed locally | No implicit operational demo; per-property coordinates, actual entity API, one refresh per saved location, replace fetched date/kind records. Provider configuration remains external. |
| R15 Workbook dependency | Fixed locally | Integrity-pinned official SheetJS 0.20.3; bounded terminable import worker; timeout regression passed. |
| R16 Dependency gate | Passed locally | Audit: zero critical/high/moderate/low findings. No accepted vulnerability exceptions. |
| R17 CI | Implemented, intentionally fail-closed | V3 plus full probes; --require-all rejects skips/partial results. Configure RRI_STAGING_API_BASE_URL to a running backend implementing the function route before the release gate can pass. |

## Validation

- Application suite: 86 files / 734 tests passed on the final finance/worker source. Final repeat also passed 734 tests after pricing availability text.
- Final build, lint and typecheck exited 0; dependency audit, V3 and repository map passed locally.
- Full 202-probe sweep: 198 passed, three finance probes failed due to changed fixture/accounting expectations, one backend probe skipped. Strict mode correctly exited 1.
- All three finance probes were repaired and rerun successfully: double-count 65/65, money kept PASS, tax liability 14/14. The baseline fixture now explicitly reports the second day's measured zero source revenue; cents-only probe disables unrelated tax estimation; disabling estimates preserves imported tax liability. These are documented contract changes rather than deleting checks.
- Final affected-path reruns: aggregate 16/16, decimal integration 49/49, pricing 37/37, build chunks 11/11.
- Therefore 201 distinct probes have passing results across the full sweep and subsequent reruns. **One remains unverified**: probe-config-exposure needs /api/functions/aiAssistant on a running backend. Static preview returns 404 and cannot prove backend error sanitization.
- Three-browser synchronization passed in the full sweep using isolated test data. This does not establish actual production identity, storage or restore behavior.
- Protected files unchanged relative to 4975c02. Existing concurrent AI_CORE_RULES.md edits were preserved; their trailing-blank-line warning is outside this patch.

## Before production approval

1. Identify the deployed backend contract: the Base44 function endpoint tested by probe-config-exposure is not mounted by the static preview. Supply the corresponding staging backend or adapt the probe to the actual deployed route with equivalent negative/error assertions; do not count 404/auth rejection as handler coverage.
2. On isolated staging data, verify two-role/two-property authorization, fresh-browser hydration, repeat import/correction, date/property-scoped owner export, aggregate rebuild and failure recovery. Confirm deployed Access configuration, D1 query limits, R2/S3/GCS bindings, object integrity, secrets and provider access.
3. Snapshot D1 and immutable object inventories. Demonstrate a restore to separate staging storage and reconcile expected cents/row counts. Verify monitoring, log redaction, alerts and retention settings externally.
4. Run the CI workflow from a clean checkout with the staging backend variable and browser prerequisite. Require a green check in the hosting/publishing path; GitHub branch rules and Cloudflare automatic deployment gates are external configuration and were not inspected here.
5. Deploy only after owner approval of the exact staged revision. Retain the current deployed Worker/frontend versions and snapshots. Smoke-check login, scoped reads, known fixture totals and export. On regression, roll back Worker/frontend first; restore data only if an authorized destructive migration actually occurred. Do not delete source archives to roll back a recomputable cache.

## Workspace preservation

Original Gemini work was preserved at D:/Caches/temp/rri-gemini-baseline-Hwo0lZ. Commit 968b1bc appeared during this takeover; it was not created by root. Later repair changes remain reviewable in the working tree. Test logs are under D:/Caches/temp/rri-*. The durable execution state is docs/production-takeover-state.json.

## Push limitation

GitHub rejected the combined push because the current OAuth credential lacks workflow scope. Application repairs and this report are pushed separately. The updated .github/workflows/security.yml remains in the local working tree and is preserved in branch codex/production-takeover-with-workflow (commit 09f6e56). CI enhancements require a credential with workflow permission before they can be published.
