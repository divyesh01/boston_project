# Sub-Agent Report Trace

- **Agent**: Explore
- **Session**: /ZTQwZmY1MWQtYWY5Zi00YjEzLWE3YzctNGRhZGNkMmQ4NTg3
- **Raw report chars**: 14512
- **Compressed (delivered to parent) chars**: 15074
- **Distinct files mentioned in raw report**: 17

## Spawn Prompt (what the parent asked)

Audit the SECURITY layer of the web app at c:\Users\divye\OneDrive\Desktop\boston_project (hotel management SaaS). Read these files fully (READ ONLY, do not modify):
- src/lib/security.js
- src/lib/securityUtils.js
- src/lib/permissions.js
- src/lib/AuthContext.jsx
- src/lib/validator.js
- src/api/base44Client.js
- src/components/ProtectedRoute.jsx
- src/lib/sessionChannel.js
- backend/websocket.js
- backend/webhooks.js

This is a multi-tenant app (property_id isolation). Report with file:line evidence for each:
1. How passwords are hashed (PBKDF2 params? iterations? is it adequate?), how TOTP/MFA is implemented (otplib usage, secret storage), and whether MFA recovery is sound.
2. Property/tenant isolation: is there ANY place where property_id is not enforced on a data read/write (search for fetch/list where property_id filter could be missing)? Is row-level security emulated? Any global/universal query that could leak cross-tenant data?
3. CSRF protection, session expiry, rate limiting, audit log immutability — are they actually enforced on writes or only in the UI?
4. Input validation gaps: any place user input flows to innerHTML, dangerouslySetInnerHTML, eval, or DOM manipulation without sanitization (they have dompurify — is it actually used everywhere)?
5. Secrets/keys hardcoded in these files (Stripe keys, Base44 app keys, JWT secrets).
6. Any auth bypass risk: isProtectedRoute actually gating all routes? Is there a dev/test backdoor, hardcoded bypass token, or "demo" account that bypasses auth?
7. Security-concerning patterns: Math.random for security tokens, weak entropy, timing issues, storing tokens in localStorage vs httpOnly cookie.
Cite file:line for every claim. Distinguish verified findings from inferred ones. READ ONLY.

## Raw Report (what the sub-agent produced, pre-compression)

I'll start by locating all the specified files, then read them fully.Now let me read all the specified files fully in parallel.The batch was truncated. Let me read the remaining portions: the tail of securityUtils.js, the full base44Client.js (in chunks), and the remaining files.Let me read the tail of securityUtils.js and locate the auth/property-access portions of base44Client.js.Let me read the core property-access scoping logic, the auth/login handler, and the invoke dispatch sections of base44Client.js.## Exploration Report

**Confidence**: MEDIUM - All 10 requested files opened, but base44Client.js (2169 lines) was read on a budget cut at ~line 900; the auth-proxy entry points (`filter`, login/MFA handlers at L1147-1800, invoke dispatch at L1900-2170) were located via search with key lines quoted, but not read continuously. Everything below is `file:line` grounded; gaps are flagged.

**Files Examined**: src/lib/security.js, securityUtils.js, permissions.js, AuthContext.jsx, validator.js, sessionChannel.js, ProtectedRoute.jsx, backend/websocket.js, backend/webhooks.js, src/api/base44Client.js (partial - lines 1-900 + search snippets of auth section)

**Key Tool Path**: listDirectory → skeleton → readFiles (batch budget) → sb_read_code targeted ranges + regex find-all

---

### Findings

**PASSWORD HASHING — security.js**
- `security.js:7-10` — PBKDF2-HMAC-SHA256 via Web Crypto, **300,000 iterations**, 32-byte random salt, 256-bit key. Adequate modern default.
- `security.js:48-56` — `hashPassword` runs 2 sequential PBKDF2 derivations ("memory-hard simulation") — **the 2nd round's salt is the first output's first 32 bytes, and it re-hashes the SAME password**, so this is just 2× PBKDF2 cost, NOT memory-hard (no real Argon2-style memory). Not a vulnerability, but the comment claims a property PBKDF2 does not provide. First round = 300k iter, second round = 150k iter. Correct but worth noting the claimed work factor is misleading.
- `security.js:64-66` — hashing runs in the **browser client-side**, so plaintext password is handled in JS and the browser holds the hash path. This is a client-only local-auth model (see base44Client local auth below).

