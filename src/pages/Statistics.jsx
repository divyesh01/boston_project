import React, { useMemo, useState } from "react";
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell,
} from "recharts";
import { BedDouble, DollarSign, Gauge, TrendingUp, Users2, Wallet, Info } from "lucide-react";
import Card from "@/components/ui-exec/Card";
import KpiCard from "@/components/ui-exec/KpiCard";
import { useGlobalFilters } from "@/lib/useGlobalFilters";
import { useHotelMetrics, useMetricDates } from "@/lib/useHotelData";
import { money, money2, num, C, CHART_COLORS, downloadCsv } from "@/lib/hotel";
import {
  snapshotDates, snapshotFor, headline, headlineTrends, composition, quality,
  indexSnapshot, metricValue, firstValue, PERIODS, PERIOD_LABEL, HEADLINE,
} from "@/lib/statisticsAnalytics";
import MetricExplorer from "@/components/statistics/MetricExplorer";

const tip = { background: "#0A1628", border: "1px solid #ffffff14", borderRadius: 12, color: "#e2e8f0" };
const axis = { fill: "#64748b", fontSize: 10 };

const ICONS = {
  occupancy: Gauge, adr: DollarSign, revpar: TrendingUp,
  sold: BedDouble, revenue: Wallet, guests: Users2,
};
const ACCENTS = {
  occupancy: C.cyan, adr: C.purple, revpar: C.green,
  sold: C.amber, revenue: C.purple, guests: C.cyan,
};

function formatByUnit(value, unit) {
  if (value === null || value === undefined) return "—";
  if (unit === "currency") return money2(value);
  if (unit === "percentage") return `${Number(value).toFixed(1)}%`;
  return num(value);
}

