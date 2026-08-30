import React, { useMemo, useState } from "react";
import {
  DollarSign, Percent, Gauge, TrendingUp, TrendingDown, X,
} from "lucide-react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import KpiCard from "@/components/ui-exec/KpiCard";
import Card from "@/components/ui-exec/Card";
import { useOccupancy, useSources } from "@/lib/useHotelData";
import { useGlobalFilters, MONTHS_LONG } from "@/lib/useGlobalFilters";
import { Link } from "react-router-dom";
import { money, money2, pct, num, inRange, C, occupancyStats, commissionFor, grossUpFromNetCents, formatDayLabel } from "@/lib/hotel";
import { toCents, fromCents } from "@/lib/decimal";
import { getRevenueThresholds, getRevenueColor, getRevenueGroup, getRevenueGroupLabel } from "@/lib/revenueThresholds";
import { calendarMonths, daysInMonth, MAX_GRIDS } from "@/lib/calendarGrids";
import { getEventsInRange, DEMAND_ORDER, DEMAND_COLORS, peakDemand, distanceColor } from "@/lib/eventSchedule";
import { ErrorState } from "@/components/ui/status";

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default function MonthlyCalendar() {
  const { dateRange, property, properties, year, months, period } = useGlobalFilters();
  const occQ = useOccupancy(dateRange, property, months);
  const sourcesQ = useSources(dateRange, property, months);
  const { data: occ = [] } = occQ;
  const { data: sources = [] } = sourcesQ;
  const [selectedDay, setSelectedDay] = useState(null);
  const [eventPopupDay, setEventPopupDay] = useState(null);
  // Read the configured thresholds so the legend cannot drift from the colours.
  const revThresholds = getRevenueThresholds();

  const occRows = useMemo(
    () => occ.filter((r) => inRange(r.date, dateRange.from, dateRange.to)),
    [occ, dateRange]
  );

  const byDate = useMemo(() => {
    // Group every row for a date, not just the last one. In portfolio ("all") mode
    // the reads return one row PER PROPERTY per date, so the old `map.set(d, r)`
    // kept only the last property's row: the calendar cell showed a single property
    // while the KPI cards above aggregated the whole portfolio, and the two numbers
    // disagreed. Dates with a single row are passed through unchanged.
    const groups = new Map();
    occRows.forEach((r) => {
      const d = String(r.date).slice(0, 10);
      if (!groups.has(d)) groups.set(d, []);
      groups.get(d).push(r);
    });
    const map = new Map();
    groups.forEach((rows, d) => {
      if (rows.length === 1) { map.set(d, rows[0]); return; }
      // Reuse the SAME aggregator the KPI cards use (occupancyStats) so a cell can
      // never drift from the header. occupancy comes back as a 0..1 fraction, which
      // both the cell and the day modal already normalise.
      const s = occupancyStats(rows, properties);
      map.set(d, {
        ...rows[0],
        date: d,
        property_id: "all",
        property_name: `${rows.length} properties`,
        room_revenue: s.revenue,
        rooms_sold: s.roomsSold,
        total_rooms: s.capacity,
        occupancy: s.occupancy,
        adr: s.adr,
        revpar: s.revpar,
      });
    });
    return map;
  }, [occRows, properties]);

  const srcByDate = useMemo(() => {
    const map = new Map();
    sources.forEach((r) => {
      const d = String(r.date).slice(0, 10);
      if (!map.has(d)) map.set(d, []);
      map.get(d).push(r);
    });
    return map;
  }, [sources]);

  // Build calendar grids from the SAME date range the KPIs are computed from.
  // This used to be `period === "monthly" && months.length > 1`, which is false for
  // ytd, yearly, quarterly, weekly, daily and custom — so all six fell into a
  // single-month branch and the page drew, titled and labelled ONE month while the
  // KPIs below aggregated the whole range (observed on the live site: "for August
  // 2026" over "214 days with data"). calendarMonths() returns {year, month} pairs;
  // the year travels with the month because a weekly or custom range can straddle a
  // year boundary, and a grid titled from a single hardcoded year cannot.
  const allMonths = useMemo(
    () => calendarMonths({ period, months, year, dateRange }),
    [period, months, year, dateRange]
  );
  // Rendering is capped, the selection is not: a range longer than MAX_GRIDS months
  // still drives the KPIs and the label, and the surplus is stated below the grids
  // rather than silently dropped.
  const displayMonths = useMemo(() => allMonths.slice(0, MAX_GRIDS), [allMonths]);
  const hiddenGrids = allMonths.length - displayMonths.length;
  const isMultiMonth = allMonths.length > 1;

  // Events for the displayed calendar months. Expanded from the shared schedule
  // (one-time + recurring), keyed by date so each calendar cell can badge demand.
  const eventsByDate = useMemo(() => {
    const first = displayMonths[0];
    const last = displayMonths[displayMonths.length - 1];
    const map = new Map();
    getEventsInRange({
      from: `${first.year}-${String(first.month + 1).padStart(2, "0")}-01`,
      to: `${last.year}-${String(last.month + 1).padStart(2, "0")}-${daysInMonth(last.year, last.month)}`,
    }).forEach((e) => {
      if (!map.has(e.date)) map.set(e.date, []);
      map.get(e.date).push(e);
    });
    return map;
  }, [displayMonths]);

  const selectedEvents = selectedDay ? (eventsByDate.get(selectedDay) || []) : [];
  const eventPopupEvents = eventPopupDay ? (eventsByDate.get(eventPopupDay) || []) : [];

  const grids = useMemo(() => {
    return displayMonths.map(({ year: gridYear, month: m }) => {
      const startDow = new Date(gridYear, m, 1).getDay();
      const lastDayNum = daysInMonth(gridYear, m);
      const cells = [];
      for (let i = 0; i < startDow; i++) cells.push(null);
      for (let d = 1; d <= lastDayNum; d++) {
        const dateStr = `${gridYear}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
        cells.push({ date: dateStr, day: d, data: byDate.get(dateStr) });
      }
      return { year: gridYear, month: m, cells };
    });
  }, [displayMonths, byDate]);

  const periodLabel = useMemo(() => {
    const name = (p) => `${MONTHS_LONG[p.month]} ${p.year}`;
    const first = allMonths[0];
    const last = allMonths[allMonths.length - 1];
    return isMultiMonth ? `${name(first)} - ${name(last)}` : name(first);
  }, [allMonths, isMultiMonth]);

  // KPIs describe the whole selected period — not just the first drawn month.
  // Previously they were computed from a single-month slice, so selecting
  // Apr–Jul showed April's $142,136 / 30 days above a badge reading
  // "2026-04-01 to 2026-07-31". Now they aggregate over the full date range.
  const kpis = useMemo(() => {
    const s = occupancyStats(occRows, properties);
    return {
      revenue: s.revenue,
      occupancy: s.occupancy,
      adr: s.adr,
      revpar: s.revpar,
      highest: occRows.length ? Math.max(...occRows.map((r) => r.room_revenue || 0)) : 0,
      lowest: occRows.length ? Math.min(...occRows.map((r) => r.room_revenue || 0)) : 0,
      days: s.days,
    };
  }, [occRows, properties]);

  const groups = useMemo(() => {
    const g = { high: [], medium: [], low: [], nodata: [] };
    grids.forEach((grid) => {
      grid.cells.forEach((c) => {
        if (!c) return;
        if (!c.data) { g.nodata.push(c); return; }
        // Classified by the same field the cells are coloured by, and against the
        // same thresholds the card subtitle prints. This used to read
        // `c.data.total_revenue`, which the CSV importer never writes (the export's
        // "Total Revenue" column is stored as total_revenue_with_misc), so every
        // imported day was grouped "low" while its cell was painted green.
        const group = getRevenueGroup(c.data.room_revenue || 0);
        g[group].push(c);
      });
    });
    return g;
  }, [grids]);

  const groupStats = (groupCells) => {
    if (!groupCells.length) return { days: 0, revenue: 0, pct: 0, occupancy: 0, adr: 0, revpar: 0 };
    const rows = groupCells.map((c) => c.data).filter(Boolean);
    const s = occupancyStats(rows, properties);
    return {
      days: groupCells.length,
      revenue: s.revenue,
      pct: kpis.revenue > 0 ? s.revenue / kpis.revenue : 0,
      occupancy: s.occupancy,
      adr: s.adr,
      revpar: s.revpar,
    };
  };

  const selectedData = selectedDay ? byDate.get(selectedDay) : null;  const selectedSources = selectedDay ? (srcByDate.get(selectedDay) || []) : [];
  const prevDayData = selectedDay ? byDate.get(
    new Date(new Date(selectedDay).getTime() - 86400000).toISOString().slice(0, 10)
  ) : null;

  const channelRanking = useMemo(() => {
    if (!selectedSources.length) return [];
    const ranked = selectedSources
      .map((s) => {
        // net_revenue IS the gross booked room revenue; commission is a cost and
        // net kept = gross − commission. Integer-cents math via the shared helper
        // so this ranking agrees to the cent with the OTA channel engine.
        const info = commissionFor(s.source || s.code);
        const stays = s.stays || 0;
        const netCents = toCents(s.net_revenue);
        const { grossCents, commissionCents } = grossUpFromNetCents(netCents, info, stays);
        return {
          name: s.source || s.code || "Unknown",
          gross: fromCents(grossCents),
          commission: fromCents(commissionCents),
          net: fromCents(grossCents - commissionCents),
          stays,
        };
      })
      .sort((a, b) => b.net - a.net);
    const total = ranked.reduce((a, r) => a + r.net, 0);
    return ranked.map((r, i) => ({ ...r, rank: i + 1, pct: total > 0 ? r.net / total : 0 }));
  }, [selectedSources]);

  return (
    <div className="space-y-6">
      <header>
        <p className="text-[11px] uppercase tracking-[0.3em] text-[#00D4FF] drop-shadow-[0_1px_2px_rgba(0,212,255,0.35)]">Owner Intelligence</p>
        <h1 className="mt-2 font-heading text-3xl font-semibold text-white drop-shadow-[0_2px_6px_rgba(0,0,0,0.75)]">Monthly Calendar View</h1>
        <p className="mt-1 text-sm text-slate-400 drop-shadow-[0_1px_1px_rgba(0,0,0,0.55)]">
          Visualize daily performance patterns, channel dominance, and yield rhythms for {periodLabel}.
        </p>
      </header>

      {/* Without this, a failed read painted every night "No Data", showed $0.00 KPIs,
          and the amber notice below told the operator to go and import reports they
          had already imported. */}
      {(occQ.isError || sourcesQ.isError) && (
        <ErrorState
          title="Could not load the month"
          description="The KPIs and calendar below would show $0.00 and mark every night 'No Data' — not because nothing was imported, but because this read failed. Re-importing will not fix it."
          error={occQ.error || sourcesQ.error}
          onRetry={() => { occQ.refetch(); sourcesQ.refetch(); }}
        />
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {/* Labelled "Room Revenue" because that is what it is: occupancyStats()
            sums room_revenue only. It used to read "Total Monthly Revenue", which
            invited a comparison with the Dashboard's $1,020,598.17 ledger total —
            a figure that is larger by exactly the ancillary lines (see
            RevenueReconciliation.js:46-59). */}
        <KpiCard label="Total Room Revenue" value={money(kpis.revenue)} sub={`${kpis.days} days with data`} accent={C.purple} icon={DollarSign} />
        <KpiCard label="Average Occupancy" value={pct(kpis.occupancy)} accent={C.cyan} icon={Percent} />
        <KpiCard label="Average ADR" value={money2(kpis.adr)} accent={C.amber} icon={Gauge} />
        <KpiCard label="Average RevPAR" value={money2(kpis.revpar)} accent={C.green} icon={Gauge} />
        <KpiCard label="Highest Day" value={money(kpis.highest)} sub="Peak room revenue" accent="#4ade80" icon={TrendingUp} />
        <KpiCard label="Lowest Day" value={money(kpis.lowest)} sub="Lowest room revenue" accent="#ff6b6b" icon={TrendingDown} />
      </div>

      {grids.map((grid) => (
        <Card
          key={`${grid.year}-${grid.month}`}
          title={`${MONTHS_LONG[grid.month]} ${grid.year} Calendar`}
          subtitle={`Green ≥ ${money(revThresholds.highRevenueThreshold)} · Gray ${money(revThresholds.mediumRevenueThreshold)}–${money(revThresholds.highRevenueThreshold)} · Red < ${money(revThresholds.mediumRevenueThreshold)} (editable in Settings)`}
        >
          <div className="mb-3 flex flex-wrap items-center gap-3 rounded-xl border border-white/[0.04] bg-gradient-to-b from-white/[0.04] to-transparent px-3 py-2 text-[10px] text-slate-400 ring-1 ring-inset ring-white/[0.03] shadow-[0_2px_8px_-4px_rgba(0,0,0,0.6),inset_0_1px_0_rgba(255,255,255,0.05)] transition-all duration-300 ease-out hover:border-white/[0.08] hover:shadow-[0_6px_18px_-8px_rgba(0,0,0,0.7),inset_0_1px_0_rgba(255,255,255,0.08)]">
            <span className="uppercase tracking-wider text-slate-500 drop-shadow-[0_1px_0_rgba(0,0,0,0.6)]">Event demand:</span>
            {Object.entries(DEMAND_COLORS).map(([label, color]) => (
              <span key={label} className="flex items-center gap-1 rounded-full border border-white/5 bg-white/[0.03] px-2 py-0.5 ring-1 ring-inset ring-white/[0.03] shadow-[0_1px_2px_rgba(0,0,0,0.4),inset_0_1px_0_rgba(255,255,255,0.05)] transition-all duration-200 hover:border-white/10 hover:bg-white/[0.06]">
                <span className="h-2 w-2 rounded-full ring-1 ring-inset ring-white/20" style={{ backgroundColor: color, boxShadow: `0 0 8px -1px ${color}aa` }} />
                {label}
              </span>
            ))}
            <span className="mx-1 hidden h-3 w-px bg-gradient-to-b from-white/[0.03] via-white/15 to-white/[0.03] shadow-[1px_0_0_rgba(0,0,0,0.55)] sm:block" />
            <span className="uppercase tracking-wider text-slate-500 drop-shadow-[0_1px_0_rgba(0,0,0,0.6)]">Event distance:</span>
            <span className="flex items-center gap-1 rounded-full border border-white/5 bg-white/[0.03] px-2 py-0.5 ring-1 ring-inset ring-white/[0.03] shadow-[0_1px_2px_rgba(0,0,0,0.4),inset_0_1px_0_rgba(255,255,255,0.05)] transition-all duration-200 hover:border-white/10 hover:bg-white/[0.06]">
              <span className="h-2 w-2 rounded-full ring-1 ring-inset ring-white/20" style={{ backgroundColor: distanceColor(0), boxShadow: `0 0 8px -1px ${distanceColor(0)}aa` }} />
              close
            </span>
            <span className="flex items-center gap-1 rounded-full border border-white/5 bg-white/[0.03] px-2 py-0.5 ring-1 ring-inset ring-white/[0.03] shadow-[0_1px_2px_rgba(0,0,0,0.4),inset_0_1px_0_rgba(255,255,255,0.05)] transition-all duration-200 hover:border-white/10 hover:bg-white/[0.06]">
              <span className="h-2 w-2 rounded-full ring-1 ring-inset ring-white/20" style={{ backgroundColor: distanceColor(20), boxShadow: `0 0 8px -1px ${distanceColor(20)}aa` }} />
              20 mi
            </span>
            <span className="flex items-center gap-1 rounded-full border border-white/5 bg-white/[0.03] px-2 py-0.5 ring-1 ring-inset ring-white/[0.03] shadow-[0_1px_2px_rgba(0,0,0,0.4),inset_0_1px_0_rgba(255,255,255,0.05)] transition-all duration-200 hover:border-white/10 hover:bg-white/[0.06]">
              <span className="h-2 w-2 rounded-full ring-1 ring-inset ring-white/20" style={{ backgroundColor: distanceColor(40), boxShadow: `0 0 8px -1px ${distanceColor(40)}aa` }} />
              40+ mi
            </span>
          </div>
          <div className="grid grid-cols-7 gap-1 sm:gap-2 lg:gap-2.5">
            {DOW.map((d) => (
              <div key={d} className="rounded-md border-b border-white/[0.05] bg-gradient-to-b from-white/[0.04] to-transparent pb-1.5 pt-1 text-center text-[10px] font-medium uppercase tracking-[0.12em] text-slate-500 shadow-[0_1px_0_rgba(0,0,0,0.5)] drop-shadow-[0_1px_0_rgba(0,0,0,0.6)] sm:pb-2 sm:text-xs sm:tracking-[0.18em] lg:pb-2.5 lg:tracking-[0.22em]">{d}</div>
            ))}
            {grid.cells.map((cell, i) => {
              if (!cell) return <div key={i} className="min-h-[76px] rounded-md border border-white/[0.02] bg-[#0A1628]/20 shadow-[inset_0_1px_2px_rgba(0,0,0,0.35)] sm:min-h-[110px] sm:rounded-lg lg:min-h-[128px] lg:rounded-xl" />;
              const revenue = cell.data?.room_revenue || 0;
              const color = cell.data ? getRevenueColor(revenue) : "transparent";
              const occPct = cell.data?.occupancy ? (cell.data.occupancy > 1 ? cell.data.occupancy : cell.data.occupancy * 100) : 0;
              const cellEvents = eventsByDate.get(cell.date) || [];
              const cellDemand = peakDemand(cellEvents);
              const eventColor = DEMAND_COLORS[cellEvents.find((e) => DEMAND_ORDER[e.demand] === cellDemand)?.demand] || null;
              const closestDist = cellEvents.length > 0 ? Math.min(...cellEvents.map((e) => e.distance)) : 0;
              const distColor = distanceColor(closestDist);
              return (
                <button
                  key={i}
                  onClick={() => setSelectedDay(cell.date)}
                  className={`group relative min-h-[76px] rounded-md border p-1.5 text-left ring-1 ring-inset ring-white/[0.04] transition-[transform,box-shadow,border-color,filter] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-transform [transform:translateZ(0)] hover:-translate-y-[2px] hover:border-white/20 hover:ring-white/[0.10] hover:brightness-[1.06] hover:shadow-[0_12px_28px_-12px_rgba(0,0,0,0.8),0_4px_10px_-5px_rgba(0,0,0,0.6),0_0_0_1px_rgba(255,255,255,0.05),inset_0_1px_0_rgba(255,255,255,0.14),inset_0_-1px_0_rgba(0,0,0,0.45)] focus-visible:outline-none focus-visible:z-10 focus-visible:-translate-y-px focus-visible:ring-2 focus-visible:ring-[#00D4FF]/70 focus-visible:ring-offset-1 focus-visible:ring-offset-[#0A1628] focus-visible:shadow-[0_14px_34px_-14px_rgba(0,212,255,0.42),0_0_0_1px_rgba(0,212,255,0.30),inset_0_1px_0_rgba(255,255,255,0.14)] active:translate-y-0 active:scale-[0.985] active:brightness-95 active:duration-100 active:shadow-[inset_0_3px_8px_rgba(0,0,0,0.62),inset_0_-1px_0_rgba(255,255,255,0.04),0_1px_1px_rgba(0,0,0,0.4)] disabled:pointer-events-none disabled:translate-y-0 disabled:opacity-45 disabled:saturate-50 disabled:shadow-[inset_0_1px_2px_rgba(0,0,0,0.4)] sm:min-h-[110px] sm:rounded-lg sm:p-2 sm:hover:-translate-y-[3px] sm:hover:shadow-[0_18px_40px_-14px_rgba(0,0,0,0.82),0_6px_14px_-6px_rgba(0,0,0,0.65),0_0_0_1px_rgba(255,255,255,0.05),inset_0_1px_0_rgba(255,255,255,0.14),inset_0_-1px_0_rgba(0,0,0,0.45)] sm:focus-visible:ring-offset-2 lg:min-h-[128px] lg:rounded-xl lg:p-2.5 lg:hover:-translate-y-1 lg:hover:shadow-[0_24px_52px_-16px_rgba(0,0,0,0.85),0_8px_18px_-8px_rgba(0,0,0,0.68),0_0_0_1px_rgba(255,255,255,0.06),inset_0_1px_0_rgba(255,255,255,0.16),inset_0_-1px_0_rgba(0,0,0,0.48)] ${
                    selectedDay === cell.date
                      ? "z-10 -translate-y-0.5 border-[#00D4FF] ring-1 ring-[#00D4FF] shadow-[0_16px_38px_-12px_rgba(0,212,255,0.52),0_2px_8px_-2px_rgba(0,0,0,0.6),0_0_0_1px_rgba(0,212,255,0.32),inset_0_1px_0_rgba(255,255,255,0.18),inset_0_-1px_0_rgba(0,0,0,0.45)] hover:-translate-y-1 hover:border-[#00D4FF] hover:ring-[#00D4FF] hover:shadow-[0_22px_46px_-14px_rgba(0,212,255,0.60),0_0_0_1px_rgba(0,212,255,0.38),inset_0_1px_0_rgba(255,255,255,0.20)]"
                      : "border-white/5 shadow-[0_1px_2px_rgba(0,0,0,0.45),inset_0_1px_0_rgba(255,255,255,0.05)]"
                  } ${!cell.data ? "bg-[#0A1628]/40 shadow-[inset_0_1px_3px_rgba(0,0,0,0.45)] hover:bg-[#0A1628]/55 hover:shadow-[inset_0_1px_4px_rgba(0,0,0,0.5),0_10px_24px_-14px_rgba(0,0,0,0.7)]" : "bg-gradient-to-b from-white/[0.06] to-transparent hover:from-white/[0.10]"}`}
                  style={cell.data ? { backgroundColor: `${color}15`, borderLeft: `3px solid ${color}`, boxShadow: `inset 3px 0 8px -4px ${color}66` } : {}}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-white drop-shadow-[0_1px_1px_rgba(0,0,0,0.7)]">{cell.day}</span>
                    {cell.data && <span className="rounded-full border border-white/10 bg-black/30 px-1 py-px text-[9px] tabular-nums text-slate-300 ring-1 ring-inset ring-white/[0.05] shadow-[0_1px_2px_rgba(0,0,0,0.5),inset_0_1px_0_rgba(255,255,255,0.08)] transition-all duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:-translate-y-px group-hover:border-white/25 group-hover:bg-black/40 group-hover:text-white group-hover:ring-white/[0.10] group-hover:shadow-[0_4px_10px_-3px_rgba(0,0,0,0.7),inset_0_1px_0_rgba(255,255,255,0.16)] group-focus-visible:border-[#00D4FF]/50 group-focus-visible:text-white group-active:translate-y-0 group-active:shadow-[inset_0_1px_3px_rgba(0,0,0,0.6)] sm:px-1.5 sm:text-[10px] lg:px-2 lg:py-0.5">{occPct.toFixed(0)}%</span>}
                  </div>
                  {/* One badge for every day that has events. It used to be two
                      variants: a tappable <button> when the night had imported
                      revenue, and an inert <div> when it did not — so the Event
                      Details popup was unreachable on exactly the days where the
                      events were the only information the cell had to offer. */}
                  {cellEvents.length > 0 && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setEventPopupDay(cell.date); }}
                      className="mt-0.5 flex w-full items-center gap-0.5 rounded-[5px] bg-gradient-to-b from-white/[0.07] to-transparent px-1 py-0.5 text-left text-[8px] font-semibold uppercase tracking-tight ring-1 ring-inset ring-white/[0.06] shadow-[0_1px_3px_rgba(0,0,0,0.5),inset_0_1px_0_rgba(255,255,255,0.08)] transition-[transform,box-shadow,filter] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-transform [transform:translateZ(0)] hover:-translate-y-px hover:scale-[1.015] hover:brightness-125 hover:ring-white/20 hover:shadow-[0_8px_18px_-5px_rgba(0,0,0,0.75),0_2px_5px_-2px_rgba(0,0,0,0.55),inset_0_1px_0_rgba(255,255,255,0.16)] focus-visible:outline-none focus-visible:z-10 focus-visible:-translate-y-px focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:ring-offset-1 focus-visible:ring-offset-black/40 focus-visible:brightness-110 active:translate-y-0 active:scale-[0.98] active:brightness-95 active:duration-100 active:shadow-[inset_0_2px_6px_rgba(0,0,0,0.6)] disabled:pointer-events-none disabled:opacity-45 disabled:saturate-50 disabled:shadow-none sm:mt-1 sm:gap-1 sm:rounded-md sm:text-[9px] sm:tracking-wide lg:px-1.5 lg:py-1"
                      style={{ backgroundColor: `${eventColor}22`, color: distColor, borderLeft: `2px solid ${eventColor}`, boxShadow: `inset 2px 0 6px -3px ${eventColor}88, 0 1px 3px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.08)` }}
                      title={cellEvents.map((e) => `${e.name} — ${e.demand}`).join(" / ")}
                    >
                      <span className="h-1.5 w-1.5 rounded-full ring-1 ring-inset ring-white/25" style={{ backgroundColor: distColor, boxShadow: `0 0 6px -1px ${distColor}cc` }} />
                      📅 {cellEvents.length} event{cellEvents.length > 1 ? "s" : ""} — tap for details
                    </button>
                  )}
                  {cell.data ? (
                    <div className="mt-0.5 space-y-0 text-[9px] text-slate-300 sm:mt-1 sm:space-y-0.5 sm:text-[10px] lg:mt-1.5">
                      <div className="font-heading text-xs font-semibold tabular-nums text-white drop-shadow-[0_2px_3px_rgba(0,0,0,0.75)] transition-all duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:-translate-y-px group-hover:drop-shadow-[0_4px_8px_rgba(0,0,0,0.9)] group-active:translate-y-0 group-active:drop-shadow-[0_1px_2px_rgba(0,0,0,0.7)] sm:text-sm lg:text-base">{money(revenue)}</div>
                      <div className="tabular-nums transition-colors duration-300 group-hover:text-slate-100 group-focus-visible:text-slate-100 drop-shadow-[0_1px_1px_rgba(0,0,0,0.6)]">ADR {money2(cell.data.adr || 0)}</div>
                      <div className="tabular-nums transition-colors duration-300 group-hover:text-slate-100 group-focus-visible:text-slate-100 drop-shadow-[0_1px_1px_rgba(0,0,0,0.6)]">RevPAR {money2(cell.data.revpar || 0)}</div>
                    </div>
                  ) : (
                    <div className="mt-1.5 text-[9px] text-slate-600 drop-shadow-[0_1px_0_rgba(0,0,0,0.5)] transition-colors duration-300 group-hover:text-slate-500 sm:mt-2 sm:text-[10px]">No Data</div>
                  )}
                </button>
              );
            })}
          </div>
        </Card>
      ))}

      {/* Truncation is stated, not hidden. The KPIs and the period label above cover
          the whole selection, so a silently capped grid list would put the page back
          into exactly the state this page was fixed out of: describing one span while
          measuring another. */}
      {hiddenGrids > 0 && (
        <div className="rounded-xl border border-[#FFB547]/20 bg-gradient-to-b from-[#FFB547]/[0.10] to-[#FFB547]/[0.04] p-4 ring-1 ring-inset ring-[#FFB547]/[0.08] shadow-[0_8px_22px_-12px_rgba(255,181,71,0.35),0_1px_2px_rgba(0,0,0,0.5),inset_0_1px_0_rgba(255,255,255,0.08)] transition-all duration-300 ease-out hover:-translate-y-px hover:border-[#FFB547]/30 hover:shadow-[0_14px_30px_-14px_rgba(255,181,71,0.45),inset_0_1px_0_rgba(255,255,255,0.12)]">
          <p className="text-sm text-[#FFB547] drop-shadow-[0_1px_2px_rgba(0,0,0,0.55)]">
            ⚠ Only the first {MAX_GRIDS} months of {periodLabel} are drawn above. The KPIs cover the full
            range, including {hiddenGrids} further month{hiddenGrids > 1 ? "s" : ""}. Narrow the date range to see them.
          </p>
        </div>
      )}

      {/* Performance Groups */}
      <div className="grid gap-4 lg:grid-cols-3">
        {["high", "medium", "low"].map((g) => {
          const stats = groupStats(groups[g]);
          const color = g === "high" ? "#4ade80" : g === "medium" ? "#94a3b8" : "#ff6b6b";
          return (
            <Card key={g} title={getRevenueGroupLabel(g)} subtitle={`${stats.days} days · ${pct(stats.pct)} of revenue`}>
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <div
                    className="h-3 w-3 rounded-full ring-1 ring-inset ring-white/20 shadow-[0_1px_3px_rgba(0,0,0,0.6)]"
                    style={{ backgroundColor: color, boxShadow: `0 0 10px -2px ${color}99, inset 0 1px 0 rgba(255,255,255,0.25)` }}
                  />
                  <span className="text-2xl font-heading font-semibold tabular-nums text-white drop-shadow-[0_2px_4px_rgba(0,0,0,0.7)]">{money(stats.revenue)}</span>
                </div>
                <div className="grid grid-cols-3 gap-2 text-xs">
                  <div className="rounded-lg border border-white/5 bg-gradient-to-b from-white/[0.05] to-transparent px-2 py-1.5 ring-1 ring-inset ring-white/[0.04] shadow-[0_1px_2px_rgba(0,0,0,0.45),inset_0_1px_0_rgba(255,255,255,0.06)] transition-all duration-300 ease-out hover:-translate-y-px hover:border-white/10 hover:shadow-[0_6px_16px_-8px_rgba(0,0,0,0.7),inset_0_1px_0_rgba(255,255,255,0.10)]">
                    <p className="text-slate-500">Occ</p>
                    <p className="tabular-nums text-slate-200 drop-shadow-[0_1px_1px_rgba(0,0,0,0.6)]">{pct(stats.occupancy)}</p>
                  </div>
                  <div className="rounded-lg border border-white/5 bg-gradient-to-b from-white/[0.05] to-transparent px-2 py-1.5 ring-1 ring-inset ring-white/[0.04] shadow-[0_1px_2px_rgba(0,0,0,0.45),inset_0_1px_0_rgba(255,255,255,0.06)] transition-all duration-300 ease-out hover:-translate-y-px hover:border-white/10 hover:shadow-[0_6px_16px_-8px_rgba(0,0,0,0.7),inset_0_1px_0_rgba(255,255,255,0.10)]">
                    <p className="text-slate-500">ADR</p>
                    <p className="tabular-nums text-slate-200 drop-shadow-[0_1px_1px_rgba(0,0,0,0.6)]">{money2(stats.adr)}</p>
                  </div>
                  <div className="rounded-lg border border-white/5 bg-gradient-to-b from-white/[0.05] to-transparent px-2 py-1.5 ring-1 ring-inset ring-white/[0.04] shadow-[0_1px_2px_rgba(0,0,0,0.45),inset_0_1px_0_rgba(255,255,255,0.06)] transition-all duration-300 ease-out hover:-translate-y-px hover:border-white/10 hover:shadow-[0_6px_16px_-8px_rgba(0,0,0,0.7),inset_0_1px_0_rgba(255,255,255,0.10)]">
                    <p className="text-slate-500">RevPAR</p>
                    <p className="tabular-nums text-slate-200 drop-shadow-[0_1px_1px_rgba(0,0,0,0.6)]">{money2(stats.revpar)}</p>
                  </div>
                </div>
              </div>
            </Card>
          );
        })}
      </div>

      {groups.nodata.length > 0 && (
        <div className="rounded-xl border border-[#FFB547]/20 bg-gradient-to-b from-[#FFB547]/[0.10] to-[#FFB547]/[0.04] p-4 ring-1 ring-inset ring-[#FFB547]/[0.08] shadow-[0_8px_22px_-12px_rgba(255,181,71,0.35),0_1px_2px_rgba(0,0,0,0.5),inset_0_1px_0_rgba(255,255,255,0.08)] transition-all duration-300 ease-out hover:-translate-y-px hover:border-[#FFB547]/30 hover:shadow-[0_14px_30px_-14px_rgba(255,181,71,0.45),inset_0_1px_0_rgba(255,255,255,0.12)]">
          <p className="text-sm text-[#FFB547] drop-shadow-[0_1px_2px_rgba(0,0,0,0.55)]">
            ⚠ {groups.nodata.length} days have no imported data for {periodLabel}. Import reports to see full performance.
          </p>
        </div>
      )}

      {/* Daily Detail Panel */}
      <DialogPrimitive.Root open={!!selectedDay} onOpenChange={(open) => !open && setSelectedDay(null)}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-gradient-to-b from-black/55 via-black/65 to-black/75 backdrop-blur-[3px] transition-opacity duration-300 ease-out data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
          <DialogPrimitive.Content 
            className="fixed inset-0 z-50 flex items-end justify-end sm:items-center sm:justify-center outline-none pointer-events-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
            aria-describedby={undefined}
          >
            <div
              className="relative w-full max-w-lg rounded-t-3xl border border-white/[0.14] bg-gradient-to-b from-[#162C4B] via-[#132743] to-[#0E1D31] p-6 sm:rounded-2xl pointer-events-auto ring-1 ring-inset ring-white/[0.08] shadow-[0_-32px_80px_-28px_rgba(0,0,0,0.92),0_32px_80px_-28px_rgba(0,0,0,0.92),0_2px_8px_-2px_rgba(0,0,0,0.7),0_0_0_1px_rgba(0,212,255,0.06),inset_0_1px_0_rgba(255,255,255,0.14),inset_0_-1px_0_rgba(0,0,0,0.5)] transition-all duration-300 ease-out"
              onClick={(e) => e.stopPropagation()}
              style={{ maxHeight: "85vh", overflowY: "auto" }}
            >
              <div className="mb-4 flex items-center justify-between border-b border-white/[0.06] pb-3 shadow-[0_1px_0_rgba(255,255,255,0.04)]">
                <DialogPrimitive.Title className="font-heading text-xl font-semibold text-white drop-shadow-[0_2px_6px_rgba(0,0,0,0.85)]">
                  {formatDayLabel(selectedDay)}
                </DialogPrimitive.Title>
                <DialogPrimitive.Close className="rounded-full border border-white/[0.06] bg-white/[0.03] p-1.5 text-slate-400 ring-1 ring-inset ring-white/[0.04] shadow-[0_1px_3px_rgba(0,0,0,0.5),inset_0_1px_0_rgba(255,255,255,0.07)] transition-[transform,box-shadow,border-color,background-color,color] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] hover:-translate-y-px hover:border-white/20 hover:bg-white/[0.08] hover:text-white hover:ring-white/[0.10] hover:shadow-[0_8px_18px_-6px_rgba(0,0,0,0.75),0_1px_2px_rgba(0,0,0,0.5),inset_0_1px_0_rgba(255,255,255,0.16)] focus-visible:outline-none focus-visible:-translate-y-px focus-visible:text-white focus-visible:ring-2 focus-visible:ring-[#00D4FF]/70 focus-visible:ring-offset-2 focus-visible:ring-offset-[#132743] focus-visible:shadow-[0_8px_20px_-8px_rgba(0,212,255,0.45),inset_0_1px_0_rgba(255,255,255,0.14)] active:translate-y-0 active:scale-95 active:duration-100 active:shadow-[inset_0_2px_6px_rgba(0,0,0,0.6)] disabled:pointer-events-none disabled:opacity-40 disabled:shadow-none" aria-label="Close">
                  <X className="h-5 w-5" />
                </DialogPrimitive.Close>
              </div>

              {/* Events render FIRST, and independently of imported revenue.
                  This block used to sit inside the selectedData branch below, so
                  a night with known demand drivers but no OccupancyDay row showed
                  only "No data imported for this day." — the cell had just badged
                  "1 EVENT" and the dialog then denied it existed. On a day with
                  no numbers yet, the events ARE the intelligence. */}
              {selectedEvents.length > 0 && (
                <div className="mb-4">
                  <p className="mb-2 text-xs uppercase tracking-widest text-slate-500 drop-shadow-[0_1px_1px_rgba(0,0,0,0.6)]">Events Driving Demand</p>
                  <div className="space-y-2">
                    {selectedEvents.map((e, i) => {
                      const col = DEMAND_COLORS[e.demand] || "#94a3b8";
                      const distCol = distanceColor(e.distance);
                      return (
                        <div key={`${e.name}-${i}`} tabIndex={0} className="group/event rounded-xl border border-white/[0.06] bg-gradient-to-b from-[#12253C] via-[#0F2135] to-[#0A1628] p-3 ring-1 ring-inset ring-white/[0.05] shadow-[0_10px_24px_-14px_rgba(0,0,0,0.85),0_1px_2px_rgba(0,0,0,0.55),inset_0_1px_0_rgba(255,255,255,0.08),inset_0_-1px_0_rgba(0,0,0,0.4)] transition-[transform,box-shadow,border-color] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-transform [transform:translateZ(0)] hover:-translate-y-0.5 hover:border-white/[0.14] hover:ring-white/[0.09] hover:shadow-[0_20px_42px_-16px_rgba(0,0,0,0.92),0_3px_8px_-2px_rgba(0,0,0,0.62),inset_0_1px_0_rgba(255,255,255,0.15)] focus-visible:outline-none focus-visible:-translate-y-0.5 focus-visible:ring-2 focus-visible:ring-[#00D4FF]/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[#132743] focus-visible:shadow-[0_16px_36px_-16px_rgba(0,212,255,0.40),inset_0_1px_0_rgba(255,255,255,0.14)] active:translate-y-0 active:duration-100 active:shadow-[inset_0_2px_7px_rgba(0,0,0,0.6)]">
                          <div className="flex items-center justify-between gap-2">
                            <p className="text-sm font-semibold drop-shadow-[0_1px_2px_rgba(0,0,0,0.6)]" style={{ color: distCol }}>{e.name}</p>
                            <span className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ring-1 ring-inset ring-white/[0.12] shadow-[0_2px_5px_-1px_rgba(0,0,0,0.6),inset_0_1px_0_rgba(255,255,255,0.14)] transition-[transform,box-shadow,filter] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover/event:-translate-y-px group-hover/event:brightness-110 group-hover/event:ring-white/[0.20] group-hover/event:shadow-[0_5px_12px_-2px_rgba(0,0,0,0.7),inset_0_1px_0_rgba(255,255,255,0.20)] group-focus-visible/event:ring-white/[0.20]" style={{ backgroundColor: `${col}22`, color: col }}>
                              {e.demand}
                            </span>
                          </div>
                          <p className="mt-1 text-xs text-slate-400 drop-shadow-[0_1px_1px_rgba(0,0,0,0.55)]">
                            {e.venue}{e.address && e.address !== "Regional" ? ` — ${e.address}` : ""}
                          </p>
                          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-slate-500 drop-shadow-[0_1px_1px_rgba(0,0,0,0.5)]">
                            {e.time && <span>🕐 {e.time}</span>}
                            {e.distance > 0 && <span style={{ color: distCol }}>📍 {e.distance} mi away</span>}
                            {e.priceRange && <span>🎟 {e.priceRange}</span>}
                            {e.holiday && e.holiday !== "Holiday Season" && <span>🗓 {e.holiday}</span>}
                          </div>
                          {e.audience && <p className="mt-1 text-[11px] text-slate-500">👥 {e.audience}</p>}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {selectedData ? (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  {/* room_revenue, the same number the cell that opened this dialog
                      printed. It used to read `total_revenue` — a field the CSV
                      importer never writes — so tapping a cell showing $12,000
                      opened a panel reading $0.00 with an N/A change. */}
                  <Metric label="Room Revenue" current={selectedData.room_revenue || 0} previous={prevDayData?.room_revenue || 0} fmt={money} />
                  <Metric label="Occupancy" current={selectedData.occupancy > 1 ? selectedData.occupancy / 100 : selectedData.occupancy || 0} previous={prevDayData?.occupancy > 1 ? prevDayData.occupancy / 100 : prevDayData?.occupancy || 0} fmt={pct} suffix=" pts" />
                  <Metric label="ADR" current={selectedData.adr || 0} previous={prevDayData?.adr || 0} fmt={money2} />
                  <Metric label="RevPAR" current={selectedData.revpar || 0} previous={prevDayData?.revpar || 0} fmt={money2} />
                </div>

                <div className="rounded-xl border border-white/[0.06] bg-gradient-to-b from-[#12253C] via-[#0F2135] to-[#0A1628] p-4 ring-1 ring-inset ring-white/[0.05] shadow-[0_10px_24px_-14px_rgba(0,0,0,0.85),0_1px_2px_rgba(0,0,0,0.55),inset_0_1px_0_rgba(255,255,255,0.08),inset_0_-1px_0_rgba(0,0,0,0.4)] transition-all duration-300 ease-out will-change-transform [transform:translateZ(0)] hover:-translate-y-0.5 hover:border-white/[0.12] hover:ring-white/[0.08] hover:shadow-[0_18px_38px_-16px_rgba(0,0,0,0.9),0_2px_6px_-2px_rgba(0,0,0,0.6),inset_0_1px_0_rgba(255,255,255,0.13)]">
                  <p className="text-xs text-slate-500 drop-shadow-[0_1px_1px_rgba(0,0,0,0.5)]">Rooms Sold</p>
                  <p className="text-lg tabular-nums text-white drop-shadow-[0_2px_4px_rgba(0,0,0,0.75)]">{num(selectedData.rooms_sold || 0)} / {num(selectedData.total_rooms || 0)}</p>
                </div>

                {channelRanking.length > 0 && (
                  <div>
                    <p className="mb-2 text-xs uppercase tracking-widest text-slate-500 drop-shadow-[0_1px_1px_rgba(0,0,0,0.6)]">Channel Ecosystem · Ranked by Net Revenue</p>
                    <div className="space-y-1.5">
                      {channelRanking.slice(0, 10).map((ch) => (
                        <div key={ch.rank} className="group/row flex items-center justify-between rounded-lg border border-white/[0.06] bg-gradient-to-b from-white/[0.06] via-white/[0.02] to-[#0A1628] px-3 py-2 text-sm ring-1 ring-inset ring-white/[0.04] shadow-[0_3px_8px_-3px_rgba(0,0,0,0.65),0_1px_2px_rgba(0,0,0,0.45),inset_0_1px_0_rgba(255,255,255,0.07),inset_0_-1px_0_rgba(0,0,0,0.35)] transition-[transform,box-shadow,border-color] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-transform [transform:translateZ(0)] hover:-translate-y-px hover:border-white/[0.14] hover:ring-white/[0.09] hover:shadow-[0_12px_26px_-8px_rgba(0,0,0,0.82),0_2px_5px_-2px_rgba(0,0,0,0.55),inset_0_1px_0_rgba(255,255,255,0.13)] focus-within:border-[#00D4FF]/40 focus-within:ring-[#00D4FF]/30 focus-within:shadow-[0_10px_24px_-10px_rgba(0,212,255,0.35),inset_0_1px_0_rgba(255,255,255,0.12)] active:translate-y-0 active:duration-100 active:shadow-[inset_0_2px_5px_rgba(0,0,0,0.55)]">
                          <span className="flex items-center gap-2 text-slate-200 transition-colors duration-300 group-hover/row:text-white">
                            <span className="w-5 text-xs tabular-nums text-slate-500 drop-shadow-[0_1px_1px_rgba(0,0,0,0.55)] transition-colors duration-300 group-hover/row:text-slate-400">#{ch.rank}</span>
                            {ch.name}
                          </span>
                          <span className="tabular-nums text-slate-300 drop-shadow-[0_1px_1px_rgba(0,0,0,0.55)] transition-colors duration-300 group-hover/row:text-white">
                            {money(ch.gross)} · {pct(ch.pct)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              /* Missing revenue is still stated plainly — the events above are not
                 a substitute for the numbers. When events are present this is a
                 compact secondary note rather than the whole dialog body. */
              <div className={selectedEvents.length > 0 ? "rounded-xl border border-white/[0.06] bg-gradient-to-b from-[#0D1D30] via-[#0B1A2C] to-[#08121F] px-4 py-3 text-center ring-1 ring-inset ring-white/[0.04] shadow-[inset_0_2px_6px_rgba(0,0,0,0.6),inset_0_-1px_0_rgba(255,255,255,0.04),0_1px_2px_rgba(0,0,0,0.5)] transition-all duration-300 ease-out" : "py-8 text-center"}>
                <p className="text-sm text-slate-500 drop-shadow-[0_1px_1px_rgba(0,0,0,0.5)]">No revenue data imported for this day.</p>
                <Link to="/upload" className="mt-1 inline-block rounded-md px-1 text-sm text-[#00D4FF] underline decoration-[#00D4FF]/40 underline-offset-2 drop-shadow-[0_1px_3px_rgba(0,212,255,0.35)] transition-[transform,color,text-decoration-color,filter,box-shadow] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] hover:-translate-y-px hover:text-white hover:decoration-white/70 hover:drop-shadow-[0_3px_8px_rgba(0,212,255,0.55)] focus-visible:outline-none focus-visible:-translate-y-px focus-visible:text-white focus-visible:ring-2 focus-visible:ring-[#00D4FF]/70 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0B1A2C] focus-visible:shadow-[0_6px_16px_-8px_rgba(0,212,255,0.5)] active:translate-y-0 active:duration-100 active:brightness-90 aria-disabled:pointer-events-none aria-disabled:opacity-45">Import reports →</Link>
              </div>
            )}
            </div>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>

      {/* Event Details Popup — opened from the clickable "event" line on a day cell */}
      <DialogPrimitive.Root open={!!eventPopupDay} onOpenChange={(open) => !open && setEventPopupDay(null)}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-[60] bg-black/70 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
          <DialogPrimitive.Content
            className="fixed inset-0 z-[60] flex items-end justify-end sm:items-center sm:justify-center outline-none pointer-events-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
            aria-describedby={undefined}
          >
            <div
              className="relative w-full max-w-md rounded-t-3xl border border-white/10 bg-gradient-to-b from-[#132743] to-[#0F1F35] p-6 sm:rounded-2xl pointer-events-auto ring-1 ring-inset ring-white/[0.06] shadow-[0_-24px_60px_-24px_rgba(0,0,0,0.9),0_24px_60px_-24px_rgba(0,0,0,0.9),inset_0_1px_0_rgba(255,255,255,0.10)]"
              onClick={(e) => e.stopPropagation()}
              style={{ maxHeight: "85vh", overflowY: "auto" }}
            >
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <p className="text-[10px] uppercase tracking-[0.3em] text-[#FFB547] drop-shadow-[0_1px_3px_rgba(255,181,71,0.35)]">Event Details</p>
                  <DialogPrimitive.Title className="mt-1 font-heading text-xl font-semibold text-white drop-shadow-[0_2px_4px_rgba(0,0,0,0.7)]">
                    {formatDayLabel(eventPopupDay)}
                  </DialogPrimitive.Title>
                </div>
                <DialogPrimitive.Close className="rounded-full border border-white/[0.06] bg-white/[0.03] p-1.5 text-slate-400 ring-1 ring-inset ring-white/[0.04] shadow-[0_1px_3px_rgba(0,0,0,0.5),inset_0_1px_0_rgba(255,255,255,0.07)] transition-[transform,box-shadow,border-color,background-color,color] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] hover:-translate-y-px hover:border-white/20 hover:bg-white/[0.08] hover:text-white hover:ring-white/[0.10] hover:shadow-[0_8px_18px_-6px_rgba(0,0,0,0.75),0_1px_2px_rgba(0,0,0,0.5),inset_0_1px_0_rgba(255,255,255,0.16)] focus-visible:outline-none focus-visible:-translate-y-px focus-visible:text-white focus-visible:ring-2 focus-visible:ring-[#FFB547]/70 focus-visible:ring-offset-2 focus-visible:ring-offset-[#132743] focus-visible:shadow-[0_8px_20px_-8px_rgba(255,181,71,0.45),inset_0_1px_0_rgba(255,255,255,0.14)] active:translate-y-0 active:scale-95 active:duration-100 active:shadow-[inset_0_2px_6px_rgba(0,0,0,0.6)] disabled:pointer-events-none disabled:opacity-40 disabled:shadow-none" aria-label="Close">
                  <X className="h-5 w-5" />
                </DialogPrimitive.Close>
              </div>

              <div className="space-y-3">
                {eventPopupEvents.length === 0 && (
                  <p className="text-sm text-slate-500">No events scheduled for this day.</p>
                )}
                {eventPopupEvents.map((e, i) => {
                  const col = DEMAND_COLORS[e.demand] || "#94a3b8";
                  const distCol = distanceColor(e.distance);
                  return (
                    <div key={`${e.name}-${i}`} tabIndex={0} className="group/popup rounded-xl border border-white/5 bg-gradient-to-b from-[#0F2135] to-[#0A1628] p-4 ring-1 ring-inset ring-white/[0.04] shadow-[0_10px_26px_-14px_rgba(0,0,0,0.85),0_1px_2px_rgba(0,0,0,0.5),inset_0_1px_0_rgba(255,255,255,0.06)] transition-[transform,box-shadow,border-color] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-transform [transform:translateZ(0)] hover:-translate-y-0.5 hover:border-white/[0.12] hover:ring-white/[0.08] hover:shadow-[0_18px_38px_-16px_rgba(0,0,0,0.92),0_2px_6px_-2px_rgba(0,0,0,0.6),inset_0_1px_0_rgba(255,255,255,0.12)] focus-visible:outline-none focus-visible:-translate-y-0.5 focus-visible:ring-2 focus-visible:ring-[#FFB547]/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0F1F35] focus-visible:shadow-[0_16px_36px_-16px_rgba(255,181,71,0.38),inset_0_1px_0_rgba(255,255,255,0.12)] active:translate-y-0 active:duration-100 active:shadow-[inset_0_2px_7px_rgba(0,0,0,0.6)]">
                      <div className="flex items-start justify-between gap-2">
                        <p className="font-heading text-base font-semibold drop-shadow-[0_1px_2px_rgba(0,0,0,0.65)] transition-[filter] duration-300 group-hover/popup:drop-shadow-[0_2px_5px_rgba(0,0,0,0.8)]" style={{ color: distCol }}>{e.name}</p>
                        <span className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ring-1 ring-inset ring-white/10 shadow-[0_1px_3px_rgba(0,0,0,0.5),inset_0_1px_0_rgba(255,255,255,0.10)] transition-[transform,box-shadow,filter] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover/popup:-translate-y-px group-hover/popup:brightness-110 group-hover/popup:ring-white/20 group-hover/popup:shadow-[0_4px_10px_-2px_rgba(0,0,0,0.65),inset_0_1px_0_rgba(255,255,255,0.16)] group-focus-visible/popup:ring-white/20" style={{ backgroundColor: `${col}22`, color: col }}>
                          {e.demand} Demand
                        </span>
                      </div>
                      {e.type && <p className="mt-1 text-xs text-slate-400">{e.type}</p>}

                      <p className="mt-2 text-sm text-slate-300">{e.venue}</p>
                      {e.address && e.address !== "Regional" && (
                        <p className="text-xs text-slate-400">📍 {e.address}</p>
                      )}

                      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-400">
                        {e.time && <span>🕐 {e.time}</span>}
                        {e.distance > 0 && <span style={{ color: distCol }}>🚗 {e.distance} mi from motel</span>}
                        {e.priceRange && <span>🎟 {e.priceRange}</span>}
                        {e.holiday && e.holiday !== "Holiday Season" && <span>🗓 {e.holiday}</span>}
                        {e.recurring && <span>🔁 Recurring</span>}
                      </div>

                      {e.audience && (
                        <p className="mt-2 border-t border-white/5 pt-2 text-[11px] text-slate-500 shadow-[0_-1px_0_rgba(0,0,0,0.4)] transition-colors duration-300 group-hover/popup:border-white/10 group-hover/popup:text-slate-400">👥 {e.audience}</p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </div>
  );
}

function Metric({ label, current, previous, fmt, suffix = "" }) {
  const diff = current - previous;
  const pctCh = previous > 0 ? (diff / previous) * 100 : 0;
  return (
    <div tabIndex={0} className="group/metric rounded-xl border border-white/[0.06] bg-gradient-to-b from-[#12253C] via-[#0F2135] to-[#0A1628] p-3 ring-1 ring-inset ring-white/[0.05] shadow-[0_10px_24px_-14px_rgba(0,0,0,0.85),0_2px_4px_-1px_rgba(0,0,0,0.55),inset_0_1px_0_rgba(255,255,255,0.08),inset_0_-1px_0_rgba(0,0,0,0.4)] transition-[transform,box-shadow,border-color] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-transform [transform:translateZ(0)] hover:-translate-y-0.5 hover:border-white/[0.14] hover:ring-white/[0.09] hover:shadow-[0_22px_44px_-16px_rgba(0,0,0,0.92),0_3px_8px_-2px_rgba(0,0,0,0.65),inset_0_1px_0_rgba(255,255,255,0.16)] focus-visible:outline-none focus-visible:-translate-y-0.5 focus-visible:ring-2 focus-visible:ring-[#00D4FF]/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[#132743] focus-visible:shadow-[0_18px_38px_-16px_rgba(0,212,255,0.38),inset_0_1px_0_rgba(255,255,255,0.14)] active:translate-y-0 active:duration-100 active:shadow-[inset_0_3px_8px_rgba(0,0,0,0.6)]">
      <p className="text-[10px] uppercase tracking-widest text-slate-500 drop-shadow-[0_1px_1px_rgba(0,0,0,0.55)] transition-colors duration-300 group-hover/metric:text-slate-400">{label}</p>
      <p className="mt-1 text-lg font-heading font-semibold tabular-nums text-white drop-shadow-[0_2px_5px_rgba(0,0,0,0.8)] transition-[filter] duration-300 group-hover/metric:drop-shadow-[0_3px_8px_rgba(0,0,0,0.9)]">{fmt(current)}</p>
      <p className="text-xs tabular-nums text-slate-500 drop-shadow-[0_1px_1px_rgba(0,0,0,0.5)]">Previous: {fmt(previous)}</p>
      <p className={`text-xs tabular-nums drop-shadow-[0_1px_2px_rgba(0,0,0,0.6)] ${diff >= 0 ? "text-[#00E096]" : "text-[#FF6B6B]"}`}>
        {previous === 0 ? "N/A" : `${diff >= 0 ? "+" : ""}${fmt(diff)}${suffix} (${pctCh >= 0 ? "+" : ""}${pctCh.toFixed(1)}%)`}
      </p>
    </div>
  );
}