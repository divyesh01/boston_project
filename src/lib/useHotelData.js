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
function filterByMonths(rows, months) {
  if (!months || months.length === 0) return rows;
  return rows.filter((r) => {
    if (!r.date) return false;
    const m = new Date(String(r.date).slice(0, 10)).getMonth();
    return months.includes(m);
  });
}

export function useOccupancy(dateRange, propertyId, months = []) {
  return useQuery({
    queryKey: ["occupancy", dateRange?.from, dateRange?.to, propertyId, (months || []).join(",")],
    queryFn: async () => {
      const filter = buildFilter(dateRange, propertyId);
      let rows;
      if (filter.date) {
        rows = await db.entities.OccupancyDay.filter(filter, "date", 2000);
      } else {
        rows = await db.entities.OccupancyDay.list("date", 2000);
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
        rows = await db.entities.SourceDay.filter(filter, "date", 5000);
      } else {
        rows = await db.entities.SourceDay.list("date", 5000);
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
        rows = await db.entities.GrossRevenueDay.filter(filter, "date", 2000);
      } else {
        rows = await db.entities.GrossRevenueDay.list("date", 2000);
      }
      return filterByMonths(rows, months);
    },
  });
}

export function useClerkRecords(dateRange, propertyId) {
  return useQuery({
    queryKey: ["clerk", propertyId],
    queryFn: () => {
      // Clerk records don't have reliable shift_date fields — filter by property only
      const filter = {};
      if (propertyId && propertyId !== "all") {
        if (Array.isArray(propertyId)) {
          if (propertyId.length > 0) filter.property_id = { $in: propertyId };
        } else {
          filter.property_id = propertyId;
        }
      }
      return db.entities.ClerkShiftRecord.filter(filter, "-created_date", 5000);
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
        rows = await db.entities.PaymentDay.filter(filter, "date", 2000);
      } else {
        rows = await db.entities.PaymentDay.list("date", 2000);
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