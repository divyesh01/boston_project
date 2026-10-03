import { readHotelDataRows } from '@/lib/hotelDataQuery';
import { db } from '@/api/base44Client';

import { useQuery } from "@tanstack/react-query";
import { purgeExpiredUploadedReportRawRows } from '@/lib/uploadRetention';
import { getDailyAggregates, buildSyntheticRows, dateBound, DAILY_AGGREGATE_VERSION } from '@/lib/dailyAggregates';
import { mergeImportHistory } from '@/lib/importHistory';
import { fetchActiveManifests } from '@/lib/bulkImportPipeline';

export function useReservations(dateRange, propertyId) {
  return useQuery({
    queryKey: ["reservations", dateRange, propertyId],
    queryFn: async () => {
      const filter = buildFilter(null, propertyId);
      const allRes = await readHotelDataRows(db.entities.Reservation, filter);

      return allRes.filter(r => {
        if (!dateRange || (!dateRange.from && !dateRange.to)) return true;
        if (dateRange.from && r.check_out && String(r.check_out).slice(0, 10) < String(dateRange.from).slice(0, 10)) return false;
        if (dateRange.to && r.check_in && String(r.check_in).slice(0, 10) > String(dateRange.to).slice(0, 10)) return false;
        return true;
      });
    },
  });
}
// Build a server-side filter combining date range and property_id(s)
// propertyId can be: "all", a single string ID, or an array of IDs
function buildFilter(dateRange, propertyId, dateField = 'date') {
  const filter = {};
  const bound = dateBound(dateRange?.from, dateRange?.to);
  if (bound) filter[dateField] = bound;
  if (propertyId != null && propertyId !== "" && propertyId !== "all") {
    if (Array.isArray(propertyId)) {
      filter.property_id = { $in: propertyId };
    } else {
      filter.property_id = propertyId;
    }
  }
  return filter;
}

// Client-side filter: keep only rows whose date falls in one of the selected months
//
// The month is read straight out of the "YYYY-MM-DD" string. It used to go
// through `new Date(str).getMonth()`, which parses a date-only string as UTC
// midnight and then reports the month in LOCAL time — so for anyone west of
// Greenwich every 1st of the month was filed under the previous month
// (2026-02-01 came back as January). That silently moved a day of revenue
// between months on every month-filtered page.
//
// Exported so scripts/verify-transactions.mjs can pin the behaviour directly;
// nothing else outside this module should need it.
export function filterByMonths(rows, months) {
  if (!months || months.length === 0) return rows;
  const wanted = new Set(months);
  return rows.filter((r) => {
    if (!r.date) return false;
    const month = Number(String(r.date).slice(5, 7));
    return month >= 1 && wanted.has(month - 1);
  });
}

export function useOccupancy(dateRange, propertyId, months = [], enabled = true) {
  return useQuery({
    queryKey: ["occupancy", dateRange?.from, dateRange?.to, propertyId, (months || []).join(",")],
    enabled,
    queryFn: async () => {
      const filter = buildFilter(dateRange, propertyId);
      const rows = await readHotelDataRows(db.entities.OccupancyDay, filter, "date");
      return filterByMonths(rows, months);
    },
  });
}

export function useSources(dateRange, propertyId, months = []) {
  return useQuery({
    queryKey: ["sources", dateRange?.from, dateRange?.to, propertyId, (months || []).join(",")],
    queryFn: async () => {
      const filter = buildFilter(dateRange, propertyId);
      const rows = await readHotelDataRows(db.entities.SourceDay, filter, "date");
      return filterByMonths(rows, months);
    },
  });
}

// `enabled` mirrors useOccupancy above. Without it, a caller that gates on a
// compare toggle has to pass an empty range instead, which still reads the
// selected property's full history. Defaulted true so existing 3-argument
// callers are unaffected.
export function useGrossRevenue(dateRange, propertyId, months = [], enabled = true) {
  return useQuery({
    queryKey: ["gross", dateRange?.from, dateRange?.to, propertyId, (months || []).join(",")],
    enabled,
    queryFn: async () => {
      const filter = buildFilter(dateRange, propertyId);
      const rows = await readHotelDataRows(db.entities.GrossRevenueDay, filter, "date");
      return filterByMonths(rows, months);
    },
  });
}

