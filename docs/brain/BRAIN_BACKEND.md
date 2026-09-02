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
| `.env.production` | `VITE_USE_SERVER_AUTH=true` + `VITE_USE_D1_API=false` | Current production: same-origin Worker authentication with browser-local business storage | This committed file contains public build flags only. Never add a password, token, pepper, or other secret |
| `PASSWORD_PEPPER_V1` | Cloudflare Worker secret (not a file) | Post-hash HMAC pepper for versioned owner credentials | Missing/short values make authentication return controlled 503; never place this value in source, logs, chat, or `.env.production` |
| `ENABLE_D1_DATA_API` | `false` in `wrangler.jsonc` | Runtime kill switch for Worker business-data endpoints | Do not enable during the auth-only rollout; existing hotel data remains in IndexedDB |
| `VITE_STANDALONE_LOCAL` | `true` in the standalone shape only | The SECOND flag `src/main.jsx` requires. A PROD build with `VITE_USE_LOCAL_AUTH=true` and this one absent, `false` or empty still refuses to boot, so a stray build cannot ship the untrusted auth path by accident. | Setting this on a build that can be reached anonymously = SECURITY DISASTER. Browser-side login and MFA are bypassable by anyone who loads the page; the upstream identity proxy (e.g. Cloudflare Access) is then the ONLY real boundary |
| `VITE_WEBSOCKET_ENDPOINT` | unset, or a `ws://` / `wss://` URL | Realtime CRDT sync (`src/crdt.jsx`). Only a ws/wss URL enables it; **any** other value (`disabled`, `off`, an `https://` URL, whitespace) resolves to unset and is warned about, so a hosting dashboard that refuses an empty value can still express "off". | Before 2026-08-23 any non-empty value reached `new WebsocketProvider()` and started a backoff loop that retried for as long as the tab stayed open |

Gate: `scripts/probe-standalone-deploy.mjs` (49/0) evaluates the boot condition and the
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
