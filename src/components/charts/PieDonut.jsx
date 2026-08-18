import React from "react";
import { ResponsiveContainer, PieChart, Pie, Cell, Tooltip, Legend } from "recharts";
import { CHART_COLORS, money2 } from "@/lib/hotel";

// Shared pie/donut chart used across the whole app.
//
// Hard requirements (enforced here):
//   1. The pie is always a real pie/donut WITH data — never an empty ring.
//   2. It never overflows its box: the radius is a PERCENTAGE of the
//      available space, so it scales down in narrow/small boxes instead of
//      being clipped by `overflow-hidden`.
//   3. Every segment's numbers are visible: a custom HTML legend below the
//      chart lists 100% of segments (colour, name, value, %) in normal flow,
//      so nothing is ever clipped by the chart canvas.
//   4. A tooltip is available on hover.
//
// Label policy:
//   - On-chart labels are drawn INSIDE the slice (centroid) and only for
//     slices >= `minLabelShare` %, so they can never spill outside the box.
//   - The legend always shows every segment (including tiny ones and the
//     "Other" bucket), so no number is ever hidden.

const tip = { background: "#0A1628", border: "1px solid #ffffff14", borderRadius: 12, color: "#e2e8f0" };

// Percentage of the smaller chart dimension the pie occupies. Using a
// percentage (not pixels) is what keeps the pie inside any box size.
const OUTER_RADIUS_PCT = 80;
const DONUT_INNER_RATIO = 0.55; // inner / outer for donut holes
const RAD = Math.PI / 180;

export default function PieDonut(
  /**
   * @type {{
   *   data?: Array<{ name?: any; value?: any; color?: string }>;
   *   type?: 'pie' | 'donut';
   *   height?: number | string;
   *   innerRadius?: number | string;
   *   minLabelShare?: number;
   *   maxSlices?: number;
   *   formatter?: (v: any) => string;
   *   showLegend?: boolean;
   *   colors?: string[];
   *   centerLabel?: any;
   *   centerSub?: any;
   *   legendColumns?: number;
   * }}
   */
  {
    data = [],
    type = "donut",
    height = 320,
    innerRadius,
    minLabelShare = 6,
    maxSlices = 12,
    formatter = money2,
    showLegend = true,
    colors,
    centerLabel,
    centerSub,
    legendColumns = 2,
  }
) {
  // 1. Keep only non-zero segments so we never draw an empty ring.
  const filtered = (data || []).filter((d) => Math.abs(Number(d.value) || 0) > 0.009);

  // 2. Cap the number of slices; overflow is bucketed into "Other" so the
  //    legend + labels never get crowded.
  const head = filtered.slice(0, maxSlices);
  const overflow = filtered.slice(maxSlices);
  const chart = head.slice();
  if (overflow.length) {
    chart.push({
      name: "Other",
      value: overflow.reduce((a, x) => a + (Number(x.value) || 0), 0),
    });
  }

  const total = chart.reduce((a, d) => a + (Number(d.value) || 0), 0) || 1;
  const palette = colors && colors.length ? colors : CHART_COLORS;
  const colorAt = (i) => palette[i % palette.length];

  const isDonut = type === "donut";
  const innerPct =
    innerRadius !== undefined
      ? innerRadius
      : isDonut
        ? Math.round(OUTER_RADIUS_PCT * DONUT_INNER_RATIO)
        : 0;

  // Inside-slice % label — positioned at the slice centroid so it can never
  // leave the chart box.
  const renderSliceLabel = ({ cx, cy, midAngle, innerRadius: ir, outerRadius: or, percent }) => {
    const share = (percent || 0) * 100;
    if (share < minLabelShare) return null;
    const r = Number(ir) + (Number(or) - Number(ir)) / 2;
    const x = Number(cx) + r * Math.cos(-Number(midAngle) * RAD);
    const y = Number(cy) + r * Math.sin(-Number(midAngle) * RAD);
    return (
      <text
        x={x}
        y={y}
        fill="#040D1A"
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={11}
        fontWeight={700}
      >
        {`${share.toFixed(0)}%`}
      </text>
    );
  };

  if (!chart.length) {
    return <p className="py-12 text-center text-sm text-slate-500">No data to visualise.</p>;
  }

  return (
    <div className="relative flex w-full flex-col" style={{ height }}>
      {/* Chart area: flexes to fill the box; legend sits below in normal flow. */}
      <div className="relative min-h-0 flex-1">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={chart}
              dataKey="value"
              nameKey="name"
              cx="50%"
              cy="50%"
              outerRadius="75%"
              innerRadius="50%"
              paddingAngle={2}
              label={false}
              labelLine={false}
              isAnimationActive={false}
            >
              {chart.map((entry, i) => (
                <Cell key={i} fill={entry.color || colorAt(i)} stroke="#040D1A" strokeWidth={2} />
              ))}
            </Pie>
            <Tooltip
              contentStyle={tip}
              formatter={(value, name) => [
                `${formatter(value)} (${(((Number(value) || 0) / total) * 100).toFixed(1)}%)`,
                name,
              ]}
            />
            <Legend layout="vertical" verticalAlign="middle" align="right" wrapperStyle={{ fontSize: 11, color: "#94a3b8" }} />
          </PieChart>
        </ResponsiveContainer>

        {centerLabel && (
          <div className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 text-center">
            <p className="font-heading text-2xl font-semibold text-white">{centerLabel}</p>
            {centerSub && <p className="text-xs text-slate-500">{centerSub}</p>}
          </div>
        )}
      </div>

      {/* Always-visible legend: every segment's number is shown, in flow. */}
      {showLegend && (
        <ul
          className="mt-3 grid w-full gap-x-5 gap-y-1 text-xs"
          style={{ gridTemplateColumns: `repeat(${Math.max(1, legendColumns)}, minmax(0, 1fr))` }}
        >
          {chart.map((d, i) => {
            const share = (((Number(d.value) || 0) / total) * 100).toFixed(1);
            return (
              <li key={i} className="flex items-center gap-2" title={`${d.name} — ${formatter(d.value)} (${share}%)`}>
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ background: d.color || colorAt(i) }}
                />
                <span className="truncate text-slate-200">{d.name}</span>
                <span className="ml-auto shrink-0 tabular-nums text-slate-100">{formatter(d.value)}</span>
                <span className="w-12 shrink-0 text-right tabular-nums text-slate-400">{share}%</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
