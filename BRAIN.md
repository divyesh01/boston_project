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
| 18 | [Glossary](#18-glossary) | Every term explained simply |

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

```
Hotel data (CSV files) --> Server Calculates --> Dashboard (React UI)
(HotelKey PMS)             (Base44 Backend)      (What you see)
```

### Who Uses It
| Person | Role | What They Do |
|--------|------|-------------|
| Divyesh | Hotel Owner | Checks dashboard daily, makes business decisions |
| AI Agents | Developers | Build features, fix bugs, write tests |
| Accountants | Finance | Track money, reconcile, audit |
| Front Desk | Staff | Import daily reports, manage rooms |

### Real Numbers (Actual Data: Jan 1 - Aug 2, 2026)
```
Total Gross Revenue:    $1,011,258.17
Total Money Kept:       $920,829.00
Total Rooms Booked:     12,362
Properties:             25 hotels
Occupancy Rate:         57.8%
Average Room Rate:      $81.80
Profit Margin:          91.1%
```

---

# 2. HOW EVERYTHING CONNECTS

```
USER'S BROWSER                          BASE44 CLOUD SERVER
+------------------------+             +------------------------+
|                        |             |                        |
|  React Frontend        |  <- HTTP -> |  19 Serverless         |
|  (src/)                |             |  Functions             |
|                        |             |  (base44/functions/)   |
|  +------------------+  |             |                        |
|  | 36 Pages         |  |             |  +------------------+  |
|  | 40+ Components   |  |             |  | 16 Database      |  |
|  | 90+ Libraries    |  |             |  | Tables           |  |
|  +------------------+  |             |  | (base44/         |  |
|                        |             |  |  entities/)      |  |
|  Local IndexedDB       |             |  +------------------+  |
|  (offline dev only)    |             |                        |
+------------------------+             |  Google Drive          |
                                       |  (backup connector)    |
                                       |                        |
                                       |  OpenWeather API       |
                                       |  (weather widget)      |
                                       +------------------------+
```

### The Three Revenue Paths (Critical!)
The system calculates revenue THREE different ways and checks they match:

```
Path 1: CSV Import --> GrossRevenueDay table --> Sum of room_revenue
Path 2: CSV Import --> PaymentDay table --> Sum of all payment methods
Path 3: CSV Import --> OccupancyDay table --> rooms_sold x ADR

All three MUST match (within $0.01). If they don't --> ALERT!
```

---

# 3. DIRECTORY MAP (Where Everything Lives)

```
boston_project/
|-- src/                          <-- FRONTEND (269 files)
|   |-- App.jsx                   <-- App entry point, all routes defined here
|   |-- main.jsx                  <-- React root render + production security check
|   |-- crdt.jsx                  <-- Real-time sync provider (Yjs)
|   |-- index.css                 <-- Global styles + Tailwind + dark theme tokens
|   |-- api/
|   |   |-- base44Client.js       <-- SDK client (auth, entities, data) PROTECTED
|   |   +-- localDb.js            <-- Dexie/IndexedDB schema (v1-v22, 30+ tables)
|   |-- components/               <-- Reusable UI pieces (40+ files)
|   |   |-- dashboard/            <-- Dashboard widgets (MoneyKept, RevenueTrend, etc.)
|   |   |-- charts/               <-- Chart components (PieDonut, UniversalChart)
|   |   |-- compare/              <-- Multi-property comparison
|   |   |-- finance/              <-- Ledger, commissions
|   |   |-- ui/                   <-- Shadcn UI primitives (50+ files)
|   |   +-- ui-exec/              <-- Executive-styled cards (KpiCard, RangePicker)
|   |-- hooks/                    <-- Custom React hooks (use-mobile, use-size, etc.)
|   |-- lib/                      <-- Business logic engines (90+ files)
|   |   |-- calculationService.js <-- Main financial calculator (ADR, RevPAR, etc.)
|   |   |-- csvParser.js          <-- CSV import parser (handles duplicate columns)
|   |   |-- dailyAggregates.js    <-- Daily summary builder (the room_revenue typo was here)
|   |   |-- RevenueReconciliation.js <-- 3-path revenue checker
|   |   |-- decimal.js            <-- Integer-cents math (prevents float errors)
|   |   |-- fraudScoringEngine.js <-- Anomaly detection (Benford's Law, z-score)
|   |   |-- anomalyDetector.js    <-- Statistical outlier detection (Welford's algo)
|   |   |-- pricingEngine.js      <-- Dynamic room pricing (elasticity, demand)
|   |   |-- universalParser.js    <-- Multi-grid streaming CSV parser
|   |   |-- parser.worker.js      <-- Web Worker for CSV parsing (off main thread)
|   |   |-- securityUtils.js      <-- CSRF, rate limiting, audit PROTECTED
|   |   |-- AuthContext.jsx       <-- Auth provider, session mgmt PROTECTED
|   |   |-- security.js           <-- Password hashing, MFA PROTECTED
|   |   |-- permissions.js        <-- RBAC role system PROTECTED
|   |   |-- deleteGuard.js        <-- Safe deletion: Confirm -> Rate-Limit -> CSRF
|   |   |-- launchPolicy.js       <-- Production launch restrictions
|   |   |-- crdtSync.js           <-- Yjs CRDT real-time sync
|   |   +-- ... (90+ total files)
|   |-- pages/                    <-- Full-page views (36 files)
|   |   |-- Dashboard.jsx         <-- Main dashboard
|   |   |-- Login.jsx             <-- Login page PROTECTED
|   |   |-- Import.jsx            <-- CSV file upload
|   |   |-- Payroll.jsx           <-- Employee payroll
|   |   |-- Housekeeping.jsx      <-- Room status board
|   |   +-- ... (36 total)
|   +-- test/                     <-- Frontend test suites
|
|-- base44/                       <-- BACKEND (43 files)
|   |-- config.jsonc              <-- Build commands + security headers (CSP, HSTS)
|   |-- .app.jsonc                <-- Cloud app ID link (6a7d6856ee1cc714b1803c0e)
|   |-- auth/config.jsonc         <-- Auth methods (password + Google OAuth)
|   |-- connectors/
|   |   +-- googledrive.jsonc     <-- Google Drive OAuth setup
|   |-- entities/                 <-- DATABASE TABLES (16 .jsonc files)
|   |   |-- User.jsonc            <-- Users, roles, scrypt passwords, MFA secrets
|   |   |-- Session.jsonc         <-- Active login sessions (SHA-256 token hash)
|   |   |-- Property.jsonc        <-- Hotel properties (code, name, rooms)
|   |   |-- OccupancyDay.jsonc    <-- Daily room stats (sold, vacant, ADR, RevPAR)
|   |   |-- GrossRevenueDay.jsonc <-- Daily revenue by department
|   |   |-- PaymentDay.jsonc      <-- Daily payment method breakdown
|   |   |-- AuditLog.jsonc        <-- Tamper-proof security log (APPEND-ONLY)
|   |   +-- ... (16 total)
|   |-- functions/                <-- SERVERLESS FUNCTIONS (19 folders)
|   |   |-- custom_auth_login/    <-- Login with MFA + rate limiting (5/15min)
|   |   |-- custom_auth_register/ <-- User registration + owner bootstrap
|   |   |-- audit_log/            <-- SHA-256 HMAC chained audit entries
|   |   |-- audit_clear/          <-- ALWAYS returns 403 (audit can NEVER be cleared)
|   |   |-- autoPayroll/          <-- Monthly auto-payroll (last day of month)
|   |   |-- aiAssistant/          <-- AI chatbot with anti-jailbreak prompts
|   |   |-- backupToDrive/        <-- Google Drive backup with SSRF protection
|   |   +-- ... (19 total)
|   +-- lib/                      <-- Shared backend libraries
|       |-- corsConfig.js         <-- CORS origin validator
|       +-- securityHeaders.js    <-- CSP + security header generator
|
|-- scripts/                      <-- TEST & VERIFICATION (106 files)
|   |-- _loader-boot.mjs          <-- Node test bootstrap (aliases, browser shims)
|   |-- _harness-auth.mjs         <-- Creates test Owner account
|   |-- acceptance-harness.mjs    <-- Runs ALL probe tests
|   |-- probe-*.mjs               <-- 20+ individual probe tests
|   |-- stubs/                    <-- Base44 SDK mocks for testing
|   |   |-- base44-runtime.mjs    <-- In-memory serverless host mock
|   |   +-- base44-sdk.mjs        <-- In-memory SDK mock with sorting
|   +-- data/                     <-- 19 real CSV test files from actual hotels
|
|-- backend/                      <-- STANDALONE SERVICES (2 files)
|   |-- webhooks.js               <-- Webhook ingestion + HMAC signature verify
|   +-- websocket.js              <-- Yjs real-time sync server + auth + CSWSH defense
|
|-- public/                       <-- STATIC FILES (icons, manifest)
|
|-- BRAIN.md                      <-- THIS FILE (you are here!)
|-- AI_CORE_RULES.md              <-- AI operating rules
|-- PROTECTED_FILES.md            <-- Files AI cannot edit
|-- AGENTS.md                     <-- Gemini/Antigravity agent rules
|-- CLAUDE.md                     <-- Claude/OpenCode agent rules
|-- BUSINESS.md                   <-- Hotel business rules + LLM prompts (52 KB)
|-- LAUNCH_READINESS_CHECKLIST.md <-- Master audit report (101 KB, most detailed doc)
+-- (other docs...)
```

---

# 4. ALL 36 PAGES (What Users See)

Every page in the app, what it does, and what files it depends on.

### Main Dashboard
| Page | File | What It Does | Key Dependencies |
|------|------|-------------|-----------------|
| **Dashboard** | `src/pages/Dashboard.jsx` | Main scoreboard: revenue, occupancy, profit, charts | `MoneyKept`, `PaymentMethodChart`, `RevenueTrend`, `PropertyRanking`, `OtaMatrix`, `ExecutiveCharts`, `LowOccAlert`, `WeatherPanel`, `YieldAdvisor`, `PricingPanel` |
| **Statistics** | `src/pages/Statistics.jsx` | Detailed stats with filters, MTD, YTD comparisons | `statisticsAnalytics.js`, `columnarAnalytics.js` |
| **Compare** | `src/pages/Compare.jsx` | Side-by-side property and period comparison | `CompareBars`, `CompareCard`, `ChannelRevenue` |
| **MtdGrowth** | `src/pages/MtdGrowth.jsx` | Month-to-date growth velocity tracking | `calculationService.js` |
| **Forecasting** | `src/pages/Forecasting.jsx` | Predict future revenue (1, 7, 30, 90 day) | `forecasting.js` |

### Operations
| Page | File | What It Does | Key Dependencies |
|------|------|-------------|-----------------|
| **Import** | `src/pages/Import.jsx` | Upload CSV files from HotelKey, auto-classify, atomic undo | `csvParser.js`, `universalParser.js`, `parser.worker.js`, `importValidation.js`, `reportParsers.js` |
| **ManualEntry** | `src/pages/ManualEntry.jsx` | Enter data by hand, copy-paste from spreadsheets | `manualEntryImport.js` |
| **Housekeeping** | `src/pages/Housekeeping.jsx` | Room status board (clean/dirty/inspected), maid assignment | `housekeepingService.js`, `housekeepingConfig.js`, `laborOptimization.js` |
| **RoomBoard** | `src/pages/RoomBoard.jsx` | Visual room grid: check-in/out, real-time CRDT sync | `roomBoard.js`, `crdtSync.js`, `pricingEngine.js` |
| **MonthlyCalendar** | `src/pages/MonthlyCalendar.jsx` | Heatmap calendar: daily occupancy + revenue tiers | `revenueThresholds.js`, `hotel.js` |

### Finance
| Page | File | What It Does | Key Dependencies |
|------|------|-------------|-----------------|
| **Transactions** | `src/pages/Transactions.jsx` | Detailed guest transaction ledger | `transactionAnalytics.js`, `transactionNorm.js` |
| **Payments** | `src/pages/Payments.jsx` | Payment method breakdown (card/cash/check) | `paymentNorm.js`, `taxConfig.js`, `reconciliationExport.js` |
| **Expenses** | `src/pages/Expenses.jsx` | Operating expense tracking, P&L rollup | `expenseCategories.js`, `deleteGuard.js` |
| **OtaChannels** | `src/pages/OtaChannels.jsx` | OTA performance: net margin by channel | `commissionRates.js`, `pdfExport.js` |
| **ChannelManager** | `src/pages/ChannelManager.jsx` | Channel commission configuration | `commissionRates.js` |

### Staff & Payroll
| Page | File | What It Does | Key Dependencies |
|------|------|-------------|-----------------|
| **Employees** | `src/pages/Employees.jsx` | Staff roster, clerk cash variance audit, anomaly sign-off | `anomalyDetector.js`, `anomalySignoff.js`, `ClerkAuditMatrix` |
| **Payroll** | `src/pages/Payroll.jsx` | Payroll register: hourly/salary, overtime, compensation | `payrollCalc.js`, `timecardCalc.js`, `employeeId.js`, `deleteGuard.js` |

### Analytics & Intelligence
| Page | File | What It Does | Key Dependencies |
|------|------|-------------|-----------------|
| **DataIntelligence** | `src/pages/DataIntelligence.jsx` | CSV health scoring, cross-report consistency, AI diagnostics | `dataScanner.js`, `aiInsights.js` |
| **DataTemplate** | `src/pages/DataTemplate.jsx` | CSV template reference + sample generator | None |
| **ChartBuilder** | `src/pages/ChartBuilder.jsx` | Custom chart creator (grouping, aggregation, multi-chart) | `chartExport.js`, `UniversalChart` |
| **Pricing** | `src/pages/Pricing.jsx` | Dynamic pricing recommendations + overrides | `pricingEngine.js`, `pricingOverride.js`, `pricingSettings.js` |
| **ActionCenter** | `src/pages/ActionCenter.jsx` | Automated alerts: Fix Today / Investigate / Opportunity | `actionCenter.js`, `alertEngine.js`, `anomalyDetector.js` |
| **Reviews** | `src/pages/Reviews.jsx` | Guest review sentiment scoring + reputation | `reputationService.js` |

### Admin & Security
| Page | File | What It Does | Key Dependencies |
|------|------|-------------|-----------------|
| **Login** | `src/pages/Login.jsx` PROTECTED | Sign in with MFA, remember-me | `AuthContext.jsx`, `security.js`, `MFASetup` |
| **Setup** | `src/pages/Setup.jsx` PROTECTED | First-run owner creation wizard | `AuthContext.jsx`, `security.js`, `validator.js` |
| **ForgotPassword** | `src/pages/ForgotPassword.jsx` PROTECTED | Request password reset (anti-enumeration) | `securityUtils.js`, `validator.js` |
| **ResetPassword** | `src/pages/ResetPassword.jsx` PROTECTED | Execute password reset (token + complexity) | `security.js`, `securityUtils.js` |
| **ChangePassword** | `src/pages/ChangePassword.jsx` | Change own password with strength check | `security.js`, `securityUtils.js`, `AuthContext.jsx` |
| **Users** | `src/pages/Users.jsx` | User management: invitations, roles, lockouts, MFA | `permissions.js`, `security.js` |
| **AuditLog** | `src/pages/AuditLog.jsx` | Security audit log viewer + chain verification | `securityUtils.js`, `auditFilter.js` |
| **Settings** | `src/pages/Settings.jsx` | App settings: commissions, alerts, taxes, MFA | `commissionRates.js`, `alertThresholds.js`, `taxSettings.js` |
| **PrivacyPolicy** | `src/pages/PrivacyPolicy.jsx` | Legal page | None |
| **TermsOfService** | `src/pages/TermsOfService.jsx` | Legal page | None |
| **DemoYDoc** | `src/pages/DemoYDoc.jsx` | Real-time CRDT sync demo | `crdt.jsx` |

---

# 5. ALL 90+ LIBRARIES (The Engines Under The Hood)

These are the files in `src/lib/` -- the brains of the app. Grouped by what they do.

### Money & Financial Engines
| File | What It Does | If You Edit This... |
|------|-------------|-------------------|
| `calculationService.js` | **Main calculator**: ADR, RevPAR, occupancy, net revenue, weighted averages | Dashboard numbers change. Test ALL financial displays. |
| `dailyAggregates.js` | Builds daily summary rows from raw data, caches results | Dashboard cards break. The room_revenue typo lived here (Problem #3). |
| `financialReconciliation.js` | 4-way cross-check: PMS reports, gateway auth, batch settlement, bank deposits | Revenue drift alerts break. |
| `RevenueReconciliation.js` | 3-path revenue matcher (Path 1 vs 2 vs 3) | Revenue audit breaks. |
| `decimal.js` | Integer-cents math: toCents(), fromCents(), multiply(), divide() -- prevents float errors | ALL money calculations break. Critical for accuracy. |
| `commissionRates.js` | OTA commission models (fixed, %, none, tax-exempt) | Channel revenue goes wrong. |
| `expenseCategories.js` | Expense type definitions | Expense tracking breaks. |
| `taxConfig.js` | Tax configuration rules | Tax calculations go wrong. |
| `taxSettings.js` | Date-windowed property-specific tax rates | Tax liability miscalculated. |
| `taxLiability.js` | Tax liability calculator | Tax reports wrong. |
| `payrollCalc.js` | Payroll: gross-to-net wage computation | Employee pay calculated wrong. |
| `timecardCalc.js` | Timecard hours/overtime (40h threshold, 30m break rules) | Overtime pay wrong. |
| `recalculationService.js` | Triggers React Query cache invalidation when data changes | Stale dashboard data. |

### Data Processing & Parsing
| File | What It Does | If You Edit This... |
|------|-------------|-------------------|
| `csvParser.js` | Core CSV parser (handles duplicate columns -- Problem #1 fix) | ALL data imports break. |
| `universalParser.js` | Multi-grid streaming CSV parser for complex reports | Complex CSV imports fail. |
| `parser.worker.js` | Web Worker for background CSV parsing (off main thread) | Import page freezes browser. |
| `reportParsers.js` | Parses specific HotelKey report types (Occupancy, Revenue, etc.) | Reports import with wrong column mapping. |
| `importValidation.js` | 4-layer validation: structure, columns, data types, business logic | Bad data gets into database. |
| `dataScanner.js` | Auto-detects CSV format, finds duplicates, date gaps, orphans | Data Intelligence page breaks. |
| `transactionNorm.js` | Normalizes transaction data shapes | Transaction page shows wrong data. |
| `paymentNorm.js` | Normalizes payment method names (Visa, MC, etc.) | Payment chart labels wrong. |
| `hotel.js` | Core hotel data operations and transformations | Everything hotel-related breaks. |
| `manualEntryImport.js` | Manual data entry processing | Manual Entry page breaks. |
| `uploadRetention.js` | TTL cleanup of expired CSV previews from IndexedDB | Browser storage fills up. |

### Security (Most Are Protected!)
| File | What It Does | If You Edit This... |
|------|-------------|-------------------|
| `AuthContext.jsx` PROTECTED | Auth provider, session management, idle polling (30s), cross-tab logout | Login breaks for EVERYONE. |
| `security.js` PROTECTED | PBKDF2 hashing (300k iterations), TOTP/MFA, WebCrypto | Passwords break, MFA breaks. |
| `securityUtils.js` PROTECTED | CSRF tokens (__Host- prefix), rate limiting, SHA-256 audit chain | Security wide open to attacks. |
| `permissions.js` PROTECTED | Roles: owner/admin/manager/front_desk/accountant/read_only | Users see data they should not. |
| `validator.js` PROTECTED | Email/input validation rules | Bad data accepted, injection possible. |
| `authHelpers.js` | Auth utility functions | Login flow breaks. |
| `authReturnTo.js` | Remembers where user was before login redirect | User redirected wrong after login. |
| `deleteGuard.js` | Safe deletion pipeline: Confirm -> Rate-Limit -> CSRF check | Accidental mass deletion possible. |
| `launchPolicy.js` | Production launch restrictions (LAUNCH_POLICY_V1) | Wrong users get production access. |
| `sessionChannel.js` | Cross-tab session sync via BroadcastChannel | Logout in one tab does not logout others. |
| `mfaRecovery.js` | MFA recovery code generation + SHA-256 hash validation | Users locked out of MFA accounts forever. |
| `auditLogger.js` | Frontend audit event logging | Security events not logged. |
| `auditFilter.js` | Audit log filtering for viewer page | Audit page filters break. |

### Analytics, AI & Intelligence
| File | What It Does | If You Edit This... |
|------|-------------|-------------------|
| `anomalyDetector.js` | Welford's algorithm + Benford's Law + z-score outliers | Fraud detection breaks. |
| `fraudScoringEngine.js` | Scores transactions: rate overrides, off-hours, large cash (>$200) | Fraud alerts stop. |
| `statisticsAnalytics.js` | Statistical analysis engine for Statistics page | Statistics page breaks. |
| `columnarAnalytics.js` | Column-level data analysis | Data Intelligence breaks. |
| `transactionAnalytics.js` | Transaction pattern analysis, employee performance | Transaction insights wrong. |
| `aiEngine.js` | AI prompt builder + intent parser + date resolver | AI Assistant answers wrong. |
| `aiInsights.js` | AI-generated dashboard insight cards | AI insight cards break. |
| `agenticAI.js` | Agentic AI orchestration + scheduling proposals | AI workflows break. |
| `ownerIntelligence.js` | Owner-specific business intelligence metrics | Owner reports wrong. |
| `forecasting.js` | Multi-model revenue prediction (1/7/30/90 day) | Forecasting page breaks. |
| `revenueThresholds.js` | Revenue alert thresholds | Revenue alerts stop firing. |
| `alertEngine.js` | Alert generation engine | All alerts stop. |
| `alertThresholds.js` | Alert threshold configuration | Alert sensitivity wrong. |

### Operations & Pricing
| File | What It Does | If You Edit This... |
|------|-------------|-------------------|
| `pricingEngine.js` | Dynamic room pricing: elasticity, demand, weather, comp-set | Room prices calculated wrong. |
| `pricingOverride.js` | Manual price overrides | Override prices do not apply. |
| `pricingSettings.js` | Pricing sensitivity presets | Pricing defaults wrong. |
| `housekeepingService.js` | Room status management (clean/dirty/inspected) | Room board wrong. |
| `housekeepingConfig.js` | Housekeeping settings | Housekeeping defaults wrong. |
| `roomBoard.js` | Room grid state management | Room board view breaks. |
| `weatherService.js` | Live weather data + revenue correlation | Weather widget breaks. |
| `weatherSettings.js` | Weather display configuration | Weather display wrong. |
| `laborOptimization.js` | Staff scheduling optimization | Labor cost estimates wrong. |
| `yieldOptimizer.js` | Revenue yield optimization suggestions | Yield suggestions wrong. |
| `reputationService.js` | Guest review aggregation + sentiment | Reviews page breaks. |
| `actionCenter.js` | Action item management (Fix Today/Investigate/Opportunity) | Action Center page breaks. |
| `anomalySignoff.js` | Anomaly triage sign-off workflow | Anomaly triage breaks. |

### Infrastructure & UI Utilities
| File | What It Does | If You Edit This... |
|------|-------------|-------------------|
| `query-client.js` | React Query config (data fetching cache) | ALL data fetching breaks. |
| `crdtSync.js` | Yjs CRDT real-time sync operations | Multi-user editing breaks. |
| `ySync.js` | Yjs sync utilities | Real-time sync breaks. |
| `realtime.js` | Real-time data subscription | Live updates stop. |
| `settingsBus.js` | Settings event bus (BroadcastChannel) | Settings do not propagate across tabs. |
| `navigation.js` | Route definitions, titles, icons | Sidebar navigation breaks. |
| `app-params.js` | Global app parameters | App defaults wrong. |
| `chartExport.js` | Export charts as high-DPI images | Chart export fails. |
| `pdfExport.js` | Export data as PDF | PDF export fails. |
| `reconciliationExport.js` | Export reconciliation reports | Reconciliation export fails. |
| `motion.js` | Framer Motion animation config | Animations break. |
| `sound.js` | Notification sounds (Web Audio) | Alert sounds stop. |
| `donutLabelLayout.js` | Pie chart label positioning algorithm | Donut chart labels overlap. |
| `useCountUp.jsx` | Number count-up animation for KPI cards | KPI animations break. |
| `ui-utils.js` | UI helper functions | Various UI glitches. |
| `utils.js` | General utility functions | Many things break subtly. |
| `employeeId.js` | Employee ID generation | Employee IDs wrong. |
| `uploadRetention.js` | Manages uploaded file cleanup | Old uploads never cleaned up. |

### Custom Hooks
| File | What It Does | If You Edit This... |
|------|-------------|-------------------|
| `useHotelData.js` | Fetches and caches ALL hotel data | ALL pages lose hotel data. |
| `useGlobalFilters.jsx` | Global date/property filter state | All filters break across every page. |
| `usePricing.js` | Pricing data hook | Pricing page loses data. |
| `usePullToRefresh.js` | Pull-to-refresh gesture on mobile | Mobile refresh gesture breaks. |
| `useSettingsVersion.js` | Subscribes to settings changes via settingsBus | UI does not recompute when settings change. |
| `use-mobile.jsx` | Mobile viewport detection (<768px) | Mobile layout breaks. |
| `use-size.jsx` | Element size tracking (ResizeObserver) | Responsive chart sizing breaks. |

---

# 6. ALL 40+ COMPONENTS (Reusable UI Pieces)

### Dashboard Widgets (src/components/dashboard/)
| Component | What It Shows | Key Data Source |
|-----------|-------------|----------------|
| `MoneyKept.jsx` | Net revenue bridge: deductions for commissions, fees, taxes | `dailyAggregates.js` -> `room_revenue` |
| `PaymentMethodChart.jsx` | Pie chart of payment methods | `PaymentDay` entity |
| `RevenueTrend.jsx` | Revenue over time line chart | `GrossRevenueDay` entity |
| `PropertyRanking.jsx` | Properties ranked by revenue | `calculationService.js` |
| `OtaMatrix.jsx` | OTA channel performance: gross, commission, net margin | `Channel` entity |
| `ExecutiveCharts.jsx` | Multi-series area/bar: portfolio occupancy and revenue pacing | Multiple sources |
| `LowOccAlert.jsx` | Low occupancy warning banner | `OccupancyDay` entity |
| `WeatherPanel.jsx` | Weather forecast + revenue correlation | `getWeather` function |
| `YieldAdvisor.jsx` | Revenue optimization tips | `yieldOptimizer.js` |
| `PricingPanel.jsx` | Dynamic pricing overview card | `pricingEngine.js` |
| `ModuleCards.jsx` | Feature module quick access tiles | Navigation config |
| `ClerkAudit.jsx` | Clerk shift audit view | `ClerkShiftRecord` entity |
| `ClerkAuditMatrix.jsx` | Clerk cash variance comparison matrix | `ClerkShiftRecord` entity |

### Chart Components (src/components/charts/)
| Component | What It Does |
|-----------|-------------|
| `UniversalChart.jsx` | Renders any chart type (bar, line, area, pie) + high-DPI export |
| `PieDonut.jsx` | Donut/pie charts with custom label layout |
| `ChartToolbar.jsx` | Chart filter/export toolbar |

### Layout & Navigation
| Component | What It Does |
|-----------|-------------|
| `Layout.jsx` | Main app shell: sidebar, header, content area, responsive drawer |
| `GlobalControlBar.jsx` | Persistent top filter bar: property + date range + compare toggles |
| `ProtectedRoute.jsx` | Route guard: role checks, active status, audit logging |
| `ScrollToTop.jsx` | Auto-scroll to top on page change |
| `AuthLayout.jsx` | Layout for login/setup pages |
| `CommandMenu.jsx` | Cmd+K keyboard search palette |
| `AIAssistant.jsx` | Slide-out AI chatbot panel |
| `propertyMap.jsx` | Leaflet-based interactive property map |

### Modals & Dialogs
| Component | What It Does |
|-----------|-------------|
| `MFASetup.jsx` | MFA enrollment wizard with TOTP QR code |
| `MFARecoveryModal.jsx` | MFA backup recovery code display |
| `PasswordConfirmDialog.jsx` | Step-up password re-verification for sensitive actions |
| `HousekeepingSettingsModal.jsx` | Housekeeping configuration |
| `TaxConfigModal.jsx` | Tax rule management |
| `AnomalySignoffModal.jsx` | Anomaly triage sign-off |
| `PricingOverrideButton.jsx` | Manual price override trigger |
| `ReconciliationExportButton.jsx` | Reconciliation report export trigger |
| `UserNotRegisteredError.jsx` | Error display for unregistered users |

### Finance & Comparison
| Component | What It Does |
|-----------|-------------|
| `LedgerTable.jsx` | Virtualized guest transaction ledger table |
| `LedgerStrip.jsx` | Compact ledger summary strip |
| `CommissionsPanel.jsx` | Commission breakdown panel |
| `EmployeeCompare.jsx` | Employee performance comparison |
| `ChannelRevenue.jsx` | Channel revenue comparison |
| `CompareBars.jsx` | Period-over-period delta bars |
| `CompareCard.jsx` | Period comparison cards |

### Executive UI (src/components/ui-exec/)
| Component | What It Does |
|-----------|-------------|
| `Card.jsx` | Executive-styled card container |
| `KpiCard.jsx` | KPI metric display with count-up animation |
| `RangePicker.jsx` | Date range picker |
| `StatusBadge.jsx` | Status indicator badge |

---

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
# Run ALL unit tests (Vitest)
npm test

# Run a specific probe test
node --import ./scripts/_loader-boot.mjs scripts/probe-money-kept-fix.mjs

# Run ALL probe tests together
node --import ./scripts/_loader-boot.mjs scripts/acceptance-harness.mjs

# Lint the code
npm run lint
```

### Probe Tests (What Each One Proves)
| Script | What It Verifies |
|--------|-----------------|
| `probe-money-kept-fix.mjs` | Money Kept shows correct value (not $0) |
| `probe-csrf-secure-flag.mjs` | CSRF cookie has __Host- prefix + Secure flag |
| `probe-financial-invariant.mjs` | Revenue paths match within tolerance |
| `probe-money-kept-float.mjs` | Float math precision is handled correctly |
| `probe-session-expiry.mjs` | Sessions expire after timeout |
| `probe-session-slide.mjs` | Session sliding window extends correctly |
| `probe-session-sliding.mjs` | Sliding session edge cases |
| `probe-ui-disabled-reason.mjs` | Disabled account shows correct error |
| `probe-active-vs-idle.mjs` | Active vs idle session detection |
| `probe-audit-list.mjs` | Audit log listing works correctly |
| `probe-idle-polling.mjs` | Idle polling does not waste resources |
| `probe-session-noop.mjs` | Session no-op handling |
| `probe-welcome-email.mjs` | Welcome email has reset link (no password) |
| `test_defect_5_probe.mjs` | Revenue reconciliation drift detection |

### Test Data (scripts/data/)
19 real-world CSV files from actual hotel properties used for end-to-end testing.

---

# 11. THE DEPENDENCY MAP (What Breaks If You Touch It)

This is the most important section for any AI. Before editing ANY file, check here.

### RED = Editing These Breaks EVERYTHING
| File | What Breaks | Danger |
|------|-----------|--------|
| `src/api/base44Client.js` PROTECTED | ALL data fetching, auth, entity access, rate limiting, property isolation | EXTREME |
| `src/lib/AuthContext.jsx` PROTECTED | ALL login, logout, session management, idle detection, cross-tab sync | EXTREME |
| `src/lib/security.js` PROTECTED | ALL password hashing, MFA, WebCrypto primitives | EXTREME |
| `src/lib/permissions.js` PROTECTED | ALL role checks, route access, capability matrix | EXTREME |
| `src/App.jsx` | ALL routing, page rendering, provider tree, lazy loading | EXTREME |
| `base44/entities/User.jsonc` | ALL authentication + authorization | EXTREME |
| `base44/entities/Session.jsonc` | ALL session management | EXTREME |
| `.env.production` | Setting VITE_USE_LOCAL_AUTH=true = mock auth in production | EXTREME |

### ORANGE = Editing These Breaks Major Features
| File | What Breaks |
|------|-----------|
| `src/lib/calculationService.js` | ALL financial calculations on dashboard |
| `src/lib/dailyAggregates.js` | Dashboard KPI cards (Money Kept, Revenue) |
| `src/lib/csvParser.js` | ALL CSV data imports |
| `src/lib/hotel.js` | ALL hotel data operations |
| `src/lib/useHotelData.js` | ALL pages lose their data |
| `src/lib/useGlobalFilters.jsx` | ALL filters (date, property) stop working |
| `src/lib/decimal.js` | ALL money math becomes imprecise (float errors) |
| `src/lib/query-client.js` | ALL React Query data fetching / caching |
| `src/api/localDb.js` | Local dev database schema (30+ tables, 22 versions) |
| `base44/functions/audit_log/entry.js` | Audit hash chain breaks (tamper detection fails) |
| `base44/entities/Property.jsonc` | Multi-tenant scoping breaks, ADR/RevPAR divides by zero |
| `base44/entities/AuditLog.jsonc` | Tamper-proof audit trail compromised |
| `package.json` | Build, test, everything |
| `vite.config.js` | Build pipeline |
| `tailwind.config.js` | ALL styling across entire UI |
| `src/index.css` | ALL global styles, dark theme, animations, focus rings |

### GREEN = Editing These Is Lower Risk (Only Affects One Feature)
| File | What Breaks |
|------|-----------|
| `src/lib/weatherService.js` | Only weather widget |
| `src/lib/sound.js` | Only notification sounds |
| `src/lib/motion.js` | Only animations |
| `src/lib/donutLabelLayout.js` | Only donut chart labels |
| `src/pages/PrivacyPolicy.jsx` | Only legal page |
| `src/pages/TermsOfService.jsx` | Only legal page |
| `src/pages/DemoYDoc.jsx` | Only CRDT demo page |
| `src/components/ui/*` | Only that specific UI primitive |

---

# 12. THE MONEY MATH (Formulas)

Every financial formula. All should use integer cents (not floating-point).

```
Occupancy %  = (Rooms Sold / Total Rooms) x 100
ADR          = Room Revenue / Rooms Sold
RevPAR       = Room Revenue / Total Rooms  (or ADR x Occupancy%)

Money Kept   = Gross Revenue - OTA Commissions - Processing Fees - Business Taxes
Profit Margin = Money Kept / Gross Revenue x 100

Net Revenue (per channel) = Gross Revenue - Commission Amount
Commission Amount = Gross Revenue x Commission Rate %

Payroll:
  Regular Pay  = Hours Worked (up to 40) x Hourly Rate
  Overtime Pay = Hours Over 40 x (Hourly Rate x 1.5)
  Gross Pay    = Regular Pay + Overtime Pay + Bonuses
  Net Pay      = Gross Pay - Deductions
```

### The Golden Benchmark
All three revenue paths must match:
```
Path 1 (GrossRevenueDay sum)  ~=  Path 2 (PaymentDay sum)  ~=  Path 3 (OccupancyDay x ADR)
Tolerance: +/- $0.01
If they do not match --> Revenue Reconciliation Alert fires
```

### Real Numbers
```
Gross Revenue:    $1,011,258.17
- OTA Commissions: -$50,287.45
- Processing Fees: -$23,816.32
- Business Taxes:  -$16,325.40
= Money Kept:     $920,829.00 (91.1% profit margin)
```

---

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

### The 5-Step Workflow
```
1. SCAN    --> Read this BRAIN.md + relevant source files
2. PROVE   --> Write a test that shows the problem
3. FIX     --> Fix the root cause
4. VERIFY  --> Run the test to prove it is fixed
5. UPDATE  --> Update BRAIN.md to reflect what changed
```

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
