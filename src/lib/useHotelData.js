import { db } from '@/api/base44Client';

import { useQuery } from "@tanstack/react-query";
import { purgeExpiredUploadedReportRawRows } from '@/lib/uploadRetention';
import { getDailyAggregates, buildSyntheticRows } from '@/lib/dailyAggregates';

export function useReservations(dateRange, propertyId) {
  return useQuery({
    queryKey: ["reservations", dateRange, propertyId],
    queryFn: async () => {
      const filter = {};
      if (propertyId && propertyId !== "all") {
        if (Array.isArray(propertyId)) {
          if (propertyId.length > 0) filter.property_id = { $in: propertyId };
        } else {
          filter.property_id = propertyId;
        }
      }
      const allRes = await db.entities.Reservation.filter(filter);
      
      return allRes.filter(r => {
        if (!dateRange || (!dateRange.from && !dateRange.to)) return true;
        if (dateRange.from && r.check_out && new Date(r.check_out) < new Date(dateRange.from)) return false;
        if (dateRange.to && r.check_in && new Date(r.check_in) > new Date(dateRange.to)) return false;
        return true;
      });
    },
  });
}
// Build a server-side filter combining date range and property_id(s)
// propertyId can be: "all", a single string ID, or an array of IDs
function buildFilter(dateRange, propertyId) {
  const filter = {};
  if (dateRange?.from && dateRange?.to) {
    filter.date = { $gte: dateRange.from, $lte: dateRange.to };
  }
  if (propertyId && propertyId !== "all") {
    if (Array.isArray(propertyId)) {
      if (propertyId.length > 0) filter.property_id = { $in: propertyId };
    } else {
      filter.property_id = propertyId;
    }
  }
  return filter;
}

// Calculate an intelligent row limit based on date range and portfolio size to prevent over-fetching
function getDynamicLimit(dateRange, propertyId, fallbackLimit = 100000) {
  if (!dateRange || !dateRange.from || !dateRange.to) return fallbackLimit;
  
  const from = new Date(dateRange.from);
  const to = new Date(dateRange.to);
  if (isNaN(from.valueOf()) || isNaN(to.valueOf())) return fallbackLimit;
  
  const days = Math.max(1, Math.ceil((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24)));
  
  // Assume ~5 records per day per property max for most entities (to leave room for duplicates/adjustments)
  const multiplier = 5; 
  let propCount = 50; // Max properties assumption for 'all'
  
  if (propertyId && propertyId !== "all") {
    propCount = Array.isArray(propertyId) ? propertyId.length : 1;
  }
  
  // Add base buffer of 1000, cap at fallbackLimit
  return Math.min(fallbackLimit, (days + 2) * propCount * multiplier + 1000);
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
      const limit = getDynamicLimit(dateRange, propertyId);
      let rows;
      if (filter.date) {
        rows = await db.entities.OccupancyDay.filter(filter, "date", limit);
      } else {
        rows = await db.entities.OccupancyDay.list("date", limit);
      }
      return filterByMonths(rows, months);
    },
  });
}

export function useSources(dateRange, propertyId, months = []) {
  return useQuery({
    queryKey: ["sources", dateRange?.from, dateRange?.to, propertyId, (months || []).join(",")],
    queryFn: async () => {
      const filter = buildFilter(dateRange, propertyId);
      const limit = getDynamicLimit(dateRange, propertyId);
      let rows;
      if (filter.date) {
        rows = await db.entities.SourceDay.filter(filter, "date", limit);
      } else {
        rows = await db.entities.SourceDay.list("date", limit);
      }
      return filterByMonths(rows, months);
    },
  });
}

