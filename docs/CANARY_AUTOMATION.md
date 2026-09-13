# RRI Bulk Import Canary Automation Harness

## 1. Executive Summary

The Red Roof Intelligence (RRI) Bulk Import Canary Automation Harness (`scripts/canary-bulk-import.mjs`) provides an automated, attributable, and structurally guarded test orchestrator for validating the bulk import data plane against isolated non-production environments.

This local automation package enables continuous verification and provides the exact launch-control tooling for Codex to execute against Cloudflare edge infrastructure once Cloudflare error `10136` (R2 Worker binding attachment) is resolved.

---

## 2. Structural Safety Guards & Invariants

To eliminate the possibility of accidental execution against production infrastructure, the harness enforces three layers of static and runtime defenses:

### 2.1 Hard-Coded Target Rejection
The harness unconditionally inspects target hostnames, service names, and database identifiers before any network request is created:

- **Forbidden Hostname**: `boston-project.divyesh-boston.workers.dev` (evaluated case-insensitively, with or without ports, paths, or query strings).
- **Forbidden Service Name**: `boston-project`.
- **Forbidden D1 Database Name**: `boston-project-production-auth`.
- **Forbidden D1 Database ID**: `e9008126-d4b4-4588-841c-128eadd94c8d`.
- **Forbidden Buckets**: Any bucket containing `production` without `canary`.

Any match throws an immediate `ProductionGuardError` with code `PRODUCTION_TARGET_FORBIDDEN` and halts execution.

### 2.2 Scheme, Userinfo, and Safe Redirection Policy
The harness strictly enforces transport and credential hygiene:
- **HTTPS Enforcement**: Requires `https://` schemes for all remote endpoints. Plain `http://` is strictly rejected unless targeting `localhost` or `127.0.0.1`.
- **Embedded Userinfo Rejection**: Rejects any URL containing embedded credentials or userinfo (e.g. `https://user:pass@host/`) with code `PRODUCTION_TARGET_USERINFO_FORBIDDEN`.
- **Manual Redirect Resolution**: Fetch requests enforce `redirect: 'manual'`. The client follows redirects manually up to a maximum depth of 5, re-validating each intermediate target through `assertSafeRedirect()`.
- **Cross-Origin Credential Stripping**: When a redirect crosses origins (different protocol, host, or port), sensitive `Authorization` and `Cookie` headers are unconditionally stripped before dispatching the next request.

### 2.3 Mandatory Isolation Confirmation
The harness requires explicit confirmation that the target environment is isolated:
```bash
CANARY_CONFIRM_ISOLATED=YES
```
If this variable is missing, empty, or set to any value other than exact uppercase `YES`, the harness throws `ISOLATION_CONFIRMATION_REQUIRED` and terminates without dispatching network calls.

### 2.4 Dry-Run Zero-Network Invariant
When executed with `--dry-run`:
- The client dispatches exactly **zero** HTTP network requests (`requestsDispatched === 0`).
- Every planned request is captured, redacted, and summarized.
- All fixtures, hashes, and expected canonical keys are computed and verified locally.

### 2.5 Secret Redaction Policy
All URLs, headers, request bodies, error messages, and JSON report outputs are filtered through `redactSecrets()`:
- `Authorization: Bearer <token>` is masked to `Bearer [REDACTED]`.
- `Cookie: ...` is masked to `[REDACTED]`.
- URL query parameters (`token`, `auth`, `password`, `key`) are stripped to `[REDACTED]`.

---

## 3. Architecture & Modular Structure

The canary automation suite is located in `scripts/canary/` and `scripts/`:

```
scripts/
├── canary-bulk-import.mjs          # CLI orchestrator & launch panel
├── probe-canary-automation.mjs     # Local regression probe suite (195th suite)
└── canary/
    ├── production-guard.mjs        # Production rejection, scheme checks, & secret redaction
    ├── fixture-generator.mjs       # Deterministic seeded HotelKey fixtures & oracles
    ├── canary-client.mjs           # Guarded HTTP fetch client with redirect & credential stripping
    └── cleanup-registry.mjs        # Attributable run-scoped resource tracking, orphan detection, & cleanup
```

---

## 4. Deterministic Synthetic Fixture Generators

The fixture generator (`scripts/canary/fixture-generator.mjs`) deterministically produces synthetic reports for all 9 supported HotelKey report families:

1. **All Transactions** (`transactions` -> `TransactionLine`)
2. **Adjustments & Refunds** (`adjustments_refunds` -> `AdjustmentRefund`)
3. **Source Summary** (`source` -> `SourceDay`)
4. **Occupancy** (`occupancy` -> `OccupancyDay`)
5. **Gross Revenue** (`gross_revenue` -> `GrossRevenueDay`)
6. **Payments** (`payments` -> `PaymentDay`)
7. **Clerk Shift** (`clerk` -> `ClerkShiftRecord`)
8. **Hotel Statistics** (`hotel_statistics` -> `HotelMetric`)
9. **Timecard** (`timecard` -> `TimecardPunch`)

