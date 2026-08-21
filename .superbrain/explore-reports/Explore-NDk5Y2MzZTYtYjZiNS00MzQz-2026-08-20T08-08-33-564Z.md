# Sub-Agent Report Trace

- **Agent**: Explore
- **Session**: /NDk5Y2MzZTYtYjZiNS00MzQzLWJlNGItM2YyNjQzMmJmYzAx
- **Raw report chars**: 9689
- **Compressed (delivered to parent) chars**: 10254
- **Distinct files mentioned in raw report**: 27

## Spawn Prompt (what the parent asked)

Audit the FINANCIAL/MONEY-MATH correctness of this hotel management app (React/JS, in c:\Users\divye\OneDrive\Desktop\boston_project). Read these files fully and report concrete bugs with exact file:line references:
- src/lib/moneyKept.js (or find where "money kept" is computed — search for moneyKept)
- src/lib/decimal.js
- src/lib/financialReconciliation.js
- src/lib/RevenueReconciliation.js
- src/lib/transactionAnalytics.js
- src/lib/statisticsAnalytics.js
- src/lib/payrollCalc.js
- src/lib/timecardCalc.js
- src/lib/calculationService.js
- src/lib/recalculationService.js
- src/pages/Payroll.jsx
- src/pages/Transactions.jsx
- src/pages/Statistics.jsx
- src/pages/MoneyKept.jsx (if exists) or the MoneyKept dashboard component

Report: (1) Any use of raw floating-point arithmetic (+,-,*,/ or Math.round) on dollar/currency values instead of integer cents / Decimal — give exact file:line. (2) Any place where two figures that should reconcile to the exact cent (e.g. transaction charges vs statistics YTD revenue, target $1,020,598.17) could diverge. (3) Rounding bugs, off-by-one-cent errors, mixed number/string money handling. (4) Payroll/timecard gross-net-tax calculation errors. Quote the offending lines. Do NOT propose fixes — just document problems with evidence.

## Raw Report (what the sub-agent produced, pre-compression)

I'll start by locating the money-related files and listing the lib directory.Let me read the core money files fully.Let me read the rest of statisticsAnalytics and the remaining lib files.The index is indexing; I'll use direct file reads instead.Now the calculation services and the MoneyKept component.Now the MoneyKept component and the three pages.Let me read the rest of MoneyKept.jsx.Let me check the `sum`/`money` helpers in hotel.js and read the three pages.Now the three pages.Let me verify usage of the duplicate `calculateMoneyKept` and check paymentNorm refunds handling.Let me confirm what data MoneyKept receives as `occRows`/`grossRows` from the Dashboard.I have enough evidence. Here is the audit report.

## Exploration Report

**Confidence**: HIGH — read every listed money file fully (skeletons + full source), plus the live widget, its caller in Dashboard.jsx, and the three pages.

**Files Examined**: decimal.js, financialReconciliation.js, RevenueReconciliation.js, transactionAnalytics.js, statisticsAnalytics.js, payrollCalc.js, timecardCalc.js, calculationService.js, recalculationService.js, components/dashboard/MoneyKept.jsx (914 lines), pages/Payroll.jsx, pages/Transactions.jsx, pages/Statistics.jsx, lib/hotel.js (money/sum), lib/paymentNorm.js, pages/Dashboard.jsx (MoneyKept call site).

**Key Tool Path**: listDirectory → readFiles (whole files) → targeted reads for the `sum`/`money`/refund helpers and the Dashboard call site.

### Findings

**(1) Raw floating-point arithmetic on dollars (not integer cents) — all money paths**

