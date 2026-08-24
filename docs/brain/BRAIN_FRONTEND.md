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
| **MonthlyCalendar** | `src/pages/MonthlyCalendar.jsx` | Heatmap calendar: daily occupancy + revenue tiers | `calendarGrids.js`, `revenueThresholds.js`, `hotel.js` |

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
| **ActionCenter** | `src/pages/ActionCenter.jsx` | Automated alerts: Fix Today / Investigate / Opportunity, plus the next 5 event days | `actionCenter.js`, `eventSchedule.js`, `hotel.js`, `useHotelData.js` |
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
| `deleteGuard.js` | Safe deletion pipeline: Dependent-disclosure -> Confirm -> Rate-Limit -> CSRF check. `dependents` puts the count and money value of the records that will *survive* into the dialog | Accidental mass deletion possible; operator cannot tell what a delete keeps. |
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
| `calendarGrids.js` | Decides WHICH months a calendar page draws, from the same `dateRange` the KPIs aggregate. `calendarMonths()`, `monthsInRange()`, `daysInMonth()`, `MAX_GRIDS` | MonthlyCalendar's header, grid count and KPIs stop agreeing. See section 16. |
| `dbArchive.js` | Whole-database backup and restore across all three storage layers | Owner loses the only off-device copy of the data. See section 7.6. |
| `sdkAnalyticsOff.js` | Mutates the shared SDK config in place to stop the vendor analytics beacon | The live console fills with `405` on `analytics/track/batch`. |

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


# 7. GETTING DATA OUT (Owner-facing export + fast filters)

> [!IMPORTANT]
> `src/lib/exportData.js` is the **only** download implementation in the app. There is
> no second one. `hotel.js#downloadCsv` and `hotel.js#downloadExcel` were deleted on
> 2026-08-20 once the last page migrated — do not reintroduce them, and do not add a
> per-page CSV writer. Two implementations of a download cannot be kept in agreement
> by review: the negative-number guard fix and the Excel column spec would each have
> had to be applied twice.

## 7.1 The five export surfaces

| Page | Rows exported | Column spec |
|------|---------------|-------------|
| `AuditLog.jsx` | Filtered + sorted audit rows | `AUDIT_EXPORT_COLUMNS` (`auditView.js`) — 19 columns covering all 13 fields the writers persist |
| `Transactions.jsx` | `visible` (the filtered ledger) | `TRANSACTION_EXPORT_COLUMNS` — 13 columns, owner-facing labels |
| `Statistics.jsx` | The snapshot rows | `STATISTICS_EXPORT_COLUMNS` — includes `original_value` as "As imported" |
| `ManualEntry.jsx` | The spreadsheet grid | Derived from `config.fields`, so headers match the on-screen grid |
| `ChartBuilder.jsx` | The aggregated groups | Derived from the table header expressions `{g}` and `` `${agg} (${v})` `` |

Every one is `(isExcel ? downloadExcel : downloadCsv)(rows, { filename, columns, sheetName })`.
Both return the row count and both **throw** on an empty set.

There is a sixth download — the whole-database archive in `dbArchive.js` (section 7.6) —
which is deliberately **not** in the table above. These five export a *filtered, columnar
view for a human to read*; the archive serialises *raw storage for a machine to restore*.
Giving the archive a column spec would silently drop any field not named in it, which is
defect 1 below reintroduced at the one place it would be unrecoverable.

## 7.2 The contract, and the four defects it closes

```js
downloadCsv(rows, { filename, columns, bom = true })   // -> row count, throws if empty
downloadExcel(rows, { filename, columns, sheetName })  // -> row count, throws if empty
buildCsv(rows, { columns, bom })                       // pure, testable
buildSheetRows(rows, { columns })                      // pure, testable
```

1. **Silent column loss.** `Object.keys(rows[0])` decided the columns for the whole
   file. Audit, transaction and payroll rows are heterogeneous — `device` is absent on
   server-side events, `employee_id` on non-payroll charges. If row 0 lacked a field,
   that column vanished for every row that had it, with no error and no count. An
   export that quietly drops a column is worse than one that fails, because the
   recipient reconciles against it.
2. **Silent empty export.** A filter matching nothing produced a header-only download
   and no message — indistinguishable from a browser blocking the download. Both
   functions now throw, and every call site reports through that page's existing
   feedback channel (`toast`, or `setSaveMsg`/`setMsgTone` on ManualEntry).
