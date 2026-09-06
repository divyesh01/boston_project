# 7. ALL 16 DATABASE TABLES (Entities)

Every piece of data stored. Each table has Row-Level Security (RLS) = data isolated per property/user.

### The Canonical RLS Rule (read AND write must be byte-identical)

10 of the 16 entities are property-scoped. Identify them by the `{{user.property_access}}`
marker, never by a hardcoded list, so a new entity is covered automatically.

```json
{ "$and": [ {"user_condition":{"is_active":true}},
            {"$or":[ {"user_condition":{"role":"admin"}},
                     {"user_condition":{"role":"owner"}},
                     {"data.property_id":{"$in":"{{user.property_access}}"}} ]} ] }
```

The operator ORDER is the whole security boundary, and both ways of getting it wrong are
silent, because RLS is enforced by the **Base44 host** -- no local suite can observe it:

| Corruption | Effect |
|-----------|--------|
| Inner `$or` flipped to `$and` | Demands one user be admin AND owner simultaneously. Nobody can read. Table looks empty. |
| Outer `$and` flipped to `$or` | ANY active user passes regardless of role or property. **Cross-property data leak.** |

**Fixed 2026-08-19:** `fix_entities.py` did a naive positional string replacement and left 9
entities (`ClerkShiftRecord`, `Expense`, `OccupancyDay`, `PaymentDay`, `PayrollRun`,
`SourceDay`, `Staff`, `TimecardPunch`, `UploadedReport`) with the sequence
`[$and,$and,$or,$or]` instead of `[$and,$or,$and,$or]`. `GrossRevenueDay.jsonc` was the
surviving healthy reference. Guarded by `scripts/probe-db-mock-rls.mjs`, which does not
merely diff the JSON -- it EXECUTES every shipped rule against a 9-case access matrix
(180 assertions), including the cross-property deny that SECURITY.md section 3 requires.

### Core Tables
| Entity | File | What It Stores | Who Can Access |
|--------|------|---------------|---------------|
| **User** | `User.jsonc` | Usernames, emails, display names, roles (owner/admin/manager/front_desk/accountant/read_only), property_access, granular permissions, scrypt password hashes, salts, TOTP MFA secrets, last TOTP counters, lockout flags, password reset tokens | Auth functions only |
| **Session** | `Session.jsonc` | SHA-256 token hash, expiry timestamp, client IP, User-Agent, revocation flag | Auth functions only |
| **Property** | `Property.jsonc` | Hotel code, name, total room count, address, phone, active status | All authenticated users |

### Financial Data (Daily Records)
| Entity | File | What It Stores |
|--------|------|---------------|
| **GrossRevenueDay** | `GrossRevenueDay.jsonc` | Daily departmental revenue: room rent, food, beverage, laundry, misc charges, advance deposits |
| **PaymentDay** | `PaymentDay.jsonc` | Daily payment breakdown: cash, check, Visa, Amex, MasterCard, Discover, direct bill, wire, loyalty discounts |
| **OccupancyDay** | `OccupancyDay.jsonc` | Daily room stats: total rooms, sold, vacant, clean, dirty, stayover, comps, no-shows, ADR, occupancy %, RevPAR |
| **SourceDay** | `SourceDay.jsonc` | Daily booking source: revenue and stays per channel code (Expedia, Booking.com, Direct, etc.) |

### Operational Data
| Entity | File | What It Stores |
|--------|------|---------------|
| **Channel** | `Channel.jsonc` | OTA commission rates (type, rate, amount) and daily channel performance |
| **ClerkShiftRecord** | `ClerkShiftRecord.jsonc` | Shift records: payments collected, cash drops, actual vs adjusted, transaction counts |
| **Expense** | `Expense.jsonc` | Operating expenses: category, amount, frequency, payment status, taxability |
| **Staff** | `Staff.jsonc` | Employee roster: department, role, pay type (hourly/salary), rates, hire date |
| **TimecardPunch** | `TimecardPunch.jsonc` | Raw time punches: clock-in/out, break minutes, department |
| **PayrollRun** | `PayrollRun.jsonc` | Finalized payroll: hours, regular/OT pay, bonuses, deductions, approval status |
| **UploadedReport** | `UploadedReport.jsonc` | Upload metadata: file URL, row counts, Drive backup ID, backup status |

### Security & System
| Entity | File | What It Stores | Special Rules |
|--------|------|---------------|--------------|
| **AuditLog** | `AuditLog.jsonc` | Every security event: action, user_id, performed_by, IP, device, property_id, result, detail, SHA-256 hash, previous_hash | **APPEND-ONLY** (update: false, delete: false) |
| **RateLimit** | `RateLimit.jsonc` | Brute-force buckets: client IP/account key, action (login/reset/mfa), attempt count, reset timestamp | Used by login, reset, MFA verification |

---

# 8. ALL 19 BACKEND FUNCTIONS (The Server Brain)

### Authentication (8 functions)
| Function | Folder | What It Does | If You Edit This... |
|----------|--------|-------------|-------------------|
| **Login** | `custom_auth_login/` | Rate limiting (5/15min per IP), scrypt verify (auto-upgrades legacy PBKDF2), TOTP MFA with counter replay prevention, session creation, HTTP-only Secure cookie, audit log | Login breaks for ALL users |
| **Logout** | `custom_auth_logout/` | CSRF token validation, session revocation, cookie clearing | Users cannot log out (sessions persist) |
| **Me** | `custom_auth_me/` | Returns sanitized user profile, slides session expiry (7d, max 30d) | Premature logout, profile fails to load |
| **Check** | `custom_auth_check/` | Fast session validation (no sliding): token hash, revocation, user status | App cannot verify login state |
| **Register** | `custom_auth_register/` | Owner bootstrap (when 0 owners exist), admin-only subsequent registration, scrypt hash, welcome email with reset link | Registration breaks |
| **Reset Request** | `custom_auth_reset_request/` | Dual rate-limit (IP + email), 1-hour token, generic response (anti-enumeration) | Reset emails stop, or flooding attacks possible |
| **Reset Password** | `custom_auth_reset_password/` | Token validation, password complexity (8+ chars, upper/lower/number), revoke all sessions | Password resets fail, weak passwords accepted |
| **User Admin** | `custom_user_admin/` | Full CRUD, MFA mgmt (with step-up password), status toggle, session revocation on privilege change, chained audit | User management breaks entirely |

