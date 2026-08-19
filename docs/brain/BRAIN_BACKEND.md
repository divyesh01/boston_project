# 7. ALL 16 DATABASE TABLES (Entities)

Every piece of data stored. Each table has Row-Level Security (RLS) = data isolated per property/user.

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

---

# 9. ALL CONFIG FILES

### Build & Deploy
| File | What It Does | If You Edit This... |
|------|-------------|-------------------|
| `package.json` | NPM deps (React 18, Base44 SDK, Recharts, Dexie, Tailwind, Radix, Framer Motion), scripts (dev, build, test, lint, ws) | Build fails, tests fail, everything |
| `vite.config.js` | Vite build: React plugin, Base44 plugin, SRI hash generator, dev security headers, console stripping, vendor chunk splitting | Production build fails |
| `vercel.json` | Vercel deploy: SPA routing (/* -> /index.html), 1-year immutable caching for /assets/*, production security headers | 404 on refresh, security headers lost |
| `sriPlugin.js` | Post-build: generates SHA-384 integrity hashes for all scripts/styles in index.html | Browsers block all scripts (SRI mismatch) |
| `eslint.config.js` | ESLint 9: React + Hooks rules, unused import removal | Linting breaks in CI |
| `vitest.config.js` | Test runner: JSDOM env, @/ path alias, setup hooks, coverage | Tests cannot run |
| `tailwind.config.js` | Design tokens: HSL color vars, chart colors 1-5, sidebar colors, fonts, accordion animations | ALL styling breaks |
| `components.json` | Shadcn UI: component paths, utility path, icon library | New UI components scaffolded wrong |
| `jsconfig.json` | IDE: @/* -> ./src/* path alias, strict JSX, type definitions | Autocomplete and type-checking break |
| `postcss.config.js` | PostCSS: loads Tailwind and autoprefixer | CSS processing fails |

### Environment Variables
| File | Key Setting | What It Controls | DANGER |
|------|------------|-----------------|--------|
| `.env.local` | `VITE_USE_LOCAL_AUTH=false` | Default: use real serverless auth | - |
| `.env.development` | `VITE_USE_LOCAL_AUTH=true` | Dev: use local IndexedDB auth shim | - |
| `.env.production` | `VITE_USE_LOCAL_AUTH=false` | Prod: MUST use real auth | Setting to true = SECURITY DISASTER |

### Base44 Config
| File | What It Does |
|------|-------------|
| `base44/config.jsonc` | Build commands + production security headers (CSP, HSTS preload, X-Frame DENY, nosniff) |
| `base44/.app.jsonc` | Links to cloud app ID: `6a7d6856ee1cc714b1803c0e` |
| `base44/auth/config.jsonc` | Auth methods enabled: password + Google OAuth (MS/FB/Apple/SAML disabled) |
| `base44/connectors/googledrive.jsonc` | Google Drive OAuth scopes (drive + email) |

---

# 10. ALL TEST SCRIPTS (106 Files)

### Test Infrastructure
| File | What It Does |
|------|-------------|
| `scripts/_loader-boot.mjs` | Node bootstrap: @/ alias resolution, browser global shims (document, location), Web Worker shim |
| `scripts/_harness-auth.mjs` | Creates in-memory Owner account for fail-closed auth in tests |
| `scripts/resolve-alias.mjs` | Custom ESM loader: @/ -> src/ |
| `scripts/resolve-base44.mjs` | Custom ESM loader: redirects @base44/sdk to local stubs |
| `scripts/stubs/base44-runtime.mjs` | In-memory Base44 host mock (secret store, entity DB) |
| `scripts/stubs/base44-sdk.mjs` | In-memory SDK mock with -field sorting and monotonic sequences |
| `scripts/acceptance-harness.mjs` | Runs ALL probe tests in sequence |

### How To Run Tests
```powershell