# 13. SECURITY ARCHITECTURE

### Authentication Flow
```
User enters email + password
  --> Rate limiter checks (5 attempts / 15 min per IP)
  --> scrypt hash verification (legacy PBKDF2 auto-upgrades to scrypt)
  --> If MFA enabled: TOTP verification (counter replay prevented via mfa_last_counter)
  --> Session created (SHA-256 token hash stored in Session entity)
  --> HTTP-only Secure cookie set (7-day expiry, 30-day absolute max)
  --> Audit log entry written (SHA-256 HMAC chained with AUDIT_CHAIN_SECRET)
```

### Session Management
```
Session lifetime:    7 days (slides if <3 days remaining)
Absolute maximum:    30 days (no sliding after this)
Idle detection:      30-second polling in AuthContext
Revocation:          Immediate on logout, password change, or privilege change
Cross-tab sync:      BroadcastChannel (sessionChannel.js)
Storage:             Server-side (Session entity), client gets opaque HTTP-only cookie
```

### CSRF Protection
```
Cookie name:     __Host-csrf_token
Flags:           Secure; Path=/; SameSite=Lax
__Host- prefix:  HTTPS only, no subdomain override, Path must be /
```

### Rate Limiting
```
Login:            5 attempts per IP per 15 minutes
Password Reset:   Rate limited by IP AND by target email
MFA Verification: Rate limited per account
```

### Audit Log (Tamper-Proof Blockchain-Style)
```
Each entry = SHA-256 HMAC of:
  canonical payload + previous entry's hash + AUDIT_CHAIN_SECRET

Result: Linked chain. If anyone edits or deletes a row,
the chain breaks and audit_verify detects the tampering.
The audit_clear function ALWAYS returns 403 -- log can never be erased.
```

**The canonical payload, and why it exists 7 times.** The signed field set is:

```
AUDIT_CANONICAL_V1 = user_id, action, performed_by_id, performed_by,
                     property_id, result, detail, created_date, previous_hash
```

hashed as `sha256(chainSecret + ":" + JSON.stringify(canonical))`. The Base44 host permits
no module sharing between functions (every import must be `npm:`, `node:` or
`base44:runtime`), so this contract is duplicated across **6 writers + 1 verifier**:
`audit_log`, `custom_user_admin`, `custom_auth_login`, `custom_auth_reset_password`,
`autoPayroll` and `deleteAccount` (the last two added 2026-08-19), plus `audit_verify`.
All 7 carry an `AUDIT_CANONICAL_V1 = ...` marker comment, and
`scripts/probe-audit-chain.mjs` asserts the markers match AND that each file hashes exactly
the fields it declares. **Any field added, removed, renamed or re-ordered in one copy makes
the verifier misflag every healthy row as tampered.**

Rules that are easy to break by accident:

- Use `|| null`, never a bare `undefined`. `JSON.stringify` DROPS undefined keys, so an
  undefined hashes a different shape than the verifier rebuilds from a NULL column.
- `created_date` must be STRICTLY increasing -- the verifier orders the chain by it. Every
  writer calls a local `monotonicIso(lastIso)` that returns `last + 1ms` on a tie. A
  same-millisecond tie can otherwise be walked in the opposite order to the one the rows
  were linked in, and reported as a chain break that never happened.
- `result` must be `'failed'`, never `'failure'` -- the AuditLog page filters are
  `["all","success","failed"]`, so a `'failure'` row is present but unfindable.
- `username` / `property_name` / `ip_address` / `device` are written to the row but NOT signed.
- A missing `AUDIT_CHAIN_SECRET` makes writers **skip the row, never write an unsigned one.**
  `audit_verify` reports a hashless row as tampered, so emitting one would make the entire
  healthy trail read as forged -- strictly worse than a missing row.

### Role-Based Access Control (RBAC)
| Role | Can See | Can Do |
|------|---------|--------|
| `owner` | Everything across all properties | Everything including user management |
| `admin` | Everything across all properties | Manage users, settings, imports |
| `manager` | Assigned properties only | Import data, manage staff |
| `front_desk` | Assigned properties only | Import daily reports only |
| `accountant` | Financial data only | View-only financial reports |
| `read_only` | Limited dashboard only | View-only, no actions |

### Standalone Local Administration (Cloudflare deployment)

The deployed standalone build intentionally sets `VITE_USE_LOCAL_AUTH=true` and
`VITE_STANDALONE_LOCAL=true`. In that mode, `src/api/base44Client.js` implements
the user-administration contract locally because the retired Base44 functions are
not the runtime path. This is a **consistency and operator-safety control**, not a
network security boundary: Cloudflare Access must protect the Worker, and a person
with developer tools on an admitted device can alter browser-resident data.

