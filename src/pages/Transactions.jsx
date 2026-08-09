import React, { useMemo, useState } from "react";
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell,
} from "recharts";
import { DollarSign, Wallet, Receipt, Users2, TrendingUp } from "lucide-react";
import Card from "@/components/ui-exec/Card";
import KpiCard from "@/components/ui-exec/KpiCard";
import { useGlobalFilters } from "@/lib/useGlobalFilters";
import { useTransactions, useSources } from "@/lib/useHotelData";
import { money, money2, num, pct, C, CHART_COLORS, downloadCsv, inRange } from "@/lib/hotel";
import {
  summarize, seriesByGrain, revenueMix, paymentMix, employeeStats, monthlyBreakdown, GRAINS,
} from "@/lib/transactionAnalytics";
import LedgerStrip from "@/components/transactions/LedgerStrip";
import EmployeeCompare from "@/components/transactions/EmployeeCompare";
import CommissionsPanel from "@/components/transactions/CommissionsPanel";
import LedgerTable from "@/components/transactions/LedgerTable";

const tip = { background: "#0A1628", border: "1px solid #ffffff14", borderRadius: 12, color: "#e2e8f0" };
const axis = { fill: "#64748b", fontSize: 10 };

const TABS = [
  ["overview", "Overview"],
  ["employees", "People"],
  ["compare", "Head to head"],
  ["commissions", "Commissions"],
  ["ledger", "Ledger"],
];