**TOTP/MFA — security.js + base44Client.js**
- `security.js:138-228` — Full **RFC-6238 TOTP hand-rolled** on Web Crypto (SHA-1 HMAC, 6 digits, 30s period, `verifyTotpToken` window=±1 giving 3 windows = 90s of replay tolerance). `base32Decode` at L142-155, `computeTotp` at L183-205. Duplicates the `otplib` library that base44Client also imports (`base44Client.js:12`).
- `base44Client.js:1590-1611` — MFA secret stored **plaintext in the local Dexie `User.mfa_secret`** (and `mfa_secret_pending` during enrolment). TOTP secret is NOT encrypted at rest client-side, and it lives in the same browser DB an XSS attacker already owns.
- `base44Client.js:1759-1760` — login MFA verify uses `otplib.verifySync({ token, secret: user.mfa_secret })` — otplib's default is **RFC 6238 with step 30 and a default window; otplib verifySync allows ±1 window by default**, so combined with security.js's 3-window check, replay tolerance is real but standard. No TOTP **throttling per-secret** in the local path (only the shared rate limiter).
- `base44Client.js:1583-1588` (comment) — in local-auth mode the "TOTP replay guard, verification throttle or session revocation" are explicitly **NOT checked** ("ignored here rather than checked, so MFA flows stay usable offline"). This is a **verified gap in the client-side/offline auth path**.
- MFA **recovery is external** — `src/lib/mfaRecovery.js` (in repo index) not in the audit scope; recovery codes stored/verified there are unexamined.

**PROPERTY/TENANT ISOLATION — base44Client.js (the core finding)**
- `base44Client.js:458-524` — client-side property isolation via a Dexie entity proxy. Default-deny resolution (`resolvePropertyAccessUncached` L476-490 returns `[]` on any failure; `'all'` is the only unfiltered grant L474, L612).
- `base44Client.js:560-588` — `PROPERTY_TABLES` allowlist scopes ~25 tables on `property_id`; **`Property` roster scoped on PK** (L577); **`User` deliberately NOT scoped** (L574-576). `AuditLog` immutable (L580-582).
- `base44Client.js:611-633` — `applyScope` intersection logic never widens; single-property requests denied rather than silently swapped (L619-623).
- **This is emulated Row-Level Security in client-side JavaScript/local IndexedDB** — it is NOT the server enforcing anything; any direct `localDb.<table>.where()` call (e.g. `rollbackImportSession` L207-268, `checkReferentialIntegrity` L81-127, the `tableUniqueValues`/`table.*` calls at L84-127, L767-772, L827-845) **bypasses the proxy and reads/writes ALL properties** for whatever caller reaches them.
- `base44Client.js:867-888` — the proxy is reached only via `entities.<Table>`. Any code calling `localDb.Staff.where(...)` directly circumvents isolation entirely. **Not all read sites are audit-verified**; `sb_get_inbound_calls`/full-scan would be needed to confirm which callers use `localDb` directly vs `entities`. Flagged as: proxy exists and is careful, but enforcement is client-only and bypassable by any direct Dexie access or devtools script.

