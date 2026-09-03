# Project Map — Where Do I Go To Change X?

Navigation for developers and AI agents. Every path below was derived from source,
not from memory. If a path here disagrees with the tree, the tree wins — fix this file.

**Read first:** `PROTECTED_FILES.md` (14 files no agent may edit without owner
authorization), then `BRAIN.md` (AI hub) or `README.md` (human setup).

## The shape of the system

One React SPA and one Cloudflare Worker, served from the same origin.

```
Browser (React SPA, Vite)                Cloudflare Worker            D1 (SQLite)
  src/pages/*  src/components/*            worker/index.js              user
        |                                        |                      account
        v                                        v                      property
  src/api/base44Client.js  --HTTP-->      worker/app-auth.js            app_session
  src/api/businessSync.js  --HTTP-->      worker/business-sync.js       business_record
        |                                  worker/entities.js           business_dataset*
        v                                        |                      user_property_access
  src/api/localDb.js (IndexedDB cache)  <--------+
```

`wrangler.jsonc` declares `main: worker/index.js`, serves `dist/` as static assets,
and sets `run_worker_first: ["/api/*"]` — so the SPA and the API share one origin and
there is no separate API host. **`base44/` is the historical generated backend and is
no longer the live auth or data path** — do not send agents there to change behavior.

## Routing

`src/App.jsx` is the router (`react-router-dom`, `<Routes>` inside the
`ProtectedRoutes` component). **There is no `src/pages/index.jsx`.** To add or
change a page, edit `src/App.jsx` and the page file under `src/pages/`.

Note: `ProtectedRoutes` (plural, declared locally in `src/App.jsx`) and
`src/components/ProtectedRoute.jsx` (singular) are different things.

## Where do I go to change…

| To change | Go to | Notes |
|---|---|---|
| **HotelKey report parsing** | `src/lib/reportParsers.js`, `src/lib/universalParser.js` | Regression fixture: `src/lib/hotelKeyRegression.test.js`. |
| **CSV / XLSX import** | `src/lib/csvParser.js`, `src/pages/Import.jsx` | Large files are parsed off the main thread — `csvParser.js` spawns `src/lib/parser.worker.js` as a Web Worker. Validation gate: `src/lib/importValidation.js`. Undo path: `src/lib/importReset.js`. Manual rows: `src/lib/manualEntryImport.js` → `src/lib/manualEntrySave.js`. |
| **Transaction normalization** | `src/lib/transactionNorm.js` | Also owns dedup keys. Payment-shape normalization is separate: `src/lib/paymentNorm.js`. |
| **Deduplication** | `src/lib/transactionNorm.js`, `src/lib/reportParsers.js` | Re-importing the same report must not double-count. |
| **Daily aggregates** | `src/lib/dailyAggregates.js` | Feeds Statistics and Dashboard. |
| **Revenue calculations** | `src/lib/RevenueReconciliation.js`, `src/lib/financialReconciliation.js` | Thresholds: `src/lib/revenueThresholds.js`. |
| **Money math (always)** | `src/lib/decimal.js` | Defines `sumCents`. Integer cents only — no float `+`/`-` on dollars. |
| **Property isolation (server)** | `worker/scope.js` | Builds the `property_id IN (…)` constraint. Enforcement helpers: `scopedRecordClause` in `worker/business-sync.js`, `scopedWhere` in `worker/entities.js`. |
| **Permissions / roles (client)** | `src/lib/permissions.js` | **Protected file.** |
| **D1 persistence / schema** | `worker/schema.sql`, `migrations-production/` | Production table names are **singular**: `user`, `account`, `property`, `app_session`. Querying `users` fails. |
| **Browser cache (IndexedDB)** | `src/api/localDb.js` | The cache, not the source of truth, once server sync is on. |
| **Business sync (client)** | `src/api/businessSync.js` | Staged upload, chunking, snapshot hydrate. |
| **Business sync (server)** | `worker/business-sync.js` | Migration start / chunk upload / activate / rollback, and its gates. |
| **Migration UI** | `src/components/BusinessMigrationCard.jsx` | Rendered from `src/pages/Import.jsx`; the route is **`/upload`**, gated by the `import_reports` permission. |
| **Authentication (server)** | `worker/app-auth.js` | Sessions live in D1 `app_session`; the browser gets only the `__Host-rri_session` HttpOnly cookie. |
| **Password hashing** | `worker/password-credential.js` | `PBKDF2_ITERATIONS` is the single source of truth for iteration count. |
| **Auth state (client)** | `src/lib/AuthContext.jsx` | **Protected file.** |
| **Payroll** | `src/lib/payrollCalc.js`, `src/pages/Payroll.jsx` | |
| **Payments / refunds** | `src/lib/paymentNorm.js`, `src/lib/refundClassification.js`, `src/pages/Payments.jsx` | Audit filters: `src/lib/refundAuditFilters.js`. |
| **Dashboard KPIs** | `src/pages/Dashboard.jsx` + `src/components/dashboard/` | 13 KPI components; each owns one card. |
| **Tests / probes** | `scripts/` | See the convention below — the filename decides whether it runs. |
| **Deployment** | `wrangler.jsonc`, `public/_headers`, `vercel.json` | See "Two hosting configs" below. |

## The scripts/ naming convention is load-bearing

`scripts/verify-all.mjs` executes a file as a suite **only** if the basename ends
`.mjs` **and** starts with `probe-`, `verify-`, or `test_`, **and** does not start
with `_`. A file named `test-thing.mjs` (hyphen) is silently never run. Name new
suites `probe-<issue>.mjs` or `verify-<area>.mjs`.

Run everything: `npm run verify:all`. Governance: `npm run verify:v3`.
Typecheck is `npm run typecheck` (`tsc -p ./jsconfig.json`), not a bare `tsc --noEmit`.

## Two hosting configs, deliberately mirrored

`public/_headers` (Cloudflare, the live host) and `vercel.json` (unused platform)
carry the **same** security headers on purpose. `scripts/probe-deploy-config.mjs`
asserts they are byte-equal, so editing one without the other fails the suite.
Read the header comment in `public/_headers` before touching either.

## Pre-commit gates you will meet

- `scripts/verify-brain.mjs` — staging any `src/`, `base44/`, or `scripts/` path
  requires a `BRAIN`/`docs/brain/` edit in the **same** commit, and any
  `file.ext:NNN` citation you add must be within that file's real line count.
  Prefer citing the **symbol**; keep line numbers for things a probe pins.
- Never `--no-verify`, force-push, or rewrite history.

## Before you decompose a large file

Read `TECH_DEBT.md`. It ranks the repository's oversized modules by *danger*, not line
count, and each row records the safe module boundary, the real risk, and the proof
obligation that must be satisfied first. Two of the three largest files are listed in
`PROTECTED_FILES.md` and cannot be split without owner authorization. Two more sit on the
live cross-browser rollout path and are explicitly deferred until that rollout is verified.

## Keeping this file honest

This map is hand-maintained. When you add, move, or delete a module, update the row
here in the same commit. If you find a row that no longer matches the tree, correct
it rather than working around it — a wrong map costs every later agent a full scan.