export function useClerkRecords(dateRange, propertyId) {
  return useQuery({
    queryKey: ["clerk", dateRange?.from, dateRange?.to, propertyId],
    queryFn: async () => {
      // ClerkShiftRecord carries an indexed shift_date (YYYY-MM-DD); scope by
      // the selected period so the Clerk Audit agrees with the dashboard range.
      const filter = buildFilter(dateRange, propertyId, 'shift_date');
      const raw = await readHotelDataRows(db.entities.ClerkShiftRecord, filter, "-shift_date");
      // Deduplicate: repeated imports of the same CSV create duplicate rows.
      // Canonical key preserves record identity across imports — earliest
      // created_date wins so the oldest import's copy is kept.
      const seen = new Map();
      for (const r of raw) {
        const key = [
          r.property_id || "",
          r.record_type || "",
          r.clerk_name || "",
          r.payment_type || "",
          r.amount ?? "",
          r.shift_date || "",
        ].join("|");
        const cur = seen.get(key);
        if (!cur) {
          seen.set(key, r);
          continue;
        }
        const curCreated = new Date(cur.created_date || 0).getTime();
        const rCreated = new Date(r.created_date || 0).getTime();
        if (rCreated < curCreated || (rCreated === curCreated && Number(r.id) < Number(cur.id))) {
          seen.set(key, r);
        }
      }
      return [...seen.values()];
    },
  });
}

export function useAdjustmentsRefunds(dateRange, propertyId) {
  return useQuery({
    queryKey: ["adjustments-refunds", dateRange?.from, dateRange?.to, propertyId],
    queryFn: async () => {
      const filter = buildFilter(dateRange, propertyId);
      return readHotelDataRows(db.entities.AdjustmentRefund, filter, "date");
    },
  });
}

export function useClerkAnomalies(dateRange, propertyId) {
  return useQuery({
    queryKey: ["clerk-anomalies", dateRange?.from, dateRange?.to, propertyId],
    queryFn: async () => {
      const filter = buildFilter(null, propertyId);
      const rows = await readHotelDataRows(db.entities.AnomalyAlert, filter, "date");
      return rows.filter((r) => {
        if (!dateRange || (!dateRange.from && !dateRange.to)) return true;
        if (dateRange.from && r.date && String(r.date).slice(0, 10) < String(dateRange.from).slice(0, 10)) return false;
        if (dateRange.to && r.date && String(r.date).slice(0, 10) > String(dateRange.to).slice(0, 10)) return false;
        return true;
      });
    },
  });
}

export function usePaymentData(dateRange, propertyId, months = []) {
  return useQuery({
    queryKey: ["payments", dateRange?.from, dateRange?.to, propertyId, (months || []).join(",")],
    queryFn: async () => {
      const filter = buildFilter(dateRange, propertyId);
      const rows = await readHotelDataRows(db.entities.PaymentDay, filter, "date");
      return filterByMonths(rows, months);
    },
  });
}

export function useUploads() {
  return useQuery({
    queryKey: ["uploads"],
    queryFn: async () => {
      const rows = await db.entities.UploadedReport.list("-created_date", 50);
      // Background retention sweep: null out raw-row previews past their TTL so
      // IndexedDB stays lean. Fire-and-forget — never blocks the import history.
      purgeExpiredUploadedReportRawRows().catch(() => {});
      if (import.meta.env.VITE_USE_SERVER_DATA_SYNC !== 'true') return rows;
      const manifests = await fetchActiveManifests('', { strict: true });
      return mergeImportHistory(rows, manifests);
    },
  });
}

export function useProperties() {
  return useQuery({
    queryKey: ["properties"],
    queryFn: () => db.entities.Property.list("-created_date"),
    staleTime: 5 * 60 * 1000,
  });
}

// Fetch latest business date for a specific property (or portfolio overall)
export function useLatestDate(propertyId) {
  return useQuery({
    queryKey: ["latest-date", propertyId],
    queryFn: async () => {
      const filter = {};
      if (propertyId != null && propertyId !== "" && propertyId !== "all") {
        if (Array.isArray(propertyId)) {
          filter.property_id = { $in: propertyId };
        } else {
          filter.property_id = propertyId;
        }
      }
      const rows = await db.entities.OccupancyDay.filter(filter, "-date", 1);
      return rows.length ? String(rows[0].date).slice(0, 10) : "";
    },
    staleTime: 60 * 1000,
  });
}

// Hotel Statistics snapshots (HotelMetric).
//
// This table is shaped unlike every other one here. The rest are one row per
// day; this is one row per (snapshot date × section × metric × period), where
// period is actual_today / mtd / ly_mtd / ytd / ly_ytd. A single import writes
// ~530 rows describing ONE business date from five angles, so a "date range"
// selects which snapshots to read, not which days to sum.
//
// The table was write-only until now: imports succeeded and nothing ever read
// them back, so an uploaded statistics file vanished from the operator's point
// of view. Everything on the Statistics page comes through here.
export function useHotelMetrics(dateRange, propertyId, enabled = true) {
  return useQuery({
    queryKey: [
      "hotel-metrics",
      dateRange?.from,
      dateRange?.to,
      propertyId,
    ],
    enabled,
    queryFn: async () => {
      const filter = buildFilter(dateRange, propertyId, 'business_date');
      return readHotelDataRows(db.entities.HotelMetric, filter, "business_date");
    },
  });
}

