import React, { useMemo, useState } from "react";
import {
  DollarSign, Percent, Gauge, TrendingUp, TrendingDown, ChevronLeft, ChevronRight, X,
} from "lucide-react";
import KpiCard from "@/components/ui-exec/KpiCard";
import Card from "@/components/ui-exec/Card";
import { useOccupancy, useSources } from "@/lib/useHotelData";
import { useGlobalFilters, MONTHS_LONG } from "@/lib/useGlobalFilters";
import { money, money2, pct, num, sum, inRange, C } from "@/lib/hotel";
import { getRevenueColor, getRevenueGroup, getRevenueGroupLabel, getRevenueThresholds } from "@/lib/revenueThresholds";

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default function MonthlyCalendar() {
  const { dateRange, property, properties, month, year, months } = useGlobalFilters();
  const { data: occ = [] } = useOccupancy(dateRange, property, months);
  const { data: sources = [] } = useSources(dateRange, property, months);
  const [selectedDay, setSelectedDay] = useState(null);

  const occRows = useMemo(
    () => occ.filter((r) => inRange(r.date, dateRange.from, dateRange.to)),
    [occ, dateRange]
  );

  const byDate = useMemo(() => {
    const map = new Map();
    occRows.forEach((r) => {
      const d = String(r.date).slice(0, 10);
      map.set(d, r);
    });
    return map;
  }, [occRows]);

  const srcByDate = useMemo(() => {
    const map = new Map();
    sources.forEach((r) => {
      const d = String(r.date).slice(0, 10);
      if (!map.has(d)) map.set(d, []);
      map.get(d).push(r);
    });
    return map;
  }, [sources]);

  const kpis = useMemo(() => {
    const revenue = sum(occRows, "total_revenue");
    const roomsSold = sum(occRows, "rooms_sold");
    const totalRooms = occRows.length * (properties.find((p) => p.id === property)?.rooms || 100);
    const days = occRows.length;
    return {
      revenue,
      occupancy: totalRooms > 0 ? roomsSold / totalRooms : 0,
      adr: roomsSold > 0 ? revenue / roomsSold : 0,
      revpar: totalRooms > 0 ? revenue / totalRooms : 0,
      highest: occRows.length ? Math.max(...occRows.map((r) => r.total_revenue || 0)) : 0,
      lowest: occRows.length ? Math.min(...occRows.map((r) => r.total_revenue || 0)) : 0,
      days,
    };
  }, [occRows, properties, property]);

  // Build calendar grid
  const calYear = year || new Date().getFullYear();
  const calMonth = month !== null ? month : new Date().getMonth();
  const firstDay = new Date(calYear, calMonth, 1);
  const lastDayNum = new Date(calYear, calMonth + 1, 0).getDate();
  const startDow = firstDay.getDay();
  const cells = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let d = 1; d <= lastDayNum; d++) {
    const dateStr = `${calYear}-${String(calMonth + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    cells.push({ date: dateStr, day: d, data: byDate.get(dateStr) });
  }

  const groups = useMemo(() => {
    const g = { high: [], medium: [], low: [], nodata: [] };
    cells.forEach((c) => {
      if (!c) return;
      if (!c.data) { g.nodata.push(c); return; }
      const group = getRevenueGroup(c.data.total_revenue || 0);
      g[group].push(c);
    });
    return g;
  }, [cells]);

  const groupStats = (groupCells) => {
    if (!groupCells.length) return { days: 0, revenue: 0, pct: 0, occupancy: 0, adr: 0, revpar: 0 };
    const revenue = groupCells.reduce((a, c) => a + (c.data?.total_revenue || 0), 0);
    const roomsSold = groupCells.reduce((a, c) => a + (c.data?.rooms_sold || 0), 0);
    const totalRooms = groupCells.length * (properties.find((p) => p.id === property)?.rooms || 100);
    return {
      days: groupCells.length,
      revenue,
      pct: kpis.revenue > 0 ? revenue / kpis.revenue : 0,
      occupancy: totalRooms > 0 ? roomsSold / totalRooms : 0,
      adr: roomsSold > 0 ? revenue / roomsSold : 0,
      revpar: totalRooms > 0 ? revenue / totalRooms : 0,
    };
  };

  const selectedData = selectedDay ? byDate.get(selectedDay) : null;
  const selectedSources = selectedDay ? (srcByDate.get(selectedDay) || []) : [];
  const prevDayData = selectedDay ? byDate.get(
    new Date(new Date(selectedDay).getTime() - 86400000).toISOString().slice(0, 10)
  ) : null;

  const channelRanking = useMemo(() => {
    if (!selectedSources.length) return [];
    const ranked = selectedSources
      .map((s) => ({
        name: s.source || s.code || "Unknown",
        gross: s.net_revenue || 0,
        commission: 0,
        net: s.net_revenue || 0,
        stays: s.stays || 0,
      }))
      .sort((a, b) => b.net - a.net);
    const total = ranked.reduce((a, r) => a + r.net, 0);
    return ranked.map((r, i) => ({ ...r, rank: i + 1, pct: total > 0 ? r.net / total : 0 }));
  }, [selectedSources]);

  return (
    <div className="space-y-6">
      <header>
        <p className="text-[11px] uppercase tracking-[0.3em] text-[#00D4FF]">Owner Intelligence</p>
        <h1 className="mt-2 font-heading text-3xl font-semibold text-white">Monthly Calendar View</h1>
        <p className="mt-1 text-sm text-slate-400">
          Visualize daily performance patterns, channel dominance, and yield rhythms for {MONTHS_LONG[calMonth]} {calYear}.
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <KpiCard label="Total Monthly Revenue" value={money(kpis.revenue)} sub={`${kpis.days} days with data`} accent={C.purple} icon={DollarSign} />
        <KpiCard label="Average Occupancy" value={pct(kpis.occupancy)} accent={C.cyan} icon={Percent} />
        <KpiCard label="Average ADR" value={money2(kpis.adr)} accent={C.amber} icon={Gauge} />
        <KpiCard label="Average RevPAR" value={money2(kpis.revpar)} accent={C.green} icon={Gauge} />
        <KpiCard label="Highest Day" value={money(kpis.highest)} sub="Peak revenue day" accent="#4ade80" icon={TrendingUp} />
        <KpiCard label="Lowest Day" value={money(kpis.lowest)} sub="Minimum revenue day" accent="#ff6b6b" icon={TrendingDown} />
      </div>

      <Card
        title={`${MONTHS_LONG[calMonth]} ${calYear} Calendar`}
        subtitle="Green ≥ $6K · Gray $3.5K–$6K · Red < $3.5K (editable in Settings)"
      >
        <div className="grid grid-cols-7 gap-1.5 sm:gap-2">
          {DOW.map((d) => (
            <div key={d} className="pb-2 text-center text-xs font-medium text-slate-500">{d}</div>
          ))}
          {cells.map((cell, i) => {
            if (!cell) return <div key={i} className="min-h-[90px] sm:min-h-[120px]" />;
            const revenue = cell.data?.total_revenue || 0;
            const color = cell.data ? getRevenueColor(revenue) : "transparent";
            const occPct = cell.data?.occupancy ? (cell.data.occupancy > 1 ? cell.data.occupancy : cell.data.occupancy * 100) : 0;
            return (
              <button
                key={i}
                onClick={() => setSelectedDay(cell.date)}
                className={`min-h-[90px] rounded-lg border p-2 text-left transition-all sm:min-h-[120px] ${
                  selectedDay === cell.date ? "border-[#00D4FF] ring-1 ring-[#00D4FF]" : "border-white/5"
                } ${!cell.data ? "bg-[#0A1628]/40" : ""}`}
                style={cell.data ? { backgroundColor: `${color}15`, borderLeft: `3px solid ${color}` } : {}}
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-white">{cell.day}</span>
                  {cell.data && <span className="text-[10px] text-slate-400">{occPct.toFixed(0)}%</span>}
                </div>
                {cell.data ? (
                  <div className="mt-1 space-y-0.5 text-[10px] text-slate-300">
                    <div className="font-heading font-semibold text-sm tabular-nums text-white">{money(revenue)}</div>
                    <div>ADR {money2(cell.data.adr || 0)}</div>
                    <div>RevPAR {money2(cell.data.revpar || 0)}</div>
                  </div>
                ) : (
                  <div className="mt-2 text-[10px] text-slate-600">No Data</div>
                )}
              </button>
            );
          })}
        </div>
      </Card>

      {/* Monthly Performance Groups */}
      <div className="grid gap-4 lg:grid-cols-3">
        {["high", "medium", "low"].map((g) => {
          const stats = groupStats(groups[g]);
          const color = g === "high" ? "#4ade80" : g === "medium" ? "#94a3b8" : "#ff6b6b";
          return (
            <Card key={g} title={getRevenueGroupLabel(g)} subtitle={`${stats.days} days · ${pct(stats.pct)} of revenue`}>
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <div className="h-3 w-3 rounded-full" style={{ backgroundColor: color }} />
                  <span className="text-2xl font-heading font-semibold text-white">{money(stats.revenue)}</span>
                </div>
                <div className="grid grid-cols-3 gap-2 text-xs">
                  <div>
                    <p className="text-slate-500">Occ</p>
                    <p className="text-slate-200">{pct(stats.occupancy)}</p>
                  </div>
                  <div>
                    <p className="text-slate-500">ADR</p>
                    <p className="text-slate-200">{money2(stats.adr)}</p>
                  </div>
                  <div>
                    <p className="text-slate-500">RevPAR</p>
                    <p className="text-slate-200">{money2(stats.revpar)}</p>
                  </div>
                </div>
              </div>
            </Card>
          );
        })}
      </div>

      {groups.nodata.length > 0 && (
        <div className="rounded-xl border border-[#FFB547]/20 bg-[#FFB547]/[0.06] p-4">
          <p className="text-sm text-[#FFB547]">
            ⚠ {groups.nodata.length} days have no imported data for {MONTHS_LONG[calMonth]} {calYear}. Import reports to see full performance.
          </p>
        </div>
      )}

      {/* Daily Detail Panel */}
      {selectedDay && (
        <div className="fixed inset-0 z-50 flex items-end justify-end sm:items-center sm:justify-center" onClick={() => setSelectedDay(null)}>
          <div className="absolute inset-0 bg-black/60" />
          <div
            className="relative w-full max-w-lg rounded-t-3xl border border-white/10 bg-[#0F1F35] p-6 sm:rounded-2xl"
            onClick={(e) => e.stopPropagation()}
            style={{ maxHeight: "85vh", overflowY: "auto" }}
          >
            <div className="mb-4 flex items-center justify-between">
              <h3 className="font-heading text-xl font-semibold text-white">
                {new Date(selectedDay).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
              </h3>
              <button onClick={() => setSelectedDay(null)} className="text-slate-400 hover:text-white">
                <X className="h-5 w-5" />
              </button>
            </div>

            {selectedData ? (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <Metric label="Total Room Revenue" current={selectedData.total_revenue || 0} previous={prevDayData?.total_revenue || 0} fmt={money} />
                  <Metric label="Occupancy" current={selectedData.occupancy > 1 ? selectedData.occupancy / 100 : selectedData.occupancy || 0} previous={prevDayData?.occupancy > 1 ? prevDayData.occupancy / 100 : prevDayData?.occupancy || 0} fmt={pct} suffix=" pts" />
                  <Metric label="ADR" current={selectedData.adr || 0} previous={prevDayData?.adr || 0} fmt={money2} />
                  <Metric label="RevPAR" current={selectedData.revpar || 0} previous={prevDayData?.revpar || 0} fmt={money2} />
                </div>

                <div className="rounded-xl border border-white/5 bg-[#0A1628] p-4">
                  <p className="text-xs text-slate-500">Rooms Sold</p>
                  <p className="text-lg text-white">{num(selectedData.rooms_sold || 0)} / {num(selectedData.total_rooms || 0)}</p>
                </div>

                {channelRanking.length > 0 && (
                  <div>
                    <p className="mb-2 text-xs uppercase tracking-widest text-slate-500">Channel Ecosystem · Ranked by Net Revenue</p>
                    <div className="space-y-1.5">
                      {channelRanking.slice(0, 10).map((ch) => (
                        <div key={ch.rank} className="flex items-center justify-between rounded-lg bg-[#0A1628] px-3 py-2 text-sm">
                          <span className="flex items-center gap-2 text-slate-200">
                            <span className="w-5 text-xs text-slate-500">#{ch.rank}</span>
                            {ch.name}
                          </span>
                          <span className="tabular-nums text-slate-300">
                            {money(ch.gross)} · {pct(ch.pct)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="py-8 text-center">
                <p className="text-slate-500">No data imported for this day.</p>
                <a href="/upload" className="mt-2 inline-block text-sm text-[#00D4FF] underline">Import reports →</a>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Metric({ label, current, previous, fmt, suffix = "" }) {
  const diff = current - previous;
  const pctCh = previous > 0 ? (diff / previous) * 100 : 0;
  return (
    <div className="rounded-xl border border-white/5 bg-[#0A1628] p-3">
      <p className="text-[10px] uppercase tracking-widest text-slate-500">{label}</p>
      <p className="mt-1 text-lg font-heading font-semibold text-white">{fmt(current)}</p>
      <p className="text-xs text-slate-500">Previous: {fmt(previous)}</p>
      <p className={`text-xs ${diff >= 0 ? "text-[#00E096]" : "text-[#FF6B6B]"}`}>
        {previous === 0 ? "N/A" : `${diff >= 0 ? "+" : ""}${fmt(diff)}${suffix} (${pctCh >= 0 ? "+" : ""}${pctCh.toFixed(1)}%)`}
      </p>
    </div>
  );
}