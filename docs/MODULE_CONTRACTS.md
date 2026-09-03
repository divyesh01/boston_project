# Module Contracts — what each module owns

One row per module: the invariant it is responsible for, how dangerous it is to edit,
and which [`docs/AI_REPO_GUIDE.md`](AI_REPO_GUIDE.md) area it belongs to.

If your change breaks the invariant in a row, you are not fixing that module — you are
redefining it, and the area's gate exists to stop you. `npm run map:verify` checks that
every module and symbol below still exists and that `PROTECTED` matches
[`PROTECTED_FILES.md`](../PROTECTED_FILES.md) exactly, in both directions.

| Module | Invariant | Risk | Area |
|---|---|---|---|
| `src/lib/reportParsers.js#parseReport` | Every row of a HotelKey export is either imported or reported; none is silently dropped. | HIGH | HotelKey import |
| `src/lib/universalParser.js#parseHotelReport` | Report type detection is content-driven; an unrecognised report fails loudly rather than parsing as another type. | HIGH | HotelKey import |
| `src/lib/importValidation.js#validateImport` | Structure, types, constraints and semantics all run before persistence; a `null` amount stays distinguishable from `0`. | HIGH | HotelKey import |
| `src/lib/csvParser.js#parseAmount` | `"$-50.00"` parses as a refund, never as a `+50` charge; unparseable input returns `null`, not `0`. | HIGH | HotelKey import |
| `src/lib/decimal.js#sumCents` | All money is integer cents. No float `+`/`-` on dollars anywhere downstream. | HIGH | Revenue/KPIs |
| `src/lib/RevenueReconciliation.js#revenueReconciliation` | Revenue paths are ranked by a fixed precedence; a disagreement between paths is surfaced, never averaged away. | HIGH | Revenue/KPIs |
| `src/lib/financialReconciliation.js#enforceFinancialInvariant` | Transaction charges and Statistics YTD reconcile to the exact cent, or the invariant throws. | HIGH | Revenue/KPIs |
| `src/lib/dailyAggregates.js#rebuildDailyAggregates` | A rebuild is a pure function of stored rows; aggregates are a cache and never a second source of truth. | NORMAL | Revenue/KPIs |
| `src/lib/validator.js#isValidEmail` | Input-shape validation only. It is not an authorization boundary and must not become one. | PROTECTED | Revenue/KPIs |
| `src/lib/transactionNorm.js#assignDedupeKeys` | Re-importing the same report never double-counts; the dedupe key is stable across imports. | HIGH | Transactions |
| `src/lib/transactionAnalytics.js#summarize` | Summaries read normalized rows only; it derives, never repairs bad upstream data. | NORMAL | Transactions |
| `src/pages/Transactions.jsx` | Shows real stored rows, and distinguishes loading, empty, error and permission-denied. | NORMAL | Transactions |
| `worker/scope.js#scopeConstraint` | Builds the server-side `property_id IN (…)` constraint. Property A can never read property B. | HIGH | Property isolation |
| `worker/entities.js#ENTITY_CONTRACT` | Every entity route declares its scope column; an entity with no declared scope is refused, not defaulted to global. | HIGH | Property isolation |
| `src/lib/permissions.js#canAccessRoute` | Client-side role gating is UX only. The real boundary is the Worker; never treat this as security. | PROTECTED | Property isolation |
| `worker/business-sync.js#handleBusinessSyncRequest` | Staged migration is all-or-nothing: upload, activate, rollback. A partial upload can never become the active generation. | HIGH | Business sync |
| `src/api/businessSync.js#createBusinessSyncClient` | Chunks and checksums what it uploads; a hash mismatch aborts instead of activating. | HIGH | Business sync |
| `src/components/BusinessMigrationCard.jsx` | Requires explicit review before migrating, and never presents an unverified dataset as backed up. | NORMAL | Business sync |
| `worker/app-auth.js#authenticateAppSession` | Sessions live in D1; the browser holds only the `__Host-` HttpOnly cookie. No session state is trusted from the client. | HIGH | Auth |
| `worker/password-credential.js#verifyCredential` | Verification is constant-shape and iteration count is centralised; an upgrade path never weakens an existing credential. | HIGH | Auth |
| `src/lib/AuthContext.jsx#useAuth` | Mirrors server auth state. It reflects the session; it never grants one. | PROTECTED | Auth |
| `src/pages/Login.jsx#default` | The only credential entry point. Failure modes stay indistinguishable to the caller. | PROTECTED | Auth |
| `src/api/localDb.js#default` | The browser cache, not the source of truth once server sync is on. A default export: `import localDb from '@/api/localDb'`, never `{ localDb }`. | HIGH | IndexedDB |
| `src/api/base44Client.js#rollbackImportSession` | An import either fully lands or fully rolls back, including past the 40-row batch boundary. | PROTECTED | IndexedDB |
| `src/lib/importReset.js#clearAllImportedData` | Clears imported data and derived caches together; a reset never leaves a stale aggregate behind. | HIGH | IndexedDB |
| `src/lib/dbArchive.js#archiveChecksum` | An archive is self-describing and checksummed; excluded stores are declared, never guessed at restore time. | NORMAL | IndexedDB |
| `src/lib/payrollCalc.js#buildPayrollRunRecord` | Pay is summed in integer cents and a committed run is immutable. | HIGH | Payroll |
| `src/pages/Payroll.jsx` | Displays committed runs as committed; server-side entity rules, not this page, decide who may write. | NORMAL | Payroll |
| `src/lib/paymentNorm.js#refundTotal` | A refund is negative exactly once. Sign is decided here and never re-applied downstream. | HIGH | Payments/refunds |
| `src/lib/refundClassification.js#classifyRefund` | Every refund lands in exactly one class, with the evidence text that justified it. | HIGH | Payments/refunds |
| `src/lib/refundAuditFilters.js#filterAuditRefunds` | Filtering changes what is shown, never what is totalled from the underlying rows. | NORMAL | Payments/refunds |
| `src/pages/Payments.jsx` | Card fees and refunds are shown as stored, with no page-level money arithmetic. | NORMAL | Payments/refunds |
| `wrangler.jsonc` | One origin: `main` is the Worker, `dist/` is the SPA, `/api/*` runs the Worker first. There is no second API host. | HIGH | Deployment |
| `public/_headers` | The live security headers. Cloudflare is the real host, so this file is authoritative. | HIGH | Deployment |
| `vercel.json` | Deliberately mirrors the live headers for an unused platform; the deploy probe fails if the two drift apart. | NORMAL | Deployment |

## Risk levels

| Risk | Meaning | What you must do |
|---|---|---|
| `PROTECTED` | Listed in [`PROTECTED_FILES.md`](../PROTECTED_FILES.md) | Read it. Do not edit, wrap, shadow, copy to a new name, or monkey-patch it. Owner authorization only. |
| `HIGH` | Money, property isolation, auth, or hostile input | Failing test or probe first, then the smallest fix, then the area gate. |
| `NORMAL` | Presentation or derived data | Normal care; the area gate still runs. |

There is no "low" tier. A module worth naming here is worth a gate.

## Two ownership details that mislead people

- **`PBKDF2_ITERATIONS` is defined in `worker/password-credential.js` but is
  module-private there.** The export surface is `worker/app-auth.js`, which re-exports
  it. Import it from `app-auth`; a `#symbol` citation against `password-credential`
  will fail `map:verify` check C2, correctly.
- **`scopedRecordClause` and `scopedWhere` are not exported** — they are internal to
  `worker/business-sync.js` and `worker/entities.js`. They enforce isolation but cannot
  be cited as symbols or imported by a test; prove them through the area's probes.
