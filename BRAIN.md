# RED ROOF INTELLIGENCE - THE PROJECT BRAIN

> **What is this file?** This is the SINGLE SOURCE OF TRUTH for the entire project.
> Any AI model should read THIS FILE FIRST before doing any work.
> It tells you what every file does, what depends on what, and what breaks if you touch something.
>
> **Last updated:** 2026-08-18
> **Total files in project:** ~312 source files (src/ + base44/ + scripts/)
> **Core rules:** Never guess, only prove. Always fix from the core.

---

# TABLE OF CONTENTS

| # | Section | What It Covers |
|---|---------|---------------|
| 1 | [The Project In 60 Seconds](#1-the-project-in-60-seconds) | What this app does, who uses it |
| 2 | [How Everything Connects](#2-how-everything-connects) | The big picture - data flow diagram |
| 3 | [Directory Map](#3-directory-map-where-everything-lives) | Every folder and what is inside |
| 4 | [All 36 Pages](#4-all-36-pages-what-users-see) | Every screen in the app |
| 5 | [All 90+ Libraries](#5-all-90-libraries-the-engines-under-the-hood) | Every calculation, parser, engine |
| 6 | [All 40+ Components](#6-all-40-components-reusable-ui-pieces) | Every reusable UI piece |
| 7 | [All 16 Database Tables](#7-all-16-database-tables-entities) | Every entity - what data is stored |
| 8 | [All 19 Backend Functions](#8-all-19-backend-functions-the-server-brain) | Every serverless function |
| 9 | [All Config Files](#9-all-config-files) | Build, deploy, environment, security |
| 10 | [All Test Scripts](#10-all-test-scripts-106-files) | Every test and probe script |
| 11 | [The Dependency Map](#11-the-dependency-map-what-breaks-if-you-touch-it) | Edit X then Y breaks |
| 12 | [The Money Math](#12-the-money-math-formulas) | Every financial formula |
| 13 | [Security Architecture](#13-security-architecture) | Auth, sessions, CSRF, MFA, rate limiting |
| 14 | [The 9 Known Problems](#14-the-9-known-problems-status-tracker) | Bug tracker with status |
| 15 | [Protected Files](#15-protected-files-do-not-touch) | Files AI must never edit |
| 16 | [How To Run, Test, Deploy](#16-how-to-run-test-deploy) | Step-by-step commands |
| 17 | [AI Rules](#17-ai-rules-for-any-model) | Rules every AI must follow |
| 18 | [Glossary](#18-glossary) | Every term explained simply |\n| 19 | [Emergency Playbook](#19-emergency-playbook-for-humans) | What to do when things break |

---

# 1. THE PROJECT IN 60 SECONDS

**Red Roof Intelligence** is a dashboard for hotel owners.

Imagine you own **25 hotels**. Every day, hundreds of guests check in, pay, and leave.
You need answers:
- How much money came in today?
- How many rooms were filled?
- How much profit did I keep after commissions and fees?
- Which booking channel (Expedia, Booking.com, direct) makes the most money?

This app gives you ALL those answers on one screen - instantly.

> [!WARNING]
> **The Golden Rule of this App:** These three paths must always match within .01.

`mermaid
sequenceDiagram
    actor User
    participant UI as Frontend
    participant API as Base44 Login Auth
    participant DB as Entity / Audit
    
    User->>UI: Enter Email & Password
    UI->>API: POST /login
    API->>API: Rate Limiter (Max 5/15m)
    API->>DB: Verify scrypt hash
    API->>User: Request TOTP Code
    User->>API: Submit 6-digit code
    API->>API: Check Replay (mfa_last_counter)
    API->>DB: Save Session (SHA-256 Token)
    API->>DB: Write Audit Log (HMAC Chain)
    API->>UI: Set HTTP-Only Secure Cookie
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

# 14. THE 9 KNOWN PROBLEMS (Status Tracker)

| # | Problem | Severity | Status | Fix Location | Commit |
|---|---------|----------|--------|-------------|--------|
| 1 | Duplicate CSV column names cause data loss | HIGH | FIXED | `src/lib/csvParser.js` line 183 | c50435c |
| 2 | Password sent in plaintext in welcome email | CRITICAL | FIXED | `base44/functions/custom_auth_register/entry.js` lines 209-217 | f07245e |
| 3 | Money Kept shows $0 (typo: total_revenue should be room_revenue) | HIGH | FIXED | `src/lib/dailyAggregates.js` line 183 | See docs |
| 4 | CSRF cookie not secure (missing __Host- prefix + Secure flag) | CRITICAL | FIXED | `src/lib/securityUtils.js` line 267-268 | efc79d9 |
| 5 | Revenue paths don't match (no reconciliation system) | HIGH | FIXED | `src/lib/RevenueReconciliation.js` (NEW file) | See docs |
| 6 | Float math precision errors ($0.1+$0.2 != $0.3) | HIGH | PENDING | `src/lib/decimal.js` exists but not fully integrated everywhere | - |
| 7 | Wrong error message for disabled accounts ("revoked" vs "disabled") | MEDIUM | PENDING | `src/lib/AuthContext.jsx` + `custom_auth_me` | - |
| 8 | Session never times out (infinite session = security risk) | CRITICAL | PENDING | `src/api/base44Client.js` + `AuthContext.jsx` | - |
| 9 | Server-only code sits in frontend folder (config leak) | MEDIUM | PENDING | `base44/lib/corsConfig.js` + `securityHeaders.js` (already in backend) | - |

---

# 15. PROTECTED FILES (DO NOT TOUCH)

> [!IMPORTANT]\n> These files are **permanently locked** from AI modification without explicit owner authorization.
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

# 16. HOW TO RUN, TEST, DEPLOY

### Start the App
```powershell
# Install dependencies (first time only)
npm install

# Start frontend + backend together (recommended for full development)
base44 dev

# Start frontend only (uses hosted Base44 backend)
npm run dev

# Open in browser
# http://localhost:5173
```

### Run Tests
```powershell
# Run unit tests (Vitest, JSDOM)
npm test

# Run a specific probe test
node --import ./scripts/_loader-boot.mjs scripts/probe-money-kept-fix.mjs

# Run ALL probe tests (acceptance suite)
node --import ./scripts/_loader-boot.mjs scripts/acceptance-harness.mjs

# Lint the code
npm run lint

# Fix lint issues automatically
npm run lint:fix
```

### Build for Production
```powershell
# Build production bundle (outputs to dist/)
npm run build

# Deploy via Vercel (automatic on git push to main, or manual CLI)
```

### Key Environment Variables / Secrets
| Variable | Where It Lives | Required? | What It Does |
|----------|---------------|-----------|-------------|
| `AUDIT_CHAIN_SECRET` | Base44 Secrets | YES | Audit log HMAC key -- log will not work without it |
| `OPENWEATHER_API_KEY` | Base44 Secrets | For weather | Weather widget API key |
| `VITE_USE_LOCAL_AUTH` | `.env.*` files | Already set | Controls auth mode -- DO NOT set true in production |
| `ALLOWED_ORIGINS` | Server env | For CORS | Comma-separated allowed origins |
| `WEBHOOK_SECRET` | Server env | For webhooks | HMAC signature verification key |

---

# 17. AI RULES (For Any Model)

### The 4 Golden Rules

1. **NEVER GUESS, ONLY PROVE.**
   - Scan the codebase before making changes.
   - Write a test that fails to prove the problem exists.
   - Run the test after fixing to prove it works.

2. **ALWAYS FIX FROM THE CORE.**
   - Find the root cause. Do not apply band-aids.
   - If the core is complex, simplify it.

3. **EXPLAIN LIKE I AM 10 YEARS OLD.**
   - All documentation must be readable by a 10-year-old.
   - Use plain language. No unnecessary jargon.

4. **FULL PERMISSION GRANTED.**
   - You may edit, delete, create, or refactor anything.
   - EXCEPTION: Files in PROTECTED_FILES.md need owner permission first.

### The 5-Step Workflow (Interactive Checklist)
- [ ] **1. SCAN:** Read this BRAIN.md + relevant source files
- [ ] **2. PROVE:** Write a test that shows the problem
- [ ] **3. FIX:** Fix the root cause
- [ ] **4. VERIFY:** Run the test to prove it is fixed
- [ ] **5. UPDATE:** Update BRAIN.md to reflect what changed``

### After Every Fix: UPDATE BRAIN.md!
When you fix a bug, add a feature, or change anything significant:
- Update the relevant section in this file
- Change the status in the problem tracker (Section 14)
- Add any new files to the directory map (Section 3) and library list (Section 5)
- Update the dependency map if connections changed (Section 11)
- This keeps the NEXT AI from wasting tokens re-scanning everything

---

# 18. GLOSSARY

### Hotel Terms
| Term | Meaning | Example |
|------|---------|---------|
| ADR | Average Daily Rate: avg price per room sold | $81.80 |
| RevPAR | Revenue Per Available Room | $47.26 |
| Occupancy % | How full the hotel is | 57.8% |
| OTA | Online Travel Agency | Expedia, Booking.com |
| PMS | Property Management System | HotelKey |
| Comp Room | Free room (complimentary) | Loyalty guest |
| No-Show | Guest booked but did not arrive | Charged anyway |
| Direct Bill | Invoice sent to company | Corporate account |
| Folio | Guest bill/invoice | All charges for one stay |
| CPOR | Cost Per Occupied Room | Total costs / rooms sold |
| GOPPAR | Gross Operating Profit Per Available Room | GOP / total rooms |
| Flow-Through | % of incremental revenue that becomes profit | Higher = more efficient |

### Tech Terms
| Term | Meaning |
|------|---------|
| API | Way for programs to talk to each other |
| Backend | Server code (hidden, does calculations) |
| Frontend | Website UI (what you see in browser) |
| CSV | Simple table file (like Excel but plain text) |
| CSRF | Cross-Site Request Forgery (hacker trick) |
| Entity | A database table in Base44 |
| Hash | One-way encryption (cannot be reversed) |
| MFA / TOTP | Multi-Factor Auth: 6-digit code from phone |
| RBAC | Role-Based Access Control: who can do what |
| RLS | Row-Level Security: data isolated per user/property |
| scrypt | Strong password hashing algorithm |
| PBKDF2 | Older password hashing (300k iterations, auto-upgrading to scrypt) |
| Session | Server-side record of a logged-in user |
| SRI | Subresource Integrity: browser verifies file not tampered |
| WebSocket | Real-time two-way connection |
| CRDT / Yjs | Technology for real-time collaborative editing |
| Dexie | IndexedDB wrapper library for local browser storage |
| BroadcastChannel | Browser API for cross-tab communication |
| SSRF | Server-Side Request Forgery (attacker tricks server into making requests) |
| IDOR | Insecure Direct Object Reference (accessing another user's data by guessing ID) |
| CSWSH | Cross-Site WebSocket Hijacking |

### Acronyms
| Short | Full |
|-------|------|
| BI | Business Intelligence |
| CSP | Content Security Policy |
| GDPR | General Data Protection Regulation |
| HSTS | HTTP Strict Transport Security |
| OWASP | Open Web Application Security Project |
| PCI DSS | Payment Card Industry Data Security Standard |

---

> REMEMBER: This file IS the project brain. When in doubt, search here first.
> After making changes, UPDATE this file so the next AI does not have to scan 45,000 files.
>
> Core Rules: Never guess, only prove. Always fix from the core. Keep it simple.


---

# 🚨 19. EMERGENCY PLAYBOOK (For Humans)

> [!TIP]
> **Hotel Owners & Managers:** If something goes wrong in real life, follow this guide before calling a developer.

### Scenario A: "The Dashboard Revenue Doesn't Match My Bank Account"
1. **Check the CSVs:** Did the front desk upload yesterday's HotelKey report? Go to Import and check the history.
2. **Check the "Drift":** Look at the **Money Kept** widget. If Path 1, 2, and 3 don't match, an employee might have manually altered a folio after the night audit.
3. **Look for Cash Variances:** Go to Employees -> Clerk Audit Matrix. Did a clerk have a large cash drop variance? 

### Scenario B: "An Employee is Locked Out"
1. **DO NOT delete their account.**
2. Go to Users (you must be an Owner/Admin).
3. Find their name and check if the **Lockout Flag** is triggered (happens automatically after 5 bad passwords).
4. Click "Unlock" or "Send Password Reset".
5. If they lost their MFA phone, click "Reset MFA" (this requires your step-up password).

### Scenario C: "The App is Super Slow or Freezing"
1. You likely have too many raw CSV previews stuck in your local browser cache.
2. The uploadRetention.js script usually clears this, but you can force it.
3. Press Ctrl + Shift + R (Hard Refresh) to clear the IndexedDB cache and pull fresh data from the Base44 Cloud.

### Scenario D: "I Accidentally Imported the Wrong Date's Data"
1. Go to the Import page.
2. Find the bad import in the "Recent Imports" list.
3. Click the **Undo/Rollback** button. (The system treats imports as atomic ledgers, so clicking undo instantly wipes the data safely across all 5 tables without leaving ghost records).
