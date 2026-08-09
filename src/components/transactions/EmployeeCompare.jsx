import React, { useMemo, useState } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from "recharts";
import Card from "@/components/ui-exec/Card";
import { money, money2, num, C } from "@/lib/hotel";
import { compareEmployees, employeeStats, GRAINS } from "@/lib/transactionAnalytics";

const tip = { background: "#0A1628", border: "1px solid #ffffff14", borderRadius: 12, color: "#e2e8f0" };
const axis = { fill: "#64748b", fontSize: 10 };

const CLASS_LABEL = {
  staff: "On-property staff",
  agency: "Contact centre",
  brand: "Brand / corporate",
  system: "Automation",
};

// Which metrics read as money vs counts. compareEmployees returns raw numbers so
// the formatting decision lives here, next to the labels.
const FORMAT = {
  revenue: money,
  collected: money,
  avgTicket: money2,
  avgPerDay: money,
  chargeCount: num,
  days: num,
  folios: num,
};

function Delta({ value, pct, format }) {
  if (!value) return <span className="text-xs text-slate-500">even</span>;
  const up = value > 0;
  return (
    <span className="text-xs font-medium tabular-nums" style={{ color: up ? C.green : C.coral }}>
      {up ? "+" : "−"}
      {format(Math.abs(value))}
      {pct !== null && pct !== undefined && Number.isFinite(pct) && (
        <span className="ml-1 text-slate-500">({up ? "+" : "−"}{Math.abs(pct).toFixed(0)}%)</span>
      )}
    </span>
  );
}

function Picker({ label, value, onChange, options, accent }) {
  return (
    <label className="flex-1">
      <span className="mb-1.5 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.14em] text-slate-400">
        <span className="h-2 w-2 rounded-full" style={{ background: accent }} />
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-10 w-full rounded-lg border border-white/10 bg-[#0A1628] px-3 text-sm text-slate-200 outline-none transition-colors focus:border-[#6C63FF]"
      >
        {options.map((o) => (
          <option key={o.username} value={o.username}>
            {o.label} · {money(o.revenue)}
          </option>
        ))}
      </select>
    </label>
  );
}

// Two people, side by side, over the selected period.
//
// System accounts are offered here but never preselected: `hkcrsuser` and
// `hkiotuser` are unattended automation that out-post every human, so putting
// one of them in a staff comparison by default would be misleading.
export default function EmployeeCompare({ rows = [], grain = "monthly" }) {
  const [includeSystem, setIncludeSystem] = useState(false);
  const [seriesGrain, setSeriesGrain] = useState(grain);

  const people = useMemo(() => employeeStats(rows, { includeSystem }), [rows, includeSystem]);
  const [aUser, setAUser] = useState("");
  const [bUser, setBUser] = useState("");

  // Default to the top two once data arrives, without stomping a user's choice.
  const a = aUser || people[0]?.username || "";
  const b = bUser || people[1]?.username || "";

  const cmp = useMemo(
    () => (a && b ? compareEmployees(rows, a, b, seriesGrain) : null),
    [rows, a, b, seriesGrain]
  );

  if (people.length < 2) {
    return (
      <Card title="Head to head" subtitle="Compare two people over the selected period">
        <p className="text-sm text-slate-500">
          Need at least two accounts in this period to compare. Widen the date range or include automation accounts.
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card
        title="Head to head"
        subtitle="Same period, same rules — revenue counts the charge side only"
        right={
          <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-400">
            <input
              type="checkbox"
              checked={includeSystem}
              onChange={(e) => { setIncludeSystem(e.target.checked); setAUser(""); setBUser(""); }}
              className="h-3.5 w-3.5 rounded border-white/20 bg-[#0A1628] accent-[#6C63FF]"
            />
            Include automation
          </label>
        }
      >
        <div className="flex flex-col gap-3 sm:flex-row">
          <Picker label="Person A" value={a} onChange={setAUser} options={people} accent={C.purple} />
          <Picker label="Person B" value={b} onChange={setBUser} options={people} accent={C.cyan} />
        </div>

        {cmp?.mismatch && (
          <p className="mt-3 rounded-xl border border-[#FFB547]/20 bg-[#FFB547]/5 px-3 py-2 text-xs text-[#FFB547]">
            Different account types — {CLASS_LABEL[cmp.a.account_class] || cmp.a.account_class} vs{" "}
            {CLASS_LABEL[cmp.b.account_class] || cmp.b.account_class}. These roles do different jobs, so the gap is not a
            performance difference.
          </p>
        )}

        {cmp && (
          <div className="mt-5 overflow-x-auto">
            <table className="w-full min-w-[520px] text-sm">
              <thead>
                <tr className="border-b border-white/5 text-left">
                  <th className="pb-2 text-[11px] font-medium uppercase tracking-[0.14em] text-slate-500">Metric</th>
                  <th className="pb-2 text-right text-[11px] font-medium uppercase tracking-[0.14em]" style={{ color: C.purple }}>
                    {cmp.a.label}
                  </th>
                  <th className="pb-2 text-right text-[11px] font-medium uppercase tracking-[0.14em]" style={{ color: C.cyan }}>
                    {cmp.b.label}
                  </th>
                  <th className="pb-2 text-right text-[11px] font-medium uppercase tracking-[0.14em] text-slate-500">
                    A − B
                  </th>
                </tr>
              </thead>
              <tbody>
                {cmp.metrics.map((m) => {
                  const fmt = FORMAT[m.key] || num;
                  const aWins = m.delta > 0;
                  return (
                    <tr key={m.key} className="border-b border-white/5 last:border-0">
                      <td className="py-2.5 text-slate-300">{m.label}</td>
                      <td
                        className="py-2.5 text-right tabular-nums"
                        style={{ color: m.delta !== 0 && aWins ? "#fff" : "#94a3b8", fontWeight: m.delta !== 0 && aWins ? 600 : 400 }}
                      >
                        {fmt(m.a)}
                      </td>
                      <td
                        className="py-2.5 text-right tabular-nums"
                        style={{ color: m.delta !== 0 && !aWins ? "#fff" : "#94a3b8", fontWeight: m.delta !== 0 && !aWins ? 600 : 400 }}
                      >
                        {fmt(m.b)}
                      </td>
                      <td className="py-2.5 text-right">
                        <Delta value={m.delta} pct={m.pct} format={fmt} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {cmp && cmp.series.length > 0 && (
        <Card
          title="Revenue written over time"
          subtitle="Charge side, by period"
          right={
            <div className="flex gap-1 rounded-lg bg-[#0A1628] p-1">
              {GRAINS.map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setSeriesGrain(key)}
                  className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                    seriesGrain === key ? "bg-[#6C63FF] text-white" : "text-slate-400 hover:text-slate-200"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          }
        >
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={cmp.series} margin={{ left: -12, right: 8, top: 8 }}>
                <CartesianGrid stroke="#ffffff0a" vertical={false} />
                <XAxis dataKey="name" tick={axis} stroke="#ffffff10" />
                <YAxis tick={axis} stroke="#ffffff10" tickFormatter={(v) => `${Math.round(v / 1000)}k`} />
                <Tooltip contentStyle={tip} formatter={(v) => money(v)} cursor={{ fill: "#ffffff06" }} />
                <Legend wrapperStyle={{ fontSize: 11, color: "#94a3b8" }} />
                <Bar dataKey={cmp.a.label} fill={C.purple} radius={[4, 4, 0, 0]} />
                <Bar dataKey={cmp.b.label} fill={C.cyan} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
      )}
    </div>
  );
}