Rules that must remain true in `handleLocalUserAdmin`:

- `list`, `search`, and `getById` require an authenticated `owner` or `admin`.
  A front-desk or other non-admin account must never receive the local roster.
- Create and update validate username, email, role, duplicate username/email, and
  password strength before writing IndexedDB. Roles are limited to the local role
  defaults plus the compatibility `user` role.
- There must always be one active owner. A different administrator cannot demote,
  disable, lock, or delete the final active owner; an actor also cannot disable or
  lock their own account through the administrative status action.
- Public user responses are an explicit allowlist. Never return password hashes,
  salts, MFA secrets, reset-token material, or session metadata from local user
  operations.
- An administrator reset/set-password action broadcasts `SESSION_REVOKED` for the
  target user. If the target is the actor, clear that local session too. A normal
  own-password change keeps the initiating tab alive but revokes the user's other
  tabs through `sessionChannel.js`.

The matching remote `custom_user_admin` function may expose only two actionable
authentication errors: a password-policy message beginning `Password must ` and
`Current password is incorrect.` All other client responses are the fixed strings
`Forbidden.` or `Request could not be completed.` Internal error text belongs only
in server logs.

Regression coverage: `src/api/authLocal.test.js`,
`scripts/test_bulletproof_auth.mjs`, `scripts/test_realtime_revocation.mjs`, and
`scripts/probe-auth-hardening.mjs`. If this contract changes, update these tests
and this section in the same change.

### Row-Level Security (RLS) -- The Second, Independent Boundary

RBAC above is enforced in the CLIENT (`src/lib/permissions.js`). RLS is enforced by the
**Base44 host** from the `rls` block in each `base44/entities/*.jsonc`. They are independent:
a correct RBAC table does not save you from a broken RLS rule, and **no local test suite can
observe host enforcement.** The canonical rule and its two silent failure modes are
documented in BRAIN_BACKEND.md section 7 -- read that before editing any entity.

The rule to hold onto: SECURITY.md section 3 requires that a clerk scoped to property A
cannot read property B. Flipping the OUTER `$and` to `$or` lets any active user read every
property, and looks completely normal in the UI. `scripts/probe-db-mock-rls.mjs` executes
that exact negative case on every shipped rule.

### Content Security Policy (CSP)
The same policy is written in THREE places, and only one of them is live:

| File | Read by | Live? |
|---|---|---|
| `public/_headers` | Cloudflare (Vite copies public/ into dist/, which wrangler uploads) | YES - this is the deployed site |
| `vercel.json` | Vercel only. Cloudflare never reads it | No |
| `base44/config.jsonc` | the base44 platform | No - base44 is no longer used |

Before `public/_headers` existed the Cloudflare deployment shipped with NO security
headers at all - no CSP, no HSTS, no X-Frame-Options - because the only copies of the
policy were in files that host does not read. `scripts/probe-deploy-config.mjs`
section 11 parses `public/_headers` and `vercel.json` and asserts every key and value
is byte-identical, so the two cannot drift; it also asserts `.gitattributes` pins
`public/_headers` to `text eol=lf`, because Cloudflare parses that file line-by-line
and a CRLF checkout on Windows would capture a CR inside every header value.

`script-src` has no `'unsafe-inline'`, so the build must emit no inline <script>.
`@base44/vite-plugin` used to inject one (its `analyticsTracker` option is the only
injection with `mode:"production"`), which every page load then violated once a host
finally served the header. It is `analyticsTracker: false` in vite.config.js and
probe-deploy-config.mjs section 12 asserts the flag and the directive together.

Policy contents:
- script-src: self only
- style-src: self + Google Fonts
- connect-src: self + Base44 backend + WebSocket
- frame-ancestors: none (no iframe embedding)
- Subresource Integrity (SRI) hashes via sriPlugin.js

### Subresource Integrity (SRI)
`sriPlugin.js` stamps a `sha384-` digest onto every `<script>`/`<link>` in the built
`index.html` that points under `/assets/`. CSP and SRI are a pair: the policy says which
origins may serve code, the digest says the bytes arrived unaltered.

A WRONG digest is strictly worse than no digest. The browser does not degrade the page, it
refuses to execute the file. On 2026-08-23 the deployed site rendered a blank dark page and
Chrome said only:

    Failed to find a valid digest in the 'integrity' attribute for resource
    '.../assets/index-Bbji4Ay-.js' ... The resource has been blocked.

