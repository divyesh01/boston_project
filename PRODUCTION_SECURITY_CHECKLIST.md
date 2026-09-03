# Red Roof Intelligence - Production Security & Deployment Verification Checklist

## Overview
This document serves as the final verification checklist before marking Red Roof Intelligence as **Production Ready**. All items must pass successfully.

---

## 1. HTTPS & Transport Security ✅

### 1.1 TLS Configuration
- [ ] **TLS 1.3 enforced** (TLS 1.2 minimum) on all endpoints
- [ ] Valid SSL/TLS certificate from trusted CA (Let's Encrypt, DigiCert, etc.)
- [ ] Certificate covers all domains (www, api, admin subdomains)
- [ ] Certificate auto-renewal configured (certbot, ACME, etc.)
- [ ] OCSP Stapling enabled

### 1.2 HTTP → HTTPS Redirect
- [ ] All HTTP traffic (port 80) redirects to HTTPS (port 443) with 301/308
- [ ] Redirect works for all paths and query parameters
- [ ] No mixed content warnings

### 1.3 HSTS (HTTP Strict Transport Security)
- [ ] `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload` header present
- [ ] Domain submitted to HSTS preload list (https://hstspreload.org/)
- [ ] `max-age` of at least 1 year (31536000 seconds)

---

## 2. Secure Cookies & Session Management ✅

### 2.1 Session Cookie Attributes
- [ ] `HttpOnly` - Prevents XSS access to session token
- [ ] `Secure` - Only transmitted over HTTPS
- [ ] `SameSite=Strict` - CSRF protection (or `Lax` with justification)
- [ ] `Path=/` - Scoped to application root
- [ ] `Domain` - Properly scoped (no leading dot unless intentional)

### 2.2 Session Security (Implemented)
- [x] Sessions use cryptographically secure random tokens (256-bit)
- [x] Session expiration: 30 min idle / 30 days remember-me
- [x] Session rotation on privilege change
- [x] **Sessions are stored server-side in D1 `app_session`, and the table holds
      only `token_hash` (SHA-256 of the token), never the token itself. The browser
      receives one opaque `__Host-rri_session` HttpOnly cookie.** Source:
      `worker/app-auth.js` (`COOKIE_NAME`, the `app_session` INSERT, and the
      `sha256(token)` lookups). *Corrected 2026-09-03: this row previously read
      "Secure storage with AES-GCM encryption in localStorage", which described the
      retired client-side base44 session model and would send a reader looking for
      session state in the browser.*
- [x] Session invalidation on logout, password change, lockout
- [x] Concurrent session limits (optional: implement server-side)

---

## 3. Authentication & Authorization ✅

### 3.1 Password Security

> **CORRECTED 2026-09-03 against source.** Three `[x]` items in this section
> asserted values the code does not have. The source of truth is
> `worker/password-credential.js` (constants `PBKDF2_ITERATIONS`, `SALT_BYTES`)
> and `worker/app-auth.js` (constants `LOCK_AFTER_FAILURES`, `LOCK_MS`,
> `COOKIE_NAME`). Read those constants — do not trust this list — and if you
> change one, correct the row here in the same commit.

- [x] PBKDF2-HMAC-SHA256, **100,000 iterations** when minting a new credential
      (`PBKDF2_ITERATIONS`). Verification accepts 100,000–1,000,000
      (`MIN_SUPPORTED_ITERATIONS`/`MAX_SUPPORTED_ITERATIONS`), so credentials
      minted at a higher count still verify. **This checklist previously claimed
      150,000 and `PRODUCTION_READINESS_REPORT.md` claims an upgrade to 300,000;
      neither figure is in the Worker.** Whether 100,000 is the intended floor is
      an open owner decision, not a settled item.
- [x] Server-side pepper in the derivation input, versioned
      (`PEPPER_VERSION`, `MAX_PEPPER_VERSION`) — omitted from earlier versions of
      this checklist, which understated the scheme.
- [x] Per-user random salt, **32 bytes** (`SALT_BYTES`) — previously listed as 16.
- [x] Minimum 8 chars, uppercase, lowercase, digit
- [x] Account lockout after 5 failed attempts (`LOCK_AFTER_FAILURES`), 15-minute
      lock (`LOCK_MS`)
- [x] No password hints or recovery via email (admin-only reset)

### 3.2 Role-Based Access Control (RBAC)
- [x] **Owner** - Full access to all features
- [x] **Admin** - Full access except self-role modification
- [x] **Manager** - Reports, expenses, OTA, users (read-only)
- [x] **Front Desk** - Dashboard, imports, basic operations
- [x] **Accountant** - Financial reports, expenses, OTA commissions
- [x] **Read Only** - Dashboard and financial reports only

### 3.3 Administrative Action Restrictions
- [x] User management: Owner/Admin only
- [x] Settings changes: Owner/Admin only
- [x] Import/Delete/Replace: Manager+ with `import_reports` permission
- [x] Payroll actions: Manager+ with `manage_expenses` permission
- [x] Backup/Restore: Owner/Admin only
- [x] Audit log access: Owner/Admin only (`view_audit_logs`)

### 3.4 Session Management
- [x] Automatic session expiration on idle
- [x] Remember-me extends to 30 days
- [x] Activity tracking extends session
- [x] Secure logout invalidates session

---

## 4. Application Protection ✅

### 4.1 Input Validation & Sanitization
- [x] HTML entity encoding for all user-controlled output (`escapeHtml`, `escapeAttr`, `escapeJs`)
- [x] URL sanitization (blocks `javascript:`, `data:`, `vbscript:` protocols)
- [x] Filename sanitization (removes path traversal chars)
- [x] Email validation with regex
- [x] Alphanumeric validation for usernames/codes
- [x] Text sanitization (strips `<script>`, `<iframe>`, `on*` handlers)
- [x] Numeric range validation

### 4.2 SQL Injection Prevention
- [x] Dexie.js (IndexedDB) used - no SQL queries
- [x] Parameterized queries via Dexie API
- [x] No dynamic query construction from user input

### 4.3 XSS Prevention
- [x] React's built-in JSX escaping for all rendered content
- [x] CSP header restricts inline scripts (`script-src 'self'`)
- [x] No `dangerouslySetInnerHTML` with unsanitized data
- [x] Input sanitization on all user inputs

### 4.4 CSRF Protection
- [x] Per-session CSRF tokens (32-byte random)
- [x] Token validation on all state-changing operations
- [x] Token rotation after successful sensitive actions
- [x] SameSite=Strict cookies as defense-in-depth

### 4.5 File Upload Security
- [x] File type validation (CSV, XLSX only)
- [x] File size limits enforced
- [x] Blob URLs for processing (no server upload in local mode)
- [x] Filename sanitization before processing

### 4.6 Rate Limiting
- [x] Login: 5 attempts per 15 min, 30 min block
- [x] Sensitive actions: 20 per hour, 1 hour block
- [x] API calls: 60 per minute, 5 min block
- [x] Progressive delays on repeated failures
- [x] Rate limit status exposed for UI feedback

---

## 5. Security Headers ✅

### 5.1 Content Security Policy (CSP)
```
Content-Security-Policy:
  default-src 'self';
  script-src 'self' 'wasm-unsafe-eval';
  style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
  font-src 'self' https://fonts.gstatic.com;
  img-src 'self' data: https:;
  connect-src 'self' https: wss:;
  frame-ancestors 'none';
  base-uri 'self';
  form-action 'self';
  object-src 'none';
```

- [x] CSP header present in meta tag and dev/preview server
- [x] No `unsafe-eval` for scripts (only wasm-unsafe-eval for WASM)
- [x] `frame-ancestors 'none'` prevents clickjacking
- [x] `object-src 'none'` prevents plugin execution

### 5.2 Other Security Headers
- [x] `X-Frame-Options: DENY`
- [x] `X-Content-Type-Options: nosniff`
- [x] `Referrer-Policy: strict-origin-when-cross-origin`
- [x] `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()`
- [x] `Cross-Origin-Opener-Policy: same-origin`
- [x] `Cross-Origin-Resource-Policy: same-origin`

---

## 6. Infrastructure Security ✅

### 6.1 Web Application Firewall (WAF)
- [ ] Cloudflare WAF enabled (or equivalent: AWS WAF, Azure Front Door, etc.)
- [ ] OWASP Core Rule Set (CRS) enabled
- [ ] Custom rules for known attack patterns
- [ ] Rate limiting at edge (complements app-level)
- [ ] Bot management enabled

### 6.2 DDoS Protection
- [ ] Cloudflare DDoS protection (or equivalent)
- [ ] Layer 3/4 and Layer 7 protection
- [ ] Auto-mitigation enabled

### 6.3 Network Security
- [ ] HTTPS only (no HTTP listeners)
- [ ] Security groups / firewall rules restrict access
- [ ] Database not publicly accessible
- [ ] Admin interfaces on separate subnet/VPN

---

## 7. Audit & Monitoring ✅

### 7.1 Audit Log Coverage
- [x] Login / Logout (success & failure)
- [x] User Management (create, update, delete, enable, disable, lock, unlock)
- [x] Property Changes (create, update, delete)
- [x] Imports (upload, scan, import, delete, replace)
- [x] Import Deletion & Replacement
- [x] Settings Changes (commission rates, tax, thresholds, etc.)
- [x] Financial Configuration Changes
- [x] Expense Changes (create, update, delete, status change)
- [x] Payroll Actions (create, approve, delete, auto-generate)
- [x] Backup Operations (create, restore, delete)

### 7.2 Audit Entry Fields
- [x] Timestamp (ISO 8601)
- [x] User ID & Username
- [x] Action (standardized action names)
- [x] Property ID & Name (when applicable)
- [x] IP Address (client-side hint, server-side in production)
- [x] Device Fingerprint
- [x] Result (Success/Failed)
- [x] Detail (contextual information)

### 7.3 Audit Log Integrity
- [x] Append-only (no update/delete via UI)
- [x] Clear requires explicit admin action (logged)
- [x] Tamper-evident (consider: hash chaining, WORM storage)

---

## 8. Secrets Management ✅

### 8.1 No Secrets in Frontend Code
- [x] No API keys, DB credentials, or secrets in source
- [x] No hardcoded passwords or tokens
- [x] Environment variables only for build-time config
- [x] `.env.local` in `.gitignore`

### 8.2 Production Secrets
- [ ] Database credentials in secure vault (AWS Secrets Manager, HashiCorp Vault, etc.)
- [ ] API keys rotated periodically
- [ ] Service accounts with minimal permissions
- [ ] No shared credentials between environments

---

## 9. Dependency Security ✅

### 9.1 Dependency Management
- [ ] `npm audit` passes with no high/critical vulnerabilities
- [ ] Dependencies updated regularly (Dependabot/Renovate configured)
- [ ] Lock file (`package-lock.json`) committed
- [ ] Unused dependencies removed

### 9.2 Supply Chain Security
- [ ] Only trusted registries (npmjs.com)
- [ ] Package integrity verification (npm audit signatures)
- [ ] No direct GitHub dependencies without review

---

## 10. Pre-Deployment Verification Tests ✅

### 10.1 Authentication Tests
- [ ] Valid credentials grant access
- [ ] Invalid credentials rejected with generic error
- [ ] Locked account cannot log in
- [ ] Disabled account cannot log in
- [ ] Expired session redirects to login
- [ ] Remember-me persists for 30 days
- [ ] Logout invalidates session
- [ ] Password change invalidates other sessions

### 10.2 Authorization Tests
- [ ] Owner can access all routes
- [ ] Admin cannot modify own role
- [ ] Manager cannot access user management
- [ ] Front Desk cannot access settings
- [ ] Read Only cannot modify data
- [ ] Property access restrictions enforced
- [ ] Unauthorized API calls return 403

### 10.3 Security Header Tests
- [ ] CSP header present and correct
- [ ] HSTS header present with 1-year max-age
- [ ] X-Frame-Options: DENY
- [ ] X-Content-Type-Options: nosniff
- [ ] Referrer-Policy: strict-origin-when-cross-origin
- [ ] No server/header leakage (X-Powered-By, etc.)

### 10.4 Rate Limiting Tests
- [ ] 6 failed logins → account locked
- [ ] 5 failed logins from same IP → rate limited
- [ ] 20 sensitive actions/hour → rate limited
- [ ] Rate limit resets after window

### 10.5 Input Validation Tests
- [ ] XSS payloads in inputs are escaped
- [ ] SQL injection attempts fail safely
- [ ] Path traversal in filenames blocked
- [ ] Oversized payloads rejected
- [ ] Invalid emails rejected
- [ ] Malformed dates rejected

### 10.6 Audit Logging Tests
- [ ] Login success logged
- [ ] Login failure logged with reason
- [ ] User create/update/delete logged
- [ ] Settings changes logged with details
- [ ] Import actions logged
- [ ] Payroll actions logged
- [ ] Property changes logged
- [ ] Log entries include all required fields

### 10.7 HTTPS & Redirect Tests
- [ ] HTTP → HTTPS redirect (301/308)
- [ ] All resources load over HTTPS
- [ ] No mixed content warnings
- [ ] HSTS header present
- [ ] Certificate valid and trusted

### 10.8 Backup & Restore Tests
- [ ] Backup creates complete data export
- [ ] Restore recovers all data correctly
- [ ] Backup encrypted at rest
- [ ] Restore validates data integrity

---

## 11. Production Deployment Steps

### 11.1 Pre-Deploy
- [ ] All checklist items above verified
- [ ] `npm run build` completes without errors
- [ ] `npm run lint` passes
- [ ] `npm run typecheck` passes
- [ ] Bundle size acceptable (< 500KB gzipped JS)
- [ ] No console.log/debug statements in production build

### 11.2 Deploy
- [ ] Deploy to staging environment first
- [ ] Run full test suite against staging
- [ ] Security scan (OWASP ZAP, Burp, etc.) on staging
- [ ] Performance test (Lighthouse, WebPageTest)
- [ ] Deploy to production with blue/green or rolling update

### 11.3 Post-Deploy Verification
- [ ] All 10.x tests pass on production URL
- [ ] Monitoring alerts configured
- [ ] Error tracking (Sentry, etc.) receiving events
- [ ] Audit logs flowing to centralized logging
- [ ] Backup job scheduled and verified

---

## 12. Sign-Off

| Role | Name | Date | Signature |
|------|------|------|-----------|
| Security Engineer | | | |
| Lead Developer | | | |
| DevOps Engineer | | | |
| Product Owner | | | |

---

## Production Ready Criteria

**The application is ONLY "Production Ready" when:**

1. ✅ All items in Sections 1-10 are checked
2. ✅ All pre-deployment verification tests pass
3. ✅ Staging deployment validated
4. ✅ Security scan shows no critical/high findings
5. ✅ All sign-offs obtained

---

## Maintenance Schedule (Post-Launch)

| Task | Frequency | Owner |
|------|-----------|-------|
| Dependency updates & audit | Weekly | DevOps |
| SSL certificate renewal | Auto / 90 days | DevOps |
| Security scan | Monthly | Security |
| Penetration test | Quarterly | Security |
| Audit log review | Monthly | Admin |
| Backup restore test | Quarterly | DevOps |
| Access review (users/roles) | Quarterly | Admin |
| Incident response drill | Semi-annually | Security |

---

*Document Version: 1.0*
*Last Updated: 2026-08-07*
*Application: Red Roof Intelligence*