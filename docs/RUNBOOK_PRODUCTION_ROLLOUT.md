# Red Roof Intelligence (RRI) Production Rollout Runbook
## Immutable Bulk Import Data Plane Architecture

**Document Version**: 1.0.0
**Target Release**: Bulk Import Data Plane (`bulk-import-data-plane`)
**Production Worker**: `boston-project`
**Production D1 Database**: `boston-project-production-auth` (`e9008126-d4b4-4588-841c-128eadd94c8d`)
**Production R2 Buckets**: `RAW_ARCHIVE` and `BULK_DATA` (names to be provisioned upon owner authorization)

---

### Strict Operator Notice

> [!CAUTION]
> **NO PRODUCTION ACTION IS PERMITTED WITHOUT EXPLICIT OWNER AUTHORIZATION.**
> Every phase in this runbook is guarded by an explicit **STOP GATE**. If any gate fails or its exit criteria are not met, halt execution immediately. Do not improvise workarounds on production.

---

### Gate 0 — Cloudflare Platform Entitlement (Error 10136 Resolution)

- **Condition**: Cloudflare account must permit Workers to bind to R2 buckets.
- **Verification Command**:
  ```bash
  # Test edge-preview or deployment of canary Worker with R2 bindings
  npx wrangler deploy --config=canary-wrangler.jsonc --dry-run
  ```
- **Pass Criteria**: Cloudflare API does NOT return `10136: "Please enable R2 through the Cloudflare Dashboard"`.
- **STOP IF**: Error 10136 persists. Await Cloudflare Support / account entitlement resolution.

---

### Gate 1 — Feature Branch & Commit SHA Confirmation

- **Verification Command**:
  ```bash
  git fetch origin
  git rev-parse HEAD
  git rev-parse origin/bulk-import-data-plane
  git rev-parse origin/main
  ```
- **Pass Criteria**: `HEAD` matches `origin/bulk-import-data-plane`. `origin/main` remains untouched at `d82ee7bbe3b3fc788a021549bed48c49c570f83d`.
- **STOP IF**: Unexpected commits or divergence found.

---

### Gate 2 — Repository Worktree Cleanliness

- **Verification Command**:
  ```bash
  git status --porcelain=v1
  git diff --check
  ```
- **Pass Criteria**: `git status --porcelain=v1` returns zero lines. `git diff --check` returns zero errors.
- **STOP IF**: Any uncommitted edits or untracked files are present.

---

### Gate 3 — Full Local Quality & Security Gates Green

- **Verification Commands**:
  ```bash
  npm run lint
  npm run typecheck
  npm run test
  npm run build
  npm run verify:v3
  npm run brain:verify
  node scripts/probe-suite-integrity.mjs
  npm run verify:all
  ```
- **Pass Criteria**:
  - `npm run lint`: 0 errors, 0 warnings.
  - `npm run typecheck`: 0 errors.
  - `npm run test`: 56 files, 525+ tests passed, 0 failed.
  - `npm run build`: Vite production bundle builds cleanly in `< 20s`.
  - `npm run verify:v3`: PASS 3.0.0.
  - `npm run verify:all`: 189+ passed, 0 failed, 1 environment skip (`probe-config-exposure.mjs`).
- **STOP IF**: Any test, typecheck, or lint check fails.

---

### Gate 4 — Isolated Canary Worker R2 Binding Attachment

- **Verification Context**: Canary Worker `rri-bulk-canary-a61a110`, canary D1 `7e746318-2280-4907-931d-9c257b62ee78`, canary R2 `rri-raw-canary-a61a110` and `rri-data-canary-a61a110`.
- **Action**: Deploy canary Worker with both R2 bindings and canary D1 attached.
- **Pass Criteria**: Deployment succeeds with version ID returned; `/api/bulk-import/pending` responds with HTTP 200 `{ pending: [] }`.
- **STOP IF**: Any binding error, permission denial, or failure occurs.

---

### Gate 5 — Canary Full Synthetic Import End-to-End

- **Action**: Upload and activate a full synthetic HotelKey report payload (e.g. 8,000 rows, ~150 KB gzip) against the canary Worker.
- **Pass Criteria**:
  - Raw archive uploaded to `rri-raw-canary-a61a110` with verified SHA-256 digest.
  - Normalized NDJSON bundle uploaded to `rri-data-canary-a61a110` with verified content hash.
  - Manifest created in canary D1 with `status = 'active'`, `row_count = 8000`.
- **STOP IF**: Upload fails, hashes mismatch, or manifest status is not `active`.

---

### Gate 6 — Real Cloudflare D1 `rows_written` Capture

- **Action**: Inspect Cloudflare D1 telemetry for the full synthetic import executed in Gate 5.
- **Pass Criteria**: Confirm that physical D1 `rows_written` per import is $O(1)$ with respect to rows (measured $\le 20$ writes).
- **STOP IF**: Write amplification occurs or writes scale linearly with row count.

---

### Gate 7 — Remote Canary Concurrency & Idempotency Races

- **Action**: Run concurrent races against the deployed canary Worker:
  1. Identical simultaneous imports: Exactly 1 manifest created, idempotent HTTP 200 responses.
  2. Overlapping simultaneous imports: Exactly 1 winner commits, loser fails closed with `IMPORT_REPLACEMENT_REQUIRED`.
  3. Stale revision replacement: Fails closed without corrupting active manifest.
