import React, { useMemo, useRef, useState } from "react";
import { CreditCard, DollarSign, Receipt, RefreshCw, AlertTriangle, Percent, Settings } from "lucide-react";
import Card from "@/components/ui-exec/Card";
import KpiCard from "@/components/ui-exec/KpiCard";
import UniversalChart from "@/components/charts/UniversalChart";
import ChartToolbar from "@/components/charts/ChartToolbar";
import TaxConfigModal from "@/components/TaxConfigModal";
import { usePaymentData, useOccupancy, useClerkRecords, useSources } from "@/lib/useHotelData";
import { usePullToRefresh } from "@/hooks/usePullToRefresh";
import { money, money2, sum, inRange, C } from "@/lib/hotel";
import { useGlobalFilters } from "@/lib/useGlobalFilters";
import { PAYMENT_METHOD_FIELDS, CARD_METHODS, refundTotalFromTotals } from "@/lib/paymentNorm";
import { getTaxConfig, calculateTax, formatTaxRate, TAX_SOURCES } from "@/lib/taxConfig";

export default function Payments() {
  const { dateRange, property, properties, paymentType, months } = useGlobalFilters();
  const { data: payRecords = [], isLoading, refetch } = usePaymentData(dateRange, property, months);
  const { data: occ = [] } = useOccupancy(dateRange, property, months);
  const { data: clerk = [] } = useClerkRecords(dateRange, property);
  const { data: sourceRows = [] } = useSources(dateRange, property, months);
  const chartRef = useRef(null);
  const { pullDist, refreshing } = usePullToRefresh(refetch);

  const payRows = useMemo(
    () => payRecords.filter((r) => inRange(r.date, dateRange.from, dateRange.to)),
    [payRecords, dateRange]
  );
  const occRows = useMemo(
    () => occ.filter((r) => inRange(r.date, dateRange.from, dateRange.to)),
    [occ, dateRange]
  );
  const srcRows = useMemo(
    () => sourceRows.filter((r) => inRange(r.date, dateRange.from, dateRange.to)),
    [sourceRows, dateRange]
  );

  // Aggregate payment methods from PaymentDay columns.
  //
  // `paymentType` narrows this to a single tender. It was destructured but never
  // used, so the dropdown appeared to work and changed nothing. PaymentDay
  // stores one column per method, so the filter is applied here at the
  // aggregation step rather than by dropping rows — a row can carry several
  // tenders at once.
  const activeMethods = useMemo(
    () => (paymentType && paymentType !== "all"
      ? PAYMENT_METHOD_FIELDS.filter(([key]) => key === paymentType)
      : PAYMENT_METHOD_FIELDS),
    [paymentType]
  );
  const methodFiltered = activeMethods.length !== PAYMENT_METHOD_FIELDS.length;

  const methodTotals = useMemo(() => {
    const out = {};
    activeMethods.forEach(([key]) => { out[key] = sum(payRows, key); });
    return out;
  }, [payRows, activeMethods]);

  const cardTotal = CARD_METHODS.reduce((a, k) => a + (methodTotals[k] || 0), 0);
  const cashTotal = methodTotals.cash || 0;
  // When one tender is selected, "collected" means that tender — otherwise the
  // stored row total, which is the authoritative sum across all methods.
  const totalCollected = methodFiltered
    ? activeMethods.reduce((a, [key]) => a + (methodTotals[key] || 0), 0)
    : sum(payRows, "total");
  const refunds = refundTotalFromTotals(methodTotals);
  const netPaymentCollected = totalCollected - refunds;
  const expectedRevenue = sum(occRows, "total_revenue");
  const variance = totalCollected - expectedRevenue;

  // Payment distribution data for chart — exclude zero values
  const paymentData = useMemo(() => {
    let data = activeMethods
      .map(([key, label]) => ({ name: label, value: Math.abs(methodTotals[key] || 0), key }))
      .filter((d) => d.value > 0)
      .sort((a, b) => b.value - a.value);
    return data;
  }, [methodTotals, activeMethods]);

  // Daily trend
  const dailyTrend = useMemo(() => {
    const cardKeys = methodFiltered
      ? CARD_METHODS.filter((k) => activeMethods.some(([key]) => key === k))
      : CARD_METHODS;
    const showCash = activeMethods.some(([key]) => key === "cash");
    return payRows
      .map((r) => ({
        date: String(r.date).slice(0, 10),
        total: methodFiltered
          ? activeMethods.reduce((a, [key]) => a + (Number(r[key]) || 0), 0)
          : Number(r.total) || 0,
        cash: showCash ? Number(r.cash) || 0 : 0,
        card: cardKeys.reduce((a, k) => a + (Number(r[k]) || 0), 0),
      }))
      .filter((r) => r.date)
      .sort((a, b) => a.date.localeCompare(b.date));
  }, [payRows, activeMethods, methodFiltered]);

  // Clerk drops (from ClerkShiftRecord, if any exist)
  const drops = useMemo(() => clerk.filter((x) => x.record_type === "drop"), [clerk]);

  // Clerk payment activity (real per-clerk records from ClerkShift.csv)
  const [expandedClerk, setExpandedClerk] = useState(null);
  const clerkAdjustments = useMemo(() => {
    const payments = clerk.filter((x) => x.record_type === "clerk_payment");
    const map = new Map();
    payments.forEach((r) => {
      const name = r.clerk_name || "Unknown";
      const cur = map.get(name) || { clerk: name, adjusted: 0, actual: 0, count: 0, records: [] };
      cur.adjusted += Number(r.amount) || 0;
      cur.actual += Number(r.amount) || 0;
      cur.count += 1;
      cur.records.push(r);
      map.set(name, cur);
    });
    return [...map.values()].sort((a, b) => b.adjusted - a.adjusted);
  }, [clerk]);

  const propName = property === "all" ? "All Properties" : (Array.isArray(property) ? `${property.length} Properties` : (properties.find((p) => p.id === property)?.name || "Property"));
  const periodLabel = `${dateRange.from || "—"} → ${dateRange.to || "—"}`;

  // Tax configuration
  const [taxModalOpen, setTaxModalOpen] = useState(false);
  const [taxConfig, setTaxConfig] = useState(getTaxConfig());

  // Classify booking-source rows (SourceDay) into the configured tax buckets.
  // Matching is based on the source/code text since the imported reports
  // carry channel names like "EXPEDIA HOTEL COLLECT", "WALK-IN", "PRP"...
  const classifySource = (r) => {
    const text = `${r.source || ""} ${r.code || ""}`.toUpperCase();
    if (/EXPEDIA.*HOTEL COLLECT|EHC/.test(text)) return "EXPEDIA_HC";
    if (/BOOKING\.?COM.*HOTEL COLLECT|BHC/.test(text)) return "BOOKING_HC";
    if (/WALK|WIN/.test(text)) return "WALK_IN";
    if (/PROPERTY BOOKING|PRP|RR WEBSITE|WEB|RED ROOF APP|APP|CONTACT CENTER|CRS/.test(text)) return "PROPERTY_BOOKING";
    return "OTHER_OTA";
  };

  const taxCalculations = useMemo(() => {
    const buckets = {};
    srcRows.forEach((r) => {
      const key = classifySource(r);
      buckets[key] = (buckets[key] || 0) + (Number(r.net_revenue) || 0);
    });
    return TAX_SOURCES.map((src) => {
      const rent = buckets[src.key] || 0;
      const tax = calculateTax(rent, src.key);
      return { ...src, rent, tax };
    });
  }, [srcRows, taxConfig]);
  const totalTaxCollected = taxCalculations.reduce((a, c) => a + c.tax, 0);

  if (isLoading) return <p className="text-slate-500">Loading payment data…</p>;

  return (
    <div className="space-y-6">
      {(pullDist > 0 || refreshing) && (
        <div className="flex items-center justify-center overflow-hidden" style={{ height: Math.max(pullDist, refreshing ? 40 : 0) }}>
          <RefreshCw className={`h-5 w-5 text-slate-400 ${refreshing ? "animate-spin" : ""}`} />
        </div>
      )}

      <header>
        <p className="text-[11px] uppercase tracking-[0.3em] text-[#00D4FF]">Module 7</p>
        <h1 className="mt-2 font-heading text-3xl font-semibold text-white">Payment Methods</h1>
        <p className="mt-1 text-sm text-slate-400">
          {propName} · {periodLabel} · {payRows.length} days of data
        </p>
      </header>

      {/* Tax Management */}
      <Card
        title="Tax Management"
        subtitle={`Rate: ${formatTaxRate(taxConfig.taxRate)} · ${taxConfig.taxEnabled ? "Active" : "Disabled"}`}
        right={
          <button
            onClick={() => setTaxModalOpen(true)}
            className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-[#0A1628] px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-[#00D4FF]/30"
          >
            <Settings className="h-3.5 w-3.5" /> Configure Tax
          </button>
        }
      >
        <div className="grid gap-4 lg:grid-cols-3">
          {/* Tax Rate & Formula */}
          <div className="rounded-xl border border-white/5 bg-[#0A1628]/60 p-4">
            <div className="flex items-center gap-2">
              <Percent className="h-4 w-4 text-[#00D4FF]" />
              <p className="text-[10px] uppercase tracking-widest text-slate-500">Tax Rate</p>
            </div>
            <p className="mt-2 font-heading text-3xl font-semibold text-white">
              {formatTaxRate(taxConfig.taxRate)}
            </p>
            <div className="mt-3 rounded-lg bg-[#040D1A] p-2.5">
              <p className="text-xs text-slate-500">Formula</p>
              <p className="mt-0.5 font-mono text-xs text-[#00D4FF]">
                Tax = Room Rent × {formatTaxRate(taxConfig.taxRate)}
              </p>
            </div>
            <div className="mt-2 space-y-0.5 text-xs text-slate-500">
              <p>$100 → ${(100 * taxConfig.taxRate).toFixed(2)} tax</p>
              <p>$200 → ${(200 * taxConfig.taxRate).toFixed(2)} tax</p>
              <p>$300 → ${(300 * taxConfig.taxRate).toFixed(2)} tax</p>
            </div>
          </div>

          {/* Per-Source Tax Breakdown */}
          <div className="rounded-xl border border-white/5 bg-[#0A1628]/60 p-4 lg:col-span-2">
            <p className="text-[10px] uppercase tracking-widest text-slate-500">Tax Breakdown by Booking Source</p>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-widest text-slate-500">
                    <th className="pb-2 pr-4">Booking Source</th>
                    <th className="pb-2 pr-4 text-right">Room Rent</th>
                    <th className="pb-2 pr-4 text-right">Tax Rate</th>
                    <th className="pb-2 pr-4 text-right">Tax Amount</th>
                    <th className="pb-2 text-center">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {taxCalculations.map((c) => (
                    <tr key={c.key} className="border-t border-white/5">
                      <td className="py-2.5 pr-4 text-slate-200">{c.label}</td>
                      <td className="py-2.5 pr-4 text-right tabular-nums text-slate-300">{money2(c.rent)}</td>
                      <td className="py-2.5 pr-4 text-right tabular-nums text-slate-400">
                        {c.taxable ? formatTaxRate(taxConfig.taxRate) : "—"}
                      </td>
                      <td className="py-2.5 pr-4 text-right tabular-nums text-[#00D4FF]">{money2(c.tax)}</td>
                      <td className="py-2.5 text-center">
                        {c.taxable ? (
                          <span className="rounded-full bg-[#00E096]/10 px-2 py-0.5 text-[10px] text-[#00E096]">Taxable</span>
                        ) : (
                          <span className="rounded-full bg-slate-700/30 px-2 py-0.5 text-[10px] text-slate-400">Exempt</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-white/10 bg-[#040D1A]/80">
                    <td className="py-3 pr-4 font-semibold text-white">TOTAL</td>
                    <td className="py-3 pr-4 text-right tabular-nums text-slate-300">{money2(taxCalculations.reduce((a, c) => a + c.rent, 0))}</td>
                    <td className="py-3 pr-4 text-right text-slate-500">—</td>
                    <td className="py-3 pr-4 text-right font-heading text-lg font-semibold text-[#00D4FF]">{money2(totalTaxCollected)}</td>
                    <td className="py-3 text-center text-xs text-slate-500">{taxConfig.taxEnabled ? "Active" : "Off"}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </div>
        <TaxConfigModal open={taxModalOpen} onClose={() => { setTaxModalOpen(false); setTaxConfig(getTaxConfig()); }} />
      </Card>

      {payRows.length === 0 ? (
        <Card title="No payment data available">
          <p className="text-sm text-slate-400">
            No payment data is available for <span className="text-slate-200">{propName}</span> during{" "}
            <span className="text-slate-200">{periodLabel}</span>.
          </p>
          <p className="mt-2 text-sm text-slate-500">
            Import a <span className="text-slate-300">Payments Summary</span> report to see payment method breakdowns,
            reconciliation, and daily trends.
          </p>
        </Card>
      ) : (
        <>
          {/* KPI Cards */}
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
            <KpiCard label="Total Collected" value={money(totalCollected)} sub={`${payRows.length} days`} accent={C.purple} icon={DollarSign} />
            <KpiCard label="Net Payment" value={money(netPaymentCollected)} sub={`After ${money(refunds)} refunds`} accent={C.green} icon={DollarSign} />
            <KpiCard label="Cash" value={money(cashTotal)} sub={`${totalCollected ? ((cashTotal / totalCollected) * 100).toFixed(1) : 0}% of total`} accent={C.amber} icon={DollarSign} />
            <KpiCard label="Card" value={money(cardTotal)} sub={`${totalCollected ? ((cardTotal / totalCollected) * 100).toFixed(1) : 0}% of total`} accent={C.cyan} icon={CreditCard} />
            <KpiCard
              label="Variance"
              value={money2(variance)}
              sub={`Expected ${money2(expectedRevenue)}`}
              accent={Math.abs(variance) < 1 ? C.green : C.coral}
              icon={Receipt}
            />
          </div>

          {/* Payment Distribution Chart */}
          <Card
            title="Payment Method Distribution"
            subtitle={`${propName} · ${periodLabel}`}
            right={<ChartToolbar targetRef={chartRef} title="Payment Method Distribution" dateRange={periodLabel} />}
          >
            <div ref={chartRef}>
              <UniversalChart data={paymentData} type="donut" />
            </div>
          </Card>

          {/* Payment Method Table */}
          <Card title="Payment Method Breakdown" subtitle="Gross amounts by method with percentage of total">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-widest text-slate-500">
                    <th className="pb-3 pr-4">Payment Method</th>
                    <th className="pb-3 pr-4 text-right">Total Amount</th>
                    <th className="pb-3 pr-4 text-right">% of Total</th>
                    <th className="pb-3 text-right">Category</th>
                  </tr>
                </thead>
                <tbody>
                  {paymentData.map((p) => {
                    const pctOfTotal = totalCollected ? (p.value / totalCollected) * 100 : 0;
                    const category = p.key === "cash" ? "Cash" : CARD_METHODS.includes(p.key) ? "Card" : p.key === "check" ? "Check" : "Other";
                    return (
                      <tr key={p.key} className="border-t border-white/5 transition-colors hover:bg-white/[0.03]">
                        <td className="py-2.5 pr-4 text-slate-200">{p.name}</td>
                        <td className="py-2.5 pr-4 text-right tabular-nums text-white">{money(p.value)}</td>
                        <td className="py-2.5 pr-4 text-right tabular-nums text-slate-400">{pctOfTotal.toFixed(1)}%</td>
                        <td className="py-2.5 text-right text-xs text-slate-500">{category}</td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-white/10 bg-[#0A1628]/80">
                    <td className="py-3 pr-4 font-semibold text-white">TOTAL</td>
                    <td className="py-3 pr-4 text-right font-heading text-lg font-semibold text-[#00D4FF]">{money(totalCollected)}</td>
                    <td className="py-3 pr-4 text-right tabular-nums text-slate-400">100.0%</td>
                    <td className="py-3 text-right text-xs text-slate-500">{paymentData.length} methods</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </Card>

          {/* Reconciliation */}
          <Card title="Payment Reconciliation" subtitle="Expected revenue vs recorded payments by day">
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-xl bg-[#0A1628]/60 p-4">
                  <p className="text-[10px] uppercase tracking-widest text-slate-500">Expected Revenue</p>
                  <p className="mt-1 text-xl font-semibold text-white">{money(expectedRevenue)}</p>
                  <p className="text-xs text-slate-500">From occupancy reports</p>
                </div>
                <div className="rounded-xl bg-[#0A1628]/60 p-4">
                  <p className="text-[10px] uppercase tracking-widest text-slate-500">Recorded Payments</p>
                  <p className="mt-1 text-xl font-semibold text-white">{money(totalCollected)}</p>
                  <p className="text-xs text-slate-500">From payment summary</p>
                </div>
                <div className="rounded-xl bg-[#0A1628]/60 p-4">
                  <p className="text-[10px] uppercase tracking-widest text-slate-500">Variance</p>
                  <p className="mt-1 text-xl font-semibold" style={{ color: Math.abs(variance) < 1 ? C.green : C.coral }}>
                    {variance >= 0 ? "+" : ""}{money2(variance)}
                  </p>
                  <p className="text-xs text-slate-500">
                    {Math.abs(variance) < 1 ? "Balanced" : variance > 0 ? "Over-collected" : "Under-collected"}
                  </p>
                </div>
              </div>

              {methodFiltered ? (
                <div className="flex items-start gap-3 rounded-xl border border-[#00D4FF]/20 bg-[#00D4FF]/[0.06] p-4">
                  <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-[#00D4FF]" />
                  <div>
                    <p className="text-sm text-slate-200">Showing one payment method only.</p>
                    <p className="mt-1 text-xs text-slate-400">
                      Variance compares a single tender against the full room revenue for the period, so a large gap is
                      expected here and does not indicate a problem. Set the payment method filter back to All to
                      reconcile collections against revenue.
                    </p>
                  </div>
                </div>
              ) : Math.abs(variance) > 100 && (
                <div className="flex items-start gap-3 rounded-xl border border-[#FFB547]/20 bg-[#FFB547]/[0.06] p-4">
                  <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-[#FFB547]" />
                  <div>
                    <p className="text-sm text-slate-200">Payment variance of {money2(Math.abs(variance))} detected.</p>
                    <p className="mt-1 text-xs text-slate-400">
                      Possible causes: refunds not captured in daily total, advance deposits, adjustments, or missing payment records for some days.
                      Review the daily trend below and compare with occupancy revenue to identify the discrepancy source.
                    </p>
                  </div>
                </div>
              )}
            </div>
          </Card>

          {/* Daily Trend */}
          {dailyTrend.length > 0 && (
            <Card title="Daily Payment Trend" subtitle={`${dailyTrend.length} days · Total, Cash, and Card`}>
              <div className="max-h-96 overflow-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-[#0F1F35] text-left text-[11px] uppercase tracking-widest text-slate-500">
                    <tr>
                      <th className="py-2 pr-4">Date</th>
                      <th className="py-2 pr-4 text-right">Total</th>
                      <th className="py-2 pr-4 text-right">Cash</th>
                      <th className="py-2 pr-4 text-right">Card</th>
                      <th className="py-2 text-right">% Cash</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dailyTrend.map((d) => (
                      <tr key={d.date} className="border-t border-white/5">
                        <td className="py-2 pr-4 text-slate-300">{d.date}</td>
                        <td className="py-2 pr-4 text-right tabular-nums text-white">{money(d.total)}</td>
                        <td className="py-2 pr-4 text-right tabular-nums text-slate-400">{money2(d.cash)}</td>
                        <td className="py-2 pr-4 text-right tabular-nums text-slate-400">{money2(d.card)}</td>
                        <td className="py-2 text-right tabular-nums text-slate-500">
                          {d.total ? ((d.cash / d.total) * 100).toFixed(0) : 0}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          {/* Payment Audit with drill-down */}
          {clerkAdjustments.length > 0 && (
            <Card title="Payment Audit" subtitle="Click a clerk to expand individual payment records">
              <div className="space-y-2">
                {clerkAdjustments.map((c) => (
                  <div key={c.clerk}>
                    <button
                      onClick={() => setExpandedClerk(expandedClerk === c.clerk ? null : c.clerk)}
                      className="flex w-full items-center justify-between rounded-xl border border-white/5 bg-[#0A1628]/60 px-4 py-3 transition-colors hover:border-white/10"
                    >
                      <div className="text-left">
                        <p className="text-sm text-white">{c.clerk}</p>
                        <p className="text-xs text-slate-500">{c.count} payment{c.count === 1 ? "" : "s"}</p>
                      </div>
                      <div className="text-right">
                        <p className="font-heading text-base tabular-nums text-[#00D4FF]">{money(c.adjusted)}</p>
                      </div>
                    </button>
                    {expandedClerk === c.clerk && (
                      <div className="mt-1 space-y-1 rounded-xl border border-white/5 bg-[#040D1A] p-3">
                        {c.records.slice(0, 50).map((r, i) => (
                          <div key={i} className="flex items-center justify-between py-1.5 text-xs">
                            <span className="text-slate-400">{r.payment_type || "—"}</span>
                            <span className="tabular-nums text-slate-300">{money2(Number(r.amount) || 0)}</span>
                          </div>
                        ))}
                        <div className="mt-2 flex items-center justify-between border-t border-white/5 pt-2">
                          <span className="text-xs font-medium text-slate-300">Total</span>
                          <span className="font-heading text-sm tabular-nums text-[#00D4FF]">{money(c.adjusted)}</span>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* Clerk drops if any */}
          {drops.length > 0 && (
            <Card title="Cash Drop Records" subtitle={`${drops.length} deposit drop records`}>
              <div className="max-h-80 overflow-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-[#0F1F35] text-left text-[11px] uppercase tracking-widest text-slate-500">
                    <tr>
                      <th className="py-2 pr-4">Date</th>
                      <th className="py-2 pr-4">Clerk</th>
                      <th className="py-2 text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {drops.map((d, i) => (
                      <tr key={i} className="border-t border-white/5">
                        <td className="py-2 pr-4 text-slate-300">{String(d.shift_date || "").slice(0, 10) || "—"}</td>
                        <td className="py-2 pr-4 text-slate-400">{d.clerk_name || "—"}</td>
                        <td className="py-2 text-right tabular-nums text-[#00D4FF]">{money2(d.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );
}