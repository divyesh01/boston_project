import React, { useMemo } from "react";
import { TrendingUp, TrendingDown, Minus, DollarSign, Wallet, BedDouble, Gauge, Percent, Sparkles } from "lucide-react";
import Card from "@/components/ui-exec/Card";
import KpiCard from "@/components/ui-exec/KpiCard";
import {
  AreaChart, Area, BarChart, Bar, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from "recharts";
import { useOccupancy } from "@/lib/useHotelData";
import { useGlobalFilters } from "@/lib/useGlobalFilters";
import { money, money2, num, pct, sum, inRange, C, occupancyStats } from "@/lib/hotel";
import { ErrorState } from "@/components/ui/status";

const METRICS = [
  { key: "total_revenue", label: "Total Revenue", fmt: money, color: C.green, icon: DollarSign },
  { key: "room_revenue", label: "Room Revenue", fmt: money, color: C.cyan, icon: Wallet },
  { key: "rooms_sold", label: "Rooms Sold", fmt: num, color: C.purple, icon: BedDouble },
  { key: "adr", label: "ADR", fmt: money2, color: C.amber, icon: Gauge },
  { key: "revpar", label: "RevPAR", fmt: money2, color: C.coral, icon: Percent },
  { key: "occupancy", label: "Occupancy", fmt: (v) => pct(v), color: "#4FE3C1", icon: TrendingUp },
];

// Small owner-facing stat chip used inside the Owner's Snapshot summary.
function MiniStat({ label, value, pctCh }) {
  const up = pctCh > 0;
  const flat = pctCh === 0;
  const color = flat ? "#94a3b8" : up ? "#00E096" : "#FF6B6B";
  return (
    <div className="rounded-xl border border-white/5 bg-white/[0.03] p-3">
      <p className="text-[10px] uppercase tracking-widest text-slate-500">{label}</p>
      <p className="mt-1 font-heading text-base font-semibold text-white">{value}</p>
      <p className="mt-0.5 text-xs font-medium" style={{ color }}>
        {flat ? "—" : `${up ? "▲" : "▼"} ${Math.abs(pctCh).toFixed(1)}%`}
      </p>
    </div>
  );
}

export default function MtdGrowth() {
  const { dateRange, compareDateRange, compareOn, property, properties, period, months, compareMonths } = useGlobalFilters();

  const occQ = useOccupancy(dateRange, property, months);
  const prevOccQ = useOccupancy(compareOn ? compareDateRange : { from: "", to: "" }, property, compareOn ? compareMonths : [], compareOn);
  const { data: occ = [] } = occQ;
  const { data: prevOcc = [] } = prevOccQ;

  const curRows = useMemo(
    () => occ.filter((r) => inRange(r.date, dateRange.from, dateRange.to)),
    [occ, dateRange]
  );
  const prevRows = useMemo(
    () => prevOcc.filter((r) => inRange(r.date, compareDateRange.from, compareDateRange.to)),
    [prevOcc, compareDateRange]
  );

  // For incomplete month comparison, only compare equivalent elapsed days
  const curElapsed = useMemo(() => {
    if (!dateRange.from) return curRows;
    const from = new Date(dateRange.from);
    const to = new Date(dateRange.to);
    const elapsedDays = Math.round((to.getTime() - from.getTime()) / 86400000) + 1;
    return curRows;
  }, [curRows, dateRange]);

  const prevElapsed = useMemo(() => {
    if (!compareOn || !compareDateRange.from) return prevRows;
    // Match same number of days from previous period start
    const from = new Date(dateRange.from);
    const to = new Date(dateRange.to);
    const elapsedDays = Math.round((to.getTime() - from.getTime()) / 86400000) + 1;
    const prevFrom = new Date(compareDateRange.from);
    const prevToDate = new Date(prevFrom);
    prevToDate.setDate(prevFrom.getDate() + elapsedDays - 1);
    const prevToIso = prevToDate.toISOString().slice(0, 10);
    return prevRows.filter((r) => inRange(r.date, compareDateRange.from, prevToIso));
  }, [prevRows, compareOn, dateRange, compareDateRange]);

  // Shared engine: capacity is summed per property (portfolio-safe), and ADR /
  // RevPAR are properly weighted.
  //
  // Both were wrong here before. Capacity used
  // `properties.find(p => p.id === property)?.rooms || 100`, which returns
  // undefined -> 100 whenever `property` is "all" or an array. And ADR / RevPAR
  // were `sum(rows, key) / rows.length` — the unweighted mean of daily rates,
  // which is not ADR: a 10-room day at $200 and a 90-room day at $100 averaged
  // to $150 instead of the true $110.
  const calc = (rows, key) => {
    if (key === "occupancy" || key === "adr" || key === "revpar") {
      return occupancyStats(rows, properties)[key];
    }
    return sum(rows, key);
  };

  const comparisons = METRICS.map((m) => {
    const cur = calc(curElapsed, m.key);
    const prev = calc(prevElapsed, m.key);
    const diff = cur - prev;
    const pctCh = prev > 0 ? (diff / prev) * 100 : 0;
    return { ...m, cur, prev, diff, pctCh };
  });

  // Owner's Snapshot: a plain-English read of MTD performance. Owners don't
  // want six raw numbers — they want "are we winning, and why". We rank the
  // metrics by % change to surface the strongest/weakest driver and narrate it.
  const summary = useMemo(() => {
    if (!compareOn) return null;
    const get = (k) => comparisons.find((c) => c.key === k);
    const rev = get("total_revenue");
    const adrM = get("adr");
    const revparM = get("revpar");
    const occM = get("occupancy");
    const ranked = [...comparisons].sort((a, b) => b.pctCh - a.pctCh);
    const best = ranked[0];
    const worst = ranked[ranked.length - 1];
    const phrase = (m) => `${m.pctCh >= 0 ? "up" : "down"} ${Math.abs(m.pctCh).toFixed(1)}%`;
    const sentence =
      `Revenue is ${phrase(rev)} to ${rev.fmt(rev.cur)} ` +
      `(${rev.diff >= 0 ? "+" : ""}${rev.fmt(rev.diff)} vs prior period). ` +
      `ADR ${phrase(adrM)} and RevPAR ${phrase(revparM)}, while occupancy ${phrase(occM)}. ` +
      `Top driver: ${best.label} (${phrase(best)})${worst.key !== best.key ? ` · lagging: ${worst.label} (${phrase(worst)})` : ""}.`;
    return { rev, adrM, revparM, occM, best, worst, sentence };
  }, [comparisons, compareOn]);

  const chartData = useMemo(() => {
    const map = new Map();
    curElapsed.forEach((r) => {
      const d = String(r.date).slice(5);
      if (!map.has(d)) map.set(d, { date: d, current: 0, previous: 0 });
      map.get(d).current += Number(r.room_revenue || 0);
    });
    prevElapsed.forEach((r) => {
      const d = String(r.date).slice(5);
      if (!map.has(d)) map.set(d, { date: d, current: 0, previous: 0 });
      map.get(d).previous += Number(r.room_revenue || 0);
    });
    return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
  }, [curElapsed, prevElapsed]);

  const occChart = useMemo(() => {
    const map = new Map();
    curElapsed.forEach((r) => {
      const d = String(r.date).slice(5);
      if (!map.has(d)) map.set(d, { date: d, current: 0, previous: 0 });
      map.get(d).current = (r.occupancy || 0) > 1 ? r.occupancy / 100 : (r.occupancy || 0);
    });
    prevElapsed.forEach((r) => {
      const d = String(r.date).slice(5);
      if (!map.has(d)) map.set(d, { date: d, current: 0, previous: 0 });
      map.get(d).previous = (r.occupancy || 0) > 1 ? r.occupancy / 100 : (r.occupancy || 0);
    });
    return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
  }, [curElapsed, prevElapsed]);

  // Per-day ADR / RevPAR (rate metrics) for trend charts. Each day is computed
  // from a single-row occupancyStats so capacity is portfolio-safe, matching the
  // weighted logic used by the metric cards above.
  const buildRateChart = (key) => {
    const map = new Map();
    const pushSide = (rows, side) => {
      rows.forEach((r) => {
        const d = String(r.date).slice(5);
        if (!map.has(d)) map.set(d, { date: d, current: 0, previous: 0 });
        map.get(d)[side] = occupancyStats([r], properties)[key];
      });
    };
    pushSide(curElapsed, "current");
    pushSide(prevElapsed, "previous");
    return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
  };

  const adrChart = useMemo(() => buildRateChart("adr"), [curElapsed, prevElapsed, properties]);
  const revparChart = useMemo(() => buildRateChart("revpar"), [curElapsed, prevElapsed, properties]);

  return (
    <div className="space-y-6">
      <header className="relative overflow-hidden rounded-3xl border border-white/10 bg-gradient-to-br from-[#101E36] to-[#0A1628] p-6">
        <div className="pointer-events-none absolute -right-12 -top-12 h-44 w-44 rounded-full bg-[#6C63FF]/20 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-12 -left-12 h-44 w-44 rounded-full bg-[#00E096]/20 blur-3xl" />
        <p className="relative text-[11px] uppercase tracking-[0.3em] text-[#00D4FF]">Period Analysis</p>
        <h1 className="relative mt-2 font-heading text-3xl font-semibold text-white">MTD Growth</h1>
        <p className="relative mt-1 text-sm text-slate-400">
          Current: {dateRange.from || "—"} → {dateRange.to || "—"} · {curElapsed.length} days
          {compareOn && <> · vs Previous: {compareDateRange.from || "—"} → {compareDateRange.to || "—"} · {prevElapsed.length} days</>}
        </p>
      </header>

      {(occQ.isError || prevOccQ.isError) && (
        <ErrorState
          title="Could not load the comparison"
          description="Growth is the difference between two reads, and at least one failed. A 0.0% delta below would be indistinguishable from a genuinely flat period."
          error={occQ.error || prevOccQ.error}
          onRetry={() => { occQ.refetch(); prevOccQ.refetch(); }}
        />
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {comparisons.map((m) => {
          const up = m.diff > 0;
          const flat = m.diff === 0 || m.prev === 0;
          return (
            <div key={m.key} className="group relative">
              <div
                className="pointer-events-none absolute -inset-px rounded-2xl opacity-25 blur-xl transition-opacity duration-300 group-hover:opacity-45"
                style={{ background: m.color }}
              />
              <KpiCard
                label={m.label}
                value={m.fmt(m.cur)}
                sub={
                  m.prev === 0 ? (
                    <span className="text-slate-500">Previous: N/A</span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5">
                      <span className={`font-medium ${up ? "text-[#00E096]" : "text-[#FF6B6B]"}`}>
                        {up ? "▲" : "▼"} {Math.abs(m.pctCh).toFixed(1)}%
                      </span>
                      <span className="text-slate-500">vs {m.fmt(m.prev)}</span>
                    </span>
                  )
                }
                accent={m.color}
                icon={m.icon}
              />
            </div>
          );
        })}
      </div>

      {summary && (
        <Card className="relative overflow-hidden border-[#00D4FF]/20 bg-gradient-to-br from-[#0F1F35] to-[#0A1628]">
          <div className="pointer-events-none absolute -right-10 -top-10 h-32 w-32 rounded-full bg-[#00D4FF]/10 blur-3xl" />
          <div className="relative flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-[#00D4FF]" />
            <h2 className="font-heading text-lg font-semibold text-white">Owner's Snapshot</h2>
          </div>
          <p className="relative mt-2 max-w-3xl text-sm leading-relaxed text-slate-300">{summary.sentence}</p>
          <div className="relative mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <MiniStat label="Revenue" value={summary.rev.fmt(summary.rev.cur)} pctCh={summary.rev.pctCh} />
            <MiniStat label={summary.adrM.label} value={summary.adrM.fmt(summary.adrM.cur)} pctCh={summary.adrM.pctCh} />
            <MiniStat label={summary.revparM.label} value={summary.revparM.fmt(summary.revparM.cur)} pctCh={summary.revparM.pctCh} />
            <MiniStat label={summary.occM.label} value={summary.occM.fmt(summary.occM.cur)} pctCh={summary.occM.pctCh} />
          </div>
        </Card>
      )}

      {compareOn && (
        <div className="rounded-2xl border border-[#00D4FF]/20 bg-[#00D4FF]/[0.04] p-4">
          <p className="text-xs uppercase tracking-widest text-[#00D4FF]">
            Comparison · {compareDateRange.from || "—"} → {compareDateRange.to || "—"} ({prevElapsed.length} elapsed days)
          </p>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/10 text-xs text-slate-500">
                  <th className="py-2 text-left font-medium">Metric</th>
                  <th className="py-2 text-right font-medium">Current</th>
                  <th className="py-2 text-right font-medium">Previous</th>
                  <th className="py-2 text-right font-medium">Difference</th>
                  <th className="py-2 text-right font-medium">% Change</th>
                  <th className="py-2 text-center font-medium">Trend</th>
                </tr>
              </thead>
              <tbody>
                {comparisons.map((m) => {
                  const up = m.diff > 0;
                  const flat = m.diff === 0 || m.prev === 0;
                  return (
                    <tr key={m.key} className="border-b border-white/5">
                      <td className="py-3 text-slate-300">{m.label}</td>
                      <td className="py-3 text-right tabular-nums text-white">{m.fmt(m.cur)}</td>
                      <td className="py-3 text-right tabular-nums text-slate-400">{m.prev === 0 ? "N/A" : m.fmt(m.prev)}</td>
                      <td className={`py-3 text-right tabular-nums ${flat ? "text-slate-500" : up ? "text-[#00E096]" : "text-[#FF6B6B]"}`}>
                        {m.prev === 0 ? "N/A" : `${up ? "+" : ""}${m.fmt(m.diff)}`}
                      </td>
                      <td className={`py-3 text-right tabular-nums ${flat ? "text-slate-500" : up ? "text-[#00E096]" : "text-[#FF6B6B]"}`}>
                        {m.prev === 0 ? "N/A" : `${m.pctCh >= 0 ? "+" : ""}${m.pctCh.toFixed(1)}%`}
                      </td>
                      <td className="py-3 text-center">
                        {flat ? <Minus className="mx-auto h-4 w-4 text-slate-500" /> : up ? <TrendingUp className="mx-auto h-4 w-4 text-[#00E096]" /> : <TrendingDown className="mx-auto h-4 w-4 text-[#FF6B6B]" />}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <Card title="Revenue Comparison" subtitle="Current period vs previous period by day">
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} margin={{ left: -12, right: 8, top: 8 }}>
              <CartesianGrid stroke="#ffffff0a" vertical={false} />
              <XAxis dataKey="date" tick={{ fill: "#64748b", fontSize: 10 }} stroke="#ffffff10" />
              <YAxis tick={{ fill: "#64748b", fontSize: 10 }} stroke="#ffffff10" tickFormatter={(v) => `${v / 1000}k`} />
              <Tooltip
                contentStyle={{ background: "#0A1628", border: "1px solid #ffffff14", borderRadius: 12, color: "#e2e8f0" }}
                formatter={(v) => money(v)}
              />
              <Bar dataKey="current" name="Current" fill={C.purple} radius={[4, 4, 0, 0]} />
              <Bar dataKey="previous" name="Previous" fill={C.cyan} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <Card title="Occupancy Trend" subtitle="Daily occupancy comparison">
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={occChart} margin={{ left: -12, right: 8, top: 8 }}>
              <defs>
                <linearGradient id="curOcc" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={C.cyan} stopOpacity={0.6} />
                  <stop offset="100%" stopColor={C.cyan} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="#ffffff0a" vertical={false} />
              <XAxis dataKey="date" tick={{ fill: "#64748b", fontSize: 10 }} stroke="#ffffff10" />
              <YAxis tick={{ fill: "#64748b", fontSize: 10 }} stroke="#ffffff10" tickFormatter={(v) => `${(v * 100).toFixed(0)}%`} />
              <Tooltip
                contentStyle={{ background: "#0A1628", border: "1px solid #ffffff14", borderRadius: 12, color: "#e2e8f0" }}
                formatter={(v) => pct(v)}
              />
              <Area type="monotone" dataKey="current" name="Current" stroke={C.cyan} fill="url(#curOcc)" strokeWidth={2} />
              <Line type="monotone" dataKey="previous" name="Previous" stroke={C.purple} strokeWidth={2} dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <Card title="ADR Trend" subtitle="Daily Average Daily Rate comparison">
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={adrChart} margin={{ left: -12, right: 8, top: 8 }}>
              <defs>
                <linearGradient id="curAdr" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={C.amber} stopOpacity={0.6} />
                  <stop offset="100%" stopColor={C.amber} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="#ffffff0a" vertical={false} />
              <XAxis dataKey="date" tick={{ fill: "#64748b", fontSize: 10 }} stroke="#ffffff10" />
              <YAxis tick={{ fill: "#64748b", fontSize: 10 }} stroke="#ffffff10" tickFormatter={(v) => `$${v.toFixed(0)}`} />
              <Tooltip
                contentStyle={{ background: "#0A1628", border: "1px solid #ffffff14", borderRadius: 12, color: "#e2e8f0" }}
                formatter={(v) => money2(v)}
              />
              <Area type="monotone" dataKey="current" name="Current" stroke={C.amber} fill="url(#curAdr)" strokeWidth={2} />
              <Line type="monotone" dataKey="previous" name="Previous" stroke={C.coral} strokeWidth={2} dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <Card title="RevPAR Trend" subtitle="Daily Revenue Per Available Room comparison">
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={revparChart} margin={{ left: -12, right: 8, top: 8 }}>
              <defs>
                <linearGradient id="curRevpar" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#4FE3C1" stopOpacity={0.6} />
                  <stop offset="100%" stopColor="#4FE3C1" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="#ffffff0a" vertical={false} />
              <XAxis dataKey="date" tick={{ fill: "#64748b", fontSize: 10 }} stroke="#ffffff10" />
              <YAxis tick={{ fill: "#64748b", fontSize: 10 }} stroke="#ffffff10" tickFormatter={(v) => `$${v.toFixed(0)}`} />
              <Tooltip
                contentStyle={{ background: "#0A1628", border: "1px solid #ffffff14", borderRadius: 12, color: "#e2e8f0" }}
                formatter={(v) => money2(v)}
              />
              <Area type="monotone" dataKey="current" name="Current" stroke="#4FE3C1" fill="url(#curRevpar)" strokeWidth={2} />
              <Line type="monotone" dataKey="previous" name="Previous" stroke={C.purple} strokeWidth={2} dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </Card>
    </div>
  );
}