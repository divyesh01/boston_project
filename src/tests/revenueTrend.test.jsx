import { describe, it, expect } from "vitest";
import React from "react";
import { render, screen } from "@testing-library/react";
import RevenueTrend, { buildRevenueTrendData } from "@/components/dashboard/RevenueTrend";

describe("RevenueTrend Component & Data Normalizer (R13)", () => {
  it("preserves zero-revenue days instead of filtering them out", () => {
    const rows = [
      { date: "2026-03-01", room_revenue: 1200, rooms_sold: 10, rooms_available: 20 },
      { date: "2026-03-02", room_revenue: 0, rooms_sold: 0, rooms_available: 20 },
      { date: "2026-03-03", room_revenue: 1500, rooms_sold: 12, rooms_available: 20 },
    ];

    const result = buildRevenueTrendData(rows);
    expect(result).toHaveLength(3);
    expect(result[0].date).toBe("03-01");
    expect(result[0].revenue).toBe(1200);

    // Day 2 must be preserved as 0
    expect(result[1].date).toBe("03-02");
    expect(result[1].revenue).toBe(0);
    expect(result[1].occupancyPct).toBe(0);

    expect(result[2].date).toBe("03-03");
    expect(result[2].revenue).toBe(1500);
  });

  it("sorts rows chronologically when input is out of order", () => {
    const rows = [
      { date: "2026-03-10", room_revenue: 2000, rooms_sold: 15, rooms_available: 20 },
      { date: "2026-03-02", room_revenue: 1000, rooms_sold: 8, rooms_available: 20 },
      { date: "2026-03-05", room_revenue: 1500, rooms_sold: 10, rooms_available: 20 },
      { date: "2026-03-01", room_revenue: 800, rooms_sold: 6, rooms_available: 20 },
    ];

    const result = buildRevenueTrendData(rows);
    expect(result.map((r) => r.fullDate)).toEqual([
      "2026-03-01",
      "2026-03-02",
      "2026-03-05",
      "2026-03-10",
    ]);
  });

  it("aggregates multi-property rows for the same date without duplicates", () => {
    const rows = [
      // Property A on 2026-03-01
      { date: "2026-03-01", property_id: "prop-1", room_revenue: 1000, rooms_sold: 10, rooms_available: 20 },
      // Property B on 2026-03-01
      { date: "2026-03-01", property_id: "prop-2", room_revenue: 2000, rooms_sold: 15, rooms_available: 30 },
      // Property A on 2026-03-02
      { date: "2026-03-02", property_id: "prop-1", room_revenue: 1200, rooms_sold: 12, rooms_available: 20 },
    ];

    const result = buildRevenueTrendData(rows);
    expect(result).toHaveLength(2);

    // Aggregated date 2026-03-01
    expect(result[0].fullDate).toBe("2026-03-01");
    expect(result[0].revenue).toBe(3000); // 1000 + 2000
    // Combined ADR: 3000 / (10 + 15) = 120
    expect(result[0].adr).toBe(120);
    // Combined Occupancy: (10 + 15) / (20 + 30) = 25 / 50 = 50%
    expect(result[0].occupancyPct).toBe(50);

    // Single property date 2026-03-02
    expect(result[1].fullDate).toBe("2026-03-02");
    expect(result[1].revenue).toBe(1200);
    expect(result[1].adr).toBe(100);
    expect(result[1].occupancyPct).toBe(60);
  });

  it("handles empty or invalid inputs gracefully", () => {
    expect(buildRevenueTrendData([])).toEqual([]);
    expect(buildRevenueTrendData(null)).toEqual([]);
    expect(buildRevenueTrendData([{ invalid: true }])).toEqual([]);
  });

  it("renders empty state message when data is empty", () => {
    render(<RevenueTrend rows={[]} dateRange={{}} />);
    expect(screen.getByText("No daily revenue data available for the selected period")).toBeInTheDocument();
  });
});
