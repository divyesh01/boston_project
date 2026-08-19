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

### Role-Based Access Control (RBAC)
| Role | Can See | Can Do |
|------|---------|--------|
| `owner` | Everything across all properties | Everything including user management |
| `admin` | Everything across all properties | Manage users, settings, imports |
| `manager` | Assigned properties only | Import data, manage staff |
| `front_desk` | Assigned properties only | Import daily reports only |
| `accountant` | Financial data only | View-only financial reports |
| `read_only` | Limited dashboard only | View-only, no actions |

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

---