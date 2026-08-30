# 4. ALL 34 PAGES (What Users See)

## Owner Analyst: grounded financial answers

`src/components/AIAssistant.jsx` is an owner-facing analyst surface in the
standalone deployment. It calls the local `answerQuestion` path; it must never
claim that an external AI model inspected the data. The assistant can explain
revenue, occupancy, ADR, RevPAR, payments, refunds, expenses, payroll, channels
and clerk variance from imported records only.

For questions such as “why Monday money low Friday high?”,
`src/lib/ownerAnalysis.js` computes a deterministic weekday comparison before
the response is rendered. It shows average matching business days, rooms sold,
occupancy, ADR, channel contribution and available refund evidence. A channel
revenue change is a fact; rate parity, inventory, cancellations and local demand
are **verification questions**, never asserted causes unless corresponding data
exists. The standard response order is: direct answer, numbers, proven drivers,
what still needs verification, GM questions, and data-quality statement.

Small spelling mistakes are corrected only against a narrow hotel vocabulary
(for example `mony` → `money`, `fridy` → `friday`). Do not fuzzy-correct dates,
dollar amounts, or property names. The UI exposes the interpretation/correction
so an owner can catch a misunderstanding. Regression coverage lives in
`src/lib/ownerAnalysis.test.js`.

Every page in the app, what it does, and what files it depends on. The count is the
number of rows below, verified against `src/pages/*.jsx` (excluding `*.test.jsx`):
34 on disk, 34 documented, no drift in either direction. This heading read "36" until
2026-08-25 while the table below listed 34 — the table was right.

### Main Dashboard
| Page | File | What It Does | Key Dependencies |
|------|------|-------------|-----------------|
| **Dashboard** | `src/pages/Dashboard.jsx` | Main scoreboard: revenue, occupancy, profit, charts | `MoneyKept`, `PaymentMethodChart`, `RevenueTrend`, `PropertyRanking`, `OtaMatrix`, `ExecutiveCharts`, `LowOccAlert`, `WeatherPanel`, `YieldAdvisor`, `PricingPanel` |
| **Statistics** | `src/pages/Statistics.jsx` | Detailed stats with filters, MTD, YTD comparisons | `statisticsAnalytics.js`, `MetricExplorer`, `useHotelData.js` |
| **Compare** | `src/pages/Compare.jsx` | Side-by-side property and period comparison | `CompareBars`, `CompareCard`, `ChannelRevenue` |
| **MtdGrowth** | `src/pages/MtdGrowth.jsx` | Month-to-date growth velocity tracking | `calculationService.js` |
| **Forecasting** | `src/pages/Forecasting.jsx` | Predict future revenue (1, 7, 30, 90 day) | `forecasting.js` |

### Operations
| Page | File | What It Does | Key Dependencies |
|------|------|-------------|-----------------|
| **Import** | `src/pages/Import.jsx` | Upload CSV files from HotelKey, auto-classify, atomic undo | `csvParser.js`, `universalParser.js`, `parser.worker.js`, `importValidation.js`, `reportParsers.js` |
| **ManualEntry** | `src/pages/ManualEntry.jsx` | Enter data by hand, copy-paste from spreadsheets | `manualEntryImport.js`, `manualEntrySave.js`, `manualDraft.js` |
| **Housekeeping** | `src/pages/Housekeeping.jsx` | Room status board (clean/dirty/inspected), maid assignment | `housekeepingService.js`, `housekeepingConfig.js`, `laborOptimization.js` |
| **RoomBoard** | `src/pages/RoomBoard.jsx` | Visual room grid: check-in/out, live cache invalidation | `roomBoard.js`, `pricingEngine.js`, `pricingSettings.js`, `realtime.js` |
| **MonthlyCalendar** | `src/pages/MonthlyCalendar.jsx` | Heatmap calendar: uses the shared luxury executive surface system with dimensional day tiles, KPI emphasis, elevated controls and modal depth, while preserving daily occupancy + revenue tiers. | `calendarGrids.js`, `revenueThresholds.js`, `hotel.js` |

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
| **Settings** | `src/pages/Settings.jsx` | App settings: commissions, alerts, taxes, MFA, backup/restore, **delete account** | `commissionRates.js`, `alertThresholds.js`, `taxSettings.js`, `dbArchive.js`, `AuthContext.jsx` (`logout`) |
| **PrivacyPolicy** | `src/pages/PrivacyPolicy.jsx` | Legal page | None |
| **TermsOfService** | `src/pages/TermsOfService.jsx` | Legal page | None |
| **DemoYDoc** | `src/pages/DemoYDoc.jsx` | Real-time CRDT sync demo | `crdt.jsx` |

