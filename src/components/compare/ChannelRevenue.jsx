import React, { useMemo, useRef } from "react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from "recharts";
import Card from "@/components/ui-exec/Card";
import ChartToolbar from "@/components/charts/ChartToolbar";
import UniversalChart from "@/components/charts/UniversalChart";
import { commissionFor, money, num, pct, C, CHART_COLORS } from "@/lib/hotel";
import { useSettingsVersion } from "@/hooks/useSettingsVersion";

export default function ChannelRevenue({ rows, dateRange }) {
  const settingsVersion = useSettingsVersion();
  const chartRef = useRef(null);

  const channels = useMemo(() => {
    const map = new Map();
    rows.forEach((r) => {
      const src = r.source || "Unknown";
      const net = Number(r.net_revenue || 0);
      const stays = Number(r.stays || 0);
      const info = commissionFor(src);
      let gross = 0;
      if (info.type === "percentage" && info.rate > 0) gross = net / (1 - info.rate);
      else if (info.type === "fixed") gross = net + info.rate * stays;
      else gross = net;
      const commission = gross - net;
      const cur = map.get(src) || { source: src, gross: 0, net: 0, stays: 0, commission: 0, adr: 0 };
      cur.gross += gross;
      cur.net += net;
      cur.stays += stays;
      cur.commission += commission;
      cur.adr += Number(r.adr || 0);
      map.set(src, cur);
    });
    return [...map.values()].sort((a, b) => b.net - a.net);
  }, [rows, settingsVersion]);

  const totalGross = channels.reduce((a, c) => a + c.gross, 0);
  const totalNet = channels.reduce((a, c) => a + c.net, 0);
  const totalCommission = channels.reduce((a, c) => a + c.commission, 0);

  const chartData = channels.slice(0, 10).map((c, i) => ({
    name: c.source,
    value: Math.round(c.net),
  }));

  if (!channels.length) {
    return (
      <Card title="Revenue by Channel" subtitle="No source data available for the selected period">
        <p className="text-sm text-slate-500">Import Source Summary reports to see channel profitability.</p>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-2xl border border-white/5 bg-[#0F1F35]/80 p-5">
          <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-slate-400">Gross Revenue</p>
          <p className="mt-3 font-heading text-3xl font-semibold text-white">{money(totalGross)}</p>
        </div>
        <div className="rounded-2xl border border-white/5 bg-[#0F1F35]/80 p-5">
          <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-slate-400">Total Commission</p>
          <p className="mt-3 font-heading text-3xl font-semibold text-[#FFB547]">{money(totalCommission)}</p>
        </div>
        <div className="rounded-2xl border border-white/5 bg-[#0F1F35]/80 p-5">
          <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-slate-400">Net Profitability</p>
          <p className="mt-3 font-heading text-3xl font-semibold text-[#00E096]">{money(totalNet)}</p>
        </div>
      </div>

      <Card
        title="Channel net revenue distribution"
        subtitle={dateRange}
        right={<ChartToolbar targetRef={chartRef} title="Channel Revenue" dateRange={dateRange} />}
      >
        <div ref={chartRef}>
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 40 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#ffffff10" vertical={false} />
                <XAxis
                  dataKey="name"
                  tick={{ fill: "#64748b", fontSize: 11 }}
                  angle={-35}
                  textAnchor="end"
                  interval={0}
                  height={60}
                />
                <YAxis
                  tick={{ fill: "#64748b", fontSize: 11 }}
                  tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`}
                />
                <Tooltip
                  cursor={{ fill: "#ffffff08" }}
                  contentStyle={{ background: "#0A1628", border: "1px solid #ffffff14", borderRadius: 12, color: "#e2e8f0" }}
                  formatter={(v) => [money(v), "Net Revenue"]}
                />
                <Bar dataKey="value" radius={[6, 6, 0, 0]}>
                  {chartData.map((_, i) => (
                    <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-4 h-64">
            <UniversalChart type="donut" data={chartData} />
          </div>
        </div>
      </Card>

      <Card title="Revenue & profitability by channel" subtitle="Ranked by highest net profitability">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10 text-xs text-slate-500">
                <th className="pb-3 text-left">Channel</th>
                <th className="pb-3 text-right">Gross Rev</th>
                <th className="pb-3 text-right">Stays</th>
                <th className="pb-3 text-right">Commission</th>
                <th className="pb-3 text-right">Net Rev</th>
                <th className="pb-3 text-right">% Rev</th>
                <th className="pb-3 text-right">Margin</th>
              </tr>
            </thead>
            <tbody>
              {channels.map((c, i) => {
                const revPct = totalNet ? c.net / totalNet : 0;
                const marginPct = c.gross > 0 ? c.net / c.gross : 0;
                return (
                  <tr key={c.source} className="border-b border-white/5">
                    <td className="py-3">
                      <span className="text-white">{i + 1}. </span>
                      <span className="text-slate-200">{c.source}</span>
                    </td>
                    <td className="py-3 text-right tabular-nums text-slate-300">{money(c.gross)}</td>
                    <td className="py-3 text-right tabular-nums text-slate-400">{num(c.stays)}</td>
                    <td className="py-3 text-right tabular-nums text-[#FFB547]">{money(c.commission)}</td>
                    <td className="py-3 text-right tabular-nums text-[#00E096]">{money(c.net)}</td>
                    <td className="py-3 text-right tabular-nums text-slate-400">{pct(revPct)}</td>
                    <td className="py-3 text-right">
                      <span
                        className="rounded-full px-2 py-0.5 text-xs font-medium"
                        style={{ background: marginPct >= 0.85 ? "rgba(0,224,150,0.12)" : "rgba(255,181,71,0.12)", color: marginPct >= 0.85 ? C.green : C.amber }}
                      >
                        {pct(marginPct, 0)}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-white/10 bg-[#0A1628]/80">
                <td className="py-3 font-semibold text-white">TOTAL ({channels.length} channels)</td>
                <td className="py-3 text-right font-heading text-base font-semibold text-slate-300">{money(totalGross)}</td>
                <td className="py-3 text-right tabular-nums text-slate-400">{channels.reduce((a, c) => a + c.stays, 0)}</td>
                <td className="py-3 text-right font-heading text-base font-semibold text-[#FFB547]">{money(totalCommission)}</td>
                <td className="py-3 text-right font-heading text-base font-semibold text-[#00E096]">{money(totalNet)}</td>
                <td className="py-3 text-right tabular-nums text-slate-400">100.0%</td>
                <td className="py-3 text-right text-xs text-slate-500">—</td>
              </tr>
            </tfoot>
          </table>
        </div>
        <p className="mt-4 text-xs text-slate-500">
          Net profitability = Gross revenue − commissions − channel fees. Walk-ins and direct bookings use zero commission unless configured in Settings.
        </p>
      </Card>
    </div>
  );
}