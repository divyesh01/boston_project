import React, { useMemo } from 'react';
import { PieChart, Pie, Cell, Legend, Tooltip, ResponsiveContainer } from 'recharts';

/**
 * ExecutiveLeaderLinePie
 *
 * Production-grade financial pie chart with custom SVG leader lines.
 * Designed for boardroom presentation on 65" displays.
 *
 * - Custom SVG leader lines (NOT recharts labelLine — it's broken)
 * - Lines start from EXACT pie boundary at segment midpoint angle
 * - Label collision detection prevents overlap
 * - Full dark theme integration
 * - Summary table below chart
 */

export function ExecutiveLeaderLinePie({
  data,           // [{ name, value, color }]
  title,
  showLegend = true
}) {

  const CANVAS_WIDTH = 1000;
  const CANVAS_HEIGHT = 600;
  const PIE_CX = 300;
  const PIE_CY = 300;
  const PIE_RADIUS = 120;
  const LABEL_DISTANCE = 280;
  const MIN_LABEL_SPACING = 50;
  const FONT_SIZE = 13;
  const LINE_COLOR = '#94a3b8';
  const LINE_WIDTH = 2;

  /** Format currency value */
  const formatCurrency = (val) => {
    const v = Number(val);
    if (v >= 1000000) return `$${(v / 1000000).toFixed(1)}M`;
    if (v >= 1000) return `$${(v / 1000).toFixed(1)}k`;
    return `$${v.toFixed(0)}`;
  };

  // Calculate angles and positions for every segment
  const safeData = data || [];
  const calculations = useMemo(() => {
    if (safeData.length === 0) return [];
    const totalValue = safeData.reduce((sum, item) => sum + item.value, 0);
    let currentAngle = 0;
    const items = [];

    safeData.forEach((segment) => {
      const percent = segment.value / totalValue;
      const radianSize = percent * 2 * Math.PI;

      const midAngle = currentAngle + radianSize / 2;

      // Recharts draws pies starting from 90° (12 o'clock), going clockwise.
      // SVG: 0° = 3 o'clock, angles go clockwise when +Y is down.
      // Recharts startAngle default is 90° (top), endAngle default is -270°.
      // So we offset by -PI/2 to align with recharts' 12-o'clock start.
      const svgAngle = midAngle - Math.PI / 2;

      // Line start: on pie boundary at exact segment midpoint
      const lineStartX = PIE_CX + PIE_RADIUS * Math.cos(svgAngle);
      const lineStartY = PIE_CY + PIE_RADIUS * Math.sin(svgAngle);

      // Determine which side the label goes (left or right of pie)
      const cosAngle = Math.cos(svgAngle);
      const isRight = cosAngle >= 0;

      // Initial label Y position: project outward from pie center
      const rawLabelY = PIE_CY + (PIE_RADIUS + 60) * Math.sin(svgAngle);

      // Label X: far to the side
      const labelX = isRight ? PIE_CX + LABEL_DISTANCE : PIE_CX - LABEL_DISTANCE;

      // Elbow point: intermediate point for 3-segment line
      const elbowX = isRight ? PIE_CX + PIE_RADIUS + 30 : PIE_CX - PIE_RADIUS - 30;

      items.push({
        segment,
        midAngle,
        svgAngle,
        lineStartX,
        lineStartY,
        elbowX,
        labelX,
        labelY: rawLabelY,
        isRight,
        percent: (percent * 100).toFixed(1)
      });

      currentAngle += radianSize;
    });

    // Split into left and right hemispheres for collision detection
    const rightItems = items.filter(i => i.isRight).sort((a, b) => a.labelY - b.labelY);
    const leftItems = items.filter(i => !i.isRight).sort((a, b) => a.labelY - b.labelY);

    // Collision resolution for each hemisphere
    const resolveCollisions = (group) => {
      for (let i = 0; i < group.length - 1; i++) {
        const current = group[i];
        const next = group[i + 1];
        if (next.labelY - current.labelY < MIN_LABEL_SPACING) {
          next.labelY = current.labelY + MIN_LABEL_SPACING;
        }
      }

      // Boundary check: push everything up if labels go below canvas
      if (group.length > 0) {
        const last = group[group.length - 1];
        if (last.labelY > CANVAS_HEIGHT - 40) {
          const overflow = last.labelY - (CANVAS_HEIGHT - 40);
          group.forEach(item => { item.labelY -= overflow; });
        }
        // Push down if labels go above canvas
        const first = group[0];
        if (first.labelY < 40) {
          const underflow = 40 - first.labelY;
          group.forEach(item => { item.labelY += underflow; });
        }
      }
    };

    resolveCollisions(rightItems);
    resolveCollisions(leftItems);

    return [...rightItems, ...leftItems];
  }, [safeData]);

  if (safeData.length === 0) {
    return (
      <div className="w-full h-96 flex items-center justify-center bg-slate-900 rounded-lg border border-slate-700">
        <p className="text-slate-400">No data available</p>
      </div>
    );
  }

  return (
    <div className="w-full bg-slate-900 rounded-xl border border-slate-800 p-8">

      <h2 className="text-2xl font-bold text-white mb-8">{title}</h2>

      <div className="relative w-full" style={{ height: CANVAS_HEIGHT }}>

        {/* 1. Pie Chart from recharts — NO labels, NO labelLine */}
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={safeData}
              cx="30%"
              cy="50%"
              outerRadius={PIE_RADIUS}
              labelLine={false}
              label={false}
              dataKey="value"
              paddingAngle={2}
            >
              {safeData.map((entry, idx) => (
                <Cell key={`cell-${idx}`} fill={entry.color} />
              ))}
            </Pie>
            <Tooltip
              formatter={(value) => formatCurrency(value)}
              contentStyle={{
                backgroundColor: '#1e293b',
                border: '1px solid #64748b',
                borderRadius: '8px',
                padding: '12px',
                color: '#f1f5f9'
              }}
              labelStyle={{ color: '#f1f5f9' }}
            />
            {showLegend && (
              <Legend
                verticalAlign="bottom"
                height={36}
                wrapperStyle={{ color: '#cbd5e1' }}
                iconType="circle"
              />
            )}
          </PieChart>
        </ResponsiveContainer>

        {/* 2. Custom SVG Leader Lines Layer — replaces broken recharts labelLine */}
        <svg
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            pointerEvents: 'none'
          }}
          viewBox={`0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}`}
          preserveAspectRatio="xMidYMid meet"
        >
          {calculations.map((item, idx) => {
            // Build a 3-point elbow path: pie edge → elbow → label
            const pathD = `M ${item.lineStartX.toFixed(1)},${item.lineStartY.toFixed(1)} L ${item.elbowX.toFixed(1)},${item.labelY.toFixed(1)} L ${item.labelX.toFixed(1)},${item.labelY.toFixed(1)}`;

            return (
              <g key={`leader-${idx}`}>
                {/* 3-point elbow leader line */}
                <path
                  d={pathD}
                  stroke={LINE_COLOR}
                  strokeWidth={LINE_WIDTH}
                  strokeDasharray="4,4"
                  fill="none"
                  opacity="0.8"
                />

                {/* Small dot at pie edge (connection point) */}
                <circle
                  cx={item.lineStartX}
                  cy={item.lineStartY}
                  r={3}
                  fill={item.segment.color}
                />

                {/* Label text */}
                <text
                  x={item.isRight ? item.labelX + 12 : item.labelX - 12}
                  y={item.labelY + FONT_SIZE * 0.35}
                  fill="#f1f5f9"
                  fontSize={FONT_SIZE}
                  fontFamily="system-ui, -apple-system, sans-serif"
                  fontWeight="600"
                  textAnchor={item.isRight ? 'start' : 'end'}
                >
                  {item.segment.name}
                </text>
                <text
                  x={item.isRight ? item.labelX + 12 : item.labelX - 12}
                  y={item.labelY + FONT_SIZE * 0.35 + 18}
                  fill="#38bdf8"
                  fontSize={12}
                  fontFamily="system-ui, -apple-system, sans-serif"
                  fontWeight="600"
                  textAnchor={item.isRight ? 'start' : 'end'}
                >
                  {formatCurrency(item.segment.value)} ({item.percent}%)
                </text>
              </g>
            );
          })}
        </svg>

      </div>

      {/* Summary Table */}
      <div className="mt-8 pt-8 border-t border-slate-700">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-700">
              <th className="text-left py-3 px-4 text-slate-300 font-semibold">Category</th>
              <th className="text-right py-3 px-4 text-slate-300 font-semibold">Amount</th>
              <th className="text-right py-3 px-4 text-slate-300 font-semibold">Percentage</th>
            </tr>
          </thead>
          <tbody>
            {safeData.map((item, idx) => {
              const total = safeData.reduce((sum, d) => sum + d.value, 0);
              const percent = ((item.value / total) * 100).toFixed(1);
              return (
                <tr key={idx} className="border-b border-slate-800 hover:bg-slate-800/50 transition">
                  <td className="py-3 px-4 text-white flex items-center gap-3">
                    <div
                      className="w-3 h-3 rounded-full shrink-0"
                      style={{ backgroundColor: item.color }}
                    />
                    {item.name}
                  </td>
                  <td className="py-3 px-4 text-right text-white font-semibold">
                    {formatCurrency(item.value)}
                  </td>
                  <td className="py-3 px-4 text-right text-slate-300">{percent}%</td>
                </tr>
              );
            })}
            <tr className="bg-slate-800/50">
              <td className="py-3 px-4 text-white font-bold">TOTAL</td>
              <td className="py-3 px-4 text-right text-white font-bold">
                {formatCurrency(safeData.reduce((s, d) => s + d.value, 0))}
              </td>
              <td className="py-3 px-4 text-right text-white font-bold">100.0%</td>
            </tr>
          </tbody>
        </table>
      </div>

    </div>
  );
}
