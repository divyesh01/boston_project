# Executive dashboard repair

Owner request: fix the imported reports missing from the Executive Hub and the contradictory payroll/deduction readouts.

COMPUTE_MODE: STANDARD
AGENTS_USED: 0
WHY_THIS_DEPTH_WAS_SUFFICIENT: sequential source review, live browser observations, deployed asset inspection, deployment history, rendered component regression tests, and the existing integration probe. Review roles were performed sequentially by the same agent; no independent review is claimed.

Writer: Codex. Risk: 2. Workflow: standard-change, with a separate deployment gate.

## Observations

- E1 / OBSERVED: live history lists 12 reports, including 214 occupancy rows and 214 gross rows, while the 2026 dashboard shows zero. Rebuilding the live cache did not resolve this.
- E2 / OBSERVED: live entry asset `index-CH-Xb81O.js` lacks the startup data gate. Cloudflare serves version `983d4ab9-bb9d-4b4d-99ba-c800847c641d` at 100%; the existing hydration fix `feb893b0-c134-4b96-9621-eb561646334c` is at 0%, pending browser validation.
- C1 / INFERRED from E1/E2: the old deployed client can display manifest history without restoring the underlying reports. Commit `615a178` already fixes initial hydration locally; the release still needs live validation.
- E3 / OBSERVED: five rendered regression tests failed before changes: paid payroll called absent, drafts called absent, gross-only revenue omitted, ancillary revenue omitted, and deductions/percentages mislabeled at zero revenue.

## Contract and review invariants

Preserve imported reports, payroll commitments, property access, integer-cent revenue arithmetic, and protected files. Do not re-upload reports, modify payroll, migrate data, or change authentication. Runtime changes cover dashboard readouts, hydration ordering, compressed storage reads, and verified historical property aliases.

Five acceptance scenarios: paid payroll; draft payroll; gross-only reports; occupancy plus gross without double counting; deductions with zero revenue. All five pass after the patch. Existing startup tests also cover empty/stale browsers, retry, isolation, exact totals, and restoring without upload.

## Changes

ModuleCards uses the shared gross-revenue calculation and reports paid versus approved/absent payroll truthfully. MoneyKept reports existing deductions even at zero revenue and leaves the percentage undefined when its revenue denominator is zero.

## Verification

- PASS: dashboard and routing tests, 10/10; all five new cases failed against the prior implementation.
- PASS: production hydration regression; gross-revenue probe 49/49; failed cost-read gate 14/14.
- PASS: lint, production build, and Wrangler deploy dry run.
- PASS: typecheck after correcting two test-only typing issues.
- UI skill search was unavailable because its bundled `core.py` is missing; used the skill's general feedback and empty-state guidance.

## Release gate

Target: `boston-project.divyesh-boston.workers.dev`. Build: `dist`, latest entry `index-rIT9s41Q.js`, includes the startup gate. Worker reads changed; no binding, secret, or database migration changes. Prior release reference: `983d4ab9-bb9d-4b4d-99ba-c800847c641d` (known to exhibit the original zero dashboard).

Owner explicitly authorized deployment and live verification. Initial deployment `5aa96c8a-dc25-42a9-9692-55c13e2ce694` exposed a startup deadlock during live acceptance.

E4 / OBSERVED: forced snapshot hydration awaited aggregate rebuilding. The rebuild reads the wrapped entities, whose freshness barrier awaits the same hydration promise. A new regression reproduces the circular wait with a one-second deadline. Removing the internal rebuild lets startup's existing post-hydration rebuild run after reports finish restoring. No freshness or authorization guard was weakened. `src/api/businessSync.js` is the additional runtime file changed.

PASS: 40 tests across business sync, the deadlock regression, dashboard readouts, and routing; the deadlock test failed before the repair. The production hydration probe also passes after this change. Final release/live acceptance in progress.

## Additional live findings and repairs

- E5 / OBSERVED: after removing the circular wait, startup reported an incorrect gzip header. GCS can transcode gzip objects, and Workers fetch independently decodes Content-Encoding. The storage adapter now requests gzip explicitly and uses `encodeResponseBody: "manual"` to preserve archive bytes. Live startup then advanced beyond decompression. The storage probe now downloads a real gzip fixture and checks byte equality and successful decompression; 287 assertions pass.
- E6 / OBSERVED: startup next reported an invalid bundle property. Upload validation accepts the browser's historical alias while object metadata and manifests use canonical server IDs. Read-only production D1 inspection confirmed 12 active manifests and the historical n:1 mapping. The manifest feed now publishes only aliases resolved unambiguously through the account's active generation and caller scope. Hydration validates rows against those aliases, verifies original hashes/counts, then materializes canonical property IDs. No source files are rewritten. The property-identity probe now covers the full upload-to-hydration path and rejects other-property and malformed aliases; 16 scenarios pass.
- References for E5: https://docs.cloud.google.com/storage/docs/transcoding and https://github.com/cloudflare/workerd/blob/main/src/workerd/api/http.h (RequestInitializerDict.encodeResponseBody).