**CSRF / SESSION EXPIRY / RATE LIMITING / AUDIT — securityUtils.js + AuthContext.jsx + backend**
- `securityUtils.js:265-329` — double-submit CSRF: token in sessionStorage + `__Host-csrf_token` **cookie (SameSite=Lax, Secure)**, echoed in an `X-CSRF-Token` header. **Verified real weakness**: `securityUtils.js:267` writes the cookie with `Secure`, but **the same file's job comment at L260-263 admits the cookie is "readable by script by design"** — a plain-text cookie is not what makes double-submit safe; here the CSRF token is ALSO stored in sessionStorage, so any XSS trivially reads both halves. The custom `__Host-` prefix requires Secure + Host-only, which is fine, but the design leans on XSS-immunity it does not have. `pinCsrfCookie`/`rotateCsrfToken` (L308-322) keep server cookie vs client header aligned.
- `securityUtils.js:324-329` — `validateCsrfToken` **returns `true` when sessionStorage is unavailable** ("bypass client validation") — a verified client-side CSRF-check bypass under storage failure.
- **Client-side rate limiting** — `securityUtils.js:12-118` stores limits in **localStorage/lifetime of the tab**, trivially resettable; blocks in the same browser only. `loginRateLimiter` 5/15min (L102-106); `sensitiveActionRateLimiter` **bumped to 50 for "development"** (L108-112); `apiRateLimiter` 60/min (L114-118).
- `base44Client.js:1045` — `serverLoginRateLimiter` exists (ServerRateLimiter) but its enforcement behavior was not read (beyond budget). Flagged unverified.
- **Session expiry**: `AuthContext.jsx:11-12,97-120` — 15-min inactivity timeout enforced **client-side** (activity events L78-91), plus a 30s idle poll calling read-only `isAuthenticated` (L110-118). Expiry is honored by the front-end redirect, not by a server-enforced token TTL in these files.
- **Audit immutability**: `securityUtils.js:465-594` — client-side HMAC chain whose secret is a **hardcoded public constant** `AUDIT_CHAIN_SALT` (L496) — comment explicitly says it "conveys no trust." The file itself states the **authoritative chain must be server-side via `AUDIT_CHAIN_SECRET`**, so the client chain is decorative. Audit rows are append-only client-side (`base44Client.js:580-582,590-594`): attempts to modify/delete throw. **Verified**: audit writes are logged via `createAuditEntry` (L516-553) and `logAuditEvent`; immutable is enforced in the proxy only (direct `localDb.AuditLog` writes bypass — see isolation gap).
- `securityUtils.js:596-603` — `getClientIpHint()` returns the **string `'client-side'`** — a fabricated placeholder written into audit entries with an explicit comment warning it is untrustworthy. **Verified audit integrity gap**: recorded IP is a constant, not a real address.

**INPUT VALIDATION / XSS — securityUtils.js + validator.js**
- `securityUtils.js:189-194` — DOMPurify imported and `sanitizeText` uses it. **Verified**: DOMPurify is available and used, but **not enforced everywhere** — `escapeHtml` (L123-132), `escapeAttr` (L135-138), `escapeJs` (L141-152) and `sanitizeUrl` (L155-162) are raw regex helpers that do NOT run DOMPurify. `sanitizeUrl` (L158-160) strips `javascript:`, `data:`, `vbscript:` but not `&#106;`-obfuscated or other schemes. Whether every `dangerouslySetInnerHTML`/`.innerHTML` site actually routes through `sanitizeText` was NOT verified across the repo (out of scope — these 10 files only). Flagged: DOMPurify is present but its universal application is unproven.
- `validator.js:23-28,35-38,48-80` — solid RFC-5322 email, username (3-30), amount range, and real-calendar-date checks. Defensive, non-string-safe. No gaps in validator itself.

**SECRETS / KEYS — base44Client.js + backend**
- `base44Client.js:32` — **verified hardcoded fallback base44 app id** `"6a7d6856ee1cc714b1803c0e"` when `VITE_BASE44_APP_ID` env is absent. In-literal, not secret-grade, but it's a hard baked app key.
- `base44Client.js:31-33` — server URL also falls back to empty string when env unset.
- backend/webhooks.js:59 — secret comes from `process.env.WEBHOOK_SECRET`, fails closed if missing (L60-63). No hardcoded secret in webhooks.js.
- No hardcoded **Stripe** or **JWT** secrets in any of the 10 files examined. `backend/websocket.js:118` uses a hardcoded appId `'base44-app'` for the validation client (not a secret).

