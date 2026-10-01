import React from "react";
import { money2, pct } from "@/lib/hotel";
import { toCents, fromCents } from "@/lib/decimal";
import { propertyDisplayName } from "@/lib/propertyRecordIdentity";

export default function TaxCalculationBreakdown({ calculations = [], properties = [] }) {
  const estimates = calculations.filter(row => row.basis === "estimated");
  const remittances = calculations.filter(row => row.remittance?.marketplace || row.remittance?.stale);
  if (!estimates.length && !remittances.length) return null;
  return (
    <div className="space-y-3 rounded-xl border border-white/10 bg-white/[0.02] p-4">
      <p className="text-sm font-medium text-white">Tax calculation</p>
      <p className="text-xs leading-relaxed text-slate-400">
        Taxable room revenue after source exemptions. Each day is rounded to cents before totals are added.
      </p>
      {remittances.map((row,i) => <div key={i} className="space-y-1 border-t border-white/10 pt-2 text-xs text-slate-300"><p>{propertyDisplayName(row,properties)} ? {row.from} ? {row.to}</p><p>Hotel remittance {money2(row.remittance.hotel)} ? documented marketplace remittance {money2(row.remittance.marketplace)}</p><p>Evidence: {row.remittance.references.join(', ') || 'none matching current taxable base'}</p>{row.remittance.stale && <p className="text-amber-300">Statement evidence needs review against the current report. Unmatched amounts remain hotel liability.</p>}</div>)}
      {estimates.map(row => {
        const rate = row.rates.state + row.rates.city + row.rates.other;
        const total = fromCents(toCents(row.state) + toCents(row.city) + toCents(row.other));
        return (
          <div key={JSON.stringify([row.property_id,row.rates,row.jurisdictions?.map(j=>[j.id,j.type,j.rate])])} className="space-y-2 border-t border-white/10 pt-3">
            <p className="text-sm text-slate-200">{propertyDisplayName(row,properties)}</p>
            <p className="text-xs text-slate-400">{row.from} → {row.to} · {row.days} {row.days === 1 ? "day" : "days"}</p>
            {row.incomplete && <p className="text-xs text-amber-300">Partial estimate: configure missing rates or supply occupied room-night counts. This total is incomplete.</p>}
            {row.jurisdictions?.length > 0 ? row.jurisdictions.map(j => <p key={j.id} className="text-xs text-slate-300">{j.label}: {j.type === 'percentage' ? `${money2(j.base)} × ${pct(j.rate,2)}` : `${j.base} occupied room-nights × ${money2(j.rate)}`} = {j.amount == null ? 'needs room-night data' : money2(j.amount)} · {j.remitter}{j.confirmationRequired ? ' (marketplace evidence required)' : ''}</p>) : [["state","State Tax"],["city","City/Local Tax"],["other","Other Taxes"]].map(([key,label]) => (
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
              Combined percentage {pct(rate,2)}{row.jurisdictions?.some(j=>j.type==='flat_per_night') ? ' + room-night fees' : ''} · {money2(total)} estimated tax
            </p>
          </div>
        );
      })}
    </div>
  );
}
