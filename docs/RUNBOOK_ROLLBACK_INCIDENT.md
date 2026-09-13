# Red Roof Intelligence (RRI) Incident & Rollback Runbook
## Bulk Import Data Plane & Control Architecture

**Document Version**: 1.0.0
**Target Architecture**: Cloudflare D1 + R2 Immutable Bulk Import Data Plane

---

### Core Principles

1. **Non-Destructive First Response**: Never execute unhedged `DELETE`, `DROP`, or `TRUNCATE` queries against production D1 or R2 during an incident.
2. **Immutable Source Preservation**: Raw files in R2 `RAW_ARCHIVE` (`rri-raw/*`) are permanent historical source documents. Never delete or overwrite them to resolve an analytics parsing issue.
3. **Fail-Closed Safety**: If storage bindings or permissions are missing or ambiguous, the application must return controlled 503/403 responses and abort transactions rather than corrupting state.

---

### Incident Classification & Action Levels

| Level | Definition | Examples | Permitted Actions |
| :--- | :--- | :--- | :--- |
| **SAFE AUTOMATIC RETRY** | Transient network or concurrency race | Revision CAS conflict, lock contention | Client / pipeline retries with fresh revision |
| **OPERATOR INVESTIGATION** | Deterministic error requiring inspection | Schema mismatch, invalid hash | Read-only audit with `scripts/audit-production-d1-readonly.sql` |
| **TRAFFIC ROLLBACK** | Active deployment causing user-visible errors | Deployed Worker crashes or throws 500s | Revert Cloudflare Worker version via Dashboard or CLI |
| **CODE ROLLBACK** | Bug in application logic requiring git revert | Regression in parsing or hydration logic | Revert feature commit on git and redeploy pre-incident version |
| **DATA REPAIR** | Metadata corruption or orphaned lineage | Interrupted migration or dangling manifest | Scoped, transaction-hedged SQL repair under owner approval |

---

### Scenario Response Playbooks

#### 1. Worker Deployment Failure
- **Symptom**: `npx wrangler deploy` fails during upload or Cloudflare returns deployment errors.
- **Immediate Action**:
  1. Inspect build logs in `.wrangler/logs/`.
  2. The previous deployed Worker version remains active and serving traffic on Cloudflare edge.
  3. Do NOT make panic changes to `wrangler.jsonc` or environment secrets.
  4. Fix local build or configuration errors in a clean feature branch and re-verify locally before re-attempting deployment.

#### 2. D1 Migration Failure (Migrations 0005 / 0006)
- **Symptom**: `wrangler d1 migrations apply` halts with an error.
- **Immediate Action**:
  1. Check migration tracker state:
     ```bash
     npx wrangler d1 execute boston-project-production-auth --remote --command="SELECT * FROM d1_migrations ORDER BY id;"
     ```
  2. D1 migrations run in transactional batches. If a migration statement errors, D1 automatically rolls back the entire migration batch.
  3. **DO NOT manually rerun 0006** without verifying tracker status. If `0005` completed but `0006` failed, inspect the error log.
  4. Verify foreign key integrity:
     ```bash
     npx wrangler d1 execute boston-project-production-auth --remote --command="PRAGMA foreign_key_check;"
     ```

#### 3. R2 Binding Missing or Unavailable (HTTP 503 `IMPORT_STORAGE_UNAVAILABLE`)
- **Symptom**: Bulk import endpoints return HTTP 503 with error `"R2 binding RAW_ARCHIVE is required"` or `"R2 binding BULK_DATA is required"`.
- **Root Cause**: `RAW_ARCHIVE` or `BULK_DATA` bucket binding is missing from `wrangler.jsonc` or unattached in Cloudflare Worker configuration.
- **Action**:
  1. This is a fail-closed protection in `worker/bulk-import.js` (`getStores()`). No data has been corrupted.
  2. Verify that bucket names in `wrangler.jsonc` match active R2 buckets in the Cloudflare dashboard.
  3. Check for Cloudflare platform error `10136` (R2 entitlement). If present, await Cloudflare resolution.
  4. Non-bulk endpoints (`/api/session`, `/api/business-sync/snapshot`) remain fully functional.

#### 4. R2 Bucket Lock Rejection (HTTP 423 `RAW_ARCHIVE_LOCKED`)
- **Symptom**: `POST /api/bulk-import/raw-destroy` returns HTTP 423 `RAW_ARCHIVE_LOCKED`.
- **Root Cause**: The R2 object in `rri-raw/*` is protected by a Cloudflare R2 bucket retention lock policy (code `10069`).
- **Action**:
  1. This is expected behavior when retention policies are active.
  2. D1 manifest status remains `raw_archived` (never marked `destroyed`).
  3. Do NOT attempt to force-delete the object through third-party tools.
  4. If destruction is authorized by the account owner, remove or wait for expiration of the retention rule in the Cloudflare Dashboard before retrying.

#### 5. Revision or Overlap Activation Conflict (HTTP 409 `IMPORT_REPLACEMENT_REQUIRED` / `REVISION_CONFLICT`)
- **Symptom**: Upload or activation fails with `IMPORT_REPLACEMENT_REQUIRED` or conflict on revision.
- **Root Cause**: A concurrent import for the same property or an overlapping date range was committed while this import was in flight.
- **Action**:
  1. The transaction failed closed and rolled back cleanly: zero orphaned manifests, zero leaked sequence rows.
  2. Client automatically fetches fresh authority via `syncBulkBundles()`.
  3. If user intends to replace the existing active report, use the UI's Force Import flow, which sends the predecessor bundle ID and its expected revision.

#### 6. Hydration Mismatch or Stale Browser Cache
- **Symptom**: Browser shows stale figures or missing rows after an import.
- **Root Cause**: Browser was offline or hydration was interrupted.
- **Action**:
  1. Dexie / IndexedDB is strictly a cache. Server D1 and R2 remain authoritative.
  2. Trigger client re-sync: Click "Refresh Data" or call `businessSync.hydrate({ force: true })`.
  3. If browser storage is corrupt, the user can safely clear browser application data; the next login will automatically rebuild IndexedDB from D1/R2 snapshots.

#### 7. Partial Raw Destruction / Unconfirmed R2 Deletion
- **Symptom**: Manifest in D1 is in `archive_status = 'destroying'`.
- **Root Cause**: `rawStore.delete()` was called, but network timeout prevented confirming D1 status transition to `destroyed`.
- **Action**:
  1. The endpoint returns 503 `RAW_DESTRUCTION_PENDING`.
  2. Retry the destroy call (`POST /api/bulk-import/raw-destroy`).
  3. The handler checks if the object is already absent in R2; if absent, it completes the D1 transition to `destroyed` idempotently.

---

### Emergency Rollback Procedure (Code / Traffic Reversion)

If a critical flaw is discovered post-release that requires immediate rollback:

1. **Step 1 — Immediate Traffic Reversion**:
   - In Cloudflare Dashboard > Workers > `boston-project` > Deployments:
   - Roll back to the previous stable Version ID (e.g. pre-rollout version).
   - This routes 100% of production traffic back to the proven codebase immediately ($< 5\text{ seconds}$).

2. **Step 2 — Verify Legacy Operability**:
   - Legacy D1 tables (`business_record`, `business_dataset_pointer`, `business_change`) were NOT dropped by migrations 0005/0006.
   - Older Worker versions do not query `import_bundle_manifest` and continue reading from `business_record` as before.

3. **Step 3 — Reconcile In-Flight Data**:
   - Run `scripts/audit-production-d1-readonly.sql` to inspect what manifests were active during the window.
   - Plan a clean patch on the feature branch.
