# AI Repo Guide — start here

You are about to change something in a hotel revenue system. One React SPA plus one
Cloudflare Worker on one origin; money is integer cents; every property is isolated.
Find your area below, read those files, run that gate, touch nothing in the last column.

**This table is machine-verified.** `npm run map:verify` fails the commit when a path,
symbol, test or command in it no longer exists — see "The contract" at the bottom.

| Area | Read first | Proves it | Gate | Never touch |
|---|---|---|---|---|
| HotelKey import | `src/lib/reportParsers.js#parseReport`, `src/lib/universalParser.js#parseHotelReport`, `src/lib/importValidation.js#validateImport`, `src/lib/csvParser.js#parseTextInWorker` | `src/lib/hotelKeyParserFixtures.test.js`, `src/lib/hotelKeyImportFixtures.test.js` | `npx vitest run src/lib/hotelKeyParserFixtures.test.js` | `src/api/base44Client.js` |
| Revenue/KPIs | `src/lib/decimal.js#sumCents`, `src/lib/RevenueReconciliation.js#revenueReconciliation`, `src/lib/financialReconciliation.js#enforceFinancialInvariant`, `src/lib/dailyAggregates.js#rebuildDailyAggregates` | `scripts/probe-financial-invariant.mjs`, `scripts/probe-decimal-integration.mjs` | `node --import ./scripts/_loader-boot.mjs scripts/probe-financial-invariant.mjs` | `src/lib/validator.js` |
| Transactions | `src/lib/transactionNorm.js#assignDedupeKeys`, `src/lib/transactionAnalytics.js#summarize`, `src/pages/Transactions.jsx` | `scripts/verify-transactions.mjs`, `scripts/probe-dedupe-indexed-lookup.mjs` | `node --import ./scripts/_loader-boot.mjs scripts/verify-transactions.mjs` | `src/api/base44Client.js` |
| Property isolation | `worker/scope.js#scopeConstraint`, `worker/entities.js#ENTITY_CONTRACT`, `worker/db.js` | `scripts/probe-worker-scope.mjs`, `scripts/probe-business-sync-isolation.mjs` | `node scripts/probe-worker-scope.mjs` | `src/lib/permissions.js` |
| Business sync | `worker/business-sync.js#handleBusinessSyncRequest`, `src/api/businessSync.js#createBusinessSyncClient`, `src/components/BusinessMigrationCard.jsx` | `scripts/probe-worker-business-sync.mjs`, `src/api/businessSync.test.js` | `node scripts/probe-worker-business-sync.mjs` | `src/api/base44Client.js` |
| Auth | `worker/app-auth.js#authenticateAppSession`, `worker/password-credential.js#verifyCredential`, `src/lib/AuthContext.jsx` | `scripts/probe-worker-app-auth.mjs`, `scripts/probe-worker-credential-lifecycle.mjs` | `node scripts/probe-worker-app-auth.mjs` | `src/lib/AuthContext.jsx`, `src/pages/Login.jsx` |
| IndexedDB | `src/api/localDb.js#default`, `src/lib/dbArchive.js`, `src/lib/importReset.js#clearAllImportedData` | `src/tests/dataIntegrity.test.js`, `scripts/probe-db-archive.mjs` | `npx vitest run src/tests/dataIntegrity.test.js` | `src/api/base44Client.js` |
| Payroll | `src/lib/payrollCalc.js#buildPayrollRunRecord`, `src/pages/Payroll.jsx` | `scripts/probe-payroll-entry-parity.mjs`, `scripts/probe-payroll-cent-aggregation.mjs` | `node --import ./scripts/_loader-boot.mjs scripts/probe-payroll-entry-parity.mjs` | `src/lib/permissions.js` |
| Payments/refunds | `src/lib/paymentNorm.js#refundTotal`, `src/lib/refundClassification.js#classifyRefund`, `src/lib/refundAuditFilters.js#filterAuditRefunds`, `src/pages/Payments.jsx` | `src/lib/refundClassification.test.js`, `src/lib/refundAuditFilters.test.js` | `npx vitest run src/lib/refundClassification.test.js` | `src/api/base44Client.js` |
| Deployment | `wrangler.jsonc`, `public/_headers`, `vercel.json` | `scripts/probe-deploy-config.mjs` | `node scripts/probe-deploy-config.mjs` | `src/api/base44Client.js` |