The blocked file was the ENTRY chunk -- the module that mounts React -- so nothing rendered
at all. The stylesheet's digest was correct, which is why the page painted its background
and then stopped.

Root cause: the plugin hashed `ctx.bundle[file].code` from inside `transformIndexHtml`.
Vite invokes that hook from `vite:build-html`'s `generateBundle`, and
`vite:build-import-analysis`'s `generateBundle` runs AFTER it and does
`chunk.code = s.toString()`, substituting the real preload dependency array for the
`__VITE_PRELOAD__` marker (76 entries, ~3.4 kB in this app). The bytes were rewritten after
they had been hashed. Only chunks containing that marker are touched -- i.e. only chunks
with dynamic imports -- which is exactly why the entry chunk, the one that lazy-loads the
pages, was the single mismatch while five static vendor chunks and the CSS were fine.
`enforce: 'post'` does not help: it orders the hook among other HTML hooks, not against
another plugin's `generateBundle`.

The fix is entirely about which hook does the hashing:

| Hook | Runs | Does |
|---|---|---|
| `writeBundle` | after rollup has written every file | hashes the file ON DISK, rewrites index.html |
| `closeBundle` | after EVERY plugin's writeBundle | recomputes each digest, throws if one drifted |

Hashing in `writeBundle` means the bytes hashed are the bytes the browser fetches. The
`closeBundle` pass is what makes the build self-verifying: a mutation test in which a later
plugin appended bytes to the entry chunk failed the build with `[simple-sri] the shipped
digests do not match the shipped files`, instead of shipping another blank page. Every
unexpected condition throws (no output dir, no HTML emitted, referenced asset missing,
nothing injected) rather than skipping a tag, because a silent skip ships an unprotected
subresource and a silent stale hash ships an outage.

This failure shape is invisible to every other gate: `vite dev` serves unhashed modules,
lint and typecheck never read build output, and the build exits 0 while the deploy
succeeds. `scripts/probe-sri-integrity.mjs` is the only thing that catches it. It asserts
the plugin still hashes from disk and does NOT use `transformIndexHtml` or `chunk.code`,
that the `__VITE_PRELOAD__` rewrite still exists in the installed vite (so nobody
"simplifies" the plugin back into the html hook), and -- when `dist/` is present --
recomputes every declared digest against the file on disk.

---

# 15. PROTECTED FILES (DO NOT TOUCH)

These files are **permanently locked** from AI modification without explicit owner authorization.
Full details: PROTECTED_FILES.md

| # | File | Why Protected |
|---|------|--------------|
| 1 | `src/api/base44Client.js` | Core SDK: auth, entities, data access, rate limiting |
| 2 | `src/lib/AuthContext.jsx` | Auth provider, session management, cross-tab revocation |
| 3 | `src/lib/security.js` | Password hashing (PBKDF2/scrypt), TOTP/MFA, WebCrypto |
| 4 | `src/lib/securityUtils.js` | CSRF tokens, rate limiting, audit entries, sanitization |
| 5 | `src/lib/permissions.js` | Role-based access control, route permission mappings |
| 6 | `src/lib/validator.js` | Email/input validation rules |
| 7 | `src/pages/Login.jsx` | Login page with MFA flow |
| 8 | `src/pages/Setup.jsx` | Owner account creation (first-run) |
| 9 | `src/pages/ForgotPassword.jsx` | Password reset request flow |
| 10 | `src/pages/ResetPassword.jsx` | Password reset execution |
| 11 | `AGENTS.md` | AI agent rules (Gemini/Antigravity) |
| 12 | `CLAUDE.md` | AI agent rules (Claude/OpenCode) |
| 13 | `PROTECTED_FILES.md` | This protection list itself |
| 14 | `.agents/rules/no-modify-protected.md` | Protection enforcement rule |

**The rules that matter (full text in PROTECTED_FILES.md):** only the repository owner
(Divyesh) can grant a one-time exception, and the AI must ask and receive explicit
confirmation BEFORE touching any protected file. An agent instructed to modify one must
refuse and cite that document. Workarounds are equally forbidden -- no `v2` copy, no
wrapper, no runtime monkey-patch that overrides protected logic.

> [!NOTE]
> **2026-08-19, logged for the record:** `AGENTS.md` (#11) was edited under an explicit
> one-time owner authorization, to delete the injected `const db = globalThis.__B44_DB__`
> statement sitting above its own heading (the origin of known problem #11). The change was
> a pure 2-line deletion with zero insertions. This was an authorized exception, NOT a
> precedent -- the file remains protected.

---
