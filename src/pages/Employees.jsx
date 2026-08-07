import React, { useMemo, useState } from "react";
import { Users, AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, Info } from "lucide-react";
import Card from "@/components/ui-exec/Card";
import KpiCard from "@/components/ui-exec/KpiCard";
import { useClerkRecords } from "@/lib/useHotelData";
import { money, money2, num, C } from "@/lib/hotel";
import { useGlobalFilters } from "@/lib/useGlobalFilters";

export default function Employees() {
  const { dateRange, property, properties, employee } = useGlobalFilters();
  const { data: records = [], isLoading } = useClerkRecords(dateRange, property);
  const [selected, setSelected] = useState(null);

  // Clerk records imported from ClerkShift.csv have mixed content in the
  // payment_type field: actual clerk names, dollar amounts from total rows,
  // and drop timestamps like "2026-01-01 11:12 PM - CARLOS HERNANDEZ".
  // We extract proper clerk names, filter out non-name values, and use
  // the adjusted field as the amount.
  function extractClerkName(rec) {
    if (rec.clerk_name) return rec.clerk_name;
    const pt = rec.payment_type || "";
    if (!pt || pt.startsWith("$") || /^\d{4}-\d{2}-\d{2}$/.test(pt)) return null;
    const m = pt.match(/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s*[AP]M\s*-\s*(.+)$/i);
    if (m) return m[1].trim();
    return pt;
  }

  const clerkRecords = useMemo(() => {
    let r = records
      .filter((x) => x.record_type === "payment")
      .map((x) => ({ ...x, _clerkName: extractClerkName(x) }))
      .filter((x) => x._clerkName);
    if (employee !== "all") r = r.filter((x) => x._clerkName === employee);
    return r;
  }, [records, employee]);

  const drops = useMemo(() => {
    let r = records
      .filter((x) => x.record_type === "drop")
      .map((x) => ({ ...x, _clerkName: extractClerkName(x) }))
      .filter((x) => x._clerkName);
    if (employee !== "all") r = r.filter((x) => x._clerkName === employee);
    return r;
  }, [records, employee]);

  const stats = useMemo(() => {
    if (!clerkRecords.length && !drops.length) return [];

    const map = new Map();
    const ensure = (k) => {
      if (!map.has(k)) map.set(k, {
        clerk: k,
        totalAdjusted: 0,
        positiveSum: 0,
        negativeSum: 0,
        txnCount: 0,
        records: [],
        dropCount: 0,
        cashDropped: 0,
      });
      return map.get(k);
    };

    clerkRecords.forEach((r) => {
      const k = r._clerkName || "Unknown";
      const s = ensure(k);
      const adj = Number(r.adjusted) || 0;
      s.totalAdjusted += adj;
      if (adj > 0) s.positiveSum += adj;
      else if (adj < 0) s.negativeSum += adj;
      s.txnCount += 1;
      s.records.push(r);
    });

    drops.forEach((d) => {
      const k = d._clerkName || "Unknown";
      const s = ensure(k);
      s.dropCount += 1;
      s.cashDropped += Number(d.amount) || 0;
    });

    return [...map.values()].map((s) => {
      const netCash = s.totalAdjusted;
      let status = "balanced";
      if (s.dropCount > 0) {
        const dropVariance = s.cashDropped - s.totalAdjusted;
        if (Math.abs(dropVariance) > 1) status = dropVariance > 0 ? "over" : "short";
        else status = "balanced";
      } else {
        if (s.totalAdjusted > 0) status = "over";
        else if (s.totalAdjusted < 0) status = "short";
      }
      return {
        ...s,
        avgPerRecord: s.txnCount ? Math.abs(s.totalAdjusted) / s.txnCount : 0,
        status,
      };
    }).sort((a, b) => b.txnCount - a.txnCount);
  }, [clerkRecords, drops]);

  const totalAdjusted = stats.reduce((a, s) => a + s.totalAdjusted, 0);
  const totalTxns = stats.reduce((a, s) => a + s.txnCount, 0);
  const totalDrops = stats.reduce((a, s) => a + s.dropCount, 0);
  const propName = property === "all" ? "All Properties" : (properties.find((p) => p.id === property)?.name || "Property");
  const periodLabel = `${dateRange.from || "—"} → ${dateRange.to || "—"}`;

  if (isLoading) return <p className="text-slate-500">Loading clerk data…</p>;

  return (
    <div className="space-y-6">
      <header>
        <p className="text-[11px] uppercase tracking-[0.3em] text-[#00D4FF]">Module 6</p>
        <h1 className="mt-2 font-heading text-3xl font-semibold text-white">Clerk Audit</h1>
        <p className="mt-1 text-sm text-slate-400">
          {propName} · {periodLabel} · {totalTxns} records · {stats.length} clerks
        </p>
      </header>

      {stats.length === 0 ? (
        <Card title="No clerk data available">
          <p className="text-sm text-slate-400">
            No clerk shift records are available for <span className="text-slate-200">{propName}</span> during{" "}
            <span className="text-slate-200">{periodLabel}</span>.
          </p>
          <p className="mt-2 text-sm text-slate-500">
            Import a <span className="text-slate-300">Clerk Shift & Cash Audit</span> report to see clerk performance,
            cash handling, and audit flags.
          </p>
        </Card>
      ) : (
        <>
          {/* Data Quality Note */}
          <div className="flex items-start gap-3 rounded-xl border border-[#FFB547]/20 bg-[#FFB547]/[0.06] p-4">
            <Info className="mt-0.5 h-5 w-5 shrink-0 text-[#FFB547]" />
            <div>
              <p className="text-sm text-slate-200">Clerk Audit Data Quality Notice</p>
              <p className="mt-1 text-xs text-slate-400">
                {stats.length} clerks detected from {totalTxns} adjustment records imported from ClerkShift.csv.
                The report scanner detected clerk names in the payment_type column and adjustment amounts in the
                adjusted column. Net adjustments shown below represent the difference between positive and negative
                adjustments per clerk. Re-importing with an updated parser will map cash handling, beginning cash,
                and payment method totals to their proper fields.
              </p>
            </div>
          </div>

          {/* KPI Cards */}
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard label="Clerks Detected" value={num(stats.length)} sub="from adjustment records" accent={C.purple} icon={Users} />
            <KpiCard label="Total Records" value={num(totalTxns)} sub="adjustment entries" accent={C.cyan} />
            <KpiCard
              label="Net Adjustments"
              value={money2(totalAdjusted)}
              sub={totalAdjusted >= 0 ? "Net positive" : "Net negative"}
              accent={totalAdjusted >= 0 ? C.green : C.coral}
            />
            <KpiCard
              label="Cash Drops"
              value={num(totalDrops)}
              sub={totalDrops ? "deposit records" : "no drop data"}
              accent={C.amber}
            />
          </div>

          {/* Clerk Table */}
          <Card title="Clerk Performance" subtitle="Click a row to see adjustment details">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-widest text-slate-500">
                    <th className="pb-3 pr-4">Clerk</th>
                    <th className="pb-3 pr-4 text-right">Records</th>
                    <th className="pb-3 pr-4 text-right">Positive Adj.</th>
                    <th className="pb-3 pr-4 text-right">Negative Adj.</th>
                    <th className="pb-3 pr-4 text-right">Net Adjusted</th>
                    {totalDrops > 0 && <th className="pb-3 pr-4 text-right">Cash Dropped</th>}
                    <th className="pb-3 text-right">Audit Status</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.map((s) => (
                    <React.Fragment key={s.clerk}>
                      <tr
                        onClick={() => setSelected(selected === s.clerk ? null : s.clerk)}
                        className="cursor-pointer border-t border-white/5 transition-colors hover:bg-white/[0.03]"
                      >
                        <td className="py-2.5 pr-4">
                          <span className="flex items-center gap-2 text-slate-200">
                            {selected === s.clerk ? <ChevronUp className="h-3.5 w-3.5 text-slate-500" /> : <ChevronDown className="h-3.5 w-3.5 text-slate-500" />}
                            {s.clerk}
                          </span>
                        </td>
                        <td className="py-2.5 pr-4 text-right tabular-nums text-slate-400">{num(s.txnCount)}</td>
                        <td className="py-2.5 pr-4 text-right tabular-nums text-[#00E096]">{money2(s.positiveSum)}</td>
                        <td className="py-2.5 pr-4 text-right tabular-nums text-[#FF6B6B]">{money2(s.negativeSum)}</td>
                        <td className="py-2.5 pr-4 text-right tabular-nums text-white">
                          {s.totalAdjusted >= 0 ? "+" : ""}{money2(s.totalAdjusted)}
                        </td>
                        {totalDrops > 0 && (
                          <td className="py-2.5 pr-4 text-right tabular-nums text-slate-300">{money2(s.cashDropped)}</td>
                        )}
                        <td className="py-2.5 text-right">
                          {s.status === "over" ? (
                            <span className="flex items-center justify-end gap-1 text-xs text-[#FFB547]">
                              <AlertTriangle className="h-3.5 w-3.5" /> Over
                            </span>
                          ) : s.status === "short" ? (
                            <span className="flex items-center justify-end gap-1 text-xs text-[#FF6B6B]">
                              <AlertTriangle className="h-3.5 w-3.5" /> Short
                            </span>
                          ) : (
                            <span className="flex items-center justify-end gap-1 text-xs text-[#00E096]">
                              <CheckCircle2 className="h-3.5 w-3.5" /> Balanced
                            </span>
                          )}
                        </td>
                      </tr>
                      {selected === s.clerk && (
                        <tr className="border-t border-white/5">
                          <td colSpan={totalDrops > 0 ? 7 : 6} className="bg-[#0A1628]/40 px-8 py-4">
                            <p className="mb-3 text-[11px] uppercase tracking-widest text-slate-500">
                              Adjustment details — {s.clerk} · {s.records.length} records
                            </p>
                            <div className="max-h-60 overflow-auto">
                              <table className="w-full text-xs">
                                <thead>
                                  <tr className="text-left text-slate-500">
                                    <th className="pb-2 pr-4">Import ID</th>
                                    <th className="pb-2 pr-4 text-right">Adjusted</th>
                                    <th className="pb-2 pr-4 text-right">Actual</th>
                                    <th className="pb-2 text-right">Net Today</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {s.records.slice(0, 100).map((r) => (
                                    <tr key={r.id} className="border-t border-white/5">
                                      <td className="py-1.5 pr-4 text-slate-500">{r.import_id || "—"}</td>
                                      <td className="py-1.5 pr-4 text-right tabular-nums text-slate-300">{money2(r.adjusted)}</td>
                                      <td className="py-1.5 pr-4 text-right tabular-nums text-slate-500">{money2(r.actual)}</td>
                                      <td className="py-1.5 text-right tabular-nums text-slate-500">{money2(r.net_today)}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}