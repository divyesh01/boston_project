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

## 12.8 Which occupancy revenue field is populated — MEASURED 2026-08-24

Three field names on `OccupancyDay` look interchangeable and are not. Measured by running
the real `scanReport("occupancy", …, { csvText })` over
`scripts/data/Occupancy Summary midelboro.csv` — 214 rows, 2026-01-01 … 2026-08-02:

| Field | Populated? | Sum over 214 rows |
|-------|-----------|-------------------|
| `room_revenue` | all 214 rows | **$1,011,258.67** |
| `total_revenue_with_misc` | all 214 rows | **$1,011,258.67** |
| `other_room_revenue` | all 214 rows | $0.00 |
| `total_revenue` (no suffix) | **0 of 214 rows — never written by the CSV path** | — |

**Rows where `total_revenue_with_misc` differs from `room_revenue`: zero.**

> [!CAUTION]
> **The Occupancy Summary's column literally headed "Total Revenue" is a ROOM total.**
> `reportParsers.js`'s `COLUMN_MAP` maps it to `total_revenue_with_misc` deliberately, to
> keep the misleading name out of the codebase. Reading it as "total revenue" does **not**
> produce an obvious $0 — it produces a plausible-looking figure that understates the
> $1,020,598.17 ledger by exactly the $9,339.50 ancillary income. A wrong number that
> looks right is more dangerous than a zero, because nobody investigates it.

**The bare `total_revenue` field is written only by `ManualEntry.jsx`.** Any page reading
it shows **$0.00 on every imported day**. Two pages did. It was the second defect fixed in
`MonthlyCalendar.jsx` (BRAIN_FRONTEND.md 16.5), and as of 2026-08-24 it is also fixed in
`MtdGrowth.jsx`, whose headline card was labelled "Total Revenue" — see
BRAIN_TROUBLESHOOTING.md 27.1. Measured through the real parser: **0 of these 214 rows
carry the field, and `sum(rows, "total_revenue")` is exactly 0.**

**How to apply.** Do not reach for a field name. Call
`grossRevenueForPeriod({ grossRows, occRows })` in `hotel.js`: it sums the
`GrossRevenueDay` components when they cover the period, falls back to the occupancy room
ledger when they do not, and **returns `basis: "total" | "room"` so the UI can label a
room-only figure honestly.** If you must display the occupancy ledger directly, label it
"Room Revenue" — see 12.6 for why the two figures legitimately differ.

## 12.9 OTA channel commissions use the shared cent engine — MEASURED 2026-08-27

OTA dashboard and transaction totals must come from
`CalculationService.calculateChannelMetrics`, not from local JavaScript number sums.
The engine converts each amount to integer cents, calculates commission there, and returns
whole-cent gross, commission, and net totals. This matters because values such as `0.1 +
0.2` cannot be represented exactly as JavaScript numbers; repeating that arithmetic in a
screen can make a displayed commission disagree by a cent with the reconciled ledger.

`OtaChannels.jsx` and the dashboard `OtaMatrix` both delegate to this engine. The
`scripts/probe-channel-commission-cents.mjs` fixture proves the old floating-point
calculation carries binary residue and verifies that both screens keep using the shared
cent-exact path. When adding another OTA surface, reuse the engine; do not reconstruct its
totals from `net_revenue` in the component.

> [!NOTE]
> An earlier revision of this repo's notes claimed `total_revenue_with_misc` was "$0.00 on
> all 214 days — the occupancy CSV never populates them". That was wrong, and it was wrong
> in the direction that invites a bad fix: believing the field is empty makes swapping to
> it look harmless. It is populated, and it is room-only. Re-measured through the real
> parser rather than by reading the mapping table.

---

## 12.10 The HotelKey parser regression net — ADDED 2026-09-03

