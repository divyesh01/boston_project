import React, { useMemo, useState, useRef } from "react";
import { DollarSign, BedDouble, Percent, Gauge, RefreshCw, FileDown, TrendingDown } from "lucide-react";
import KpiCard from "@/components/ui-exec/KpiCard";
import Card from "@/components/ui-exec/Card";
import OtaMatrix from "@/components/dashboard/OtaMatrix";
import ClerkAudit from "@/components/dashboard/ClerkAudit";
import YieldAdvisor from "@/components/dashboard/YieldAdvisor";
import RevenueTrend from "@/components/dashboard/RevenueTrend";
import ExecutiveCharts from "@/components/dashboard/ExecutiveCharts";
import MoneyKept from "@/components/dashboard/MoneyKept";
import PropertyRanking from "@/components/dashboard/PropertyRanking";
import LowOccAlert from "@/components/dashboard/LowOccAlert";
import { useOccupancy, useSources, useClerkRecords, useGrossRevenue } from "@/lib/useHotelData";
import { usePullToRefresh } from "@/hooks/usePullToRefresh";
import { exportToPdf } from "@/lib/pdfExport";
import { money, money2, num, pct, sum, inRange, C, getOccThreshold } from "@/lib/hotel";
import { getAlertThresholds } from "@/lib/alertThresholds";
import { useGlobalFilters } from "@/lib/useGlobalFilters";