### Ugly CSV Stress Variants
The generator can inject real-world CSV edge cases to stress-test streaming parsers:
- **UTF-8 BOM**: Prepends `\uFEFF` byte order mark.
- **Quoted Commas & Escapes**: Injects fields like `"Doe, John #5"` and `"Special ""VIP"""`.
- **Embedded Newlines**: Injects multiline text inside quoted strings.
- **Negative Currency**: Formats negative values as `-$45.00` or `($45.00)`.
- **Repeated Headers & Whitespace**: Simulates paginated reports with repeated header blocks.

### Precomputed Oracles
Every generated fixture includes bit-exact precomputed expectations:
- `rawSha256`: Native SHA-256 of raw CSV bytes.
- `rawCanonicalKey`: Enforces `rri-raw/<account_id>/<property_id>/<raw_sha256>`.
- `normalizedHash`: Content hash of parsed canonical NDJSON items.
- `bundleCanonicalKey`: Enforces `rri-data/<account_id>/<property_id>/<normalized_hash>`.
- `rowCount` and `entityCounts`: Expected record counts.

---

## 5. Attributable Cleanup Registry & Orphan Tracking

Every canary execution instantiates a `CleanupRegistry` with a globally unique run ID:
```
canary-<timestamp>-<random_hex>
```

### Resource Tracking & Orphan Detection
The registry tracks:
- All raw object keys uploaded to `RAW_ARCHIVE`.
- All bundle object keys uploaded to `BULK_DATA`.
- Key-to-bundle mappings: Tracks whether uploaded R2 objects successfully activated in D1.
- **Orphan R2 Detection (`orphanedR2Keys`)**: Any R2 object uploaded whose subsequent D1 activation fails or aborts is flagged as orphaned. The registry prioritizes sweeping these keys and surfaces them in reports.
- **Superseded Bundle Cleanup**: Acknowledges HTTP 404 on `deleteBundle` as expected behavior when a bundle was already marked `superseded` in D1 by a subsequent import.

### Interrupt & Emergency Handling
The registry installs listeners for `SIGINT` (Ctrl+C) and `SIGTERM`. If an operator interrupts execution mid-flight, the registry catches the signal, triggers an emergency sweep of all created keys, logs the outcome, and exits cleanly.

### Explicit Cleanup Status
If tests pass but cleanup encounters retention locks, unmapped orphans, or transient errors, the final verdict reports:
```
TEST PASS / CLEANUP PARTIAL (<n> remaining resources to sweep manually)
```
with an explicit inventory of all remaining keys so operators know exactly what requires manual sweeping.

---

## 6. CLI Usage & Stage Specifications

### Quick Dry-Run (Safe Inspection)
```bash
node scripts/canary-bulk-import.mjs --dry-run
```

### Full Automated Run (Preflight -> Import -> Concurrency -> Hydration -> Cleanup)
```bash
node scripts/canary-bulk-import.mjs --all --config=canary.env
```

### Canary Test Stages

1. **Stage 1 (Preflight)**:
   Verifies reachability, health endpoints, CORS headers, and manifest feed response codes.
2. **Stage 2 (Smoke)**:
   Uploads a single small report (payments, 3 rows) and verifies canonical R2 key paths and D1 activation.
3. **Stage 3 (Import)**:
   Executes multi-family imports (transactions, adjustments, occupancy, clerk) with ugly CSV variants.
4. **Stage 4 (Concurrency)**:
   Simulates three realistic parallel race conditions:
   - **Identical Parallel Race**: Two identical uploads dispatched concurrently; both succeed idempotently returning the identical bundle ID.
   - **Conflicting Overlap Race**: Two overlapping date ranges for the same report family dispatched concurrently; exactly one commits revision $R$, while the other receives HTTP 409 (`BUNDLE_OVERLAP`), followed by an explicit supersedes import recovering at revision $R+1$.
   - **Distinct Non-Overlap Race**: Two disjoint report types dispatched concurrently; both succeed and receive distinct monotonically increasing revisions.
5. **Stage 5 (Hydration & Data Integrity)**:
   Simulates an independent browser client (Browser B):
   - Queries the manifest feed (`since_revision=0`).
   - Downloads the latest compressed bundle directly from R2.
   - Decompresses gzip content (`zlib.gunzipSync`).
   - Independently recomputes canonical normalized content and SHA-256 hash according to the wire contract (excluding provenance keys, deep sorting object keys, and sorting NDJSON lines).
   - Asserts bit-for-bit equality: `computedNormalizedHash === targetManifest.normalized_hash === x-normalized-hash`.
   - Validates total row count and asserts deterministic row IDs (`row.id` / `row.row_id`).
   - Validates pagination cursor freshness (`since_revision` & `after_id`) confirming zero unread records at head.
6. **Stage 6 (Bucket Lock)**:
   - If `--allow-canary-bucket-lock` is passed: deletes a sacrificial test key and asserts HTTP 423 `RAW_ARCHIVE_LOCKED`.
   - If omitted: marks stage as `SKIPPED (opt-in required: --allow-canary-bucket-lock)` and marks verdict as `QUALIFIED_PASS (BUCKET_LOCK_SKIPPED)`.