- `src/lib/statisticsAnalytics.js:227` — in `headline()`, `if (v !== null) value += v;` adds Taxable Room Revenue + Exempt Room Revenue as two raw float dollars. This is precisely the figure that must tie to the cent (`$1,011,258.67` room subtotal) against `sum(OccupancyDay.room_revenue)`. The *same* subtotal is computed cents-correctly by `revenueSplit()` at `statisticsAnalytics.js:368` via `sumCents`. Two different implementations of one reconciled quantity, one float.
- `src/components/dashboard/MoneyKept.jsx:174` — `bump(..., "gross", Number(r.room_revenue) || 0)` raw float per-day gross; `:180-182` `comm = rev * info.rate` (and fixed/actual variants); `:188` `card * ccFee`; `:191` `refund * ccFee`; `:262-264` `state += base * r.state` etc. (per-day tax estimate). The only place these get snapped to cents is `pushItem` at `:383` (`Math.round(amount*100)/100`), so every intermediate is float.
- `MoneyKept.jsx:448` — `const kept = gross - totalDeductions;` float subtraction. `gross` comes from `sum()` (hotel.js:46, which is `sumCents`, i.e. cents-correct), and `totalDeductions` is a sum of per-item already-cents-rounded amounts, so `kept` is effectively cent-accurate — but the subtraction itself is float, and the component's two mirror implementations do not share this discipline.
- `MoneyKept.jsx:617-618` — `netRevenueBase = gross - refundsTotal - passThrough; keepRate = ... kept / netRevenueBase` float division (display ratio only).
- `MoneyKept.jsx:527-534` — trend lump-sum allocation `share = (d.gross / grossTotal) * lumpTotal` distributes lump payroll/expenses across days by revenue share as floats (chart-only, but produces fractional-cent daily `kept`).
- `src/lib/transactionAnalytics.js:266` — `fee = fromCents(Math.round(toCents(settled) * rate))` multiplies integer cents by a float rate (`rate` is e.g. `0.023`) then rounds; `:291` does the same per-employee. Per-employee rounded fees summed (`byEmployee`) can differ by a cent from the single overall `fee` at `:266` because rounding happens at different granularities.
- `src/lib/calculationService.js:110` — `cur.gross += Number(r.net_revenue)` float accumulation; `:120-122` `commission = c.gross * info.rate` / `info.rate * c.stays`; `:127` `net: c.gross - commission`; `:128` float margin. Cents are only re-introduced at the end (`calculateMoneyKept:205` does `sumCents(...commission)`), i.e. per-channel commission is a float that is rounded once after the fact.

**(2) Figures that should reconcile to the exact cent but can diverge**

- **Dashboard "Money Kept" gross is ROOM-ONLY revenue, not total revenue.** `Dashboard.jsx:321` passes `occRows` (OccupancyDay) into MoneyKept, and `MoneyKept.jsx:153` computes `gross = sum(occRows, "room_revenue")` → `$1,011,258.67`. The transactions page and the reconciliation invariant target total revenue `$1,020,598.17` (room + ~`$9,339.50` ancillary). So the dashboard headline gross and the "Money Kept" bottom line can never equal the transaction/statistics revenue, and a user comparing dashboard gross against the Transactions or Statistics revenue sees a ~$9.3k permanent gap. This is the exact reconciliation the prompt asks about.
- **Reconciliation statistics leg is hardcoded to YTD regardless of the requested range.** `financialReconciliation.js:227` calls `revenueSplit(statisticsRows, 'ytd')` while the transaction leg (`:223`) is scoped to the caller's `dateRange`. Unless the range happens to be Jan‑1→today, the reconciler compares a YTD statistics figure against a non-YTD transaction total, producing false "drift" (or masking real drift).
- **The two Money Kept implementations use different keep-rate bases.** Live widget `MoneyKept.jsx:617` uses `gross − refunds − passThrough`; shadow `calculationService.js:233` uses `gross − refunds − estimatedTaxes`. `calculateMoneyKept`/`calculateProfitMetrics` are only called by scripts (`probe-money-kept*.mjs`) today, but the two mirrors diverge by construction — the LAUNCH checklist explicitly warns to reconcile them if ever wired to the UI.
- **Shadow impl overstates card volume.** `calculationService.js:207` computes `cardTotal = sum(total) − sum(cash) − sum(check)`, so every non-cash/non-check method (direct_bill, loyalty, wire, etc.) is charged the credit-card fee; the live widget `MoneyKept.jsx:187` correctly sums only `CARD_METHODS`. The two disagree on cc fees.

**(3) Rounding bugs / mixed number-string money**

- `decimal.js:82-91` / `hotel.js:41` — the app-wide `money()` formatter calls `formatCents(toCents(v), 0)`, and `formatCents` with `decimals === 0` returns dollars with **no cents** (line 87-89). Every headline `money(...)` display (Revenue, Money Kept, Settlements, Total Deductions) drops the cents, so "reconciled to the cent" is only visible via `money2()`; a 17¢ figure renders as `$0`. Display-only, but the reason per-cent drift is invisible on the dashboard.
- `transactionAnalytics.js:82` `avgTicket = revenue / charges.length` and `:109` same — float division of a cents figure by a count (display only).
- `payrollCalc.js:39` — `otRate = Number(overtime_rate) || br * 1.5` uses a float 1.5 default multiplier; acceptable after `toCents`, but the OT rate is a float from the start.

