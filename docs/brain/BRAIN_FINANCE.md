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