### Audit Trail (4 functions)
| Function | Folder | What It Does | If You Edit This... |
|----------|--------|-------------|-------------------|
| **Log** | `audit_log/` | SHA-256 HMAC: canonical payload + previous hash + AUDIT_CHAIN_SECRET | Audit chain breaks -- tampering goes undetected |
| **Verify** | `audit_verify/` | Walks entire log, recomputes hashes, detects tampering/deletion | Cannot verify audit integrity |
| **List** | `audit_list/` | Admin-only filtered query with property access enforcement | Audit page shows nothing |
| **Clear** | `audit_clear/` | **ALWAYS returns HTTP 403** -- audit can NEVER be cleared | If changed: entire audit trail can be destroyed |

### Business Operations (4 functions)
| Function | Folder | What It Does | If You Edit This... |
|----------|--------|-------------|-------------------|
| **AI Assistant** | `aiAssistant/` | Tenant-scoped AI: validates session, enforces property boundaries, anti-jailbreak prompts, queries Base44 LLM | AI leaks cross-property data |
| **Auto Payroll** | `autoPayroll/` | Monthly payroll (last day): reconcile timecards, 40h overtime threshold, 30m break rules, create PayrollRun | Employees paid wrong or double-paid |
| **Delete Account** | `deleteAccount/` | Requires explicit "DELETE:<userId>" confirmation, wipes data across 5 entities | Accidental mass data deletion |
| **Get Weather** | `getWeather/` | Proxy to OpenWeather API (hides API key from browser) | Weather widget breaks |

### External Integrations (3 functions)
| Function | Folder | What It Does | If You Edit This... |
|----------|--------|-------------|-------------------|
| **Backup to Drive** | `backupToDrive/` | SSRF-safe file download, hierarchical Drive folders, upload + update UploadedReport | Drive backups fail or SSRF vulnerability |
| **Import Drive File** | `importDriveFile/` | Downloads from Drive via OAuth, IDOR defense (tenant property check) | Drive import breaks or cross-tenant leak |
| **List Drive Files** | `listDriveFiles/` | Lists CSV/spreadsheet files from connected Google Drive | Drive file picker breaks |

### Fixed 2026-08-19: the `__B44_DB__` fake-database shim

Seven of these functions (`aiAssistant`, `autoPayroll`, `backupToDrive`, `deleteAccount`,
`getWeather`, `importDriveFile`, `listDriveFiles`) each opened with an injected line:

```js
const db = globalThis.__B44_DB__ || { entities: {...}, auth: { me: async () => null } };
```

whose methods returned `[]` / `null` / `{}`. So **every read returned "no rows" and every
write was silently discarded.** `getWeather` returned 401 for everyone; two
`AuditLog.create` calls went nowhere. Nothing caught it for months because
`eslint.config.js` ignores `base44/**` entirely and `jsconfig.json`'s `include` is `src/**`
only -- **`base44/**` is checked by NO automated tooling except the probes.**

Origin was `AGENTS.md` line 1, which carried the same statement above its own heading: an
agent reads its own rulebook and copies line 1 as the house way to query the database. The
same codemod also broke `public/manifest.json` (one prepended JS line made `JSON.parse`
fail, so browsers discarded the entire manifest and it shipped that way in `dist/`).

Two traps when repairing this class of defect:

- Preserve each author's elevation intent -- `db.asServiceRole.X` -> `base44.asServiceRole.X`,
  bare `db.X` -> `base44.X`. Do NOT blanket-elevate.
- `autoPayroll` never had an SDK client in ANY revision, so a mechanical `db.` -> `base44.`
  rename leaves it broken. It needed `createClientFromRequest` added, and its call sites
  deliberately elevated to `asServiceRole` because a scheduled cron run has no session
  cookie and would be denied by the very RLS rules being repaired.

`autoPayroll` and `deleteAccount` are now WRITERS on the audit chain (see BRAIN_SECURITY.md).

### Fixed 2026-08-22: one SDK specifier across all 18 functions

Every function imports the SDK by a Deno specifier that carries its own version
range. Until now the repository held **two** ranges: the 7 `.ts` functions pinned
`npm:@base44/sdk@0.8.40` and the 11 `.js` functions `npm:@base44/sdk@^0.8.41`.
`package.json` declares `^0.8.41`, so the exact pin named a version nothing else
in the repository asked for. All 18 now read `npm:@base44/sdk@^0.8.41`.

This had been deferred twice on a misreading, which is the part worth recording.
`custom_auth_login/entry.js:204` and `custom_user_admin/entry.js:311` carry a
warning that copies must stay byte-identical — **that warning is about the
canonical audit field list (`AUDIT_CANONICAL_V1`), not about the import line.**
Read as covering line 1, it froze the split in place.

Why the split was a real hazard rather than untidiness: `autoPayroll/entry.ts` and
`deleteAccount/entry.ts` are audit-chain writers (previous paragraph), so two
functions were appending to **one hash chain** through a different SDK build from
every other writer. The `.ts` functions use exactly one export between them,
`createClientFromRequest`, which is present in 0.8.41 — checked against
`node_modules/@base44/sdk/dist/client.d.ts`, not assumed.

Blast radius, because this specifier is a **string key** in three other places and
a mechanical rename orphans all three:

```
vitest.config.js                     resolve.alias key   -> stale alias deleted
tests/backend/aiAssistant.test.js    vi.mock() specifier -> updated
tests/backend/all_endpoints.test.js  vi.mock() specifier -> two mocks collapsed to one
```

A missed `vi.mock` does not fail loudly. The mock simply stops intercepting the
module the function imports and the test reaches the **real** SDK. All three were
updated in the same change; `vitest run tests/backend` is 24/24.

`scripts/probe-no-real-credentials.mjs:104,286` still contain the literal string
`npm:@base44/sdk@0.8.40` and must be **left alone** — they are regex fixtures
asserting a version specifier is not misread as an email address.

```
node --import ./scripts/_loader-boot.mjs scripts/probe-audit-chain.mjs   # 36/0
npx vitest run tests/backend                                            # 24/24
```

### Fixed 2026-08-22: `base44/lib/corsConfig.js` — two defects in a file nothing imports

`python -m graphify query "corsConfig"` returns **6 nodes, all inside this one file, and
no inbound edge from anywhere in the repository.** It is an orphan. Both defects below
were therefore latent, never observed at runtime — which is precisely why they needed a
static guard rather than a bug report. An unused file generates no runtime evidence, so
the person who discovers its defects is whoever wires it into a function first.

