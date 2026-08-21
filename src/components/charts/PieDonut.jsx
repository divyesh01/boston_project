import React from "react";
import { ResponsiveContainer, PieChart, Pie, Cell, Tooltip } from "recharts";
import { CHART_COLORS, money2 } from "@/lib/hotel";
import {
  computeSliceAngles,
  layoutDonutLabels,
  chooseLabelFontSizes,
  chooseOuterRadiusPct,
} from "@/lib/donutLabelLayout";

// Shared pie/donut chart used across the whole app.
//
// Hard requirements (enforced here):
//   1. The pie is always a real pie/donut WITH data — never an empty ring.
//   2. It never overflows its box: the radius is a PERCENTAGE of the
//      available space, so it scales down in narrow/small boxes instead of
//      being clipped. The percentage also shrinks to give the label columns
//      whatever width they need, so long names are never cut off.
//   3. EVERY slice is labelled outside the ring, connected by a leader line
//      that starts on the slice edge. Labels never cross to the opposite side
//      and NEVER overlap each other — see src/lib/donutLabelLayout.js for the
//      placement engine and why overlap is impossible.
//   4. A tooltip is available on hover; a legend below shows 100% of segments.

const tip = { background: "#0A1628", border: "1px solid #ffffff14", borderRadius: 12, color: "#e2e8f0" };

// The pie itself. cx/outerRadius are PERCENTAGES (never fixed pixels) so the
// donut always fits its box; the pie stays centred so BOTH label columns get
// equal room for their text.
const PIE_CX_PCT = "50%";
const PIE_MAX_OUTER_PCT = 46;
const PIE_MIN_OUTER_PCT = 26;
const PIE_PADDING = 2; // keep in sync with <Pie paddingAngle>

// The donut ring is BOLD: the hole is only 30% of the shorter side, and the
// ring never collapses below MIN_RING_PX even in a tiny box (computed from the
// measured chart size, falling back to the percentage while unmounted).
const DONUT_INNER_PCT = "30%";
const MIN_RING_PX = 16;

// Resolve the donut hole for a measured box. Returns "30%" while the ring stays
// at least MIN_RING_PX thick; otherwise returns the pixel inner radius that
// keeps the ring exactly at the floor. Never thinner than that, never negative.
/**
 * @param {number} width
 * @param {number} height
 * @param {number|string} [outerPct] Outer radius as a percent — "41%" or 41.
 * @returns {string|number}
 */
export function donutInnerFor(width, height, outerPct = PIE_MAX_OUTER_PCT) {
  const maxRadius = Math.min(Number(width) || 0, Number(height) || 0) / 2;
  if (!(maxRadius > 0)) return DONUT_INNER_PCT;
  const outerPx = (parseFloat(String(outerPct)) / 100) * maxRadius;
  const innerPx = (parseFloat(DONUT_INNER_PCT) / 100) * maxRadius;
  return innerPx <= outerPx - MIN_RING_PX ? DONUT_INNER_PCT : Math.max(0, outerPx - MIN_RING_PX);
}

// Trim a trailing ".00" ("$16,325.00" → "$16,325") but keep real cents.
const trimDot00 = (s) => (typeof s === "string" && s.endsWith(".00") ? s.slice(0, -3) : s);

