import { describe, expect, it } from "vitest";
import {
  projectRecurringExpenses,
  buildMoneyKeptBaseData,
  buildMoneyKeptPresentation,
} from "@/lib/moneyKeptModel";

describe("moneyKeptModel recurring expenses", () => {
  it("projects a monthly series without duplicating entered dates", () => {
    const extras = projectRecurringExpenses({
      expenses: [{
        property_id: "P1",
        expense_name: "Insurance",
        category: "insurance",
        expense_date: "2026-01-31",
        amount: 100,
        recurring: true,
        frequency: "monthly",
      }],
      from: "2026-01-31",
      to: "2026-04-30",
    });

    expect(extras.map((x) => x.expense_date)).toEqual([
      "2026-02-28", "2026-03-28", "2026-04-28",
    ]);
    expect(extras.every((x) => x.amount === 100 && x.vendor === "Recurring")).toBe(true);
  });
});

describe("moneyKeptModel base calculation", () => {
  it("returns an exact zero model for an empty period", () => {
    const base = buildMoneyKeptBaseData({
      occRows: [], srcRows: [], grossRows: [], payRecords: [],
      expenses: [], payroll: [], recurringExtras: [],
      from: "2026-01-01", to: "2026-01-31",
    });

    expect(base.gross).toBe(0);
    expect(base.totalDeductions).toBe(0);
    expect(base.kept).toBe(0);
    expect(base.items).toEqual([]);
    expect(base.dayTotals).toEqual([]);
  });
});

describe("moneyKeptModel presentation", () => {
  it("allocates lump deductions by revenue share and preserves the headline total", () => {
    const data = buildMoneyKeptPresentation({
      gross: 1000,
      grossBasis: { basis: "total" },
      items: [
        { key: "taxes", label: "Business Taxes", amount: 100, records: [] },
        { key: "payroll", label: "Payroll", amount: 200, records: [] },
      ],
      totalDeductions: 300,
      kept: 700,
      from: "2026-09-01",
      to: "2026-09-30",
      tax: { state: 0, city: 0, other: 0 },
      refundsTotal: 0,
      passThrough: 0,
      dayTotals: [
        { date: "2026-09-01", gross: 600, commission: 0, ccFee: 0, refundFee: 0, deductTax: 0, refunds: 0 },
        { date: "2026-09-02", gross: 400, commission: 0, ccFee: 0, refundFee: 0, deductTax: 0, refunds: 0 },
      ],
    }, "month");

    expect(data.trendData).toEqual([{ label: "2026-09", gross: 1000, kept: 700 }]);
    expect(data.barData.map((x) => x.value)).toEqual([1000, 700]);
    expect(data.pieData.reduce((n, x) => n + x.value, 0)).toBe(1000);
    expect(data.pieIsGrossShare).toBe(true);
  });
});
