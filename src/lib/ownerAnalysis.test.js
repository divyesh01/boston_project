import { describe, expect, it } from "vitest";
import { normalizeOwnerQuestion, priorComparableRange, requestedWeekdays, weekdayPerformanceAnalysis } from "./ownerAnalysis";

describe("owner analysis", () => {
  it("corrects only known operational words and keeps numbers intact", () => {
    const result = normalizeOwnerQuestion("whi mony low on fridy 2026-08-28?");
    expect(result.normalized).toContain("money");
    expect(result.normalized).toContain("friday");
    expect(result.normalized).toContain("2026-08-28");
    expect(result.corrections.map((correction) => correction.to)).toEqual(["why", "money", "friday"]);
  });

  it("recognizes weekday comparison requests after correction", () => {
    expect(requestedWeekdays(normalizeOwnerQuestion("monday vs fridy money").normalized)).toEqual(["Monday", "Friday"]);
  });

  it("reports facts without claiming an unproven channel cause", () => {
    const occupancyRows = [
      { date: "2026-08-24", room_revenue: 4000, rooms_sold: 40, total_rooms: 100 },
      { date: "2026-08-28", room_revenue: 7200, rooms_sold: 60, total_rooms: 100 },
    ];
    const sourceRows = [
      { date: "2026-08-24", source: "Expedia", net_revenue: 900 },
      { date: "2026-08-28", source: "Expedia", net_revenue: 2200 },
    ];
    const result = weekdayPerformanceAnalysis({ occupancyRows, sourceRows, firstDay: "Monday", secondDay: "Friday" });
    expect(result.available).toBe(true);
    expect(result.delta.revenue).toBe(3200);
    expect(result.delta.rooms).toBe(20);
    expect(result.channels[0]).toMatchObject({ name: "Expedia", change: 1300 });
  });

  it("uses the immediately preceding equal-length range for money-change analysis", () => {
    expect(priorComparableRange("2026-08-24", "2026-08-30")).toEqual({ from: "2026-08-17", to: "2026-08-23", days: 7 });
    expect(priorComparableRange("not-a-date", "2026-08-30")).toBeNull();
  });
});
