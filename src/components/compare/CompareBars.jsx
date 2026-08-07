import React, { useRef } from "react";
import Card from "@/components/ui-exec/Card";
import ChartToolbar from "@/components/charts/ChartToolbar";
import { BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid } from "recharts";
import { C } from "@/lib/hotel";

export default function CompareBars({ data, dateRange }) {
  const chartRef = useRef(null);
  return (
    <Card
      title="Period A vs Period B"
      subtitle="Revenue, rooms sold and ADR side by side"
      right={<ChartToolbar targetRef={chartRef} title="Period A vs Period B" dateRange={dateRange} />}
    >
      <div ref={chartRef} className="h-80">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ left: -10, right: 8, top: 8 }}>
            <CartesianGrid stroke="#ffffff0a" vertical={false} />
            <XAxis dataKey="metric" tick={{ fill: "#64748b", fontSize: 11 }} stroke="#ffffff10" />
            <YAxis tick={{ fill: "#64748b", fontSize: 11 }} stroke="#ffffff10" />
            <Tooltip contentStyle={{ background: "#0A1628", border: "1px solid #ffffff14", borderRadius: 12 }} />
            <Legend wrapperStyle={{ fontSize: 12, color: "#94a3b8" }} />
            <Bar dataKey="Period A" fill={C.purple} radius={[6, 6, 0, 0]} />
            <Bar dataKey="Period B" fill={C.cyan} radius={[6, 6, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}