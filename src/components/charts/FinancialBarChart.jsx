import React from 'react';

/**
 * FinancialBarChart
 *
 * Horizontal bar chart for financial data visualization.
 * Designed for boardroom presentation.
 *
 * - All data visible at once
 * - Large readable labels
 * - No overlaps
 * - Professional appearance
 */

export function FinancialBarChart({
  data,
  title,
  totalLabel = 'TOTAL'
}) {

  if (!data || data.length === 0) {
    return <div className="text-slate-400">No data available</div>;
  }

  const total = data.reduce((sum, item) => sum + item.value, 0);

  const formatCurrency = (value) => {
    if (value >= 1000000) return `$${(value / 1000000).toFixed(1)}M`;
    if (value >= 1000) return `$${(value / 1000).toFixed(1)}k`;
    return `$${value.toFixed(0)}`;
  };

  const dataWithPercent = data.map(item => ({
    ...item,
    percent: ((item.value / total) * 100).toFixed(1)
  }));

  return (
    <div className="w-full bg-slate-900 rounded-xl border border-slate-800 p-8">

      {/* TITLE */}
      <h2 className="text-3xl font-bold text-white mb-2">{title}</h2>
      <p className="text-slate-400 text-sm mb-8">
        Total: {formatCurrency(total)} | Period: 2026-01-01 to 2026-08-02
      </p>

      {/* CHART */}
      <div className="w-full space-y-6">

        {/* Each category as a horizontal bar */}
        {dataWithPercent.map((item, idx) => (
          <div key={idx} className="w-full">

            {/* Label + Value Row */}
            <div className="flex justify-between items-center mb-2">
              <span className="text-white font-semibold text-lg">{item.name}</span>
              <span className="text-slate-300 text-lg font-bold">
                {formatCurrency(item.value)} ({item.percent}%)
              </span>
            </div>

            {/* Bar */}
            <div className="w-full bg-slate-800 rounded h-12 overflow-hidden">
              <div
                className="h-full flex items-center px-4 transition-all duration-300"
                style={{
                  width: `${item.percent}%`,
                  backgroundColor: item.color
                }}
              >
                <span className="text-white font-bold text-sm">
                  {item.percent}%
                </span>
              </div>
            </div>

          </div>
        ))}

      </div>

      {/* TOTAL ROW */}
      <div className="mt-10 pt-6 border-t border-slate-700">
        <div className="flex justify-between items-center">
          <span className="text-white font-bold text-xl">{totalLabel}</span>
          <span className="text-white font-bold text-xl">
            {formatCurrency(total)}
          </span>
        </div>
      </div>

      {/* DATA TABLE */}
      <div className="mt-8 pt-8 border-t border-slate-700">
        <h3 className="text-white font-semibold text-lg mb-4">Detailed Breakdown</h3>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-700">
              <th className="text-left py-3 px-4 text-slate-300 font-semibold">Category</th>
              <th className="text-right py-3 px-4 text-slate-300 font-semibold">Amount</th>
              <th className="text-right py-3 px-4 text-slate-300 font-semibold">Percentage</th>
              <th className="text-right py-3 px-4 text-slate-300 font-semibold">Status</th>
            </tr>
          </thead>
          <tbody>
            {data.map((item, idx) => {
              const percent = ((item.value / total) * 100).toFixed(1);
              const status = item.value > 0 ? '↑ Expense' : '↓ Gain';
              return (
                <tr key={idx} className="border-b border-slate-800 hover:bg-slate-800/50">
                  <td className="py-3 px-4 text-white flex items-center gap-3">
                    <div
                      className="w-4 h-4 rounded"
                      style={{ backgroundColor: item.color }}
                    />
                    {item.name}
                  </td>
                  <td className="py-3 px-4 text-right text-white font-semibold">
                    {formatCurrency(item.value)}
                  </td>
                  <td className="py-3 px-4 text-right text-slate-300">
                    {percent}%
                  </td>
                  <td className="py-3 px-4 text-right text-slate-400 text-xs">
                    {status}
                  </td>
                </tr>
              );
            })}
            <tr className="bg-slate-800/50 font-bold">
              <td className="py-3 px-4 text-white">TOTAL</td>
              <td className="py-3 px-4 text-right text-white">
                {formatCurrency(total)}
              </td>
              <td className="py-3 px-4 text-right text-white">100.0%</td>
              <td className="py-3 px-4 text-right"></td>
            </tr>
          </tbody>
        </table>
      </div>

    </div>
  );
}