## Reading the columns

- **Read first** — at most 5 files; the gate rejects a sixth. If your change needs
  one, you are in two areas — do them as two changes. Fewer is fine when the area
  really is that small.
- **Proves it** — a suite that actually imports something from *Read first*. The gate
  checks that link, so you cannot cite a test that never touches the module.
- **Gate** — the exact command. `verify-*`/`probe-*` scripts that import `@/…`
  aliases need `--import ./scripts/_loader-boot.mjs`; bare `node` fails them with
  `Cannot find package '@/lib'`, which reads like repo rot and is not.
- **Never touch** — read it, never edit it. Everything listed there is in
  [`PROTECTED_FILES.md`](../PROTECTED_FILES.md) and needs owner authorization.

## Three rules that outrank convenience

1. **Money is integer cents.** `src/lib/decimal.js#sumCents`, never float `+`/`-` on
   dollars. Transactions and Statistics YTD must reconcile to the exact cent.
2. **Property isolation is server-side.** `worker/scope.js#scopeConstraint` builds the
   `property_id IN (…)` constraint. Client-side role checks are UX, not a boundary.
3. **Imports are hostile input.** Malformed headers, CRLF, quoted commas, unicode and
   re-imports of the same report all have fixtures. Never silently drop a row.

## Where else to look

| Question | Document |
|---|---|
| Which suite covers this area, and what kind is it? | [`docs/TEST_MATRIX.md`](TEST_MATRIX.md) |
| What invariant does this module own? | [`docs/MODULE_CONTRACTS.md`](MODULE_CONTRACTS.md) |
| How is the system wired end to end? | [`PROJECT_MAP.md`](../PROJECT_MAP.md) — diagram, routing, D1 schema, hosting |
| What may I not edit? | [`PROTECTED_FILES.md`](../PROTECTED_FILES.md) |
| Which large file is safe to split, and what proof first? | [`TECH_DEBT.md`](../TECH_DEBT.md) |
| Deeper subsystem notes | [`docs/brain/BRAIN_INDEX.md`](brain/BRAIN_INDEX.md) |

## The contract

`scripts/verify-repo-map.mjs` parses the three tables in this guide,
`docs/TEST_MATRIX.md` and `docs/MODULE_CONTRACTS.md`, then fails on: a path that no
longer exists · a `#symbol` that is no longer exported · a test or probe that is not a
suite · a gate command that resolves to nothing · a protected file mislabelled or
pointed at without a warning · a missing area, empty cell or >5 files · a duplicated
or conflicting mapping · a *Proves it* suite that never reaches its *Read first* module
· a dead path in [`PROJECT_MAP.md`](../PROJECT_MAP.md)'s table, so the map this layer
sits on cannot rot underneath it either.

```bash
npm run map:verify
```

Run it before you commit — the pre-commit hook runs it for you. When you move code,
fix the row in the **same** commit. Cite a `#symbol`, never a line number; symbols
survive edits and line numbers rot within a day.

A gate that cannot fail is decoration, so this one is mutation-tested: `npm run
map:mutate` rewrites one document at a time to reproduce seventeen failure modes — at
least one per check id except `C6-shape` — asserts each is caught by that exact id,
restores every file byte-identically, and re-runs the gate green. A `finally` plus
SIGINT/SIGTERM handlers restore whatever is in flight, so a throw or a Ctrl-C cannot
leave a broken document behind. It stays outside `npm run verify:all` because that
sweep enforces its per-suite timeout with `SIGKILL`, which no handler can catch.

```bash
npm run map:mutate
```
