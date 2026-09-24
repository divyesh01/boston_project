import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const mocks = vi.hoisted(() => ({
  useOccupancy: vi.fn(),
  useGrossRevenue: vi.fn(),
}));

vi.mock("@/lib/useHotelData", () => mocks);
vi.mock("@/lib/useGlobalFilters", () => ({
  useGlobalFilters: () => ({
    dateRange: { from: "2026-01-01", to: "2026-01-31" },
    property: "P_A",
    months: [],
  }),
}));
vi.mock("@/api/base44Client", () => ({
  db: { entities: { PayrollRun: { filter: vi.fn().mockResolvedValue([]) } } },
}));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: [], isLoading: false }) }));

import ModuleCards from "./ModuleCards.jsx";

describe("Dashboard revenue module data availability", () => {
  const empty = { data: [], isLoading: false };
  const renderCards = () => render(<MemoryRouter><ModuleCards /></MemoryRouter>);

  it("shows unavailable rather than zero when revenue and occupancy authority are absent", async () => {
    mocks.useOccupancy.mockReturnValue(empty);
    mocks.useGrossRevenue.mockReturnValue(empty);

    renderCards();

    const revenue = screen.getByRole("link", { name: /Open Executive Hub/ });
    expect(await within(revenue).findByText("N/A")).toBeInTheDocument();
  });

  it("uses Gross Revenue rows even when Occupancy Summary is absent", async () => {
    mocks.useOccupancy.mockReturnValue(empty);
    mocks.useGrossRevenue.mockReturnValue({
      ...empty,
      data: [{ property_id: "P_A", date: "2026-01-01", room_rent: 12500 }],
    });

    renderCards();

    const revenue = screen.getByRole("link", { name: /Open Executive Hub/ });
    expect(await within(revenue).findByText("$12,500")).toBeInTheDocument();
    expect(within(revenue).getByText("Gross Revenue")).toBeInTheDocument();
  });
});