export default function Dashboard() {
  const { dateRange, property, properties, compareOn, compareDateRange, compareMonths, employee, paymentType, channel, months } = useGlobalFilters();
  const isPortfolio = property === "all" || Array.isArray(property);
  const selectedProp = isPortfolio ? null : properties.find((p) => p.id === property);
  const propRooms = selectedProp?.rooms || 100;
  const propName = isPortfolio ? (Array.isArray(property) ? `${property.length} Properties` : "All Properties / Portfolio") : (selectedProp?.name || "Property");

  const { data: occ = [], isLoading, refetch: refOcc } = useOccupancy(dateRange, property, months);
  const { data: prevOcc = [] } = useOccupancy(compareOn ? compareDateRange : { from: "", to: "" }, property, compareOn ? compareMonths : [], compareOn);
  const { data: sources = [], refetch: refSrc } = useSources(dateRange, property, months);
  const { data: clerk = [], refetch: refClerk } = useClerkRecords(dateRange, property);
  const { data: gross = [], refetch: refGross } = useGrossRevenue(dateRange, property, months);

  // Dedicated previous-period range for trend alerts (independent of the current filter)
  const alertPrevRange = useMemo(() => {
    if (!dateRange.from || !dateRange.to) return { from: "", to: "" };
    const periodDays = Math.round((new Date(dateRange.to) - new Date(dateRange.from)) / 86400000) + 1;
    if (periodDays <= 0) return { from: "", to: "" };
    const prevTo = new Date(new Date(dateRange.from).getTime() - 86400000);
    const prevFrom = new Date(prevTo.getTime() - (periodDays - 1) * 86400000);
    return { from: prevFrom.toISOString().slice(0, 10), to: prevTo.toISOString().slice(0, 10) };
  }, [dateRange]);
  const { data: alertPrevOcc = [] } = useOccupancy(alertPrevRange, property, [], !!(alertPrevRange.from && alertPrevRange.to));
  const [exporting, setExporting] = useState(false);
  const contentRef = useRef(null);

  const occRows = useMemo(() => occ.filter((r) => inRange(r.date, dateRange.from, dateRange.to)), [occ, dateRange]);
  const srcRows = useMemo(() => {
    let r = sources.filter((x) => inRange(x.date, dateRange.from, dateRange.to));
    if (channel !== "all") r = r.filter((x) => x.source === channel || x.code === channel);
    return r;
  }, [sources, dateRange, channel]);
  const grossRows = useMemo(() => gross.filter((r) => inRange(r.date, dateRange.from, dateRange.to)), [gross, dateRange]);
  const clerkFiltered = useMemo(() => {
    let r = clerk;
    if (employee !== "all") r = r.filter((x) => x.clerk_name === employee);
    if (paymentType !== "all") r = r.filter((x) => (x.payment_type || "").toUpperCase() === paymentType);
    return r;
  }, [clerk, employee, paymentType]);

  const handleRefresh = async () => {
    await Promise.all([refOcc(), refSrc(), refClerk(), refGross()]);
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

  const uniqueDays = new Set(occRows.map((r) => String(r.date).slice(0, 10))).size;
  const revenue = sum(occRows, "total_revenue");
  const roomsSold = sum(occRows, "rooms_sold");

  const capacity = useMemo(() => {
    if (isPortfolio) {
      const daysPerProp = new Map();
      occRows.forEach((r) => {
        const pid = r.property_id || "_default";
        daysPerProp.set(pid, (daysPerProp.get(pid) || 0) + 1);
      });
      let cap = 0;
      daysPerProp.forEach((days, pid) => {
        const rooms = roomCounts[pid] ?? 100;
        cap += days * rooms;
      });
      return cap;
    }
    return occRows.length * propRooms;
  }, [occRows, isPortfolio, propRooms, roomCounts]);

  const occupancy = capacity ? roomsSold / capacity : 0;
  const adr = roomsSold ? revenue / roomsSold : 0;
  const revpar = capacity ? revenue / capacity : 0;

  const prevStats = useMemo(() => {
    if (!compareOn || !prevOcc.length) return null;
    const prevRev = sum(prevOcc, "total_revenue");
    const prevRooms = sum(prevOcc, "rooms_sold");
    const prevCap = isPortfolio
      ? Object.values(roomCounts).reduce((a, rooms) => a + rooms * (prevOcc.length / properties.length), 0)
      : prevOcc.length * propRooms;
    return {
      revenue: prevRev,
      roomsSold: prevRooms,
      occupancy: prevCap ? prevRooms / prevCap : 0,
      adr: prevRooms ? prevRev / prevRooms : 0,
    };
  }, [compareOn, prevOcc, isPortfolio, propRooms, roomCounts, properties.length]);

  const threshold = getOccThreshold();
  const lowOccDays = useMemo(() => occRows.filter((r) => Number(r.occupancy || 0) < threshold), [occRows, threshold]);

  const alerts = useMemo(() => {
    if (!dateRange.from || !dateRange.to || !occ.length || !alertPrevOcc.length) return [];
    const thresholds = getAlertThresholds();

    const prevRows = alertPrevOcc;
    const prevRev = sum(prevRows, "total_revenue");
    const prevRooms = sum(prevRows, "rooms_sold");
    const prevCap = isPortfolio
      ? Object.values(roomCounts).reduce((a, rooms) => a + rooms * (prevRows.length / properties.length), 0)
      : prevRows.length * propRooms;
    const prevOccVal = prevCap ? prevRooms / prevCap : 0;
    const prevAdr = prevRooms ? prevRev / prevRooms : 0;

    const out = [];
    if (prevRev > 0) {
      const ch = (revenue - prevRev) / prevRev;
      if (ch <= -thresholds.revenueDecreasePct)
        out.push({ metric: "Revenue", current: revenue, previous: prevRev, pct: ch, sev: Math.abs(ch) >= 0.2 ? "Critical" : "Warning", fmt: money });
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
  }, [occ, alertPrevOcc, dateRange, revenue, occupancy, adr, isPortfolio, propRooms, roomCounts, properties.length]);

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

  const handleExport = async () => {
    if (exporting || !contentRef.current) return;
    setExporting(true);
    try {
      await exportToPdf(contentRef.current, `RRI_Executive_${property}_${dateRange.from}_${dateRange.to}.pdf`);
    } catch (e) {
      console.error(e);
    }
    setExporting(false);
  };

  if (isLoading) return <p className="text-slate-500">Loading executive data…</p>;

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
        <button
          onClick={handleExport}
          disabled={exporting}
          className="flex h-11 items-center gap-2 rounded-lg bg-[#6C63FF] px-4 text-sm font-medium text-white transition-colors hover:bg-[#5b52e8] disabled:opacity-50"
        >
          <FileDown className="h-4 w-4" />
          <span className="hidden sm:inline">{exporting ? "Generating…" : "Export PDF"}</span>
        </button>
      </header>

      <div ref={contentRef} className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <KpiCard label="Total Revenue" value={money(revenue)} sub={`${uniqueDays} unique days`} accent={C.purple} icon={DollarSign} />
          <KpiCard label="Rooms Sold" value={num(roomsSold)} sub={`of ${num(capacity)} available`} accent={C.cyan} icon={BedDouble} />
          <KpiCard label="Occupancy" value={pct(occupancy)} sub={`Avg ${num(Math.round(roomsSold / (occRows.length || 1)))} rooms/night`} accent={C.green} icon={Percent} />
          <KpiCard label="ADR / RevPAR" value={money2(adr)} sub={`RevPAR ${money2(revpar)}`} accent={C.amber} icon={Gauge} />
        </div>

        {compareOn && prevStats && (
          <div className="rounded-2xl border border-[#00D4FF]/20 bg-[#00D4FF]/[0.04] p-4">
            <p className="text-xs uppercase tracking-widest text-[#00D4FF]">
              Comparison · {compareDateRange.from || "—"} → {compareDateRange.to || "—"}
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {[
                { label: "Revenue", cur: revenue, prev: prevStats.revenue, fmt: money },
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
        <MoneyKept occRows={occRows} srcRows={srcRows} dateRange={dateRange} property={property} />

        {/* Four fixed executive charts — always visible */}
        <ExecutiveCharts rows={occRows} />

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

        {/* Portfolio breakdown — only when All Properties selected */}
        {isPortfolio && occRows.length > 0 && (
          <PropertyRanking occRows={occRows} properties={properties} />
        )}

        <RevenueTrend rows={occRows} dateRange={`${dateRange.from || "—"} to ${dateRange.to || "—"}`} />
        <OtaMatrix rows={srcRows} />

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
                    <span className="w-24 text-right text-sm tabular-nums text-slate-400">{money(c.value)}</span>
                  </div>
                );
              })}
            </div>
          </Card>
        )}

        <div className="grid gap-6 lg:grid-cols-2">
          <ClerkAudit records={clerkFiltered} />
          <YieldAdvisor occupancy={occupancy} adr={adr} revpar={revpar} />
        </div>
      </div>
    </div>
  );
}