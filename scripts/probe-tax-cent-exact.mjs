// Probe (audit finding 2.2, safe part): taxConfig.calculateTax used raw float
// multiplication `rent * getTaxRate()`, so the Payments tax table carried IEEE-754
// sub-cent residue into a "tax collected" figure BUSINESS.md requires exact to the
// cent — and that number diverged from CalculationService, which computes the same
// product cent-exact via decimal.multiply.
//
// Root cause (before fix): `return rent * getTaxRate();`
//   1000.10 * 0.117 === 117.01170000000001  (a fraction of a cent that is not money)
//
// Fix: `return fromCents(multiply(rent, getTaxRate()));` — the SAME helper
// CalculationService.calculateTaxes uses (calculationService.js:285), so a taxed
// line rounds to the cent identically in both models.
//
// NOTE: this does NOT unify the two tax MODELS (the per-source flat-rate Payments
// table vs the per-property date-windowed CalculationService rates). That is a
// product decision flagged for the owner. This is only the money-math correctness
// fix, in the same class as Fixes #1/#3/#4.
//
// Run: node --import ./scripts/_loader-boot.mjs scripts/probe-tax-cent-exact.mjs

import { register } from "node:module";
register(new URL("./resolve-alias.mjs", import.meta.url));

const { calculateTax, getTaxRate } = await import("@/lib/taxConfig");
const { multiply, fromCents, sumCents } = await import("@/lib/decimal");

let pass = 0, fail = 0;
const T = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`); }
};

// Taxable source key from the default config (WALK_IN is taxable).
const TAXABLE = "WALK_IN";
const EXEMPT = "OTHER_OTA";

const isCentExact = (dollars) => Math.abs(dollars * 100 - Math.round(dollars * 100)) < 1e-9;

console.log("\n=== 0. The float residue the old code shipped ===");
{
  const rate = getTaxRate();
  const rent = 1000.10;
  const oldFloat = rent * rate;
  T("old float carried sub-cent residue", !isCentExact(oldFloat), `oldFloat=${oldFloat}`);
}

console.log("\n=== 1. calculateTax is now exact to the cent ===");
{
  const rents = [1000.10, 333.33, 12.34, 99.99, 250.55, 1_234_567.89];
  for (const rent of rents) {
    const tax = calculateTax(rent, TAXABLE);
    T(`tax on $${rent} lands on a whole cent`, isCentExact(tax), `tax=${tax}`);
    T(`tax on $${rent} matches fromCents(multiply(...))`,
      tax === fromCents(multiply(rent, getTaxRate())), `tax=${tax}`);
  }
}

console.log("\n=== 2. It matches the authoritative CalculationService math ===");
{
  // CalculationService.calculateTaxes computes `multiply(base, rate)` per line.
  const rent = 1000.10;
  const csCents = multiply(rent, getTaxRate());
  T("calculateTax equals CalculationService's per-line result",
    calculateTax(rent, TAXABLE) === fromCents(csCents), `${calculateTax(rent, TAXABLE)} vs ${fromCents(csCents)}`);
}

console.log("\n=== 3. Non-taxable source and zero rent still return 0 ===");
{
  T("exempt source is not taxed", calculateTax(1000, EXEMPT) === 0, String(calculateTax(1000, EXEMPT)));
  T("zero rent is zero tax", calculateTax(0, TAXABLE) === 0, String(calculateTax(0, TAXABLE)));
  T("non-numeric rent is zero tax", calculateTax("abc", TAXABLE) === 0, String(calculateTax("abc", TAXABLE)));
}

console.log("\n=== 4. Summing many taxed lines stays cent-exact (the table footer) ===");
{
  const rents = [1000.10, 333.33, 12.34, 99.99, 250.55];
  const taxes = rents.map((r) => calculateTax(r, TAXABLE));
  const total = fromCents(sumCents(taxes));
  T("footer total is exact to the cent", isCentExact(total), `total=${total}`);
  // Every summand is already cent-exact, so summing cents cannot reintroduce residue.
  T("no summand carried residue into the total", taxes.every(isCentExact), JSON.stringify(taxes));
}

console.log(`\n${fail === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