---

## 18. Owner Analyst — evidence-only owner questions

Owner Analyst corrects only a narrow set of hotel-operational spelling mistakes; property names, dates, and amounts are never fuzzy-corrected. Weekday explanations show imported occupancy, revenue, ADR, channel, and refund facts, while operational causes remain verification tasks. “Why is money kept down?” compares the requested period with the immediately preceding equal-length period and decomposes the change into revenue, refunds, payroll, and operating costs. “What is wrong today?” gives an owner briefing from the latest imported business day and its preceding-day baseline. Missing baselines, channel reports, or operational records are stated as limits, never filled with a guess.

Comparable ranges are calculated from explicit date-time millisecond values, so the same date logic is valid under the browser runtime and the repository’s strict JavaScript typecheck.

The in-panel conversation can carry the last confirmed property, date range, and operational topic into a short follow-up such as “why was it low?” or “what about Expedia?”. Topics are deliberately limited to revenue/money kept, occupancy, channels, refunds, costs, cash, and a daily summary. The active context is shown and can be cleared. A new explicit date overrides it, a dashboard-filter change clears it, and the context is only a client-side default: authorization always remains session-derived in the function layer. Topic-aware answers compare the preceding equal-length period when its imported report exists; otherwise they state the missing evidence rather than infer a cause.

## 19. Clerk Audit — refund evidence and room-rent leakage

The Clerk Audit classifies AdjustmentRefund records from evidence, not a dollar shortcut. A note that explicitly identifies a guest/security/incidental deposit return is a proved **Deposit Return** and is excluded from room-rent leakage. A non-deposit refund is surfaced as a **Room-Rent Refund** (or possible room-rent refund when the note lacks a service/rate reason). An exact `$100` refund with no deposit-return wording is **Needs Review**—it is neither silently excluded nor accused as leakage. Cash room-rent refunds receive the strongest visual emphasis because they need prompt folio and approval review. The audit identifies the clerk who processed an entry; it never attributes the operational cause to that clerk without supporting evidence.

Inside a selected clerk’s drawer, the owner can independently filter folio refunds by classification (including cash room-rent risk), payment method, date range, room number, evidence/notes, and inclusive minimum/maximum amount. The live result count and total always reflect every active filter. “Hide proved deposit returns” excludes only note-confirmed deposits; it never hides unclear `$100` items. Clear filters restores the complete selected-clerk ledger.

# 5. ALL 90+ LIBRARIES (The Engines Under The Hood)

These are the files in `src/lib/` -- the brains of the app. Grouped by what they do.

