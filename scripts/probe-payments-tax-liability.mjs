// Probe (audit finding 2.2): the Payments "Tax Management" card used to apply ONE
// flat legacy rate to every booking source (taxConfig.calculateTax per TAX_SOURCE),
// a per-channel ESTIMATE that diverged from the reconciled tax the MoneyKept
// dashboard deducts. The owner chose to REPLACE that table with the authoritative
// per-property, date-windowed engine — CalculationService.calculateTaxLiability —
// the SAME call MoneyKept routes through, so the two pages can never print a
// different tax figure for the same period.
//
// Payments.jsx now renders taxLiability = CalculationService.calculateTaxLiability(
//   srcRows, grossRows, resolvedPropertyId, dateRange). This probe pins the
// contract that card depends on:
//   - every returned figure is exact to the cent (BUSINESS.md: no float residue),
//   - total === state + city + other,
//   - total === imported + estimated (each date lands in exactly one bucket),
//   - PMS-imported tax lines take precedence per date; days with no imported tax
//     are estimated from the property's effective rates (base × rate, cent-exact),
//   - and the estimated portion equals an independent cent-exact reconstruction
//     built from the SAME rates/base the MoneyKept widget uses — the reconciliation.
//
// Pure logic (no DOM/Worker), but calculationService.js imports via the @/lib alias,
// so run WITH the alias loader:
//   node --import ./scripts/_loader-boot.mjs scripts/probe-payments-tax-liability.mjs

import { CalculationService } from "../src/lib/calculationService.js";
import { setTaxConfig } from "../src/lib/taxConfig.js";
import { saveTaxSettings, getEffectiveTaxRates } from "../src/lib/taxSettings.js";
import { toCents, fromCents, multiply } from "../src/lib/decimal.js";

// settingsStore reads localStorage; absent under node → provide a real store so
// setTaxConfig/saveTaxSettings persist and calculateTaxLiability sees a config.
if (!globalThis.localStorage) {
  const store = {};
  globalThis.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    clear: () => { for (const k of Object.keys(store)) delete store[k]; },
  };
}

let pass = 0, fail = 0;
const T = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`); }
};
const isCentExact = (d) => Math.abs(d * 100 - Math.round(d * 100)) < 1e-9;

// ── Fixture ──────────────────────────────────────────────────────────────────
// Tax must be BOTH enabled and configured, or calculateTaxLiability short-circuits
// to an all-zero object and every assertion below would pass vacuously.
const RATES = { state: 0.07, city: 0.035, other: 0.012 };
setTaxConfig({ taxRate: RATES.state, taxEnabled: true });
saveTaxSettings([
  { property_id: "*", state_rate: RATES.state, city_rate: RATES.city, other_rate: RATES.other, effective_start: "2020-01-01" },
]);

const RANGE = { from: "2026-01-01", to: "2026-01-03" };

// Day 1: taxable source WITH an imported PMS tax line → pass-through (imported).
// Day 2: taxable source with NO imported tax → estimated from effective rates.
// Day 3: an exempt source (OTHER_OTA) → contributes no base, no tax.
const SRC = [
  { date: "2026-01-01", source: "EXPEDIA HOTEL COLLECT", net_revenue: 1000, property_id: "" },
  { date: "2026-01-02", source: "WALK IN", net_revenue: 500, property_id: "" },
  { date: "2026-01-03", source: "OTHER OTA", net_revenue: 999, property_id: "" },
];
const GROSS = [
  { date: "2026-01-01", state_tax: 70, city_tax: 35, other_tax: 12, property_id: "" },
];

const L = CalculationService.calculateTaxLiability(SRC, GROSS, "", RANGE);

console.log("\n=== 1. Every returned figure is exact to the cent ===");
for (const k of ["state", "city", "other", "total", "imported", "estimated"]) {
  T(`${k} lands on a whole cent`, isCentExact(L[k]), `${k}=${L[k]}`);
}

console.log("\n=== 2. total === state + city + other (bucket sum) ===");
T("total reconciles to the three buckets",
  toCents(L.total) === toCents(L.state) + toCents(L.city) + toCents(L.other),
  JSON.stringify(L));

console.log("\n=== 3. total === imported + estimated (each date in one bucket) ===");
T("imported + estimated equals total",
  toCents(L.imported) + toCents(L.estimated) === toCents(L.total),
  `imported=${L.imported} estimated=${L.estimated} total=${L.total}`);

console.log("\n=== 4. PMS-imported tax takes precedence on day 1 ===");
{
  // Day 1 carried an imported tax line, so its whole 70+35+12 is pass-through and
  // NONE of it is estimated. Imported total must be exactly day 1's PMS tax.
  T("imported equals day-1 PMS tax (70+35+12)", L.imported === 117, `imported=${L.imported}`);
}

console.log("\n=== 5. Day 2 (no imported tax) is estimated cent-exactly from the rates ===");
{
  // The reconciliation: rebuild day 2's estimate from the SAME base × rate the
  // engine (and the MoneyKept widget) use, via the SAME decimal.multiply helper.
  const base = 500; // WALK_IN net_revenue, taxable
  const r = getEffectiveTaxRates("", "2026-01-02");
  const estCents = multiply(base, r.state) + multiply(base, r.city) + multiply(base, r.other);
  T("estimated equals base × effective rates, to the cent",
    toCents(L.estimated) === estCents, `estimated=${L.estimated} expected=${fromCents(estCents)}`);
  // 500 × (0.07+0.035+0.012) = 500 × 0.117 = 58.50
  T("estimated is the expected $58.50", L.estimated === 58.5, `estimated=${L.estimated}`);
}

console.log("\n=== 6. Exempt source (day 3) adds no tax ===");
{
  // Rebuild the whole thing WITHOUT day 3 — the exempt OTHER_OTA row must not move
  // any figure, proving it contributed no taxable base.
  const withoutExempt = CalculationService.calculateTaxLiability(SRC.slice(0, 2), GROSS, "", RANGE);
  T("dropping the exempt row leaves the total unchanged",
    withoutExempt.total === L.total, `with=${L.total} without=${withoutExempt.total}`);
}

console.log("\n=== 7. Disabled / unconfigured tax returns an all-zero object ===");
{
  setTaxConfig({ taxRate: RATES.state, taxEnabled: false });
  const off = CalculationService.calculateTaxLiability(SRC, GROSS, "", RANGE);
  T("every key is 0 when tax is disabled",
    ["state", "city", "other", "total", "imported", "estimated"].every((k) => off[k] === 0),
    JSON.stringify(off));
  setTaxConfig({ taxRate: RATES.state, taxEnabled: true }); // restore
}

console.log("\n=== 8. Out-of-range dates are excluded ===");
{
  // Narrow the range to day 1 only: day 2's estimate must drop out entirely.
  const day1Only = CalculationService.calculateTaxLiability(SRC, GROSS, "", { from: "2026-01-01", to: "2026-01-01" });
  T("range clamp drops day-2 estimate", day1Only.estimated === 0 && day1Only.imported === 117,
    JSON.stringify(day1Only));
}

console.log(`\n${fail === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