// "A, B and C" — and past four names, a count, because the banner this feeds is
// one line and a PMS with real history loaded would list a hundred metrics.
function listNames(names = []) {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  if (names.length > 4) return `${names.slice(0, 3).join(", ")} and ${names.length - 3} others`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function Segmented({ value, onChange, options }) {
  return (
    <div className="flex flex-wrap gap-1 rounded-lg bg-[#0A1628] p-1">
      {options.map(([key, label, hint]) => (
        <button
          key={key}
          onClick={() => onChange(key)}
          title={hint}
          className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
            value === key ? "bg-[#6C63FF] text-white" : "text-slate-400 hover:text-slate-200"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export default function Statistics() {
  const { dateRange, property } = useGlobalFilters();
  const [period, setPeriod] = useState("actual_today");
  const [trendKey, setTrendKey] = useState("occupancy");

  const { data: rows = [], isLoading } = useHotelMetrics(dateRange, property);
  const { data: allDates = [] } = useMetricDates(property);

  const dates = useMemo(() => snapshotDates(rows), [rows]);
  const [pickedDate, setPickedDate] = useState("");
  const snapshot = useMemo(() => snapshotFor(rows, pickedDate), [rows, pickedDate]);

  const cards = useMemo(() => headline(snapshot.rows, period), [snapshot.rows, period]);
  const index = useMemo(() => indexSnapshot(snapshot.rows), [snapshot.rows]);
  const trends = useMemo(() => headlineTrends(rows), [rows]);
  const revenueMix = useMemo(() => composition(snapshot.rows, "Revenue", period).slice(0, 10), [snapshot.rows, period]);
  const paymentMix = useMemo(() => composition(snapshot.rows, "Payments", period), [snapshot.rows, period]);
  const q = useMemo(() => quality(rows), [rows]);

  if (isLoading) return <p className="text-slate-500">Loading hotel statistics…</p>;

  // Two different empty states. "Nothing imported ever" and "nothing in this date
  // range" need different fixes, and conflating them sends the operator to the
  // Import page to re-upload a file they already have.
  if (!rows.length) {
    const everImported = allDates.length > 0;
    return (
      <div className="space-y-6">
        <header>
          <p className="text-[11px] uppercase tracking-[0.3em] text-[#00D4FF]">Property Performance</p>
          <h1 className="mt-2 font-heading text-3xl font-semibold text-white">Statistics</h1>
        </header>
        <Card title={everImported ? "No snapshot in this date range" : "No statistics imported yet"}>
          {everImported ? (
            <p className="text-sm text-slate-400">
              This property has {num(allDates.length)} snapshot{allDates.length === 1 ? "" : "s"}, the most recent
              dated {allDates[0]}. Move the date range to cover it.
            </p>
          ) : (
            <p className="text-sm text-slate-400">
              Upload a “Hotel Statistics” export from Import Reports. Each file is one day’s snapshot covering
              occupancy, ADR, RevPAR, revenue, taxes, payments, guests and reservations.
            </p>
          )}
        </Card>
      </div>
    );
  }

  const roomsAvailable = firstValue(index, ["Rooms Available To Sell"], period);
  const totalRooms = firstValue(index, ["Total Rooms"], "actual_today");
  const outOfOrder = metricValue(index, "Out Of Order", period);
  const arrivals = metricValue(index, "Arrivals", period);
  const departures = metricValue(index, "Departures", period);
  const walkIns = metricValue(index, "Walk Ins", period);
  const noShows = metricValue(index, "No Shows", period);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[11px] uppercase tracking-[0.3em] text-[#00D4FF]">Property Performance</p>
          <h1 className="mt-2 font-heading text-3xl font-semibold text-white">Statistics</h1>
          <p className="mt-1 text-sm text-slate-400">
            Snapshot for {snapshot.date || "—"} · {num(snapshot.rows.length)} metrics
            {dates.length > 1 ? ` · ${num(dates.length)} snapshots in range` : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {dates.length > 1 && (
            <select
              value={snapshot.date}
              onChange={(e) => setPickedDate(e.target.value)}
              className="h-9 rounded-lg border border-white/10 bg-[#0A1628] px-3 text-sm text-slate-200 outline-none focus:border-[#6C63FF]"
            >
              {[...dates].reverse().map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
          )}
          <Segmented value={period} onChange={setPeriod} options={PERIODS} />
        </div>
      </header>

      {/* The window being read is stated in words. "62" means something very
          different under Today than under Year to date, and the three windows
          nest, so the distinction is easy to lose. */}
      <p className="flex items-center gap-2 text-xs text-slate-500">
        <Info className="h-3.5 w-3.5 shrink-0" />
        Showing <span className="text-slate-300">{PERIOD_LABEL[period]}</span>
        {period === "actual_today"
          ? ` — activity on ${snapshot.date} alone.`
          : period === "mtd"
          ? ` — 1 ${new Date(`${snapshot.date}T00:00:00`).toLocaleString("en-US", { month: "long" })} through ${snapshot.date}.`
          : ` — 1 January through ${snapshot.date}.`}
      </p>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((m) => (
          <KpiCard
            key={m.key}
            label={m.label}
            value={formatByUnit(m.value, m.unit)}
            accent={ACCENTS[m.key]}
            icon={ICONS[m.key]}
            sub={
              m.change
                ? `${m.change.pct >= 0 ? "+" : "−"}${Math.abs(m.change.pct).toFixed(1)}% vs last year`
                : m.hint
            }
          />
        ))}
      </div>

      {/* Prior-year coverage is partial, and the honest version of that is a
          list rather than a flag. Last-year columns are present for all ~106
          metrics but read 0.00 for nearly all of them — the PMS has no trading
          history loaded, so a delta against those zeros would print "+100%" on
          every card. A few room-inventory counts do carry real prior-year
          values, so this names exactly which ones rather than claiming the
          whole export is empty. */}
      {q.priorYearMetrics.length === 0 ? (
        <p className="rounded-xl border border-[#FFB547]/20 bg-[#FFB547]/5 px-4 py-2.5 text-xs text-[#FFB547]">
          Last-year columns are all zero in this export, so no year-over-year comparison is shown. That is missing
          history in the PMS, not a year with no business.
        </p>
      ) : (
        <p className="rounded-xl border border-[#FFB547]/20 bg-[#FFB547]/5 px-4 py-2.5 text-xs text-[#FFB547]">
          Last-year figures are only loaded for {listNames(q.priorYearMetrics)}. Every other metric reads zero for
          last year, so year-over-year is shown on those {q.priorYearMetrics.length} and left off elsewhere — that is
          missing history in the PMS, not a year with no business.
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Rooms tonight" subtitle="How the 100-room inventory resolved">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {[
              ["Total rooms", totalRooms, "count"],
              ["Available to sell", roomsAvailable, "count"],
              ["Out of order", outOfOrder, "count"],
              ["Sold", metricValue(index, "Room Sold", period), "count"],
            ].map(([label, value, unit]) => (
              <div key={label}>
                <p className="text-[11px] uppercase tracking-[0.14em] text-slate-500">{label}</p>
                <p className="mt-1 font-heading text-2xl font-semibold tabular-nums text-white">
                  {formatByUnit(value, unit)}
                </p>
              </div>
            ))}
          </div>
          <div className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
            {[
              ["Arrivals", arrivals],
              ["Departures", departures],
              ["Walk-ins", walkIns],
              ["No-shows", noShows],
            ].map(([label, value]) => (
              <div key={label}>
                <p className="text-[11px] uppercase tracking-[0.14em] text-slate-500">{label}</p>
                <p className="mt-1 text-lg font-medium tabular-nums text-slate-200">{formatByUnit(value, "count")}</p>
              </div>
            ))}
          </div>
        </Card>

        <Card
          title="Where the money came from"
          subtitle={`Settlements by method · ${PERIOD_LABEL[period]}`}
        >
          {paymentMix.length === 0 ? (
            <p className="text-sm text-slate-500">No settlements recorded for this window.</p>
          ) : (
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={paymentMix} layout="vertical" margin={{ left: 34, right: 12 }}>
                  <CartesianGrid stroke="#ffffff0a" horizontal={false} />
                  <XAxis type="number" tick={axis} stroke="#ffffff10" tickFormatter={(v) => money(v)} />
                  <YAxis type="category" dataKey="name" tick={axis} stroke="#ffffff10" width={96} />
                  <Tooltip contentStyle={tip} formatter={(v) => money2(v)} cursor={{ fill: "#ffffff06" }} />
                  <Bar dataKey="value" radius={[0, 4, 4, 0]}>
                    {paymentMix.map((e, i) => (
                      <Cell key={e.name} fill={e.value < 0 ? C.coral : CHART_COLORS[i % CHART_COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>
      </div>

      <Card
        title="Revenue lines"
        subtitle={`Non-zero revenue codes · ${PERIOD_LABEL[period]} · ${num(revenueMix.length)} of the section shown`}
      >
        {revenueMix.length === 0 ? (
          <p className="text-sm text-slate-500">No revenue posted in this window.</p>
        ) : (
          <div className="space-y-2.5">
            {revenueMix.map((r, i) => {
              const top = Math.abs(revenueMix[0].value) || 1;
              return (
                <div key={r.name} className="flex items-center gap-3">
                  <span className="w-44 shrink-0 truncate text-xs text-slate-400" title={r.name}>{r.name}</span>
                  <span className="h-2 flex-1 overflow-hidden rounded-full bg-white/5">
                    <span
                      className="block h-full rounded-full transition-all duration-500"
                      style={{
                        width: `${Math.max(2, (Math.abs(r.value) / top) * 100)}%`,
                        background: CHART_COLORS[i % CHART_COLORS.length],
                      }}
                    />
                  </span>
                  <span className="w-24 shrink-0 text-right text-sm tabular-nums text-slate-200">{money2(r.value)}</span>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* A trend needs more than one snapshot. Rather than draw a single dot and
          call it a line, explain what would make this chart appear. */}
      <Card
        title="Across snapshots"
        subtitle="Built from the Today column only — MTD and YTD figures from consecutive days overlap"
        right={
          dates.length > 1 ? (
            <Segmented
              value={trendKey}
              onChange={setTrendKey}
              options={HEADLINE.map((m) => [m.key, m.label])}
            />
          ) : null
        }
      >
        {dates.length < 2 ? (
          <p className="text-sm text-slate-400">
            One snapshot in this range ({snapshot.date}). Import a statistics export for another day, or widen the
            date range, and the trend appears here.
          </p>
        ) : (
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={trends[trendKey] || []} margin={{ left: -12, right: 8, top: 8 }}>
                <defs>
                  <linearGradient id="stat-trend" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={C.cyan} stopOpacity={0.45} />
                    <stop offset="100%" stopColor={C.cyan} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="#ffffff0a" vertical={false} />
                <XAxis dataKey="date" tick={axis} stroke="#ffffff10" />
                <YAxis tick={axis} stroke="#ffffff10" />
                <Tooltip
                  contentStyle={tip}
                  formatter={(v) => formatByUnit(v, HEADLINE.find((m) => m.key === trendKey)?.unit)}
                />
                <Area
                  type="monotone"
                  dataKey="value"
                  name={HEADLINE.find((m) => m.key === trendKey)?.label || "Value"}
                  stroke={C.cyan}
                  strokeWidth={2}
                  fill="url(#stat-trend)"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>

      <MetricExplorer rows={snapshot.rows} />

      <Card
        title="About this data"
        subtitle="What was imported and how much of it the app recognised"
        right={
          <button
            onClick={() =>
              downloadCsv(
                snapshot.rows.map((r) => ({
                  business_date: r.business_date,
                  section: r.section,
                  metric: r.metric_name,
                  category: r.metric_category,
                  period: r.period,
                  value: r.value,
                  unit: r.unit,
                  original: r.original_value,
                })),
                `statistics-${snapshot.date || "snapshot"}.csv`
              )
            }
            className="rounded-lg bg-[#6C63FF]/20 px-3 py-1.5 text-xs text-[#6C63FF] transition-colors hover:bg-[#6C63FF]/35"
          >
            Export snapshot
          </button>
        }
      >
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[
            ["Snapshots in range", num(q.snapshots)],
            ["Metrics stored", num(q.metrics)],
            ["Unrecognised metrics", q.unknownCount ? num(q.unknownCount) : "none"],
            ["Date range", q.firstDate === q.lastDate ? q.firstDate : `${q.firstDate} → ${q.lastDate}`],
          ].map(([label, value]) => (
            <div key={label}>
              <dt className="text-[11px] uppercase tracking-[0.14em] text-slate-500">{label}</dt>
              <dd className="mt-1 text-sm text-slate-200">{value}</dd>
            </div>
          ))}
        </dl>

        {q.unknownNames.length > 0 && (
          <p className="mt-4 text-xs text-slate-400">
            Imported but not categorised, and shown as-is in the table above:{" "}
            <span className="text-[#FFB547]">{q.unknownNames.join(", ")}</span>
          </p>
        )}

        {q.inferredDates.length > 0 && (
          <p className="mt-3 text-xs text-[#FFB547]">
            Hotel Statistics exports carry no date column, so the date on{" "}
            {q.inferredDates.length === 1 ? "this snapshot was" : "these snapshots were"} inferred at import:{" "}
            {q.inferredDates.join(", ")}. Correct it on the Import page if it is wrong.
          </p>
        )}
      </Card>
    </div>
  );
}