### Money & Financial Engines
| File | What It Does | If You Edit This... |
|------|-------------|-------------------|
| `calculationService.js` | **Main calculator**: ADR, RevPAR, occupancy, net revenue, weighted averages | Dashboard numbers change. Test ALL financial displays. |
| `dailyAggregates.js` | Builds daily summary rows from raw data, caches results | Dashboard cards break. The room_revenue typo lived here (Problem #3). |
| `financialReconciliation.js` | 4-way cross-check: PMS reports, gateway auth, batch settlement, bank deposits | Nothing on screen changes — no page imports it (measured 2026-08-24: `hotelKeyRegression.test.js` + `probe-financial-invariant.mjs` only). Drift is a `console.warn`, not an alert. |
| `RevenueReconciliation.js` | 3-path revenue matcher (Path 1 vs 2 vs 3) | Revenue audit breaks. |
| `decimal.js` | Integer-cents math: toCents(), fromCents(), multiply(), divide() -- prevents float errors | ALL money calculations break. Critical for accuracy. `Math.round(n * SCALE)` inside it is not a violation — that IS the dollars-to-cents boundary. Importing this module opts a file into the cents domain, and `scripts/probe-float-money.mjs` then forbids float-dollar rounding in it unless the site is allowlisted with a reason. Measured 2026-08-24: 26 modules have opted in. |
| `settingsStore.js` | The ONLY localStorage reader/writer the settings modules may use. Readers return the caller's fallback and log the key they discarded; writers return `true`/`false` and never throw. **Measured 2026-08-25: 9 importers — 8 settings modules plus `DataIntelligence.jsx` — and 12 key names, one of which (`rri_housekeeping_config_`) is a per-property prefix rather than a fixed key.** The earlier figure of "7 modules, 9 keys" was correct on 2026-08-24 and went stale twice: `DataIntelligence.jsx` (+2 keys) joined with the catch-block sweep, and `housekeepingConfig.js` (+1) with tracker #55. | A refused write becomes silent again. Before 2026-08-24 those modules carried hand-written `catch {}` blocks between them, so a quota-exhausted or private-browsing write was swallowed while `notifySettingsChanged()` still fired — the page showed "Saved" and the app kept computing on the OLD rate (measured: 22% typed, 15% applied = $70 unreported per $1,000 of Expedia gross). **Never `void` a writer's return value.** And a boolean is only half of it: where the store *clamps*, read the value back before rendering it — see `housekeepingConfig.js` below. **Not every silent-storage fix belongs here:** `manualDraft.js` (2026-08-25) was written separately because a draft's failures have to reach the screen and it needs a guarded remove — see that row. |
| `commissionRates.js` | OTA commission models (fixed, %, none, tax-exempt) | Channel revenue goes wrong. Its setters return `false` when the browser refuses the write — a caller that ignores that shows a rate the engine is not using. `commissionFor()` resolves the LONGEST matching key, so editing `EXPEDIA` does not move `EXPEDIA HOTEL COLLECT`. **It owns THREE keys** (`rri_commission_rates_v2`, `rri_cc_fee_rate`, `rri_cc_fee_refunds_v1`); a page that hand-lists them will list the wrong number, as `Settings.jsx`'s delete-account handler did with two of three (tracker #57). Nothing outside this module should name its keys. |
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
| `manualDraft.js` | The ONLY holder of the Manual Entry draft key and of every `localStorage` call behind it (`draftKeyFor`, `readDraft`, `writeDraft`, `clearDraft`). **Deliberately not on `settingsStore.js`:** a draft is not a setting — its failures must reach the *screen*, so each message is a finished sentence the page renders through `setSaveMsg`/`setMsgTone`, and it needs a guarded `removeItem`, which the settings store has no primitive for. | Hand-typed money rows are lost in silence again. Before 2026-08-25 the page held 5 raw calls: `getItem` sat outside its own `try`, so a browser that refuses storage threw out of a `useEffect` and `LazyErrorBoundary` **replaced the whole page**; a corrupt draft was deleted with no message; the auto-save's only failure path was `console.warn` while the amber "● Unsaved draft" dot kept claiming the rows were kept; and the unguarded clear after a *successful* save threw past `setSaving(false)` and `rotateCsrfToken()`. `manual_draft_` is also a `LOCAL_SLOT_PREFIXES` entry in `dbArchive.js`, so renaming the key drops drafts out of every backup — `probe-db-archive.mjs` asserts it. See BRAIN_TROUBLESHOOTING section 35. |
| `uploadRetention.js` | TTL cleanup of expired CSV previews from IndexedDB | Browser storage fills up. |

### Security (Most Are Protected!)
| File | What It Does | If You Edit This... |
|------|-------------|-------------------|
| `AuthContext.jsx` PROTECTED | Auth provider, session management, idle polling (30s), cross-tab logout | Login breaks for EVERYONE. **Its `logout(shouldRedirect = true)` takes a BOOLEAN and builds `/login?returnTo=…` itself. `db.auth.logout(redirect)` in `base44Client.js` takes a URL and assigns it straight to `window.location.href`.** Two same-named functions, one parameter each, and `true` is legal-looking to both — `Settings.jsx` passed `true` to the URL one and sent deleted accounts to `<origin>/true` (tracker #57, BRAIN_TROUBLESHOOTING section 36). Pages should call this one. |
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
| `fraudScoringEngine.js` | Clerk-shift risk scoring: cash-adjustment z-score, rate overrides, off-hours (01:00–05:00) activity over $50. **Two entry points that disagree on weights and cut-offs** — read the module header before wiring either in | Nothing on screen changes — imported only by `hotelKeyRegression.test.js`. There is no fraud alert wired to a page yet. |
| `statisticsAnalytics.js` | Statistical analysis engine for Statistics page | Statistics page breaks. |
| `columnarAnalytics.js` | **Unwired scaffold.** Zero importers anywhere; every metric array is built at length 0 with no ingestion path, so it can only ever return zeros | Nothing breaks. Data Intelligence runs on `dataScanner.js` + `aiInsights.js`. Deletion proposed — see the file header. |
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
| `housekeepingConfig.js` | Four per-property productivity standards (checkout min, stayover min, wage, target labor %), clamped to `LIMITS` on write | The Housekeeping page's whole labor plan derives from these four numbers. Two rules learned the hard way (tracker #55, BRAIN_TROUBLESHOOTING section 34): **the writer clamps, so a caller must re-read with `getHousekeepingConfig` rather than trust what it submitted** — otherwise the page renders figures computed from a value that was never stored; and **`Number(x) \|\| fallback` is forbidden here**, because the editors report `Number(e.target.value)`, `Number("")` is `0`, and a falsy test made the clamp floors unreachable from the UI. |
| `roomBoard.js` | Room grid state management | Room board view breaks. |
| `weatherService.js` | Live weather data + revenue correlation | Weather widget breaks. |
| `weatherSettings.js` | Property coordinates for the forecast (never an API key — that is server-side) | More than the weather card. Traced 2026-08-24: WeatherPanel fetches with these coordinates and persists `WeatherSnapshot` rows, `usePricing.js` builds `weatherByDate` from those rows, and `pricingEngine.js` turns it into `weatherMultiplierBps` — so wrong coordinates quietly move every recommended rate. |
| `laborOptimization.js` | `generateHousekeepingSchedule(checkouts, stayovers, standards)` — required minutes and shift count | Until 2026-08-25 it hardcoded `* 30` and `* 15`, **the exact defaults of the two minute settings**, so both were decorative: read, clamped, saved, never consumed. The historical constants are now the parameter's defaults, so a caller passing nothing is unchanged. If you touch it, assert that a *tuned* standard moves `requiredMinutes` — a round-trip assertion cannot see this defect. `MINUTES_PER_SHIFT = 480` is deliberately not configurable. |
| `yieldOptimizer.js` | Rate recommendation in float dollars. **Unwired**, and it disagrees with the live `pricingEngine.js` by up to $25.60/night on identical inputs | Nothing on screen changes — imported only by `hotelKeyRegression.test.js`. Its file header recommended deleting it and making `YieldAdvisor.jsx` render pricingEngine's number; resolved differently on 2026-08-25 — see `yieldAdvice.js`, which recommends **no** rate at all and points the reader at the Dynamic Pricing panel, so the app keeps exactly one rate recommender. |
| `reputationService.js` | Guest review aggregation + sentiment | Reviews page breaks. |
| `actionCenter.js` | Action item management (Fix Today/Investigate/Opportunity) | Action Center page breaks. |
| `yieldAdvice.js` | `buildYieldAdvice({occupancy, capacity, roomsSold, threshold})` → `{band, target, occupancy, capacity, roomsSold, headline, action, basis}`. The Dashboard yield panel's whole decision, split out of the `.jsx` so `probe-yield-advisor.mjs` can import it (JSX cannot be imported by the harness — same split as `actionCenter.js` ↔ `ActionCenter.jsx`) | The panel's text. Three invariants: it **recommends no rate** (that is `pricingEngine.js`, alone); its soft band is `occ < getOccThreshold()`, which is `LowOccAlert`'s own predicate, so the two panels on one screen cannot contradict each other; and `capacity <= 0` returns `band: 'unknown'` — an unmeasured period must not receive rate advice. `STRONG_OCCUPANCY_MARGIN = 0.20` is the one editorial constant (there is no high-occupancy setting in `alertThresholds.js`); at the default 0.60 target it reproduces the shipped 0.80 boundary. |
| `anomalySignoff.js` | Anomaly triage sign-off workflow | Anomaly triage breaks. |

### Infrastructure & UI Utilities
| File | What It Does | If You Edit This... |
|------|-------------|-------------------|
| `query-client.js` | React Query config (data fetching cache) | ALL data fetching breaks. |
| `crdtSync.js` | Hand-rolled LWW-Set / OR-Map / vector clocks. **Not Yjs** (that is `src/crdt.jsx`) and **unwired** — the only importer is `probe-crdt-convergence.mjs` | Nothing breaks. Multi-user editing runs on `src/crdt.jsx` (Yjs), which `App.jsx` wraps the whole app in. Editing this only affects that one probe. |
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
| `YieldAdvisor.jsx` | Occupancy band + what to do about it. Renders `yieldAdvice.js` and computes nothing itself. Until 2026-08-25 it computed its advice inline and **every figure in it was invented**: `$10–$15` / `$5–$8` rate moves from nothing, an ADR target from `money2(adr * 1.05)` (float dollars), a caption reading "Occupancy vs 100-room capacity" on a page that holds the real room-night total, a hardcoded `> 0.6` band that contradicted `LowOccAlert` on the same screen, and "Soft Occupancy (0.0%). Drop rate $5–$8" for an **empty** database | `yieldAdvice.js`, `hotel.js` (`pct`, `money2`), `ui-exec/Card` |
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

# 17. REACT-QUERY FETCH GATING (why 28 missing `enabled:` options are NOT a defect)

Measured 2026-08-25: **40 `useQuery` calls across 12 files, 12 with `enabled:`, 8 with an
explicit `staleTime`.** That reads like a bug report — 28 queries that fire before their
inputs are ready — and it is not one. Anyone tempted to add `enabled:` to the other 28
should read this section first, because the churn buys nothing and the reasoning is not
visible from any single call site.

## 17.1 The three properties that make it safe

**One: no page component mounts until auth is resolved.** `RequireAuth` (`src/App.jsx:166`)
wraps every route under `ProtectedRoutes`, and while `isLoadingAuth || !authChecked` it
returns a full-screen spinner instead of `children`; if the check completes unauthenticated
it returns `null`. So the ordinary "query fires with a half-initialised user" race cannot
happen here — the query's component does not exist yet.

**Two: no selection is a sentinel, not a hole.** With `selectedPropertyIds` defaulting to
`[]` (`useGlobalFilters.jsx:143`), `effectiveProperties` is empty and `property` resolves to
the string `"all"`. Consumers forward that to `db.entities.*.filter` as *no property
condition*, and `applyScope` turns an absent condition into the caller's own allowance.
`"all"` therefore means "all of mine", never "all that exist" — the data layer enforces it,
not the hook. That is why an early fire returns correct data rather than empty or leaked
data.

**Three: every property-dependent key contains the property.** `["occupancy", from, to,
propertyId, …]` and friends. If the roster resolves later and changes `effectiveProperties`,
the key changes with it and react-query refetches on its own. The two keys that carry no
property — `["uploads"]` and `["properties"]` — are portfolio-wide within the allowance by
design, so there is nothing for a property switch to change.

## 17.2 The failure mode this would be, if any one of the three were missing

Worth writing down, because it is a real react-query trap and the next reader will meet it
somewhere else. `src/lib/query-client.js` sets `staleTime: 5000` **and
`refetchOnWindowFocus: false`**, with no `refetchOnReconnect` override. Nothing in
`AuthContext.jsx`, `App.jsx` or `main.jsx` clears or invalidates the cache when auth
resolves — verified by grep, and **not one of the 40 query keys contains user identity or an
auth-ready flag.**

So *if* a query could fire while the allowance was still empty, it would cache `[]` under a
key that never subsequently changes. Stale after 5s is not the same as refetched: with
window-focus refetching off and no remount, no invalidation and no key change, that empty
array would be served forever. The user would get a dashboard of zeros that a reload fixes
and nothing else does — indistinguishable from "there is no data", which is the exact
failure `useGlobalFilters.jsx:162-166` warns about in its own comment.

The protection is property one, and it lives in a different file from all 40 call sites.
**If anyone ever makes `RequireAuth` render `children` during loading — for a skeleton
screen, say — this section becomes a live defect list and all 28 queries need `enabled:`.**
That is the coupling to watch, not the missing option.

## 17.3 What was checked and found clean

`DataIntelligence.jsx:41` (`['data-files']`) reads a raw table with no property scope and
says so in a comment on the next line; it is one of the documented raw-access sites from the
B4 sweep, and `:103` pulls `property` from `useGlobalFilters` for display. Not a defect.
`useUploads` and `useProperties` are property-agnostic on purpose. No code change was made
for any of this, deliberately.

## 18. Clerk Audit drawer width

The selected-clerk audit drawer is anchored to the right of the viewport but is resizable
from its left edge. Dragging left gives the owner more room for folio evidence and refund
classification; dragging right makes the panel narrower. Arrow Left and Arrow Right work on
the focused resize handle. Width is clamped to a readable minimum and the available viewport,
so it cannot be dragged off-screen. Each refund row wraps — rather than truncates — its full
classification explanation and every available imported evidence field (remarks, refund code,
payment detail, reason code, and charge type). If the source record itself contains only a
short value, the UI states that limitation instead of inventing a fuller note.

---

## 19. Premium analytics page heroes

`src/components/PremiumPageHero.jsx` is the shared, presentation-only hero for the three
highest-value analytics surfaces: `Dashboard.jsx`, `Statistics.jsx`, and
`Forecasting.jsx`. It provides token-driven depth, a scoped CSS perspective stack, and a
single Framer Motion entrance. Decorative layers are `aria-hidden` and ignore pointer
events; spatial motion is removed when `prefers-reduced-motion` is active.

The hero accepts real page actions rather than decorative controls. Dashboard keeps PDF
export and adds data refresh, Statistics exposes its existing CSV/Excel exports and
snapshot controls, and Forecasting exposes assumption navigation plus a reset to the
declared default scenario. The component must stay presentation-only: financial values,
query state, export implementations, and forecasting calculations remain owned by their
pages. `scripts/probe-premium-page-heroes.mjs` holds the three-page scope, accessibility,
action, and reduced-motion contract.

---

## 20. Luxury 3D Button System Architecture

The repository uses a centralized luxury 3D button system defined in `src/components/ui/button.jsx` and tokenized in `src/index.css`:

- **Layered Gradients**: Uses restrained linear gradients (`[background-image:linear-gradient(180deg,rgba(255,255,255,0.12)_0%,rgba(0,0,0,0.15)_100%)]`) layered over semantic background color tokens (`bg-primary`, `bg-destructive`, `bg-secondary`), ensuring Tailwind CSS and `tailwind-merge` class deduplication works seamlessly without color stripping.
- **Specular Bevel Highlights**: 1px inset top highlight bevels (`--btn-bevel-strong` / `inset 0 1px 0 rgba(255,255,255,0.16)` on primary/destructive; `--btn-bevel-soft` on secondary).
- **Lower Contact Shadows**: Dual-layer ambient and contact shadows (`--btn-contact`, `0 2px 4px -1px rgba(0,0,0,0.50), 0 1px 2px rgba(0,0,0,0.40)`).
- **Tactile Physics**: Rest elevation, hover lift (`hover:-translate-y-px` with intensified shadow), and tactile active compression (`active:translate-y-[1px]` with inset shadow `inset 0 2px 4px rgba(0,0,0,0.45)`).
- **GPU Compositor Isolation**: Uses `transform-gpu` without `will-change` to eliminate compositor memory bloat across dense grids.
- **Scoped Transitions**: Strictly property-scoped transitions (`transition-[transform,box-shadow,background-color,border-color]`, 150ms ease-out) avoiding layout thrashing.
- **High-Contrast Focus**: Emerald brand focus ring (`focus-visible:ring-2 focus-visible:ring-[#00E096]`) with 10.64:1 contrast ratio on dark card surfaces.
- **WCAG & Reduced Motion**: `disabled:opacity-50 disabled:shadow-none disabled:translate-y-0` and full `motion-reduce:transition-none motion-reduce:transform-none` neutralization.
- **Hierarchy**: `ghost` and `link` variants remain flat without 3D transforms.

