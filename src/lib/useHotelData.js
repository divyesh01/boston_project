import { db } from '@/api/base44Client';

import { useQuery } from "@tanstack/react-query";

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
      let rows;
      if (filter.date) {
        rows = await db.entities.OccupancyDay.filter(filter, "date", 100000);
      } else {
        rows = await db.entities.OccupancyDay.list("date", 100000);
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
      let rows;
      if (filter.date) {
        rows = await db.entities.SourceDay.filter(filter, "date", 100000);
      } else {
        rows = await db.entities.SourceDay.list("date", 100000);
      }
      return filterByMonths(rows, months);
    },
  });
}

export function useGrossRevenue(dateRange, propertyId, months = []) {
  return useQuery({
    queryKey: ["gross", dateRange?.from, dateRange?.to, propertyId, (months || []).join(",")],
    queryFn: async () => {
      const filter = buildFilter(dateRange, propertyId);
      let rows;
      if (filter.date) {
        rows = await db.entities.GrossRevenueDay.filter(filter, "date", 100000);
      } else {
        rows = await db.entities.GrossRevenueDay.list("date", 100000);
      }
      return filterByMonths(rows, months);
    },
  });
}

export function useClerkRecords(dateRange, propertyId) {
  return useQuery({
    queryKey: ["clerk", dateRange?.from, dateRange?.to, propertyId],
    queryFn: () => {
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
      return db.entities.ClerkShiftRecord.filter(filter, "-shift_date", 100000);
    },
  });
}

export function usePaymentData(dateRange, propertyId, months = []) {
  return useQuery({
    queryKey: ["payments", dateRange?.from, dateRange?.to, propertyId, (months || []).join(",")],
    queryFn: async () => {
      const filter = buildFilter(dateRange, propertyId);
      let rows;
      if (filter.date) {
        rows = await db.entities.PaymentDay.filter(filter, "date", 100000);
      } else {
        rows = await db.entities.PaymentDay.list("date", 100000);
      }
      return filterByMonths(rows, months);
    },
  });
}

export function useUploads() {
  return useQuery({
    queryKey: ["uploads"],
    queryFn: () => db.entities.UploadedReport.list("-created_date", 50),
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
      const rows = filter.date
        ? await db.entities.TransactionLine.filter(filter, "date", 200000)
        : await db.entities.TransactionLine.list("date", 200000);
      return filterByMonths(rows, months);
    },
  });
}