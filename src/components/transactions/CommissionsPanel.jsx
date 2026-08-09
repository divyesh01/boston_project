import React, { useMemo } from "react";
import { Link } from "react-router-dom";
import { CreditCard, ExternalLink, Info } from "lucide-react";
import Card from "@/components/ui-exec/Card";
import KpiCard from "@/components/ui-exec/KpiCard";
import { money, money2, num, pct, C, commissionFor, inRange } from "@/lib/hotel";
import { getCcFeeRate } from "@/lib/commissionRates";
import { cardFeeBreakdown } from "@/lib/transactionAnalytics";

// Commissions and fees, split by what the data can actually support.
//
// Two costs, two different sources, deliberately not merged:
//
//   1. Card processing fees come straight out of this ledger. The settlement
//      side names its instrument (FPCC = folio payment, credit card), so the
//      fee is settled card volume x the configured rate. Attributable to the
//      person who took the payment.
//
//   2. Channel/OTA commission cannot be derived from this ledger. The
//      transaction export carries no channel column — Outlet Name, Group Name
//      and House Account Name are blank on all 16,921 rows, and Company Name is
//      a direct-bill account, not a booking source. So channel commission is
//      read from the channel report (SourceDay) for the same dates and labelled
//      as such, rather than invented per transaction.
//
// Presenting a fabricated per-transaction channel split would look more
// complete and be wrong, so the boundary is stated in the UI instead of hidden.
export default function CommissionsPanel({ rows = [], sourceRows = [], dateRange }) {
  const feeRate = getCcFeeRate();

  const cards = useMemo(
    () => cardFeeBreakdown(rows, feeRate, { byEmployee: true }),
    [rows, feeRate]
  );

  // Channel commission over the same window, using the app's existing rules.
  // commissionFor() re-reads localStorage on every call, so it is resolved once
  // per channel here rather than once per row.
  const channels = useMemo(() => {
    const inWindow = dateRange?.from && dateRange?.to
      ? sourceRows.filter((r) => inRange(r.date, dateRange.from, dateRange.to))
      : sourceRows;

    const byChannel = new Map();
    for (const r of inWindow) {
      const key = r.source || r.code || "(unknown)";
      let e = byChannel.get(key);
      if (!e) { e = { name: key, revenue: 0, stays: 0 }; byChannel.set(key, e); }
      e.revenue += Number(r.net_revenue) || 0;
      e.stays += Number(r.stays) || 0;
    }

    return [...byChannel.values()]
      .map((e) => {
        const rule = commissionFor(e.name);
        let commission = 0;
        if (rule.type === "percentage") commission = e.revenue * rule.rate;
        else if (rule.type === "fixed") commission = rule.rate * e.stays;
        else if (rule.type === "actual") commission = rule.rate;
        return { ...e, rule, commission };
      })
      .filter((e) => e.revenue > 0 || e.stays > 0)
      .sort((a, b) => b.commission - a.commission);
  }, [sourceRows, dateRange]);

  const channelTotal = channels.reduce((a, c) => a + c.commission, 0);
  const channelRevenue = channels.reduce((a, c) => a + c.revenue, 0);
  const totalCost = cards.fee + channelTotal;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard label="Card fees" value={money2(cards.fee)} sub={`${pct(cards.rate, 2)} of ${money(cards.settled)} settled`} accent={C.coral} icon={CreditCard} />
        <KpiCard label="Channel commission" value={money(channelTotal)} sub={channels.length ? `${channels.length} channels in range` : "No channel data in range"} accent={C.amber} />
        <KpiCard label="Total cost of sale" value={money(totalCost)} sub="Card fees + channel commission" accent={C.purple} />
        <KpiCard label="Card settlements" value={num(cards.count)} sub={`of ${money(cards.settled)} taken on card`} accent={C.cyan} />
      </div>

      <Card
        title="Card processing fees"
        subtitle={`Settled card volume x ${pct(cards.rate, 2)} — change the rate in Settings`}
      >
        {cards.count === 0 ? (
          <p className="text-sm text-slate-500">No card settlements in this period.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-sm">
              <thead>
                <tr className="border-b border-white/5 text-left">
                  <th className="pb-2 text-[11px] font-medium uppercase tracking-[0.14em] text-slate-500">Taken by</th>
                  <th className="pb-2 text-right text-[11px] font-medium uppercase tracking-[0.14em] text-slate-500">Payments</th>
                  <th className="pb-2 text-right text-[11px] font-medium uppercase tracking-[0.14em] text-slate-500">Card volume</th>
                  <th className="pb-2 text-right text-[11px] font-medium uppercase tracking-[0.14em] text-slate-500">Fee</th>
                </tr>
              </thead>
              <tbody>
                {cards.byEmployee.slice(0, 12).map((e) => (
                  <tr key={e.username} className="border-b border-white/5 last:border-0">
                    <td className="py-2.5 text-slate-300">{e.label}</td>
                    <td className="py-2.5 text-right tabular-nums text-slate-400">{num(e.count)}</td>
                    <td className="py-2.5 text-right tabular-nums text-slate-200">{money(e.settled)}</td>
                    <td className="py-2.5 text-right tabular-nums" style={{ color: C.coral }}>{money2(e.fee)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-white/10">
                  <td className="pt-2.5 font-medium text-white">Total</td>
                  <td className="pt-2.5 text-right tabular-nums text-slate-300">{num(cards.count)}</td>
                  <td className="pt-2.5 text-right font-medium tabular-nums text-white">{money(cards.settled)}</td>
                  <td className="pt-2.5 text-right font-medium tabular-nums" style={{ color: C.coral }}>{money2(cards.fee)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Card>

      <Card
        title="Channel commission"
        subtitle="From the channel report for these dates"
        right={
          <Link to="/ota" className="flex items-center gap-1.5 text-xs text-[#00D4FF] transition-colors hover:text-white">
            OTA Channels <ExternalLink className="h-3 w-3" />
          </Link>
        }
      >
        <div className="mb-4 flex gap-2.5 rounded-xl border border-white/5 bg-[#0A1628]/60 p-3">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-500" />
          <p className="text-xs leading-relaxed text-slate-400">
            The transaction ledger records what was billed and settled, not where the booking came from — it has no
            channel column. These figures therefore come from the channel report over the same dates, and cannot be
            broken down per transaction or per clerk.
          </p>
        </div>

        {channels.length === 0 ? (
          <p className="text-sm text-slate-500">No channel revenue recorded for this date range.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-b border-white/5 text-left">
                  <th className="pb-2 text-[11px] font-medium uppercase tracking-[0.14em] text-slate-500">Channel</th>
                  <th className="pb-2 text-right text-[11px] font-medium uppercase tracking-[0.14em] text-slate-500">Revenue</th>
                  <th className="pb-2 text-right text-[11px] font-medium uppercase tracking-[0.14em] text-slate-500">Rate</th>
                  <th className="pb-2 text-right text-[11px] font-medium uppercase tracking-[0.14em] text-slate-500">Commission</th>
                </tr>
              </thead>
              <tbody>
                {channels.slice(0, 12).map((c) => (
                  <tr key={c.name} className="border-b border-white/5 last:border-0">
                    <td className="py-2.5 text-slate-300">{c.name}</td>
                    <td className="py-2.5 text-right tabular-nums text-slate-200">{money(c.revenue)}</td>
                    <td className="py-2.5 text-right tabular-nums text-slate-400">
                      {c.rule.type === "percentage" ? pct(c.rule.rate, 1)
                        : c.rule.type === "fixed" ? `${money2(c.rule.rate)}/night`
                        : c.rule.type === "actual" ? "Actual"
                        : "—"}
                    </td>
                    <td className="py-2.5 text-right tabular-nums" style={{ color: c.commission > 0 ? C.amber : "#64748b" }}>
                      {c.commission > 0 ? money(c.commission) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-white/10">
                  <td className="pt-2.5 font-medium text-white">Total</td>
                  <td className="pt-2.5 text-right font-medium tabular-nums text-white">{money(channelRevenue)}</td>
                  <td />
                  <td className="pt-2.5 text-right font-medium tabular-nums" style={{ color: C.amber }}>{money(channelTotal)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
