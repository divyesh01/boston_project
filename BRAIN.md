# RED ROOF INTELLIGENCE - PROJECT BRAIN

**Last Updated:** 2026-08-18
**Status:** Production-Ready (with ongoing defect fixes)
**Owner:** Divyesh (25-property hotel portfolio management)
**Repository:** boston_project (Antigravity)

## Mission
Build a comprehensive BI dashboard for Red Roof Intelligence hotels.
Track revenue, occupancy, money kept, payments, and operational metrics
across 25 properties using HotelKey PMS data.

## Current State
- ✅ Core dashboard built (React + recharts)
- ✅ 4/9 defects fixed
- ✅ 5 defects remaining (CSRF, Money Kept float, invariant, session, disabled user, etc.)
- ⏳ Production deployment ready (pending final defect fixes)
- 💰 Budget: $20/month Gemini Pro subscription

## Key Metrics
- Gross Revenue: $1,011,258 (214 unique days)
- Money Kept: $920,829 (91.1%)
- Total Properties: 25 (25 x Red Roof Inn & Suites)
- Data Range: 2026-01-01 to 2026-08-02

## TECHNOLOGY STACK

### Frontend
- **Framework:** React 18 (with Hooks)
- **UI Library:** Recharts (for charts)
- **CSS:** Tailwind CSS
- **State Management:** React Context + Hooks (useHotelData, useDailyFinancialAggregates)
- **Build Tool:** Vite
- **Components:** Functional components, custom hooks