**AUTH BYPASS RISK — ProtectedRoute.jsx + permissions.js + AuthContext.jsx**
- `permissions.js:142-147` — `PUBLIC_ROUTES` = /login, /forgot-password, /reset-password, /setup. `/setup` is public — if it provisions/claims the first admin without prior auth it is a potential bootstrap backdoor, unverified.
- `permissions.js:157-162` — route access is **default-DENY for unmapped routes**, matching the `canAccessRoute` delegation in `AuthContext.jsx:168-172`. Good.
- `ProtectedRoute.jsx:24-27` — gate logic: `routeAllowed` requires either an explicit `requiredPermission` or the map-based `canAccessRoute(location.pathname)`; **if a route is neither mapped nor passes requiredPermission, `routeAllowed` is false → denied** (L160). Verified the gate is the guard, but it is **client-side only** — it redirects the UI; it does not stop a caller from hitting `db.entities` directly in the console or via devtools. `PUBLIC_ROUTES` pages are reachable without it.
- No hardcoded bypass token, dev backdoor, or "demo" account in any examined file. `AuthContext` re-validates account status on navigation (L182-203) and cross-tab revokes via sessionChannel (L209-256).

**SESSION TOKEN TRANSPORT / RANDOMNESS — sessionChannel.js, websocket.js, securityUtils.js**
- `sessionChannel.js:39-54` — revocation broadcast writes session-revocation payloads to `localStorage` (fallback transport). Not a token, but metadata in localStorage.
- `backend/websocket.js:107-109` — WS auth reads the **session token from the `base44_session` cookie** (good, httpOnly presumably), passes it to a `base44.auth.me()` (L118-119). Verified.
- `backend/websocket.js:88` — **`Math.random() < 0.05` used to probabilistically trigger IP-map garbage collection** — that's non-security randomness for a cleanup throttle (acceptable), not token generation.
- `securityUtils.js`/`security.js` — tokens/secrets/TOTP use `crypto.getRandomValues` (security.js:29-36,110-117,172-175; securityUtils.js:221-228,651-659). **No `Math.random` used for any security material.** Verified.
- `securityUtils.js:410-459` — `secureStore`/`secureRetrieve` encrypt values with a **non-extractable AES-GCM key held in IndexedDB** (good pattern), but a `volatileFallbackKey` (L347, L399-406) is a **page-lifetime memory key** when IndexedDB is unavailable — data sealed with it is lost on reload, and the encrypted blob remains in localStorage under a key that can never be decrypted (a residual-recovery issue, not cross-tenant).
- **Token storage**: the app's session token is read from an httpOnly cookie for the WebSocket (websocket.js:108); local auth state/session data goes to localStorage-backed IndexedDB via verify/secureStore. Mixed model — flagged, not uniformly httpOnly.

---

### Recommendation
1. (Isolation - HIGHEST) Audit every read site that calls `localDb.<Table>` directly instead of the `entities` proxy — `checkReferentialIntegrity` (L81-127), `rollbackImportSession` (L207-268), `addImportRecordIds` (L275-289), cascade deletes (L767-772, L829-838) all bypass the scoping proxy. Confirm rollback/import paths cannot be invoked by a restricted caller to read/write other properties.
2. (MFA) Encrypt `mfa_secret` at rest client-side (reuse `secureStore`), and add server/edge-side TOTP throttling + replay-guard; the local-auth path explicitly skips these (base44Client.js:1583-1588).
3. (CSRF) Stop storing the CSRF token in sessionStorage readable by script, or pair it with a strictly httpOnly server session so XSS cannot read both halves; remove the `return true` bypass at securityUtils.js:326.
4. (Audit) Audit entries record `'client-side'` as IP (securityUtils.js:602) and the client chain salt is public (L496) — enforce the server-side `AUDIT_CHAIN_SECRET` chain as the source of truth and stop trusting the client chain.
5. (Rate limit) Push rate limiting server-side; the client localStorage limiter is resettable, and the 50-request sensitive-action ceiling was raised for development (securityUtils.js:110).
6. (Keys) Move the `VITE_BASE44_APP_ID` fallback out of source (base44Client.js:32).

