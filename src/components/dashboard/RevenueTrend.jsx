import React, { useRef } from "react";
import Card from "@/components/ui-exec/Card";
import ChartToolbar from "@/components/charts/ChartToolbar";
import { AreaChart, Area, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine } from "recharts";
import { C, money, getOccThreshold } from "@/lib/hotel";
import { toCents, fromCents } from "@/lib/decimal";

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
      revenueCents: 0,
      allRoomsSold: 0,
      // Known occupied and available counts only from capacity-covered rows
      coveredRoomsSold: 0,
      coveredRoomsAvailable: 0,
      // Uncovered rows (no capacity) with roomsSold & occupancy (defensible implied capacity)
      uncoveredRoomsSold: 0,
      uncoveredCapacityWeight: 0,
      // Fallback ADR weighting tracking
      adrRevenueCents: 0,
      impliedRoomsSold: 0,
      adrSumCents: 0,
      adrCount: 0,
    };

    const revCents = toCents(r.room_revenue ?? r.revenue);
    const sold = Number(r.rooms_sold) || 0;
    const avail = Number(r.rooms_available ?? r.total_rooms) || 0;
    const occ = Number(r.occupancy) || 0;
    const adr = Number(r.adr) || 0;
    const adrCents = toCents(adr);

    existing.revenueCents += revCents;
    existing.allRoomsSold += sold;

    // Compute portfolio occupancy strictly from rows with explicit capacity or
    // defensible implied capacity (sold / occupancy). Unsupported occupancy-only
    // source rows or sold counts lacking capacity/occupancy cannot infer capacity
    // and are omitted from the portfolio denominator to prevent distortion.
    if (avail > 0) {
      existing.coveredRoomsSold += sold;
      existing.coveredRoomsAvailable += avail;
    } else if (sold > 0 && occ > 0) {
      existing.uncoveredRoomsSold += sold;
      existing.uncoveredCapacityWeight += sold / occ;
    }

    if (adrCents > 0) {
      existing.adrSumCents += adrCents;
      existing.adrCount += 1;
      if (revCents > 0) {
        existing.adrRevenueCents += revCents;
        existing.impliedRoomsSold += revCents / adrCents;
      }
    }

    byDate.set(isoDate, existing);
  }

  // Sort strictly in chronological order
  const sortedDates = Array.from(byDate.keys()).sort();

  return sortedDates.map((isoDate) => {
    const item = byDate.get(isoDate);

    let adr = 0;
    if (item.allRoomsSold > 0) {
      adr = fromCents(Math.round(item.revenueCents / item.allRoomsSold));
    } else if (item.impliedRoomsSold > 0) {
      adr = fromCents(Math.round(item.adrRevenueCents / item.impliedRoomsSold));
    } else if (item.adrCount > 0) {
      adr = fromCents(Math.round(item.adrSumCents / item.adrCount));
    }

    let occupancy = 0;
    const totalCapacityWeight = item.coveredRoomsAvailable + item.uncoveredCapacityWeight;
    const totalOccupiedRooms = item.coveredRoomsSold + item.uncoveredRoomsSold;

    // When no defensible denominator exists across rows for this date, return 0
    // so the chart safely hides the occupancy line.
    if (totalCapacityWeight > 0) {
      occupancy = totalOccupiedRooms / totalCapacityWeight;
    }
    occupancy = Math.max(0, Math.min(1, occupancy));

    return {
      date: isoDate.slice(5),
      fullDate: isoDate,
      revenue: fromCents(item.revenueCents),
      adr,
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