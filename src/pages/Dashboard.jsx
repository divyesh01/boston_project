import React, { useMemo, useState, useRef, useEffect, lazy, Suspense } from "react";
import confetti from "canvas-confetti";
import { DollarSign, BedDouble, Percent, Gauge, RefreshCw, FileDown, FileSpreadsheet, TrendingDown, Lightbulb, AlertTriangle, TrendingUp, Loader2 } from "lucide-react";
import KpiCard from "@/components/ui-exec/KpiCard";
import Card from "@/components/ui-exec/Card";
import Button from "@/components/ui-exec/Button";
import ClerkAudit from "@/components/dashboard/ClerkAudit";
import YieldAdvisor from "@/components/dashboard/YieldAdvisor";
import RevenueTrend from "@/components/dashboard/RevenueTrend";
import PropertyRanking from "@/components/dashboard/PropertyRanking";
import LowOccAlert from "@/components/dashboard/LowOccAlert";
import ModuleCards from "@/components/dashboard/ModuleCards";

const OtaMatrix = lazy(() => import("@/components/dashboard/OtaMatrix"));
const ExecutiveCharts = lazy(() => import("@/components/dashboard/ExecutiveCharts"));
const MoneyKept = lazy(() => import("@/components/dashboard/MoneyKept"));
import { useOccupancy, useSources, useClerkRecords, useGrossRevenue, usePaymentData, useDailyFinancialAggregates, filterByMonths } from "@/lib/useHotelData";
import { usePullToRefresh } from "@/hooks/usePullToRefresh";
import { exportToPdf } from "@/lib/pdfExport";
import { money2, num, pct, sum, inRange, C, getOccThreshold, grossRevenueForPeriod, perPropertyStats } from "@/lib/hotel";
import KpiProvenanceDrawer from "@/components/lineage/KpiProvenanceDrawer";
import { fromCents, sumCents } from "@/lib/decimal";
import { getAlertThresholds } from "@/lib/alertThresholds";
import { useGlobalFilters } from "@/lib/useGlobalFilters";
import { CalculationService } from "@/lib/calculationService";
import { evaluatePortfolioDataHealth, reconcileFinancialTotals } from "@/lib/dataHealth";
import { toast } from "sonner";
import { OwnerIntelligenceService } from "@/lib/ownerIntelligence";
import { useQuery } from "@tanstack/react-query";
import { db } from "@/api/base44Client";
import WeatherPanel from "@/components/dashboard/WeatherPanel";
import PricingPanel from "@/components/dashboard/PricingPanel";
import SmartButtonGroup from "@/components/dashboard/SmartButtonGroup";
import OTAShiftSimulator from "@/components/dashboard/OTAShiftSimulator";
import ScheduleReportDialog from "@/components/dashboard/ScheduleReportDialog";
import OwnerPacketPreview from "@/components/dashboard/OwnerPacketPreview";
import { FEATURE_FLAGS, useFeatureFlag } from "@/lib/featureFlags";
import { useRealtimeInvalidation } from "@/lib/realtime";
import { ErrorState } from "@/components/ui/status";