**(4) Payroll / timecard gross-net-tax**

- **Payroll has no gross/net/tax model at all.** `payrollCalc.js:49` `total_pay = regularPayCents + overtimePayCents + bonusCents − deductionsCents`. `deductions` is a single free-form field; there is no tax withholding / gross-to-net computation anywhere in `payrollCalc.js` or the Payroll page. If "tax" is expected on payroll, it is absent.
- `timecardCalc.js:281` — `row.hours += paid.hours` accumulates `paid.hours` (each `= paidMinutes/60`, a float) across all shifts, so the weekly total is a float; the 40-hour OT threshold (`:290` `Math.max(0, row.hours - weeklyOvertimeHours)`) is applied to the unrounded float while the reported `hours`/`overtime_hours` are re-rounded to 2 decimals at `:291-292`. OT splitting can therefore be computed on a slightly different number than what is displayed/paid.
- `payrollCalc.js:45` — hourly pay `Math.round(baseRateCents * hrs)` multiplies an integer-cents hourly rate by a float hour count (e.g. 37.5); cents-accurate only after `Math.round`. Fine for whole-cents rates, but if a rate like `$15.025` were entered, `toCents` already rounds it to the cent before the multiply.

**(5) Non-math correctness note (reconciliation hardening is good, but the invariant is range-scoped)**

- `RevenueReconciliation.js` (precedence, cents comparisons, `$0.01` tolerance, `suspectZeroPaths`, `NO_DATA`) and `financialReconciliation.reconcileDailyFinancials` (all-cents 4-way) are correct in isolation. The remaining risk is upstream: the YTD-hardcode at `financialReconciliation.js:227` and the room-only gross feeding the dashboard.

### Recommendation
The single highest-impact fix target is `MoneyKept.jsx:153`: the dashboard's gross (and therefore `kept`, `keepRate`, and every deduction %) is computed off room-only `room_revenue`, so it structurally cannot reconcile to the `$1,020,598.17` total-revenue target shown on Transactions/Statistics. Next, normalize `statisticsAnalytics.js:227` (float add) to the same cents path used by `revenueSplit` (`:368`), and scope the statistics leg in `financialReconciliation.js:227` to the requested `dateRange` instead of hardcoded `'ytd'`.

### Not covered / Uncertain
- Did not read the `autoPayroll` DB function (server-side) that `Payroll.jsx` invokes at `:175` — payroll created by the engine may compute pay differently than `calculatePay`; the audit covers the client-side `calculatePay`/`timecardCalc` only.
- Did not read `CommissionsPanel.jsx` / `LedgerStrip.jsx` / `LedgerTable.jsx` (transaction sub-components) — commission and fee display math there was not audited.
- The `money()` whole-dollar display behavior (decimal.js:87-89) is inferred from the formatter source; I did not verify every call site intentionally relies on cent-free display.
- `recalculationService.js` contains no money math (only React Query cache invalidation) — no findings.

## Compressed Report (what the parent actually received)

<HYDRATION_REPORT>
I'll start by locating the money-related files and listing the lib directory.Let me read the core money files fully.Let me read the rest of statisticsAnalytics and the remaining lib files.The index is indexing; I'll use direct file reads instead.Now the calculation services and the MoneyKept component.Now the MoneyKept component and the three pages.Let me read the rest of MoneyKept.jsx.Let me check the `sum`/`money` helpers in hotel.js and read the three pages.Now the three pages.Let me verify usage of the duplicate `calculateMoneyKept` and check paymentNorm refunds handling.Let me confirm what data MoneyKept receives as `occRows`/`grossRows` from the Dashboard.I have enough evidence. Here is the audit report.

## Exploration Report

**Confidence**: HIGH — read every listed money file fully (skeletons + full source), plus the live widget, its caller in Dashboard.jsx, and the three pages.

**Files Examined**: decimal.js, financialReconciliation.js, RevenueReconciliation.js, transactionAnalytics.js, statisticsAnalytics.js, payrollCalc.js, timecardCalc.js, calculationService.js, recalculationService.js, components/dashboard/MoneyKept.jsx (914 lines), pages/Payroll.jsx, pages/Transactions.jsx, pages/Statistics.jsx, lib/hotel.js (money/sum), lib/paymentNorm.js, pages/Dashboard.jsx (MoneyKept call site).

**Key Tool Path**: listDirectory → readFiles (whole files) → targeted reads for the `sum`/`money`/refund helpers and the Dashboard call site.

### Findings

