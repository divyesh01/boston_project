import React, { useRef } from "react";
import Card from "@/components/ui-exec/Card";
import ChartToolbar from "@/components/charts/ChartToolbar";
import { AreaChart, Area, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine } from "recharts";
import { C, money, getOccThreshold } from "@/lib/hotel";

/**
 * Normalizes and groups daily report rows into chronologically sorted,
 * multi-property aggregated chart data points.
 * Preserves zero-revenue days and deduplicates multi-property entries for the same date.
 *
 * @param {Array<Object>} rows
 * @returns {Array<{ date: string, fullDate: string, revenue: number, adr: number, occupancyPct: number }>}
 */
export function buildRevenueTrendData(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return [];

  const byDate = new Map();

  for (const r of rows) {
    if (!r || !r.date) continue;
    const isoDate = String(r.date).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) continue;

    const existing = byDate.get(isoDate) || {
      fullDate: isoDate,
      revenue: 0,
      roomsSold: 0,
      roomsAvailable: 0,
      occSum: 0,
      rowCount: 0,
      fallbackAdr: 0,
    };

    const rev = Number(r.room_revenue ?? r.revenue) || 0;
    const sold = Number(r.rooms_sold) || 0;
    const avail = Number(r.rooms_available) || 0;
    const occ = Number(r.occupancy) || 0;

    existing.revenue += rev;
    existing.roomsSold += sold;
    existing.roomsAvailable += avail;
    existing.occSum += occ;
    existing.rowCount += 1;
    if (r.adr) existing.fallbackAdr = Number(r.adr);

    byDate.set(isoDate, existing);
  }

  // Sort strictly in chronological order
  const sortedDates = Array.from(byDate.keys()).sort();

  return sortedDates.map((isoDate) => {
    const item = byDate.get(isoDate);
    let adr = 0;
    if (item.roomsSold > 0) {
      adr = item.revenue / item.roomsSold;
    } else if (item.fallbackAdr > 0) {
      adr = item.fallbackAdr;
    }

    let occupancy = 0;
    if (item.roomsAvailable > 0) {
      occupancy = item.roomsSold / item.roomsAvailable;
    } else if (item.rowCount > 0) {
      occupancy = item.occSum / item.rowCount;
    }
    occupancy = Math.max(0, Math.min(1, occupancy));

    return {
      date: isoDate.slice(5),
      fullDate: isoDate,
      revenue: Math.round(item.revenue * 100) / 100,
      adr: Math.round(adr * 100) / 100,
      occupancyPct: Math.round(occupancy * 100),
    };
  });
}

export default function RevenueTrend({ rows, dateRange }) {
  const chartRef = useRef(null);
  const occThreshold = getOccThreshold();
  const data = buildRevenueTrendData(rows);
  const hasOccData = data.some((d) => d.occupancyPct > 0);

  return (
    <Card
      title="Daily Revenue Trend"
      subtitle="Total room revenue per day · occupancy line with 60% threshold"
      right={<ChartToolbar targetRef={chartRef} title="Daily Revenue Trend" dateRange={dateRange} />}
    >
      <div ref={chartRef} className="h-72">
        {data.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-slate-500">
            No daily revenue data available for the selected period
          </div>
        ) : (
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
                labelFormatter={(label, payload) => payload?.[0]?.payload?.fullDate || label}
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
        )}
      </div>
    </Card>
  );
}