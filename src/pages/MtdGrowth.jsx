import React, { useMemo } from "react";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";
import Card from "@/components/ui-exec/Card";
import KpiCard from "@/components/ui-exec/KpiCard";
import {
  AreaChart, Area, BarChart, Bar, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from "recharts";
import { useOccupancy } from "@/lib/useHotelData";
import { useGlobalFilters, MONTHS_LONG } from "@/lib/useGlobalFilters";
import { money, money2, num, pct, sum, inRange, C } from "@/lib/hotel";

const METRICS = [
  { key: "total_revenue", label: "Total Revenue", fmt: money },
  { key: "room_revenue", label: "Room Revenue", fmt: money },
  { key: "rooms_sold", label: "Rooms Sold", fmt: num },
  { key: "adr", label: "ADR", fmt: money2 },
  { key: "revpar", label: "RevPAR", fmt: money2 },
  { key: "occupancy", label: "Occupancy", fmt: (v) => pct(v) },
];

export default function MtdGrowth() {
  const { dateRange, compareDateRange, compareOn, property, properties, period, months, compareMonths } = useGlobalFilters();

  const { data: occ = [] } = useOccupancy(dateRange, property, months);
  const { data: prevOcc = [] } = useOccupancy(compareOn ? compareDateRange : { from: "", to: "" }, property, compareOn ? compareMonths : []);

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
    const elapsedDays = Math.round((to - from) / 86400000) + 1;
    return curRows;
  }, [curRows, dateRange]);

  const prevElapsed = useMemo(() => {
    if (!compareOn || !compareDateRange.from) return prevRows;
    // Match same number of days from previous period start
    const from = new Date(dateRange.from);
    const to = new Date(dateRange.to);
    const elapsedDays = Math.round((to - from) / 86400000) + 1;
    const prevFrom = new Date(compareDateRange.from);
    const prevToDate = new Date(prevFrom);
    prevToDate.setDate(prevFrom.getDate() + elapsedDays - 1);
    const prevToIso = prevToDate.toISOString().slice(0, 10);
    return prevRows.filter((r) => inRange(r.date, compareDateRange.from, prevToIso));
  }, [prevRows, compareOn, dateRange, compareDateRange]);

  const calc = (rows, key) => {
    if (key === "occupancy") {
      const roomsSold = sum(rows, "rooms_sold");
      const totalRooms = rows.length * (properties.find((p) => p.id === property)?.rooms || 100);
      return totalRooms > 0 ? roomsSold / totalRooms : 0;
    }
    if (key === "adr" || key === "revpar") {
      if (rows.length === 0) return 0;
      return sum(rows, key) / rows.length;
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

  const chartData = useMemo(() => {
    const map = new Map();
    curElapsed.forEach((r) => {
      const d = String(r.date).slice(5);
      if (!map.has(d)) map.set(d, { date: d, current: 0, previous: 0 });
      map.get(d).current += Number(r.total_revenue || 0);
    });
    prevElapsed.forEach((r) => {
      const d = String(r.date).slice(5);
      if (!map.has(d)) map.set(d, { date: d, current: 0, previous: 0 });
      map.get(d).previous += Number(r.total_revenue || 0);
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

  return (
    <div className="space-y-6">
      <header>
        <p className="text-[11px] uppercase tracking-[0.3em] text-[#00D4FF]">Period Analysis</p>
        <h1 className="mt-2 font-heading text-3xl font-semibold text-white">MTD Growth</h1>
        <p className="mt-1 text-sm text-slate-400">
          Current: {dateRange.from || "—"} → {dateRange.to || "—"} · {curElapsed.length} days
          {compareOn && <> · vs Previous: {compareDateRange.from || "—"} → {compareDateRange.to || "—"} · {prevElapsed.length} days</>}
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {comparisons.map((m) => {
          const up = m.diff > 0;
          const flat = m.diff === 0 || m.prev === 0;
          const Icon = flat ? Minus : up ? TrendingUp : TrendingDown;
          return (
            <KpiCard
              key={m.key}
              label={m.label}
              value={m.fmt(m.cur)}
              sub={
                m.prev === 0
                  ? "Previous: N/A"
                  : `vs ${m.fmt(m.prev)} · ${up ? "+" : ""}${m.fmt(m.diff)} (${m.pctCh >= 0 ? "+" : ""}${m.pctCh.toFixed(1)}%)`
              }
              accent={flat ? C.amber : up ? C.green : C.coral}
              icon={Icon}
            />
          );
        })}
      </div>

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
                  <stop offset="0%" stopColor={C.purple} stopOpacity={0.6} />
                  <stop offset="100%" stopColor={C.purple} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="#ffffff0a" vertical={false} />
              <XAxis dataKey="date" tick={{ fill: "#64748b", fontSize: 10 }} stroke="#ffffff10" />
              <YAxis tick={{ fill: "#64748b", fontSize: 10 }} stroke="#ffffff10" tickFormatter={(v) => `${(v * 100).toFixed(0)}%`} />
              <Tooltip
                contentStyle={{ background: "#0A1628", border: "1px solid #ffffff14", borderRadius: 12, color: "#e2e8f0" }}
                formatter={(v) => pct(v)}
              />
              <Area type="monotone" dataKey="current" name="Current" stroke={C.purple} fill="url(#curOcc)" strokeWidth={2} />
              <Line type="monotone" dataKey="previous" name="Previous" stroke={C.cyan} strokeWidth={2} dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </Card>
    </div>
  );
}