import React, { useRef } from "react";
import Card from "@/components/ui-exec/Card";
import ChartToolbar from "@/components/charts/ChartToolbar";
import { AreaChart, Area, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine } from "recharts";
import { C, money, getOccThreshold } from "@/lib/hotel";

export default function RevenueTrend({ rows, dateRange }) {
  const chartRef = useRef(null);
  const occThreshold = getOccThreshold();
  const data = rows
    .filter((r) => Number(r.total_revenue || 0) > 0)
    .map((r) => ({
      date: String(r.date).slice(5),
      revenue: r.total_revenue || 0,
      adr: r.adr || 0,
      occupancyPct: Math.round(Number(r.occupancy || 0) * 100),
    }));
  const hasOccData = data.some((d) => d.occupancyPct > 0);

  return (
    <Card
      title="Daily Revenue Trend"
      subtitle="Total room revenue per day · occupancy line with 60% threshold"
      right={<ChartToolbar targetRef={chartRef} title="Daily Revenue Trend" dateRange={dateRange} />}
    >
      <div ref={chartRef} className="h-72">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ left: -12, right: 8, top: 8 }}>
            <defs>
              <linearGradient id="revGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={C.purple} stopOpacity={0.6} />
                <stop offset="100%" stopColor={C.purple} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="#ffffff0a" vertical={false} />
            <XAxis dataKey="date" tick={{ fill: "#64748b", fontSize: 11 }} stroke="#ffffff10" />
            <YAxis yAxisId="revenue" orientation="left" tick={{ fill: "#64748b", fontSize: 11 }} stroke="#ffffff10" tickFormatter={(v) => `${v / 1000}k`} />
            {hasOccData && (
              <YAxis yAxisId="occ" orientation="right" domain={[0, 100]} tick={{ fill: C.green, fontSize: 10 }} stroke="#ffffff10" tickFormatter={(v) => `${v}%`} />
            )}
            <Tooltip
              contentStyle={{ background: "#0A1628", border: "1px solid #ffffff14", borderRadius: 12, color: "#e2e8f0" }}
              formatter={(v, name) => (name === "occupancyPct" ? `${v}%` : money(v))}
            />
            <Area yAxisId="revenue" type="monotone" dataKey="revenue" stroke={C.cyan} strokeWidth={2} fill="url(#revGrad)" />
            {hasOccData && (
              <Line yAxisId="occ" type="monotone" dataKey="occupancyPct" stroke={C.green} strokeWidth={1.5} dot={false} />
            )}
            {hasOccData && (
              <ReferenceLine yAxisId="occ" y={occThreshold * 100} stroke={C.coral} strokeDasharray="4 4" label={{ value: `${Math.round(occThreshold * 100)}%`, fill: C.coral, fontSize: 10 }} />
            )}
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}