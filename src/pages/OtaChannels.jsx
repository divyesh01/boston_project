import React, { useMemo, useState, useRef } from "react";
import { DollarSign, Percent, TrendingDown, FileDown, Lightbulb, Plus, Trash2 } from "lucide-react";
import KpiCard from "@/components/ui-exec/KpiCard";
import Card from "@/components/ui-exec/Card";
import PaymentMethodChart from "@/components/dashboard/PaymentMethodChart";
import { useSources, usePaymentData } from "@/lib/useHotelData";
import { useGlobalFilters } from "@/lib/useGlobalFilters";
import { usePullToRefresh } from "@/hooks/usePullToRefresh";
import { exportToPdf } from "@/lib/pdfExport";
import { C, money, money2, pct, num, sum, inRange, commissionFor } from "@/lib/hotel";
import { getCommissionRates, setCommissionRates, getCcFeeRate, setCcFeeRate, COMMISSION_TYPES } from "@/lib/commissionRates";
import ResponsiveSelect from "@/components/ui/ResponsiveSelect";

export default function OtaChannels() {
  const { dateRange, property, months } = useGlobalFilters();
  const { data: sources = [], refetch } = useSources(dateRange, property, months);
  const { data: payRows = [], refetch: refPay } = usePaymentData(dateRange, property, months);
  const [rates, setRates] = useState(getCommissionRates());
  const [ccFee, setCcFee] = useState(getCcFeeRate());
  const [newSource, setNewSource] = useState("");
  const [exporting, setExporting] = useState(false);
  const contentRef = useRef(null);

  const handleRefresh = async () => { await Promise.all([refetch(), refPay()]); };
  usePullToRefresh(handleRefresh);

  const srcRows = useMemo(() => sources.filter((r) => inRange(r.date, dateRange.from, dateRange.to)), [sources, dateRange]);

  const channels = useMemo(() => {
    const map = new Map();
    srcRows.forEach((r) => {
      const key = r.source || r.code || "UNKNOWN";
      const cur = map.get(key) || { source: key, gross: 0, stays: 0 };
      cur.gross += Number(r.net_revenue) || 0;
      cur.stays += Number(r.stays) || 0;
      map.set(key, cur);
    });
    return [...map.values()]
      .filter((c) => c.gross > 0 || c.stays > 0)
      .map((c) => {
        const info = commissionFor(c.source);
        let commission = 0;
        if (info.type === "percentage") commission = c.gross * info.rate;
        else if (info.type === "fixed") commission = info.rate * c.stays;
        else if (info.type === "actual") commission = info.rate;
        return { ...c, ...info, commission, net: c.gross - commission, margin: c.gross ? (c.gross - commission) / c.gross : 0 };
      })
      .sort((a, b) => b.net - a.net);
  }, [srcRows, rates]);

  const totalGross = channels.reduce((a, c) => a + c.gross, 0);
  const totalCommission = channels.reduce((a, c) => a + c.commission, 0);
  const totalNet = channels.reduce((a, c) => a + c.net, 0);

  const updateRate = (source, field, value) => {
    const updated = { ...rates };
    if (!updated[source]) updated[source] = { type: "percentage", rate: 0, taxExempt: false };
    updated[source] = { ...updated[source], [field]: value };
    setRates(updated);
    setCommissionRates(updated);
  };

  const addSource = () => {
    if (!newSource.trim()) return;
    const key = newSource.trim().toUpperCase();
    const updated = { ...rates, [key]: { type: "percentage", rate: 0, taxExempt: false } };
    setRates(updated);
    setCommissionRates(updated);
    setNewSource("");
  };

  const removeSource = (source) => {
    const updated = { ...rates };
    delete updated[source];
    setRates(updated);
    setCommissionRates(updated);
  };

  const updateCcFee = (v) => {
    const val = parseFloat(v) || 0;
    setCcFee(val);
    setCcFeeRate(val);
  };

  const handleExport = async () => {
    if (exporting || !contentRef.current) return;
    setExporting(true);
    try { await exportToPdf(contentRef.current, `RRI_OTA_Channels_${dateRange.from}_${dateRange.to}.pdf`); } catch (e) {}
    setExporting(false);
  };

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[11px] uppercase tracking-[0.3em] text-[#00D4FF]">Channel Profitability</p>
          <h1 className="mt-2 font-heading text-3xl font-semibold text-white">OTA Channels Net Profitability</h1>
          <p className="mt-1 text-sm text-slate-400">{dateRange.from || "—"} → {dateRange.to || "—"} · {channels.length} channels</p>
        </div>
        <button onClick={handleExport} disabled={exporting} className="flex h-11 items-center gap-2 rounded-lg bg-[#6C63FF] px-4 text-sm font-medium text-white transition-colors hover:bg-[#5b52e8] disabled:opacity-50">
          <FileDown className="h-4 w-4" /><span className="hidden sm:inline">{exporting ? "Generating…" : "Export PDF"}</span>
        </button>
      </header>

      <div ref={contentRef} className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-3">
          <KpiCard label="Total Gross Revenue" value={money(totalGross)} sub={`${channels.length} active channels`} accent={C.purple} icon={DollarSign} />
          <KpiCard label="Total Commission Paid" value={money(totalCommission)} sub={`${pct(totalGross ? totalCommission / totalGross : 0, 1)} of gross`} accent={C.coral} icon={TrendingDown} />
          <KpiCard label="Total Net Revenue" value={money(totalNet)} sub={`${pct(totalGross ? totalNet / totalGross : 0)} net margin`} accent={C.green} icon={Percent} />
        </div>

        <Card title="Channel Performance Matrix" subtitle="Edit commission rates inline — changes save to browser and reflect instantly">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-widest text-slate-500">
                  <th className="pb-3 pr-3">Channel</th>
                  <th className="pb-3 pr-3 text-right">Gross</th>
                  <th className="pb-3 pr-3">Comm. Type</th>
                  <th className="pb-3 pr-3 text-right">Rate/Amount</th>
                  <th className="pb-3 pr-3 text-right">Commission $</th>
                  <th className="pb-3 pr-3 text-right">Net</th>
                  <th className="pb-3 pr-3 text-right">Margin</th>
                  <th className="pb-3 pr-3 text-right">Rooms</th>
                  <th className="pb-3 pr-3 text-right">ADR</th>
                  <th className="pb-3">Tax</th>
                  <th className="pb-3"></th>
                </tr>
              </thead>
              <tbody>
                {channels.map((c) => {
                  const rateInfo = rates[c.source] || { type: "none", rate: 0, taxExempt: false };
                  return (
                    <tr key={c.source} className="border-t border-white/5 transition-colors hover:bg-white/[0.03]">
                      <td className="py-2.5 pr-3 font-medium text-slate-200">{c.source}</td>
                      <td className="py-2.5 pr-3 text-right tabular-nums">{money(c.gross)}</td>
                      <td className="py-2.5 pr-3">
                        <select
                          value={rateInfo.type}
                          onChange={(e) => updateRate(c.source, "type", e.target.value)}
                          className="h-8 rounded-lg border border-white/10 bg-[#0A1628] px-2 text-xs text-slate-200"
                        >
                          {COMMISSION_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                        </select>
                      </td>
                      <td className="py-2.5 pr-3 text-right">
                        <input
                          type="number"
                          step="0.01"
                          value={rateInfo.rate}
                          disabled={rateInfo.type === "none"}
                          onChange={(e) => updateRate(c.source, "rate", parseFloat(e.target.value) || 0)}
                          className="h-8 w-20 rounded-lg border border-white/10 bg-[#0A1628] px-2 text-right text-xs tabular-nums text-slate-200 disabled:opacity-30"
                        />
                      </td>
                      <td className="py-2.5 pr-3 text-right tabular-nums" style={{ color: c.commission > 0 ? C.coral : "#64748b" }}>
                        {c.commission > 0 ? `-${money(c.commission)}` : "—"}
                      </td>
                      <td className="py-2.5 pr-3 text-right font-medium tabular-nums text-white">{money(c.net)}</td>
                      <td className="py-2.5 pr-3 text-right tabular-nums" style={{ color: c.margin >= 0.9 ? C.green : C.amber }}>{pct(c.margin)}</td>
                      <td className="py-2.5 pr-3 text-right tabular-nums text-slate-400">{num(c.stays)}</td>
                      <td className="py-2.5 pr-3 text-right tabular-nums text-slate-400">{c.stays ? money2(c.gross / c.stays) : "—"}</td>
                      <td className="py-2.5 pr-3">
                        <button
                          onClick={() => updateRate(c.source, "taxExempt", !rateInfo.taxExempt)}
                          className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${rateInfo.taxExempt ? "bg-[#00D4FF]/15 text-[#00D4FF]" : "bg-white/5 text-slate-500"}`}
                        >
                          {rateInfo.taxExempt ? "Exempt" : "Taxable"}
                        </button>
                      </td>
                      <td className="py-2.5 pr-3">
                        <button onClick={() => removeSource(c.source)} className="text-slate-600 hover:text-[#FF6B6B]">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-white/5 pt-4">
            <input
              type="text"
              value={newSource}
              onChange={(e) => setNewSource(e.target.value)}
              placeholder="Add new source name…"
              className="h-9 flex-1 min-w-[200px] rounded-lg border border-white/10 bg-[#0A1628] px-3 text-sm text-slate-200 placeholder-slate-600"
              onKeyDown={(e) => e.key === "Enter" && addSource()}
            />
            <button onClick={addSource} className="flex h-9 items-center gap-1.5 rounded-lg bg-[#6C63FF] px-3 text-sm text-white">
              <Plus className="h-4 w-4" /> Add Source
            </button>
          </div>
        </Card>

        <Card title="Credit/Debit Card Processing Fee" subtitle="Applied to all card charges and refunds">
          <div className="flex items-center gap-4">
            <input
              type="number"
              step="0.001"
              value={ccFee}
              onChange={(e) => updateCcFee(e.target.value)}
              className="h-10 w-28 rounded-lg border border-white/10 bg-[#0A1628] px-3 text-right text-sm tabular-nums text-slate-200"
            />
            <span className="text-sm text-slate-400">% fee on Visa, Mastercard, Amex, Discover transactions</span>
          </div>
        </Card>

        <PaymentMethodChart payRows={payRows.filter((r) => inRange(r.date, dateRange.from, dateRange.to))} />

        {channels.length > 0 && (
          <Card title="Channel Optimization Insights">
            <div className="space-y-3">
              {channels
                .filter((c) => c.gross > 1000)
                .slice(0, 5)
                .map((c) => {
                  const isHighMargin = c.margin >= 0.9;
                  const msg = isHighMargin
                    ? c.source === "WALK-IN"
                      ? "100% Margin! Invest in local marketing and walk-in promotions."
                      : "Highly profitable channel. Focus on growing this segment."
                    : "High volume channel. Consider negotiating lower commission or pushing direct bookings.";
                  return (
                    <div key={c.source} className="flex items-start gap-3 rounded-lg bg-white/[0.03] p-3">
                      <Lightbulb className="mt-0.5 h-4 w-4 shrink-0 text-[#FFB547]" />
                      <div className="flex-1">
                        <p className="text-sm text-white">{c.source}</p>
                        <p className="text-xs text-slate-400">{msg}</p>
                      </div>
                      <span className="text-right text-xs tabular-nums text-slate-500">
                        {money(c.gross)} · {pct(c.margin)}
                      </span>
                    </div>
                  );
                })}
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}