// `enabled` mirrors useOccupancy above. Without it, a caller that gates on a
// compare toggle has to pass an empty range instead — and an empty range makes
// buildFilter produce no `filter.date`, which falls to the unfiltered
// GrossRevenueDay.list() branch: a full-table read whose rows are then thrown
// away. Defaulted true so the existing 3-argument callers are unaffected.
export function useGrossRevenue(dateRange, propertyId, months = [], enabled = true) {
  return useQuery({
    queryKey: ["gross", dateRange?.from, dateRange?.to, propertyId, (months || []).join(",")],
    enabled,
    queryFn: async () => {
      const filter = buildFilter(dateRange, propertyId);
      const limit = getDynamicLimit(dateRange, propertyId);
      let rows;
      if (filter.date) {
        rows = await db.entities.GrossRevenueDay.filter(filter, "date", limit);
      } else {
        rows = await db.entities.GrossRevenueDay.list("date", limit);
      }
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
      const filter = {};
      if (dateRange?.from && dateRange?.to) {
        filter.shift_date = { $gte: dateRange.from, $lte: dateRange.to };
      }
      if (propertyId && propertyId !== "all") {
        if (Array.isArray(propertyId)) {
          if (propertyId.length > 0) filter.property_id = { $in: propertyId };
        } else {
          filter.property_id = propertyId;
        }
      }
      const limit = getDynamicLimit(dateRange, propertyId, 100000);
      const raw = await db.entities.ClerkShiftRecord.filter(filter, "-shift_date", limit);
      // Deduplicate: repeated imports of the same CSV create duplicate rows.
      // Canonical key preserves record identity across imports — earliest
      // created_date wins so the oldest import's copy is kept.
      const seen = new Map();
      for (const r of raw) {
        const key = [
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
      const limit = getDynamicLimit(dateRange, propertyId);
      if (filter.date) {
        return db.entities.AdjustmentRefund.filter(filter, "date", limit);
      }
      return db.entities.AdjustmentRefund.list("date", limit);
    },
  });
}

export function useClerkAnomalies(dateRange, propertyId) {
  return useQuery({
    queryKey: ["clerk-anomalies", dateRange?.from, dateRange?.to, propertyId],
    queryFn: async () => {
      const filter = {};
      if (propertyId && propertyId !== "all") {
        if (Array.isArray(propertyId)) {
          if (propertyId.length > 0) filter.property_id = { $in: propertyId };
        } else {
          filter.property_id = propertyId;
        }
      }
      const limit = getDynamicLimit(dateRange, propertyId);
      const rows = await db.entities.AnomalyAlert.filter(filter, "date", limit);
      return rows.filter((r) => {
        if (!dateRange || (!dateRange.from && !dateRange.to)) return true;
        if (dateRange.from && r.date && r.date < dateRange.from) return false;
        if (dateRange.to && r.date && r.date > dateRange.to) return false;
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
      const limit = getDynamicLimit(dateRange, propertyId);
      let rows;
      if (filter.date) {
        rows = await db.entities.PaymentDay.filter(filter, "date", limit);
      } else {
        rows = await db.entities.PaymentDay.list("date", limit);
      }
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
      return rows;
    },
  });
}

export function useProperties() {
  return useQuery({
    queryKey: ["properties"],
    queryFn: () => db.entities.Property.list("-created_date", 100),
    staleTime: 5 * 60 * 1000,
  });
}

// Fetch latest business date for a specific property (or portfolio overall)
export function useLatestDate(propertyId) {
  return useQuery({
    queryKey: ["latest-date", Array.isArray(propertyId) ? propertyId.join(",") : propertyId],
    queryFn: async () => {
      const filter = {};
      if (propertyId && propertyId !== "all") {
        if (Array.isArray(propertyId)) {
          if (propertyId.length > 0) filter.property_id = { $in: propertyId };
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
      Array.isArray(propertyId) ? propertyId.join(",") : propertyId,
    ],
    enabled,
    queryFn: async () => {
      const filter = {};
      if (dateRange?.from && dateRange?.to) {
        filter.business_date = { $gte: dateRange.from, $lte: dateRange.to };
      }
      if (propertyId && propertyId !== "all") {
        if (Array.isArray(propertyId)) {
          if (propertyId.length > 0) filter.property_id = { $in: propertyId };
        } else {
          filter.property_id = propertyId;
        }
      }
      return db.entities.HotelMetric.filter(filter, "business_date", 200000);
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
    queryKey: ["hotel-metric-dates", Array.isArray(propertyId) ? propertyId.join(",") : propertyId],
    queryFn: async () => {
      const filter = {};
      if (propertyId && propertyId !== "all") {
        if (Array.isArray(propertyId)) {
          if (propertyId.length > 0) filter.property_id = { $in: propertyId };
        } else {
          filter.property_id = propertyId;
        }
      }
      const rows = await db.entities.HotelMetric.filter(filter, "-business_date", 200000);
      return [...new Set(rows.map((r) => String(r.business_date || "").slice(0, 10)).filter(Boolean))]
        .sort((a, b) => (a < b ? 1 : -1));
    },
    staleTime: 60 * 1000,
  });
}

// Materialized daily financial aggregates (see src/lib/dailyAggregates.js).
//
// Reads the pre-summed DailyFinancialAggregate cache and reconstructs the
// synthetic per-day rows CalculationService consumes, so the Dashboard loads
// from a few hundred rows instead of scanning the raw ledgers. Returns null
// when the cache is empty so callers can fall back to live computation.
export function useDailyFinancialAggregates(dateRange, propertyId, enabled = true) {
  return useQuery({
    queryKey: ["daily-aggregates", dateRange?.from, dateRange?.to, Array.isArray(propertyId) ? propertyId.join(",") : propertyId],
    enabled,
    queryFn: async () => {
      const aggs = await getDailyAggregates({
        propertyId,
        from: dateRange?.from || "",
        to: dateRange?.to || "",
      });
      if (!aggs.length) return null;
      return buildSyntheticRows(aggs);
    },
    staleTime: 30 * 1000,
  });
}

//
// Same filter/month idiom as the other hooks, so property scoping, date ranges
// and the month multi-select all behave identically to the rest of the app.
// `TransactionLine` is in PROPERTY_TABLES, so the entity proxy also enforces
// per-user property access on top of whatever filter is passed here.
//
// The limit is deliberately high: a full year of one property's ledger is in
// the tens of thousands of rows and the page's rollups are only correct over
// the complete set. All aggregation happens in transactionAnalytics.js.
export function useTransactions(dateRange, propertyId, months = [], enabled = true) {
  return useQuery({
    queryKey: [
      "transaction-lines",
      dateRange?.from,
      dateRange?.to,
      Array.isArray(propertyId) ? propertyId.join(",") : propertyId,
      (months || []).join(","),
    ],
    enabled,
    queryFn: async () => {
      const filter = buildFilter(dateRange, propertyId);
      const limit = getDynamicLimit(dateRange, propertyId, 200000);
      const rows = filter.date
        ? await db.entities.TransactionLine.filter(filter, "date", limit)
        : await db.entities.TransactionLine.list("date", limit);
      return filterByMonths(rows, months);
    },
  });
}

// ─── Operational modules (features 3-6) ───

// Room master register. Scoped by property; the entity proxy also enforces
// per-user property access.
export function useRooms(propertyId) {
  return useQuery({
    queryKey: ["rooms", Array.isArray(propertyId) ? propertyId.join(",") : propertyId],
    queryFn: async () => {
      const filter = {};
      if (propertyId && propertyId !== "all") {
        if (Array.isArray(propertyId)) {
          if (propertyId.length > 0) filter.property_id = { $in: propertyId };
        } else {
          filter.property_id = propertyId;
        }
      }
      return db.entities.Room.filter(filter, "room_number", 100000);
    },
  });
}

// Per-room nightly ledger (RoomStay). Same property/date/month idiom as the
// other hooks.
export function useRoomStays(dateRange, propertyId, months = []) {
  return useQuery({
    queryKey: [
      "room-stays",
      dateRange?.from,
      dateRange?.to,
      Array.isArray(propertyId) ? propertyId.join(",") : propertyId,
      (months || []).join(","),
    ],
    queryFn: async () => {
      const filter = buildFilter(dateRange, propertyId);
      const limit = getDynamicLimit(dateRange, propertyId);
      const rows = filter.date
        ? await db.entities.RoomStay.filter(filter, "date", limit)
        : await db.entities.RoomStay.list("date", limit);
      return filterByMonths(rows, months);
    },
  });
}

// Housekeeping task queue.
export function useHousekeepingTasks(dateRange, propertyId) {
  return useQuery({
    queryKey: [
      "housekeeping",
      dateRange?.from,
      dateRange?.to,
      Array.isArray(propertyId) ? propertyId.join(",") : propertyId,
    ],
    queryFn: async () => {
      const filter = {};
      if (dateRange?.from && dateRange?.to) filter.task_date = { $gte: dateRange.from, $lte: dateRange.to };
      if (propertyId && propertyId !== "all") {
        if (Array.isArray(propertyId)) {
          if (propertyId.length > 0) filter.property_id = { $in: propertyId };
        } else {
          filter.property_id = propertyId;
        }
      }
      const limit = getDynamicLimit(dateRange, propertyId);
      return db.entities.HousekeepingTask.filter(filter, "-task_date", limit);
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
      Array.isArray(propertyId) ? propertyId.join(",") : propertyId,
    ],
    queryFn: async () => {
      const filter = {};
      if (dateRange?.from && dateRange?.to) filter.review_date = { $gte: dateRange.from, $lte: dateRange.to };
      if (propertyId && propertyId !== "all") {
        if (Array.isArray(propertyId)) {
          if (propertyId.length > 0) filter.property_id = { $in: propertyId };
        } else {
          filter.property_id = propertyId;
        }
      }
      const limit = getDynamicLimit(dateRange, propertyId);
      return db.entities.Review.filter(filter, "-review_date", limit);
    },
  });
}

// Cached weather snapshots (feature 5).
export function useWeatherSnapshots(propertyId) {
  return useQuery({
    queryKey: ["weather", Array.isArray(propertyId) ? propertyId.join(",") : propertyId],
    queryFn: async () => {
      const filter = {};
      if (propertyId && propertyId !== "all") {
        if (Array.isArray(propertyId)) {
          if (propertyId.length > 0) filter.property_id = { $in: propertyId };
        } else {
          filter.property_id = propertyId;
        }
      }
      return db.entities.WeatherSnapshot.filter(filter, "-date", 100000);
    },
    staleTime: 60 * 1000,
  });
}