3. **No UTF-8 BOM, LF endings.** Excel on Windows read a BOM-less UTF-8 CSV as the
   local ANSI code page, so "Nuñez" arrived as "NuÃ±ez". Now BOM + CRLF per RFC 4180.
4. **Blob URL revoked on the same tick as `.click()`**, racing the browser's own fetch
   of that URL, and an anchor never attached to the document.

## 7.3 The formula-injection guard, and the bug the guard itself caused

Cells beginning `= + - @ tab CR` are prefixed with `'` via
`securityUtils.js#neutralizeFormula`, so a payload like `-2+3+cmd|' /C calc'!A0`
imported from a hostile CSV cannot execute when the owner opens the export.

> [!CAUTION]
> Applied naively, that rule prefixes **every negative amount**. `-25.50` exported as
> the text `'-25.50`, and a refund column of text cannot be summed — silently, with no
> error, in a file an accountant reconciles against. This defect was introduced and
> caught inside the same session.

The fix is an exemption for values that are plain decimal numbers:

```js
const NUMERIC_TEXT = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const guarded = NUMERIC_TEXT.test(raw) ? raw : neutralizeFormula(raw);
```

> [!TIP]
> **BEST OUTCOME NOTE.** No formula or DDE payload is *also* a valid plain decimal, so
> the exemption gives up nothing. The alternative — a list of "numeric columns" to skip
> — would need updating every time a column is added, and would fail silently when
> someone forgot. This rule needs no list to keep in sync. Verified both directions in
> `probe-export-data.mjs` §4b: `-25.5`, `-1234.56`, `-1.2e3`, `.5` pass through as
> numbers; `-2+3`, `- 1`, `+1`, `-1,000`, `-$5`, `=-1` are all still guarded.

In Excel the same rule keeps numbers as **numbers**: `excelCell` coerces numeric text
with `Number()` so the cell is right-aligned and summable, rather than a text cell that
looks like a number.

## 7.4 Fast filters: what the owner does not have to redo

`exportData.js` also owns the date-filter layer, because a filter and an export of that
filter must agree about what "this month" means.

- `QUICK_RANGES` / `resolveQuickRange` — Today, Yesterday, This week, This month, Last
  month, This quarter, YTD, Last 7/30/90 days.
- `readStoredFilters` / `writeStoredFilters` / `clearStoredFilters` — the dashboard
  reopens where the owner left it.
- `describeRange` — the active range is rendered next to the total, so **a subtotal is
  never read as a total**. Covered by `probe-export-data.mjs` §8.
- `countUndated` — rows with no date are counted and shown, not dropped. A date filter
  that silently discards undated rows makes the total disagree with the unfiltered view
  for a reason the owner cannot see.

> [!WARNING]
> **Every date here derives from LOCAL calendar parts, never `toISOString()`.** The
> repo's timezone is America/New_York, so `new Date().toISOString().slice(0,10)`
> returns **tomorrow's** date after 8pm — a "Today" filter that hides the evening
> shift's own events, precisely when a night-audit clerk is looking at them.
>
> Same trap, different symptom: `new Date("YYYY-MM-DD")` parses as **UTC midnight**, so
> formatting it locally names the **previous** day. Use `hotel.js#formatDayLabel` for
> any date-only string; never construct a `Date` from one to make a label.

## 7.5 Bundle note

Deleting `downloadExcel` from `hotel.js` also removed `import * as XLSX` from it. `xlsx`
is the largest dependency in the bundle and `hotel.js` is imported by nearly every
page, so it was being pulled into almost every route. It now loads only with the export
module that uses it.

## 7.6 The whole-database archive — the only backup that exists

Added 2026-08-24: `src/lib/dbArchive.js`, a "Backup & restore" card in `Settings.jsx`, and
a shared `downloadBlob()` lifted into `exportData.js`. Proved by
`scripts/probe-db-archive.mjs` (216 assertions, 9 sections). No protected file was touched.

The entire hotel database lives only in this browser's IndexedDB. Clearing site data
destroyed everything, with no recovery path of any kind. This card is the whole recovery
story — treat it accordingly.

