import React from "react";
import { money2, pct } from "@/lib/hotel";
import { toCents, fromCents } from "@/lib/decimal";
import { propertyDisplayName } from "@/lib/propertyRecordIdentity";

export default function TaxCalculationBreakdown({ calculations = [], properties = [] }) {
  const estimates = calculations.filter(row => row.basis === "estimated");
  if (!estimates.length) return null;
  return (
    <div className="space-y-3 rounded-xl border border-white/10 bg-white/[0.02] p-4">
      <p className="text-sm font-medium text-white">Tax calculation</p>
      <p className="text-xs leading-relaxed text-slate-400">
        Taxable room revenue after source exemptions. Each day is rounded to cents before totals are added.
      </p>
      {estimates.map(row => {
        const rate = row.rates.state + row.rates.city + row.rates.other;
        const total = fromCents(toCents(row.state) + toCents(row.city) + toCents(row.other));
        return (
          <div key={JSON.stringify([row.property_id,row.rates])} className="space-y-2 border-t border-white/10 pt-3">
            <p className="text-sm text-slate-200">{propertyDisplayName(row,properties)}</p>
            <p className="text-xs text-slate-400">{row.from} → {row.to} · {row.days} {row.days === 1 ? "day" : "days"}</p>
            {[["state","State Tax"],["city","City/Local Tax"],["other","Other Taxes"]].map(([key,label]) => (
              <div key={key} className="space-y-1 text-xs leading-relaxed text-slate-300">
                <p className="font-medium">{label} ({pct(row.rates[key],2)})</p>
                <p className="break-words tabular-nums">
                  {money2(row.base)} × {pct(row.rates[key],2)}
                  {row.rounding[key] !== 0 && <> {row.rounding[key] > 0 ? "+" : "−"} {money2(Math.abs(row.rounding[key]))} daily rounding</>}
                  {" = "}<span className="text-white">{money2(row[key])}</span>
                </p>
              </div>
            ))}
            <p className="border-t border-white/10 pt-2 text-sm font-medium tabular-nums text-amber-300">
              Combined {pct(rate,2)} · {money2(total)} estimated tax
            </p>
          </div>
        );
      })}
    </div>
  );
}
