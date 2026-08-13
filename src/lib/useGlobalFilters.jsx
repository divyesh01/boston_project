// @refresh reset
import React, { createContext, useContext, useState, useMemo, useCallback } from "react";
import { useProperties, useLatestDate } from "@/lib/useHotelData";
import { useAuth } from "@/lib/AuthContext";

const Ctx = createContext(null);

export const PERIODS = [
  ["ytd", "YTD"],
  ["daily", "Daily"],
  ["weekly", "Weekly"],
  ["monthly", "Multi-Month"],
  ["quarterly", "Quarterly"],
  ["yearly", "Yearly"],
  ["custom", "Custom"],
];

export const MONTHS_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
export const MONTHS_LONG = ["January","February","March","April","May","June","July","August","September","October","November","December"];

export const PAGE_FILTERS = {
  "/": { employee: true, paymentType: true, channel: true, reportType: true },
  "/action-center": { channel: true },
  "/compare": { channel: true },
  "/rooms": {},
  "/employees": { employee: true },
  // PaymentDay carries one row per business date with a column per tender and
  // no employee dimension at all, so the global employee dropdown had nothing to
  // filter and was silently ignored. The per-clerk section further down the page
  // comes from ClerkShiftRecord and has its own expander. `paymentType` IS wired
  // (it narrows the method aggregation).
  "/payments": { paymentType: true },
  // The ledger page has its own account picker: the global employee dropdown is
  // built from ClerkShiftRecord.clerk_name, which never matches the PMS
  // usernames on TransactionLine, so offering it here would filter to nothing.
  "/transactions": { paymentType: true },
  // Statistics reads whole PMS snapshots, and every metric in one is already
  // aggregated by the PMS. There is no per-employee or per-channel dimension to
  // slice on, so only the date range and property apply — both of which live
  // outside this map and always show.
  "/statistics": {},
  "/charts": { channel: true, reportType: true },
  // The OTA page manages commission RATES and compares every channel against
  // the others; filtering to a single channel would hide the comparison that is
  // the point of the page. It never read the global `channel` value, so the
  // dropdown was rendered and silently ignored — removed rather than wired.
  "/ota": {},
  "/channel-manager": {},
  "/settings": {},
  "/upload": {},
  "/calendar": {},
  "/mtd": {},
  "/expenses": {},
  "/payroll": {},
  "/manual-entry": {},
  "/forecasting": {},
  "/data-template": {},
  "/housekeeping": {},
  "/reviews": {},
  "/pricing": {},
};

const CUR_YEAR = new Date().getFullYear();
const pad = (n) => String(n).padStart(2, "0");
const iso = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
const lastDay = (y, m) => new Date(y, m + 1, 0).getDate();

function computeRangeFromMonths(year, months, latestDate) {
  if (!months || months.length === 0) {
    const today = new Date();
    const m = year === today.getFullYear() ? today.getMonth() : 0;
    return { from: iso(year, m, 1), to: iso(year, m, lastDay(year, m)) };
  }
  const minM = Math.min(...months);
  const maxM = Math.max(...months);
  const today = new Date();
  let to = iso(year, maxM, lastDay(year, maxM));
  // If the max month is in the current year and in the future, cap to latest data or today
  if (year >= today.getFullYear() && maxM >= today.getMonth()) {
    to = latestDate || iso(today.getFullYear(), today.getMonth(), today.getDate());
    // But don't go before the start of the range
    if (to < iso(year, minM, 1)) to = iso(year, maxM, lastDay(year, maxM));
  }
  return { from: iso(year, minM, 1), to };
}

