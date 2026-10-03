import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

// --- Mock only data hooks, the model presentation, and irrelevant chart/UI components.
// MoneyKept.jsx itself (and its warning guard) is NOT mocked.

vi.mock("@/lib/moneyKeptModel", () => ({
  projectRecurringExpenses: () => [],
  buildMoneyKeptBaseData: () => ({}),
  buildMoneyKeptPresentation: vi.fn(),
}));

vi.mock("@/lib/useHotelData", () => ({
  usePaymentData: () => ({ data: [] }),
  useProperties: () => ({ data: [] }),
}));

vi.mock("@/lib/useGlobalFilters", () => ({
  useGlobalFilters: () => ({ months: undefined }),
}));

vi.mock("@/hooks/useSettingsVersion", () => ({
  useSettingsVersion: () => 0,
}));

vi.mock("@/lib/commissionRates", () => ({
  getCcFeeRate: () => 0,
  getCcFeeOnRefunds: () => false,
}));

vi.mock("@/lib/useCountUp", () => ({
  CountUp: ({ as: As = "p", value, className }) =>
    React.createElement(As, { className }, value),
}));

vi.mock("@/components/charts/PieDonut", () => ({
  default: () => React.createElement("div", { "data-testid": "pie" }),
}));

vi.mock("@/components/ui-exec/Card", () => ({
  default: ({ children }) => React.createElement("div", null, children),
}));

vi.mock("@/components/dashboard/TaxCalculationBreakdown", () => ({
  default: function TaxCalculationBreakdownStub() {
    return null;
  },
}));

vi.mock("lucide-react", () => ({
  X: () => React.createElement("span"),
  Wallet: () => React.createElement("span"),
}));

vi.mock("recharts", () => {
  const stub = (name) => {
    function RechartsStub(props) {
      return React.createElement("div", { "data-testid": name }, props.children);
    }
    RechartsStub.displayName = name;
    return RechartsStub;
  };
  const nullStub = (name) => {
    function RechartsNullStub() {
      return null;
    }
    RechartsNullStub.displayName = name;
    return RechartsNullStub;
  };
  return {
    ResponsiveContainer: stub("responsive"),
    Cell: nullStub("cell"),
    Tooltip: nullStub("tooltip"),
    BarChart: stub("barchart"),
    Bar: nullStub("bar"),
    XAxis: nullStub("xaxis"),
    YAxis: nullStub("yaxis"),
    CartesianGrid: nullStub("cartesiangrid"),
    AreaChart: stub("areachart"),
    Area: nullStub("area"),
    Line: nullStub("line"),
  };
});

import MoneyKept from "./MoneyKept.jsx";
import { buildMoneyKeptPresentation } from "@/lib/moneyKeptModel";

const WARNING = /Deductions exceed gross revenue/;

function fixture({ gross, deduction, kept, pieIsGrossShare }) {
  const items =
    deduction > 0
      ? [{ key: "other", label: "Other Expenses", amount: deduction, records: [] }]
      : [];
  return {
    gross,
    grossBasis: { basis: "gross", dollars: gross },
    items,
    totalDeductions: deduction,
    kept,
    pieData: [],
    pieIsGrossShare,
    refundsTotal: 0,
    passThrough: 0,
    barData: [],
    trendData: [],
    colorByKey: new Map(),
    tax: { state: 0, city: 0, other: 0, rates: {}, calculations: [] },
    isTaxIncomplete: false,
    isPartial: false,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

function renderCase(fx) {
  vi.mocked(buildMoneyKeptPresentation).mockReturnValue(fx);
  return render(
    React.createElement(MoneyKept, {
      occRows: [],
      srcRows: [],
      grossRows: [],
      dateRange: { from: "2026-01-01", to: "2026-01-31" },
      property: null,
      aggPayRows: [],
      aggExpenses: [],
      expenses: [],
      payroll: [],
    })
  );
}

describe("MoneyKept deductions-exceed-gross warning guard", () => {
  it("gross 0 / deductions 0 / kept 0: no warning", () => {
    renderCase(fixture({ gross: 0, deduction: 0, kept: 0, pieIsGrossShare: false }));
    expect(screen.queryByText(WARNING)).toBeNull();
  });

  it("gross 100 / deductions 100 / kept 0 (break-even): no warning", () => {
    renderCase(fixture({ gross: 100, deduction: 100, kept: 0, pieIsGrossShare: false }));
    expect(screen.queryByText(WARNING)).toBeNull();
  });

  it("gross 100 / deductions 150 / kept -50 (strict loss): warning shown", () => {
    renderCase(fixture({ gross: 100, deduction: 150, kept: -50, pieIsGrossShare: false }));
    expect(screen.queryByText(WARNING)).not.toBeNull();
  });
});