export default function Dashboard() {
  const [isScheduleOpen, setIsScheduleOpen] = useState(false);
  const luxuryUiEnabled = useFeatureFlag(FEATURE_FLAGS.LUXURY_UI_ENABLED);

  const { dateRange, property, properties, compareOn, compareDateRange, compareMonths, employee, paymentType, channel, months } = useGlobalFilters();
  const isPortfolio = property === "all" || Array.isArray(property);
  const selectedProp = isPortfolio ? null : properties.find((p) => p.id === property);
  const propRooms = selectedProp?.rooms || 100;
  const propName = isPortfolio ? (Array.isArray(property) ? `${property.length} Properties` : "All Properties / Portfolio") : (selectedProp?.name || "Property");

  // Feature 7: live dashboard. While enabled, cross-tab change notifications and
  // a lightweight poll invalidate these query prefixes so the dashboard stays
  // fresh without manual refresh. Default on for the operational data sets.
  useRealtimeInvalidation(["occupancy", "sources", "gross", "clerk", "payments", "expenses", "payroll", "anomaly-alerts", "rooms", "reservations", "weather", "daily-aggregates", "properties"]);

  // The raw-ledger hooks still run (they feed the explicit Compare view and act
  // as the aggregate's fallback), but the Dashboard no longer blocks render on
  // them — the materialized aggregate drives the initial paint.
  const { data: occ = [], isLoading, isError: occError, error: occErrorObj, refetch: refOcc } = useOccupancy(dateRange, property, months);
  const { data: prevOcc = [] } = useOccupancy(compareOn ? compareDateRange : { from: "", to: "" }, property, compareOn ? compareMonths : [], compareOn);
  const { data: sources = [], refetch: refSrc } = useSources(dateRange, property, months);
  const { data: clerk = [], refetch: refClerk } = useClerkRecords(dateRange, property);
  const { data: gross = [], isError: grossError, error: grossErrorObj, refetch: refGross } = useGrossRevenue(dateRange, property, months);
  const { data: payRows = [] } = usePaymentData(dateRange, property, months);

  // Materialized daily aggregates (rebuilt on every import). When present, the
  // headline metrics, charts and owner-intelligence panels read a few hundred
  // pre-summed rows instead of the raw ledgers — instant at 10k+ rows. Falls
  // back to the live ledgers when the cache is empty (e.g. nothing imported yet).
  const agg = useDailyFinancialAggregates(dateRange, property);
  const aggData = agg.data;
  
  // Fetch expenses and payroll for owner intelligence
  const propertyKey = Array.isArray(property) ? property.join(",") : property;
  const propFilter = property && property !== "all" 
    ? (Array.isArray(property) ? { property_id: { $in: property } } : { property_id: property })
    : {};
  
  const { data: expenses = [], isError: expensesError, error: expensesErrorObj, refetch: refExpenses } = useQuery({
    queryKey: ["expenses", propertyKey],
    queryFn: () => db.entities.Expense.filter(propFilter, "-expense_date", 100000),
  });

  const { data: payroll = [], isError: payrollError, error: payrollErrorObj, refetch: refPayroll } = useQuery({
    queryKey: ["payroll", propertyKey],
    queryFn: () => db.entities.PayrollRun.filter(propFilter, "-pay_period_start", 100000),
  });

  // Automated financial anomaly alerts flagged during CSV import — owner review queue.
  // Scoped by the active date range so the query planner uses the [property_id+date]
  // compound index (or the plain date index for portfolio-wide views).
  const anomalyFilter = useMemo(() => {
    /** @type {{ property_id?: string | { $in: string[] }, date?: { $gte: string, $lte: string } }} */
    const base = { ...propFilter };
    if (dateRange.from && dateRange.to) {
      base.date = { $gte: dateRange.from, $lte: dateRange.to };
    }
    return base;
  }, [propFilter, dateRange.from, dateRange.to]);

  const { data: anomalyAlerts = [] } = useQuery({
    queryKey: ["anomaly-alerts", propertyKey, dateRange.from, dateRange.to],
    queryFn: () => db.entities.AnomalyAlert.filter(anomalyFilter, "-date", 500),
  });

  // Dedicated previous-period range for trend alerts (independent of the current filter)
  const alertPrevRange = useMemo(() => {
    if (!dateRange.from || !dateRange.to) return { from: "", to: "" };
    const periodDays = Math.round((new Date(dateRange.to).getTime() - new Date(dateRange.from).getTime()) / 86400000) + 1;
    if (periodDays <= 0) return { from: "", to: "" };
    const prevTo = new Date(new Date(dateRange.from).getTime() - 86400000);
    const prevFrom = new Date(prevTo.getTime() - (periodDays - 1) * 86400000);
    return { from: prevFrom.toISOString().slice(0, 10), to: prevTo.toISOString().slice(0, 10) };
  }, [dateRange]);
  const { data: alertPrevOcc = [] } = useOccupancy(alertPrevRange, property, [], !!(alertPrevRange.from && alertPrevRange.to));
  // Previous-period aggregate for trend alerts — mirrors the current-period one so
  // the alerts need not wait on the raw-ledger fetch when the cache is populated.
  const aggPrev = useDailyFinancialAggregates(alertPrevRange, property);
  const aggPrevData = aggPrev.data;
  const [exporting, setExporting] = useState(false);
  // An export failure used to reach console.error only, so the button dropped back
  // to "Export PDF" with nothing saved and no way to tell that from a PDF that did
  // save. Same surface as OtaChannels.jsx, which already got this right.
  const [exportError, setExportError] = useState(null);
  const contentRef = useRef(null);
  const packetExportInFlight = useRef(false);

  const occRows = useMemo(() => {
    const base = aggData ? aggData.occRows : occ.filter((r) => inRange(r.date, dateRange.from, dateRange.to));
    return filterByMonths(base, months);
  }, [aggData, occ, dateRange, months]);
  const srcRows = useMemo(() => {
    let r = aggData ? aggData.srcRows : sources.filter((x) => inRange(x.date, dateRange.from, dateRange.to));
    if (channel !== "all") r = r.filter((x) => x.source === channel || x.code === channel);
    return filterByMonths(r, months);
  }, [aggData, sources, dateRange, channel, months]);
  const grossRows = useMemo(() => {
    const base = aggData ? aggData.grossRows : gross.filter((r) => inRange(r.date, dateRange.from, dateRange.to));
    return filterByMonths(base, months);
  }, [aggData, gross, dateRange, months]);
  const aggPayRows = useMemo(() => (aggData ? aggData.payRows : payRows), [aggData, payRows]);
  const aggExpenses = useMemo(() => expenses, [expenses]);
  const clerkFiltered = useMemo(() => {
    let r = clerk;
    if (employee !== "all") r = r.filter((x) => x.clerk_name === employee);
    if (paymentType !== "all") r = r.filter((x) => (x.payment_type || "").toUpperCase() === paymentType);
    return r;
  }, [clerk, employee, paymentType]);

  const handleRefresh = async () => {
    await Promise.all([refOcc(), refSrc(), refClerk(), refGross(), refExpenses(), refPayroll()]);
  };
  const { pullDist, refreshing } = usePullToRefresh(handleRefresh);

  // Weighted calculations — for portfolio, use per-property room counts; for single property, use propRooms
  const roomCounts = useMemo(() => {
    if (isPortfolio) {
      const map = {};
      properties.forEach((p) => { map[p.id] = p.rooms || 100; });
      return map;
    }
    return { [property]: propRooms };
  }, [isPortfolio, properties, property, propRooms]);

  // Use centralized calculation service for all financial metrics
  const currentStats = useMemo(() => CalculationService.calculateOccupancyMetrics(occRows, roomCounts), [occRows, roomCounts]);
  const prevStats = useMemo(() => {
    if (!compareOn || !prevOcc.length) return null;
    return CalculationService.calculateOccupancyMetrics(prevOcc, roomCounts);
  }, [compareOn, prevOcc, roomCounts]);

  const { revenue, roomsSold, capacity, occupancy, adr, revpar } = currentStats;
  const uniqueDays = new Set(occRows.map((r) => String(r.date).slice(0, 10))).size;

  // `revenue` above is ROOM revenue — it is the numerator for ADR and RevPAR and
  // must stay room-only. The card labelled "Total Revenue" needs the actual
  // total, so it comes from the shared helper instead: room ledger + ancillary
  // charges. The two used to be the same value, which meant this card read
  // $1,011,258.67 under a "Total Revenue" label while the Money Kept widget on
  // the same screen reported a different total for the same period.
  const totalRev = useMemo(() => grossRevenueForPeriod({ grossRows, occRows }), [grossRows, occRows]);

  const [provenanceMetric, setProvenanceMetric] = useState(null);
  const [isProvenanceOpen, setIsProvenanceOpen] = useState(false);

  const openProvenance = (metricType) => {
    const propBreakdown = perPropertyStats(occRows, properties);
    if (metricType === "revenue") {
      setProvenanceMetric({
        name: "Portfolio Total Revenue",
        value: money2(totalRev.dollars),
        formula: "SUM(occupancy_day.room_revenue) + SUM(gross_revenue_day.misc_charge)",
        definition: "Total room rent and ancillary charges realized across all selected properties for the chosen business dates.",
        dateRange,
        properties: propBreakdown.map((p) => ({ id: p.property_id, name: p.property_name, value: p.revenue })),
        reconciliation: { difference: 0, isBalanced: true },
      });
    } else if (metricType === "rooms") {
      setProvenanceMetric({
        name: "Total Rooms Sold",
        value: `${num(roomsSold)} rooms`,
        formula: "SUM(occupancy_day.rooms_sold)",
        definition: "Total physical room nights occupied by paying, corporate, and stayover guests across the portfolio.",
        dateRange,
        properties: propBreakdown.map((p) => ({ id: p.property_id, name: p.property_name, value: p.roomsSold })),
        reconciliation: { difference: 0, isBalanced: true },
      });
    } else if (metricType === "occupancy") {
      setProvenanceMetric({
        name: "Portfolio Occupancy Rate",
        value: pct(occupancy),
        formula: "divideRate(roomsSold, capacityCents) — Weighted by Physical Capacity",
        definition: "Ratio of total rooms sold to available physical room capacity. Weighted properly across properties.",
        dateRange,
        properties: propBreakdown.map((p) => ({ id: p.property_id, name: p.property_name, value: p.revenue })),
        reconciliation: { difference: 0, isBalanced: true },
      });
    } else if (metricType === "adr") {
      setProvenanceMetric({
        name: "Average Daily Rate (ADR) & RevPAR",
        value: `${money2(adr)} (RevPAR ${money2(revpar)})`,
        formula: "ADR = Room Revenue / Rooms Sold; RevPAR = Room Revenue / Total Available Capacity",
        definition: "Realized room revenue yield per sold room night and per available room night.",
        dateRange,
        properties: propBreakdown.map((p) => ({ id: p.property_id, name: p.property_name, value: p.revenue })),
        reconciliation: { difference: 0, isBalanced: true },
      });
    }
    setIsProvenanceOpen(true);
  };

  useEffect(() => {
    if (revenue > 50000) {
      confetti({ particleCount: 100, spread: 70, origin: { y: 0.6 } });
    }
  }, [revenue]);

  const threshold = getOccThreshold();
  const lowOccDays = useMemo(() => occRows.filter((r) => Number(r.occupancy || 0) < threshold), [occRows, threshold]);

  // Previous-period stats come from the aggregate when available, else the live
  // ledger — so the trend alerts don't force a raw-ledger fetch.
  const alertPrevStats = useMemo(() => {
    const prevAgg = aggPrevData ? aggPrevData.occRows : alertPrevOcc;
    if (!prevAgg.length) return null;
    return CalculationService.calculateOccupancyMetrics(prevAgg, roomCounts);
  }, [aggPrevData, alertPrevOcc, roomCounts]);

  const alerts = useMemo(() => {
    if (!dateRange.from || !dateRange.to || !occRows.length || !alertPrevStats) return [];
    const thresholds = getAlertThresholds();

    const prevRev = alertPrevStats.revenue;
    const prevOccVal = alertPrevStats.occupancy;
    const prevAdr = alertPrevStats.adr;

    const out = [];
    if (prevRev > 0) {
      const ch = (revenue - prevRev) / prevRev;
      if (ch <= -thresholds.revenueDecreasePct)
        out.push({ metric: "Revenue", current: revenue, previous: prevRev, pct: ch, sev: Math.abs(ch) >= 0.2 ? "Critical" : "Warning", fmt: money2 });
    }
    if (prevOccVal > 0) {
      const ch = occupancy - prevOccVal;
      if (ch <= -thresholds.occupancyDecreasePoints)
        out.push({ metric: "Occupancy", current: occupancy, previous: prevOccVal, pct: ch, sev: Math.abs(ch) >= 0.2 ? "Critical" : "Warning", fmt: (v) => pct(v) });
    }
    if (prevAdr > 0) {
      const ch = (adr - prevAdr) / prevAdr;
      if (ch <= -thresholds.revenueDecreasePct)
        out.push({ metric: "ADR", current: adr, previous: prevAdr, pct: ch, sev: Math.abs(ch) >= 0.2 ? "Critical" : "Warning", fmt: money2 });
    }
    return out;
  }, [occRows, alertPrevStats, dateRange, revenue, occupancy, adr, roomCounts, threshold]);

  // Anomaly alerts scoped to the currently selected period.
  const anomalyInRange = useMemo(
    () => anomalyAlerts.filter((a) => inRange(a.date, dateRange.from, dateRange.to)),
    [anomalyAlerts, dateRange]
  );

  const miscCharges = useMemo(() => {
    const cats = [
      ["misc_charge", "Misc Charge"], ["system_charge", "System"], ["food", "Food"],
      ["event", "Event"], ["bar", "Bar"], ["laundry", "Laundry"],
      ["phone", "Phone"], ["other", "Other"], ["beverage", "Beverage"],
    ];
    return cats
      .map(([key, label]) => ({ label, value: sum(grossRows, key) }))
      .filter((c) => c.value > 0)
      .sort((a, b) => b.value - a.value);
  }, [grossRows]);

  const moneyKeptResult = useMemo(() => {
    return CalculationService.calculateMoneyKept(
      occRows,
      srcRows,
      grossRows,
      aggPayRows,
      aggExpenses,
      payroll,
      dateRange,
      property
    );
  }, [occRows, srcRows, grossRows, aggPayRows, aggExpenses, payroll, dateRange, property]);

  const dataByProperty = useMemo(() => {
    /** @type {Record<string, { occRows: Array<any>, srcRows: Array<any>, grossRows: Array<any>, payRows: Array<any> }>} */
    const map = {};
    properties.forEach((p) => {
      map[p.id] = { occRows: [], srcRows: [], grossRows: [], payRows: [] };
    });
    occRows.forEach((r) => {
      const pid = r.property_id;
      if (map[pid]) map[pid].occRows.push(r);
    });
    srcRows.forEach((r) => {
      const pid = r.property_id;
      if (map[pid]) map[pid].srcRows.push(r);
    });
    grossRows.forEach((r) => {
      const pid = r.property_id;
      if (map[pid]) map[pid].grossRows.push(r);
    });
    aggPayRows.forEach((r) => {
      const pid = r.property_id;
      if (map[pid]) map[pid].payRows.push(r);
    });
    return map;
  }, [properties, occRows, srcRows, grossRows, aggPayRows]);

  const portfolioHealth = useMemo(() => {
    return evaluatePortfolioDataHealth(properties, dataByProperty, dateRange);
  }, [properties, dataByProperty, dateRange]);

  const reconciliation = useMemo(() => {
    const grossLedgerCents = sumCents(grossRows.map((r) => r.room_rent || r.gross_revenue || r.room_revenue || 0));
    const occupancyRevenueCents = sumCents(occRows.map((r) => r.room_revenue || 0));
    const reportedCents = grossLedgerCents > 0 ? grossLedgerCents : occupancyRevenueCents;
    const calculatedCents = sumCents(srcRows.map((r) => r.net_revenue || r.revenue || 0));
    const finalReported = reportedCents > 0 ? fromCents(reportedCents) : (totalRev.dollars || revenue);
    const finalCalculated = fromCents(calculatedCents);
    const hasData = reportedCents > 0 || calculatedCents > 0 || (totalRev.dollars || revenue) > 0;
    const payCents = sumCents((aggPayRows || []).map((r) => r.total || 0));

    return reconcileFinancialTotals(finalReported, finalCalculated, {
      hasData,
      reportedCount: grossRows.length || occRows.length,
      calculatedCount: srcRows.length,
      paymentsTotal: (aggPayRows || []).length > 0 ? fromCents(payCents) : null,
      channelLedgerPresent: srcRows.length > 0,
    });
  }, [grossRows, occRows, srcRows, totalRev.dollars, revenue, aggPayRows]);

  const channelMetrics = useMemo(
    () => CalculationService.calculateChannelMetrics(srcRows),
    [srcRows]
  );

  const otaEconomics = useMemo(() => {
    const otaChannels = channelMetrics.filter((c) => c.isOta);
    const grossCents = sumCents(otaChannels.map((c) => c.gross || 0));
    const commCents = sumCents(otaChannels.map((c) => c.commission || 0));
    const grossDollars = fromCents(grossCents);
    const commDollars = fromCents(commCents);
    const rate = grossDollars > 0 ? commDollars / grossDollars : 0.16;
    return { grossDollars, commDollars, rate };
  }, [channelMetrics]);

  const handleExport = async () => {
    if (exporting || !contentRef.current) return;
    setExporting(true);
    setExportError(null);
    try {
      await exportToPdf(contentRef.current, `RRI_Executive_${property}_${dateRange.from}_${dateRange.to}.pdf`);
    } catch (e) {
      setExportError(e?.message || String(e));
    }
    setExporting(false);
  };

  const handleExportPacket = async () => {
    if (packetExportInFlight.current) return;
    packetExportInFlight.current = true;
    try {
      const { downloadOwnerPerformancePacket } = await import("@/lib/ownerPacketExport");
      const packetProperties = isPortfolio
        ? Array.isArray(property)
          ? properties.filter((p) => property.includes(p.id))
          : properties
        : properties.filter((p) => p.id === property);

      const propertyStats = CalculationService.calculatePerPropertyStats(occRows, packetProperties);
      const prevPropertyStats = alertPrevOcc.length > 0
        ? CalculationService.calculatePerPropertyStats(alertPrevOcc, packetProperties)
        : [];

      const otaChannels = channelMetrics.filter((c) => c.isOta);
      const commissionTotalDollars = otaEconomics.commDollars;
      const commissionRate = revenue > 0 ? commissionTotalDollars / revenue : 0;

      const directChannels = channelMetrics.filter((c) => c.isDirect);
      const directRevenue = fromCents(sumCents(directChannels.map((c) => c.gross)));
      const directShare = revenue > 0 ? directRevenue / revenue : 0;

      const dateLabel = dateRange?.from && dateRange?.to
        ? `${dateRange.from} to ${dateRange.to}`
        : 'Current Period';

      downloadOwnerPerformancePacket({
        dateRangeLabel: dateLabel,
        properties: packetProperties,
        kpis: {
          revenue,
          roomsSold,
          occupancy,
          adr,
          revpar,
          netKept: moneyKeptResult.kept,
          taxIncomplete: Boolean(moneyKeptResult?.taxIncomplete || moneyKeptResult?.isPartial),
          isPartial: Boolean(moneyKeptResult?.isPartial || moneyKeptResult?.taxIncomplete),
          commissionTotal: commissionTotalDollars,
          commissionRate,
          directShare,
        },
        propertyStats,
        prevPropertyStats,
        channelMetrics,
        portfolioHealth,
        reconciliation,
      });

      toast.success('Downloaded Monthly Owner Performance Packet (.xlsx)');
    } catch (err) {
      toast.error(`Export failed: ${err?.message || 'Unknown error'}`);
    } finally {
      packetExportInFlight.current = false;
    }
  };

  // Render as soon as the materialized aggregate settles. When the cache is
  // populated we show pre-summed metrics instantly and let the raw-ledger hooks
  // finish in the background (they only feed the secondary trend alerts). When
  // the cache is empty (nothing imported yet) we fall back to waiting for the
  // live ledgers — the original behaviour.
  const initialLoading = (aggData ? false : isLoading) || agg.isLoading;
  if (initialLoading) return <p className="text-slate-500">Loading executive data…</p>;

  // Every KPI card on this page sums an array. An empty array sums to 0, so a failed
  // read renders a complete, confident dashboard reading $0 revenue and 0% occupancy —
  // figures an owner could act on. Stop instead.
  // A failed expenses or payroll read is included below because they are the ONLY
  // source of the deductions in "Money Kept — net profit after all deductions": on
  // failure React Query leaves them [], so the card would silently book zero costs
  // and overstate profit with no error shown. isError (not empty) gates it, so a
  // hotel that genuinely has no expenses/payroll yet is unaffected.
  const dashboardError = agg.isError ? agg.error : occError ? occErrorObj : grossError ? grossErrorObj : expensesError ? expensesErrorObj : payrollError ? payrollErrorObj : null;
  if (dashboardError) {
    return (
      <ErrorState
        title="Could not load executive data"
        description="No KPIs are shown because the underlying read failed. Zeros here would be indistinguishable from a genuinely flat day."
        error={dashboardError}
        onRetry={handleRefresh}
      />
    );
  }

  return (
    <div className="space-y-6">
      {(pullDist > 0 || refreshing) && (
        <div className="flex items-center justify-center overflow-hidden" style={{ height: Math.max(pullDist, refreshing ? 40 : 0) }}>
          <RefreshCw className={`h-5 w-5 text-slate-400 ${refreshing ? "animate-spin" : ""}`} />
        </div>
      )}

      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[11px] uppercase tracking-[0.3em] text-[#00D4FF]">Executive Mode</p>
          <h1 className="mt-2 font-heading text-3xl font-semibold text-white">Boss Decision Hub</h1>
          <p className="mt-1 text-sm text-slate-400">
            {propName} · {dateRange.from || "—"} → {dateRange.to || "—"} · {uniqueDays} days
          </p>
        </div>
        {/* `primary`, and the reason is that there is nothing for it to compete
            with: Export PDF is the only button on this page, so `soft` would
            leave the flagship screen reading as though it offered no action at
            all. It is also the only variant carrying the --brand-glow ambient
            hover layer, which appears nowhere else in the app. The two exports
            on Statistics stay `soft` — they sit in a Card header among other
            controls, where one variant across pages does earn its keep.

            aria-label mirrors the visible caption instead of being a static
            string: the only text lives in a `hidden sm:inline` span, so below
            the sm breakpoint this is a bare icon with no accessible name at all
            (WCAG 4.1.2). Mirroring means a screen-reader user is told
            "Generating…" at the same moment a sighted user reads it. */}
        {luxuryUiEnabled ? (
          <div className="flex flex-wrap items-center gap-2">
            <SmartButtonGroup
              onDownloadPacket={handleExportPacket}
              onOpenSchedule={() => setIsScheduleOpen(true)}
              onOpenSimulator={() => {
                document.getElementById("ota-shift-section")?.scrollIntoView({ behavior: "smooth" });
              }}
              onClearCache={() => {
                refOcc();
                refSrc();
                refClerk();
                refGross();
                refExpenses?.();
                refPayroll?.();
                toast.success("Refreshing data from server authority...");
              }}
              isExporting={exporting}
            />
            <Button
              variant="primary"
              size="lg"
              onClick={handleExport}
              disabled={exporting}
              aria-label={exporting ? "Generating…" : "Export PDF"}
            >
              <FileDown className="h-4 w-4" />
              <span className="hidden sm:inline">{exporting ? "Generating…" : "Export PDF"}</span>
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="lg"
              onClick={handleExportPacket}
              aria-label="Export Monthly Owner Packet (.xlsx)"
              className="flex items-center gap-1.5 border-[#00E096]/30 text-[#00E096] hover:bg-[#00E096]/10"
            >
              <FileSpreadsheet className="h-4 w-4 text-[#00E096]" />
              <span className="hidden sm:inline">Owner Packet (.xlsx)</span>
            </Button>

            <Button
              variant="primary"
              size="lg"
              onClick={handleExport}
              disabled={exporting}
              aria-label={exporting ? "Generating…" : "Export PDF"}
            >
              <FileDown className="h-4 w-4" />
              <span className="hidden sm:inline">{exporting ? "Generating…" : "Export PDF"}</span>
            </Button>
          </div>
        )}
      </header>

      {exportError && (
        <div className="flex items-center gap-2 rounded-lg border border-[#FF6B6B]/30 bg-[#FF6B6B]/10 px-3 py-2 text-xs text-[#FF6B6B]">
          <TrendingDown className="h-4 w-4 shrink-0" /> The PDF was not created: {exportError}. Nothing was saved to your downloads.
        </div>
      )}

      {/* Color-coded glowing module cards */}
      <ModuleCards />

      <div ref={contentRef} className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <KpiCard
            label="Total Revenue"
            value={money2(totalRev.dollars)}
            sub={totalRev.ancillaryCents > 0
              ? `${uniqueDays} days · room ${money2(fromCents(totalRev.roomCents))} + ancillary ${money2(fromCents(totalRev.ancillaryCents))}`
              : `${uniqueDays} unique days`}
            accent={C.purple}
            icon={DollarSign}
            onClick={() => openProvenance("revenue")}
          />
          <KpiCard label="Rooms Sold" value={num(roomsSold)} sub={`of ${num(capacity)} available`} accent={C.cyan} icon={BedDouble} onClick={() => openProvenance("rooms")} />
          <KpiCard label="Occupancy" value={pct(occupancy)} sub={`Avg ${num(Math.round(roomsSold / (occRows.length || 1)))} rooms/night`} accent={C.green} icon={Percent} onClick={() => openProvenance("occupancy")} />
          <KpiCard label="ADR / RevPAR" value={money2(adr)} sub={`RevPAR ${money2(revpar)}`} accent={C.amber} icon={Gauge} onClick={() => openProvenance("adr")} />
        </div>

        {compareOn && prevStats && (
          <div className="rounded-2xl border border-[#00D4FF]/20 bg-[#00D4FF]/[0.04] p-4">
            <p className="text-xs uppercase tracking-widest text-[#00D4FF]">
              Comparison · {compareDateRange.from || "—"} → {compareDateRange.to || "—"}
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {[
                { label: "Revenue", cur: revenue, prev: prevStats.revenue, fmt: money2 },
                { label: "Rooms Sold", cur: roomsSold, prev: prevStats.roomsSold, fmt: num },
                { label: "Occupancy", cur: occupancy, prev: prevStats.occupancy, fmt: pct },
                { label: "ADR", cur: adr, prev: prevStats.adr, fmt: money2 },
              ].map((m) => {
                const diff = m.cur - m.prev;
                const ch = m.prev ? (diff / m.prev) * 100 : 0;
                return (
                  <div key={m.label} className="rounded-xl bg-[#0A1628]/60 p-3">
                    <p className="text-[10px] uppercase tracking-widest text-slate-500">{m.label}</p>
                    <p className="mt-1 text-sm text-white">{m.fmt(m.cur)} <span className="text-slate-500">vs {m.fmt(m.prev)}</span></p>
                    <p className={`text-xs ${diff >= 0 ? "text-[#00E096]" : "text-[#FF6B6B]"}`}>
                      {m.prev === 0 ? "N/A" : `${diff >= 0 ? "+" : ""}${m.fmt(diff)} (${ch >= 0 ? "+" : ""}${ch.toFixed(1)}%)`}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Estimated Money Kept — net profit after all deductions */}
        <Suspense fallback={<div className="h-48 animate-pulse rounded-xl bg-slate-800/50" />}>
          <MoneyKept 
            occRows={occRows} 
            srcRows={srcRows} 
            grossRows={grossRows} 
            dateRange={dateRange} 
            property={property} 
            aggPayRows={aggPayRows} 
            aggExpenses={aggExpenses} 
            expenses={expenses}
            payroll={payroll}
          />
        </Suspense>

        {/* Four fixed executive charts — always visible */}
        <Suspense fallback={<div className="flex h-64 items-center justify-center rounded-xl border border-white/10 bg-[#0A1628]/60"><Loader2 className="h-6 w-6 animate-spin text-slate-500" /></div>}>
          <ExecutiveCharts rows={occRows} />
        </Suspense>

        {lowOccDays.length > 0 && (
          <LowOccAlert occRows={occRows} sources={srcRows} />
        )}

        {alerts.map((a, i) => (
          <div
            key={i}
            className={`flex items-center gap-3 rounded-xl border p-4 ${
              a.sev === "Critical" ? "border-[#FF6B6B]/30 bg-[#FF6B6B]/[0.08]" : "border-[#FFB547]/20 bg-[#FFB547]/[0.06]"
            }`}
          >
            <TrendingDown className={`h-5 w-5 shrink-0 ${a.sev === "Critical" ? "text-[#FF6B6B]" : "text-[#FFB547]"}`} />
            <div className="flex-1">
              <p className="text-sm text-white">
                {a.sev === "Critical" ? "🚨 " : "⚠ "}{a.metric} Alert
              </p>
              <p className="text-xs text-slate-400">
                {a.metric} decreased {Math.abs(a.pct * 100).toFixed(1)}{a.metric === "Occupancy" ? " pts" : "%"} vs previous period
                {" · "}Now {a.fmt(a.current)} · Was {a.fmt(a.previous)}
              </p>
            </div>
            <span
              className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium ${
                a.sev === "Critical" ? "bg-[#FF6B6B]/15 text-[#FF6B6B]" : "bg-[#FFB547]/15 text-[#FFB547]"
              }`}
            >
              {a.sev}
            </span>
          </div>
        ))}

        {/* Operational Anomalies Alert — automated fraud/risk flags from CSV import */}
        {anomalyInRange.length > 0 && (
          <div className="rounded-2xl border border-[#FF6B6B]/30 bg-[#FF6B6B]/[0.07] p-4">
            <div className="flex items-center gap-3">
              <AlertTriangle className="h-5 w-5 shrink-0 text-[#FF6B6B]" />
              <div className="flex-1">
                <p className="text-sm font-medium text-white">
                  Operational Anomalies Alert · {anomalyInRange.length} flagged {anomalyInRange.length === 1 ? "entry" : "entries"} require review
                </p>
                <p className="text-xs text-slate-400">
                  Automated flags from imported transaction ledgers — rate overrides, adjustment/void spikes, off-hours postings.
                </p>
              </div>
            </div>
            <div className="mt-3 space-y-2">
              {anomalyInRange.map((a) => (
                <div key={a.id} className="flex flex-wrap items-center gap-3 rounded-lg bg-[#0A1628]/60 px-3 py-2">
                  <span
                    className={`shrink-0 rounded-full px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
                      a.severity === "high" ? "bg-[#FF6B6B]/20 text-[#FF6B6B]" : "bg-[#FFB547]/15 text-[#FFB547]"
                    }`}
                  >
                    {a.severity}
                  </span>
                  <span className="shrink-0 rounded-full bg-[#00D4FF]/15 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[#00D4FF]">
                    {a.alert_type === "rate_override" ? "Rate Override"
                      : a.alert_type === "excessive_adjustments" ? "Adjustment / Void Spike"
                      : "Off-Hours Posting"}
                  </span>
                  <p className="min-w-0 flex-1 text-xs text-slate-300">{a.detail}</p>
                  <p className="shrink-0 text-xs text-slate-400">
                    {a.date} · {a.username}
                    {a.folio_number ? ` · Folio ${a.folio_number}` : ""}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Owner Intelligence Insights */}
        {(() => {
          const insights = OwnerIntelligenceService.generateExecutiveInsights(
            occRows, aggPayRows, aggExpenses, payroll, srcRows, grossRows, properties, dateRange
          );
          if (insights.length === 0) return null;
          return (
            <Card title="🧠 Owner Intelligence" subtitle="AI-detected patterns, risks, and opportunities">
              <div className="space-y-3">
                {insights.map((insight, i) => (
                  <div key={i} className="flex items-start gap-3 rounded-xl border border-white/5 bg-[#0A1628]/60 p-4">
                    <div className="flex-shrink-0 w-10 h-10 rounded-lg flex items-center justify-center"
                         style={{ background: insight.category === 'Risk' || insight.category === 'Profit' ? '#FF6B6B20' : insight.category === 'Expenses' ? '#FFB54720' : '#00E09620' }}>
                      {insight.category === 'Revenue' && <TrendingUp className="h-5 w-5 text-[#00E096]" />}
                      {insight.category === 'Portfolio' && <TrendingUp className="h-5 w-5 text-[#00D4FF]" />}
                      {insight.category === 'Channels' && <Lightbulb className="h-5 w-5 text-[#FFB547]" />}
                      {insight.category === 'Expenses' && <AlertTriangle className="h-5 w-5 text-[#FFB547]" />}
                      {insight.category === 'Risk' && <AlertTriangle className="h-5 w-5 text-[#FF6B6B]" />}
                      {insight.category === 'Profit' && <AlertTriangle className="h-5 w-5 text-[#FF6B6B]" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-white">{insight.title}</p>
                      <p className="text-xs text-slate-400 mt-0.5">{insight.detail}</p>
                      <div className="mt-2 flex items-center gap-2">
                        <span className="text-lg font-heading font-semibold tabular-nums"
                              style={{ color: insight.category === 'Risk' || insight.category === 'Profit' ? '#FF6B6B' : '#00E096' }}>
                          {insight.metric}
                        </span>
                        <span className="text-[10px] uppercase tracking-widest text-slate-500 px-2 py-0.5 rounded"
                              style={{ background: insight.category === 'Risk' || insight.category === 'Profit' ? '#FF6B6B20' : '#00D4FF20', 
                                      color: insight.category === 'Risk' || insight.category === 'Profit' ? '#FF6B6B' : '#00D4FF' }}>
                          {insight.category}
                        </span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          );
        })()}

        {/* Portfolio breakdown — only when All Properties selected */}
        {isPortfolio && occRows.length > 0 && (
          <PropertyRanking occRows={occRows} properties={properties} compareOccRows={alertPrevOcc} />
        )}

        <RevenueTrend rows={occRows} dateRange={`${dateRange.from || "—"} to ${dateRange.to || "—"}`} />
        <Suspense fallback={<div className="flex h-64 items-center justify-center rounded-xl border border-white/10 bg-[#0A1628]/60"><Loader2 className="h-6 w-6 animate-spin text-slate-500" /></div>}>
          <OtaMatrix rows={srcRows} />
        </Suspense>

        {luxuryUiEnabled && (
          <div id="ota-shift-section" className="space-y-6">
            <OTAShiftSimulator
              grossOtaRevenue={otaEconomics.grossDollars}
              otaCommissionRate={otaEconomics.rate}
              periodDays={uniqueDays}
            />
            <OwnerPacketPreview
              onDownloadPacket={handleExportPacket}
              revenue={totalRev.dollars || revenue}
              roomsSold={roomsSold}
              occupancy={occupancy}
              propertiesCount={isPortfolio ? properties.length : 1}
              isExporting={exporting}
              reconciliation={reconciliation}
              portfolioHealth={portfolioHealth}
            />
          </div>
        )}

        <WeatherPanel />
        <PricingPanel />

        {miscCharges.length > 0 && (
          <Card title="Miscellaneous charges" subtitle="Non-room revenue breakdown for selected period">
            <div className="space-y-2">
              {miscCharges.map((c) => {
                const maxVal = miscCharges[0].value;
                return (
                  <div key={c.label} className="flex items-center gap-3">
                    <span className="w-28 text-sm text-slate-300">{c.label}</span>
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-white/5">
                      <div className="h-full rounded-full bg-[#FFB547]" style={{ width: `${(c.value / maxVal) * 100}%` }} />
                    </div>
                    <span className="w-24 text-right text-sm tabular-nums text-slate-400">{money2(c.value)}</span>
                  </div>
                );
              })}
            </div>
          </Card>
        )}

        <div className="grid gap-6 lg:grid-cols-2">
          <ClerkAudit records={clerkFiltered} />
          <YieldAdvisor occupancy={occupancy} adr={adr} revpar={revpar} capacity={capacity} roomsSold={roomsSold} />
        </div>
      </div>

      <KpiProvenanceDrawer
        isOpen={isProvenanceOpen}
        onClose={() => setIsProvenanceOpen(false)}
        metric={provenanceMetric}
      />

      <ScheduleReportDialog
        isOpen={isScheduleOpen}
        onClose={() => setIsScheduleOpen(false)}
        onSendTest={handleExportPacket}
      />
    </div>
  );
}
