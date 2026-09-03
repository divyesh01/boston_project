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

**[`docs/AI_REPO_GUIDE.md`](docs/AI_REPO_GUIDE.md) answers this.** It maps ten
subsystems — HotelKey import, Revenue/KPIs, Transactions, Property isolation, Business
sync, Auth, IndexedDB, Payroll, Payments/refunds, Deployment — to the 3–5 files you
read, the suite that proves the change, the exact gate command, and the files you must
not edit. `npm run map:verify` fails the commit when any of that stops being true, so
it is the one place worth trusting first.

This file keeps only what the routing layer has no column for.

| To change | Go to | Notes |
|---|---|---|
| **Off-thread parsing** | `src/lib/csvParser.js` | Large files are parsed off the main thread: it spawns `src/lib/parser.worker.js` as a Web Worker. Manual rows take a different path: `src/lib/manualEntryImport.js` → `src/lib/manualEntrySave.js`. |
| **Revenue thresholds** | `src/lib/revenueThresholds.js` | The tolerance band the reconciliation in `src/lib/RevenueReconciliation.js` compares against. |
| **D1 persistence / schema** | `worker/schema.sql`, `migrations-production/` | Production table names are **singular**: `user`, `account`, `property`, `app_session`. Querying `users` fails. |
| **Migration UI** | `src/components/BusinessMigrationCard.jsx` | Rendered from `src/pages/Import.jsx`; the route is **`/upload`**, gated by the `import_reports` permission. |
| **Session cookie** | `worker/app-auth.js` | The browser gets only `__Host-rri_session`, HttpOnly. Session state itself lives in D1 `app_session`. |
| **Dashboard KPIs** | `src/pages/Dashboard.jsx`, `src/components/dashboard/` | 13 KPI components; each owns one card. |
| **Tests / probes** | `scripts/` | See the convention below — the filename decides whether it runs. |

Every backticked path in the table above is machine-checked (`map:verify` check C9), so
a row that points at a deleted file fails the commit that deleted it.

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
compares them **header by header** — not as whole files — and also asserts
`public/_headers` is non-empty, uses LF endings, and is pinned to LF by
`.gitattributes`. Editing one without the other fails the suite.
Read the header comment in `public/_headers` before touching either.

## Pre-commit gates you will meet

- `scripts/verify-brain.mjs` — staging any `src/`, `base44/`, or `scripts/` path
  requires a `BRAIN`/`docs/brain/` edit in the **same** commit, and any
  `file.ext:NNN` citation you add must be within that file's real line count.
  Prefer citing the **symbol**; keep line numbers for things a probe pins.
- `scripts/verify-repo-map.mjs` — the routing layer must still match the tree:
  `docs/AI_REPO_GUIDE.md`, `docs/TEST_MATRIX.md`, `docs/MODULE_CONTRACTS.md` and the
  table in this file. Run it with `npm run map:verify`; prove it can still fail with
  `npm run map:mutate`.
- Neither runs inside `npm run verify:all` — they are documentation gates, and both
  carry an `EXCLUDE` entry there saying so.
- Never `--no-verify`, force-push, or rewrite history.

## Before you decompose a large file

Read `TECH_DEBT.md`. It ranks the repository's oversized modules by *danger*, not line
count, and each row records the safe module boundary, the real risk, and the proof
obligation that must be satisfied first. Two of the three largest files are listed in
`PROTECTED_FILES.md` and cannot be split without owner authorization. Two more sit on the
live cross-browser rollout path and are explicitly deferred until that rollout is verified.

## Keeping this file honest

The diagram and the prose here are hand-maintained and **not** machine-checked — only
the table above is (check C9). When you add, move, or delete a module, update this file
in the same commit as the code move. If you find a line that no longer matches the tree,
correct it rather than working around it — a wrong map costs every later agent a full
scan. For anything the ten areas cover, change
[`docs/AI_REPO_GUIDE.md`](docs/AI_REPO_GUIDE.md) instead; that is where the gate looks.
