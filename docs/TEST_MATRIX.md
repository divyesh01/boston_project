# Test Matrix — which suite covers this area

One row per suite. **Area** keys are the ones in
[`docs/AI_REPO_GUIDE.md`](AI_REPO_GUIDE.md); this table adds the suites that guide's
*Proves it* column has no room for, and the exact command for each.

Every command below was executed and exited 0 on 2026-09-03. `npm run map:verify`
re-checks that each suite file still exists and each command still resolves.

| Area | Suite | Kind | Command |
|---|---|---|---|
| HotelKey import | `src/lib/hotelKeyParserFixtures.test.js` | vitest | `npx vitest run src/lib/hotelKeyParserFixtures.test.js` |
| HotelKey import | `src/lib/hotelKeyImportFixtures.test.js` | vitest | `npx vitest run src/lib/hotelKeyImportFixtures.test.js` |
| HotelKey import | `scripts/probe-hotelkey-mutations.mjs` | probe | `node scripts/probe-hotelkey-mutations.mjs` |
| Revenue/KPIs | `scripts/probe-financial-invariant.mjs` | probe | `node --import ./scripts/_loader-boot.mjs scripts/probe-financial-invariant.mjs` |
| Revenue/KPIs | `scripts/probe-decimal-integration.mjs` | probe | `node --import ./scripts/_loader-boot.mjs scripts/probe-decimal-integration.mjs` |
| Revenue/KPIs | `scripts/verify-money-kept.mjs` | verify | `node --import ./scripts/_loader-boot.mjs scripts/verify-money-kept.mjs` |
| Transactions | `scripts/verify-transactions.mjs` | verify | `node --import ./scripts/_loader-boot.mjs scripts/verify-transactions.mjs` |
| Transactions | `scripts/probe-dedupe-indexed-lookup.mjs` | probe | `node --import ./scripts/_loader-boot.mjs scripts/probe-dedupe-indexed-lookup.mjs` |
| Property isolation | `scripts/probe-worker-scope.mjs` | probe | `node scripts/probe-worker-scope.mjs` |
| Property isolation | `scripts/probe-business-sync-isolation.mjs` | probe | `node scripts/probe-business-sync-isolation.mjs` |
| Business sync | `scripts/probe-worker-business-sync.mjs` | probe | `node scripts/probe-worker-business-sync.mjs` |
| Business sync | `src/api/businessSync.test.js` | vitest | `npx vitest run src/api/businessSync.test.js` |
| Business sync | `scripts/verify-coexistence.mjs` | verify | `node --import ./scripts/_loader-boot.mjs scripts/verify-coexistence.mjs` |
| Auth | `scripts/probe-worker-app-auth.mjs` | probe | `node scripts/probe-worker-app-auth.mjs` |
| Auth | `scripts/probe-worker-credential-lifecycle.mjs` | probe | `node scripts/probe-worker-credential-lifecycle.mjs` |
| Auth | `src/api/authServer.test.js` | vitest | `npx vitest run src/api/authServer.test.js` |
| IndexedDB | `src/tests/dataIntegrity.test.js` | vitest | `npx vitest run src/tests/dataIntegrity.test.js` |
| IndexedDB | `scripts/probe-db-archive.mjs` | probe | `node --import ./scripts/_loader-boot.mjs scripts/probe-db-archive.mjs` |
| Payroll | `scripts/probe-payroll-entry-parity.mjs` | probe | `node --import ./scripts/_loader-boot.mjs scripts/probe-payroll-entry-parity.mjs` |
| Payroll | `scripts/probe-payroll-cent-aggregation.mjs` | probe | `node --import ./scripts/_loader-boot.mjs scripts/probe-payroll-cent-aggregation.mjs` |
| Payroll | `src/api/autoPayroll.test.js` | vitest | `npx vitest run src/api/autoPayroll.test.js` |
| Payments/refunds | `src/lib/refundClassification.test.js` | vitest | `npx vitest run src/lib/refundClassification.test.js` |
| Payments/refunds | `src/lib/refundAuditFilters.test.js` | vitest | `npx vitest run src/lib/refundAuditFilters.test.js` |
| Payments/refunds | `scripts/probe-parse-amount.mjs` | probe | `node scripts/probe-parse-amount.mjs` |
| Deployment | `scripts/probe-deploy-config.mjs` | probe | `node scripts/probe-deploy-config.mjs` |
| Deployment | `scripts/verify-all.mjs` | gate | `npm run verify:all` |

## Kinds

| Kind | What it is | How it runs |
|---|---|---|
| `vitest` | jsdom unit/integration suite under `src/` | `npx vitest run <path>` |
| `probe` | standalone Node harness pinning one behaviour | `node scripts/probe-*.mjs` |
| `verify` | broader Node regression suite over an area | `node scripts/verify-*.mjs` |
| `gate` | runs many suites; the pre-deploy sweep | `npm run <script>` |

## The one command that decides bare vs loader

A `probe-`/`verify-` script that imports `@/lib/…` **must** be launched with
`node --import ./scripts/_loader-boot.mjs`. Bare `node` fails it with
`ERR_MODULE_NOT_FOUND: Cannot find package '@/lib'`, `Error: Invalid URL`, or
`ReferenceError: Worker is not defined` — three errors that read exactly like the
repository is broken when nothing is wrong but the launch line.

`_loader-boot.mjs` registers the `@/` resolver *before* hoisted static imports run,
installs the DOM shims from `_dom-shims.mjs`, and sets `VITE_USE_LOCAL_AUTH=true`.
Some probes register the resolver themselves (`probe-parse-amount.mjs`) and some use
only relative imports (`probe-worker-*.mjs`) — those run bare. When unsure, use the
loader form; it is harmless where it is not needed. The Command column above is the
form that was actually executed, so copy it rather than reconstructing it.

## Suites this table deliberately omits

- **`scripts/verify-repo-map.mjs`** — the gate for the three routing documents
  themselves, run by `npm run map:verify`. It belongs to no single area, so it has no
  row here; a row would force a false ownership claim.
- **`scripts/probe-repo-map-gate.mjs`** — the mutation harness that proves that gate
  can still fail, run by `npm run map:mutate`. Same reason, plus one of its own: it
  rewrites the routing documents in place and restores them, so a run killed by the
  sweep's per-suite timeout would leave a tracked document modified. Both carry an
  `EXCLUDE` entry in `scripts/verify-all.mjs` stating exactly that.
- **`scripts/verify-brain.mjs`** — the `BRAIN`/`docs/brain/` anti-rot and citation
  gate, run by `npm run brain:verify` and by `.git/hooks/pre-commit`. Same reason.
- **`src/lib/hotelKeyRegression.test.js`** — the filename says HotelKey; the imports
  are `financialReconciliation`, `yieldOptimizer` and `fraudScoringEngine`. It touches
  no parser and is not HotelKey coverage. `PROJECT_MAP.md` cited it as such until this
  commit; `map:verify` check C8 now rejects that class of claim automatically.
- The other ~120 scripts in `scripts/`. `npm run verify:all` discovers every
  `probe-*`/`verify-*`/`test_*` `.mjs` file by name, so a new suite needs no
  registration anywhere — but if it covers one of the ten areas, add its row here.