## Latest deployment and outstanding acceptance

Deployment `a74137df-5c16-410b-b0f4-7d32d355c937` completed successfully. It includes all repairs above and the normal production build. A temporary passive startup diagnostic used during investigation was removed by rebuilding and redeploying; it is not in source or the final asset set.

E7 / OBSERVED: Chrome refuses the new entry script with `net::ERR_BLOCKED_BY_CLIENT`. The user also reports the diagnostic's asset-load failure for that same script. Direct HTTP checks return 200 and exact SRI hashes for every HTML entry/preload/CSS resource; the entry also matches with identity, gzip, Brotli, and Zstandard negotiation. The precise browser-side blocker is UNKNOWN. The browser tool prohibits chrome://extensions/ inspection, so identifying the extension requires user assistance. No blocker or browser security setting was disabled.

PASS: latest lint, typecheck, build, V3, 40 targeted unit/rendered tests, production hydration regression, property-identity 16 scenarios, bulk integrity 17 scenarios, storage 287 assertions, chunk graph 11 checks, SRI 20 checks. The full verify:all suite was NOT_RUN; targeted coverage follows affected runtime boundaries.

## Property roster association and final acceptance

E8 / OBSERVED: the browser subsequently loaded deployment a74137. The portfolio showed 214 days (2026-01-01 through 2026-08-02), $1,020,598.17 gross revenue, 12,362 rooms sold, and 57.8% occupancy. Selecting Middleboro still showed zero: restored reports used canonical server IDs while the local Property roster retained numeric ID 1.

Hydration now resolves the exact typed local roster ID using only the canonical ID and server-proven aliases, after verifying the original bundle hash and counts. It rejects multiple roster matches. It materializes report rows and import history under that local ID and removes obsolete derived aggregates for the same verified identity before rebuilding. Server manifests, source archives, and payroll records remain unchanged. This supersedes E6's canonical local materialization.

PASS: the property-identity regression seeds a numeric roster ID and stale canonical aggregates, verifies the exact numeric report/history association and obsolete aggregate cleanup, and retains cross-property rejection. The 16 identity scenarios, 17 integrity scenarios, production hydration regression, lint, typecheck, build, 11 chunk checks, and 20 SRI checks pass after this change.

Deployment `9a7c3f30-9b6a-4ec2-982d-5a8869913eff` was confirmed at 100% traffic. E9 / OBSERVED: both portfolio and selected Middleboro now show 214 days, $1,020,598.17 gross, 12,362 rooms, and 57.8% occupancy. The property ranking now names Middleboro correctly. Startup completed in approximately two minutes.

E10 / OBSERVED: the portfolio ranking total still displayed 0% occupancy and $0 RevPAR because perPropertyStats omitted the capacity field consumed by PropertyRanking. It now exposes the already-calculated available room nights. A rendered two-property test failed before and passed after, verifying weighted occupancy 50% and RevPAR $50.

E11 / OBSERVED: import history showed 24 entries, pairing each server manifest with its hydrated local copy. Their stable bundle IDs match, but property IDs and the gross report label differ between local and server representations. mergeImportHistory now prioritizes the active manifest by exact bundle ID. This changes display merging only and deletes no records or archives. A regression reproduces the duplicate before the fix and confirms one authoritative entry after it.

Final release `51f8bfe8-61e7-4e90-bfb3-73be1ba3116c` includes E10/E11 and is confirmed at 100% traffic. PASS: 45 targeted tests across five files, lint, typecheck, build, capacity probe 68 assertions, hotel stats probe 40 assertions, and SRI 20 checks. Direct production HTTP checks return 200 and matching SHA-384 for all seven declared entry/preload/style resources.

E12 / OBSERVED: final live Import Reports displays exactly 12 total imports / 12 matching, including the original 214-row occupancy and gross reports, with no re-upload or source deletion.

E13 / OBSERVED / PASS: final live Executive Hub shows $1,020,598.17 total revenue, 12,362 rooms sold out of 21,400 available, 57.8% occupancy, ADR $81.80, and RevPAR $47.26 for January 1 through August 2, 2026 (214 days). The portfolio ranking total now also shows 57.8% and $47.26. Portfolio payroll shows 16 paid / $36,800, with estimated money kept $847,517.71. The dashboard is left open on All Properties. Screenshot: `C:/Users/Divyesh/.codex/visualizations/2026/09/25/01a0dacc-a0d0-7fb3-854d-c0e431fe0800/dashboard-repaired.png`.

Limitations: full startup restoration still takes approximately two minutes in this browser; performance optimization was not part of these correctness repairs. The existing weather integration reports unavailable server credentials and uses its labelled demo fallback; it was not changed.

Read-only inspection found existing PayrollRun records have an empty property ID. They remain portfolio-level; no payroll assignments were inferred or changed. Changes remain uncommitted locally; pre-existing .tmp content was preserved.