**Defect 1 — `process.env` at module scope.** Line 19 was
`const productionOrigins = process.env.ALLOWED_ORIGINS ? ... : []`. A bare `process`
reference throws `ReferenceError` **at import time** in any host that does not define it:
a browser/Vite bundle, or a Deno function running without the Node compatibility global.
For a CORS module that is the worst available failure mode — it takes down the endpoint it
was added to protect, before a single request is inspected. Now read lazily and memoised
through `readEnv()`, which tries `Deno.env.get` first (base44 functions run on Deno),
falls back to `process.env`, and treats a `Deno.env.get` permission throw as "unset"
rather than propagating it.

`allowedOrigins` and `productionOrigins` are now **getters** on `module.exports`. Exporting
them as plain arrays would have re-introduced the module-scope evaluation the fix removes,
while looking harmless.

**Defect 2 — the preflight wildcarded unauthorized origins.** The `OPTIONS` branch read
`res.header('Access-Control-Allow-Origin', isAllowedOrigin(origin) ? origin : '*')`, so an
origin the module was about to reject got a wildcard grant plus the full
`GET, PUT, POST, DELETE, OPTIONS` method list. That contradicts the file's own header
contract ("Rejects unauthorized origins with HTTP 403"). Practical exposure was limited —
the follow-up request was still 403'd below, and browsers refuse `*` together with
credentials — but it failed safe by *browser behaviour*, not by design. Unauthorized
preflights now get the same 403 as unauthorized requests.

**Deliberately NOT changed**, so nobody "finishes the job" by accident:

- The `else if (isProductionOrigin(origin))` branch is **unreachable**. `allowedOrigins`
  already contains every production origin, so `isAllowedOrigin` is true first. Pre-existing
  dead code, harmless, left alone.
- The file is **CommonJS** (`module.exports`) and **Express-shaped** (`res.header`,
  `next()`). A Deno serverless function under `base44/functions/` cannot import it as-is.
  That is the real reason it is dead, and converting it is a port, not a fix — do that only
  when something actually needs it.

`scripts/probe-cors-config.mjs` guards both defects, 35 assertions. It loads the module
inside a bare `vm` context rather than with `import()`, because Node always defines
`process` and an `import()`-based test therefore *cannot* observe the crash the fix
prevents. Its static assertions run against comment-stripped source: the fix documents
itself by quoting the defective lines, and a naive substring search finds the old wildcard
in the comment saying it is gone (the same trap produced a false FAIL in
`verify-money-kept.mjs` the same day).

Both halves were mutation-tested, so no assertion is vacuous: against `HEAD`'s pre-fix
source **7 assertions fail** (including "module evaluates without throwing", which is
direct proof the `ReferenceError` was real); against a mutant restoring **only** the
preflight wildcard, **5 fail**.

```
node scripts/probe-cors-config.mjs        # 35/0, standalone — no loader needed
```

---

# 9. ALL CONFIG FILES

### Production Worker authentication (2026-09-01)

- `wrangler.jsonc` now routes `/api/*` through `worker/index.js`, binds
  `boston-project-production-auth`, and keeps `ENABLE_D1_DATA_API=false`.
- `.env.production` selects `VITE_USE_SERVER_AUTH=true` and
  `VITE_USE_D1_API=false`. Authentication is server-backed; hotel/business
  entities remain browser-local IndexedDB.
- Password records use the versioned
  `$rri-pbkdf2-sha256$v=1$i=100000$p=1$...` contract plus the
  `PASSWORD_PEPPER_V1` Cloudflare secret. Legacy/unknown formats fail closed.
- `app_session` and `app_mfa_challenge` are the browser-independent session
  and single-use MFA stores. D1 stores token digests, never bearer cookies.
- `/api/session` derives the frontend route-capability baseline for `owner` and
  `admin` from their authoritative server role, then applies any stored
  permission overrides. This prevents a provisioned owner whose legacy
  `permissions` JSON is `{}` from being authenticated but trapped in a blank
  same-path `/` permission redirect. Non-owner roles receive no elevated
  defaults from this boundary.
- Owner migration is compare-and-swap and profile-preserving; provisioning and
  migration scripts never persist plaintext passwords. New-owner provisioning
  stores the same complete owner capability map returned by the session API.
- Property deletion in the browser walks 24 dependent IndexedDB tables.
  `propertyCascadeIds` handles numeric/string legacy ids without deleting a
  separately owned cross-type property.
- Production Worker `6b04c93d-f5e4-4de7-9832-357a8aeffee5` includes the
  permission-bootstrap incident repair. Its pre-change rollback target is
  `623b3ee9-6815-43fb-a70c-1c1cdea0a2c8`; the earlier authentication rollout
  passed the 22-check live smoke.

### Cross-browser business-data sync rollout (2026-09-02, enabled)

- `VITE_USE_SERVER_DATA_SYNC` (build time, `.env.production`) and the independent
  Worker kill switch `ENABLE_BUSINESS_SYNC_API` (`wrangler.jsonc`) are both
  `true` as of this rollout. They must move together: a client with sync on
  against a Worker with the API off receives `404 {"error":"business-data sync is
  disabled"}`, which carries no `no_active_dataset` code, so `requestOptional`
  rethrows instead of falling back to the cache. `ENABLE_D1_DATA_API` remains
  `false` — the legacy per-request entity API is a different path and is not
  needed by this one.
- Production D1 `boston-project-production-auth` has `0002_business_sync.sql`
  applied (Observed 2026-09-02: `d1_migrations` = `0001_auth_schema.sql`,
  `0002_business_sync.sql`; 11 `business_*` tables; 7 `idx_business*` indexes;
  users 1, accounts 1, properties 0, grants 0, sessions 2 — all unchanged across
  the migration). Schema migration is not dataset activation: `business_dataset`,
  `business_dataset_pointer`, `business_record` and `business_sync_state` were
  all left at zero rows, so the account has no active generation.
- Enabling the flags cannot clear a browser's existing data. The only
  `.clear()` in `src/api/businessSync.js` is inside `hydrate()`'s snapshot path
  (line 310) and is unreachable while `fetchSnapshot()` returns `null`, which is
  exactly what happens when the server answers `404 no_active_dataset` (line
  305 returns first). `applyFeed` never clears; it only requests a rebuild.
- An active-but-empty generation — the one state that would clear a cache and
  write nothing back — cannot be created. `startMigration` rejects a manifest
  whose entity totals are `<= 0` (422) and `activateMigration` refuses a
  generation with no property roster (422), with a chunk count/hash that does not
  match the manifest (409), with a total record count that does not reconcile
  (409), with any per-entity count that does not reconcile (409), or with an
  orphaned `property_key` reference (422) — one that names an *absent* property,
  which is not the same as the account-global key that names *no* property (see
  the next bullet). The pointer swap, the roster upsert and the previous-generation
  retirement all run in one `env.DB.batch()`.
