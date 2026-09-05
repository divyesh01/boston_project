# HotelKey parser regression corpus

Synthetic, hand-authored HotelKey exports. **No real hotel data is in this
directory and none may be added.** Every guest name is invented, every folio and
confirmation number is fabricated, and the amounts are round test values chosen
so a wrong answer is visible by eye.

These files exist because `src/lib/reportParsers.js` (~1,900 lines) could not be
split or cleaned up safely: nothing committed proved its behavior. The only
full real-file parser test read from a transient upload directory that no longer
exists, and `src/lib/hotelKeyRegression.test.js` — despite the name — imports
`financialReconciliation`, `yieldOptimizer` and `fraudScoringEngine` and
**touches no parser at all**. Never cite that file as parser coverage.

## What consumes this directory

| Path | Layer | Tests |
| --- | --- | --- |
| `src/lib/hotelKeyParserFixtures.test.js` | scan / parse | 21 |
| `src/lib/hotelKeyImportFixtures.test.js` | import / persist / isolation | 30 |
| `scripts/probe-hotelkey-mutations.mjs` | proves the two suites bite | 11 mutations |

```bash
npx vitest run src/lib/hotelKeyParserFixtures.test.js src/lib/hotelKeyImportFixtures.test.js
```

```bash
npm run hotelkey:mutate
```

The mutation harness reintroduces one real defect at a time into
`reportParsers.js`, `transactionNorm.js` or `importValidation.js`, runs the
suites, asserts they **fail**, then restores the file from git. It refuses to
start if a target file is already dirty, and it requires a green baseline first —
otherwise a `KILLED` verdict means nothing.

Read its verdicts precisely:

- **KILLED** — the net caught the defect. This is the only passing verdict.
- **SURVIVED** — a hole in the net. The corpus cannot tell correct code from
  this specific broken code. Add a fixture; do not delete the mutation.
- **STALE** — the anchor no longer matches the source, so that mutation checked
  **nothing**. Re-anchor it. A run of nine kills and one stale is a nine-mutation
  run, not a pass.
- **RESIDUE** — the revert did not restore the file. Inspect the working tree
  before doing anything else.

## The fixtures

All transaction fixtures share one 19-column HotelKey header with `Amount` at
0-based index 13, use LF line endings, and end in a trailer row that is empty in
every column except `Amount`.

| File | Pins |
| --- | --- |
| `transactions-stacked-sections.csv` | Five stacked grids of differing width. The widest section **that has rows** wins; header-only sections are reported as skipped, not silently dropped. Also the revenue contract: charges sum to 287.50, and all rows together sum to exactly double that, so a refactor that stops splitting the ledger side double-counts visibly. |
| `transactions-tied-sections.csv` | Two grids of *equal* width, both carrying rows. Selection uses a strict `>`, so the **first** wins and the second is discarded. Pins the tie-break — and pins the hazard that the checksum then reconciles against the winning section's own trailer and reports `matches: true` while a third of the file is gone. A balanced checksum is not evidence the whole file was read. |
| `transactions-narrow-only.csv` | The same revenue must be read when the wide section is absent, so section selection is not load-bearing for the money. |
| `transactions-repeated-header.csv` | A header row repeated mid-grid is **data to reject**, not a second header. The three real postings survive and the file is blocked. |
| `transactions-dates.csv` | The five date spellings the PMS emits, plus one unreadable value that must be skipped rather than guessed. |
| `transactions-impossible-date.csv` | An impossible calendar date on an amount-only row is a **trailer**, not a skipped row — the distinction changes the checksum. |
| `transactions-malformed-money.csv` | Nine sign and formatting conventions (parentheses, trailing minus, currency symbols, thousands separators, blanks). Pins the coercion log, the integer-cents sum, and that an unparseable value is never silently zeroed. |
| `transactions-checksum-mismatch.csv` | A truncated download. Both totals and the signed difference must be named, never hidden. |
| `transactions-identical-rows.csv` | Three byte-identical postings are three real nights. The occurrence index keeps all three; the file-hash and row-level guards stop the false duplicates. |
| `occupancy-percent-branches.csv` | The five branches of the 2026-08-20 occupancy fix, including the underivable row and the refused above-1 value. This is the flat-table shape, which carries no trailer checksum. |

## Adding a fixture

1. Invent the data. If you are tempted to paste a real export, stop.
2. Keep LF endings and the 19-column header unless the point of the fixture is
   to break one of those.
3. Add the assertion to whichever suite owns the layer, then add or re-point a
   mutation in `scripts/probe-hotelkey-mutations.mjs` so the new coverage is
   proven to bite. A fixture with no mutation behind it is untested test code.
4. `.gitignore` has a blanket `*.csv` rule. It is negated for this directory
   only. Confirm a new file is actually tracked — **no output and exit 1 is the
   correct result** (it means "not ignored"); a printed rule means git will
   silently refuse to add the file:

```bash
git check-ignore -v src/lib/__fixtures__/hotelkey/your-new-file.csv
```

Narrative, hazards and the full mutation table live in
`docs/brain/BRAIN_FINANCE.md` section 12.10.
