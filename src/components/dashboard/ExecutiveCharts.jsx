import React, { useMemo, useRef } from "react";
import {
  ResponsiveContainer, AreaChart, Area, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip,
} from "recharts";
import Card from "@/components/ui-exec/Card";
import ChartToolbar from "@/components/charts/ChartToolbar";
import { money, money2, pct, C } from "@/lib/hotel";

const tip = { background: "#0A1628", border: "1px solid #ffffff14", borderRadius: 12, color: "#e2e8f0" };
const axis = { fill: "#64748b", fontSize: 10 };

function MiniChartCard({ title, data, dataKey, fmt, color, chartType }) {
  const ref = useRef(null);
  return (
    <Card
      title={title}
      right={<ChartToolbar targetRef={ref} title={title} />}
    >
      <div ref={ref} className="h-48">
        <ResponsiveContainer width="100%" height="100%">
          {chartType === "line" ? (
            <LineChart data={data} margin={{ left: -10, right: 8, top: 8 }}>
              <CartesianGrid stroke="#ffffff0a" vertical={false} />
              <XAxis dataKey="name" tick={axis} stroke="#ffffff10" />
              <YAxis tick={axis} stroke="#ffffff10" tickFormatter={(v) => fmt(v)} width={70} />
              <Tooltip contentStyle={tip} formatter={(v) => fmt(v)} />
              <Line type="monotone" dataKey={dataKey} stroke={color} strokeWidth={2} dot={false} />
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
              <XAxis dataKey="name" tick={axis} stroke="#ffffff10" />
              <YAxis tick={axis} stroke="#ffffff10" tickFormatter={(v) => fmt(v)} width={70} />
              <Tooltip contentStyle={tip} formatter={(v) => fmt(v)} />
              <Area type="monotone" dataKey={dataKey} stroke={color} strokeWidth={2} fill={`url(#grad-${dataKey})`} />
            </AreaChart>
          )}
        </ResponsiveContainer>
      </div>
    </Card>
  );
}

export default function ExecutiveCharts({ rows }) {
  const data = useMemo(() => {
    return rows
      .map((r) => ({
        name: String(r.date).slice(5),
        date: r.date,
        revenue: Number(r.total_revenue) || 0,
        adr: Number(r.adr) || 0,
        revpar: Number(r.revpar) || 0,
        occupancy: Number(r.occupancy) || 0,
      }))
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-31);
  }, [rows]);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <MiniChartCard title="Revenue" data={data} dataKey="revenue" fmt={money} color={C.purple} chartType="area" />
      <MiniChartCard title="ADR" data={data} dataKey="adr" fmt={money2} color={C.cyan} chartType="line" />
      <MiniChartCard title="RevPAR" data={data} dataKey="revpar" fmt={money2} color={C.green} chartType="area" />
      <MiniChartCard title="Occupancy" data={data} dataKey="occupancy" fmt={(v) => pct(v)} color={C.amber} chartType="line" />
    </div>
  );
}