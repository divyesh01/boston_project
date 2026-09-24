import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  useOccupancy: vi.fn(),
  useSources: vi.fn(),
  useClerkRecords: vi.fn(),
  useGrossRevenue: vi.fn(),
  usePaymentData: vi.fn(),
  useDailyFinancialAggregates: vi.fn(),
}));

vi.mock("@/lib/useHotelData", () => ({
  ...mocks,
  filterByMonths: (rows) => rows,
}));
vi.mock("@/lib/useGlobalFilters", () => ({
  useGlobalFilters: () => ({
    dateRange: { from: "2026-01-01", to: "2026-01-31" },
    property: "P_A",
    properties: [{ id: "P_A", name: "Property A", rooms: 100 }],
    compareOn: false,
    compareDateRange: { from: "", to: "" },
    compareMonths: [],
    employee: "all",
    paymentType: "all",
    channel: "all",
    months: [],
  }),
}));
vi.mock("@/hooks/usePullToRefresh", () => ({ usePullToRefresh: () => ({ pullDist: 0, refreshing: false }) }));
vi.mock("@/lib/realtime", () => ({ useRealtimeInvalidation: vi.fn() }));
vi.mock("@/api/base44Client", () => ({
  db: { entities: { Expense: { filter: vi.fn() }, PayrollRun: { filter: vi.fn() }, AnomalyAlert: { filter: vi.fn() } } },
}));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: [], isLoading: false, isError: false }) }));
vi.mock("@/components/ui-exec/KpiCard", () => ({
  default: ({ label, value, sub }) => <section role="group" aria-label={label}><span>{value}</span><small>{sub}</small></section>,
}));
vi.mock("@/components/ui-exec/Card", () => ({ default: () => null }));
vi.mock("@/components/ui-exec/Button", () => ({ default: () => null }));
vi.mock("@/components/dashboard/ClerkAudit", () => ({ default: () => null }));
vi.mock("@/components/dashboard/YieldAdvisor", () => ({ default: () => null }));
vi.mock("@/components/dashboard/RevenueTrend", () => ({ default: () => null }));
vi.mock("@/components/dashboard/PropertyRanking", () => ({ default: () => null }));
vi.mock("@/components/dashboard/LowOccAlert", () => ({ default: () => null }));
vi.mock("@/components/dashboard/ModuleCards", () => ({ default: () => null }));
vi.mock("@/components/dashboard/OtaMatrix", () => ({ default: () => null }));
vi.mock("@/components/dashboard/ExecutiveCharts", () => ({ default: () => null }));
vi.mock("@/components/dashboard/MoneyKept", () => ({ default: () => null }));
vi.mock("@/components/dashboard/WeatherPanel", () => ({ default: () => null }));
vi.mock("@/components/dashboard/PricingPanel", () => ({ default: () => null }));
vi.mock("@/components/ui/status", () => ({ ErrorState: () => null }));

import Dashboard from "./Dashboard.jsx";

describe("Dashboard data availability", () => {
  const empty = { data: [], isLoading: false, isError: false, refetch: vi.fn() };
  const configure = ({ occupancy = [], gross = [] } = {}) => {
    mocks.useOccupancy.mockReturnValue({ ...empty, data: occupancy });
    mocks.useSources.mockReturnValue(empty);
    mocks.useClerkRecords.mockReturnValue(empty);
    mocks.useGrossRevenue.mockReturnValue({ ...empty, data: gross });
    mocks.usePaymentData.mockReturnValue(empty);
    mocks.useDailyFinancialAggregates.mockReturnValue({ data: null, isLoading: false, isError: false });
  };

  it("does not present absent Gross Revenue or Occupancy authority as valid zero metrics", async () => {
    configure();

    render(<Dashboard />);

    expect(await within(screen.getByRole("group", { name: "Total Revenue" })).findByText("N/A")).toBeInTheDocument();
    expect(await within(screen.getByRole("group", { name: "Occupancy" })).findByText("N/A")).toBeInTheDocument();
    expect(await within(screen.getByRole("group", { name: "ADR / RevPAR" })).findByText("N/A")).toBeInTheDocument();
  });

  it("keeps zero-valued metrics when an authoritative report contains valid zero rows", async () => {
    configure({
      occupancy: [{ property_id: "P_A", date: "2026-01-01", total_rooms: 100, rooms_sold: 0, room_revenue: 0 }],
      gross: [{ property_id: "P_A", date: "2026-01-01", room_rent: 0 }],
    });

    render(<Dashboard />);

    expect(await within(screen.getByRole("group", { name: "Total Revenue" })).findByText("$0.00")).toBeInTheDocument();
    expect(await within(screen.getByRole("group", { name: "Occupancy" })).findByText("0.0%")).toBeInTheDocument();
    expect(await within(screen.getByRole("group", { name: "ADR / RevPAR" })).findByText("$0.00")).toBeInTheDocument();
  });

  it("shows Gross Revenue without claiming occupancy data exists", async () => {
    configure({ gross: [{ property_id: "P_A", date: "2026-01-01", room_rent: 12500 }] });

    render(<Dashboard />);

    expect(await within(screen.getByRole("group", { name: "Total Revenue" })).findByText("$12,500.00")).toBeInTheDocument();
    expect(await within(screen.getByRole("group", { name: "Occupancy" })).findByText("N/A")).toBeInTheDocument();
    expect(await within(screen.getByRole("group", { name: "ADR / RevPAR" })).findByText("N/A")).toBeInTheDocument();
  });
});
