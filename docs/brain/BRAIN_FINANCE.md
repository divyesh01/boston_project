# 12. THE MONEY MATH (Formulas)

Every financial formula. All of these run in integer cents through `src/lib/decimal.js`
— never in floating point. See section 12.5 for why that is not optional.

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

---

## 12.1 The Golden Benchmark — CORRECTED 2026-08-20

> [!CAUTION]
> **This section previously specified an invariant that cannot hold.** It read:
> "Path 1 (GrossRevenueDay sum) ~= Path 2 (PaymentDay sum) ~= Path 3 (OccupancyDay x
> ADR), tolerance +/- $0.01." Those three sums measure three different things, so
> equality is not a property the data can have. `probe-revenue-reconciliation.mjs` was
> written to that spec, could not satisfy it against real rows, and had been given
> fixtures that made it agree with itself. **The document was the root cause of the
> defective probe** — not the other way round.

The three paths and what each actually measures:

| Path | Source | Measures |
|------|--------|----------|
| 1 | `GrossRevenueDay` | **Charges posted** — room rent plus ancillary, minus `non_revenue` and `advance_deposit` |
| 2 | `PaymentDay` | **Settlements received** — tender by method, including `REFUND` rows |
| 3 | `OccupancyDay` | **Room-only revenue** — the room ledger, no ancillary at all |

Why they legitimately differ:

- **Path 3 < Path 1 by exactly the ancillary total.** Path 3 is room-only *by design*.
  Occupancy and ADR are room metrics; folding food and bar revenue into them would
  make ADR meaningless.
- **Path 2 is a different accounting period from Path 1.** A charge posted on the 30th
  and settled on the 1st appears in Path 1 in one month and Path 2 in the next.
- **`REFUND` in this PMS is a settlement, not a reversal.** It records money going out
  through a tender line. It does not remove the original charge, so it moves Path 2
  without moving Path 1. Revenue is therefore **CHARGE-only**; a refund never reduces
  Path 1.

### What is actually invariant

```
Path 1 room component  ==  Path 3          (exact, to the cent)
Path 1 total           ==  Path 1 room + ancillary - non_revenue - advance_deposit
Path 2                 ==  charges settled in this period, which is NOT Path 1
```

`hotel.js#grossRevenueForPeriod({ grossRows, occRows })` is the single implementation
of the Path-1/Path-3 relationship. It returns provenance, not just a number:

```js
{ cents, dollars, basis: "total" | "room", roomCents, ancillaryCents }
```

The room component comes from `occRows` when they cover the period, otherwise from
`room_rent` on the gross rows — **never both**, which is how double counting is
prevented. `basis` tells the caller which happened.

> [!TIP]
> **BEST OUTCOME NOTE.** A reconciliation alert should fire on a violated invariant,
> never on an expected difference. The old spec guaranteed a permanent false alarm,
> and a permanent false alarm trains the owner to ignore the alert that matters. The
> alert now compares Path 1's room component against Path 3 — a difference there is
> always real.

## 12.2 Component vocabulary (names, not values)

Inclusion is decided by **column name**, never by sign or magnitude. A large number is
not evidence that a column is revenue.

```
GROSS_ANCILLARY_COMPONENTS   = misc_charge, system_charge, food, event,
                               bar, beverage, laundry, phone, other
GROSS_NON_REVENUE_COMPONENTS = non_revenue, advance_deposit
CARD_METHODS                 = visa, master, amex, discover
REFUND_FIELDS                = closed_balance_folio, loyalty_discount   (stored SIGNED/negative)
```

`room_rent` is deliberately **not** in the ancillary list — it is the room component,
and listing it as ancillary would double count every room night.

## 12.3 Capacity is per day, never per row

```
capacity room-nights = (distinct dates in range) x (rooms in inventory)
```

**Never** `sum(row.total_rooms)`. A per-row fallback makes a duplicate import
invisible: 28 days imported twice gives 56 rows, occupancy sums to 2x, capacity also
sums to 2x, and the ratio stays plausible. With per-day capacity the same double
import reports >100% occupancy, which is the signal the owner needs. A 100-room hotel
has 2800 room-nights in a 28-day month however many times the report was imported.

Period averages divide by **distinct dates in range**, never by `rows.length`.

## 12.4 The card-processing fee basis

The fee applies to card tender only — `CARD_METHODS`. Cash, check and direct-bill
settlements attract no processing fee. Charging the fee against total tender
understates Money Kept by the fee on every cash dollar taken.

## 12.5 Why integer cents, with measured evidence

Not a style preference. Measured on node 22 in this repository:

