import React from "react";

// Dependency-free SVG sparkline.
//
// Deliberately NOT recharts. A KPI grid renders up to 55 of these (KpiCard has
// 55 call sites across 13 files) and recharts mounts a ResponsiveContainer plus
// a resize observer per chart; at that count it is a measurable amount of work
// for a 60px trend line. This is one <path>.
//
// It is aria-hidden by design: the trend is already stated in text by the delta
// Badge beside it, so announcing the shape again is noise for a screen-reader
// user. The line is decoration reinforcing a fact that is written down.

const VB_W = 100;
const VB_H = 32;
const PAD = 3; // keeps the stroke off the viewBox edge so it can't be clipped

export default function Sparkline(
  /** @type {{
   *   data?: Array<number>;
   *   color?: string;
   *   fill?: boolean;
   *   className?: string;
   *   strokeWidth?: number;
   * }} */
  { data = [], color = "var(--brand)", fill = true, className = "", strokeWidth = 1.75 }
) {
  const gradientId = React.useId();

  // Hostile input: a metric series can arrive with nulls from a partial import
  // or NaN from a divide-by-zero rate. Drop them rather than emitting "NaN"
  // into the path data, which silently renders nothing at all.
  const points = React.useMemo(
    () => (Array.isArray(data) ? data.map(Number).filter(Number.isFinite) : []),
    [data]
  );

  if (points.length === 0) return null;

  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min;

  const innerW = VB_W - PAD * 2;
  const innerH = VB_H - PAD * 2;

  // range === 0 is the flat-series case (every value identical, common for a
  // metric that hasn't moved). Dividing by it would give NaN, so pin to the
  // vertical middle and draw a true flat line — which is the honest picture.
  const y = (v) => (range === 0 ? PAD + innerH / 2 : PAD + innerH - ((v - min) / range) * innerH);
  const x = (i) => (points.length === 1 ? PAD + innerW / 2 : PAD + (i / (points.length - 1)) * innerW);

  const coords = points.map((v, i) => [x(i), y(v)]);
  const line = coords.map(([cx, cy], i) => `${i === 0 ? "M" : "L"}${cx.toFixed(2)},${cy.toFixed(2)}`).join(" ");
  // A single point has no line to draw, so give it a 1px horizontal nub.
  const linePath = coords.length === 1 ? `${line} L${(coords[0][0] + 0.01).toFixed(2)},${coords[0][1].toFixed(2)}` : line;
  const areaPath = `${linePath} L${(VB_W - PAD).toFixed(2)},${VB_H} L${PAD},${VB_H} Z`;

  return (
    <svg
      viewBox={`0 0 ${VB_W} ${VB_H}`}
      // `none` lets the line stretch to any card width. The stroke would
      // distort with it — thick verticals, thin horizontals — so every stroked
      // element below opts out via vector-effect.
      preserveAspectRatio="none"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {fill && (
        <>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.22" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={areaPath} fill={`url(#${gradientId})`} stroke="none" />
        </>
      )}
      <path
        d={linePath}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
      {/* Terminal dot marks "you are here" — the most recent value. */}
      <circle
        cx={coords[coords.length - 1][0]}
        cy={coords[coords.length - 1][1]}
        r={1.9}
        fill={color}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