`src/lib/reportParsers.js` was 1,937 lines and could not safely be split, because nothing
committed to this repo proved its behaviour. (It is 1,839 lines as of extraction 1 — see
12.11.) Two things looked like coverage and were not:
`src/lib/hotelKeyRegression.test.js` imports `financialReconciliation`, `yieldOptimizer`
and `fraudScoringEngine` and **touches no parser at all** — never cite it as parser
coverage — and `scripts/test-parser.mjs`, the only test that ran a real export end to end,
read a file from a transient upload directory that is not in the repo. Delete the upload,
lose the test.

The net that replaces it is committed and self-contained:

| Path | What it is |
|---|---|
| `src/lib/__fixtures__/hotelkey/*.csv` | 10 hand-authored exports. Invented guests, invented confirmation numbers, round amounts. No PMS data. |
| `src/lib/__fixtures__/hotelkey/README.md` | What each fixture pins, how to add one, and how to read a mutation verdict. |
| `src/lib/hotelKeyParserFixtures.test.js` | 21 tests — `scanReport` only, no database. |
| `src/lib/hotelKeyImportFixtures.test.js` | 30 tests — `scanReport` → `importReport` → Dexie, through `fake-indexeddb` with a real authenticated owner. |
| `scripts/probe-hotelkey-mutations.mjs` | Reintroduces 11 real defects one at a time and asserts the suites FAIL. |

Fixtures reach the parser through `meta.csvText`, which `getRowsArray` honours ahead of any
fetch, so no file, network or upload directory is involved. The `Worker` global is replaced
by an in-process shim that calls `parser.worker.js`'s real `self.onmessage`; the shim throws
`HOTELKEY_WORKER_SHIM_UNARMED` rather than silently passing if that handler is ever absent.

**The `*.csv` blanket ignore rule nearly made this invisible.** `.gitignore` refused all ten
fixtures, so the suites would have passed locally and the corpus would never have been
committed — the exact transient-file failure it exists to remove. There is now one narrow
negation, `!src/lib/__fixtures__/**/*.csv`; `scripts/data/*.csv` and every other CSV in the
tree stay ignored. Verify with `git check-ignore -v <path>`.

### What the mutation harness proves

A suite that cannot tell the correct parser from a plausibly broken one is decoration.
Each mutation is applied by exact string replacement and reverted with `git checkout --`;
the harness refuses to start unless its target files are clean and re-checks at the end.
**11 of 11 killed** (Observed 2026-09-03). The harness also prints the names of the tests
that failed, because a mutation filed under one behaviour but killed only by an unrelated
assertion is an incidental kill, not proof of that behaviour.

| # | Defect reintroduced | Killed by |
|---|---|---|
| M1 | `addMeta` stops stamping `property_id` (`reportParsers.js#addMeta`) | property-assignment + isolation tests |
| M2 | dedupe keys assigned **before** the property stamp (`#doImport`) | stored-key equality |
| M3 | file-hash guard drops its `property_id` filter (`#doImport`) | cross-property isolation |
| M4 | occurrence index removed from the key (`transactionNorm.js:167`) | 3 byte-identical postings |
| M5 | property gate accepts whitespace (`#importReport`) | 9-case fail-closed table |
| M6 | validation gate disabled (`#importReport`) | per-layer blocked-import table |
| M7 | equal-width section tie-break reversed (`#scanTransactions`) | tied-sections fixture |
| M8 | a repeated mid-grid header treated as a header | repeated-header fixture |
| M9 | trailer rows no longer absorbed (`transactionNorm.js:196`) | revenue + checksum |
| M10 | unparseable money coerced silently (`importValidation.js:96`) | coercion log |
| M11 | ledger-side classifier loses its refund branch (`transactionNorm.js:225`) | charge/payment split |

M7 initially **SURVIVED**. Reversing the tie-break was equivalent on the corpus because no
fixture had two row-bearing sections of the same width — a hole in the net, not a passing
grade. `transactions-tied-sections.csv` closed it.

