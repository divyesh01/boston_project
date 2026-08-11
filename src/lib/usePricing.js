// Pricing data hook (feature 8).
//
// Assembles the live demand signals the pricing engine needs — the room
// register, the reservation book, and the cached weather snapshots — and feeds
// them to the pure buildPricingForecast() together with the operator's pricing
// config (from localStorage). The result is a per-day, per-room-type
// recommendation the Pricing page and the dashboard PricingPanel both render.
import { useMemo } from "react";
import { useRooms, useReservations, useWeatherSnapshots } from "./useHotelData";
import { useGlobalFilters } from "./useGlobalFilters";
import { getPricingConfig } from "./pricingSettings.js";
import { buildPricingForecast } from "./pricingEngine.js";

// Build a { [isoDate]: conditionString } map from cached weather snapshots so
// the engine can apply the weather signal where a snapshot exists.
function weatherByDate(snapshots) {
  const map = {};
  for (const s of snapshots || []) {
    const d = String(s.date || "").slice(0, 10);
    if (!d) continue;
    // current conditions carry the actionable signal; fall back to any row.
    if (s.kind === "current" || map[d] == null) map[d] = s.condition || s.weather || map[d] || null;
  }
  return map;
}

// Compute a pricing forecast for the active property using live data.
//   days — how many days ahead (default 14)
export function usePricingForecast(days = 14) {
  const { property, latestDate } = useGlobalFilters();
  const { data: rooms = [] } = useRooms(property);
  const { data: reservations = [] } = useReservations(null, property);
  const { data: snapshots = [] } = useWeatherSnapshots(property);

  const config = getPricingConfig();
  const wByDate = useMemo(() => weatherByDate(snapshots), [snapshots]);

  const forecast = useMemo(
    () =>
      buildPricingForecast({
        rooms,
        reservations,
        weatherByDate: wByDate,
        config,
        days,
        fromDate: latestDate || new Date().toISOString().slice(0, 10),
      }),
    [rooms, reservations, wByDate, config, days, latestDate]
  );

  return { forecast, config, enabled: Boolean(config.enabled), days };
}