function computeRange(period, year, month, latestDate, customFrom, customTo) {
  const y = year || CUR_YEAR;
  const today = new Date();

  if (period === "custom") return { from: customFrom || "", to: customTo || "" };

  if (period === "ytd") {
    const from = iso(y, 0, 1);
    let to;
    if (y >= today.getFullYear()) {
      to = latestDate || iso(today.getFullYear(), today.getMonth(), today.getDate());
    } else {
      to = iso(y, 11, 31);
    }
    return { from, to };
  }

  if (period === "yearly") return { from: iso(y, 0, 1), to: iso(y, 11, 31) };

  if (period === "monthly") {
    // Multi-month: handled by computeRangeFromMonths via the months array
    // This fallback handles the case where months is not passed
    const m = month !== null ? month : (y === today.getFullYear() ? today.getMonth() : 0);
    return { from: iso(y, m, 1), to: iso(y, m, lastDay(y, m)) };
  }

  if (period === "quarterly") {
    const m = month !== null ? Math.floor(month / 3) * 3 : 0;
    return { from: iso(y, m, 1), to: iso(y, m + 2, lastDay(y, m + 2)) };
  }

  if (period === "daily") {
    const m = month !== null ? month : today.getMonth();
    const d = today.getDate();
    return { from: iso(y, m, d), to: iso(y, m, d) };
  }

  if (period === "weekly") {
    const m = month !== null ? month : today.getMonth();
    const ref = new Date(y, m, month !== null ? 15 : today.getDate());
    const day = ref.getDay();
    const start = new Date(ref);
    start.setDate(ref.getDate() - day);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    return {
      from: iso(start.getFullYear(), start.getMonth(), start.getDate()),
      to: iso(end.getFullYear(), end.getMonth(), end.getDate()),
    };
  }

  return { from: iso(y, 0, 1), to: iso(y, 11, 31) };
}