// The snapshot dates that exist for a property, newest first.
//
// Kept separate from useHotelMetrics because the page needs to know whether ANY
// statistics have been imported even when the current date range is empty —
// otherwise "no data in this range" and "you have never imported a statistics
// file" look identical, and the operator cannot tell which problem they have.
export function useMetricDates(propertyId) {
  return useQuery({
    queryKey: ["hotel-metric-dates", propertyId],
    queryFn: async () => {
      const filter = buildFilter(null, propertyId);
      const rows = await readHotelDataRows(db.entities.HotelMetric, filter, "-business_date");
      return [...new Set(rows.map((r) => String(r.business_date || "").slice(0, 10)).filter(Boolean))]
        .sort((a, b) => (a < b ? 1 : -1));
    },
    staleTime: 60 * 1000,
  });
}

// Materialized daily financial aggregates (see src/lib/dailyAggregates.js).
// Reads the pre-summed DailyFinancialAggregate cache and reconstructs the
// synthetic per-day rows CalculationService consumes, so the Dashboard loads
// from a few hundred rows instead of scanning the raw ledgers. First checks local
// IndexedDB; if empty (fresh browser context), queries server /api/aggregates/daily
// fast-path so the dashboard paints in <1s. Returns null when both are empty so
// Fail-closed aggregate selection: portfolio (all, array selections, null/empty/unset)
// returns null so callers always query property-scoped raw ledgers. Neither local
// nor server summary proves full portfolio property/date/subledger freshness.
export function useDailyFinancialAggregates(dateRange, propertyId, enabled = true) {
  const isSingleProperty = typeof propertyId === "string" && propertyId.trim() !== "" && propertyId !== "all";

  // Use a dedicated namespace for single-property queries to avoid colliding with
  // any legacy or warm cache keys for portfolio/all/arrays.
  // In addition, select projection and explicit result projection guarantee data: null
  // when not a single property, even if old cached data exists in React Query.
  const query = useQuery({
    queryKey: [
      "daily-aggregates",
      isSingleProperty ? "single" : "portfolio-disabled",
      DAILY_AGGREGATE_VERSION,
      dateRange?.from,
      dateRange?.to,
      isSingleProperty ? propertyId : (Array.isArray(propertyId) ? propertyId.join(",") : (propertyId || "all")),
    ],
    enabled: Boolean(enabled && isSingleProperty),
    select: (data) => (isSingleProperty ? data : null),
    queryFn: async () => {
      if (!isSingleProperty) return null;

      const aggs = await getDailyAggregates({
        propertyId,
        from: dateRange?.from || "",
        to: dateRange?.to || "",
      });
      if (aggs.length) return buildSyntheticRows(aggs);

      // Fast-path for clean browser contexts: query server-authoritative daily summaries
      try {
        const propParam = propertyId;
        const url = new URL("/api/aggregates/daily", globalThis.location?.origin || "http://localhost");
        if (propParam && propParam !== "all") url.searchParams.set("property_id", propParam);
        if (dateRange?.from) url.searchParams.set("from", dateRange.from);
        if (dateRange?.to) url.searchParams.set("to", dateRange.to);

        const res = await fetch(url.toString(), { credentials: "same-origin" });
        if (res.ok) {
          const data = await res.json();
          if (data?.ok && Array.isArray(data.summaries) && data.summaries.length > 0) {
            const complete = data.summaries.every(row => {
              try { const meta = JSON.parse(row.channel_summary_json || '{}')._meta;
                return row.refund_cents === 0 && meta && ['occupancy','revenue','source','payment'].every(type=>meta.coverage?.includes(type));
              } catch {return false;}
            });
            if (complete && data.source === 'property_day_summary' && data.stale !== true) return buildSyntheticRows(data.summaries);
          }
        }
      } catch {
        // Fall back to null so caller renders from live ledgers
      }

      return null;
    },
    staleTime: 30 * 1000,
  });

  return isSingleProperty ? query : { ...query, data: null };
}

