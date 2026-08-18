import React from 'react';
import { PieChart, Pie, Cell, Legend, Tooltip, ResponsiveContainer } from 'recharts';

/**
 * ExecutiveFinancialPie
 * 
 * Professional financial dashboard pie chart.
 * Designed for boardroom presentation on large displays.
 * 
 * - Full-width, dark theme integration
 * - Large readable labels with proper spacing
 * - No label cutoff or overlap
 * - Executive-grade styling
 */

export function ExecutiveFinancialPie({ 
  data,           // Array: [{ name: string, value: number, color: string }]
  title,          // String: Chart title
  showLegend = true
}) {
  
  if (!data || data.length === 0) {
    return (
      <div className="w-full h-96 flex items-center justify-center bg-slate-900 rounded-lg border border-slate-700">
        <p className="text-slate-400">No data available</p>
      </div>
    );
  }

  // Format currency value
  const formatCurrency = (value) => {
    if (value >= 1000000) return `$${(value / 1000000).toFixed(1)}M`;
    if (value >= 1000) return `$${(value / 1000).toFixed(1)}k`;
    return `$${value.toFixed(0)}`;
  };

  // Format percentage
  const formatPercent = (value, total) => {
    const percent = ((value / total) * 100).toFixed(1);
    return `${percent}%`;
  };

  const total = data.reduce((sum, item) => sum + item.value, 0);

  return (
    <div className="w-full bg-slate-900 rounded-xl border border-slate-800 p-8">
      
      {/* TITLE */}
      <h2 className="text-2xl font-bold text-white mb-8">{title}</h2>

      {/* CHART CONTAINER - Full width */}
      <div className="w-full h-auto">
        <ResponsiveContainer width="100%" height={500}>
          <PieChart margin={{ top: 20, right: 200, bottom: 20, left: 20 }}>
            
            {/* Main pie */}
            <Pie
              data={data}
              cx="35%"                    // Center left (leave space for labels)
              cy="50%"
              labelLine={true}            // Enable leader lines
              label={({ name, value }) => {
                const percent = formatPercent(value, total);
                const formatted = formatCurrency(value);
                return `${name}: ${formatted} (${percent})`;
              }}
              outerRadius={130}           // Large pie
              dataKey="value"
              paddingAngle={2}            // Small gaps between slices
            >
              {data.map((entry, index) => (
                <Cell key={`cell-${index}`} fill={entry.color} />
              ))}
            </Pie>

            {/* TOOLTIP on hover */}
            <Tooltip
              contentStyle={{
                backgroundColor: '#1e293b',
                border: '1px solid #64748b',
                borderRadius: '8px',
                padding: '12px',
                color: '#f1f5f9'
              }}
              formatter={(value) => {
                const percent = formatPercent(value, total);
                return [`${formatCurrency(value)} (${percent})`, 'Amount'];
              }}
              labelStyle={{ color: '#f1f5f9' }}
            />

            {/* LEGEND */}
            {showLegend && (
              <Legend
                verticalAlign="bottom"
                height={36}
                wrapperStyle={{
                  paddingTop: '24px',
                  color: '#cbd5e1'
                }}
                iconType="circle"
              />
            )}

          </PieChart>
        </ResponsiveContainer>
      </div>

      {/* SUMMARY TABLE - Below chart */}
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
            {data.map((item, idx) => (
              <tr key={idx} className="border-b border-slate-800 hover:bg-slate-800/50 transition">
                <td className="py-3 px-4 text-white flex items-center gap-3">
                  <div 
                    className="w-3 h-3 rounded-full" 
                    style={{ backgroundColor: item.color }}
                  />
                  {item.name}
                </td>
                <td className="py-3 px-4 text-right text-white font-semibold">
                  {formatCurrency(item.value)}
                </td>
                <td className="py-3 px-4 text-right text-slate-300">
                  {formatPercent(item.value, total)}
                </td>
              </tr>
            ))}
            <tr className="bg-slate-800/50">
              <td className="py-3 px-4 text-white font-bold">TOTAL</td>
              <td className="py-3 px-4 text-right text-white font-bold">
                {formatCurrency(total)}
              </td>
              <td className="py-3 px-4 text-right text-white font-bold">100.0%</td>
            </tr>
          </tbody>
        </table>
      </div>

    </div>
  );
}
