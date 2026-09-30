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
    if (!d || s.source === "demo" || s.demo === true) continue;
    // current conditions carry the actionable signal; fall back to any row.
    if (s.kind === "current" || map[d] == null) map[d] = s.condition || s.weather || map[d] || null;
  }
  return map;
}

// Compute a pricing forecast for the active property using live data.
//   days — how many days ahead (default 14)
export function usePricingForecast(days = 14) {
  const { property } = useGlobalFilters();
  const roomsQ = useRooms(property);
  const reservationsQ = useReservations(null, property);
  const snapshotsQ = useWeatherSnapshots(property);
  const { data: rooms = [] } = roomsQ;
  const { data: reservations = [] } = reservationsQ;
  const { data: snapshots = [] } = snapshotsQ;

  const config = getPricingConfig(typeof property === "string" && property !== "all" ? property : "*");
  const wByDate = useMemo(() => weatherByDate(snapshots), [snapshots]);

  const calendarToday = new Intl.DateTimeFormat("en-CA", {timeZone:"America/New_York",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
  const forecastStartDate = calendarToday;
  const isHistoricalSimulation = false;
  const unavailable = property === "all" || Array.isArray(property) || roomsQ.isPending || reservationsQ.isPending || roomsQ.isError || reservationsQ.isError;

  const forecast = useMemo(
    () =>
      unavailable ? [] : buildPricingForecast({
        rooms,
        reservations,
        weatherByDate: wByDate,
        config,
        days,
        fromDate: forecastStartDate,
      }),
    [rooms, reservations, wByDate, config, days, forecastStartDate, unavailable]
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

  return {
    forecast,
    config,
    enabled: Boolean(config.enabled),
    days,
    isError,
    error,
    refetch,
    isHistoricalSimulation,
    forecastStartDate,
    calendarToday,
  };
}
