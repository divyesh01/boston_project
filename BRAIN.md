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
| 20 | [Appendix: All 418 Files](#20-appendix-all-418-files) | Complete codebase index |

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

# ðŸš¨ 19. EMERGENCY PLAYBOOK (For Humans)

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

---

# ðŸ—ƒï¸ 20. APPENDIX: ALL 418 FILES

> [!NOTE]
> For complete reference, here is the exhaustive list of every single file in the project. Use this to verify existence before creating new files.

<details>
<summary><strong>Click to expand the full file catalog</strong></summary>

`	ext
base44\.app.jsonc
base44\.types\types.d.ts
base44\auth\config.jsonc
base44\config.jsonc
base44\connectors\googledrive.jsonc
base44\entities\AuditLog.jsonc
base44\entities\Channel.jsonc
base44\entities\ClerkShiftRecord.jsonc
base44\entities\Expense.jsonc
base44\entities\GrossRevenueDay.jsonc
base44\entities\OccupancyDay.jsonc
base44\entities\PaymentDay.jsonc
base44\entities\PayrollRun.jsonc
base44\entities\Property.jsonc
base44\entities\RateLimit.jsonc
base44\entities\Session.jsonc
base44\entities\SourceDay.jsonc
base44\entities\Staff.jsonc
base44\entities\TimecardPunch.jsonc
base44\entities\UploadedReport.jsonc
base44\entities\User.jsonc
base44\functions\aiAssistant\entry.ts
base44\functions\audit_clear\entry.js
base44\functions\audit_list\entry.js
base44\functions\audit_log\entry.js
base44\functions\audit_verify\entry.js
base44\functions\autoPayroll\entry.ts
base44\functions\autoPayroll\function.jsonc
base44\functions\backupToDrive\entry.ts
base44\functions\custom_auth_check\entry.js
base44\functions\custom_auth_login\entry.js
base44\functions\custom_auth_logout\entry.js
base44\functions\custom_auth_me\entry.js
base44\functions\custom_auth_register\entry.js
base44\functions\custom_auth_reset_password\entry.js
base44\functions\custom_auth_reset_request\entry.js
base44\functions\custom_user_admin\entry.js
base44\functions\deleteAccount\entry.ts
base44\functions\getWeather\entry.ts
base44\functions\importDriveFile\entry.ts
base44\functions\listDriveFiles\entry.ts
base44\lib\corsConfig.js
base44\lib\securityHeaders.js
scripts\_harness-auth.mjs
scripts\_loader-boot.mjs
scripts\acceptance-harness.mjs
scripts\acceptance-report.json
scripts\benchmark_performance.mjs
scripts\data\Adjustments and Refunds Activity (1).csv
scripts\data\Adjustments and Refunds Activity (2).csv
scripts\data\Adjustments and Refunds Activity.csv
scripts\data\All Transactions (1).csv
scripts\data\All Transactions (2).csv
scripts\data\All Transactions.csv
scripts\data\Clerk Shift.csv
scripts\data\Gross Revenue Report midelboro.csv
scripts\data\Hotel Statistics (1).csv
scripts\data\Hotel Statistics.csv
scripts\data\Occupancy Summary midelboro.csv
scripts\data\Payments Summary (1).csv
scripts\data\Payments Summary (2).csv
scripts\data\Payments Summary.csv
scripts\data\Source Summary (1).csv
scripts\data\Source Summary (2).csv
scripts\data\Source Summary (3).csv
scripts\data\Source Summary.csv
scripts\data\timecard-sample.csv
scripts\probe-active-vs-idle.mjs
scripts\probe-adjustments.mjs
scripts\probe-audit-chain.mjs
scripts\probe-audit-filter.mjs
scripts\probe-audit-list.mjs
scripts\probe-auth-audit.mjs
scripts\probe-auth-hardening.mjs
scripts\probe-clerk-fraud-filter.mjs
scripts\probe-config-exposure.mjs
scripts\probe-csrf-host-prefix.mjs
scripts\probe-csrf-secure-flag.mjs
scripts\probe-csv-data-loss.mjs
scripts\probe-csvParser-data-loss.mjs
scripts\probe-date-validation.mjs
scripts\probe-delete-guard.mjs
scripts\probe-deploy-config.mjs
scripts\probe-financial-invariant.mjs
scripts\probe-hotel.mjs
scripts\probe-housekeeping.mjs
scripts\probe-idle-polling.mjs
scripts\probe-import.mjs
scripts\probe-import-rollback-id.mjs
scripts\probe-import-txn-zone.mjs
scripts\probe-import-validation.mjs
scripts\probe-manual-entry-import.mjs
scripts\probe-money-kept.mjs
scripts\probe-money-kept-fix.mjs
scripts\probe-money-kept-float.mjs
scripts\probe-ota-sync.mjs
scripts\probe-parse-amount.mjs
scripts\probe-pricing.mjs
scripts\probe-profit-leakage.mjs
scripts\probe-property-isolation.mjs
scripts\probe-realtime.mjs
scripts\probe-red.mjs
scripts\probe-red6.mjs
scripts\probe-red8.mjs
scripts\probe-revenue-reconciliation.mjs
scripts\probe-reviews.mjs
scripts\probe-roomboard.mjs
scripts\probe-session-expiry.mjs
scripts\probe-session-noop.mjs
scripts\probe-session-slide.mjs
scripts\probe-session-sliding.mjs
scripts\probe-startup.mjs
scripts\probe-ui-disabled-reason.mjs
scripts\probe-ui-feedback.mjs
scripts\probe-validation-gaps.mjs
scripts\probe-weather.mjs
scripts\probe-welcome-email.mjs
scripts\repro-import-atomicity.mjs
scripts\resolve-alias.mjs
scripts\resolve-base44.mjs
scripts\stubs\base44-runtime.mjs
scripts\stubs\base44-sdk.mjs
scripts\test_anomaly_detector.mjs
scripts\test_auditlog_immutability.mjs
scripts\test_bulletproof_auth.mjs
scripts\test_defect_5_probe.mjs
scripts\test_local_auth.mjs
scripts\test_me_disabled.mjs
scripts\test_realtime_revocation.mjs
scripts\test_validator.mjs
scripts\test-parser.mjs
scripts\test-throttle.mjs
scripts\test-throttle-standalone.mjs
scripts\update-csrf.mjs
scripts\update-test-csrf.mjs
scripts\verify_cross_module_impact.mjs
scripts\verify-actioncenter.mjs
scripts\verify-anomaly-ingestion.mjs
scripts\verify-coexistence.mjs
scripts\verify-donut-labels.mjs
scripts\verify-harness.mjs
scripts\verify-import-rollback.mjs
scripts\verify-imports.mjs
scripts\verify-money-kept.mjs
scripts\verify-motion.mjs
scripts\verify-source-contributions.mjs
scripts\verify-statistics.mjs
scripts\verify-timecard.mjs
scripts\verify-transactions.mjs
src\api\authLocal.test.js
src\api\autoPayroll.test.js
src\api\base44Client.importRollback.test.js
src\api\base44Client.js
src\api\localDb.js
src\App.jsx
src\components\AIAssistant.jsx
src\components\AnomalySignoffModal.jsx
src\components\AuditCategoryFilter.jsx
src\components\AuthLayout.jsx
src\components\charts\ChartToolbar.jsx
src\components\charts\PieDonut.jsx
src\components\charts\PieDonut.test.jsx
src\components\charts\UniversalChart.jsx
src\components\CommandMenu.jsx
src\components\compare\ChannelRevenue.jsx
src\components\compare\CompareBars.jsx
src\components\compare\CompareCard.jsx
src\components\dashboard\ClerkAudit.jsx
src\components\dashboard\ClerkAuditMatrix.jsx
src\components\dashboard\ExecutiveCharts.jsx
src\components\dashboard\LowOccAlert.jsx
src\components\dashboard\ModuleCards.jsx
src\components\dashboard\MoneyKept.jsx
src\components\dashboard\OtaMatrix.jsx
src\components\dashboard\PaymentMethodChart.jsx
src\components\dashboard\PricingPanel.jsx
src\components\dashboard\PropertyRanking.jsx
src\components\dashboard\RevenueTrend.jsx
src\components\dashboard\WeatherPanel.jsx
src\components\dashboard\YieldAdvisor.jsx
src\components\GlobalControlBar.jsx
src\components\GoogleIcon.jsx
src\components\HousekeepingSettingsModal.jsx
src\components\Layout.jsx
src\components\MFARecoveryModal.jsx
src\components\MFASetup.jsx
src\components\PasswordConfirmDialog.jsx
src\components\PricingOverrideButton.jsx
src\components\propertyMap.jsx
src\components\ProtectedRoute.jsx
src\components\ReconciliationExportButton.jsx
src\components\ScrollToTop.jsx
src\components\statistics\MetricExplorer.jsx
src\components\TaxConfigModal.jsx
src\components\transactions\CommissionsPanel.jsx
src\components\transactions\EmployeeCompare.jsx
src\components\transactions\LedgerStrip.jsx
src\components\transactions\LedgerTable.jsx
src\components\ui\accordion.jsx
src\components\ui\accordion.test.jsx
src\components\ui\alert.jsx
src\components\ui\alert.test.jsx
src\components\ui\alert-dialog.jsx
src\components\ui\aspect-ratio.jsx
src\components\ui\avatar.jsx
src\components\ui\avatar.test.jsx
src\components\ui\badge.jsx
src\components\ui\badge.test.jsx
src\components\ui\breadcrumb.jsx
src\components\ui\button.jsx
src\components\ui\button.test.jsx
src\components\ui\calendar.jsx
src\components\ui\card.jsx
src\components\ui\card.test.jsx
src\components\ui\carousel.jsx
src\components\ui\chart.jsx
src\components\ui\checkbox.jsx
src\components\ui\checkbox.test.jsx
src\components\ui\collapsible.jsx
src\components\ui\command.jsx
src\components\ui\context-menu.jsx
src\components\ui\dialog.jsx
src\components\ui\drawer.jsx
src\components\ui\dropdown-menu.jsx
src\components\ui\empty-state.jsx
src\components\ui\error-boundary.jsx
src\components\ui\form.jsx
src\components\ui\hover-card.jsx
src\components\ui\image.jsx
src\components\ui\input.jsx
src\components\ui\input.test.jsx
src\components\ui\input-otp.jsx
src\components\ui\label.jsx
src\components\ui\label.test.jsx
src\components\ui\loading.jsx
src\components\ui\menubar.jsx
src\components\ui\navigation-menu.jsx
src\components\ui\pagination.jsx
src\components\ui\popover.jsx
src\components\ui\progress.jsx
src\components\ui\progress.test.jsx
src\components\ui\radio-group.jsx
src\components\ui\resizable.jsx
src\components\ui\ResponsiveSelect.jsx
src\components\ui\scroll-area.jsx
src\components\ui\select.jsx
src\components\ui\separator.jsx
src\components\ui\separator.test.jsx
src\components\ui\sheet.jsx
src\components\ui\sidebar.jsx
src\components\ui\skeleton.jsx
src\components\ui\skeleton.test.jsx
src\components\ui\slider.jsx
src\components\ui\sonner.jsx
src\components\ui\status.jsx
src\components\ui\switch.jsx
src\components\ui\switch.test.jsx
src\components\ui\table.jsx
src\components\ui\table.test.jsx
src\components\ui\tabs.jsx
src\components\ui\tabs.test.jsx
src\components\ui\textarea.jsx
src\components\ui\textarea.test.jsx
src\components\ui\toast.jsx
src\components\ui\toaster.jsx
src\components\ui\toggle.jsx
src\components\ui\toggle.test.jsx
src\components\ui\toggle-group.jsx
src\components\ui\toggle-group.test.jsx
src\components\ui\tooltip.jsx
src\components\ui\types.js
src\components\ui\use-toast.jsx
src\components\ui-exec\Card.jsx
src\components\ui-exec\KpiCard.jsx
src\components\ui-exec\RangePicker.jsx
src\components\ui-exec\StatusBadge.jsx
src\components\UserNotRegisteredError.jsx
src\crdt.jsx
src\hooks\use-mobile.jsx
src\hooks\usePullToRefresh.js
src\hooks\useSettingsVersion.js
src\hooks\use-size.jsx
src\index.css
src\lib\actionCenter.js
src\lib\agenticAI.js
src\lib\aiEngine.js
src\lib\aiEngine.test.js
src\lib\aiInsights.js
src\lib\alertEngine.js
src\lib\alertThresholds.js
src\lib\anomalyDetector.js
src\lib\anomalyDetector.test.js
src\lib\anomalySignoff.js
src\lib\app-params.js
src\lib\auditFilter.js
src\lib\auditLogger.js
src\lib\AuthContext.jsx
src\lib\authHelpers.js
src\lib\authHelpers.test.js
src\lib\authReturnTo.js
src\lib\calculationService.js
src\lib\chartExport.js
src\lib\columnarAnalytics.js
src\lib\commissionRates.js
src\lib\crdtSync.js
src\lib\csvParser.js
src\lib\dailyAggregates.js
src\lib\dataScanner.js
src\lib\dataScanner.test.js
src\lib\decimal.js
src\lib\deleteGuard.js
src\lib\donutLabelLayout.js
src\lib\employeeId.js
src\lib\expenseCategories.js
src\lib\financialReconciliation.js
src\lib\forecasting.js
src\lib\fraudScoringEngine.js
src\lib\hotel.js
src\lib\hotelKeyRegression.test.js
src\lib\housekeepingConfig.js
src\lib\housekeepingService.js
src\lib\importValidation.js
src\lib\laborOptimization.js
src\lib\launchPolicy.js
src\lib\manualEntryImport.js
src\lib\mfaRecovery.js
src\lib\motion.js
src\lib\navigation.js
src\lib\ownerIntelligence.js
src\lib\PageNotFound.jsx
src\lib\parser.worker.js
src\lib\paymentNorm.js
src\lib\payrollCalc.js
src\lib\pdfExport.js
src\lib\permissions.js
src\lib\pricingEngine.js
src\lib\pricingOverride.js
src\lib\pricingSettings.js
src\lib\query-client.js
src\lib\realtime.js
src\lib\recalculationService.js
src\lib\reconciliationExport.js
src\lib\reportParsers.js
src\lib\reputationService.js
src\lib\RevenueReconciliation.js
src\lib\revenueThresholds.js
src\lib\roomBoard.js
src\lib\security.js
src\lib\securityUtils.js
src\lib\securityUtils.test.js
src\lib\sessionChannel.js
src\lib\settingsBus.js
src\lib\sound.js
src\lib\statisticsAnalytics.js
src\lib\taxConfig.js
src\lib\taxLiability.js
src\lib\taxLiability.test.js
src\lib\taxSettings.js
src\lib\timecardCalc.js
src\lib\timecardCalc.test.js
src\lib\transactionAnalytics.js
src\lib\transactionNorm.js
src\lib\ui-utils.js
src\lib\universalParser.js
src\lib\uploadRetention.js
src\lib\useCountUp.jsx
src\lib\useGlobalFilters.jsx
src\lib\useHotelData.js
src\lib\usePricing.js
src\lib\utils.js
src\lib\validator.js
src\lib\weatherService.js
src\lib\weatherSettings.js
src\lib\yieldOptimizer.js
src\lib\ySync.js
src\main.jsx
src\pages\ActionCenter.jsx
src\pages\AuditLog.jsx
src\pages\ChangePassword.jsx
src\pages\ChannelManager.jsx
src\pages\ChartBuilder.jsx
src\pages\Compare.jsx
src\pages\Dashboard.jsx
src\pages\DataIntelligence.jsx
src\pages\DataTemplate.jsx
src\pages\DemoYDoc.jsx
src\pages\Employees.jsx
src\pages\Expenses.jsx
src\pages\Forecasting.jsx
src\pages\ForgotPassword.jsx
src\pages\Housekeeping.jsx
src\pages\Import.jsx
src\pages\Login.jsx
src\pages\Login.test.jsx
src\pages\ManualEntry.jsx
src\pages\MonthlyCalendar.jsx
src\pages\MtdGrowth.jsx
src\pages\OtaChannels.jsx
src\pages\Payments.jsx
src\pages\Payroll.jsx
src\pages\Pricing.jsx
src\pages\PrivacyPolicy.jsx
src\pages\ResetPassword.jsx
src\pages\Reviews.jsx
src\pages\RoomBoard.jsx
src\pages\Settings.jsx
src\pages\Setup.jsx
src\pages\Setup.test.jsx
src\pages\Statistics.jsx
src\pages\TermsOfService.jsx
src\pages\Transactions.jsx
src\pages\Users.jsx
src\tests\dataIntegrity.test.js
src\tests\financials.test.js
src\test-setup.js
src\types\ui.js
src\utils\index.js
src\utils\index.ts
``n</details>


