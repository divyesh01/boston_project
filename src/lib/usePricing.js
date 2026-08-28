// Pricing data hook (feature 8).
//
// Assembles the local model inputs the pricing engine needs — the room
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

// Compute a local pricing scenario; these records are not verified live feeds.
//   days — how many days ahead (default 14)
export function usePricingForecast(days = 14) {
  const { property, latestDate } = useGlobalFilters();
  const roomsQ = useRooms(property);
  const reservationsQ = useReservations(null, property);
  const snapshotsQ = useWeatherSnapshots(property);
  const { data: rooms = [] } = roomsQ;
  const { data: reservations = [] } = reservationsQ;
  const { data: snapshots = [] } = snapshotsQ;

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

  // The three reads have to be reported to the caller, not just consumed. Each of
  // them fails into an empty array, and buildPricingForecast() answers an empty
  // array the same way it answers a genuinely quiet week: with base rates, a
  // default occupancy assumption and a full 14-day rate card. A recommended rate
  // computed from a reservation book that failed to load is a guess wearing the
  // costume of a recommendation, so Pricing and PricingPanel need to be able to
  // say so.
  const isError = roomsQ.isError || reservationsQ.isError || snapshotsQ.isError;
  const error = roomsQ.error || reservationsQ.error || snapshotsQ.error;
  const refetch = () => {
    roomsQ.refetch();
    reservationsQ.refetch();
    snapshotsQ.refetch();
  };

  const isLoading = roomsQ.isLoading || reservationsQ.isLoading || snapshotsQ.isLoading;
  return { forecast, config, enabled: Boolean(config.enabled), days, isLoading, isError, error, refetch };
}
