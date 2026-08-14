import { describe, it, expect } from "vitest";
import { buildTaxObject } from "@/lib/taxLiability";

describe("buildTaxObject", () => {
  const baseRecords = {
    "State Tax": [{ name: "2024-01-01", amount: 10 }],
    "City/Local Tax": [{ name: "2024-01-01", amount: 5 }],
    "Other Taxes": [{ name: "2024-01-01", amount: 2 }],
  };

  it("exposes per-jurisdiction liability amounts as numbers (not a bare total)", () => {
    const tax = buildTaxObject({
      liabState: 100,
      liabCity: 50,
      liabOther: 25,
      taxRecords: baseRecords,
      passThrough: 7,
      taxIsActual: true,
      estimatedTaxFromRates: 175,
      effectiveTaxRate: undefined,
    });

    expect(tax.state).toBe(100);
    expect(tax.city).toBe(50);
    expect(tax.other).toBe(25);
    // The UI reads tax.state + tax.city + tax.other — must be numbers.
    expect(typeof (tax.state + tax.city + tax.other)).toBe("number");
  });

  it("attaches the matching per-jurisdiction record arrays", () => {
    const tax = buildTaxObject({
      liabState: 100,
      liabCity: 50,
      liabOther: 25,
      taxRecords: baseRecords,
      passThrough: 7,
      taxIsActual: true,
      estimatedTaxFromRates: 175,
      effectiveTaxRate: undefined,
    });

    expect(tax.stateRecords).toHaveLength(1);
    expect(tax.cityRecords).toHaveLength(1);
    expect(tax.otherRecords).toHaveLength(1);
  });

  it("reports estimated=0 and keeps passThrough when taxes are actual", () => {
    const tax = buildTaxObject({
      liabState: 100,
      liabCity: 50,
      liabOther: 25,
      taxRecords: baseRecords,
      passThrough: 7,
      taxIsActual: true,
      estimatedTaxFromRates: 175,
      effectiveTaxRate: undefined,
    });

    expect(tax.estimated).toBe(0);
    expect(tax.passThrough).toBe(7);
  });

  it("reports the estimated amount and effective rate when not actual", () => {
    const tax = buildTaxObject({
      liabState: 0,
      liabCity: 0,
      liabOther: 0,
      taxRecords: {},
      passThrough: 0,
      taxIsActual: false,
      estimatedTaxFromRates: 175,
      effectiveTaxRate: 0.12,
    });

    expect(tax.estimated).toBe(175);
    expect(tax.effectiveRate).toBe(0.12);
  });
});