**(1) Raw floating-point arithmetic on dollars (not integer cents) — all money paths**

- `src/lib/statisticsAnalytics.js:227` — in `headline()`, `if (v !== null) value += v;` adds Taxable Room Revenue + Exempt Room Revenue as two raw float dollars. This is precisely the figure that must tie to the cent (`$1,011,258.67` room subtotal) against `sum(OccupancyDay.room_revenue)`. The *same* subtotal is computed cents-correctly by `revenueSplit()` at `statisticsAnalytics.js:368` via `sumCents`. Two different implementations of one reconciled quantity, one float.
- `src/components/dashboard/MoneyKept.jsx:174` — `bump(..., "gross", Number(r.room_revenue) || 0)` raw float per-day gross; `:180-182` `comm = rev * info.rate` (and fixed/actual variants); `:188` `card * ccFee`; `:191` `refund * ccFee`; `:262-264` `state += base * r.state` etc. (per-day tax estimate). The only place these get snapped to cents is `pushItem` at `:383` (`Math.round(amount*100)/100`), so every intermediate is float.
- `MoneyKept.jsx:448` — `const kept = gross - totalDeductions;` float subtraction. `gross` comes from `sum()` (hotel.js:46, which is `sumCents`, i.e. cents-correct), and `totalDeductions` is a sum of per-item already-cents-rounded amounts, so `kept` is effectively cent-accurate — but the subtraction itself is float, and the component's two mirror implementations do not share this discipline.
- `MoneyKept.jsx:617-618` — `netRevenueBase = gross - refundsTotal - passThrough; keepRate = ... kept / netRevenueBase` float division (display ratio only).
- `MoneyKept.jsx:527-534` — trend lump-sum allocation `share = (d.gross / grossTotal) * lumpTotal` distributes lump payroll/expenses across days by revenue share as floats (chart-only, but produces fractional-cent daily `kept`).
- `src/lib/transactionAnalytics.js:266` — `fee = fromCents(Math.round(toCents(settled) * rate))` multiplies integer cents by a float rate (`rate` is e.g. `0.023`) then rounds; `:291` does the same per-employee. Per-employee rounded fees summed (`byEmployee`) can differ by a cent from the single overall `fee` at `:266` because rounding happens at different granularities.
- `src/lib/calculationService.js:110` — `cur.gross += Number(r.net_revenue)` float accumulation; `:120-122` `commission = c.gross * info.rate` / `info.rate * c.stays`; `:127` `net: c.gross - commission`; `:128` float margin. Cents are only re-introduced at the end (`calculateMoneyKept:205` does `sumCents(...commission)`), i.e. per-channel commission is a float that is rounded once after the fact.

**(2) Figures that should reconcile to the exact cent but can diverge**

- **Dashboard "Money Kept" gross is ROOM-ONLY revenue, not total revenue.** `Dashboard.jsx:321` passes `occRows` (OccupancyDay) into MoneyKept, and `MoneyKept.jsx:153` computes `gross = sum(occRows, "room_revenue")` → `$1,011,258.67`. The transactions page and the reconciliation invariant target total revenue `$1,020,598.17` (room + ~`$9,339.50` ancillary). So the dashboard headline gross and the "Money Kept" bottom line can never equal the transaction/statistics revenue, and a user comparing dashboard gross against the Transactions or Statistics revenue sees a ~$9.3k permanent gap. This is the exact reconciliation the prompt asks about.
- **Reconciliation statistics leg is hardcoded to YTD regardless of the requested range.** `financialReconciliation.js:227` calls `revenueSplit(statisticsRows, 'ytd')` while the transaction leg (`:223`) is scoped to the caller's `dateRange`. Unless the range happens to be Jan‑1→today, the reconciler compares a YTD statistics figure against a non-YTD transaction total, producing false "drift" (or masking real drift).
- **The two Money Kept implementations use different keep-rate bases.** Live widget `MoneyKept.jsx:617` uses `gross − refunds − passThrough`; shadow `calculationService.js:233` uses `gross − refunds − estimatedTaxes`. `calculateMoneyKept`/`calculateProfitMetrics` are only called by scripts (`probe-money-kept*.mjs`) today, but the two mirrors diverge by construction — the LAUNCH checklist explicitly warns to reconcile them if ever wired to the UI.
- **Shadow impl overstates card volume.** `calculationService.js:207` computes `cardTotal = sum(total) − sum(cash) − sum(check)`, so every non-cash/non-check method (direct_bill, loyalty, wire, etc.) is charged the credit-card fee; the live widget `MoneyKept.jsx:187` correctly sums only `CARD_METHODS`. The two disagree on cc fees.

