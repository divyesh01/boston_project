import React from "react";
import { ResponsiveContainer, PieChart, Pie, Cell, Tooltip, Legend } from "recharts";
import { CHART_COLORS, money2 } from "@/lib/hotel";

// Shared pie/donut chart used across the whole app.
//
// Global standard: every pie/donut chart must render
//   1. the chart itself,
//   2. data labels on the slices (name + value + %),
//   3. a full legend (always lists every segment),
//   4. a tooltip.
//
// Label policy (to keep the chart readable when there are many categories):
//   - slices below `minShareLabel` % do not get an on-chart label — the legend
//     and tooltip still show them, so no segment is hidden.
//   - `maxSlices` caps how many slices actually reach the pie (the overflow is
//     bucketed into an "Other" slice), which keeps labels from overlapping.
// The legend always reflects the exact data that was charted.

const tip = { background: "#0A1628", border: "1px solid #ffffff14", borderRadius: 12, color: "#e2e8f0" };

export default function PieDonut(
  /**
   * @type {{
   *   data?: Array<{ name?: any; value?: any; color?: string }>;
   *   type?: 'pie' | 'donut';
   *   height?: number | string;
   *   outerRadius?: number;
   *   innerRadius?: number;
   *   minShareLabel?: number;
   *   maxSlices?: number;
   *   formatter?: (v: any) => string;
   *   showLegend?: boolean;
   *   colors?: string[];
   *   centerLabel?: any;
   *   centerSub?: any;
   * }}
   */
  {
  data = [],
  type = "donut",
  height = 320,
  outerRadius = 110,
  innerRadius,
  minShareLabel = 0.5,
  maxSlices = 12,
  formatter = money2,
  showLegend = true,
  colors,
  centerLabel,
  centerSub,
}) {
  const filtered = (data || []).filter((d) => Math.abs(Number(d.value) || 0) > 0.009);
  const chart = filtered.slice(0, maxSlices);
  const overflow = filtered.slice(maxSlices);
  if (overflow.length) {
    chart.push({ name: "Other", value: overflow.reduce((a, x) => a + (Number(x.value) || 0), 0) });
  }
  const total = chart.reduce((a, d) => a + (Number(d.value) || 0), 0);
  const palette = colors && colors.length ? colors : CHART_COLORS;
  const colorAt = (i) => palette[i % palette.length];
  const radiusInner = innerRadius !== undefined ? innerRadius : type === "donut" ? Math.round(outerRadius * 0.55) : 0;

  // On-chart label: readable only when the slice is big enough to fit one.
  const renderLabel = ({ name, value, percent }) => {
    const share = (percent || 0) * 100;
    if (share < minShareLabel) return "";
    if (share < 4) return `${name} (${share.toFixed(1)}%)`;
    return `${name} ${formatter(value)} (${share.toFixed(1)}%)`;
  };

  if (!chart.length) {
    return <p className="py-12 text-center text-sm text-slate-500">No data to visualise.</p>;
  }

  return (
    <div style={{ height }} className="relative w-full">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={chart}
            dataKey="value"
            nameKey="name"
            cx="50%"
            cy="50%"
            outerRadius={outerRadius}
            innerRadius={radiusInner}
            paddingAngle={2}
            label={renderLabel}
            labelLine={{ stroke: "#475569", strokeWidth: 1 }}
            isAnimationActive={false}
          >
            {chart.map((entry, i) => (
              <Cell key={i} fill={entry.color || colorAt(i)} stroke="#040D1A" strokeWidth={2} />
            ))}
          </Pie>
          <Tooltip
            contentStyle={tip}
            formatter={(value, name, entry) => {
              const share = total ? (((Number(value) || 0) / total) * 100).toFixed(1) : "0";
              return [`${formatter(value)} (${share}%)`, name];
            }}
          />
          {showLegend && (
            <Legend
              wrapperStyle={{ fontSize: 11, color: "#94a3b8" }}
              formatter={(value, entry) => {
                const share = total ? (((entry?.payload?.value || 0) / total) * 100).toFixed(1) : "0";
                return (
                  <span style={{ color: "#94a3b8" }}>
                    {value} — {formatter(entry?.payload?.value || 0)} ({share}%)
                  </span>
                );
              }}
            />
          )}
        </PieChart>
      </ResponsiveContainer>
      {centerLabel && (
        <div className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 text-center">
          <p className="font-heading text-2xl font-semibold text-white">{centerLabel}</p>
          {centerSub && <p className="text-xs text-slate-500">{centerSub}</p>}
        </div>
      )}
    </div>
  );
}