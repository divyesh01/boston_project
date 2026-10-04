import React, { useMemo, useState } from "react";
import {
  ResponsiveContainer, Cell, Tooltip,
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  AreaChart, Area, Line,
} from "recharts";
import PieDonut from '@/components/charts/PieDonut';
import { X, Wallet } from "lucide-react";
import Card from "@/components/ui-exec/Card";
import { usePaymentData, useProperties } from "@/lib/useHotelData";
import TaxCalculationBreakdown from "@/components/dashboard/TaxCalculationBreakdown";
import { useGlobalFilters } from "@/lib/useGlobalFilters";
import { money, money2, pct, C, CHART_COLORS } from "@/lib/hotel";
import { fromCents, toCents } from "@/lib/decimal";
import { getCcFeeRate, getCcFeeOnRefunds } from "@/lib/commissionRates";
import { useSettingsVersion } from "@/hooks/useSettingsVersion";
import { CountUp } from "@/lib/useCountUp";
import { projectRecurringExpenses, buildMoneyKeptBaseData, buildMoneyKeptPresentation } from "@/lib/moneyKeptModel";

const tip = { background: "#0A1628", border: "1px solid #ffffff14", borderRadius: 12, color: "#e2e8f0" };
const axis = { fill: "#64748b", fontSize: 10 };


const TREND_MODES = [
  ["day", "Day"],
  ["week", "Week"],
  ["month", "Month"],
  ["year", "Year"],
];