- **A business record with no property is account-global, not orphaned**
  (2026-09-03). The typed-key encoder spells that exactly one way: `s:0:`, from
  `typedRecordKey("")`. No *other* id can reach that spelling — every non-empty
  string id yields `s:<len>:` with `len > 0`, and a numeric id `0` yields `n:0`,
  which is a *real* property id. The sentinel is nonetheless IN-BAND, because a
  `Property` whose own id is `""` encodes to `s:0:` as well; that collision is
  refused, not prevented by the format, and the three refusals are enumerated in
  `BRAIN_SECURITY.md` §18. An empty `property_key` on the wire — the field absent,
  not the string `s:0:` — is an omitted field, never global. Such a
  record activates with `server_property_id` left SQL NULL and gets no
  `business_property_map` row and no sentinel roster row; activation's
  property-key `UPDATE` is keyed by a mapped key, so it never touches it. This is
  the write half of a read path that already handled NULL: `scopedRecordClause`
  emits `1=1` for `scope.all` and `server_property_id IN (…)` for a restricted
  caller, which SQL NULL never matches. `property_key` is covered by three hashes
  (the migration chunk hash, the transaction chunk hash and the `mutate` request
  hash), so it is **never normalized server-side** — only compared against one
  named constant, at all four sites that resolve a key to a server property id.
  Observed 2026-09-03: production's single staged generation holds 16 such rows,
  14 `PayrollRun` and 2 `Staff`, produced by posting historical payroll while the
  global property filter is `all`. No `TransactionLine`, `GrossRevenueDay`,
  `OccupancyDay` or `PaymentDay` row is property-less, so the cent-exact revenue
  reconciliation is untouched by this contract.
- `business_staging_target.server_property_id` is `NOT NULL`, so the staged
  transaction path cannot store NULL there and binds the sentinel
  `__account_global__` in that one insert. `business_record` and `business_change`
  keep a real NULL. The sentinel never persists — staging targets are deleted on
  commit and on abort — and it grants nothing: the commit-time scope guard admits
  it only through its two unrestricted arms, and both the SQL guard and its JS
  fallback state that explicitly rather than relying on the fact that no
  `user_property_access` row can name it. Chosen over a live DDL migration because
  that table has no foreign key to `property` and the sentinel's lifetime is one
  transaction. A chunk whose operations are *all* global leaves the property-key
  list empty, and `property_key IN ()` is a SQLite syntax error, so that lookup is
  skipped rather than built.
- The implementation stages complete 25-entity IndexedDB snapshots in
  immutable account-scoped D1 generations, preserves numeric versus string ids,
  verifies chunk hashes/counts, and exposes data only through an atomic active
  generation pointer. Clean browsers rebuild IndexedDB as a cache from a fixed
  snapshot revision plus a monotonic change feed.
- Online single-record writes are server-first, mutation-idempotent, guarded by
  the previous row hash, property scoped, and retained in a durable browser
  outbox across ambiguous response loss. Offline business writes remain blocked.
  Property deletion forces a full cache rebuild. Employee-id sequences are
  reserved by account on the server when sync mode is active.
- Active-generation rollback restores the previous property roster in the same
  D1 batch as the pointer swap. Replacement-only properties are deactivated,
  not deleted, because deleting them would cascade authorization grants.
- The `runInTransaction` release blocker is resolved locally for report import,
  manual-entry save, and payroll bulk posting. The client captures mutations in
  a read-your-writes overlay without changing business IndexedDB tables, then
  sends idempotent 13-operation chunks through explicit
  `start`/`chunk`/`commit`/`abort`/`status` endpoints. Import rollback ids are
  durably deferred until the authoritative commit is confirmed and hydrated.
- Each transaction clones the active immutable generation, records the active
  generation and account revision, and atomically swaps the pointer only after
  live authorization, property scope, revision, pointer, expiry, and pending
  state all pass inside the D1 batch. Abort, expiry, and conflict paths remove
  staging rows, targets, chunk receipts, and mutation guards; ambiguous responses
  retain the browser outbox until status proves commit or a pending attempt is
  explicitly aborted. Concurrent start/chunk/commit retries are idempotent.
- Every destructive staging cleanup batch — abort, the expiry sweep, and the
  commit conflict rollback — carries a `${tx_id}:cleanup` guard row that requires
  the transaction to still be `pending` (and, for the sweep, still expired) at
  batch-execution time. The pre-batch status read is a check-then-act window: a
  commit that wins that race publishes the staging generation as the active
  dataset, so an unguarded cleanup would delete the live dataset's records and
  property map and still return success. The `CHECK (ok = 1)` column turns a lost
  race into a rolled-back batch, and abort then reports `transaction_not_pending`
  instead of destroying authoritative data. Cleanup must never widen to
  unconditional deletes on a generation id that a concurrent commit can activate.
- `activeTransaction` in `src/api/businessSync.js` is module-scoped by design.
  The browser has no async context propagation, so a UI write issued while a
  transaction callback awaits is captured into that open transaction instead of
  racing it. The alternative — letting the concurrent write reach the server
  first — bumps the account revision and makes the whole staged import fail the
  commit CAS, losing far more work than it protects. Callers must not start a
  transaction around long-lived interactive flows.
- `ensureFresh` in `src/api/businessSync.js` coalesces concurrent readers onto a
  single in-flight pull. Every wrapped read (`filter`, `list`, `paginate`,
  `count`, `get`) awaits it first, so its contract is that it resolves only once
  the local cache is authoritative. A time-only throttle broke that contract: it
  armed `lastPullAt` before the snapshot download finished, so a second widget
  mounting in the same tick took the early return and rendered the pre-hydration
  cache — empty on a clean browser — while the server held the data. That is
  exactly the upload-once cross-browser case this subsystem exists to serve.
  Waiters now join the shared `pullPromise`, and the throttle is armed only after
  `hydrate()` resolves. `hydrate()` resolves for a completed swap, for an offline
  fall back to a usable prior cache, and for an inactive dataset, and throws only
  when no usable cache exists, so a failed cold pull stays immediately retryable
  instead of throttling the next reader into a silent empty result. No `await`
  may be introduced between the `pullPromise` check and its assignment; that
  reopens the double-pull race the join closes.
