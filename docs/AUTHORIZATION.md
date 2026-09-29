# Authorization & Multi-Tenant Security Architecture

This document specifies the authoritative security contracts for identity, role-based access control (RBAC), and property isolation across all Base44 serverless backend functions and application services.

---

## 1. The Three-Tier Security Model

Every incoming request to a backend endpoint is subject to three sequential authorization gates:

```
Request
  │
  ▼
[ Tier 1: Identity & Session Gate ]
  ├── Resolves session token from `base44_session` cookie
  ├── Computes SHA-256 digest (`token_hash`)
  ├── Verifies session exists, `!session.is_revoked`, and `expires_at > now`
  └── Verifies caller account exists, `user.is_active === true`, and `!user.is_locked`
  │
  ▼
[ Tier 2: Permission & Role Gate ]
  ├── Owner and Admin roles hold wildcard privileges (`isRootUser = true`)
  ├── Non-root roles resolve permissions via custom `user.permissions` overrides
  └── Fallback to canonical `ROLE_DEFAULT_PERMISSIONS` (e.g. manager, front_desk, accountant, read_only)
  │
  ▼
[ Tier 3: Property Isolation Gate (Fail-Closed) ]
  ├── Root users (owner/admin) or explicit `property_access === 'all'` are unrestricted (`null`)
  ├── Valid array grants (`string[]`) restrict access strictly to listed property IDs
  └── Missing, null, empty array, or malformed values receive ZERO grants (`[]`) -> FAIL CLOSED
```

---

## 2. Core Invariants (Non-Negotiable)

### 2.1 The Fail-Closed Property Access Rule
**A missing, undefined, null, or non-array `property_access` value on a non-root account MUST NEVER result in unrestricted access.**
- **Vulnerability (Anti-Pattern):**
  ```ts
  // DANGEROUS: Any non-array value (undefined, null, string, object) becomes null (unrestricted)!
  const allowed = user.property_access === 'all' || !Array.isArray(user.property_access)
    ? null
    : user.property_access.map(String);
  ```
- **Authoritative Standard:**
  ```ts
  // SECURE: Fail closed into empty list unless explicitly root or 'all'
  const isUnrestricted =
    user.role === 'owner' ||
    user.role === 'admin' ||
    user.property_access === 'all';

  const allowedPropertyIds = isUnrestricted
    ? null
    : Array.isArray(user.property_access)
      ? user.property_access.map(String)
      : [];
  ```

### 2.2 CSRF Protection on Mutating Endpoints
All state-mutating endpoints (e.g. uploads, deletes, backups, password updates, logouts) must require a double-submit CSRF cookie token:
- Cookie: `__Host-csrf_token` (Strict, Secure, HttpOnly=false)
- Header: `x-csrf-token`
- Header value must strictly match the cookie value (`===`). Read-only query endpoints are exempt.

### 2.3 Row-Level & In-Memory Scoping
When endpoints receive pre-aggregated or client-provided rows (such as in `aiAssistant`), the allowed property scope must be enforced directly on the data rows themselves via server-side filters (e.g., `scopeSyntheticRows`), preventing cross-tenant data leakage even if a user manipulates request payload parameters.

---

## 3. Centralized Authorization Utilities

Shared serverless authorization helpers reside in `base44/utils/auth.js`:

| Helper | Purpose |
|---|---|
| `isRootUser(user)` | Determines if user has root bypass privileges (`owner` or `admin`). |
| `resolvePropertyScope(user)` | Resolves allowed property ID strings, or `null` if unrestricted, failing closed to `[]`. |
| `isPropertyAuthorized(user, id)` | Boolean check verifying whether user can access a specific `propertyId`. |
| `hasPermission(user, key)` | Resolves custom user permission or role default. |
| `validateCsrf(req)` | Validates `x-csrf-token` against `__Host-csrf_token`. |

---

## 4. Automated Verification & Defense-in-Depth

The authorization architecture is continuously enforced by:
1. **`scripts/probe-auth-uniformity.mjs`**: Static analysis probe scanning all 19 serverless functions for fail-open anti-patterns, incomplete session checks, and missing CSRF defenses.
2. **`scripts/probe-auth-hardening.mjs`**: In-depth behavioral probe exercising authentication edge cases, MFA rotation, credential hardening, and session eviction.
3. **`tests/backend/` suites**:
   - `authUtils.test.js`: Pure logic contract tests for authorization utilities.
   - `importDriveFile.test.js`: IDOR mitigation and fail-closed property scoping.
   - `listDriveFiles.test.js`: Permission and property-grant verification for Drive listing.