> [!CAUTION]
> **A backup that only walks Dexie loses real money configuration.** The archive carries
> **three** layers, and the third is the one every reasonable implementation forgets:
> `stores` (Dexie tables), `secure_slots` (decrypted `secureStore` values), and
> `local_slots` (plain `localStorage` strings). Hand-entered money settings live in
> *plain* localStorage — `rri_commission_rates_v2`, `rri_cc_fee_rate`,
> `rri_cc_fee_refunds_v1`, `rri_tax_config_v1`, `rri_tax_settings_v1`,
> `rri_alert_thresholds`, `rri_revenue_thresholds`, `rri_pricing_config`,
> `rri_weather_config`, `rri_housekeeping_config_<propId>`, `rri_filters_<page>`,
> `rri_automationRules`, `rri_reportHistory` — plus `manual_draft_<propId>_<reportType>`,
> which carries **no `rri_` prefix at all**. `LOCAL_SLOT_PREFIXES` must keep both
> prefixes. Dropping this layer produces 8 probe FAILs naming every lost setting.

**Encrypted slots travel DECRYPTED, on purpose.** `getOrGenerateCryptoKey()` creates a
**non-extractable** AES-GCM key in a separate IndexedDB, so ciphertext copied to another
machine can never be opened again — a backup of `rri_enc_*` blobs is not a backup. Only
`rri_import_sessions` is a secure slot worth carrying (`SECURE_SLOT_KEYS`), and the probe
asserts the literal string `rri_enc_` never appears in the archive. Three keys can never
be found by a localStorage prefix scan and must be named explicitly if ever needed:
`rr_local_session` and `rri_rate_limits_v1` are `secureStore` slots (persisted as
`rri_enc_*`), and `rri_csrf_token` lives in **sessionStorage**.

**Restore invariants.**

- All 29 archived stores have **inbound** primary keys (28× `++id`, `IdSequence` on
  `prefix`). That is what lets one uniform `bulkPut(rows)` preserve ids and every
  cross-store reference. §3 asserts `schema.primKey.keyPath !== null` for every store; an
  outbound key reads as `null`.
- `LocalSession` and `PasswordResetRequest` are excluded deliberately — they are
  credentials, not data.
- Restore is **ONE** `localDb.transaction("rw", ...)` doing clear + bulkPut across all
  stores, so a partial failure rolls back whole. Per-store transactions instead of one
  produces a probe FAIL reading `Property: length 2 vs 1` — a half-failed restore that had
  already destroyed a row. localStorage and secureStore writes happen only **after** the
  Dexie commit, because a non-Dexie `await` inside the transaction breaks the zone.
- **The audit entry for a restore is written AFTER the restore**, not before. The AuditLog
  table has just been replaced by the backup's rows, so an entry written first is erased by
  the very action it records. A byte-faithful restore keeps `verifyAuditChain()` green
  because the chain tip is read from the table itself.

**Known characteristic, not a defect:** `serializeArchive` uses
`JSON.stringify(archive, null, 2)`, so 40k–100k transaction rows produce tens of MB,
roughly doubled by the indentation (cap 300 MB). The indentation is deliberate — opening
the file in a text editor is a legitimate recovery path.

> [!WARNING]
> `src/lib/uploadGuard.js`'s `ALLOWED_EXT = /\.(csv|xlsx|xls)$/i` must **NOT** be widened
> to admit `.json` to make restore work. The archive file input is its own
> `<input accept>` and never passes through the upload gate. §9 asserts this.

---

# 16. PAGE PERIOD COHERENCE (a page must describe the span it measures)

Added 2026-08-24 after `MonthlyCalendar.jsx` was found describing one month while its KPIs
measured 214 days. This section exists because the defect is a *class*, not an incident:
any page that renders both a period **label** and period **KPIs** can drift apart, and the
drift is invisible in code review because each half is correct on its own.

## 16.1 The rule

**Derive the label from the same source the KPIs aggregate.** The KPIs aggregate
`dateRange`. Therefore the header, the grid count, the card titles and the empty-state
notice must all derive from `dateRange` too — never from `month`/`year` alone.

`src/lib/calendarGrids.js` is that derivation for calendar pages:

```js
calendarMonths({ period, months, year, dateRange })  // -> [{ year, month }, ...] UNCAPPED
monthsInRange(from, to)                              // every {year, month} an ISO range touches
daysInMonth(year, month)                             // numeric construction, no string parsing
MAX_GRIDS = 24                                       // render cap; surplus must be STATED
```

The old inline expression was:

```js
const isMultiMonth = period === "monthly" && months.length > 1;
```

false for ytd, yearly, quarterly, weekly, daily **and** custom — so six of seven periods
drew exactly ONE grid. The live site showed a header reading "for August 2026" above one
August grid, over KPI cards summing all 214 imported days. YTD now draws 8 grids, not 1.