- Treating a 404 from `transaction/status` as "never started" is safe because the
  worker never deletes `business_staging_transaction` rows — every terminal state
  is an `UPDATE` to `committed`, `aborted`, `expired`, or `conflict`. A committed
  transaction can therefore never answer 404, so recovery dropping an outbox
  entry on 404 cannot discard a committed write. Any future change that deletes
  staging transaction rows would turn that recovery branch into silent data loss.
- Current deterministic evidence: Worker sync probe 27/27 (the seven added checks
  cover the abort race, the expiry-sweep race, later-chunk property scope,
  commit-after-abort, staging invisibility to snapshot and feed, selective
  expiry, and full cross-account denial), real router/auth/kill-switch probe
  4/4, `src/api/businessSync.test.js` 21/21, full Vitest 46 files / 362 tests,
  credential scan 15/15, `verify:v3` PASS, lint 0 errors, `npm run typecheck`
  0 errors, production build PASS, and `verify:all` 147 suites / 146 PASS /
  0 FAIL / 1 environment SKIP (`probe-config-exposure.mjs` needs a running Vite
  server that mounts the Base44 serverless functions; it is an honest environment
  skip, not a pass). Note that a bare `tsc --noEmit` is not the typecheck gate:
  with no project argument it prints usage and exits 1, so use
  `npm run typecheck`, which runs `tsc -p ./jsconfig.json`. Two invariants were
  mutation-tested. Removing the abort guard reproduces `abort must fail closed
  once the commit won, got 200`, and removing only the sweep guard fails the
  sweep test while the abort test still passes. Replacing `ensureFresh`'s
  `await pullPromise` join with a bare `return` reproduces the empty concurrent
  read (`expected [] to deeply equal [ { id: 9, … } ]`), so neither check is
  vacuous. Business sync remains disabled and undeployed; this evidence verifies
  the local release candidate, not production readiness.

