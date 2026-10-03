# Owner Launch Readiness Runbook (Release 2026-10-03)

> **Status:** `DRAFT` — **No claim of release readiness** until all final gates pass and the owner completes manual authenticated browser acceptance.

---

## 1. Verified Behavioral Repairs & Architectural Contracts

This release consolidates core financial, operational, worker aggregate, and frontend engine repairs:

### A. Financial Integrity & Uncertainty Propagation
- **Money Kept Uncertainty Propagation:** When tax jurisdictions lack configured rates or occupied room nights are missing, tax calculations fail closed with `incomplete: true`. Downstream, `Money Kept` explicitly qualifies the headline and line items as `(Partial Estimate)`, never misrepresenting partial numbers as complete net profit.
- **Deduction & Tax Preservation:** Known deductions (OTA commissions, credit card fees, operating expenses, and known percentage taxes) are strictly preserved using exact integer-cents arithmetic (`toCents`/`fromCents`); known financial totals continue using exact integer cents.
- **Pass-Through Tax Truth:** Pass-through taxes collected on behalf of municipalities remain deductions from gross revenue and are never inflated as owner's kept funds.
- **Simplified Line Item Qualification:** Tax line items are qualified once (`Business Taxes (partial estimate)` or `Business Taxes (incomplete · unknown)`), avoiding duplicate qualification tags and redundant inline badges.
- **Loss Warning:** The deductions-exceed-gross message appears only when money kept is negative. Empty and break-even periods do not display a loss warning; the underlying financial totals are unchanged.
- **Owner Performance Packet Export:** XLSX exports reflect identical data provenance; Executive Summary and Sheet 5 explicitly stamp `PARTIAL / TAX INCOMPLETE` warnings when partial analytical periods are selected.

### B. Operational Scope & Ledger Isolation
- **RoomBoard Independent Querying:** Room stays and housekeeping tasks query strictly against `boardDate`. Multi-day stays overlapping `boardDate` (checked in prior, checking out after) are fully preserved. Loading states gate rendering to prevent false vacant room indicators.
- **Active Property Filtering:** Global filters (`useGlobalFilters`) filter out inactive properties (`p.active !== false`) across dashboards, property pickers, and comparisons, while keeping Settings unfiltered for property management.
- **Empty Property Selection:** Local Payroll, Expenses, and Forecasting queries return no rows when no properties are selected. Synthetic owner/restricted query tests preserve single, nonempty, and date-filter behavior; normal browser acceptance remains pending.
- **Zero-Selection Guard:** Portfolio view passes an explicit array of active property IDs (`activePortfolioIds`), never the unscoped `"all"` sentinel, preventing inactive property data leakage.
- **Fail-Closed Portfolio Aggregates:** Daily financial aggregate cache (`useDailyFinancialAggregates`) is restricted to single properties (`typeof propertyId === 'string' && propertyId !== 'all'`). Multi-property or portfolio requests safely bypass cached aggregates and compute from raw authoritative ledgers to prevent partial cache totals.
- **Worker Aggregate Availability:** When both supported aggregate tables are absent or empty, the aggregate read returns an explicit unavailable result with empty summaries. The client uses raw ledgers unless it has nonempty, complete, current summaries for the selected property. Unexpected storage errors remain errors.

### C. Frontend Engine & Security Hardening
- **Tailwind CSS v4 & LightningCSS:** Updated to `tailwindcss@4.3.3` with `@tailwindcss/postcss@4.3.3`. The installed candidate passed 68 compatibility checks in headless Chromium. Focus PNGs for the covered fixtures were byte-identical (1719B); raw shadow strings differ because v4 adds transparent layers. This evidence does not establish parity for every page or browser.
- **PDF Export:** The pinned `html2canvas-pro@2.5.0` renderer resolves the observed unsupported `oklab` failure. Normal synthetic downloads parse and render populated pages. Numeric figures now disable ellipsis only in the export clone; known populated figures pass independent page-one pixel review; larger-value and full-page visual checks remain pending. This is not production acceptance.
- **Dependency Security Clean:** Upgraded `dompurify` to `3.4.16` (deduplicated across dependencies including `jspdf`). Vulnerable braces dependency removed from the dependency tree. `npm run audit:gate` passes with 0 advisories (`ACCEPTED = {}` unchanged).

---

## 2. Standard Automated Verification Commands

Run these exact commands to verify system integrity:

```bash
# 1. DIVYESH V3 Canonical Governance Check
npm run verify:v3

# 2. Dependency Security Audit Gate (0 high / 0 critical)
npm run audit:gate

# 3. Financial Completeness & Uncertainty Propagation Probe (48 asserts)
node --import ./scripts/_loader-boot.mjs scripts/probe-money-kept-tax-completeness.mjs

# 4. Operational RoomBoard & Global Filters Probe (22 asserts)
node --import ./scripts/_loader-boot.mjs scripts/probe-roomboard-filters-aggregates.mjs

# 5. Worker Aggregate Availability & Storage Probe (11 scenario groups with nested assertions)
node --import ./scripts/_loader-boot.mjs scripts/probe-worker-aggregate-availability.mjs

# 6. Core Financial & Model Unit Suites
npx vitest run src/lib/moneyKeptModel.test.js src/lib/taxLiability.test.js
```