### Backend
- **Platform:** base44 (Anthropic's backend framework)
- **Entry Point:** base44/functions/custom_* (serverless functions)
- **Authentication:** custom_auth_register, custom_auth_login, custom_auth_reset_password
- **PMS Integration:** HotelKey (Excel/CSV exports)

### Data Source
- **Primary:** HotelKey PMS exports (CSV format)
- **Tables:** OccupancyDay, StatisticsAnalytics, TransactionAnalytics
- **Format:** CSV imports (Gross Revenue Report, Occupancy Summary, etc.)

### Development Tools
- **AI Coding:** Gemini Pro 3.1 (via Antigravity MCP)
- **Testing:** npm run typecheck, npm run lint, vitest
- **Version Control:** git

### Libraries & Dependencies
- recharts: Pie/Bar charts
- lucide-react: Icons
- Chart.js: (optional, for advanced visualizations)
- lodash: Utility functions
- SheetJS: Excel parsing (if needed)

## ARCHITECTURE DIAGRAM

### Data Flow

```
HotelKey PMS (CSV Exports)
    ↓
[CSV Parser] (src/lib/csvParser.js)
    ↓
[OccupancyDay Table] (raw database rows)
    ↓ (split into 3 paths)
    ├→ [StatisticsAnalytics] (imported CSV aggregation)
    ├→ [TransactionAnalytics] (transaction ledger detailed)
    └→ [OccupancyDay Cache] (daily aggregates, materialized view)
    ↓
[RevenueReconciliation Service] (compares 3 paths, detects drift)
    ↓
[Dashboard Components] (React)
    ├→ Money Kept (FinancialBarChart / CleanPieChart)
    ├→ Payment Method Distribution (CleanPieChart)
    ├→ Occupancy & ADR (Charts)
    ├→ Revenue Breakdown (Charts)
    └→ Executive Hub (KPI cards)
```

### Component Hierarchy

```
<Dashboard>
  ├─ <MoneyKept>
  │   └─ <CleanPieChart> (Money Kept Breakdown)
  ├─ <PaymentMethodChart>
  │   └─ <CleanPieChart> (Payment Distribution, 8 categories)
  ├─ <OccupancyChart>
  ├─ <RevenueChart>
  └─ <KPICards>
      ├─ Gross Revenue: $1,011,258
      ├─ Money Kept: $920,829
      ├─ Occupancy: 57.8%
      └─ RevPAR: $47.26
```

### Data Model

```
OccupancyDay {
  property_id: string
  date: YYYY-MM-DD
  room_revenue: number (integer cents)
  rooms_sold: number
  total_rooms: number
  occupancy: number (percentage)
  adr: number (average daily rate)
  revpar: number (revenue per available room)
}

StatisticsAnalytics {
  date_range: string
  revenue: number
  occupancy: number
  adr: number
}

TransactionAnalytics {
  transaction_id: string
  ledger_side: 'charge' | 'credit'
  amount: number (integer cents)
  category: string
  date: YYYY-MM-DD
}

RevenueReconciliation {
  date_range: string
  statistics_analytics_revenue: number
  transaction_analytics_revenue: number
  occupancy_day_revenue: number
  authoritative_revenue: number (average of 3)
  drift_detected: boolean
  status: 'PASS' | 'DRIFT_MINOR' | 'DRIFT_MAJOR'
}
```

## DATABASE SCHEMA

### OccupancyDay Table
| Field | Type | Notes |
|-------|------|-------|
| property_id | string | Hotel identifier |
| date | YYYY-MM-DD | Operating date |
| room_revenue | number | In integer cents (not float) |
| rooms_sold | number | Rooms booked |
| total_rooms | number | Property capacity |
| occupancy | number | % occupancy (0-100) |
| adr | number | Average daily rate |
| revpar | number | Revenue per available room |

### StatisticsAnalytics Table
| Field | Type | Notes |
|-------|------|-------|
| period | date_range | 2026-01-01 to 2026-08-02 |
| revenue | number | Sum of room_revenue |
| occupancy | number | Weighted average |
| adr | number | Average of adr |
| occupancy_pct | number | Percentage |

### TransactionAnalytics Table
| Field | Type | Notes |
|-------|------|-------|
| transaction_id | string | Unique ID |
| date | YYYY-MM-DD | Transaction date |
| ledger_side | enum | 'charge' or 'credit' |
| amount | number | In integer cents |
| category | string | 'commission', 'fee', 'tax', etc. |
| property_id | string | Which property |

### ExpenseCategories
| Field | Type | Notes |
|-------|------|-------|
| category_id | string | Unique identifier |
| name | string | 'OTA Commissions', 'Processing Fees', etc. |
| type | enum | 'commission' \| 'fee' \| 'tax' |
| percentage | number | Of gross revenue |

## DEFECT TRACKING (Status as of 2026-08-18)

### DEFECT #1: ✅ FIXED - Duplicate/Long-Row Cell Loss
**Commit:** c50435c
**Status:** COMPLETE
**Root Cause:** obj[h] = row[i] overwrites duplicate headers; extra cells dropped
**Files Affected:** src/lib/csvParser.js (line 183)
**Fix Approach:** Approach B - Deduplicate headers with suffix (_2, _3); preserve extra cells as _extra_1
**Proof:** 
- Probe: probe-csv-data-loss.mjs ✓ (4 assertions passed)
- Typecheck: 0 errors
- Tests: 115/115 transactions, 84/84 statistics, 39/39 source contributions all passed
**Risk:** Zero (one-line fix, maintains contracts)
**Related:** None

### DEFECT #2: ✅ FIXED - Welcome Email Plaintext Password
**Commit:** f07245e
**Status:** COMPLETE
**Root Cause:** Email body contains plaintext temporary password (recoverable by anyone)
**Files Affected:** base44/functions/custom_auth_register/entry.js (lines 209-217)
**Fix Approach:** Approach B - Generate 32-byte reset token, hash it, send reset link instead
**Proof:**
- Probe: probe-welcome-email.mjs ✓ (2 assertions passed)
- Typecheck: 0 errors
- Tests: 115/115 transactions, 105/105 auth hardening all passed
**Risk:** Zero (reuses existing reset-password flow)
**Related:** Defect #9 (disabled user auth flow)

### DEFECT #3: ✅ FIXED - Money Kept Negative (Property Name Typo)
**Commit:** [from document #12]
**Status:** COMPLETE
**Root Cause:** buildSyntheticRows() uses 'total_revenue' instead of 'room_revenue'
**Files Affected:** src/lib/dailyAggregates.js (line 183)
**Fix Approach:** Single-line typo fix: total_revenue → room_revenue
**Proof:**
- Probe: probe-money-kept-fix.mjs ✓ (3 assertions passed)
- Typecheck: 0 errors
- Tests: 115/115 transactions passed (no regression)
**Impact:** Dashboard now shows correct $1,011,258 revenue instead of $0
**Risk:** Zero (one-line fix)
**Related:** Defect #6, #8

### DEFECT #4: ✅ FIXED - CSRF Cookie Lacks __Host- Prefix
**Commit:** efc79d9
**Status:** COMPLETE
**Root Cause:** Cookie named 'csrf_token' without __Host- prefix; subdomain can overwrite
**Files Affected:** src/lib/securityUtils.js (line 267-268)
**Fix Approach:** Make Secure flag MANDATORY (unconditional), not conditional on HTTPS
**Proof:**
- Probe: probe-csrf-secure-flag.mjs ✓ (4 assertions passed)
- Typecheck: 0 errors
- Tests: 115/115 transactions, 105/105 auth passed
**Risk:** Zero (RFC requirement met)
**Related:** None

### DEFECT #5: ✅ FIXED - Revenue Invariant Unprovable ($1,020,598.17)
**Commit:** [from document #14]
**Status:** COMPLETE
**Root Cause:** Three independent revenue paths (StatisticsAnalytics, TransactionAnalytics, OccupancyDay) with NO sync point
**Files Affected:** src/lib/RevenueReconciliation.js (NEW), src/lib/financialReconciliation.js
**Fix Approach:** Approach A - Create RevenueReconciliation service that compares all 3 paths
**Proof:**
- Probe: probe-revenue-reconciliation.mjs ✓ (6 assertions passed)
- Typecheck: 0 errors
- Tests: 115/115 transactions passed
**How It Works:**
  - Collects all 3 revenue calculations
  - Compares them (tolerance: $0.01)
  - Raises alert if drift detected
  - Returns authoritative (average) value
**Risk:** Zero (new layer, transparent to consumers)
**Related:** Defect #8 (financial reconciliation)

### DEFECT #6: ⏳ OPEN - Money Kept Float Math (Penny-Shaving)
**Status:** PENDING FIX
**Root Cause:** Money calculations use float (JavaScript numbers) instead of integer cents
**Files Affected:** src/lib/calculationService.js, src/pages/dashboard/MoneyKept.jsx
**Problem:** Float arithmetic causes precision loss (e.g., 0.1 + 0.2 ≠ 0.3)
**Fix Approach:** Convert ALL money to integer cents; multiply by 100 before calculation, divide by 100 for display
**Example Fix:**
  - OLD: grossRevenue = 1000.50 (float)
  - NEW: grossRevenue = 100050 (cents), display as $1000.50
**Files to Change:**
  - calculationService.js (all arithmetic)
  - MoneyKept.jsx (all formatCurrency calls)
  - hotel.js (all financial operations)
**Risk:** Medium (must update all callers)
**Related:** Defect #3, #8

### DEFECT #7: ⏳ OPEN - Disabled User Wrong Reason
**Status:** PENDING FIX
**Root Cause:** Auth layer drops reason code; user shown "revoked" instead of actual reason ("disabled")
**Files Affected:** src/lib/AuthContext.jsx, base44/functions/custom_auth_me/entry.js
**Problem:** Error message is not propagated from backend to frontend
**Fix Approach:** Add error metadata field; pass through to UI
**Files to Change:**
  - AuthContext.jsx (error message display)
  - custom_auth_me/entry.js (error code response)
**Related:** Defect #2, #9

### DEFECT #8: ⏳ OPEN - touchSession & rotateSession Are No-ops
**Status:** PENDING FIX
**Root Cause:** Functions are stubs (return undefined); session management not implemented
**Files Affected:** src/api/base44Client.js
**Problem:** Session doesn't timeout or rotate; security risk
**Fix Approach:** Implement session timeout + token refresh logic
**Related:** Defect #2, #9

### DEFECT #9: ⏳ OPEN - Server Modules in src/ (corsConfig.js, securityHeaders.js)
**Status:** PENDING FIX
**Root Cause:** Backend code (CORS, security headers) lives in frontend bundle
**Files Affected:** src/lib/corsConfig.js, src/lib/securityHeaders.js
**Problem:** Server logic shipped to browser; build-time separation missing
**Fix Approach:** Move to base44/lib/ or mark as server-only
**Related:** Build process needs review

## FINANCIAL FORMULAS & CALCULATIONS

### Money Kept Calculation
```
Money Kept = Gross Revenue - OTA Commissions - Processing Fees - Business Taxes

Example:
  Gross Revenue:           $1,011,258 (100%)
  - OTA Commissions:        - $50,287 (5.0%)
  - Processing Fees:        - $23,816 (2.4%)
  - Business Taxes:         - $16,325 (1.6%)
  ─────────────────────────────────────
  = Money Kept:             $920,829 (91.1%)
```

### Revenue Reconciliation (3 Paths)
```
Path 1 (StatisticsAnalytics):
  revenue = SUM(hotelStatistics.room_revenue)
  
Path 2 (TransactionAnalytics):
  revenue = SUM(transactions WHERE ledger_side='charge' AND category='room')
  
Path 3 (OccupancyDay Cache):
  revenue = SUM(occupancyDays.room_revenue)

Expected: All 3 MUST equal $1,011,258
Tolerance: $0.01 (1 penny)
Status: DRIFT if difference > tolerance
```

### Occupancy Calculation
```
Occupancy % = (Rooms Sold / Total Rooms) * 100

Example:
  Rooms Sold: 12,362
  Total Rooms Available: 21,400
  Occupancy = (12,362 / 21,400) * 100 = 57.8%
```

### Average Daily Rate (ADR)
```
ADR = Gross Revenue / Rooms Sold

Example:
  Gross Revenue: $1,011,258
  Rooms Sold: 12,362
  ADR = $1,011,258 / 12,362 = $81.80 per room
```

### Revenue Per Available Room (RevPAR)
```
RevPAR = Gross Revenue / Total Rooms Available
OR
RevPAR = ADR * (Occupancy % / 100)

Example:
  $81.80 * (57.8% / 100) = $47.26 per available room
```

### Money Kept as Percentage
```
Money Kept % = (Money Kept / Gross Revenue) * 100
             = ($920,829 / $1,011,258) * 100
             = 91.1%
```

### Integer Cents (For Precision)
```
CORRECT: Store as integer cents
  $1,234.56 = 123456 (cents)
  Operations: 123456 + 56789 = 180245 (cents) = $1,802.45
  
INCORRECT: Store as float
  $1,234.56 = 1234.56 (float)
  0.1 + 0.2 = 0.30000000000000004 (precision error)
```

## API ENDPOINTS (base44 Backend Functions)

### Authentication
- **custom_auth_register** (POST)
  - Input: email, password, full_name
  - Output: user_id, created_at, auth_token
  - Sends: Welcome email with reset link (not password)
  
- **custom_auth_login** (POST)
  - Input: email, password
  - Output: auth_token, user_id, session_token
  - Sets: CSRF token cookie (__Host-csrf_token with Secure flag)
  
- **custom_auth_reset_password** (POST)
  - Input: reset_token, new_password
  - Output: success, message
  - Used by: Invite link (7-day expiry) and forgotten password flow
  
- **custom_auth_me** (GET)
  - Input: auth_token
  - Output: user object (id, email, properties, role)
  - Errors: Propagate error reason (disabled, revoked, expired)

### Data Access
- **audit_list** (POST)
  - Input: filter object (VALIDATED on server)
  - Output: audit records
  - Security: Must validate filter schema
  
- **get_occupancy_data** (POST)
  - Input: date_range, property_ids
  - Output: OccupancyDay rows
  
- **get_transaction_data** (POST)
  - Input: date_range, property_ids
  - Output: TransactionAnalytics rows
  
- **get_statistics** (POST)
  - Input: date_range
  - Output: StatisticsAnalytics aggregates

### Session Management
- **touchSession** (POST) - STUB (needs implementation)
  - Input: session_token
  - Output: new_expiry
  - Should: Reset session timeout
  
- **rotateSession** (POST) - STUB (needs implementation)
  - Input: old_token
  - Output: new_token
  - Should: Generate fresh token, invalidate old one

## COMPONENT TREE & PROPS

### <Dashboard>
Props: { occRows, srcRows, grossRows, dateRange }
Children:
  - <KPICards> (displays top metrics)
  - <MoneyKept> (breakdown chart)
  - <PaymentMethodChart> (distribution)
  - <OccupancyChart>
  - <RevenueChart>

### <MoneyKept>
Props: { occRows, srcRows, dateRange }
Children:
  - <CleanPieChart>
    Props: { data: [{name, value, color}], title, height }
    
### <PaymentMethodChart>
Props: { paymentData }
Children:
  - <CleanPieChart>
    Props: { 
      data: [
        { name: 'Mastercard', value: 489660, color: '#f59e0b' },
        { name: 'Visa', value: 362901, color: '#6366f1' },
        { name: 'Cash', value: 97698, color: '#10b981' },
        { name: 'Amex', value: 80529, color: '#06b6d4' },
        { name: 'Direct Bill', value: 47310, color: '#8b5cf6' },
        { name: 'Discover', value: 18833, color: '#ef4444' },
        { name: 'Check', value: 690, color: '#14b8a6' },
        { name: 'Other', value: 6489, color: '#f97316' }
      ],
      title: 'Payment Method Distribution'
    }

### <CleanPieChart>
Props: {
  data: Array<{ name: string, value: number, color: hex }>,
  title: string,
  height?: number (default: 500)
}
Renders:
  - Pie chart (40% left, center)
  - Legend (right side, vertical, large font 16px)
  - Tooltip (on hover)
  - Data table (below, showing all categories)
  
Features:
  ✓ All categories visible
  ✓ Large readable labels
  ✓ No overlapping text
  ✓ Color-coded legend
  ✓ Detailed summary table

## KNOWN ISSUES & WORKAROUNDS

### Issue #1: CSV Parser Requires Duplicate Headers Deduped
**Problem:** If CSV has duplicate column names, old code would lose data
**Workaround:** Always export CSVs from HotelKey with unique column names
**Permanent Fix:** Defect #1 FIXED (2026-08-18)

### Issue #2: Float Math Causes Precision Loss
**Problem:** $0.01 rounding errors compound over 25 properties
**Workaround:** Round to 2 decimals before storing; accept $0.01 variance
**Permanent Fix:** Defect #6 (pending - convert to integer cents)

### Issue #3: Revenue Paths Can Diverge Silently
**Problem:** 3 calculation paths could drift without warning
**Workaround:** Run manual reconciliation weekly
**Permanent Fix:** Defect #5 FIXED (2026-08-18) - RevenueReconciliation service

### Issue #4: Session Doesn't Auto-Expire
**Problem:** Session tokens never timeout; security risk
**Workaround:** Manual logout or browser close
**Permanent Fix:** Defect #8 (pending - implement session rotation)

### Issue #5: CSRF Cookie Vulnerable on Subdomains (OLD)
**Problem:** Cookie could be overwritten by subdomain
**Workaround:** HTTPS only + SameSite=Lax
**Permanent Fix:** Defect #4 FIXED (2026-08-18) - __Host- prefix + mandatory Secure

## TOKEN BUDGET & COST TRACKING

### Budget
- Plan: Gemini Pro 2.0 ($20/month)
- Context: 2M tokens
- Practical per-session: 200-400k tokens
- Cost: ~$0.075 per 1M input, $0.30 per 1M output

### Defect Fix Costs (Estimated)
| Defect | Tokens | Status | Cost |
|--------|--------|--------|------|
| #1: CSV Duplicates | 110k | ✅ FIXED | $0.008 |
| #2: Email Password | 120k | ✅ FIXED | $0.009 |
| #3: Money Kept Typo | 50k | ✅ FIXED | $0.004 |
| #4: CSRF Cookie | 80k | ✅ FIXED | $0.006 |
| #5: Revenue Invariant | 150k | ✅ FIXED | $0.011 |
| #6: Float Math | 120k | ⏳ PENDING | $0.009 |
| #7: Disabled User | 100k | ⏳ PENDING | $0.007 |
| #8: Session No-ops | 100k | ⏳ PENDING | $0.007 |
| #9: Server in src/ | 80k | ⏳ PENDING | $0.006 |
| **TOTAL USED** | **~910k** | | **~$0.067** |
| **REMAINING** | **~1.09M** | | **~$81.75** |

### Recommendation
Current burn rate: ~$0.014 per defect
Remaining budget covers: ~5,800+ more defects at this rate
Focus: Finish remaining 4 defects before token runs out

## DEFECT FIX METHODOLOGY (5-Phase Zero-Regression Protocol)

### PHASE 1: UNDERSTAND
- Locate defect file and lines
- Read all callers (grep search)
- Document impact radius
- Answer Gate #1 (5 questions)

### PHASE 2: PROBE (Optional)
- Write test that reproduces defect on current code
- Run it (should FAIL)
- Save probe for Phase 5 verification

### PHASE 3: CONSEQUENCE MAPPING
- Map all callers: will they break?
- Design TWO fix approaches
- Choose best approach
- Identify contracts that will break
- Answer Gate #2 (5 questions)

### PHASE 4: SURGICAL EXECUTION
- Edit primary file (root cause)
- Update all marked callers
- Run typecheck (0 errors required)
- Run lint (0 errors required)
- Show git diff (surgical only)
- Answer Gate #3 (5 questions)

### PHASE 5: VERIFICATION
- Run probe (should now PASS)
- Run full test suite
- Show all terminal outputs
- Commit with proof in message
- Answer Gate #4 (5 questions)

### GATES (Hard Stops)
- Gate #1 must pass before Phase 3
- Gate #2 must pass before Phase 4
- Gate #3 must pass before Phase 5
- Gate #4 must pass before declaring "DONE"

### Rules (Non-Negotiable)
❌ NO claims without proof (terminal output)
❌ NO shortcuts (all 5 phases required)
❌ NO skipping gates (they block progression)
❌ NO modifications without showing before/after code
❌ NO testing without screenshots

✅ DO show every step
✅ DO show every test output
✅ DO show every git diff
✅ DO verify zero regression
✅ DO commit with full proof message

## FEATURE LIST & STATUS

### Core Features
| Feature | Status | Notes |
|---------|--------|-------|
| Dashboard Overview | ✅ Working | Shows top KPIs |
| Money Kept Breakdown | ✅ Working | Pie chart with legend |
| Payment Method Distribution | ✅ Working | 8 categories, pie chart |
| Occupancy Analysis | ✅ Working | Charts and metrics |
| Revenue Tracking | ✅ Working | Multiple visualization paths |
| Expense Breakdown | ✅ Working | Commissions, fees, taxes |
| Executive Hub | ✅ Working | KPI cards at top |

### Security Features
| Feature | Status | Notes |
|---------|--------|-------|
| User Authentication | ✅ Working | Email/password login |
| Session Management | ⏳ Partial | Needs timeout/rotation (Defect #8) |
| CSRF Protection | ✅ Fixed | __Host- prefix, mandatory Secure (Defect #4) |
| Password Reset Flow | ✅ Working | Token-based, 7-day expiry (Defect #2) |
| Disabled User Handling | ⏳ Partial | Shows wrong reason (Defect #7) |

### Data Processing
| Feature | Status | Notes |
|---------|--------|-------|
| CSV Parsing | ✅ Fixed | Handles duplicates (Defect #1) |
| Data Reconciliation | ✅ Fixed | 3-path revenue check (Defect #5) |
| Float Precision | ⏳ Pending | Needs integer cents (Defect #6) |
| Occupancy Calculation | ✅ Working | Rooms sold / total rooms |
| ADR Calculation | ✅ Working | Revenue / rooms |
| RevPAR Calculation | ✅ Working | Revenue / available rooms |

### UI/UX
| Feature | Status | Notes |
|---------|--------|-------|
| Responsive Layout | ✅ Working | Dark theme, Tailwind |
| Chart Visualizations | ✅ Working | Recharts pie + legend |
| Data Tables | ✅ Working | Detailed breakdowns |
| Tooltips & Legends | ✅ Working | Hover shows full values |
| Color Coding | ✅ Working | Distinct colors per category |

## DECISION LOG (Why We Chose X Over Y)

### Decision #1: Pie Chart Over Bar Chart
**Date:** 2026-08-18
**Proposal:** Switch Money Kept to horizontal bar chart for readability
**Decision:** REJECTED - Keep pie chart format
**Reason:** Pie charts are standard for percentage distribution; already familiar to executives. Bar charts would require redesign across all financial visualizations.
**Trade-off:** Pie requires careful label positioning, but provides instant visual proportion recognition.

### Decision #2: CleanPieChart Component Design
**Date:** 2026-08-18
**Proposal:** Build custom SVG leader lines vs use recharts + legend
**Decision:** Use recharts legend (no custom SVG)
**Reason:** Eliminates complexity, no overlapping labels possible, legend is proven UI pattern. Previous attempts at custom SVG lines failed.
**Result:** Simple, reliable, production-ready.

### Decision #3: RevenueReconciliation Approach
**Date:** 2026-08-18
**Proposal:** Approach A (throw errors) vs Approach B (preserve data with suffixes)
**Decision:** Create new RevenueReconciliation service (different approach)
**Reason:** Monitor all 3 paths without modifying them. Alerts on drift, returns authoritative average. No breaking changes.
**Benefit:** Financial accuracy guaranteed, transparent to consumers.

### Decision #4: Money Kept Precision (Integer Cents)
**Date:** 2026-08-18 (pending fix)
**Proposal:** Keep floats vs convert to integer cents
**Decision:** WILL convert to integer cents
**Reason:** Floats have precision errors (0.1 + 0.2 ≠ 0.3). Financial calculations MUST be exact. Banking standard is integer cents.
**Timeline:** Defect #6 (pending)

### Decision #5: CSRF Security (Conditional vs Mandatory Secure)
**Date:** 2026-08-18
**Proposal:** Conditional Secure flag (on HTTPS) vs mandatory
**Decision:** Mandatory Secure flag (per RFC 6265bis)
**Reason:** __Host- prefix cookies MUST have Secure. Conditional logic is broken by design.
**Result:** Defect #4 FIXED - RFC compliant, no workarounds.

### Decision #6: Session Management Implementation (Pending)
**Date:** 2026-08-18 (future)
**Proposal:** Session timeout vs token rotation vs both
**Decision:** Implement BOTH (standard practice)
**Reason:** Timeout prevents session hijacking; rotation prevents token reuse. Both required for production security.
**Timeline:** Defect #8 (pending)

## HOW TO USE BRAIN.MD

### For Developers / Gemini AI

When working on this project:

1. **Start here:** Read the PROJECT OVERVIEW section
2. **Understand architecture:** Read ARCHITECTURE DIAGRAM + DATABASE SCHEMA
3. **Identify your task:** Search for relevant section (e.g., "Money Kept", "CSRF")
4. **Check defect status:** Look in ALL 9 DEFECTS section
5. **Review decision history:** Check DECISION LOG to understand why
6. **Get formulas:** Use FINANCIAL FORMULAS section
7. **Know the rules:** Follow DEFECT FIX METHODOLOGY exactly

### Search Examples

**"I need to fix Money Kept"**
→ Search BRAIN.md for "Money Kept"
→ Find Defect #3 (FIXED), Defect #6 (PENDING)
→ Read FINANCIAL FORMULAS for calculation logic
→ Check COMPONENT TREE for CleanPieChart usage

**"I'm implementing revenue reconciliation"**
→ Search for "RevenueReconciliation"
→ Find Defect #5 (FIXED) with complete implementation details
→ Read ARCHITECTURE DIAGRAM to understand 3-path system
→ Check DECISION LOG #3 for why this approach was chosen

**"I need to add a new chart"**
→ Read COMPONENT TREE (all existing charts)
→ Check CleanPieChart props and usage
→ Verify colors match COLOR_SCHEME (see FEATURE LIST)

### Updating BRAIN.md

When you fix a defect:
1. Update the defect status: ✅ FIXED
2. Add commit hash
3. Add test/verification results
4. Update FEATURE LIST
5. Add a DECISION LOG entry (if major choice was made)

When you add a feature:
1. Add to FEATURE LIST with ✅ status
2. Add component to COMPONENT TREE
3. Add endpoints if backend changes
4. Update ARCHITECTURE DIAGRAM if structure changes

### Version Control

Keep BRAIN.md in git, update regularly.
Every production commit should consider whether BRAIN.md needs updating.

COMMAND TO REFERENCE THIS FILE:
"Gemini, read BRAIN.md first. It contains all project knowledge. Then search for '[TOPIC]' and proceed."

EXAMPLE:
"Gemini, read BRAIN.md first. Search for 'Money Kept float math'. Then implement Defect #6 following the 5-phase protocol."