- **Pass Criteria**: All concurrency checks pass with zero data corruption or unhandled errors.
- **STOP IF**: Conflicting manifests or duplicate active rows are created.

---

### Gate 8 — Two-Browser Hydration & Convergence Remotely

- **Action**: Simulate Browser A importing a report and Browser B synchronizing via `/api/business-sync/feed`.
- **Pass Criteria**: Browser B materializes identical row count and identical deterministic row IDs in IndexedDB without querying D1 for rows.
- **STOP IF**: Row IDs differ between browsers, or client throws unhandled hydration errors.

---

### Gate 9 — Edge Worker CPU & Memory Headroom

- **Action**: Monitor execution metrics on the canary Worker during Gate 5 and Gate 7.
- **Pass Criteria**:
  - Worker CPU time $\le 10\text{ ms}$ (Free Tier compliance; observed $< 2\text{ ms}$ locally).
  - Worker memory usage $\le 128\text{ MB}$ (safe bounded streaming without buffering full payload in RAM).
- **STOP IF**: CPU limit exceeded (`Error 1101` / `1102`) or memory allocation failure occurs.

---

### Gate 10 — Production Read-Only D1 Pre-Flight Audit

- **Execution Command**:
  ```bash
  npx wrangler d1 execute boston-project-production-auth --remote --file=scripts/audit-production-d1-readonly.sql
  ```
- **Pass Criteria**:
  - `d1_migrations` table contains migrations `0001` through `0004` (confirming `0005` and `0006` are pending).
  - No existing corrupt tables or unresolved foreign key violations (`PRAGMA foreign_key_check` returns empty).
  - Current `business_sync_state` revision recorded.
- **STOP IF**: Migration tracker is in an unexpected state or schema corruptions exist.

---

### Gate 11 — Owner Explicit Production Authorization

- **Requirement**: Provide the complete audit output from Gates 0–10 to the repository owner (Divyesh).
- **Pass Criteria**: Receive explicit, affirmative owner authorization to proceed with production provisioning, migration, and deployment.
- **STOP IF**: Authorization is pending or withheld.

---

### Gate 12 — Production D1 Migration Execution

- **Action**: Apply tracked pending migrations `0005` and `0006` to production D1:
  ```bash
  npx wrangler d1 migrations apply boston-project-production-auth --remote
  ```
- **Pass Criteria**:
  - Migration `0005_bulk_import_manifest.sql` applied cleanly.
  - Migration `0006_bulk_import_integrity.sql` applied cleanly.
  - Re-run `scripts/audit-production-d1-readonly.sql` to confirm:
    - `import_bundle_manifest` table exists with all indexes.
    - `identity_version`, `raw_destroy_requested_at`, `raw_destroyed_at` columns present.
    - `d1_migrations` contains exactly `0001` through `0006`.
- **STOP IF**: Migration fails or halts mid-apply. Consult `docs/RUNBOOK_ROLLBACK_INCIDENT.md`.

---

### Gate 13 — Production R2 Buckets & Wrangler Configuration

- **Action**:
  1. Provision production R2 buckets (e.g. `rri-raw-production-01`, `rri-bulk-production-01`).
  2. Configure `wrangler.jsonc` with production bindings:
     ```jsonc
     "r2_buckets": [
       { "binding": "RAW_ARCHIVE", "bucket_name": "rri-raw-production-01" },
       { "binding": "BULK_DATA", "bucket_name": "rri-bulk-production-01" }
     ]
     ```
- **Pass Criteria**: Buckets exist in production account and are bound to Worker environment.
- **STOP IF**: Bucket creation or binding configuration fails.

---

### Gate 14 — Production Client & Worker Deployment

- **Action**:
  ```bash
  npm run build
  npx wrangler deploy
  ```
- **Pass Criteria**:
  - Build succeeds with Subresource Integrity (SRI) hashes generated.
  - Worker deployment succeeds with live URL confirmed: `boston-project.divyesh-boston.workers.dev`.
- **STOP IF**: Build errors or deployment upload fails.

---

### Gate 15 — Production Post-Deployment Smoke Verification

- **Action**:
  1. Authenticate as owner via `/api/session`.
  2. Verify `/api/bulk-import/pending` returns HTTP 200 `{ pending: [] }`.
  3. Verify that non-bulk routes (`/api/session`, `/api/business-sync/snapshot`, `/api/properties`) operate normally.
- **Pass Criteria**: All verification requests return expected HTTP status codes.
- **STOP IF**: Any endpoint returns 500 or 503 errors.

---

### Gate 16 — Production Telemetry & Stability Observation

- **Action**: Monitor Cloudflare Worker metrics (logs, CPU time, status codes) for 30 minutes following deployment.
- **Pass Criteria**:
  - Error rate is 0%.
  - Zero unhandled exceptions or 503 `IMPORT_STORAGE_UNAVAILABLE` errors.
- **STOP IF**: Elevated error rates or timeouts are observed.

---

### Gate 17 — Production Feature Enablement & Transition Sign-Off

- **Action**: Announce production readiness for bulk HotelKey imports. Existing legacy D1 data remains intact and continues serving read queries until overridden by covered bulk imports.
- **Sign-Off**: Complete rollout summary documented in `docs/brain/BRAIN_BACKEND.md`.