```
2.05 - 2.01                        = 0.040000000000000036
[1234.56, 0.07, 0.1, 0.2] summed   = 1234.9299999999998
1000 x 0.07 left-folded            = 69.99999999999966   (should be 70.00)
0.07 * 3                           = 0.21000000000000002
```

The third line is the one that reaches the owner: a thousand $0.07 fee postings drift
by three and a half cents, and that is the figure a bank statement is reconciled
against.

> [!NOTE]
> Not every float sum drifts. `[19.99, 0.01, 0.1, 0.2]` sums to exactly 20.3. This
> matters because it is why the defect survived so long — the arithmetic is right most
> of the time, so spot-checking finds nothing. Only the *guarantee* differs.

### The `multiply` trap

`decimal.js#multiply(a, b)` treats **`a` as money and `b` as a RATE**. It is for
`amount x commission_rate`. Using it for money x count (rooms, nights, headcount)
silently divides by `RATE_SCALE`. For counts, scale the cents integer directly.

```
SCALE      = 100     (cents per dollar)
RATE_SCALE = 10000   (basis points)
add/subtract -> return CENTS, not dollars
```

## 12.5.1 Money Kept sign and cache units — ADDED 2026-08-21

`Money Kept = gross - deductions`. A negative result is mathematically valid when
deductions are greater than gross; the UI must show that loss rather than changing
the sign to make the dashboard look healthy.

An **estimated OTA commission greater than total revenue is not valid** when every
percentage rate is clamped below 100%. Investigate the input rows and cache before
changing the sign or adding a cap. A cap would hide bad data and make the report
unreconcilable.

The dashboard reads `DailyFinancialAggregate` before it reads the raw ledgers. The
aggregate contract is:

```
source_net.<channel>.net       dollars
occ_revenue                    dollars
gross_misc.<field>             dollars
expense_by_category.<key>      dollars
```

The accumulator may use integer cents internally, but `finalizeDay()` converts every
money field, including nested `source_net`, back to dollars before storage. The cache
has `aggregate_version = 2`; rows without that version are legacy data and must be
ignored so the caller falls back to raw ledgers. Guessing the unit of an old row can
turn a normal commission into a multi-million-dollar deduction.

Proof commands:

```
node --import ./scripts/_loader-boot.mjs scripts/probe-money-kept-gross.mjs
node --import ./scripts/_loader-boot.mjs scripts/probe-decimal-integration.mjs
```

Both must pass before trusting the Money Kept card after a cache-format change.

## 12.5.2 The headline figure itself — FIXED 2026-08-22

Section 12.5 explains why the *formulas* run in cents. The last place that did not
was the number the whole card exists to state.

`MoneyKept.jsx` used to compute:

```js
const totalDeductions = items.reduce((a, i) => a + i.amount, 0);
const kept = gross - totalDeductions;
const netRevenueBase = gross - refundsTotal - passThrough;   // keep-rate denominator
```

Every `i.amount` is already snapped to 2dp by `pushItem`, so this looks safe — and
it very nearly was. The residue was around 1e-10, invisible after formatting. That
is precisely why it lasted: it is the *guarantee* that was wrong, not usually the
output, which is the same reason given in the note at the end of 12.5. Both now
read:

```js
const totalDeductionsCents = items.reduce((a, i) => a + toCents(i.amount), 0);
const kept = fromCents(toCents(gross) - totalDeductionsCents);
const netRevenueBase = fromCents(toCents(gross) - toCents(refundsTotal) - toCents(passThrough));
```

`netRevenueBase` matters as much as `kept`: it is the denominator of the displayed
keep rate, so a residue there moves a percentage the owner reads against a target.

**Deliberately still fractional:** the per-day `share` / `lumpTotal` allocation
that apportions a lump deduction across days for the trend chart. It is an
apportionment, not a stated amount — forcing it to whole cents would stop the daily
slices summing to the lump they came from. Snapping the *displayed* slice
(`keptSlice`) is fine and unchanged.

Section 6 of the proof command below asserts both expressions **statically against
the component source**, not just re-implemented arithmetic, because a probe that
mirrors the formula cannot notice the original changing. All three of those static
assertions were mutation-tested against the pre-fix source and each fails on it.

```
node --import ./scripts/_loader-boot.mjs scripts/verify-money-kept.mjs   # 29/0
```

## 12.6 Real Numbers — RESOLVED 2026-08-20

Measured, not transcribed. `scripts/probe-money-kept-gross.mjs` drives the real
`scanReport` over the real fixture set and asserts every figure below (49 checks, all
green):

