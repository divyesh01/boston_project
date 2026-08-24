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
import { money, money2, pct, num, inRange, C, occupancyStats, commissionFor, formatDayLabel } from "@/lib/hotel";
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
        // Actually subtract commission — the panel is titled "Ranked by Net
        // Revenue" but used to set commission: 0 and net = gross, so an OTA
        // booking outranked a direct booking of the same value.
        const gross = s.net_revenue || 0;
        const info = commissionFor(s.source || s.code);
        let commission = 0;
        if (info.type === "percentage") commission = gross * info.rate;
        else if (info.type === "fixed") commission = info.rate * (s.stays || 0);
        else if (info.type === "actual") commission = info.rate;
        return {
          name: s.source || s.code || "Unknown",
          gross,
          commission,
          net: gross - commission,
          stays: s.stays || 0,
        };
      })
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
          <div className="mb-3 flex flex-wrap items-center gap-3 text-[10px] text-slate-400">
            <span className="uppercase tracking-wider text-slate-500">Event demand:</span>
            {Object.entries(DEMAND_COLORS).map(([label, color]) => (
              <span key={label} className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
                {label}
              </span>
            ))}
            <span className="mx-1 hidden h-3 w-px bg-white/10 sm:block" />
            <span className="uppercase tracking-wider text-slate-500">Event distance:</span>
            <span className="flex items-center gap-1">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: distanceColor(0) }} />
              close
            </span>
            <span className="flex items-center gap-1">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: distanceColor(20) }} />
              20 mi
            </span>
            <span className="flex items-center gap-1">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: distanceColor(40) }} />
              40+ mi
            </span>
          </div>
          <div className="grid grid-cols-7 gap-1.5 sm:gap-2">
            {DOW.map((d) => (
              <div key={d} className="pb-2 text-center text-xs font-medium text-slate-500">{d}</div>
            ))}
            {grid.cells.map((cell, i) => {
              if (!cell) return <div key={i} className="min-h-[90px] sm:min-h-[120px]" />;
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
                  className={`min-h-[90px] rounded-lg border p-2 text-left transition-all sm:min-h-[120px] ${
                    selectedDay === cell.date ? "border-[#00D4FF] ring-1 ring-[#00D4FF]" : "border-white/5"
                  } ${!cell.data ? "bg-[#0A1628]/40" : ""}`}
                  style={cell.data ? { backgroundColor: `${color}15`, borderLeft: `3px solid ${color}` } : {}}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-white">{cell.day}</span>
                    {cell.data && <span className="text-[10px] text-slate-400">{occPct.toFixed(0)}%</span>}
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
                      className="mt-1 flex w-full items-center gap-1 rounded-md px-1 py-0.5 text-left text-[9px] font-semibold uppercase tracking-wide transition-all hover:brightness-125"
                      style={{ backgroundColor: `${eventColor}22`, color: distColor, borderLeft: `2px solid ${eventColor}` }}
                      title={cellEvents.map((e) => `${e.name} — ${e.demand}`).join(" / ")}
                    >
                      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: distColor }} />
                      📅 {cellEvents.length} event{cellEvents.length > 1 ? "s" : ""} — tap for details
                    </button>
                  )}
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
      ))}

      {/* Truncation is stated, not hidden. The KPIs and the period label above cover
          the whole selection, so a silently capped grid list would put the page back
          into exactly the state this page was fixed out of: describing one span while
          measuring another. */}
      {hiddenGrids > 0 && (
        <div className="rounded-xl border border-[#FFB547]/20 bg-[#FFB547]/[0.06] p-4">
          <p className="text-sm text-[#FFB547]">
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
            ⚠ {groups.nodata.length} days have no imported data for {periodLabel}. Import reports to see full performance.
          </p>
        </div>
      )}

      {/* Daily Detail Panel */}
      <DialogPrimitive.Root open={!!selectedDay} onOpenChange={(open) => !open && setSelectedDay(null)}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
          <DialogPrimitive.Content 
            className="fixed inset-0 z-50 flex items-end justify-end sm:items-center sm:justify-center outline-none pointer-events-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
            aria-describedby={undefined}
          >
            <div
              className="relative w-full max-w-lg rounded-t-3xl border border-white/10 bg-[#0F1F35] p-6 sm:rounded-2xl pointer-events-auto shadow-2xl"
              onClick={(e) => e.stopPropagation()}
              style={{ maxHeight: "85vh", overflowY: "auto" }}
            >
              <div className="mb-4 flex items-center justify-between">
                <DialogPrimitive.Title className="font-heading text-xl font-semibold text-white">
                  {formatDayLabel(selectedDay)}
                </DialogPrimitive.Title>
                <DialogPrimitive.Close className="text-slate-400 hover:text-white" aria-label="Close">
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
                  <p className="mb-2 text-xs uppercase tracking-widest text-slate-500">Events Driving Demand</p>
                  <div className="space-y-2">
                    {selectedEvents.map((e, i) => {
                      const col = DEMAND_COLORS[e.demand] || "#94a3b8";
                      const distCol = distanceColor(e.distance);
                      return (
                        <div key={`${e.name}-${i}`} className="rounded-xl border border-white/5 bg-[#0A1628] p-3">
                          <div className="flex items-center justify-between gap-2">
                            <p className="text-sm font-semibold" style={{ color: distCol }}>{e.name}</p>
                            <span className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider" style={{ backgroundColor: `${col}22`, color: col }}>
                              {e.demand}
                            </span>
                          </div>
                          <p className="mt-1 text-xs text-slate-400">
                            {e.venue}{e.address && e.address !== "Regional" ? ` — ${e.address}` : ""}
                          </p>
                          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-slate-500">
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
              /* Missing revenue is still stated plainly — the events above are not
                 a substitute for the numbers. When events are present this is a
                 compact secondary note rather than the whole dialog body. */
              <div className={selectedEvents.length > 0 ? "rounded-xl border border-white/5 bg-[#0A1628] px-4 py-3 text-center" : "py-8 text-center"}>
                <p className="text-sm text-slate-500">No revenue data imported for this day.</p>
                <Link to="/upload" className="mt-1 inline-block text-sm text-[#00D4FF] underline">Import reports →</Link>
              </div>
            )}
            </div>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>

      {/* Event Details Popup — opened from the clickable "event" line on a day cell */}
      <DialogPrimitive.Root open={!!eventPopupDay} onOpenChange={(open) => !open && setEventPopupDay(null)}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-[60] bg-black/70 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
          <DialogPrimitive.Content
            className="fixed inset-0 z-[60] flex items-end justify-end sm:items-center sm:justify-center outline-none pointer-events-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
            aria-describedby={undefined}
          >
            <div
              className="relative w-full max-w-md rounded-t-3xl border border-white/10 bg-[#0F1F35] p-6 sm:rounded-2xl pointer-events-auto shadow-2xl"
              onClick={(e) => e.stopPropagation()}
              style={{ maxHeight: "85vh", overflowY: "auto" }}
            >
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <p className="text-[10px] uppercase tracking-[0.3em] text-[#FFB547]">Event Details</p>
                  <DialogPrimitive.Title className="mt-1 font-heading text-xl font-semibold text-white">
                    {formatDayLabel(eventPopupDay)}
                  </DialogPrimitive.Title>
                </div>
                <DialogPrimitive.Close className="text-slate-400 hover:text-white" aria-label="Close">
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
                    <div key={`${e.name}-${i}`} className="rounded-xl border border-white/5 bg-[#0A1628] p-4">
                      <div className="flex items-start justify-between gap-2">
                        <p className="font-heading text-base font-semibold" style={{ color: distCol }}>{e.name}</p>
                        <span className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider" style={{ backgroundColor: `${col}22`, color: col }}>
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
                        <p className="mt-2 border-t border-white/5 pt-2 text-[11px] text-slate-500">👥 {e.audience}</p>
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