**(3) Rounding bugs / mixed number-string money**

- `decimal.js:82-91` / `hotel.js:41` — the app-wide `money()` formatter calls `formatCents(toCents(v), 0)`, and `formatCents` with `decimals === 0` returns dollars with **no cents** (line 87-89). Every headline `money(...)` display (Revenue, Money Kept, Settlements, Total Deductions) drops the cents, so "reconciled to the cent" is only visible via `money2()`; a 17¢ figure renders as `$0`. Display-only, but the reason per-cent drift is invisible on the dashboard.
- `transactionAnalytics.js:82` `avgTicket = revenue / charges.length` and `:109` same — float division of a cents figure by a count (display only).
- `payrollCalc.js:39` — `otRate = Number(overtime_rate) || br * 1.5` uses a float 1.5 default multiplier; acceptable after `toCents`, but the OT rate is a float from the start.

**(4) Payroll / timecard gross-net-tax**

- **Payroll has no gross/net/tax model at all.** `payrollCalc.js:49` `total_pay = regularPayCents + overtimePayCents + bonusCents − deductionsCents`. `deductions` is a single free-form field; there is no tax withholding / gross-to-net computation anywhere in `payrollCalc.js` or the Payroll page. If "tax" is expected on payroll, it is absent.
- `timecardCalc.js:281` — `row.hours += paid.hours` accumulates `paid.hours` (each `= paidMinutes/60`, a float) across all shifts, so the weekly total is a float; the 40-hour OT threshold (`:290` `Math.max(0, row.hours - weeklyOvertimeHours)`) is applied to the unrounded float while the reported `hours`/`overtime_hours` are re-rounded to 2 decimals at `:291-292`. OT splitting can therefore be computed on a slightly different number than what is displayed/paid.
- `payrollCalc.js:45` — hourly pay `Math.round(baseRateCents * hrs)` multiplies an integer-cents hourly rate by a float hour count (e.g. 37.5); cents-accurate only after `Math.round`. Fine for whole-cents rates, but if a rate like `$15.025` were entered, `toCents` already rounds it to the cent before the multiply.

**(5) Non-math correctness note (reconciliation hardening is good, but the invariant is range-scoped)**

- `RevenueReconciliation.js` (precedence, cents comparisons, `$0.01` tolerance, `suspectZeroPaths`, `NO_DATA`) and `financialReconciliation.reconcileDailyFinancials` (all-cents 4-way) are correct in isolation. The remaining risk is upstream: the YTD-hardcode at `financialReconciliation.js:227` and the room-only gross feeding the dashboard.

### Recommendation
The single highest-impact fix target is `MoneyKept.jsx:153`: the dashboard's gross (and therefore `kept`, `keepRate`, and every deduction %) is computed off room-only `room_revenue`, so it structurally cannot reconcile to the `$1,020,598.17` total-revenue target shown on Transactions/Statistics. Next, normalize `statisticsAnalytics.js:227` (float add) to the same cents path used by `revenueSplit` (`:368`), and scope the statistics leg in `financialReconciliation.js:227` to the requested `dateRange` instead of hardcoded `'ytd'`.

### Not covered / Uncertain
- Did not read the `autoPayroll` DB function (server-side) that `Payroll.jsx` invokes at `:175` — payroll created by the engine may compute pay differently than `calculatePay`; the audit covers the client-side `calculatePay`/`timecardCalc` only.
- Did not read `CommissionsPanel.jsx` / `LedgerStrip.jsx` / `LedgerTable.jsx` (transaction sub-components) — commission and fee display math there was not audited.
- The `money()` whole-dollar display behavior (decimal.js:87-89) is inferred from the formatter source; I did not verify every call site intentionally relies on cent-free display.
- `recalculationService.js` contains no money math (only React Query cache invalidation) — no findings.

---
[Exploration: Explore (deepseek-v4-flash) | 132908ms | 15 turns | 22 tools | 95434in/12417out tokens | status: completed]
</HYDRATION_REPORT>

CRITICAL: Write your final answer DIRECTLY from the findings above. Do NOT re-page files the sub-agent already covered (no whole-file skeleton/symbols/read on those paths). To confirm one specific cited line, a narrow sb_read_code range (<=40 lines) is allowed. Files the report did NOT cover stay fully readable — locate them with superbrain_listDirectory / superbrain_search instead of guessing.