// Measure the chart box ourselves (ResizeObserver) so the ring floor and the
// label typography can be sized from real pixels.
function useContainerSize() {
  const ref = React.useRef(null);
  const [size, setSize] = React.useState({ width: 0, height: 0 });
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const update = () => {
      const rect = el.getBoundingClientRect();
      setSize((s) => (s.width === rect.width && s.height === rect.height ? s : { width: rect.width, height: rect.height }));
    };
    update();
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(update);
      observer.observe(el);
      return () => observer.disconnect();
    }
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return { ref, width: size.width, height: size.height };
}

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
   *   startAngle?: number;
   *   endAngle?: number;
   * }}
   */
  {
    data = [],
    type = "donut",
    height = 320,
    innerRadius,
    minLabelShare = 0,
    maxSlices = 12,
    formatter = money2,
    showLegend = true,
    colors,
    centerLabel,
    centerSub,
    legendColumns = 2,
    startAngle = 0,
    endAngle = 360,
  }
) {
  // 1. Keep only segments that can actually be drawn as a wedge.
  //    A pie has no way to represent negative area: a negative value makes
  //    recharts sweep the sector backwards over its neighbours AND inflates
  //    every other slice's percentage (because it shrinks the total). Any
  //    caller can legitimately produce a negative — a payment method whose
  //    refunds exceed its charges, a channel with net-negative revenue — so
  //    the guard lives here, once, and reports what it had to leave out.
  const positive = (data || []).filter((d) => (Number(d.value) || 0) > 0.009);
  const negative = (data || []).filter((d) => (Number(d.value) || 0) < -0.009);
  const filtered = positive;

  // 2. Cap the number of slices; overflow is bucketed into "Other" so the
  //    labels never get crowded.
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

  // Full dollar amounts with cents, ".00" trimmed on clean whole dollars. Used
  // consistently in the labels, the legend, and the tooltip.
  const fmtMoney = (v) => trimDot00(formatter(v));

  const { ref: chartRef, width: boxWidth, height: boxHeight } = useContainerSize();

  // Slice geometry, mirroring recharts' own sector layout.
  const angles = computeSliceAngles(
    chart.map((d) => Number(d.value) || 0),
    { startAngle: Number(startAngle), endAngle: Number(endAngle), padAngle: PIE_PADDING }
  );

  // The slices that get an outside callout.
  const labelInput = chart
    .map((d, i) => {
      const share = ((Number(d.value) || 0) / total) * 100;
      return {
        name: String(d.name ?? ""),
        valueText: `${fmtMoney(Number(d.value) || 0)} (${share.toFixed(1)}%)`,
        mid: angles[i]?.mid ?? 0,
        share,
        color: d.color || colorAt(i),
        sliceIndex: i,
      };
    })
    .filter((r) => r.share >= minLabelShare);

  // Give the label columns the width they need by shrinking the ring, rather
  // than letting text run off the edge of the box.
  const measuredFonts = chooseLabelFontSizes(boxWidth, boxHeight);
  const outerPct = chooseOuterRadiusPct(labelInput, {
    width: boxWidth,
    height: boxHeight,
    nameSize: measuredFonts.nameSize,
    valueSize: measuredFonts.valueSize,
    maxPct: PIE_MAX_OUTER_PCT,
    minPct: PIE_MIN_OUTER_PCT,
  });

  // The donut hole is 30% of the box, clamped so the ring stays at least
  // MIN_RING_PX thick on small boxes (measured by the ResizeObserver hook).
  const measuredInner = isDonut ? donutInnerFor(boxWidth, boxHeight, outerPct) : 0;
  const inner = innerRadius !== undefined ? innerRadius : measuredInner;

  // Lay the labels out ONCE per geometry, cached by the exact inputs so this
  // stays a pure function of props (no render-phase mutation, StrictMode-safe).
  const planRef = React.useRef({ key: null, plan: null });
  const planFor = (cx, cy, outerRadius) => {
    // Before the ResizeObserver reports, derive the box from the pie's own
    // centre — recharts centres the pie, so cx*2 / cy*2 recover the SVG size.
    const width = boxWidth > 0 ? boxWidth : Number(cx) * 2;
    const planHeight = boxHeight > 0 ? boxHeight : Number(cy) * 2;
    const fonts = chooseLabelFontSizes(width, planHeight);
    const key = [
      cx, cy, outerRadius, width, planHeight, fonts.nameSize,
      labelInput.map((r) => `${r.name}:${r.valueText}:${r.mid.toFixed(3)}`).join("|"),
    ].join("~");
    if (planRef.current.key !== key) {
      planRef.current = {
        key,
        plan: layoutDonutLabels({
          slices: labelInput,
          cx: Number(cx),
          cy: Number(cy),
          outerRadius: Number(outerRadius),
          width,
          height: planHeight,
          nameSize: fonts.nameSize,
          valueSize: fonts.valueSize,
        }),
      };
    }
    return planRef.current.plan;
  };

  if (!chart.length) {
    return (
      <div className="py-12 text-center">
        <p className="text-sm text-slate-500">No data to visualise.</p>
        {negative.length > 0 && (
          <p className="mt-1 text-xs text-amber-300/80">
            Every value in this period is negative (net refunds), which a pie cannot show.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="relative flex w-full flex-col" style={{ height }}>
      {/* Chart area: flexes to fill the box; legend sits below in normal flow. */}
      <div ref={chartRef} className="relative min-h-0 flex-1 overflow-visible">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={chart}
                dataKey="value"
                nameKey="name"
                cx={PIE_CX_PCT}
                cy="50%"
                outerRadius={outerPct}
                innerRadius={inner}
                startAngle={startAngle}
                endAngle={endAngle}
                paddingAngle={PIE_PADDING}
                labelLine={false}
                isAnimationActive={false}
                label={(props) => {
                  const { cx, cy, outerRadius, percent, payload, index } = props;
                  const name = payload?.name ?? props.name;
                  if ((percent || 0) * 100 < minLabelShare) return null;

                  const plan = planFor(cx, cy, outerRadius);
                  // Match on the slice's index when recharts supplies it, so
                  // two slices sharing a name (e.g. "Other") never swap labels.
                  const row =
                    (typeof index === "number" && plan.labels.find((l) => l.sliceIndex === index)) ||
                    plan.labels.find((l) => l.name === name);
                  if (!row) return null; // dropped: slice keeps its tooltip + legend entry

                  const stroke = row.color || "#64748b";
                  return (
                    <g>
                      <polyline
                        points={row.points.map((p) => `${p.x},${p.y}`).join(" ")}
                        fill="none"
                        stroke={stroke}
                        strokeOpacity={0.55}
                        strokeWidth={1.25}
                        strokeLinejoin="round"
                      />
                      <circle cx={row.dotX} cy={row.dotY} r={3} fill={stroke} stroke="#040D1A" strokeWidth={1} />
                      <text
                        x={row.textX}
                        y={row.firstBaselineY}
                        textAnchor={row.textAnchor}
                        fontSize={plan.nameSize}
                        fill="#f1f5f9"
                        fontWeight={700}
                      >
                        {row.nameLines.map((line, li) => (
                          <tspan key={li} x={row.textX} dy={li === 0 ? 0 : row.lineH}>
                            {line}
                          </tspan>
                        ))}
                        <tspan
                          x={row.textX}
                          dy={row.valueLineH}
                          fontSize={plan.valueSize}
                          fill="#94a3b8"
                          fontWeight={600}
                        >
                          {row.valueText}
                        </tspan>
                      </text>
                    </g>
                  );
                }}
            >
              {chart.map((entry, i) => (
                <Cell key={i} fill={entry.color || colorAt(i)} stroke="#040D1A" strokeWidth={2} />
              ))}
            </Pie>
            <Tooltip
              contentStyle={tip}
              formatter={(value, name) => [
                `${fmtMoney(value)} (${(((Number(value) || 0) / total) * 100).toFixed(1)}%)`,
                name,
              ]}
            />
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
          className="mt-4 grid w-full gap-x-6 gap-y-2 text-base"
          style={{ gridTemplateColumns: `repeat(${Math.max(1, legendColumns)}, minmax(0, 1fr))` }}
        >
          {chart.map((d, i) => {
            const share = (((Number(d.value) || 0) / total) * 100).toFixed(1);
            return (
              <li key={i} className="flex items-center gap-2.5" title={`${d.name} — ${fmtMoney(d.value)} (${share}%)`}>
                <span
                  className="h-3.5 w-3.5 shrink-0 rounded-full"
                  style={{ background: d.color || colorAt(i) }}
                />
                <span className="truncate text-slate-200 font-medium">{d.name}</span>
                <span className="ml-auto shrink-0 tabular-nums text-white font-medium">{fmtMoney(d.value)}</span>
                <span className="w-16 shrink-0 text-right tabular-nums text-slate-400">{share}%</span>
              </li>
            );
          })}
        </ul>
      )}
      {/* Anything the ring could not represent is named explicitly rather than
          silently dropped, so the chart never disagrees with the table beside it. */}
      {negative.length > 0 && (
        <p className="mt-2 text-xs text-amber-300/80">
          Not shown in the ring (net negative for this period):{" "}
          {negative.map((d) => `${d.name} ${fmtMoney(Number(d.value) || 0)}`).join(", ")}
        </p>
      )}
    </div>
  );
}
