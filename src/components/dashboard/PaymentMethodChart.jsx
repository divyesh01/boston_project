import React, { useMemo } from "react";
import PieDonut from "@/components/charts/PieDonut";
import Card from "@/components/ui-exec/Card";
import { CHART_COLORS, money2 } from "@/lib/hotel";
import { useSettingsVersion } from "@/hooks/useSettingsVersion";
import { CalculationService } from "@/lib/calculationService";
import { fromCents, toCents, sumCents } from "@/lib/decimal";

export default function PaymentMethodChart({ payRows = [] }) {
  const settingsVersion = useSettingsVersion();

  const data = useMemo(() => {
    if (!payRows?.length) return { chart: [], totals: {} };
    const sums = {
      Cash: { value: 0, isCard: false, color: CHART_COLORS[2] },
      Visa: { value: 0, isCard: true, color: CHART_COLORS[0] },
      Mastercard: { value: 0, isCard: true, color: CHART_COLORS[3] },
      Amex: { value: 0, isCard: true, color: CHART_COLORS[1] },
      Discover: { value: 0, isCard: true, color: CHART_COLORS[4] },
      "Direct Bill": { value: 0, isCard: false, color: CHART_COLORS[5] },
      Check: { value: 0, isCard: false, color: CHART_COLORS[6] },
      Other: { value: 0, isCard: false, color: CHART_COLORS[7] },
    };

    payRows.forEach((r) => {
      sums.Cash.value += Number(r.cash) || 0;
      sums.Visa.value += Number(r.visa) || 0;
      sums.Mastercard.value += Number(r.master) || 0;
      sums.Amex.value += Number(r.amex) || 0;
      sums.Discover.value += Number(r.discover) || 0;
      sums["Direct Bill"].value += Number(r.direct_bill) || 0;
      sums.Check.value += Number(r.check) || 0;
      const otherSum = (Number(r.closed_balance_folio) || 0) + (Number(r.corpay) || 0) +
        (Number(r.loyalty_certificate) || 0) + (Number(r.loyalty_discount) || 0) +
        (Number(r.vip_pass) || 0) + (Number(r.wire_transfer) || 0) + (Number(r.other) || 0);
      sums.Other.value += otherSum;
    });

    // Filter out zero values
    const chart = Object.entries(sums)
      .filter(([_, v]) => Math.abs(v.value) >= 0.01)
      .map(([name, v]) => ({ name, value: v.value, isCard: v.isCard, color: v.color, feeCents:0 }))
      .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));

    const totalGross = fromCents(sumCents(chart.map((c) => c.value)));
    const { cardTotal, fee: ccFees, methodFeeCents } = CalculationService.calculateCardFees(payRows);
    const netKept = fromCents(toCents(totalGross) - toCents(ccFees));

    const methods = {Visa:"visa",Mastercard:"master",Amex:"amex",Discover:"discover"};
    for (const row of chart) row.feeCents = methodFeeCents[methods[row.name]] || 0;
    return { chart, totals: { totalGross, cardTotal, ccFees, netKept } };
  }, [payRows, settingsVersion]);

  if (!data.chart.length) {
    return (
      <Card title="Payment Method Distribution" subtitle="Cash flow by payment type">
        <p className="py-8 text-center text-sm text-slate-500">No payment data for selected period</p>
      </Card>
    );
  }

  const { chart, totals } = data;

  return (
    <Card
      title="Payment Method Distribution"
      subtitle={`Total ${money2(totals.totalGross)} · CC fees ${money2(totals.ccFees)} (configured property rates) · Net kept ${money2(totals.netKept)}`}
    >
      {/* Big single donut — every category labelled on the chart */}
      <div className="h-[700px]">
        <PieDonut data={chart} type="donut" height="100%" formatter={money2} showLegend={false} />
      </div>

      {/* Per-category gross vs net (after card fees) */}
      <div className="mt-6 grid gap-x-8 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
        {chart.map((c) => (
          <div key={c.name} className="flex items-center gap-3 rounded-lg bg-white/[0.03] px-3 py-2.5">
            <div className="h-3.5 w-3.5 shrink-0 rounded-full" style={{ background: c.color }} />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-slate-200">
                {c.name}
                {c.isCard && <span className="ml-1.5 text-xs text-slate-500">· configured fee</span>}
              </div>
              <div className="text-sm font-semibold tabular-nums text-white">{money2(c.value)}</div>
            </div>
            <div className="shrink-0 text-right">
              <div className="text-xs text-slate-400">after fees</div>
              <div className="text-sm tabular-nums text-[#00E096]">
                {c.isCard ? money2(fromCents(toCents(c.value) - c.feeCents)) : money2(c.value)}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Fee summary */}
      <div className="mt-6 border-t border-white/10 pt-5">
        <div className="flex justify-between text-base">
          <span className="text-slate-400">CC/Debit processing fees</span>
          <span className="tabular-nums text-[#FF6B6B]">-{money2(totals.ccFees)}</span>
        </div>
        <div className="mt-1 flex justify-between text-base font-semibold">
          <span className="text-slate-300">Net kept (after fees)</span>
          <span className="tabular-nums text-[#00E096]">{money2(totals.netKept)}</span>
        </div>
      </div>
    </Card>
  );
}