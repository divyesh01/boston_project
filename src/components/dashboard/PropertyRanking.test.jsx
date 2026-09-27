import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import PropertyRanking from "./PropertyRanking";

describe("PropertyRanking portfolio totals", () => {
  it("uses the property day capacity when calculating portfolio occupancy", () => {
    const properties = [
      { id: "A", name: "Hotel A", rooms: 100 },
      { id: "B", name: "Hotel B", rooms: 80 },
    ];
    const occRows = [
      { property_id: "A", date: "2026-01-01", room_revenue: 5000, rooms_sold: 100, total_rooms: 200 },
      { property_id: "B", date: "2026-01-01", room_revenue: 2500, rooms_sold: 50, total_rooms: 100 },
    ];

    const html = renderToStaticMarkup(<PropertyRanking occRows={occRows} properties={properties} />);
    const portfolioRow = html.match(/Portfolio Total[\s\S]*?<\/tr>/)?.[0];

    expect(portfolioRow).toContain(">50.0%</td>");
    expect(portfolioRow).toContain(">$50.00</td>");
    expect(portfolioRow).toContain(">$25.00</td>");
  });
});