export default function MoneyKept({ occRows, srcRows, grossRows, dateRange, property, aggPayRows, aggExpenses, expenses = [], payroll = [] }) {
  const ccFee = getCcFeeRate();
  const ccFeeRefunds = getCcFeeOnRefunds();
  const settingsVersion = useSettingsVersion();
  const { data: properties = [] } = useProperties();
  const [active, setActive] = useState(null);
  const [trendMode, setTrendMode] = useState("week");

  const { months } = useGlobalFilters();
  const { data: payRecords = [] } = usePaymentData(dateRange, property, months);

  const from = dateRange?.from || "";
  const to = dateRange?.to || "";

  // 1. Heavy computation: recurring expense projection lives in the pure model.
  const recurringExtras = useMemo(
    () => projectRecurringExpenses({ expenses, from, to }),
    [expenses, from, to],
  );

  // 2. Base calculations live outside React so the financial model can be
  // verified without rendering and cannot drift into a second UI-only copy.
  const baseData = useMemo(
    () => buildMoneyKeptBaseData({
      occRows, srcRows, grossRows, payRecords, expenses, payroll,
      from, to, aggPayRows, aggExpenses, recurringExtras,
    }),
    [occRows, srcRows, grossRows, payRecords, expenses, payroll, from, to, property, ccFee, ccFeeRefunds, settingsVersion, aggPayRows, aggExpenses, recurringExtras, properties],
  );

  // 3. Final chart/trend view model.
  const data = useMemo(
    () => buildMoneyKeptPresentation(baseData, trendMode),
    [baseData, trendMode],
  );

  const {
    gross, grossBasis, items, totalDeductions, kept, pieData, barData, trendData, tax,
    refundsTotal, passThrough, colorByKey, pieIsGrossShare, isTaxIncomplete, isPartial,
  } = data;
  const partial = Boolean(isTaxIncomplete || isPartial || tax?.incomplete);
  // Keep rate = money kept against the *net-revenue base*, not raw gross.
  // Refunds (returned to guest) and pass-through taxes (collected on behalf of
  // the government, never the owner's to keep) are removed from the denominator
  // so the percentage reflects true net-revenue efficiency rather than an
  // artificially inflated share of uncollected gross.
  // Integer cents for the same reason as `kept` above: this is the denominator
  // of the displayed keep rate, so a residue here moves a percentage the owner
  // reads against a target.
  const netRevenueBase = fromCents(toCents(gross) - toCents(refundsTotal));
  const keepRate = netRevenueBase > 0 ? kept / netRevenueBase : (gross > 0 ? kept / gross : 0);
  const periodLabel = `${from || "—"} → ${to || "—"}`;
  const taxTotal = fromCents(toCents(tax.state) + toCents(tax.city) + toCents(tax.other));

  // Say which ledger the gross came from. A room-only figure and a total-revenue
  // figure differ by every ancillary charge the hotel posted, so labelling both
  // "Imported occupancy revenue" (as this card used to) told the operator the
  // wrong thing in one of the two cases. Rendered with cents because this is the
  // number that must reconcile against the night-audit export exactly.
  const grossIsRoomOnly = grossBasis?.basis === "room";
  const grossTitle = grossIsRoomOnly ? "Room Revenue" : "Total Revenue";
  const grossSource = grossIsRoomOnly
    ? "Imported occupancy revenue (room only — no gross revenue report for this period)"
    : "Imported gross revenue report · room + ancillary charges";

  const open = (label, rows) => setActive({ label, rows: rows || [] });

  const TaxRow = ({ label, amount, records, color, rate }) => (
    <button
      onClick={() => open(label, records)}
      className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-3 text-left transition-colors hover:bg-white/[0.04] focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-400"
    >
      <span className="flex items-center gap-2 text-sm text-slate-300">
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
        {label}
        {Number.isFinite(rate) && <span className="text-xs text-slate-400">({pct(rate,2)} estimated)</span>}
      </span>
      <span className="text-sm tabular-nums text-slate-200">{money2(amount)}</span>
    </button>
  );

  return (
    <div className="space-y-6">
      {/* ── Main KPI hero ── */}
      <div className="relative overflow-hidden rounded-2xl border border-[#00E096]/20 bg-gradient-to-br from-[#00E096]/[0.10] via-[#0F1F35]/90 to-[#0F1F35]/90 p-6">
        <div className="absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-transparent via-[#00E096] to-transparent" />
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-[11px] uppercase tracking-[0.3em] text-[#00D4FF]">Money in My Pocket</p>
            <div className="flex items-center gap-2">
              <h2 className="mt-1 font-heading text-xl font-semibold text-white">Estimated Money Kept</h2>
              {partial && (
                <span className="mt-1 inline-flex items-center rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-300">
                  Partial Estimate
                </span>
              )}
            </div>
            <p className="mt-1 text-xs text-slate-400">
              {partial
                ? "Provisional take-home: tax calculations are incomplete (missing rates or room nights)"
                : "Net profit after commissions, card fees, expenses & refunds"}
            </p>
          </div>
          <Wallet className="h-6 w-6 text-[#00E096]" />
        </div>
        <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <div className="sm:col-span-2">
            <div className="flex items-center gap-2">
              <p className="text-[10px] uppercase tracking-widest text-slate-500" title="Estimated Money Kept = Gross Revenue - all commissions, fees, taxes, payroll, expenses and refunds">
                {partial ? "Estimated Money Kept (Partial)" : "Estimated Money Kept"}
              </p>
              {partial && (
                <span className="text-[10px] font-medium text-amber-300">
                  (taxes incomplete)
                </span>
              )}
            </div>
            {/* The three headline figures roll up to their value, and re-roll
                whenever the date range, the fee rate or a settings change moves
                them — so a settings change is visible as money moving rather
                than as one string quietly replacing another. CountUp settles on
                the exact formatted string it was handed, so these stay
                reconciled to the cent. */}
            <CountUp
              as="p"
              value={`${kept >= 0 ? "" : "-"}${money2(Math.abs(kept))}`}
              className={`mt-1 font-heading text-4xl font-semibold ${kept >= 0 ? "text-[#00E096]" : "text-[#FF6B6B]"}`}
            />
            <p className="mt-1 text-xs text-slate-500">
              {gross > 0 ? `${money2(gross)} ${grossIsRoomOnly ? "room revenue" : "total revenue"} · ${partial ? "partial keep rate" : "keep rate"} ${pct(keepRate)}` : "No revenue in selected period"}
            </p>
            {partial && (
              <p className="mt-1 text-xs text-amber-300">
                Partial estimate: configure missing rates or supply occupied room-night counts. Keep rate and profit are not final.
              </p>
            )}
            <p className="mt-0.5 text-[10px] text-slate-600">
              {netRevenueBase > 0 ? `rate measured on net base ${money2(netRevenueBase)} = gross − refunds − pass-through tax` : ""}
            </p>
          </div>
          <div className="rounded-xl border border-white/5 bg-[#0A1628]/60 p-4">
            <p className="text-[10px] uppercase tracking-widest text-slate-500" title={grossSource}>{grossTitle}</p>
            <CountUp as="p" value={money2(gross)} className="mt-1 font-heading text-2xl font-semibold text-white" />
            <p className="mt-1 text-xs text-slate-500">{grossSource}</p>
          </div>
          <div className="rounded-xl border border-white/5 bg-[#0A1628]/60 p-4">
            <p className="text-[10px] uppercase tracking-widest text-slate-500" title="Sum of every deduction category shown below">Total Deductions</p>
            <CountUp as="p" value={`-${money2(totalDeductions)}`} className="mt-1 font-heading text-2xl font-semibold text-[#FFB547]" />
            <p className="mt-1 text-xs text-slate-500">{totalDeductions === 0 ? "No deductions" : gross > 0 ? `${pct(totalDeductions / gross)} of revenue` : "Deductions recorded; no revenue in this period"} · {items.length} {items.length === 1 ? "category" : "categories"}</p>
          </div>
        </div>
      </div>

      {/* ── Profit breakdown + pie ── */}
      <Card title="Profit Breakdown" subtitle={`Where every dollar goes · click any line to see the underlying transactions (${periodLabel})`}>
        <div className="grid gap-6 lg:grid-cols-5">
          <div className="space-y-1 lg:col-span-2">
            <button
              onClick={() => open(grossTitle, [{ name: grossTitle, detail: grossSource, amount: gross }])}
              className="flex w-full items-center justify-between rounded-lg px-3 py-2 transition-colors hover:bg-white/[0.04]"
            >
              <span className="text-sm font-medium text-slate-200">{grossTitle}</span>
              <span className="font-heading text-sm tabular-nums text-white">
                {money2(gross)}
                {gross > 0 && <span className="ml-1.5 text-xs text-slate-500">(100%)</span>}
              </span>
            </button>

            {items.map((i, idx) => {
              const color = colorByKey.get(i.key) || CHART_COLORS[idx % CHART_COLORS.length];
              return (
                <button
                  key={i.key}
                  onClick={() => open(i.label, i.records)}
                  title={"Click to see the underlying transactions"}
                  className="flex w-full items-center justify-between rounded-lg px-3 py-2 transition-colors hover:bg-white/[0.04]"
                >
                  <span className="flex items-center gap-2 text-sm text-slate-300">
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
                    {i.label}
                  </span>
                  <span className="text-sm tabular-nums text-slate-200">
                    {i.incomplete && i.amount === 0 ? (
                      <span className="text-xs font-medium text-amber-300">Unknown (tax inputs incomplete)</span>
                    ) : (
                      <>
                        {i.amount < 0 ? '+' : '-'}{money2(Math.abs(i.amount))}
                        {/* Always share OF GROSS, so every row in this column and
                            every slice in the pie are measuring the same thing. The
                            configured rate (e.g. a 11.70% tax rate) is a different
                            quantity against a different base, so it is shown
                            separately and labelled — it used to be printed in this
                            slot, which made the list and the pie disagree on the
                            same dollar figure. */}
                        <span className="ml-1.5 text-xs text-slate-500">{gross > 0 ? `(${pct(i.amount / gross)})` : "(—)"}</span>
                        {i.rate !== undefined && (
                          <span className="ml-1 text-xs text-slate-600">· {pct(i.rate, 2)} rate</span>
                        )}
                        {i.incomplete && !i.label.toLowerCase().includes("partial") && (
                          <span className="ml-1.5 text-xs font-medium text-amber-300">(partial)</span>
                        )}
                      </>
                    )}
                  </span>
                </button>
              );
            })}

            {items.length === 0 && (
              <p className="px-3 py-6 text-center text-sm text-slate-500">
                No deductions recorded for the selected period. Enter expenses or payroll to see where money goes.
              </p>
            )}

            <div className="my-2 border-t border-dashed border-white/10" />
            <div className="flex w-full items-center justify-between rounded-lg bg-[#00E096]/[0.06] px-3 py-3">
              <span className="flex items-center gap-2 text-sm font-medium text-[#00E096]">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: C.green }} />
                {partial ? "Estimated Money Kept (Partial)" : "Estimated Money Kept"}
              </span>
              <span className="font-heading text-base font-semibold tabular-nums text-[#00E096]">
                {kept >= 0 ? "" : "-"}{money2(Math.abs(kept))}
                <span className="ml-1.5 text-xs font-normal text-slate-400">
                  {gross > 0 ? `(${partial ? "partial " : ""}${pct(keepRate)})` : "(—)"}
                </span>
              </span>
            </div>
          </div>

          {/* Pie chart */}
          <div className="w-full lg:col-span-3">
            <PieDonut
              data={pieData}
              type="donut"
              height={480}
              showLegend={false}
              startAngle={90}
              endAngle={-270}
            />
            {!pieIsGrossShare && kept < 0 && (
              <p className="mt-1 text-center text-xs text-amber-300/80">
                Deductions exceed gross revenue this period, so there is no “money kept”
                wedge — these shares are of total deductions, not of gross.
              </p>
            )}
          </div>
        </div>
      </Card>

      {/* ── Taxes Collected / Tax Liability ── */}
      <Card
        title="Taxes Collected / Tax Liability"
        subtitle={`State, city, and other taxes shown separately · click a line for daily records (${periodLabel})`}
      >
        {taxTotal !== 0 || tax.calculations?.length > 0 ? (
          <div className="grid gap-6 lg:grid-cols-2">
            <div className="space-y-1">
              <TaxRow label="State Tax" amount={tax.state} color={CHART_COLORS[0]} records={tax.stateRecords} rate={tax.rates?.state} />
              <TaxRow label="City/Local Tax" amount={tax.city} color={CHART_COLORS[1]} records={tax.cityRecords} rate={tax.rates?.city} />
              <TaxRow label="Other Taxes" amount={tax.other} color={CHART_COLORS[2]} records={tax.otherRecords} rate={tax.rates?.other} />
              <div className="my-2 border-t border-dashed border-white/10" />
              <div className="flex w-full items-center justify-between rounded-lg bg-[#FFB547]/[0.06] px-3 py-3">
                <span className="flex items-center gap-2 text-sm font-medium text-[#FFB547]">
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: C.amber }} />
                  Total Tax Liability
                </span>
                <span className="font-heading text-base font-semibold tabular-nums text-[#FFB547]">{money2(taxTotal)}</span>
              </div>
              <p className="px-3 pt-2 text-xs text-slate-500">
                {tax.passThrough > 0.004 && (
                  <span className="block">Pass-through (imported from PMS): <span className="text-[#00E096]">{money2(tax.passThrough)}</span> — collected from the guest, remitted to government, does not reduce money kept.</span>
                )}
                {tax.estimated > 0.004 && (
                  <span className="block">Estimated at configured rates{tax.effectiveRate > 0 ? ` — combined ${pct(tax.effectiveRate, 2)}` : ""}: <span className="text-[#FFB547]">{money2(tax.estimated)}</span> — treated as a business cost since reports didn't include tax lines.</span>
                )}
              </p>
            </div>
            <TaxCalculationBreakdown calculations={tax.calculations} properties={properties} />
          </div>
        ) : (
          <p className="py-6 text-center text-sm text-slate-500">
            No tax data for the selected period. Imported PMS state/city tax lines are shown here automatically; otherwise taxes are estimated from the per-property tax settings.
          </p>
        )}
      </Card>

      {/* ── Visual breakdown: bar + trend ── */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={`${grossTitle} vs Money Kept`} subtitle="Every dollar of revenue vs what you keep after all deductions">
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={barData} layout="vertical" margin={{ left: 40, right: 16 }}>
                <CartesianGrid stroke="#ffffff0a" horizontal={false} />
                <XAxis type="number" tick={axis} tickFormatter={(v) => money(v)} stroke="#ffffff10" />
                <YAxis type="category" dataKey="name" tick={axis} width={150} stroke="#ffffff10" />
                <Tooltip contentStyle={tip} formatter={(v) => money2(v)} />
                <Bar dataKey="value" radius={[0, 6, 6, 0]}>
                  {barData.map((b, i) => (
                    <Cell key={i} fill={b.color} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card
          title={partial ? "Estimated Money Kept Trend (Partial)" : "Estimated Money Kept Trend"}
          subtitle="Kept after deductions per day, week, month, or year"
          right={
            <div className="flex items-center gap-0.5 rounded-lg border border-white/10 bg-[#0A1628] p-0.5">
              {TREND_MODES.map(([mode, label]) => (
                <button
                  key={mode}
                  onClick={() => setTrendMode(mode)}
                  className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                    trendMode === mode ? "bg-[#6C63FF] text-white" : "text-slate-400 hover:text-slate-200"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          }
        >
          <div className="h-64">
            {trendData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={trendData} margin={{ left: -10, right: 8, top: 8 }}>
                  <defs>
                    <linearGradient id="keptGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={C.green} stopOpacity={0.35} />
                      <stop offset="100%" stopColor={C.green} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="#ffffff0a" vertical={false} />
                  <XAxis dataKey="label" tick={axis} stroke="#ffffff10" />
                  <YAxis tick={axis} stroke="#ffffff10" tickFormatter={(v) => `${Math.round(v / 1000)}k`} width={54} />
                  <Tooltip
                    contentStyle={tip}
                    formatter={(v, name) => [money2(v), name === "gross" ? grossTitle : (partial ? "Estimated Money Kept (Partial)" : "Estimated Money Kept")]}
                  />
                  <Area type="monotone" dataKey="kept" stroke={C.green} strokeWidth={2} fill="url(#keptGrad)" />
                  <Line type="monotone" dataKey="gross" stroke={C.purple} strokeWidth={1.5} strokeDasharray="4 4" dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <p className="py-16 text-center text-sm text-slate-500">No trend data for the selected period.</p>
            )}
          </div>
        </Card>
      </div>

      {/* ── Drill-down modal ── */}
      {active && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onClick={() => setActive(null)}>
          <div
            className="w-full max-w-lg rounded-2xl border border-white/10 bg-[#151921] p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h3 className="font-heading text-lg font-semibold text-white">{active.label}</h3>
                <p className="text-xs text-slate-500">{active.rows.length} underlying records</p>
              </div>
              <button onClick={() => setActive(null)} className="text-slate-400 hover:text-white">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="max-h-80 space-y-1.5 overflow-auto pr-1">
              {active.rows.map((r, i) => (
                <div key={i} className="flex items-center justify-between rounded-lg border border-white/5 bg-[#0A1628]/60 px-3 py-2">
                  <div>
                    <p className="text-sm text-slate-200">{r.name}</p>
                    {r.detail && <p className="text-[11px] text-slate-500">{r.detail}</p>}
                  </div>
                  <span className="font-heading text-sm tabular-nums text-[#FFB547]">-{money2(r.amount)}</span>
                </div>
              ))}
              {active.rows.length === 0 && <p className="py-6 text-center text-sm text-slate-500">No underlying transactions recorded.</p>}
            </div>
            <div className="mt-4 flex items-center justify-between border-t border-white/5 pt-3">
              <span className="text-sm text-slate-400">Total</span>
              <span className="font-heading text-lg tabular-nums text-[#FFB547]">
                -{money2(active.rows.reduce((a, r) => a + (Number(r.amount) || 0), 0))}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