export function GlobalFiltersProvider({ children }) {
  // Multi-property: array of property IDs (empty = all properties)
  const [selectedPropertyIds, setSelectedPropertyIds] = useState([]);
  const [period, setPeriod] = useState("ytd");
  const [year, setYear] = useState(CUR_YEAR);
  // Multi-month: array of month indices (0-11). Empty = current month fallback
  const [months, setMonths] = useState([]);
  const [compareOn, setCompareOn] = useState(false);
  const [comparePeriod, setComparePeriod] = useState("monthly");
  const [compareYear, setCompareYear] = useState(CUR_YEAR);
  const [compareMonths, setCompareMonths] = useState([]);
  const [employee, setEmployee] = useState("all");
  const [paymentType, setPaymentType] = useState("all");
  const [channel, setChannel] = useState("all");
  const [reportType, setReportType] = useState("all");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");

  const { data: properties = [] } = useProperties();
  const { canAccessProperty } = useAuth();

  // Property-level access: non-owner/admin users only see their assigned properties
  const accessibleProperties = useMemo(
    () => properties.filter((p) => canAccessProperty(p.id)),
    [properties, canAccessProperty]
  );

  // Constrain selections to accessible properties
  const effectiveProperties = useMemo(() => {
    const sel = selectedPropertyIds.filter((id) => accessibleProperties.some((p) => p.id === id));
    // Owner/admin with no selection = all; restricted users with no selection = all accessible
    return sel;
  }, [selectedPropertyIds, accessibleProperties]);

  // Backward-compat: property as string or array for hooks
  const property = effectiveProperties.length === 0
    ? "all"
    : effectiveProperties.length === 1
    ? effectiveProperties[0]
    : effectiveProperties;

  const { data: latestDate = "" } = useLatestDate(property);

  // Compute date range
  const dateRange = useMemo(() => {
    if (period === "custom") return { from: customFrom, to: customTo };
    if (period === "ytd" || period === "yearly" || period === "quarterly" || period === "daily" || period === "weekly") {
      return computeRange(period, year, null, latestDate, customFrom, customTo);
    }
    // "monthly" = Multi-Month mode
    return computeRangeFromMonths(year, months, latestDate);
  }, [period, year, months, latestDate, customFrom, customTo]);

  const compareDateRange = useMemo(() => {
    if (comparePeriod === "monthly") {
      return computeRangeFromMonths(compareYear, compareMonths, latestDate);
    }
    return computeRange(comparePeriod, compareYear, null, latestDate, "", "");
  }, [comparePeriod, compareYear, compareMonths, latestDate]);

  // Check if a date falls in one of the selected months
  const isMonthSelected = useCallback((dateStr) => {
    if (!dateStr) return false;
    if (period !== "monthly") return true; // only filter when in multi-month mode
    if (months.length === 0) return true; // no months selected = all
    const m = new Date(String(dateStr).slice(0, 10)).getMonth();
    return months.includes(m);
  }, [period, months]);

  // Toggle a month on/off
  const toggleMonth = useCallback((m) => {
    setMonths((prev) => {
      if (prev.includes(m)) return prev.filter((x) => x !== m);
      return [...prev, m].sort((a, b) => a - b);
    });
    setPeriod("monthly");
  }, []);

  const selectMonth = (m) => {
    setMonths([m]);
    setPeriod("monthly");
  };

  // Toggle a property on/off
  const toggleProperty = useCallback((id) => {
    setSelectedPropertyIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      return [...prev, id];
    });
  }, []);

  const setPropertyMulti = useCallback((ids) => {
    setSelectedPropertyIds(ids || []);
  }, []);

  // Backward compat: setProperty accepts "all" or a single ID
  const setProperty = useCallback((val) => {
    if (val === "all") setSelectedPropertyIds([]);
    else setSelectedPropertyIds([val]);
  }, []);

  const prevMonth = () => {
    let m = months.length ? months[months.length - 1] : new Date().getMonth();
    let y = year;
    if (m === 0) { m = 11; y--; } else { m--; }
    setMonths([m]); setYear(y); setPeriod("monthly");
  };

  const nextMonth = () => {
    let m = months.length ? months[months.length - 1] : new Date().getMonth();
    let y = year;
    if (m === 11) { m = 0; y++; } else { m++; }
    setMonths([m]); setYear(y); setPeriod("monthly");
  };

  const goToLatestData = () => {
    if (!latestDate) return;
    const d = new Date(latestDate);
    setYear(d.getFullYear());
    setMonths([d.getMonth()]);
    setPeriod("monthly");
  };

  const reset = () => {
    setSelectedPropertyIds([]);
    setPeriod("ytd");
    setYear(CUR_YEAR);
    setMonths([]);
    setCompareOn(false);
    setComparePeriod("monthly");
    setCompareYear(CUR_YEAR);
    setCompareMonths([]);
    setEmployee("all");
    setPaymentType("all");
    setChannel("all");
    setReportType("all");
    setCustomFrom("");
    setCustomTo("");
  };

  const value = {
    // Multi-property
    selectedPropertyIds,
    toggleProperty,
    setPropertyMulti,
    // Backward compat
    property, setProperty,
    properties,
    accessibleProperties,
    // Period
    period, setPeriod,
    year, setYear,
    // Multi-month
    months, setMonths, toggleMonth,
    // Backward compat: month getter returns first selected or null
    month: months.length ? months[0] : null,
    setMonth: selectMonth,
    // Compare
    compareOn, setCompareOn,
    comparePeriod, setComparePeriod,
    compareYear, setCompareYear,
    compareMonths, setCompareMonths,
    // Other filters
    employee, setEmployee,
    paymentType, setPaymentType,
    channel, setChannel,
    reportType, setReportType,
    customFrom, setCustomFrom,
    customTo, setCustomTo,
    // Computed
    dateRange,
    compareDateRange,
    isMonthSelected,
    latestDate,
    reset,
    prevMonth,
    nextMonth,
    goToLatestData,
    PERIODS,
    MONTHS_SHORT,
    MONTHS_LONG,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useGlobalFilters() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useGlobalFilters must be used within GlobalFiltersProvider");
  return ctx;
}