## 16.2 Two traps inside that derivation

**The year must travel with the month.** A weekly or custom range straddles a year
boundary. The old single `calYear` made Dec 2025 – Jan 2026 render as two grids *both*
titled 2026, and `key={grid.month}` collided between them. The probe asserts `calYear`
never returns.

**`monthly` is the ONE period where `months[]` stays authoritative over the range.**
`computeRangeFromMonths()` in `useGlobalFilters.jsx` turns a non-contiguous pick
(April + July) into a **contiguous** range (Apr 1 – Jul 31), while the row filter keeps
only the picked months. Deriving grids from the range there would draw empty May and June
grids the owner never selected — mutation-tested: removing that branch yields 4 grids
instead of 2.

## 16.3 Never cap silently

Rendering is capped at `MAX_GRIDS` and the surplus is reported in an amber notice. A
silent cap recreates the original defect exactly: a page showing fewer months than it
measures.

## 16.4 The non-calendar pattern

`Expenses.jsx:118` is the correct shape for a page with no grid: picked month names when
`period === "monthly"`, otherwise the raw `from → to`. Copy that, not the old calendar.

## 16.5 Three numbers, three measures, one page

The same fix closed a second defect worth generalising. Calendar cells were coloured by
`room_revenue` against the thresholds the card subtitle prints, but `getRevenueGroup()`
classified by `total_revenue` and the day modal displayed it. **The CSV importer never
writes `total_revenue`** (0 of 214 parsed rows — see BRAIN_FINANCE.md 12.8), so every
imported day was grouped "low" while its cell was painted green, and tapping a $12,000
cell opened a panel reading $0.00.

> [!TIP]
> **BEST OUTCOME NOTE.** When a page shows a value three ways — a colour, a KPI and a
> detail panel — assert that all three read the **same field**, not merely that each one
> renders. All three were individually "working". Proved by
> `scripts/probe-monthly-calendar.mjs` (67 assertions, 6 sections); reproduction measured
> **53 PASS / 11 FAIL** against the unedited page before any fix was written.

The KPI is now labelled **"Total Room Revenue"** precisely so nobody compares it against
the Dashboard's $1,020,598.17 ledger total. The $9,339.50 difference is real ancillary
income, not a bug — BRAIN_FINANCE.md 12.6.

## 16.6 The same two defects, on a second page

`MtdGrowth.jsx` carried both failure modes 16.5 describes, independently discovered
(tracker #45, #46 — full write-up in BRAIN_TROUBLESHOOTING.md 27).

Its headline card was keyed on the same never-written `total_revenue`, so it read **$0** and
the Owner's Snapshot narrated *"Revenue is up 0.0% to $0"* in prose. And it violated 16.1
in the comparison direction: the header printed the **full** prior period while the numbers
beneath it were computed over a window truncated to the elapsed day count. Two spans, one
label.

> [!IMPORTANT]
> **A period label is not the only thing that must match the measurement — so must the
> comparison window.** `compareDateRange` is the full prior period by design
> (`computeRange(comparePeriod, compareYear, …)`), so any page comparing "so far this
> period" against it *must* truncate, *and must say so*. The page now derives
> `prevWindow` and prints that in both places a range is shown.

The truncation itself was the bug that mattered. It was computed as
`prevToDate.setDate(prevFrom.getDate() + elapsedDays - 1)` — a UTC-midnight parse read
through local calendar accessors — which lost a day in the owner's zone and **inflated
every growth percentage on the page**. Date arithmetic on a `"YYYY-MM-DD"` key now goes
through `hotel.js#isoEpochDay` / `#epochDayToIso`, which are built on `Date.UTC` and never
consult the host calendar. `formatDayLabel` in the same file defuses the identical trap on
the display side.

> [!CAUTION]
> **Do not reimplement either helper with a local accessor**, and do not trust a green
> suite here: the defective expression is wrong in **2 of 8** probed windows under
> `America/New_York` and wrong in **0 of 8** under `TZ=UTC`, so a UTC run exonerates it
> completely. Every CI runner is UTC; an agent sandbox inherits `TZ` from its host and can
> be either (BRAIN_TROUBLESHOOTING.md 27.2). `scripts/probe-mtd-growth.mjs` pins the zone
> on its first executable line so the verdict does not depend on where it ran.

---