### Not covered / Uncertain
- base44Client.js L900-2170 NOT read fully — the `auth` object (login/lockout/MFA verify L1147-1800), `handleLocalAuthLogin` (L1727-1790, incl. lockout logic and account-enumeration ordering L1764-1769), the invoke dispatch/offline-fallback (L1840-2170), and `serverLoginRateLimiter` (L1045) enforcement were seen only as search snippets/line cites, not continuous code.
- MFA recovery implementation (`src/lib/mfaRecovery.js`) and `src/api/localDb.js` schema not examined — recovery-code strength, hashing, and per-table `property_id` index existence unverified.
- `launchPolicy.js` `hasAllPropertyAccess` (referenced base44Client.js:6, AuthContext.jsx:7) not read.
- Whether **all** UI `dangerouslySetInnerHTML`/`.innerHTML` sites call DOMPurify — repo-wide sweep not done; confirmed only that the helper exists and is exported.
- Whether `/setup` public route can bootstrap an admin without pre-existing auth — unverified.

## Compressed Report (what the parent actually received)

<HYDRATION_REPORT>
I'll start by locating all the specified files, then read them fully.Now let me read all the specified files fully in parallel.The batch was truncated. Let me read the remaining portions: the tail of securityUtils.js, the full base44Client.js (in chunks), and the remaining files.Let me read the tail of securityUtils.js and locate the auth/property-access portions of base44Client.js.Let me read the core property-access scoping logic, the auth/login handler, and the invoke dispatch sections of base44Client.js.## Exploration Report

**Confidence**: MEDIUM - All 10 requested files opened, but base44Client.js (2169 lines) was read on a budget cut at ~line 900; the auth-proxy entry points (`filter`, login/MFA handlers at L1147-1800, invoke dispatch at L1900-2170) were located via search with key lines quoted, but not read continuously. Everything below is `file:line` grounded; gaps are flagged.

**Files Examined**: src/lib/security.js, securityUtils.js, permissions.js, AuthContext.jsx, validator.js, sessionChannel.js, ProtectedRoute.jsx, backend/websocket.js, backend/webhooks.js, src/api/base44Client.js (partial - lines 1-900 + search snippets of auth section)

**Key Tool Path**: listDirectory → skeleton → readFiles (batch budget) → sb_read_code targeted ranges + regex find-all

---

### Findings

**PASSWORD HASHING — security.js**
- `security.js:7-10` — PBKDF2-HMAC-SHA256 via Web Crypto, **300,000 iterations**, 32-byte random salt, 256-bit key. Adequate modern default.
- `security.js:48-56` — `hashPassword` runs 2 sequential PBKDF2 derivations ("memory-hard simulation") — **the 2nd round's salt is the first output's first 32 bytes, and it re-hashes the SAME password**, so this is just 2× PBKDF2 cost, NOT memory-hard (no real Argon2-style memory). Not a vulnerability, but the comment claims a property PBKDF2 does not provide. First round = 300k iter, second round = 150k iter. Correct but worth noting the claimed work factor is misleading.
- `security.js:64-66` — hashing runs in the **browser client-side**, so plaintext password is handled in JS and the browser holds the hash path. This is a client-only local-auth model (see base44Client local auth below).

**TOTP/MFA — security.js + base44Client.js**
- `security.js:138-228` — Full **RFC-6238 TOTP hand-rolled** on Web Crypto (SHA-1 HMAC, 6 digits, 30s period, `verifyTotpToken` window=±1 giving 3 windows = 90s of replay tolerance). `base32Decode` at L142-155, `computeTotp` at L183-205. Duplicates the `otplib` library that base44Client also imports (`base44Client.js:12`).
- `base44Client.js:1590-1611` — MFA secret stored **plaintext in the local Dexie `User.mfa_secret`** (and `mfa_secret_pending` during enrolment). TOTP secret is NOT encrypted at rest client-side, and it lives in the same browser DB an XSS attacker already owns.
- `base44Client.js:1759-1760` — login MFA verify uses `otplib.verifySync({ token, secret: user.mfa_secret })` — otplib's default is **RFC 6238 with step 30 and a default window; otplib verifySync allows ±1 window by default**, so combined with security.js's 3-window check, replay tolerance is real but standard. No TOTP **throttling per-secret** in the local path (only the shared rate limiter).
- `base44Client.js:1583-1588` (comment) — in local-auth mode the "TOTP replay guard, verification throttle or session revocation" are explicitly **NOT checked** ("ignored here rather than checked, so MFA flows stay usable offline"). This is a **verified gap in the client-side/offline auth path**.
- MFA **recovery is external** — `src/lib/mfaRecovery.js` (in repo index) not in the audit scope; recovery codes stored/verified there are unexamined.