---

## 3. Owner Configuration & Truth Contracts

Before reviewing live numbers in the web application, ensure property configurations are reviewed:

1. **Property tax configuration (`/settings`):**
   - Verify each property has active tax rules for State, City/Local, and Flat fees with effective start dates.
   - For flat-per-night fees, occupied room night data must be present; otherwise, calculations mark taxes as `partial estimate`.
2. **Channel Commission Rates (`/channel-manager`):**
   - Confirm OTA commission percentages and credit card processing fee rates match actual merchant processor agreements.
3. **Property roster (`/settings`):**
   - Ensure inactive properties are marked `Active: false`. Inactive properties are omitted from dashboard summaries and portfolio aggregates.

---

## 4. Actionable Browser Operational Steps

### Flow 1: Import and review HotelKey data
1. Open **Import** (`/upload`) and select the intended property.
2. Upload a supported HotelKey report, such as Hotel Statistics or Source Summary.
3. Review validation results and any overlap or replacement warning before confirming an import.
4. Review the import result and resolve reported errors before relying on the dashboard totals.

### Flow 2: Review room activity
1. Open **Room Board** (`/rooms`) and select the property and board date.
2. Wait for loading to finish before interpreting vacancy.
3. Check overnight stays against the selected date and review the displayed housekeeping statuses.

### Flow 3: Review financial estimates
1. Open **Dashboard** (`/`, with `/dashboard` as an alias) and select the property and reporting period.
2. Review Estimated Money Kept and its deduction breakdown.
3. When tax configuration or room-night evidence is incomplete, retain the partial or unknown qualification and resolve the missing inputs before treating the estimate as complete.

### Flow 4: Review payroll
1. Open **Payroll** (`/payroll`).
2. Reconcile the recorded payroll for the reporting period before relying on payroll deductions in the financial review.

### Flow 5: Export the owner packet
1. On Dashboard, select the intended property and reporting period.
2. Click **Export Owner Packet (.xlsx)**.
3. Open the workbook and compare its Executive Summary with the dashboard for the same selection.
4. Review the data provenance and completeness notices. Incomplete tax evidence must remain qualified in the export.

---

## 5. Deployment, Database & Migration Status

### Live Production Context (Root Sealed Metadata)
- **Production Base Git Commit:** `b3a8aa421e2ab8bec3d03cb440e2a44ea12cd077`
- **Current Active Deployment Version (100% Traffic):** `d11352f9`
- **Known Rollback Deployment Target:** `2fbd2cd4` (source commit: `b1512a23ad39024c930f9e3a6f03618b157946b7`)
- *Notice:* Full deployment version hashes are managed externally by the release controller; do not run deployment commands with truncated IDs.

### Database D1 Ledger Status
- **Active Production Ledger:** Migrations `0001` through `0007` are currently active.
- **Pending Migrations:** Migrations `0008` and `0009` are pending owner approval (separate from authenticated owner UI acceptance) and absent from the production migration ledger.
- **Live DDL Warning:** **NO LIVE DDL HAS RUN.** Migrations `0008` and `0009` require explicit written owner approval prior to execution; the current status is `DRAFT` and not ready until final gates pass and owner acceptance is completed.
- **Additive Schema Rollback Invariant:** If code or traffic rollback is initiated, additive DB schemas remain forward-compatible. Rolling back code/traffic reverts Worker routes and UI assets, but does NOT drop tables or user data. Database migration operations remain separate manual actions.

### Authentication & Acceptance Gate Boundary
- **Public Credential-Free Routes:** Public edge routes and 401 unauthenticated challenge probes pass root verification.
- **Authenticated Owner Routes:** End-to-end authenticated owner browser routes remain **UNPROVEN** in production until the owner performs live authenticated manual sign-in and acceptance.

---

## 6. Forthcoming Release Matrix
Verified repair candidate, 2026-10-03:

| Gate | Result | Scope |
| --- | --- | --- |
| Standard Vitest | PASS: 98 files, 835 tests | Frozen repair source |
| Typecheck / lint / production build | PASS | Repository commands |
| Brain / repository map / V3 | PASS | Staged task changes |
| Dependency audit | PASS: zero advisories | No accepted exceptions added |
| Financial / operations / aggregate / authorization probes | PASS in documented scopes | Synthetic fixtures and actual handlers; not production owner acceptance |
| Normal PDF / workbook | PASS for the recorded two-property case | Eight PDF pages reviewed; workbook reconciles 2,452,500 cents with completeness warnings |
| Route body coverage | 27 PASS, 9 NOT_RUN | Local synthetic normal-auth fixture; historical render and redirect evidence distinguished |
| Primary browser actions | 2 PASS, 105 NOT_RUN | PDF/XLSX actions proven; remaining actions require actual interaction evidence |
| Production owner acceptance | NOT_RUN | No production authenticated owner acceptance claimed |

The candidate is not an owner-ready declaration. Larger-number PDF rendering, outstanding browser routes/actions, private-fixture checks and production acceptance remain separate open gates. The broad mutation sweep passed the earlier candidate snapshot; it is not a full mutation claim for the added warning, empty-selection and PDF callback changes. Their focused regressions and the final standard suite pass.
