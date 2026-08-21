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
Defined in both `base44/config.jsonc` and `vercel.json`:
- script-src: self only
- style-src: self + Google Fonts
- connect-src: self + Base44 backend + WebSocket
- frame-ancestors: none (no iframe embedding)
- Subresource Integrity (SRI) hashes via sriPlugin.js

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