import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React, { useMemo } from "react";
import PieDonut from "@/components/charts/PieDonut";
import Card from "@/components/ui-exec/Card";
import { CHART_COLORS, money2, pct } from "@/lib/hotel";
import { getCcFeeRate } from "@/lib/commissionRates";
import { useSettingsVersion } from "@/hooks/useSettingsVersion";
export default function PaymentMethodChart({ payRows }) {
    const ccFee = getCcFeeRate();
    useSettingsVersion();
    const data = useMemo(() => {
        if (!payRows?.length)
            return { chart: [], totals: {} };
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
            .filter(([_, v]) => Math.abs(v.value) > 0.01)
            .map(([name, v]) => ({ name, value: v.value, isCard: v.isCard, color: v.color }))
            .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
        const totalGross = chart.reduce((a, c) => a + c.value, 0);
        const cardTotal = chart.filter((c) => c.isCard).reduce((a, c) => a + c.value, 0);
        const ccFees = cardTotal * ccFee;
        const netKept = totalGross - ccFees;
        return { chart, totals: { totalGross, cardTotal, ccFees, netKept } };
    }, [payRows, ccFee]);
    if (!data.chart.length) {
        return (_jsx(Card, { title: "Payment Method Distribution", subtitle: "Cash flow by payment type", children: _jsx("p", { className: "py-8 text-center text-sm text-slate-500", children: "No payment data for selected period" }) }));
    }
    const { chart, totals } = data;
    return (_jsx(Card, { title: "Payment Method Distribution", subtitle: `Total ${money2(totals.totalGross)} · CC fees ${money2(totals.ccFees)} (${pct(ccFee, 2)} on cards) · Net kept ${money2(totals.netKept)}`, children: _jsxs("div", { className: "grid gap-4 lg:grid-cols-2", children: [_jsx("div", { className: "h-[280px]", children: _jsx(PieDonut, { data: chart, type: "donut", height: "100%", outerRadius: 90, formatter: money2 }) }), _jsxs("div", { className: "space-y-2", children: [chart.map((c) => (_jsxs("div", { className: "flex items-center gap-3 rounded-lg bg-white/[0.03] px-3 py-2", children: [_jsx("div", { className: "h-3 w-3 shrink-0 rounded-full", style: { background: c.color } }), _jsxs("span", { className: "flex-1 text-sm text-slate-200", children: [c.name, c.isCard && _jsxs("span", { className: "ml-1 text-[10px] text-slate-500", children: ["\u00B7 ", pct(ccFee, 1), " fee"] })] }), _jsx("span", { className: "text-right text-sm font-medium tabular-nums text-white", children: money2(c.value) }), _jsx("span", { className: "w-20 text-right text-xs tabular-nums text-slate-400", children: c.isCard ? money2(c.value * (1 - ccFee)) : money2(c.value) })] }, c.name))), _jsxs("div", { className: "mt-3 border-t border-white/5 pt-3", children: [_jsxs("div", { className: "flex justify-between text-sm", children: [_jsx("span", { className: "text-slate-400", children: "CC/Debit processing fees" }), _jsxs("span", { className: "tabular-nums text-[#FF6B6B]", children: ["-", money2(totals.ccFees)] })] }), _jsxs("div", { className: "mt-1 flex justify-between text-sm font-medium", children: [_jsx("span", { className: "text-slate-300", children: "Net kept (after fees)" }), _jsx("span", { className: "tabular-nums text-[#00E096]", children: money2(totals.netKept) })] })] })] })] }) }));
}