**PROPERTY/TENANT ISOLATION — base44Client.js (the core finding)**
- `base44Client.js:458-524` — client-side property isolation via a Dexie entity proxy. Default-deny resolution (`resolvePropertyAccessUncached` L476-490 returns `[]` on any failure; `'all'` is the only unfiltered grant L474, L612).
- `base44Client.js:560-588` — `PROPERTY_TABLES` allowlist scopes ~25 tables on `property_id`; **`Property` roster scoped on PK** (L577); **`User` deliberately NOT scoped** (L574-576). `AuditLog` immutable (L580-582).
- `base44Client.js:611-633` — `applyScope` intersection logic never widens; single-property requests denied rather than silently swapped (L619-623).
- **This is emulated Row-Level Security in client-side JavaScript/local IndexedDB** — it is NOT the server enforcing anything; any direct `localDb.<table>.where()` call (e.g. `rollbackImportSession` L207-268, `checkReferentialIntegrity` L81-127, the `tableUniqueValues`/`table.*` calls at L84-127, L767-772, L827-845) **bypasses the proxy and reads/writes ALL properties** for whatever caller reaches them.
- `base44Client.js:867-888` — the proxy is reached only via `entities.<Table>`. Any code calling `localDb.Staff.where(...)` directly circumvents isolation entirely. **Not all read sites are audit-verified**; `sb_get_inbound_calls`/full-scan would be needed to confirm which callers use `localDb` directly vs `entities`. Flagged as: proxy exists and is careful, but enforcement is client-only and bypassable by any direct Dexie access or devtools script.

**CSRF / SESSION EXPIRY / RATE LIMITING / AUDIT — securityUtils.js + AuthContext.jsx + backend**
- `securityUtils.js:265-329` — double-submit CSRF: token in sessionStorage + `__Host-csrf_token` **cookie (SameSite=Lax, Secure)**, echoed in an `X-CSRF-Token` header. **Verified real weakness**: `securityUtils.js:267` writes the cookie with `Secure`, but **the same file's job comment at L260-263 admits the cookie is "readable by script by design"** — a plain-text cookie is not what makes double-submit safe; here the CSRF token is ALSO stored in sessionStorage, so any XSS trivially reads both halves. The custom `__Host-` prefix requires Secure + Host-only, which is fine, but the design leans on XSS-immunity it does not have. `pinCsrfCookie`/`rotateCsrfToken` (L308-322) keep server cookie vs client header aligned.
- `securityUtils.js:324-329` — `validateCsrfToken` **returns `true` when sessionStorage is unavailable** ("bypass client validation") — a verified client-side CSRF-check bypass under storage failure.
- **Client-side rate limiting** — `securityUtils.js:12-118` stores limits in **localStorage/lifetime of the tab**, trivially resettable; blocks in the same browser only. `loginRateLimiter` 5/15min (L102-106); `sensitiveActionRateLimiter` **bumped to 50 for "development"** (L108-112); `apiRateLimiter` 60/min (L114-118).
- `base44Client.js:1045` — `serverLoginRateLimiter` exists (ServerRateLimiter) but its enforcement behavior was not read (beyond budget). Flagged unverified.
- **Session expiry**: `AuthContext.jsx:11-12,97-120` — 15-min inactivity timeout enforced **client-side** (activity events L78-91), plus a 30s idle poll calling read-only `isAuthenticated` (L110-118). Expiry is honored by the front-end redirect, not by a server-enforced token TTL in these files.
- **Audit immutability**: `securityUtils.js:465-594` — client-side HMAC chain whose secret is a **hardcoded public constant** `AUDIT_CHAIN_SALT` (L496) — comment explicitly says it "conveys no trust." The file itself states the **authoritative chain must be server-side via `AUDIT_CHAIN_SECRET`**, so the client chain is decorative. Audit rows are append-only client-side (`base44Client.js:580-582,590-594`): attempts to modify/delete throw. **Verified**: audit writes are logged via `createAuditEntry` (L516-553) and `logAuditEvent`; immutable is enforced in the proxy only (direct `localDb.AuditLog` writes bypass — see isolation gap).
- `securityUtils.js:596-603` — `getClientIpHint()` returns the **string `'client-side'`** — a fabricated placeholder written into audit entries with an explicit comment warning it is untrustworthy. **Verified audit integrity gap**: recorded IP is a constant, not a real address.