M11 did not exist in the first run. An adversarial review pointed out that the revenue
assertions read `ledger_side` — a field production assigns in one line — and that no
mutation touched that line. The suite's own comment calls it "the single most expensive
contract in the file", so the most expensive contract was also the least proven. Collapsing
the refund branch makes every row a charge and doubles revenue from $287.50 to $575.00 while
every row count stays correct, which is exactly the regression the fixture was built to
catch.

### Four behaviours pinned as hazards, deliberately not changed

1. **A same-width repeated grid is silently dropped.** Section selection uses a strict `>`
   (`reportParsers.js#scanTransactions`), so on a width tie the first grid wins and the
   second one's rows never reach `rowsToImport`. In `transactions-tied-sections.csv` that
   discards $1,035.00, and because the checksum reconciles against the winning section's own
   trailer the scan reports `matches: true`. **A balanced checksum is not evidence that the
   whole file was read.**
2. **Re-encoding a file defeats the file-level already-imported guard.** `fileHash` is taken
   over the raw text, so a CRLF or BOM variant of an imported file gets a new identity. The
   row-level `dedupe_key` still stops the duplicate rows; the cheap guard just stops helping.
   Note also that `generateFileHash` truncates SHA-256 to 32 hex chars
   (`universalParser.js:559`), keeping 128 of 256 bits.
3. **A whitespace-padded `propertyId` is stamped verbatim.** The persist gate rejects on
   `propertyId.trim() === ""` (`reportParsers.js#importReport`) but never assigns the trimmed
   value, so `" P-BOS-001 "` passes the gate and every row lands under a property id that no
   normal query matches. Pinned by *"accepts an id that only needs trimming to be non-empty"*,
   which asserts the rows are invisible under the clean id and present under the padded one. Two
   callers disagreeing about whitespace would silently split one hotel's ledger in two.
4. **The occurrence index is counted per batch, not against history.** `assignDedupeKeys`
   starts a fresh `Map` on every call (`transactionNorm.js:180`), so identical postings are
   numbered 0,1,2… within one file. Idempotence therefore depends on the same file replaying
   the same occurrences in the same order. Two *different* exports that each contain exactly
   one of two byte-identical postings both produce occurrence 0, and the second import loses
   its row to the row-level guard. No fixture covers that split; a HotelKey export covering a
   date normally carries every posting on it, which is why the design is acceptable rather
   than correct.

Hazards 1–3 are pinned by assertions, so changing any of them is a visible decision rather
than a regression. Hazard 4 is documented only — no fixture covers the split-export case, and
this note is the record of that gap. None was repaired here: the brief was to build the net
before touching the parser.

### The adversarial review, and what it changed

The net was reviewed by an independent model (Antigravity `gemini-3.8-flash-high`,
`--effort high`, read-only, workspace scoped to `src/lib` and `scripts`) asked to find where
the net fails to bite rather than to approve it. Four of its findings were accepted and are
fixed in this commit:

1. **The most expensive contract had no mutation.** → M11 above.
2. **One vacuous test.** *"blocks before the persist path"* ended each call with
   `.catch(() => {})` and then asserted both tables were empty. Any unrelated early crash
   would have satisfied it — empty tables because nothing ran. It now asserts
   `code: "IMPORT_VALIDATION_BLOCKED"` on each rejection.
3. **Two false pins.** Two comments claimed a reversed stamp order would cause *cross-property*
   data loss through the row-level guard. It would not: `existingTxnDedupeKeys` scopes its read
   to one property (`reportParsers.js#existingTxnDedupeKeys`), so the property component of
   the key is defence-in-depth, not the isolating mechanism. Both comments now say what the
   assertions actually prove.
4. **One wrong verb.** A comment said `mapTransactionRow` "floors" `amount`; the code defaults
   a null `amount` to 0 (`transactionNorm.js:219`) and floors nothing.

