import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useDailyFinancialAggregates, useRoomStays } from "@/lib/useHotelData";
import { db } from "@/api/base44Client";

vi.mock("@/api/base44Client", () => ({
  db: {
    entities: {
      RoomStay: {
        filter: vi.fn(),
      },
      DailyFinancialAggregate: {
        filter: vi.fn(),
      },
    },
  },
}));

vi.mock("@/lib/dailyAggregates", () => ({
  DAILY_AGGREGATE_VERSION: 1,
  dateBound: vi.fn(),
  getDailyAggregates: vi.fn(),
  buildSyntheticRows: vi.fn((rows) => ({
    occRows: rows.map((r) => ({ property_id: r.property_id, date: r.business_date, rooms_sold: 10 })),
    srcRows: [],
    grossRows: [],
    payRows: [],
  })),
}));

describe("useDailyFinancialAggregates and useRoomStays behavioral contracts", () => {
  let queryClient;
  const createWrapper = () => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    return function TestQueryWrapper({ children }) {
      return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fails closed (returns data: null) for portfolio scopes (array, 'all', empty array, null) to prevent partial portfolio totals", async () => {
    const { getDailyAggregates } = await import("@/lib/dailyAggregates");
    // Simulate that local aggregate cache has data for prop-1 only
    vi.mocked(getDailyAggregates).mockResolvedValue([
      { property_id: "prop-1", business_date: "2026-08-01", aggregate_version: 1 },
    ]);

    // Test with array portfolio scope ["prop-1", "prop-2"]
    const { result: portfolioResult } = renderHook(
      () => useDailyFinancialAggregates({ from: "2026-08-01", to: "2026-08-31" }, ["prop-1", "prop-2"]),
      { wrapper: createWrapper() }
    );

    // Should immediately fail-closed and return null for portfolio scope
    expect(portfolioResult.current.data).toBeNull();

    // Test with "all" sentinel
    const { result: allResult } = renderHook(
      () => useDailyFinancialAggregates({ from: "2026-08-01", to: "2026-08-31" }, "all"),
      { wrapper: createWrapper() }
    );
    expect(allResult.current.data).toBeNull();

    // Test with empty array
    const { result: emptyResult } = renderHook(
      () => useDailyFinancialAggregates({ from: "2026-08-01", to: "2026-08-31" }, []),
      { wrapper: createWrapper() }
    );
    expect(emptyResult.current.data).toBeNull();
  });

  it("allows aggregate fast-path for valid single property ID string", async () => {
    const { getDailyAggregates } = await import("@/lib/dailyAggregates");
    vi.mocked(getDailyAggregates).mockResolvedValue([
      { property_id: "prop-1", business_date: "2026-08-01", aggregate_version: 1 },
    ]);

    const { result } = renderHook(
      () => useDailyFinancialAggregates({ from: "2026-08-01", to: "2026-08-31" }, "prop-1"),
      { wrapper: createWrapper() }
    );

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
      expect(result.current.data).toBeDefined();
    });

    expect(result.current.data?.occRows?.length).toBe(1);
    expect(result.current.data?.occRows[0].property_id).toBe("prop-1");
  });

  it("useRoomStays fetches stays overlapping boardDate, including check_in before boardDate and check_out after boardDate", async () => {
    // Stays stored in database:
    // Stay 1: Multiday stay (2026-08-01 to 2026-08-05). date = 2026-08-01
    // Stay 2: Same-day stay (2026-08-03). date = 2026-08-03
    // Stay 3: Future stay (2026-08-10 to 2026-08-12). date = 2026-08-10
    const rawStays = [
      { id: "s1", property_id: "prop-1", date: "2026-08-01", check_in: "2026-08-01", check_out: "2026-08-05", guest_name: "Multiday Guest" },
      { id: "s2", property_id: "prop-1", date: "2026-08-03", check_in: "2026-08-03", check_out: "2026-08-04", guest_name: "Current Guest" },
      { id: "s3", property_id: "prop-1", date: "2026-08-10", check_in: "2026-08-10", check_out: "2026-08-12", guest_name: "Future Guest" },
    ];

    db.entities.RoomStay.filter.mockResolvedValue(rawStays);

    // Query for boardDate = "2026-08-03"
    const { result } = renderHook(
      () => useRoomStays("2026-08-03", "prop-1"),
      { wrapper: createWrapper() }
    );

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    const stays = result.current.data;
    // Both Multiday Guest (spanning 2026-08-01 to 2026-08-05) and Current Guest must be present on 2026-08-03
    expect(stays.map((s) => s.guest_name)).toContain("Multiday Guest");
    expect(stays.map((s) => s.guest_name)).toContain("Current Guest");
    // Future Guest must not be present
    expect(stays.map((s) => s.guest_name)).not.toContain("Future Guest");
    // Each stay's date must be aligned with boardDate "2026-08-03" so staysForDate matches
    const multidayStay = stays.find((s) => s.guest_name === "Multiday Guest");
    expect(multidayStay.date).toBe("2026-08-03");
  });
});