7. **Stage 7 (Large Payload)**:
   Streams a large 1,000-row fixture validating chunked upload and memory bounds.
8. **Stage 8 (Cleanup)**:
   Executes in a `finally`-equivalent path after successful completion or stage failure. Sweeps all registered canary bundles and raw archives; inventories and surfaces any unmapped R2 orphans (`orphanedR2Keys`), and never reports `CLEAN` unless 100% of tracked resources are accounted for and swept.

### Available CLI Flags

| Flag | Description |
| :--- | :--- |
| `--dry-run` | Zero network calls. Validates environment and outputs planned actions. |
| `--preflight` | Tests connectivity, headers, and manifest feed reachability. |
| `--smoke` | Executes single small report upload (payments, 3 rows) and verifies canonical keys. |
| `--import` | Executes multi-family import (transactions, adjustments, occupancy, clerk) with ugly CSV variants. |
| `--concurrency` | Validates identical idempotency, conflicting overlap rejection, and distinct monotonic revisions. |
| `--hydration` | Simulates Browser B: downloads bundle, verifies gzip decompression, row counts, IDs, and manifest cursor. |
| `--lock` | Tests R2 bucket retention lock (requires `--allow-canary-bucket-lock`). |
| `--large` | Tests streaming and compression of a large 1,000-row fixture. |
| `--cleanup` | Sweeps all created canary bundles and archives; verifies zero orphaned keys. |
| `--all` | Runs the full sequence of stages in order with final cleanup. |
| `--json` | Outputs machine-readable JSON summary. |
| `--output <path>` | Writes JSON execution summary to file. |
| `--target <url>` | Overrides the target canary worker URL (must be HTTPS unless localhost). |
| `--property <id>` | Overrides the target property ID. |
| `--account <id>` | Overrides the target account ID. |
| `--allow-canary-bucket-lock` | Explicit safety opt-in to test HTTP 423 bucket lock destruction. |

---

## 7. Telemetry Classification Standard

To prevent misleading claims regarding physical resource usage, all metrics produced by the canary harness adhere to strict classification categories:

| Classification | Meaning |
| :--- | :--- |
| `REAL_CLOUDFLARE_MEASURED` | Measured directly from Cloudflare Worker runtime, D1 query metrics, or R2 API responses. |
| `LOCAL_CLIENT_MEASURED` | Measured by the local canary test client (e.g. number of HTTP requests dispatched). |
| `LOCAL_SQLITE_MEASURED` | Measured in local Node.js test harness against in-memory SQLite (`DatabaseSync`). |
| `MODELED` | Calculated from analytical or mathematical models (e.g. theoretical write amplification formula). |
| `ESTIMATED` | Engineering approximation based on fixture size or payload characteristics. |
| `UNMEASURED` | Not yet measured on the target environment. |

> [!IMPORTANT]
> **Full-Import D1 Physical Writes remain `UNMEASURED`** until Codex executes the canary suite against live Cloudflare edge infrastructure after error `10136` is resolved. The current theoretical model predicts $\le 20$ writes per full batch import.

---

## 8. Verdict Engine & Exit Codes

The orchestrator produces one of four mutually exclusive overall verdicts:

- `PASS`: All executed stages succeeded cleanly, cleanup swept 100% of created resources, and bucket lock was verified. Exit code: `0`.
- `PASS (DRY_RUN)`: Dry-run execution succeeded with zero network calls. Exit code: `0`.
- `QUALIFIED_PASS (BUCKET_LOCK_SKIPPED)`: All executed functional stages passed and cleanup was `CLEAN`, but bucket lock testing was skipped due to missing `--allow-canary-bucket-lock`. Exit code: `0`.
- `FAIL`: Any stage threw an error, cleanup was `PARTIAL` or `FAILED`, or orphaned R2 objects remained unswept. Exit code: `1`.

---

## 9. Handoff to Codex (When Cloudflare Error 10136 Resolves)

When Cloudflare resolves error `10136`, Codex can execute the canary harness with minimal token expenditure:

1. **Verify 10136 Resolution**:
   ```bash
   npx wrangler deploy --config=canary-wrangler.jsonc --dry-run
   ```
2. **Deploy Canary Worker with Bindings**:
   Deploy `rri-bulk-canary-a61a110` with bindings to canary D1 (`7e746318-...`) and canary R2 buckets (`rri-raw-canary-a61a110`, `rri-data-canary-a61a110`).
3. **Execute Full Canary Harness**:
   ```bash
   $env:CANARY_CONFIRM_ISOLATED="YES"
   node scripts/canary-bulk-import.mjs --all --target="https://rri-bulk-canary-a61a110.<subdomain>.workers.dev" --allow-canary-bucket-lock --json --output="canary-results.json"
   ```
4. **Capture Real Physical D1 `rows_written`**:
   Inspect Cloudflare D1 query metrics for the import execution, update telemetry classification from `UNMEASURED` to `REAL_CLOUDFLARE_MEASURED`, and report final canary status.
