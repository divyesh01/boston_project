# BUSINESS DIRECTIVES — HOTEL OWNER PERSPECTIVE & FINANCIAL MATH

## 1. OWNER KPI PRIORITY
- Prioritize metrics critical to hotel profitability:
  - **Gross Revenue**: Total charges generated.
  - **Net Retained Earnings ("Money Kept")**: Revenue remaining after deducting refunds, pass-through taxes, OTA commissions, credit card fees, operating expenses, and payroll.
  - **ADR & RevPAR**: Average Daily Rate and Revenue Per Available Room weighted accurately by rooms sold and capacity.
  - **Keep Rate**: Percentage of revenue retained after pass-through deductions.

## 2. INTEGER-CENTS ARITHMETIC
- **MANDATORY:** Always perform financial arithmetic using integer cents (`sumCents`, `Decimal.js`).
- Never perform raw floating-point addition/subtraction (`+`, `-`) on currency dollars to avoid rounding drift.
- Format all display outputs using the shared `money(cents)` helper function.

## 3. ARITHMETIC RECONCILIATION INVARIANTS
- Verify that charge sums across transaction reports match YTD revenue figures reported in statistics files to the exact cent (e.g. `sum(CHARGE) = $1,020,598.17`).