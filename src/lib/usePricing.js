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
import { getEnterpriseConfig, getPropertyProfile } from './enterpriseConfigEngine.js';
import { propertyLocalDate } from './businessDate.js';
import { singleSelectedProperty } from './propertySelection.js';
import { useSettingsVersion } from '@/hooks/useSettingsVersion';

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
  const { property, properties, latestDate } = useGlobalFilters();
  const settingsVersion = useSettingsVersion();
  const selectedProperty = singleSelectedProperty(property, properties);
  const propertyId = selectedProperty?.id ?? null;
  const roomsQ = useRooms(property);
  const reservationsQ = useReservations(null, property);
  const snapshotsQ = useWeatherSnapshots(property);
  const { data: rooms = [] } = roomsQ;
  const { data: reservations = [] } = reservationsQ;
  const { data: snapshots = [] } = snapshotsQ;

  const config = useMemo(() => getPricingConfig(propertyId ?? '*'), [propertyId, settingsVersion]);
  const wByDate = useMemo(() => weatherByDate(snapshots), [snapshots]);

  const profile = propertyId == null ? null : getPropertyProfile(propertyId);
  const clockConfigured = Boolean(profile?.timezone || profile?.current_business_date);
  const calendarToday = profile?.timezone ? propertyLocalDate(profile.timezone) : profile?.current_business_date || new Date().toISOString().slice(0, 10);
  const forecastStartDate = profile?.current_business_date || calendarToday;
  const policyForDate = useMemo(() => date => getEnterpriseConfig(propertyId, date, selectedProperty || {}), [propertyId, selectedProperty, settingsVersion]);
  const isHistoricalSimulation = false;
  const unavailable = propertyId == null || roomsQ.isPending || reservationsQ.isPending || roomsQ.isError || reservationsQ.isError;

  const forecast = useMemo(
    () =>
      unavailable ? [] : buildPricingForecast({
        rooms,
        reservations,
        weatherByDate: wByDate,
        config,
        days,
        fromDate: forecastStartDate,
        policyForDate,
      }),
    [rooms, reservations, wByDate, config, days, forecastStartDate, unavailable, policyForDate]
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
    availabilityMessage: propertyId == null ? "Select one property for pricing recommendations." : roomsQ.isPending || reservationsQ.isPending ? "Loading room inventory and reservations…" : "No room register yet. Create one on the Room Board.",
    freshnessNotice: `${!clockConfigured ? 'Configure the property time zone and business date; this preview uses UTC dates. ' : ''}${latestDate && latestDate < calendarToday ? `Imported financial data ends ${latestDate}. ` : ''}Rates are model estimates from the stored room register and reservation book; confirm current bookings before use.`,
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