### Build & Deploy
| File | What It Does | If You Edit This... |
|------|-------------|-------------------|
| `package.json` | NPM deps (React 18, Base44 SDK, Recharts, Dexie, Tailwind, Radix, Framer Motion), scripts (dev, build, test, lint, ws) | Build fails, tests fail, everything |
| `vite.config.js` | Vite build: React plugin, Base44 plugin, standalone env guard, SRI hash generator, dev security headers, console stripping, vendor chunk splitting | Production build fails |
| `vercel.json` | Vercel deploy: SPA routing (/* -> /index.html), 1-year immutable caching for /assets/*, production security headers | 404 on refresh, security headers lost |
| `sriPlugin.js` | Hashes every `/assets/` subresource in the built index.html. Digests are taken in `writeBundle` (the file ON DISK) and re-verified in `closeBundle`, after every other plugin has written | Move the hashing back into `transformIndexHtml` and the browser blocks the entry chunk: blank page, whole app down. See BRAIN_SECURITY "Subresource Integrity" |
| `envGuardPlugin.js` | Accepts either the current server-auth shape (`VITE_USE_SERVER_AUTH=true`, D1 data off) or the complete legacy standalone shape | It refuses a production bundle with neither usable authentication shape |
| `eslint.config.js` | ESLint 9: React + Hooks rules, unused import removal | Linting breaks in CI |
| `vitest.config.js` | Test runner: JSDOM env, @/ path alias, setup hooks, coverage | Tests cannot run |
| `tailwind.config.js` | Design tokens: HSL color vars, chart colors 1-5, sidebar colors, fonts, accordion animations | ALL styling breaks |
| `components.json` | Shadcn UI: component paths, utility path, icon library | New UI components scaffolded wrong |
| `jsconfig.json` | IDE: @/* -> ./src/* path alias, strict JSX, type definitions | Autocomplete and type-checking break |
| `postcss.config.js` | PostCSS: loads Tailwind and autoprefixer | CSS processing fails |

### Deploying: two paths, one worker

The site is the Cloudflare Worker **`boston-project`**
(`boston-project.divyesh-boston.workers.dev`). Two things can update it, and the `name` in
`wrangler.jsonc` is the single line that makes them agree -- read the comment in that file
before touching it.

**Local upload.** `npm run build`, then `npx wrangler deploy`, which uploads whatever is in
`dist/`. `.env.production` is part of the checkout, so the flags are present, the guard passes,
and the bundle can log in.

**Cloudflare Workers Builds from GitHub.** Five defects have been measured in this pipeline.
Four came from build #2576feba (2026-08-23, on the abandoned `divyeshpro` worker); the fifth
only became visible once the first four were addressed, on build #159d05dc (2026-08-24).

| Defect | Why it breaks the deploy | State |
|---|---|---|
| Repo was `divyesh01/divyeshpro` | The code lives in `divyesh01/boston_project`. Pushing a fix to the repo you are reading did not reach that pipeline at all | fixed in dashboard: now `divyesh01/boston_project`, branch `main` |
| Branch was `dependabot/npm_and_yarn/vite-8.2.2` | `npm clean-install` died with ERESOLVE: that branch bumps vite to 8.2.2 while `@vitejs/plugin-react@4.7.0` declares peer vite `^4.2.0 \|\| ^5.0.0 \|\| ^6.0.0 \|\| ^7.0.0`. A dependabot branch is not a deployable branch | fixed in dashboard, and `.github/dependabot.yml` now prevents the branch existing |
| Deploy command was `npx wrangler versions upload` | Uploads a version WITHOUT routing production traffic to it, so a "successful" build changes nothing a visitor sees | fixed in dashboard: `npx wrangler deploy` |
| **Build variables: None** | While `.env.production` was gitignored a Git build saw neither auth flag. Before `envGuardPlugin.js` that produced a green build and a bundle nobody could log into; after it, three builds failed in ~1s. Two dashboard attempts changed nothing -- Cloudflare has a **Runtime** "Variables and Secrets" section as well as a **Build** one, and only the Build one reaches `npm run build` | fixed here, upstream of the dashboard: `.env.production` is now committed (see Environment Variables below), so any clone builds the working shape. Build variables are no longer required for a deploy; if set, they still win (`loadEnv` merges `process.env` last) |
| `wrangler.jsonc` `name` was `divyeshpro` | The build belongs to the `boston-project` service but its deploy command reads this file, so the two deploy paths pointed at two different workers | fixed here: `name` is `boston-project` |

Build #159d05dc is the useful evidence: Initializing / Cloning / Installing all succeeded and
the build then failed at `configResolved` in one second with
`[standalone-env-guard] refusing to build a production bundle that cannot log anybody in.`
That is the pipeline failing for the right reason for the first time. Cloudflare's build
variables reach the bundle because `loadEnv` merges `process.env` keys carrying the `VITE_`
prefix over the ones parsed from `.env` files (observed in
`node_modules/vite/dist/node/chunks/dep-Dm0c1Wj2.js:16932`), so a dashboard variable and a
line in `.env.production` are equivalent as far as the guard and the bundle are concerned.

`.github/dependabot.yml` ignores semver-major bumps of `vite` and `@vitejs/plugin-react` so
the bot stops re-opening a branch that cannot install. They are peer-coupled and have to move
together, by hand.

Two known-and-accepted weaknesses in this path: `wrangler` is not a declared dependency, so
`npx wrangler deploy` resolves whatever version is newest at build time; and the Worker name
can only be verified against the dashboard by eye, since nothing in the repo can observe it.

### Environment Variables
| File | Key Setting | What It Controls | DANGER |
|------|------------|-----------------|--------|
| `.env.example` | **committed template** | The only place the required variable names are written down, each annotated with the file:line that reads it. `.gitignore` has an explicit `!.env.example` negation so `.env.*` cannot swallow it. | Deleting it leaves a new deploy nothing to copy |
| `.env.local` | `VITE_USE_LOCAL_AUTH=false` | Default: use real serverless auth | Loaded by Vite in **every** mode including `vite build` — never put `true` here |
| `.env.development` | `VITE_USE_LOCAL_AUTH=true` | Dev: use local IndexedDB auth shim | - |
| `.env.production` | `VITE_USE_SERVER_AUTH=true` + `VITE_USE_D1_API=false` + `VITE_USE_SERVER_DATA_SYNC=true` | Current production: same-origin Worker authentication, legacy entity API off, business data authoritative in D1 with IndexedDB as a cache | This committed file contains public build flags only. Never add a password, token, pepper, or other secret. `VITE_USE_SERVER_DATA_SYNC` is baked in at build time — changing it needs a rebuild AND a deploy, in step with `ENABLE_BUSINESS_SYNC_API` |
| `PASSWORD_PEPPER_V1` | Cloudflare Worker secret (not a file) | Post-hash HMAC pepper for versioned owner credentials | Missing/short values make authentication return controlled 503; never place this value in source, logs, chat, or `.env.production` |
| `ENABLE_D1_DATA_API` | `false` in `wrangler.jsonc` | Runtime kill switch for Worker business-data endpoints | Not part of the cross-browser sync path; leave false. `/api/entities`, `/api/import`, `/api/properties` and `/api/transactions` stay 404 |
| `ENABLE_BUSINESS_SYNC_API` | `true` in `wrangler.jsonc` | Independent kill switch for the staged cross-browser snapshot/feed/mutation API | Enabled for the 2026-09-02 rollout. Setting it back to `false` does not delete data, but it strands a sync-enabled client on 404s with no `no_active_dataset` code — flip it together with the client flag and redeploy |
| `VITE_STANDALONE_LOCAL` | `true` in the standalone shape only | The SECOND flag `src/main.jsx` requires. A PROD build with `VITE_USE_LOCAL_AUTH=true` and this one absent, `false` or empty still refuses to boot, so a stray build cannot ship the untrusted auth path by accident. | Setting this on a build that can be reached anonymously = SECURITY DISASTER. Browser-side login and MFA are bypassable by anyone who loads the page; the upstream identity proxy (e.g. Cloudflare Access) is then the ONLY real boundary |
| `VITE_WEBSOCKET_ENDPOINT` | unset, or a `ws://` / `wss://` URL | Realtime CRDT sync (`src/crdt.jsx`). Only a ws/wss URL enables it; **any** other value (`disabled`, `off`, an `https://` URL, whitespace) resolves to unset and is warned about, so a hosting dashboard that refuses an empty value can still express "off". | Before 2026-08-23 any non-empty value reached `new WebsocketProvider()` and started a backoff loop that retried for as long as the tab stayed open |

Gate: `scripts/probe-standalone-deploy.mjs` (61/0) evaluates the boot condition and the
endpoint resolution **extracted verbatim from `src/main.jsx` and `src/crdt.jsx`** against a
table of environments. Reimplementing either rule inside the probe would only prove the
probe agrees with itself, and would keep passing after the real guard was deleted. Sections
5 and 6 do the same for the BUILD-time guard: they import `envGuardPlugin.js` and call its
real `configResolved` hook against a table of environments, then assert the guard is wired
into `vite.config.js` and that the CI build step supplies both flags.

### Base44 Config
| File | What It Does |
|------|-------------|
| `base44/config.jsonc` | Build commands + production security headers (CSP, HSTS preload, X-Frame DENY, nosniff) |
| `base44/.app.jsonc` | Links to cloud app ID: `6a7d6856ee1cc714b1803c0e` |
| `base44/auth/config.jsonc` | Auth methods enabled: password + Google OAuth (MS/FB/Apple/SAML disabled) |
| `base44/connectors/googledrive.jsonc` | Google Drive OAuth scopes (drive + email) |

---

# 10. TEST SCRIPTS — live gate re-measured 2026-09-01

The current auto-discovered gate is **142 suites** at list
`b24b8cfa`: the production-auth completion run reported 141 PASS, 0 FAIL,
and one explicit Not Run (`probe-config-exposure`, because no localhost dev
server was running). Vitest separately passed 45 files / 341 tests.

Auth-specific evidence:

- `probe-worker-app-auth.mjs`: 16/16 local Worker contract, including owner
  route capabilities and a non-owner privilege-escalation negative.
- `probe-worker-auth-remote.mjs`: 8/8 isolated remote Cloudflare runtime.
- `smoke-production-auth.mjs`: 22/22 real production; cleanup proved one
  versioned owner, zero legacy owners, and zero residual sessions, challenges,
  or smoke users.
- `probe-property-id-type.mjs`: 29/29 numeric/string cascade and isolation.

`probe-worker-auth-remote.mjs` has an environmental failure mode that looks like a
credential regression and is not one. Before it asserts anything it creates a real
temporary D1 with `wrangler d1 create`, and Cloudflare intermittently refuses that
one call with HTTP 401 `Authentication error [code: 10000]`. Observed 2026-09-03:
the refusal arrived while the OAuth token was valid — `d1 (write)` in scope, expiry
an hour out, and `GET /d1/database`, `/user`, `/accounts` and `/memberships` all
returning 200 in the same process 0.2s later. A differential over this machine's 30
`d1 create` invocations found 28 successes, and on 2026-09-01 the byte-identical
command failed at 09:23:32 and succeeded at 09:23:59 — 27 seconds later, same token,
same flags, no repository change. Re-running the suite unchanged returned 8 passed,
0 failed. Because the throw happens before the first `check()`, the suite prints no
PASS/FAIL/SKIP summary and exits 1, so `verify-all` reports FAIL for a run that
asserted nothing; it does not implement the `SKIP:`-and-exit-0 convention that seven
other suites use for an unavailable environment. Retry it before believing it.

Measured, not estimated. The heading here previously read "106 Files", which matched
nothing countable. Re-counted 2026-08-22; the 2026-08-20 set (117 / 95 / 73 / 71 / 34)
had gone stale as suites were added during the launch remediation, so **re-run the
one-liners rather than trusting these numbers**:

```
scripts/ on disk, all files incl. subdirs   132
  .mjs at the top level of scripts/         110
  named probe-*.mjs / verify-*.mjs           85
  auto-discovered as suites by verify:all    83   <- the number that matters
vitest .test/.spec files elsewhere in repo   36
```

83, not 85, because `verify-all.mjs` (the runner) and `verify-brain.mjs` (a docs gate) are
suite-named but excluded by name. Run `npm run verify:all -- --list` for the live list and
the exclusion reasons; every run also prints a `list <id> (<n> discovered)` fingerprint.
The fingerprint is `list 0c624d13 (83 discovered)` as of 2026-08-22. It changes
legitimately whenever a suite is added, so compare it **across shards of a single run** —
never against a number copied out of a document.

### Test Infrastructure
| File | What It Does |
|------|-------------|
| `scripts/_loader-boot.mjs` | Node bootstrap: @/ alias resolution, browser global shims (document, location), Web Worker shim |
| `scripts/_harness-auth.mjs` | Creates in-memory Owner account for fail-closed auth in tests |
| `scripts/resolve-alias.mjs` | Custom ESM loader: @/ -> src/ |
| `scripts/resolve-base44.mjs` | Custom ESM loader: redirects @base44/sdk to local stubs |
| `scripts/stubs/base44-runtime.mjs` | In-memory Base44 host mock (secret store, entity DB) |
| `scripts/stubs/base44-sdk.mjs` | In-memory SDK mock with -field sorting and monotonic sequences |
| `scripts/acceptance-harness.mjs` | 11 stateful sections that must run in order. **It does NOT run all probe tests** — that is `npm run verify:all`. It is not even auto-discovered (its name matches neither `probe-*` nor `verify-*`), it needs `vite`, and section 3.5 deletes ~7918 rows through `fake-indexeddb` so it cannot finish in a Linux sandbox. Opt-in flags: `HARNESS_SKIP=3,4`, `HARNESS_TIMING=1` |
| `scripts/probe-db-mock-rls.mjs` | **The only automated guard on `base44/**`.** Fails on any `__B44_DB__` shim or `db.*` call site in a serverless entry, deep-equals every property-scoped RLS rule against the canonical rule, then EXECUTES all 20 shipped rules against a 9-case access matrix. Mutation-self-tests every run: it rebuilds both historical RLS corruptions and fails if the matrix does not catch them. |
| `scripts/probe-audit-chain.mjs` | Imports the REAL serverless entry files (via `resolve-base44.mjs`) and asserts all 7 copies of the canonical audit payload agree with the verifier |
| `scripts/probe-deploy-config.mjs` | Parses (not pattern-matches) `manifest.json`, `vercel.json`, CSP headers |

### How To Run Tests
```powershell
# EVERYTHING. Start here -- auto-discovers all 111 suites, distinguishes PASS / FAIL /
# BROKEN (could not start) / TIMEOUT (could not finish) / BAD-EXIT / SKIP.
npm run verify:all
npm run verify:all -- --list            # the live list + why anything is excluded
npm run verify:all -- --filter money    # one slice (plain substring match)
npm run verify:all -- --shard 3/9       # the 3rd of 9 slices, for a capped wall clock

# One suite
node --import ./scripts/_loader-boot.mjs scripts/probe-money-kept-fix.mjs

# Probes that run standalone (no loader needed -- they stub the host themselves)
node scripts/probe-db-mock-rls.mjs
node scripts/probe-audit-chain.mjs
node scripts/probe-deploy-config.mjs

# Static gates
npm run lint            # eslint . --quiet     0 errors expected
npm run lint:fix
npm run typecheck       # tsc -p ./jsconfig.json with checkJs -- JSDoc is load-bearing
npm run brain:verify    # documentation gate (git hook); NOT a behaviour suite

# Vitest unit tests (34 .test/.spec files)
npm test                # vitest run
npm run test:watch
```

> [!CAUTION]
> **`npm test` and `scripts/acceptance-harness.mjs` do not run in a Linux sandbox** when
> `node_modules` was installed on Windows. Measured 2026-08-20:
> `Error: Cannot find module @rollup/rollup-linux-x64-gnu`. Same cause as the
> `verify-harness.mjs` SKIP. That is an environment limit, **not** a passing result — run
> them on Windows or in CI, and record them as *Not Run* anywhere else.
>
> **Do not lower `--timeout` to make a run fit a command-time cap.** It kills slow suites
> and labels them TIMEOUT, which fabricates failures. Shard the list instead, and confirm
> every shard printed the same `list <id>` before adding the shards up. Both traps are
> written up in BRAIN_TROUBLESHOOTING.md 22.3 and 22.5.

> [!IMPORTANT]
> `verify-transactions.mjs` and `verify-coexistence.mjs` MUST be run with
> `node --import ./scripts/_loader-boot.mjs`. Bare `node scripts/verify-*.mjs` dies on the
> `@/lib` alias or attempts a real HTTP call, which looks like a code failure but is not.

---

## Worker D1 write contracts (2026-09-02)

- `worker/schema.sql` must remain column/index/constraint compatible with `migrations-production/0001_auth_schema.sql` for every production-auth table. `scripts/verify-schema-parity.mjs` compares the real DDLs and keeps production authentication-only.
- Generic entity creation suppresses only deterministic same-primary-key replays with `ON CONFLICT(id) DO NOTHING`. It does not use blanket `INSERT OR IGNORE`, which previously hid required-field, foreign-key, and business-key failures.
- D1 write failures are classified by constraint kind: uniqueness is 409; missing/invalid/reference data is 422; non-constraint failures remain generic 500 without SQL details.
- Roster business keys are preflighted for an actionable conflict response, while the database uniqueness constraint remains the authority for races.
- Bulk writes remain one D1 batch so a rejected row cannot leave neighboring rows committed.
- The Worker user API stores real versioned credentials in the same atomic batch as the new user and grants. Password change/reset operations revoke sessions and MFA challenges in the same batch as the credential replacement.

Primary gates: `scripts/probe-worker-entities-conflict.mjs`, `scripts/probe-worker-entities-roster-create.mjs`, `scripts/probe-worker-credential-lifecycle.mjs`, and `scripts/verify-schema-parity.mjs`.

---

## Authoritative Cross-Browser Sync Property Mapping (2026-09-06)

- **Numeric vs. String Property ID Dual-Resolution**: Dexie stores `Property` records with auto-increment numbers (`n:1`), while parser and HTML select elements produce string IDs (`s:1:1`). `worker/business-sync.js` resolves this with `alternateKeyMap` during migration activation, ensuring child records reference their valid property without `422 orphaned property reference` errors and ensuring `UPDATE business_record SET server_property_id=?` covers both keys.
- **Session Property Access Expansion**: `worker/index.js` `/api/session` decodes `business_property_map` entries for the active generation to ensure scoped non-owner roles (e.g. GMs) receive both server property IDs and their corresponding local numeric/string keys in `property_access`.
- **User Administration Property Resolution**: `worker/users.js` `assertProperties` resolves incoming property IDs against active migration mappings when local numeric IDs are supplied by UI selectors.
- **Client Manifest & Invalidation**: `src/api/businessSync.js` computes revenue cents across both `total_revenue` and `room_revenue` fields and emits `publish('dataset', 'hydrate')` on snapshot load; `src/pages/Dashboard.jsx` invalidates `"daily-aggregates"` and `"properties"` to eliminate cold-browser stale caches.
- **Late Hydration Readers Join the Pull**: `ensureFresh()` awaits the active pull or hydration promise when a read arrives after snapshot hydration has started. A cold Browser B therefore cannot resolve a dashboard query against the pre-hydration empty cache.
- **Sync Admission Is Bounded and Server-Owned**: Direct mutation rows reject `account_id` and `server_property_id`, migration start accepts schema version 1 only, and each account may hold at most three pending cloned transactions. The pending limit is enforced inside the D1 batch as well as by a fast pre-check so concurrent starts cannot exceed it.
- **Transaction Cleanup Authorization**: A pending transaction may be aborted only by its creator or an account owner/admin. Non-admin creators must still hold every staged property grant at abort time; account-global targets remain all-property only.
- **Rollback Code Evacuation**: Active-generation rollback first moves every current property ID or code that conflicts with the previous roster to a unique temporary code in the same D1 batch, then restores the prior roster. This breaks swaps and reuse cycles without deleting properties or cascading away grants.
- **User Role Hierarchy**: A GM with delegated `manage_users` can manage GM/manager/front-desk accounts but cannot create, promote, modify, reset, or delete an admin. Owner-only restrictions remain in force for owner accounts.

Primary gates: `scripts/probe-cross-browser-sync-e2e.mjs`, `scripts/probe-gm-property-access.mjs`, `scripts/probe-adversarial-browser-b-kpis.mjs`, and `scripts/probe-worker-business-sync.mjs`.

---

## Cloudflare D1 Write-Amplification Remediation (Option D Architecture) (2026-09-06)

- **Elimination of O(N) Generation Cloning**: `startTransaction` in `worker/business-sync.js` no longer clones the active generation (previously copying 38,684 rows into `business_record`). Routine transactions now stage deltas in `business_record_staging` without touching the active generation until commit.
- **Set-Based Atomic In-Place Commit**: On `commitTransaction`, staged deltas are applied directly to the active dataset in `business_record`, generating sequential change logs in `business_change` (`seq = currentRevision + 1 + index`) and advancing `business_sync_state.revision += stagedRows.length`.
- **Inverse Pre/Post-Image Rollback Journaling with CAS Conflict Protection**:
  - `business_rollback_journal` captures the exact pre-image (`previous_row_json`, `previous_row_hash`) and applied post-image hash (`applied_row_hash`).
  - `POST /api/business-sync/transaction/rollback` restores prior states in $O(M)$ time. If any live record was altered by a subsequent transaction, CAS detection fails closed with HTTP 409 `ROLLBACK_CONFLICT`.
- **Migration Rollback Barrier**: When transactions commit against an active generation, `business_dataset.post_migration_mutated` is set to `1`. Subsequent calls to `rollbackMigration` are rejected with HTTP 409 `MIGRATION_ROLLBACK_BLOCKED` to prevent destroying post-migration business changes.
- **Migration Upfront Property Resolution**: `uploadChunk` resolves and stamps authoritative `server_property_id` on initial insert. `activateMigration` performs zero rewrites on `business_record` (reducing activation writes by 38,683 rows).
- **Auth Session Sliding Hysteresis & Fail-Silent Recovery**:
  - `authenticateAppSession` in `worker/app-auth.js` enforces a 15-minute sliding hysteresis window before issuing `UPDATE app_session` writes.
  - Heartbeat touches on read paths are non-blocking and fail-silent: transient D1 write quota limits do not block authenticated reads.
- **Client Realtime Tab Leader Election & Backoff**:
  - `src/lib/realtime.js` establishes a single leader tab across open browser tabs via `BroadcastChannel` (`rri_realtime_leader`). Only the elected leader executes the active polling timer.
  - When the leader polls, it broadcasts `POLL_TICK` to all peer tabs so they refresh local queries simultaneously without making redundant server requests.
  - Tabs automatically pause polling when minimized or hidden (`document.hidden`).
  - Exponential backoff doubles polling intervals up to 60s upon network or server errors, resetting to 10s on success.
- **Empirical Write Accounting (Proven by `scripts/probe-d1-write-budget.mjs`)**:
  - Transaction Start: 5 writes (guards, dataset, property map, staging tx).
  - Transaction Chunk: $3M + 2$ writes.
  - Transaction Commit: $3M + 6$ writes (journal, live updates, change log, revision, status, staging cleanup).
  - Total Lifecycle Writes: 30 rows for $M=1$ (was 38,685, a 1,289x reduction); 48 rows for $M=3$ (was 38,687, an 805x reduction); 949 rows for $M=100$.
  - Session Read: 0 writes within 15-minute window; 1 write after window expiry.

Primary gates: `scripts/probe-d1-write-budget.mjs` (4 assertions validating write bounds and session hysteresis), `scripts/probe-realtime-leader.mjs`, `scripts/probe-worker-business-sync.mjs`, `scripts/probe-business-sync-global-records.mjs`, and `scripts/verify-schema-parity.mjs`.