Rejected with reason: it called M7 an incidental kill on the grounds that 34 columns still
beat 19 under a reversed scan — true for `transactions-stacked-sections.csv`, but the tie
fixture exists precisely because reversal is otherwise unobservable, so the tie-break is the
behaviour under test rather than a side effect. It also read the revenue assertions as
filtering with test-local logic; `ledger_side` is assigned by production
(`transactionNorm.js:225`), which is what made M11 the right response instead of rewriting the
tests. Its claim that a padded `propertyId` is uncovered missed the test eight lines below the
gate it cited — hazard 3 above.

### Running it

```bash
npx vitest run src/lib/hotelKeyParserFixtures.test.js src/lib/hotelKeyImportFixtures.test.js
node scripts/probe-hotelkey-mutations.mjs
```

The suites are the gate; the harness is the proof the gate bites. Run the harness after any
edit to `reportParsers.js`, `transactionNorm.js` or `importValidation.js` — a `STALE` verdict
means an anchor moved and that mutation checked nothing.

---

## 12.11 Decomposing the parser without editing the net — ADDED 2026-09-04

12.10's net exists so `reportParsers.js` can be split. The first extraction proved the
constraint that governs the rest: **the net pins the parser's source text, so what may move
is decided by the anchors, not by what looks tidiest.** Seven of the eleven mutations are
exact strings inside that file, and a moved anchor scores `STALE` — which the harness counts
as *not killed*, because a mutation that cannot be applied has proved nothing. Six probes
additionally assert against the file as text. An extraction that disturbs either would have
to edit the safety net in the same commit as the code it guards, which inverts the proof
order and is not allowed.

**Extraction 1 (2026-09-04).** `src/lib/reportGrid.js` (NEW) takes `detectReportType`,
`dedupByKey` and `withLazyObjects` — no report-specific logic, no database, no money math —
and `reportParsers.js` imports them back. 1,937 → 1,839 lines, `1 99` numstat, zero modified
lines. Equivalence was measured against `git show HEAD:` rather than asserted: 28 checks, 0
failures, covering all 8 single-line anchors, the M3 and M7 multi-line anchors, byte-identity
of the three moved blocks, CRLF purity, and both symbols that had to stay behind.

**"Verbatim" has one exact exception, and every extraction will hit it.** All three functions
were module-**private** in `reportParsers.js` (`function dedupByKey(…)`), and a moved function
must be exported to be importable, so each declaration line gained the `export ` keyword.
Measured: the blocks are byte-identical after stripping that one prefix, and identical in
length (9 / 10 / 71 lines). So the honest claim is *byte-identical apart from the `export`
the move requires* — not literal byte-identity. An extraction gate should normalise that
prefix explicitly rather than let it pass as noise, because a gate that tolerates one
unexplained difference tolerates the next one too.

**One trap worth keeping.** `git show HEAD:<path>` returns the LF-normalised blob while the
working copy of every `src/` file here is CRLF, so a byte comparison between the two must
normalise to a common LF basis first — otherwise `split("\r\n")` yields one element, the
extracted slice is `""`, and `includes("")` reports a vacuous PASS on every block. Assert
CRLF purity separately, against the raw bytes.

**`mapRow` cannot move.** Its `COLUMN_MAP` is pinned inside `reportParsers.js` by the
source-text assertions in `probe-mtd-growth.mjs` and `probe-monthly-calendar.mjs`.

**Line-number citations in 12.10 were replaced by symbol citations** because extraction 1
shifted all eight of them — `:859` → 761, `:1476` → 1378, `:1826` → 1728 and so on. This is
tracker #58's undetectable class: still in range, so the citation gate stays green while the
reader lands on unrelated code. Five more extractions will shift them again, so the numbers
were removed rather than corrected. Line numbers for `transactionNorm.js` and
`importValidation.js` are kept — those files did not move.

Remaining order, one family per commit, each through the same chain: transaction scanner →
daily/revenue scanner → adjustments/refunds → the remaining report-specific scanners →
`reportImport.js`. `TECH_DEBT.md` section 3 carries the register.

---