function Segmented({ value, onChange, options }) {
  return (
    <div className="flex gap-1 rounded-lg bg-[#0A1628] p-1">
      {options.map(([key, label]) => (
        <button
          key={key}
          onClick={() => onChange(key)}
          className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
            value === key ? "bg-[#6C63FF] text-white" : "text-slate-400 hover:text-slate-200"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export default function Transactions() {
  const { dateRange, property, months } = useGlobalFilters();
  const [tab, setTab] = useState("overview");
  const [grain, setGrain] = useState("daily");
  const [includeSystem, setIncludeSystem] = useState(false);

  const { data: rows = [], isLoading } = useTransactions(dateRange, property, months);
  const { data: sources = [] } = useSources(dateRange, property, months);

  // Belt and braces: the query may be served from a cache built for a wider
  // range, so re-filter to exactly what the control bar is asking for.
  const scoped = useMemo(
    () => (dateRange?.from && dateRange?.to ? rows.filter((r) => inRange(r.date, dateRange.from, dateRange.to)) : rows),
    [rows, dateRange]
  );

  const stats = useMemo(() => summarize(scoped), [scoped]);
  const series = useMemo(() => seriesByGrain(scoped, grain), [scoped, grain]);
  const categories = useMemo(() => revenueMix(scoped, "charge_category"), [scoped]);
  const codes = useMemo(() => revenueMix(scoped, "transaction_code").slice(0, 8), [scoped]);
  const methods = useMemo(() => paymentMix(scoped), [scoped]);
  const months12 = useMemo(() => monthlyBreakdown(scoped), [scoped]);

  const people = useMemo(() => employeeStats(scoped, { includeSystem }), [scoped, includeSystem]);
  const humanRevenue = useMemo(
    () => employeeStats(scoped, { includeSystem: false }).reduce((a, e) => a + e.revenue, 0),
    [scoped]
  );
  const automatedRevenue = stats.revenue - humanRevenue;

  if (isLoading) return <p className="text-slate-500">Loading transaction ledger…</p>;

  if (!scoped.length) {
    return (
      <div className="space-y-6">
        <header>
          <p className="text-[11px] uppercase tracking-[0.3em] text-[#00D4FF]">Ledger Intelligence</p>
          <h1 className="mt-2 font-heading text-3xl font-semibold text-white">Transactions</h1>
        </header>
        <Card title="No transactions in this range">
          <p className="text-sm text-slate-400">
            Import an “All Transactions” export from Import Reports, then pick a date range that covers it.
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[11px] uppercase tracking-[0.3em] text-[#00D4FF]">Ledger Intelligence</p>
          <h1 className="mt-2 font-heading text-3xl font-semibold text-white">Transactions</h1>
          <p className="mt-1 text-sm text-slate-400">
            {dateRange.from || "—"} → {dateRange.to || "—"} · {num(scoped.length)} lines · {num(stats.days)} trading days
          </p>
        </div>
        <div className="flex flex-wrap gap-1 rounded-lg bg-[#0A1628] p-1">
          {TABS.map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
                tab === key ? "bg-[#6C63FF] text-white" : "text-slate-400 hover:text-slate-200"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </header>

      {tab === "overview" && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard label="Revenue" value={money(stats.revenue)} sub={`${money(stats.avgPerDay)} per trading day`} accent={C.purple} icon={DollarSign} />
            <KpiCard label="Settlements" value={money(stats.collected)} sub={`${num(stats.paymentCount)} payments taken`} accent={C.cyan} icon={Wallet} />
            <KpiCard label="Charges posted" value={num(stats.chargeCount)} sub={`${money2(stats.avgTicket)} average`} accent={C.green} icon={Receipt} />
            <KpiCard label="Folios touched" value={num(stats.folios)} sub={`${num(stats.guests)} reservations`} accent={C.amber} icon={Users2} />
          </div>

          <LedgerStrip
            revenue={stats.revenue}
            collected={stats.collected}
            methods={methods}
            chargeCount={stats.chargeCount}
            paymentCount={stats.paymentCount}
          />

          <Card
            title="Revenue over time"
            subtitle="Charge side, with settlements overlaid"
            right={<Segmented value={grain} onChange={setGrain} options={GRAINS} />}
          >
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={series} margin={{ left: -12, right: 8, top: 8 }}>
                  <defs>
                    <linearGradient id="txn-rev" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={C.purple} stopOpacity={0.6} />
                      <stop offset="100%" stopColor={C.purple} stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="txn-col" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={C.cyan} stopOpacity={0.35} />
                      <stop offset="100%" stopColor={C.cyan} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="#ffffff0a" vertical={false} />
                  <XAxis dataKey="name" tick={axis} stroke="#ffffff10" minTickGap={24} />
                  <YAxis tick={axis} stroke="#ffffff10" tickFormatter={(v) => `${Math.round(v / 1000)}k`} />
                  <Tooltip contentStyle={tip} formatter={(v, n) => [money(v), n === "revenue" ? "Revenue" : "Settled"]} />
                  <Area type="monotone" dataKey="revenue" stroke={C.purple} strokeWidth={2} fill="url(#txn-rev)" dot={false} />
                  <Area type="monotone" dataKey="collected" stroke={C.cyan} strokeWidth={2} fill="url(#txn-col)" dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="What guests were charged for" subtitle="Revenue by charge category">
              <div className="space-y-3">
                {categories.map((c, i) => {
                  const share = stats.revenue ? (c.value / stats.revenue) * 100 : 0;
                  return (
                    <div key={c.name}>
                      <div className="flex items-baseline justify-between">
                        <span className="text-sm text-slate-300">{c.name}</span>
                        <span className="text-sm tabular-nums text-white">{money(c.value)}</span>
                      </div>
                      <div className="mt-1.5 flex items-center gap-2">
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[#0A1628]">
                          <div
                            className="h-full rounded-full transition-all duration-500"
                            style={{ width: `${share}%`, background: CHART_COLORS[i % CHART_COLORS.length] }}
                          />
                        </div>
                        <span className="w-11 text-right text-xs tabular-nums text-slate-500">{share.toFixed(1)}%</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>

            <Card title="How guests paid" subtitle="Settlement volume by method">
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={methods} layout="vertical" margin={{ left: 8, right: 16, top: 8 }}>
                    <CartesianGrid stroke="#ffffff0a" horizontal={false} />
                    <XAxis type="number" tick={axis} stroke="#ffffff10" tickFormatter={(v) => `${Math.round(v / 1000)}k`} />
                    <YAxis type="category" dataKey="name" tick={axis} stroke="#ffffff10" width={92} />
                    <Tooltip contentStyle={tip} formatter={(v) => money(v)} cursor={{ fill: "#ffffff06" }} />
                    <Bar dataKey="value" radius={[0, 4, 4, 0]}>
                      {methods.map((_, i) => (
                        <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>
          </div>

          {months12.length > 1 && (
            <Card title="Month by month" subtitle="Every month in the selected range">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-sm">
                  <thead>
                    <tr className="border-b border-white/5 text-left">
                      <th className="pb-2 text-[11px] font-medium uppercase tracking-[0.14em] text-slate-500">Month</th>
                      <th className="pb-2 text-right text-[11px] font-medium uppercase tracking-[0.14em] text-slate-500">Revenue</th>
                      <th className="pb-2 text-right text-[11px] font-medium uppercase tracking-[0.14em] text-slate-500">Settled</th>
                      <th className="pb-2 text-right text-[11px] font-medium uppercase tracking-[0.14em] text-slate-500">Lines</th>
                      <th className="pb-2 text-right text-[11px] font-medium uppercase tracking-[0.14em] text-slate-500">Avg ticket</th>
                      <th className="pb-2 text-right text-[11px] font-medium uppercase tracking-[0.14em] text-slate-500">vs prior</th>
                    </tr>
                  </thead>
                  <tbody>
                    {months12.map((m, i) => {
                      const prior = i > 0 ? months12[i - 1].revenue : null;
                      const delta = prior ? ((m.revenue - prior) / prior) * 100 : null;
                      return (
                        <tr key={m.bucket} className="border-b border-white/5 last:border-0">
                          <td className="py-2.5 text-slate-300">{m.name}</td>
                          <td className="py-2.5 text-right font-medium tabular-nums text-white">{money(m.revenue)}</td>
                          <td className="py-2.5 text-right tabular-nums text-slate-400">{money(m.collected)}</td>
                          <td className="py-2.5 text-right tabular-nums text-slate-400">{num(m.txns)}</td>
                          <td className="py-2.5 text-right tabular-nums text-slate-400">{money2(m.avgTicket)}</td>
                          <td className="py-2.5 text-right tabular-nums" style={{ color: delta === null ? "#64748b" : delta >= 0 ? C.green : C.coral }}>
                            {delta === null ? "—" : `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%`}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </>
      )}

      {tab === "employees" && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard label="Written by people" value={money(humanRevenue)} sub={`${pct(stats.revenue ? humanRevenue / stats.revenue : 0)} of revenue`} accent={C.green} icon={Users2} />
            <KpiCard label="Written by automation" value={money(automatedRevenue)} sub={`${pct(stats.revenue ? automatedRevenue / stats.revenue : 0)} of revenue`} accent={C.amber} icon={TrendingUp} />
            <KpiCard label="Active accounts" value={num(people.length)} sub={includeSystem ? "Including automation" : "People only"} accent={C.purple} />
            <KpiCard label="Top producer" value={people[0] ? money(people[0].revenue) : "—"} sub={people[0]?.label || "—"} accent={C.cyan} />
          </div>

          <Card
            title="Who wrote the business"
            subtitle="Revenue posted per account over the selected period"
            right={
              <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-400">
                <input
                  type="checkbox"
                  checked={includeSystem}
                  onChange={(e) => setIncludeSystem(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-white/20 bg-[#0A1628] accent-[#6C63FF]"
                />
                Include automation
              </label>
            }
          >
            <div style={{ height: Math.max(240, Math.min(people.length, 15) * 30 + 40) }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={people.slice(0, 15)} layout="vertical" margin={{ left: 8, right: 24, top: 8 }}>
                  <CartesianGrid stroke="#ffffff0a" horizontal={false} />
                  <XAxis type="number" tick={axis} stroke="#ffffff10" tickFormatter={(v) => `${Math.round(v / 1000)}k`} />
                  <YAxis type="category" dataKey="label" tick={axis} stroke="#ffffff10" width={132} />
                  <Tooltip
                    contentStyle={tip}
                    cursor={{ fill: "#ffffff06" }}
                    formatter={(v) => [money(v), "Revenue"]}
                  />
                  <Bar dataKey="revenue" radius={[0, 4, 4, 0]}>
                    {people.slice(0, 15).map((p, i) => (
                      <Cell key={i} fill={p.account_class === "system" ? C.amber : CHART_COLORS[i % CHART_COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Card>

          <Card title="Detail" subtitle="Every account, ranked by revenue written">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="border-b border-white/5 text-left">
                    <th className="pb-2 text-[11px] font-medium uppercase tracking-[0.14em] text-slate-500">Account</th>
                    <th className="pb-2 text-right text-[11px] font-medium uppercase tracking-[0.14em] text-slate-500">Revenue</th>
                    <th className="pb-2 text-right text-[11px] font-medium uppercase tracking-[0.14em] text-slate-500">Settled</th>
                    <th className="pb-2 text-right text-[11px] font-medium uppercase tracking-[0.14em] text-slate-500">Charges</th>
                    <th className="pb-2 text-right text-[11px] font-medium uppercase tracking-[0.14em] text-slate-500">Avg ticket</th>
                    <th className="pb-2 text-right text-[11px] font-medium uppercase tracking-[0.14em] text-slate-500">Days</th>
                  </tr>
                </thead>
                <tbody>
                  {people.map((p) => (
                    <tr key={p.username} className="border-b border-white/5 last:border-0">
                      <td className="py-2.5">
                        <span className="text-slate-300">{p.label}</span>
                        {p.account_class === "system" && (
                          <span className="ml-2 rounded-full px-2 py-0.5 text-[10px]" style={{ background: `${C.amber}14`, color: C.amber }}>
                            automation
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 text-right font-medium tabular-nums text-white">{money(p.revenue)}</td>
                      <td className="py-2.5 text-right tabular-nums text-slate-400">{money(p.collected)}</td>
                      <td className="py-2.5 text-right tabular-nums text-slate-400">{num(p.chargeCount)}</td>
                      <td className="py-2.5 text-right tabular-nums text-slate-400">{money2(p.avgTicket)}</td>
                      <td className="py-2.5 text-right tabular-nums text-slate-400">{num(p.days)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}

      {tab === "compare" && <EmployeeCompare rows={scoped} grain="monthly" />}

      {tab === "commissions" && <CommissionsPanel rows={scoped} sourceRows={sources} dateRange={dateRange} />}

      {tab === "ledger" && (
        <>
          {codes.length > 0 && (
            <Card title="Top transaction codes" subtitle="Charge side, by revenue">
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={codes} margin={{ left: -12, right: 8, top: 8 }}>
                    <CartesianGrid stroke="#ffffff0a" vertical={false} />
                    <XAxis dataKey="name" tick={axis} stroke="#ffffff10" />
                    <YAxis tick={axis} stroke="#ffffff10" tickFormatter={(v) => `${Math.round(v / 1000)}k`} />
                    <Tooltip contentStyle={tip} formatter={(v) => money(v)} cursor={{ fill: "#ffffff06" }} />
                    <Bar dataKey="value" fill={C.purple} radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>
          )}
          <LedgerTable
            rows={scoped}
            onExport={(visible) =>
              downloadCsv(
                visible.map((r) => ({
                  date: r.date, time: r.time, guest: r.guest_name, room: r.room_number,
                  folio: r.folio_number, confirmation: r.confirmation_number,
                  code: r.transaction_code, description: r.transaction_description,
                  side: r.ledger_side, category: r.charge_category, method: r.payment_method,
                  amount: r.amount, posted_by: r.username,
                })),
                `transactions_${dateRange.from || "all"}_${dateRange.to || "all"}.csv`
              )
            }
          />
        </>
      )}
    </div>
  );
}
