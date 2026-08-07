import React, { useMemo, useState } from "react";
import Card from "@/components/ui-exec/Card";
import { money, money2, C } from "@/lib/hotel";
import { AlertTriangle, CheckCircle2, Filter } from "lucide-react";

export default function ClerkAudit({ records }) {
  const [showFlaggedOnly, setShowFlaggedOnly] = useState(false);

  const payments = records.filter((r) => r.record_type === "payment");
  const drops = records.filter((r) => r.record_type === "drop");
  const clerkPayments = records.filter((r) => r.record_type === "clerk_payment");

  const cashPayment = payments.find((r) => (r.payment_type || "").toUpperCase() === "CASH");
  const cashCollected = Number(cashPayment?.net_today || cashPayment?.adjusted || 0);
  const cashAdjusted = Number(cashPayment?.adjusted || cashPayment?.net_today || 0);

  const electronicPayments = payments
    .filter((r) => (r.payment_type || "").toUpperCase() !== "CASH")
    .reduce((a, r) => a + Number(r.net_today || r.adjusted || 0), 0);

  const totalShiftActivity = cashCollected + electronicPayments;
  const totalDrops = drops.reduce((a, d) => a + Number(d.amount || 0), 0);
  const expectedCashDrop = cashAdjusted;
  const actualCashDrop = totalDrops;
  const variance = expectedCashDrop - actualCashDrop;

  const status = !drops.length
    ? "Missing"
    : Math.abs(variance) < 1
    ? "Matched"
    : variance > 0
    ? "Short"
    : "Over";

  const statusColor = {
    Matched: C.green,
    Short: C.coral,
    Over: C.amber,
    Missing: C.coral,
  }[status];

  const byClerk = useMemo(() => {
    const map = new Map();
    drops.forEach((d) => {
      const k = d.clerk_name || "Unknown";
      const cur = map.get(k) || { clerk: k, drops: 0, dropCount: 0, last: "", cashCollected: 0 };
      cur.drops += Number(d.amount) || 0;
      cur.dropCount += 1;
      if ((d.shift_date || "") > cur.last) cur.last = d.shift_date || "";
      map.set(k, cur);
    });
    clerkPayments.forEach((r) => {
      if ((r.payment_type || "").toUpperCase() === "CASH") {
        const k = r.clerk_name || "Unknown";
        if (!map.has(k)) map.set(k, { clerk: k, drops: 0, dropCount: 0, last: "", cashCollected: 0 });
        map.get(k).cashCollected += Number(r.amount) || 0;
      }
    });
    return [...map.values()];
  }, [drops, clerkPayments]);

  const clerks = byClerk
    .map((c) => {
      const expected = c.cashCollected || (byClerk.length === 1 ? cashAdjusted : c.drops);
      return { ...c, expected, variance: expected - c.drops };
    })
    .sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance));

  const flaggedClerks = clerks.filter((c) => Math.abs(c.variance) > 1);
  const displayClerks = showFlaggedOnly ? flaggedClerks : clerks;

  return (
    <Card
      title="Clerk Cash & Shift Audit"
      subtitle="Cash-only deposit reconciliation · electronic payments excluded"
      right={
        <div className="flex items-center gap-2">
          {flaggedClerks.length > 0 && (
            <button
              onClick={() => setShowFlaggedOnly(!showFlaggedOnly)}
              className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs ${
                showFlaggedOnly ? "bg-[#FF6B6B]/15 text-[#FF6B6B]" : "bg-white/5 text-slate-400"
              }`}
            >
              <Filter className="h-3 w-3" />
              {showFlaggedOnly ? `Flagged (${flaggedClerks.length})` : `All (${clerks.length})`}
            </button>
          )}
          <span
            className="flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium"
            style={{ background: `${statusColor}1a`, color: statusColor }}
          >
            {status === "Matched" ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
            {status}
          </span>
        </div>
      }
    >
      <div className="mb-4 grid grid-cols-2 gap-3 text-xs">
        <div className="rounded-lg border border-white/5 bg-[#0A1628]/60 p-3">
          <p className="text-slate-500">Total shift activity</p>
          <p className="font-heading text-lg text-white">{money2(totalShiftActivity)}</p>
        </div>
        <div className="rounded-lg border border-white/5 bg-[#0A1628]/60 p-3">
          <p className="text-slate-500">Electronic payments</p>
          <p className="font-heading text-lg text-slate-300">{money2(electronicPayments)}</p>
        </div>
        <div className="rounded-lg border border-white/5 bg-[#0A1628]/60 p-3">
          <p className="text-slate-500">Expected cash drop</p>
          <p className="font-heading text-lg text-white">{money2(expectedCashDrop)}</p>
        </div>
        <div className="rounded-lg border border-white/5 bg-[#0A1628]/60 p-3">
          <p className="text-slate-500">Actual cash drop</p>
          <p className="font-heading text-lg text-[#00D4FF]">{money2(actualCashDrop)}</p>
        </div>
      </div>

      {Math.abs(variance) >= 1 && (
        <div className="mb-4 flex items-center gap-3 rounded-xl border border-[#FF6B6B]/20 bg-[#FF6B6B]/[0.05] p-3">
          <AlertTriangle className="h-4 w-4 shrink-0 text-[#FF6B6B]" />
          <p className="text-sm font-bold text-[#FF6B6B]">
            Cash Variance: {variance > 0 ? "-" : "+"}
            {money2(Math.abs(variance))}
          </p>
          <span className="ml-auto text-xs text-slate-400">
            {variance > 0 ? "Short by" : "Over by"} {money2(Math.abs(variance))}
          </span>
        </div>
      )}

      <div className="space-y-2">
        {displayClerks.map((c) => {
          const isFlagged = Math.abs(c.variance) > 1;
          return (
            <div
              key={c.clerk}
              className={`flex items-center justify-between rounded-xl border px-4 py-3 transition-colors ${
                isFlagged ? "border-[#FF6B6B]/20 bg-[#FF6B6B]/[0.05]" : "border-white/5 bg-[#0A1628]/60 hover:border-white/10"
              }`}
            >
              <div>
                <p className="text-sm text-white">{c.clerk}</p>
                <p className="text-xs text-slate-500">
                  {c.dropCount} drop{c.dropCount === 1 ? "" : "s"} · last {c.last || "—"}
                </p>
                {isFlagged && (
                  <p className="mt-0.5 text-xs text-[#FF6B6B]">
                    {c.variance > 0 ? "Short by" : "Over by"} {money2(Math.abs(c.variance))}
                  </p>
                )}
              </div>
              <div className="text-right">
                <p className="font-heading text-base tabular-nums text-[#00D4FF]">{money2(c.drops)}</p>
                {isFlagged && (
                  <p className="text-xs tabular-nums text-slate-500">vs {money2(c.expected)}</p>
                )}
              </div>
            </div>
          );
        })}
        {!displayClerks.length && <p className="text-sm text-slate-500">No cash drops imported yet.</p>}
      </div>
    </Card>
  );
}