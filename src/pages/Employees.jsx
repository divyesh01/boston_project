import React, { useMemo, useState, useEffect } from "react";
import * as Tabs from "@radix-ui/react-tabs";
import { motion } from "framer-motion";
import { Users, AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, Info } from "lucide-react";
import Card from "@/components/ui-exec/Card";
import KpiCard from "@/components/ui-exec/KpiCard";
import { useClerkRecords, useAdjustmentsRefunds, useClerkAnomalies } from "@/lib/useHotelData";
import { money2, num, C } from "@/lib/hotel";
import { detectClerkAnomalies } from "@/lib/anomalyDetector";
import ClerkAuditMatrix from "@/components/dashboard/ClerkAuditMatrix";
import { useGlobalFilters } from "@/lib/useGlobalFilters";
import { signOffShiftAnomaly } from "@/lib/anomalySignoff";
import { db } from "@/api/base44Client";

export default function Employees() {
  const { dateRange, property, properties, employee } = useGlobalFilters();
  const { data: records = [], isLoading } = useClerkRecords(dateRange, property);
  const { data: adjRef = [], isLoading: isLoadingAdj } = useAdjustmentsRefunds(dateRange, property);
  const { data: allAnomalies = [] } = useClerkAnomalies(dateRange, property);
  const [selected, setSelected] = useState(null);
  const [clerkFilter, setClerkFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  // The Fraud & Anomalies tab has its own Clerk + Payment Type filters, kept
  // separate from the Shift Cash Audit filters above because they read a
  // different data source (PMS adjustments/refunds, not ClerkShift payments).
  const [fraudClerk, setFraudClerk] = useState("all");
  const [fraudType, setFraudType] = useState("all");

  // Manager sign-off state for clerk shift anomalies.
  const [mgr, setMgr] = useState(null);
  const [signOffNotes, setSignOffNotes] = useState({});
  const [signedClerks, setSignedClerks] = useState({});
  const [notice, setNotice] = useState(null);
  useEffect(() => {
    db.auth.me().then((u) => setMgr(u)).catch(() => setMgr(null));
  }, []);

  const handleSignOff = async (clerk) => {
    const notes = signOffNotes[clerk.clerk] || "";
    const user = mgr || {};
    try {
      for (const rec of clerk.records) {
        if (!rec.id) continue;
        await signOffShiftAnomaly({
          shiftId: rec.id,
          managerUserId: user.id || "manager",
          managerName: user.username || user.email || "Manager",
          resolutionNotes: notes,
          propertyId: rec.property_id || property || null,
        });
      }
      setSignedClerks((p) => ({ ...p, [clerk.clerk]: true }));
      setNotice({ type: "ok", text: `Signed off ${clerk.clerk}'s shift records.` });
    } catch (e) {
      setNotice({ type: "error", text: `Sign-off failed: ${e.message}` });
    }
  };

  const adjustments = useMemo(() => adjRef.filter(r => r.record_type === "adjustment"), [adjRef]);
  const refunds = useMemo(() => adjRef.filter(r => r.record_type === "refund"), [adjRef]);

  // Fraud-tab filters narrow the INPUTS to the anomaly engine so every derived
  // view (KPIs, risk matrix, ledger, drill-down) recomputes consistently.
  // Adjustments carry no payment tender, so Payment Type narrows refunds only;
  // the Clerk filter narrows both. Default "all"/"all" returns the same array
  // references, preserving current behavior exactly.
  const fraudAdjustments = useMemo(() => {
    if (fraudClerk === "all") return adjustments;
    return adjustments.filter((a) => a.username === fraudClerk);
  }, [adjustments, fraudClerk]);

  const fraudRefunds = useMemo(() => {
    let r = refunds;
    if (fraudClerk !== "all") r = r.filter((x) => x.username === fraudClerk);
    if (fraudType !== "all") r = r.filter((x) => (x.paymentTypeRefunded || "—") === fraudType);
    return r;
  }, [refunds, fraudClerk, fraudType]);

  // Dropdown options come from the UNFILTERED data so choosing one value never
  // hides the others. Clerk options union adjustment + refund usernames; payment
  // types exist on refunds only.
  const fraudClerkOptions = useMemo(() => {
    const set = new Set();
    for (const a of adjustments) if (a.username) set.add(a.username);
    for (const r of refunds) if (r.username) set.add(r.username);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [adjustments, refunds]);

  const fraudTypeOptions = useMemo(() => {
    const set = new Set();
    for (const r of refunds) if (r.paymentTypeRefunded) set.add(r.paymentTypeRefunded);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [refunds]);

  // We can either use persisted anomalies or recalculate on the fly for the dashboard.
  // Using detectClerkAnomalies directly gives us both the flags (matching current thresholds)
  // and the clerkRiskScores matrix instantly.
  const { flaggedAnomalies, clerkRiskScores } = useMemo(() => {
    // If you want to use strictly persisted alerts:
    // const persisted = allAnomalies.filter(a => Object.values(CLERK_ANOMALY_TYPES).includes(a.alert_type));
    // But detectClerkAnomalies generates everything needed for the UI in one pass:
    return detectClerkAnomalies({ adjustments: fraudAdjustments, refunds: fraudRefunds });
  }, [fraudAdjustments, fraudRefunds]);

  // Clerk records imported from ClerkShift.csv come in three record types:
  //  - "payment": payment method totals (CASH, CHECK, AMEX...), NOT clerks
  //  - "clerk_payment": per-clerk payment activity with clerk_name + amount
  //  - "drop": cash drops with clerk_name + shift_date + amount
  // We only surface clerk_payment and drop records; payment methods are
  // shown on the Payments page instead.
  const clerkRecords = useMemo(() => {
    let r = records.filter((x) => x.record_type === "clerk_payment");
    if (employee !== "all") r = r.filter((x) => x.clerk_name === employee);
    return r;
  }, [records, employee]);

  const drops = useMemo(() => {
    let r = records.filter((x) => x.record_type === "drop");
    if (employee !== "all") r = r.filter((x) => x.clerk_name === employee);
    return r;
  }, [records, employee]);

  // Payment-type filter narrows the clerk payment activity that feeds the
  // per-clerk aggregation (net amounts, positive/negative sums, txn counts).
  const typeFilteredClerkRecords = useMemo(() => {
    if (typeFilter === "all") return clerkRecords;
    return clerkRecords.filter((r) => (r.payment_type || "—") === typeFilter);
  }, [clerkRecords, typeFilter]);

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

    typeFilteredClerkRecords.forEach((r) => {
      const k = r.clerk_name || "Unknown";
      const s = ensure(k);
      const adj = Number(r.amount) || 0;
      s.totalAdjusted += adj;
      if (adj > 0) s.positiveSum += adj;
      else if (adj < 0) s.negativeSum += adj;
      s.txnCount += 1;
      s.records.push(r);
    });

    drops.forEach((d) => {
      const k = d.clerk_name || "Unknown";
      const s = ensure(k);
      s.dropCount += 1;
      s.cashDropped += Number(d.amount) || 0;
    });

    return [...map.values()].map((s) => {
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
  }, [typeFilteredClerkRecords, drops]);

  // Clerk filter narrows which clerk rows are shown in the table (the audit
  // aggregation/KPIs above still reflect the payment-type filter).
  const filteredStats = useMemo(() => {
    if (clerkFilter === "all") return stats;
    return stats.filter((s) => s.clerk === clerkFilter);
  }, [stats, clerkFilter]);

  const clerkOptions = useMemo(
    () => [...new Set(stats.map((s) => s.clerk))].sort((a, b) => a.localeCompare(b)),
    [stats]
  );
  const typeOptions = useMemo(() => {
    const set = new Set(clerkRecords.map((r) => (r.payment_type || "—")).filter(Boolean));
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [clerkRecords]);

  const [activeTab, setActiveTab] = useState("cash_drops");

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

      {notice && (
        <div className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs ${notice.type === "ok" ? "border-[#00E096]/30 bg-[#00E096]/10 text-[#00E096]" : "border-[#FF6B6B]/30 bg-[#FF6B6B]/10 text-[#FF6B6B]"}`}>
          {notice.type === "ok" ? <CheckCircle2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />} {notice.text}
        </div>
      )}

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
        <Tabs.Root value={activeTab} onValueChange={setActiveTab}>
          <div className="mb-6 flex items-center justify-between">
            <Tabs.List className="relative flex w-fit rounded-full bg-[#0A1628]/80 p-1 backdrop-blur-md border border-white/5">
              {["cash_drops", "anomalies"].map((tabId) => {
                const isActive = activeTab === tabId;
                return (
                  <Tabs.Trigger
                    key={tabId}
                    value={tabId}
                    className={`relative z-10 rounded-full px-5 py-2 text-sm font-medium outline-none transition-colors duration-300 ${
                      isActive ? "text-white" : "text-slate-400 hover:text-slate-300"
                    }`}
                  >
                    {isActive && (
                      <motion.div
                        layoutId="activeTabBadge"
                        className="absolute inset-0 z-[-1] rounded-full bg-[#1A2C46] shadow-[0_0_15px_rgba(255,255,255,0.05)] border border-white/10"
                        transition={{ type: "spring", bounce: 0.2, duration: 0.6 }}
                      />
                    )}
                    {tabId === "cash_drops" ? "Shift Cash Audit" : "Fraud & Anomalies"}
                  </Tabs.Trigger>
                );
              })}
            </Tabs.List>
          </div>

          <Tabs.Content value="cash_drops" className="space-y-6 outline-none">
            {/* Data Quality Note */}
            <div className="flex items-start gap-3 rounded-xl border border-[#FFB547]/20 bg-[#FFB547]/[0.06] p-4">
              <Info className="mt-0.5 h-5 w-5 shrink-0 text-[#FFB547]" />
              <div>
                <p className="text-sm text-slate-200">Clerk Audit Data Quality Notice</p>
                <p className="mt-1 text-xs text-slate-400">
                  {stats.length} clerks detected from {totalTxns} payment records imported from ClerkShift.csv.
                  Clerk performance is derived from the per-clerk payment activity and cash deposit records in the
                  report. Net amounts shown represent the difference between positive and negative payment activity
                  per clerk.
                </p>
              </div>
            </div>

            {/* KPI Cards */}
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <KpiCard label="Clerks Detected" value={num(stats.length)} sub="from payment records" accent={C.purple} icon={Users} />
              <KpiCard label="Total Records" value={num(totalTxns)} sub="payment entries" accent={C.cyan} />
              <KpiCard
                label="Net Payments"
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

            {/* Filters */}
            <div className="flex flex-wrap items-end gap-4">
              <label className="flex flex-col gap-1 text-xs text-slate-400">
                Clerk
                <select
                  value={clerkFilter}
                  onChange={(e) => setClerkFilter(e.target.value)}
                  className="min-w-[10rem] rounded-lg border border-white/10 bg-[#0A1628] px-3 py-2 text-sm text-slate-200 outline-none transition-colors focus:border-[#00D4FF]/40"
                >
                  <option value="all">All Clerks</option>
                  {clerkOptions.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs text-slate-400">
                Payment Type
                <select
                  value={typeFilter}
                  onChange={(e) => setTypeFilter(e.target.value)}
                  className="min-w-[10rem] rounded-lg border border-white/10 bg-[#0A1628] px-3 py-2 text-sm text-slate-200 outline-none transition-colors focus:border-[#00D4FF]/40"
                >
                  <option value="all">All Types</option>
                  {typeOptions.map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              </label>
            </div>

            {/* Clerk Table */}
            <Card title="Clerk Cash Drops & Shifts" subtitle="Click a row to see shift payment details">
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
                     {filteredStats.map((s) => (
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
                                Payment details — {s.clerk} · {s.records.length} records
                              </p>
                              <div className="max-h-60 overflow-auto">
                                <table className="w-full text-xs">
                                  <thead>
                                    <tr className="text-left text-slate-500">
                                      <th className="pb-2 pr-4">Payment Type</th>
                                      <th className="pb-2 pr-4 text-right">Amount</th>
                                      <th className="pb-2 text-right">Txns</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {s.records.slice(0, 100).map((r) => (
                                      <tr key={r.id} className="border-t border-white/5">
                                        <td className="py-1.5 pr-4 text-slate-300">{r.payment_type || "—"}</td>
                                        <td className="py-1.5 pr-4 text-right tabular-nums text-slate-300">{money2(r.amount)}</td>
                                        <td className="py-1.5 text-right tabular-nums text-slate-500">{r.transaction_count || "—"}</td>
                                      </tr>
                                    ))}
                                 </tbody>
                  </table>
                 {filteredStats.length === 0 && (
                   <p className="px-1 py-4 text-sm text-slate-500">No clerks match the selected filters.</p>
                 )}
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-white/5 pt-3">
                  <input
                    value={signOffNotes[s.clerk] || ""}
                    onChange={(e) => setSignOffNotes((p) => ({ ...p, [s.clerk]: e.target.value }))}
                    placeholder="Resolution notes (optional)"
                    className="flex-1 min-w-[200px] rounded-lg border border-white/10 bg-[#0A1628] px-3 py-2 text-xs text-white"
                  />
                  <button
                    onClick={() => handleSignOff(s)}
                    disabled={signedClerks[s.clerk]}
                    className="rounded-lg bg-[#00D4FF] px-3 py-2 text-xs font-medium text-[#04231A] hover:bg-[#5fe3ff] disabled:opacity-50"
                  >
                    {signedClerks[s.clerk] ? "Signed Off" : "Sign Off Shift"}
                  </button>
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
          </Tabs.Content>

          <Tabs.Content value="anomalies" className="outline-none">
            {isLoadingAdj ? (
               <Card title="Loading anomaly data…">
                 <p className="text-sm text-slate-400">Querying adjustment and refund records…</p>
               </Card>
            ) : adjustments.length === 0 && refunds.length === 0 ? (
               <Card title="No anomaly data available">
                 <p className="text-sm text-slate-400">
                   No <span className="text-slate-300">Adjustments & Refunds</span> records found for{" "}
                   <span className="text-slate-300">{propName}</span> during{" "}
                   <span className="text-slate-300">{periodLabel}</span>.
                 </p>
                 <p className="mt-2 text-sm text-slate-500">
                   Import an <span className="text-slate-300">Adjustments & Refunds Activity</span> report on the{" "}
                   <a href="/upload" className="text-[#00D4FF] underline">Import</a> page, or adjust your date range and property filters.
                 </p>
               </Card>
            ) : (
              <div className="space-y-6">
                {/* Filters */}
                <div className="flex flex-wrap items-end gap-4">
                  <label className="flex flex-col gap-1 text-xs text-slate-400">
                    Clerk
                    <select
                      value={fraudClerk}
                      onChange={(e) => setFraudClerk(e.target.value)}
                      className="min-w-[10rem] rounded-lg border border-white/10 bg-[#0A1628] px-3 py-2 text-sm text-slate-200 outline-none transition-colors focus:border-[#00D4FF]/40"
                    >
                      <option value="all">All Clerks</option>
                      {fraudClerkOptions.map((c) => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1 text-xs text-slate-400">
                    Payment Type
                    <select
                      value={fraudType}
                      onChange={(e) => setFraudType(e.target.value)}
                      className="min-w-[10rem] rounded-lg border border-white/10 bg-[#0A1628] px-3 py-2 text-sm text-slate-200 outline-none transition-colors focus:border-[#00D4FF]/40"
                    >
                      <option value="all">All Types</option>
                      {fraudTypeOptions.map((t) => (
                        <option key={t} value={t}>{t}</option>
                      ))}
                    </select>
                  </label>
                  {(fraudClerk !== "all" || fraudType !== "all") && (
                    <button
                      type="button"
                      onClick={() => { setFraudClerk("all"); setFraudType("all"); }}
                      className="rounded-lg border border-white/10 px-3 py-2 text-sm text-slate-400 outline-none transition-colors hover:border-white/20 hover:text-slate-200"
                    >
                      Clear
                    </button>
                  )}
                </div>

                <ClerkAuditMatrix
                  flaggedAnomalies={flaggedAnomalies}
                  clerkRiskScores={clerkRiskScores}
                  adjustments={fraudAdjustments}
                  refunds={fraudRefunds}
                />
              </div>
            )}
          </Tabs.Content>
        </Tabs.Root>
      )}
    </div>
  );
}