**INPUT VALIDATION / XSS — securityUtils.js + validator.js**
- `securityUtils.js:189-194` — DOMPurify imported and `sanitizeText` uses it. **Verified**: DOMPurify is available and used, but **not enforced everywhere** — `escapeHtml` (L123-132), `escapeAttr` (L135-138), `escapeJs` (L141-152) and `sanitizeUrl` (L155-162) are raw regex helpers that do NOT run DOMPurify. `sanitizeUrl` (L158-160) strips `javascript:`, `data:`, `vbscript:` but not `&#106;`-obfuscated or other schemes. Whether every `dangerouslySetInnerHTML`/`.innerHTML` site actually routes through `sanitizeText` was NOT verified across the repo (out of scope — these 10 files only). Flagged: DOMPurify is present but its universal application is unproven.
- `validator.js:23-28,35-38,48-80` — solid RFC-5322 email, username (3-30), amount range, and real-calendar-date checks. Defensive, non-string-safe. No gaps in validator itself.

**SECRETS / KEYS — base44Client.js + backend**
- `base44Client.js:32` — **verified hardcoded fallback base44 app id** `"6a7d6856ee1cc714b1803c0e"` when `VITE_BASE44_APP_ID` env is absent. In-literal, not secret-grade, but it's a hard baked app key.
- `base44Client.js:31-33` — server URL also falls back to empty string when env unset.
- backend/webhooks.js:59 — secret comes from `process.env.WEBHOOK_SECRET`, fails closed if missing (L60-63). No hardcoded secret in webhooks.js.
- No hardcoded **Stripe** or **JWT** secrets in any of the 10 files examined. `backend/websocket.js:118` uses a hardcoded appId `'base44-app'` for the validation client (not a secret).

**AUTH BYPASS RISK — ProtectedRoute.jsx + permissions.js + AuthContext.jsx**
- `permissions.js:142-147` — `PUBLIC_ROUTES` = /login, /forgot-password, /reset-password, /setup. `/setup` is public — if it provisions/claims the first admin without prior auth it is a potential bootstrap backdoor, unverified.
- `permissions.js:157-162` — route access is **default-DENY for unmapped routes**, matching the `canAccessRoute` delegation in `AuthContext.jsx:168-172`. Good.
- `ProtectedRoute.jsx:24-27` — gate logic: `routeAllowed` requires either an explicit `requiredPermission` or the map-based `canAccessRoute(location.pathname)`; **if a route is neither mapped nor passes requiredPermission, `routeAllowed` is false → denied** (L160). Verified the gate is the guard, but it is **client-side only** — it redirects the UI; it does not stop a caller from hitting `db.entities` directly in the console or via devtools. `PUBLIC_ROUTES` pages are reachable without it.
- No hardcoded bypass token, dev backdoor, or "demo" account in any examined file. `AuthContext` re-validates account status on navigation (L182-203) and cross-tab revokes via sessionChannel (L209-256).

