import React, { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { TrendingUp, DollarSign, Percent, Building2, BarChart3 } from "lucide-react";
import Card from "@/components/ui-exec/Card";
import KpiCard from "@/components/ui-exec/KpiCard";
import { db } from "@/api/base44Client";
import { useOccupancy } from "@/lib/useHotelData";
import { useGlobalFilters } from "@/lib/useGlobalFilters";
import { money, money2, sum, inRange, C } from "@/lib/hotel";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from "recharts";

const HORIZONS = [
  { key: "day", label: "Next Day", days: 1 },
  { key: "week", label: "Next Week", days: 7 },
  { key: "month", label: "Next Month", days: 30 },
  { key: "quarter", label: "Next Quarter", days: 90 },
];

function buildPropertyFilter(property) {
  const filter = {};
  if (property && property !== "all") {
    if (Array.isArray(property)) {
      if (property.length > 0) filter.property_id = { $in: property };
    } else {
      filter.property_id = property;
    }
  }
  return filter;
}

export default function Forecasting() {
  const { property, properties, accessibleProperties, dateRange, months, year } = useGlobalFilters();
  const { data: occ = [] } = useOccupancy(dateRange, property, months);
  const propertyKey = Array.isArray(property) ? property.join(",") : property;
  const { data: expenses = [] } = useQuery({
    queryKey: ["expenses", propertyKey],
    queryFn: () => db.entities.Expense.filter(buildPropertyFilter(property), "-expense_date", 100000),
  });
  const { data: payroll = [] } = useQuery({
    queryKey: ["payroll", propertyKey],
    queryFn: () => db.entities.PayrollRun.filter(buildPropertyFilter(property), "-pay_period_start", 100000),
  });

  const occRows = useMemo(() => occ.filter((r) => {
    if (!r.date) return false;
    const d = String(r.date).slice(0, 10);
    return d >= (dateRange.from || "") && d <= (dateRange.to || "");
  }), [occ, dateRange]);

  const propName = property === "all" ? "All Properties" : (Array.isArray(property) ? `${property.length} Properties` : (properties.find((p) => p.id === property)?.name || "Property"));

  const histStats = useMemo(() => {
    const revenue = sum(occRows, "total_revenue");
    const roomsSold = sum(occRows, "rooms_sold");
    const totalRooms = sum(occRows, "total_rooms") || (occRows.length > 0 ? (occRows[0].total_rooms || 100) : 100) * occRows.length;
    const occupancy = totalRooms > 0 ? roomsSold / totalRooms : 0;
    const adr = roomsSold > 0 ? revenue / roomsSold : 0;
    const revpar = totalRooms > 0 ? revenue / totalRooms : 0;
    const days = occRows.length || 1;
    const expInPeriod = expenses.filter((e) => inRange(e.expense_date, dateRange.from, dateRange.to));
    const payInPeriod = payroll.filter((p) => inRange(p.pay_period_start, dateRange.from, dateRange.to));
    const expenseTotal = sum(payInPeriod, "total_pay") + sum(expInPeriod, "amount");
    const dailyRevenue = revenue / days;
    const dailyExpense = days > 0 ? expenseTotal / days : 0;
    return {
      revenue, roomsSold, totalRooms, occupancy, adr, revpar, days,
      dailyRevenue, dailyExpense,
      hasExpenseData: payInPeriod.length + expInPeriod.length > 0,
    };
  }, [occRows, expenses, payroll, dateRange]);

  const [horizon, setHorizon] = useState("month");
  const [adjustments, setAdjustments] = useState({
    rateAdjust: 0,
    occupancyAdjust: 0,
    adrAdjust: 0,
    availableRooms: 100,
    otaCommission: 15,
    expenseAdjust: 0,
  });

  const horizonDays = HORIZONS.find((h) => h.key === horizon)?.days || 30;

  const forecast = useMemo(() => {
    const adjRate = 1 + (adjustments.rateAdjust || 0) / 100;
    const adjOcc = Math.min(1, Math.max(0, histStats.occupancy + (adjustments.occupancyAdjust || 0) / 100));
    const adjAdr = (histStats.adr || 50) * adjRate + (adjustments.adrAdjust || 0);
    const availableRooms = adjustments.availableRooms || 100;
    const projectedRoomsSold = Math.round(availableRooms * adjOcc * horizonDays);
    const projectedRevenue = projectedRoomsSold * adjAdr;
    const otaCommissionAmount = projectedRevenue * (adjustments.otaCommission || 0) / 100;
    const baseExpenses = histStats.hasExpenseData ? histStats.dailyExpense * horizonDays : (histStats.dailyRevenue || 0) * horizonDays * 0.65;
    const projectedExpenses = baseExpenses * (1 + (adjustments.expenseAdjust || 0) / 100);
    const netProfit = projectedRevenue - projectedExpenses - otaCommissionAmount;
    const projectedRevpar = availableRooms > 0 ? projectedRevenue / (availableRooms * horizonDays) : 0;

    return {
      revenue: projectedRevenue,
      roomsSold: projectedRoomsSold,
      occupancy: adjOcc,
      adr: adjAdr,
      revpar: projectedRevpar,
      expenses: projectedExpenses,
      otaCommission: otaCommissionAmount,
      netProfit,
      margin: projectedRevenue > 0 ? netProfit / projectedRevenue : 0,
    };
  }, [histStats, adjustments, horizonDays]);

  const comparisonData = useMemo(() => {
    const histRevenue = histStats.dailyRevenue * horizonDays;
    const histOcc = histStats.occupancy;
    const histAdr = histStats.adr;
    const histRevpar = histStats.revpar;
    const histExpenses = histStats.hasExpenseData ? histStats.dailyExpense * horizonDays : histRevenue * 0.65;

    return [
      { metric: "Revenue", historical: Math.round(histRevenue), forecast: Math.round(forecast.revenue), diff: forecast.revenue - histRevenue },
      { metric: "Rooms Sold", historical: Math.round(histStats.roomsSold / histStats.days * horizonDays), forecast: forecast.roomsSold, diff: forecast.roomsSold - Math.round(histStats.roomsSold / histStats.days * horizonDays) },
      { metric: "Occupancy", historical: histOcc, forecast: forecast.occupancy, diff: forecast.occupancy - histOcc, isPct: true },
      { metric: "ADR", historical: Math.round(histAdr), forecast: Math.round(forecast.adr), diff: forecast.adr - histAdr },
      { metric: "RevPAR", historical: Math.round(histRevpar), forecast: Math.round(forecast.revpar), diff: forecast.revpar - histRevpar },
      { metric: "Expenses", historical: Math.round(histExpenses), forecast: Math.round(forecast.expenses), diff: forecast.expenses - histExpenses },
      { metric: "Net Profit", historical: Math.round(histRevenue - histExpenses), forecast: Math.round(forecast.netProfit), diff: forecast.netProfit - (histRevenue - histExpenses) },
    ];
  }, [histStats, forecast, horizonDays]);

  const chartData = comparisonData.filter((d) => !d.isPct).map((d) => ({
    name: d.metric,
    Historical: d.historical,
    Forecast: d.forecast,
  }));

  const propOpts = (accessibleProperties.length ? accessibleProperties : properties).map((p) => [p.id, p.name]);

  return (
    <div className="space-y-6">
      <header>
        <p className="text-[11px] uppercase tracking-[0.3em] text-[#00D4FF]">Module 9</p>
        <h1 className="mt-2 font-heading text-3xl font-semibold text-white">Revenue Forecasting</h1>
        <p className="mt-1 text-sm text-slate-400">
          Project future performance based on historical data. Adjust assumptions to model scenarios.
        </p>
        <p className="mt-2 text-xs text-slate-500">
          {propName} · Based on {histStats.days} days of historical data ·{" "}
          {histStats.hasExpenseData
            ? `expenses from actual records (${money(histStats.dailyExpense)}/day)`
            : "no expense data yet — expenses assumed at 65% of revenue"}
        </p>
      </header>

      {/* Historical baseline */}
      <Card title="Historical Baseline" subtitle={`From ${dateRange.from || "—"} to ${dateRange.to || "—"}`}>
        <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
          <KpiCard label="Avg Daily Revenue" value={money(histStats.dailyRevenue)} accent={C.purple} icon={DollarSign} />
          <KpiCard label="Avg Occupancy" value={`${(histStats.occupancy * 100).toFixed(1)}%`} accent={C.cyan} icon={Percent} />
          <KpiCard label="Avg ADR" value={money2(histStats.adr)} accent={C.green} icon={DollarSign} />
          <KpiCard label="Avg RevPAR" value={money2(histStats.revpar)} accent={C.amber} icon={TrendingUp} />
          <KpiCard label="Rooms Sold/Day" value={Math.round(histStats.roomsSold / (histStats.days || 1))} accent={C.coral} icon={Building2} />
        </div>
      </Card>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Adjustment controls */}
        <Card title="Forecast Assumptions" subtitle="Adjust to model different scenarios" className="lg:col-span-1">
          <div className="space-y-4">
            <div>
              <label className="mb-1.5 block text-xs text-slate-400">Forecast Horizon</label>
              <div className="grid grid-cols-2 gap-2">
                {HORIZONS.map((h) => (
                  <button
                    key={h.key}
                    onClick={() => setHorizon(h.key)}
                    className={`rounded-lg border px-3 py-2 text-xs transition-all ${
                      horizon === h.key
                        ? "border-[#6C63FF] bg-[#6C63FF]/15 text-white"
                        : "border-white/10 text-slate-400 hover:border-white/20"
                    }`}
                  >
                    {h.label}
                  </button>
                ))}
              </div>
            </div>

            <SliderInput
              label="Rate Adjustment"
              value={adjustments.rateAdjust}
              onChange={(v) => setAdjustments({ ...adjustments, rateAdjust: v })}
              min={-50} max={100} step={5} unit="%"
              hint="Increase or decrease room rates"
            />
            <SliderInput
              label="Occupancy Adjustment"
              value={adjustments.occupancyAdjust}
              onChange={(v) => setAdjustments({ ...adjustments, occupancyAdjust: v })}
              min={-30} max={30} step={1} unit="%"
              hint="Increase or decrease occupancy"
            />
            <SliderInput
              label="ADR Adjustment ($)"
              value={adjustments.adrAdjust}
              onChange={(v) => setAdjustments({ ...adjustments, adrAdjust: v })}
              min={-50} max={100} step={5} unit="$"
              hint="Fixed ADR change on top of rate adjustment"
            />
            <SliderInput
              label="Available Rooms"
              value={adjustments.availableRooms}
              onChange={(v) => setAdjustments({ ...adjustments, availableRooms: v })}
              min={10} max={500} step={1} unit=""
              hint="Total rooms available per day"
            />
            <SliderInput
              label="OTA Commission"
              value={adjustments.otaCommission}
              onChange={(v) => setAdjustments({ ...adjustments, otaCommission: v })}
              min={0} max={30} step={1} unit="%"
              hint="Average commission on OTA bookings"
            />
            <SliderInput
              label="Expense Adjustment"
              value={adjustments.expenseAdjust}
              onChange={(v) => setAdjustments({ ...adjustments, expenseAdjust: v })}
              min={-50} max={100} step={5} unit="%"
              hint="Increase or decrease operating expenses"
            />
          </div>
        </Card>

        {/* Forecast results */}
        <div className="space-y-4 lg:col-span-2">
          <Card title={`Projected Performance — ${HORIZONS.find((h) => h.key === horizon)?.label}`} subtitle={`${horizonDays} days forecast`}>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <KpiCard label="Projected Revenue" value={money(forecast.revenue)} sub={`${horizonDays} days`} accent={C.green} icon={DollarSign} />
              <KpiCard label="Projected Net Profit" value={money(forecast.netProfit)} sub={`${(forecast.margin * 100).toFixed(1)}% margin`} accent={forecast.netProfit >= 0 ? C.green : C.coral} icon={TrendingUp} />
              <KpiCard label="Projected ADR" value={money2(forecast.adr)} accent={C.purple} icon={DollarSign} />
              <KpiCard label="Projected Occupancy" value={`${(forecast.occupancy * 100).toFixed(1)}%`} accent={C.cyan} icon={Percent} />
              <KpiCard label="Projected RevPAR" value={money2(forecast.revpar)} accent={C.amber} icon={BarChart3} />
              <KpiCard label="Projected Expenses" value={money(forecast.expenses)} sub={`OTA: ${money(forecast.otaCommission)}`} accent={C.coral} icon={DollarSign} />
            </div>
          </Card>

          {/* Comparison chart */}
          <Card title="Historical vs Forecast" subtitle="Side-by-side comparison over the forecast period">
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} margin={{ left: -10, right: 8, top: 8 }}>
                  <CartesianGrid stroke="#ffffff0a" vertical={false} />
                  <XAxis dataKey="name" tick={{ fill: "#64748b", fontSize: 10 }} stroke="#ffffff10" angle={-20} textAnchor="end" height={60} />
                  <YAxis tick={{ fill: "#64748b", fontSize: 10 }} stroke="#ffffff10" />
                  <Tooltip contentStyle={{ background: "#0A1628", border: "1px solid #ffffff14", borderRadius: 12, color: "#e2e8f0" }} formatter={(v) => money(v)} />
                  <Legend wrapperStyle={{ fontSize: 11, color: "#94a3b8" }} />
                  <Bar dataKey="Historical" fill={C.amber} radius={[4, 4, 0, 0]} />
                  <Bar dataKey="Forecast" fill={C.green} radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Card>
        </div>
      </div>

      {/* Detailed comparison table */}
      <Card title="Detailed Comparison" subtitle="Historical baseline vs forecast projection">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-widest text-slate-500">
                <th className="pb-3 pr-4">Metric</th>
                <th className="pb-3 pr-4 text-right">Historical</th>
                <th className="pb-3 pr-4 text-right">Forecast</th>
                <th className="pb-3 pr-4 text-right">Difference</th>
                <th className="pb-3 text-right">% Change</th>
              </tr>
            </thead>
            <tbody>
              {comparisonData.map((row) => (
                <tr key={row.metric} className="border-t border-white/5">
                  <td className="py-2.5 pr-4 text-slate-200">{row.metric}</td>
                  <td className="py-2.5 pr-4 text-right tabular-nums text-slate-300">
                    {row.isPct ? `${(row.historical * 100).toFixed(1)}%` : money(row.historical)}
                  </td>
                  <td className="py-2.5 pr-4 text-right tabular-nums text-white">
                    {row.isPct ? `${(row.forecast * 100).toFixed(1)}%` : money(row.forecast)}
                  </td>
                  <td className="py-2.5 pr-4 text-right tabular-nums" style={{ color: row.diff >= 0 ? C.green : C.coral }}>
                    {row.diff >= 0 ? "+" : ""}{row.isPct ? `${(row.diff * 100).toFixed(1)}%` : money(row.diff)}
                  </td>
                  <td className="py-2.5 text-right tabular-nums" style={{ color: row.diff >= 0 ? C.green : C.coral }}>
                    {row.historical !== 0 ? `${((row.diff / Math.abs(row.historical)) * 100).toFixed(1)}%` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-slate-500">
          ⚠ Forecasts are projections only and do not overwrite historical data. Adjust assumptions to model different scenarios.
        </p>
      </Card>
    </div>
  );
}

function SliderInput({ label, value, onChange, min, max, step, unit, hint }) {
  return (
    <div>
      <div className="flex items-center justify-between">
        <label className="text-xs text-slate-400">{label}</label>
        <span className="font-heading text-sm font-semibold text-white">
          {value > 0 && unit !== "$" ? "+" : ""}{unit === "$" ? `$${value}` : unit === "%" ? `${value}%` : value}
        </span>
      </div>
      <input
        type="range"
        min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-2 w-full accent-[#6C63FF]"
      />
      {hint && <p className="mt-0.5 text-[10px] text-slate-600">{hint}</p>}
    </div>
  );
}