```
Total revenue  (Path 1, charges)      $1,020,598.17
  room leg     (Path 3, occupancy)    $1,011,258.67
  ancillary                           $    9,339.50
  1,011,258.67 + 9,339.50           = 1,020,598.17   exact
```

> [!NOTE]
> **This section previously read `Gross Revenue: $1,011,258.17`, which was wrong twice.**
> First, it was **mislabeled**: that magnitude is the room-only leg (Path 3), not gross.
> `CLAUDE.md` section 10 requires reconciliation to **$1,020,598.17**, and the two
> numbers were being read as rival claims about the same quantity when they are in fact
> two different quantities that differ by exactly the ancillary total. Second, the cents
> were off — the measured room leg is `$1,011,258.67`, not `.17`.
>
> The ancillary total is pet fees, laundry, smoking fees, restaurant, property damage,
> early check-in, misc and AR adjustments: **money the owner kept that the Money Kept
> widget did not count** until launch item #2 was fixed. Measuring deductions against
> the room leg while the hotel actually collected the total understated the keep rate,
> so the owner was shown a business less profitable than the one they were running.

The deduction lines below are carried forward from earlier documentation and are **not**
yet asserted by a probe — treat them as unverified until one drives them:

```
- OTA Commissions: -$50,287.45
- Processing Fees: -$23,816.32
- Business Taxes:  -$16,325.40
```

> [!TIP]
> **BEST OUTCOME NOTE.** Do not anchor a new assertion to a number typed into a document.
> Anchor it to a probe that derives the number from the fixtures, and let the document
> quote the probe. Several suites in this repo came to encode the very defects they were
> meant to catch because someone transcribed a snapshot out of a defective run — see
> BRAIN_TROUBLESHOOTING.md section 22. `CLAUDE.md` is protected and was not edited.

---

## 12.7 Occupancy: which column is authoritative — ADDED 2026-08-20

The Occupancy Summary prints **four** different occupancy columns. Only one is mapped
in `COLUMN_MAP`, on purpose:

```
Occupancy Including OOO Comp and House Use   -> occupancy   (MAPPED)
Occupancy Excluding OOO ...                  -> unmapped, reported as unknown_columns
Occupancy ... (two further variants)         -> unmapped, reported as unknown_columns
```

**Mapping more than one would be worse than mapping none.** `mapRow` iterates
`Object.entries`, so when two headers resolve to the same field the last column in the
row wins — column order in the export would silently decide which definition of
occupancy the dashboard shows. One mapping, chosen deliberately, is the only version of
this that is explainable to an owner.

The choice is licensed by measurement, not preference. Over the real 214-row export,
`Total Sold Rooms / Total Rooms` equals this column on **every** row (0 mismatches at
2dp), so the mapped column is the one that agrees with the two integers the night audit
reconciles. Asserted by `scripts/probe-validation-gaps.mjs` section 5.

### Precedence, and why

```
printed ratio (0.85)          -> used as-is, even if the room counts disagree
printed percent (85) + counts -> COUNTS WIN
printed percent (85), no counts -> 85 / 100
no printed value, counts      -> sold / total
neither                       -> 0, AND an `occupancy_underivable` finding
```

Audited integers outrank a printed percentage because the percentage is derived output
while the counts are reconciled inputs. A printed ratio that contradicts the counts is
left alone deliberately: that disagreement is a data-quality signal the owner should
see, not something to average away.

**Over 100% is never clamped.** `150` becomes `1.5`, not `1.0`. Occupancy above 100% is
the strongest available signal of a duplicated import; clamping it is precisely what
makes a double import invisible. See 12.3.

> [!CAUTION]
> **Before 2026-08-20 no header spelling mapped to `occupancy` at all.** Three
> consequences, all measured: every clean import raised a false `unknown_columns`
> warning naming all four columns; a file with sold rooms but no `Total Rooms` imported
> occupancy as **0** — a full hotel recorded as an empty one, which propagates into ADR
> and RevPAR; and the percent-form branch was unreachable, so it could never be tested.
> Worse, the branch's own `= 0` fallback made `occupancy` look *present* to
> `REQUIRED_FIELDS`, so such a file imported with **zero findings**. That last part is
> the dangerous one: silence read as success. The `occupancy_underivable` finding now
> escalates to ERROR when it affects every row and WARNING otherwise, mirroring
> `unparseable_dates` rather than inventing a second convention. Tracker #32 and #33.

> [!TIP]
> **BEST OUTCOME NOTE.** When an export offers several columns for one concept, map
> exactly one and let the validator keep naming the rest as unknown. The warning is not
> noise — it is the record that a choice was made and that the alternatives still exist.
> Silencing it by mapping them all hands the decision to CSV column order.

---
