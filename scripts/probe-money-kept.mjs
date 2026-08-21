/**
 * PROBE: the Money Kept gross figure — its basis, and integer-cent exactness.
 *
 * WHAT WAS WRONG WITH THIS PROBE (rewritten 2026-08-20)
 * ---------------------------------------------------------------------------
 * 1. It could not fail. It printed "PRECISION LOSS DETECTED!" and then fell off
 *    the end of the function, so the process exited 0 and scripts/verify-all.mjs
 *    counted it green. It had been printing that line on every run.
 * 2. What it printed was not true. Its fixture was `[{ total_revenue: 2.05 }]`,
 *    but calculateMoneyKept reads room revenue from the occupancy ledger — it has
 *    never looked at `total_revenue`. Gross came back $0, kept came back -$2.01,
 *    and the probe reported that as a precision defect. It was a fixture defect:
 *    the arithmetic under test was never exercised.
 *
 * The original intent — prove that gross minus a same-period expense lands on the
 * exact cent — is preserved in §2 with a fixture that reaches the code, and §1 now
 * pins the gross basis so a fixture can never again silently contribute nothing.
 */
import { register } from "node:module";
register(new URL("./resolve-alias.mjs", import.meta.url));

const { CalculationService } = await import("../src/lib/calculationService.js");

const RANGE = { from: "2026-08-01", to: "2026-08-31" };
const moneyKept = ({ occ = [], gross = [], exp = [] }) =>
  CalculationService.calculateMoneyKept(occ, [], gross, [], exp, [], RANGE);

let failed = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failed += 1;
};

console.log("=== PROBE: MONEY KEPT GROSS BASIS AND CENT EXACTNESS ===");

console.log("\n1. gross reads the room ledger, and says which basis it used");
{
  const onlyTotal = moneyKept({ occ: [{ date: "2026-08-01", total_revenue: 2.05 }] });
  check(
    "a row carrying only total_revenue contributes nothing to gross",
    onlyTotal.gross === 0,
    `got ${onlyTotal.gross} — if this now passes revenue through, the basis changed and MoneyKept.jsx's banner must change with it`,
  );

  const roomOnly = moneyKept({ occ: [{ date: "2026-08-01", room_revenue: 2.05 }] });
  check("room_revenue is the room-ledger basis", roomOnly.gross === 2.05, `got ${roomOnly.gross}`);
  check('basis is reported as "room" when no gross rows cover the period', roomOnly.grossBasis.basis === "room", `got ${roomOnly.grossBasis.basis}`);

  // The gross-charge ledger adds ancillary revenue on top of the room ledger.
  // This is the same helper (hotel.js#grossRevenueForPeriod) the dashboard widget
  // calls, which is the point: before 2026-08-20 this service ignored grossRows
  // for the gross figure and reported a different headline number than the widget.
  const withAncillary = moneyKept({
    occ: [{ date: "2026-08-01", room_revenue: 2.05 }],
    gross: [{ date: "2026-08-01", room_rent: 2.05, misc_charge: 0.1, food: 0.2 }],
  });
  check("ancillary charges are added when the gross ledger covers the period", withAncillary.gross === 2.35, `got ${withAncillary.gross}`);
  check('basis is reported as "total" once gross rows exist', withAncillary.grossBasis.basis === "total", `got ${withAncillary.grossBasis.basis}`);
  check(
    "room_rent on the gross row does not double-count the room night",
    withAncillary.grossBasis.roomCents === 205,
    `got ${withAncillary.grossBasis.roomCents} cents`,
  );
  check(
    "non-revenue columns are excluded by name, not by value",
    moneyKept({
      occ: [{ date: "2026-08-01", room_revenue: 2.05 }],
      gross: [{ date: "2026-08-01", non_revenue: 500, advance_deposit: 250 }],
    }).gross === 2.05,
  );
}

console.log("\n2. gross minus a same-period expense lands on the exact cent");
{
  // 2.05 - 2.01 left-folds to 0.040000000000000036 in float (measured, node 22).
  const res = moneyKept({
    occ: [{ date: "2026-08-01", room_revenue: 2.05 }],
    exp: [{ category: "maintenance", expense_date: "2026-08-01", amount: 2.01 }],
  });
  check("operating expenses are exactly 2.01", res.operatingExpenses === 2.01, `got ${res.operatingExpenses}`);
  check("kept is exactly 0.04, not 0.040000000000000036", res.kept === 0.04, `got ${res.kept}`);
  check("kept is reproducible through totalDeductions", res.kept === Math.round((res.gross - res.totalDeductions) * 100) / 100);
}

console.log("\n3. an out-of-period expense cannot reduce this period's kept");
{
  const res = moneyKept({
    occ: [{ date: "2026-08-01", room_revenue: 2.05 }],
    exp: [{ category: "maintenance", expense_date: "2026-07-31", amount: 2.01 }],
  });
  check("July's invoice leaves August alone", res.kept === 2.05, `got ${res.kept}`);
}

if (failed > 0) {
  console.error(`\nFAIL: ${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nPASSED: all checks passed");
process.exit(0);