//
// Same filter/month idiom as the other hooks, so property scoping, date ranges
// and the month multi-select all behave identically to the rest of the app.
// `TransactionLine` is in PROPERTY_TABLES, so the entity proxy also enforces
// per-user property access on top of whatever filter is passed here.
//
// Rollups require every matching row. Date and property indexes narrow the
// read; an estimated row limit silently drops busy days or larger portfolios.
// All aggregation happens in transactionAnalytics.js.
export function useTransactions(dateRange, propertyId, months = [], enabled = true) {
  return useQuery({
    queryKey: [
      "transaction-lines",
      dateRange?.from,
      dateRange?.to,
      propertyId,
      (months || []).join(","),
    ],
    enabled,
    queryFn: async () => {
      const filter = buildFilter(dateRange, propertyId);
      const rows = await readHotelDataRows(db.entities.TransactionLine, filter, "date");
      return filterByMonths(rows, months);
    },
  });
}

// ─── Operational modules (features 3-6) ───

// Room master register. Scoped by property; the entity proxy also enforces
// per-user property access.
export function useRooms(propertyId) {
  return useQuery({
    queryKey: ["rooms", propertyId],
    queryFn: async () => {
      const filter = {};
      if (propertyId != null && propertyId !== "" && propertyId !== "all") {
        if (Array.isArray(propertyId)) {
          filter.property_id = { $in: propertyId };
        } else {
          filter.property_id = propertyId;
        }
      }
      return readHotelDataRows(db.entities.Room, filter, "room_number");
    },
  });
}

// Per-room nightly ledger (RoomStay). Same property/date/month idiom as the
// other hooks. Supports boardDate overlap queries so multiday stays are preserved.
export function useRoomStays(dateRange, propertyId, months = []) {
  const isSingleDate = typeof dateRange === "string";
  const targetDate = isSingleDate ? dateRange : (dateRange?.boardDate || (dateRange?.from && dateRange.from === dateRange.to ? dateRange.from : null));
  const rangeFrom = isSingleDate ? dateRange : (dateRange?.from || targetDate || "");
  const rangeTo = isSingleDate ? dateRange : (dateRange?.to || targetDate || "");

  return useQuery({
    queryKey: [
      "room-stays",
      targetDate || rangeFrom,
      targetDate || rangeTo,
      propertyId,
      (months || []).join(","),
    ],
    queryFn: async () => {
      const filter = buildFilter(null, propertyId);
      const rows = await readHotelDataRows(db.entities.RoomStay, filter, "date");

      const matching = rows.filter((r) => {
        const checkIn = String(r.check_in || r.date || "").slice(0, 10);
        const checkOut = String(r.check_out || r.date || "").slice(0, 10);
        const stayDate = String(r.date || "").slice(0, 10);

        if (targetDate) {
          if (checkIn && checkOut) {
            if (checkIn <= targetDate && checkOut > targetDate) return true;
            if (checkIn === targetDate && checkOut === targetDate) return true;
          }
          if (stayDate === targetDate) return true;
          if (checkIn === targetDate) return true;
          return false;
        }

        if (rangeFrom && checkOut && checkOut < rangeFrom) return false;
        if (rangeTo && checkIn && checkIn > rangeTo) return false;
        return true;
      });

      const aligned = targetDate
        ? matching.map((s) => (s.date === targetDate ? s : { ...s, date: targetDate, stay_date: s.date }))
        : matching;

      return filterByMonths(aligned, months);
    },
  });
}

// Housekeeping task queue.
export function useHousekeepingTasks(dateRange, propertyId) {
  const range = typeof dateRange === "string" ? { from: dateRange, to: dateRange } : dateRange;
  return useQuery({
    queryKey: [
      "housekeeping",
      range?.from,
      range?.to,
      propertyId,
    ],
    queryFn: async () => {
      const filter = buildFilter(range, propertyId, 'task_date');
      return readHotelDataRows(db.entities.HousekeepingTask, filter, "-task_date");
    },
  });
}

// Aggregated guest reviews (feature 6).
export function useReviews(dateRange, propertyId) {
  return useQuery({
    queryKey: [
      "reviews",
      dateRange?.from,
      dateRange?.to,
      propertyId,
    ],
    queryFn: async () => {
      const filter = buildFilter(dateRange, propertyId, 'review_date');
      return readHotelDataRows(db.entities.Review, filter, "-review_date");
    },
  });
}

// Cached weather snapshots (feature 5).
export function useWeatherSnapshots(propertyId) {
  return useQuery({
    queryKey: ["weather", propertyId],
    queryFn: async () => {
      const filter = {};
      if (propertyId != null && propertyId !== "" && propertyId !== "all") {
        if (Array.isArray(propertyId)) {
          filter.property_id = { $in: propertyId };
        } else {
          filter.property_id = propertyId;
        }
      }
      return readHotelDataRows(db.entities.WeatherSnapshot, filter, "-date");
    },
    staleTime: 60 * 1000,
  });
}