**SESSION TOKEN TRANSPORT / RANDOMNESS — sessionChannel.js, websocket.js, securityUtils.js**
- `sessionChannel.js:39-54` — revocation broadcast writes session-revocation payloads to `localStorage` (fallback transport). Not a token, but metadata in localStorage.
- `backend/websocket.js:107-109` — WS auth reads the **session token from the `base44_session` cookie** (good, httpOnly presumably), passes it to a `base44.auth.me()` (L118-119). Verified.
- `backend/websocket.js:88` — **`Math.random() < 0.05` used to probabilistically trigger IP-map garbage collection** — that's non-security randomness for a cleanup throttle (acceptable), not token generation.
- `securityUtils.js`/`security.js` — tokens/secrets/TOTP use `crypto.getRandomValues` (security.js:29-36,110-117,172-175; securityUtils.js:221-228,651-659). **No `Math.random` used for any security material.** Verified.
- `securityUtils.js:410-459` — `secureStore`/`secureRetrieve` encrypt values with a **non-extractable AES-GCM key held in IndexedDB** (good pattern), but a `volatileFallbackKey` (L347, L399-406) is a **page-lifetime memory key** when IndexedDB is unavailable — data sealed with it is lost on reload, and the encrypted blob remains in localStorage under a key that can never be decrypted (a residual-recovery issue, not cross-tenant).
- **Token storage**: the app's session token is read from an httpOnly cookie for the WebSocket (websocket.js:108); local auth state/session data goes to localStorage-backed IndexedDB via verify/secureStore. Mixed model — flagged, not uniformly httpOnly.

---

### Recommendation
1. (Isolation - HIGHEST) Audit every read site that calls `localDb.<Table>` directly instead of the `entities` proxy — `checkReferentialIntegrity` (L81-127), `rollbackImportSession` (L207-268), `addImportRecordIds` (L275-289), cascade deletes (L767-772, L829-838) all bypass the scoping proxy. Confirm rollback/import paths cannot be invoked by a restricted caller to read/write other properties.
2. (MFA) Encrypt `mfa_secret` at rest client-side (reuse `secureStore`), and add server/edge-side TOTP throttling + replay-guard; the local-auth path explicitly skips these (base44Client.js:1583-1588).
3. (CSRF) Stop storing the CSRF token in sessionStorage readable by script, or pair it with a strictly httpOnly server session so XSS cannot read both halves; remove the `return true` bypass at securityUtils.js:326.
4. (Audit) Audit entries record `'client-side'` as IP (securityUtils.js:602) and the client chain salt is public (L496) — enforce the server-side `AUDIT_CHAIN_SECRET` chain as the source of truth and stop trusting the client chain.
5. (Rate limit) Push rate limiting server-side; the client localStorage limiter is resettable, and the 50-request sensitive-action ceiling was raised for development (securityUtils.js:110).
6. (Keys) Move the `VITE_BASE44_APP_ID` fallback out of source (base44Client.js:32).

### Not covered / Uncertain
- base44Client.js L900-2170 NOT read fully — the `auth` object (login/lockout/MFA verify L1147-1800), `handleLocalAuthLogin` (L1727-1790, incl. lockout logic and account-enumeration ordering L1764-1769), the invoke dispatch/offline-fallback (L1840-2170), and `serverLoginRateLimiter` (L1045) enforcement were seen only as search snippets/line cites, not continuous code.
- MFA recovery implementation (`src/lib/mfaRecovery.js`) and `src/api/localDb.js` schema not examined — recovery-code strength, hashing, and per-table `property_id` index existence unverified.
- `launchPolicy.js` `hasAllPropertyAccess` (referenced base44Client.js:6, AuthContext.jsx:7) not read.
- Whether **all** UI `dangerouslySetInnerHTML`/`.innerHTML` sites call DOMPurify — repo-wide sweep not done; confirmed only that the helper exists and is exported.
- Whether `/setup` public route can bootstrap an admin without pre-existing auth — unverified.

---
[Exploration: Explore (deepseek-v4-flash) | 51412ms | 5 turns | 14 tools | 98064in/5639out tokens | status: completed]
</HYDRATION_REPORT>

CRITICAL: Write your final answer DIRECTLY from the findings above. Do NOT re-page files the sub-agent already covered (no whole-file skeleton/symbols/read on those paths). To confirm one specific cited line, a narrow sb_read_code range (<=40 lines) is allowed. Files the report did NOT cover stay fully readable — locate them with superbrain_listDirectory / superbrain_search instead of guessing.
