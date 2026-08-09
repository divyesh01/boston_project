import React, { useMemo, useRef } from "react";
import {
  ResponsiveContainer, AreaChart, Area, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine,
} from "recharts";
import Card from "@/components/ui-exec/Card";
import ChartToolbar from "@/components/charts/ChartToolbar";
import { money, money2, pct, C, getOccThreshold } from "@/lib/hotel";

const tip = { background: "#0A1628", border: "1px solid #ffffff14", borderRadius: 12, color: "#e2e8f0" };
const axis = { fill: "#64748b", fontSize: 10 };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// Compact axis label for a YYYY-MM-DD date, e.g. "Aug 2".
function axisDate(dateStr) {
  if (!dateStr) return "";
  const [, m, d] = String(dateStr).slice(0, 10).split("-");
  return `${MONTHS[Number(m) - 1]} ${Number(d)}`;
}

// Full label for tooltips, e.g. "August 2, 2026".
function fullDate(dateStr) {
  if (!dateStr) return "";
  const [y, m, d] = String(dateStr).slice(0, 10).split("-");
  return `${MONTHS_LONG[Number(m) - 1]} ${Number(d)}, ${y}`;
}

// Pick ~N evenly spaced dates for the X axis. Only axis labels are reduced —
// every underlying data point stays in the chart and remains hoverable.
function spacedTicks(rows, want = 9) {
  if (!rows.length) return [];
  const step = Math.max(1, Math.floor(rows.length / want));
  const ticks = [];
  for (let i = 0; i < rows.length; i += step) ticks.push(rows[i].date);
  const last = rows[rows.length - 1].date;
  if (ticks[ticks.length - 1] !== last) ticks.push(last);
  return ticks;
}

/**
 * @type {import('react').FC<{
 *   title: any;
 *   data: any;
 *   dataKey: any;
 *   fmt: (v: any) => string;
 *   color: any;
 *   chartType: 'area' | 'line' | 'occ';
 *   ticks: any;
 *   occupancyTarget?: number | null;
 * }>}
 */
function MiniChartCard({ title, data, dataKey, fmt, color, chartType, ticks, occupancyTarget = null }) {
  const ref = useRef(null);
  return (
    <Card
      title={title}
      subtitle={`${axisDate(data[0]?.date)} → ${axisDate(data[data.length - 1]?.date)} · daily`}
      right={<ChartToolbar targetRef={ref} title={title} />}
    >
      <div ref={ref} className="h-56">
        <ResponsiveContainer width="100%" height="100%">
          {chartType === "line" || chartType === "occ" ? (
            <LineChart data={data} margin={{ left: -10, right: 8, top: 8 }}>
              <CartesianGrid stroke="#ffffff0a" vertical={false} />
              <XAxis dataKey="date" ticks={ticks} interval={0} tickFormatter={axisDate} tick={axis} stroke="#ffffff10" />
              <YAxis
                tick={axis}
                stroke="#ffffff10"
                tickFormatter={(v) => fmt(v)}
                width={64}
                domain={chartType === "occ" ? [0, 1] : [0, "auto"]}
              />
              <Tooltip contentStyle={tip} labelFormatter={fullDate} formatter={(v) => [fmt(v)]} />
              {chartType === "occ" && occupancyTarget != null && (
                <ReferenceLine
                  y={occupancyTarget}
                  stroke="#FF6B6B"
                  strokeDasharray="3 3"
                  strokeOpacity={0.8}
                  label={{
                    value: `${pct(occupancyTarget)} target`,
                    position: "insideBottomRight",
                    fill: "#FF6B6B",
                    fontSize: 10,
                  }}
                />
              )}
              <Line type="monotone" dataKey={dataKey} stroke={color} strokeWidth={2} dot={false} isAnimationActive={false} />
            </LineChart>
          ) : (
            <AreaChart data={data} margin={{ left: -10, right: 8, top: 8 }}>
              <defs>
                <linearGradient id={`grad-${dataKey}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={color} stopOpacity={0.4} />
                  <stop offset="100%" stopColor={color} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="#ffffff0a" vertical={false} />
              <XAxis dataKey="date" ticks={ticks} interval={0} tickFormatter={axisDate} tick={axis} stroke="#ffffff10" />
              <YAxis tick={axis} stroke="#ffffff10" tickFormatter={(v) => fmt(v)} width={64} domain={[0, "auto"]} />
              <Tooltip contentStyle={tip} labelFormatter={fullDate} formatter={(v) => [fmt(v)]} />
              <Area type="monotone" dataKey={dataKey} stroke={color} strokeWidth={2} fill={`url(#grad-${dataKey})`} dot={false} isAnimationActive={false} />
            </AreaChart>
          )}
        </ResponsiveContainer>
      </div>
    </Card>
  );
}

export default function ExecutiveCharts({ rows }) {
  const { data, ticks } = useMemo(() => {
    // One OccupancyDay row per property per date. In portfolio ("all properties")
    // mode multiple rows share a date, so we must aggregate to one point per day —
    // otherwise the X axis gets duplicate categories and the trend is misleading.
    // Revenue and rooms are summed; derived metrics are recomputed from the totals
    // (a plain average of ADR across properties would be wrong).
    const byDate = new Map();
    for (const r of rows || []) {
      const date = String(r.date || "").slice(0, 10);
      if (!date) continue;
      const cur = byDate.get(date);
      if (cur) {
        cur.revenue += Number(r.total_revenue) || 0;
        cur.roomsSold += Number(r.rooms_sold) || 0;
        cur.totalRooms += Number(r.total_rooms) || 0;
      } else {
        byDate.set(date, {
          date,
          revenue: Number(r.total_revenue) || 0,
          roomsSold: Number(r.rooms_sold) || 0,
          totalRooms: Number(r.total_rooms) || 0,
        });
      }
    }
    const data = [...byDate.values()]
      .map((d) => {
        const sold = d.roomsSold;
        const total = d.totalRooms;
        return {
          date: d.date,
          revenue: d.revenue,
          occupancy: total > 0 ? sold / total : 0,
          adr: sold > 0 ? d.revenue / sold : 0,
          revpar: total > 0 ? d.revenue / total : 0,
        };
      })
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    return { data, ticks: spacedTicks(data) };
  }, [rows]);

  if (!data.length) {
    return (
      <Card title="Core Performance" subtitle="No occupancy data for the selected period">
        <p className="py-10 text-center text-sm text-slate-500">
          Import an Occupancy Summary report to see daily revenue, occupancy, ADR, and RevPAR trends.
        </p>
      </Card>
    );
  }

  const occThreshold = getOccThreshold();

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <MiniChartCard title="Room Revenue Trend" data={data} dataKey="revenue" fmt={money} color={C.purple} chartType="area" ticks={ticks} />
      <MiniChartCard title="Occupancy % Trend" data={data} dataKey="occupancy" fmt={(v) => pct(v)} color={C.amber} chartType="occ" occupancyTarget={occThreshold || null} ticks={ticks} />
      <MiniChartCard title="ADR Trend" data={data} dataKey="adr" fmt={money2} color={C.cyan} chartType="line" ticks={ticks} />
      <MiniChartCard title="RevPAR Trend" data={data} dataKey="revpar" fmt={money2} color={C.green} chartType="area" ticks={ticks} />
    </div>
  );
}