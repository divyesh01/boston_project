# Golden Hotel verification oracle

The Golden Hotel is a **committed, synthetic-only** owner dataset used to prove the
hotel's headline numbers across independent report families. It contains no real guest,
hotel, PMS, or production data.

## Fixed oracle

| Measure | Expected |
|---|---:|
| Transaction charge-side total revenue | $1,050.00 |
| Hotel Statistics YTD total revenue | $1,050.00 |
| Hotel Statistics YTD room revenue | $1,000.00 |
| Hotel Statistics YTD ancillary revenue | $50.00 |
| Occupancy room revenue | $1,000.00 |
| Direct channel room revenue | $400.00 |
| OTA channel room revenue | $600.00 |
| Direct + OTA room revenue | $1,000.00 |

The relationships are more important than the individual numbers:

```text
transactions total == statistics total == $1,050.00
statistics room + statistics ancillary == $1,000.00 + $50.00 == $1,050.00
occupancy room == source direct + source OTA == $1,000.00
```

All money assertions are integer cents. Do not replace them with floating-point epsilon
comparisons.

## Source files

- `src/lib/__fixtures__/hotelkey/golden-owner-transactions.csv`
- `src/lib/__fixtures__/hotelkey/golden-owner-occupancy.csv`
- `src/lib/__fixtures__/hotelkey/golden-owner-source.csv`
- `src/lib/__fixtures__/hotelkey/golden-owner-statistics.csv`

The files intentionally use invented names and `.invalid` email addresses.

## Automated owner journey

`src/lib/goldenHotelOwnerJourney.test.js` drives every source through the real
`scanReport -> importReport -> IndexedDB analytics` path. It proves:

1. all four files auto-detect and pass import validation;
2. expected row counts persist;
3. transaction, statistics, and occupancy revenue reconcile to the exact cent;
4. direct/OTA source contribution sums to room revenue;
5. the production revenue reconciler returns `PASS` and $1,050.00;
6. closing and reopening the database preserves the exact same owner numbers;
7. every persisted row remains property-scoped and carries import/source provenance;
8. raw SHA-256 and normalized-content SHA-256 identities are deterministic for the
   committed inputs.

Run the focused contract with:

```bash
npx vitest run src/lib/goldenHotelOwnerJourney.test.js
```

## Codex / Antigravity ownership

**Codex** owns changes to parsers, import persistence, analytics, reconciliation, and the
Golden Hotel implementation. If a product change intentionally changes one of these
numbers, Codex must explain the accounting reason before editing the oracle.

**Antigravity** owns independent verification. For changes touching imports, revenue,
dashboard KPIs, persistence, hydration, or property isolation, Antigravity should run the
focused Golden Hotel suite first, then the relevant broader gates.

For owner-facing changes, Antigravity should additionally verify the browser journey:

```text
sign in -> select Golden Hotel -> import reports -> inspect YTD/room/source numbers
-> refresh -> reopen in a fresh browser context -> confirm the same numbers
```

A browser PASS must be tied to the exact commit SHA it verified. A later implementation
commit makes the old browser PASS stale.

## Change-control rule

Do not "fix" a failing implementation by changing the oracle to match the new output.
Change these expected values only when the product/accounting contract intentionally
changes, and document why the old relationship is no longer correct.
