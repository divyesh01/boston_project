import React from "react";
import { money, num, C } from "@/lib/hotel";

// The two-sided ledger, stated plainly.
//
// A PMS ledger posts money twice: once when it is billed to the folio (the
// charge side) and once when it is settled (the payment side, which this export
// labels REFUND). Adding both together is the single easiest way to misread
// this file — it overstates revenue by ~31% — so the page leads with the two
// sides shown separately rather than burying the distinction in a tooltip.
//
// The bar widths are proportional to each side, which makes the gap between
// what was billed and what settled inside the selected window legible at a
// glance without asking the reader to compare two numbers.
export default function LedgerStrip({ revenue = 0, collected = 0, methods = [], chargeCount = 0, paymentCount = 0 }) {
  const total = revenue + collected;
  const billedPct = total > 0 ? (revenue / total) * 100 : 50;
  const methodTotal = methods.reduce((a, m) => a + m.value, 0);

  return (
    <div className="rounded-2xl border border-white/5 bg-[#0F1F35]/80 p-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h3 className="font-heading text-sm font-semibold tracking-wide text-white">Both sides of the ledger</h3>
          <p className="mt-1 text-xs text-slate-400">
            Charges are what guests were billed. Settlements are what was taken in. They are separate figures — adding
            them together double-counts.
          </p>
        </div>
        <p className="text-xs text-slate-500 tabular-nums">
          {num(chargeCount)} charges · {num(paymentCount)} settlements
        </p>
      </div>

      <div className="mt-5 flex h-3 overflow-hidden rounded-full bg-[#0A1628]">
        <div
          className="h-full transition-all duration-500"
          style={{ width: `${billedPct}%`, background: `linear-gradient(90deg, ${C.purple}, ${C.purple}cc)` }}
        />
        <div
          className="h-full transition-all duration-500"
          style={{ width: `${100 - billedPct}%`, background: `linear-gradient(90deg, ${C.cyan}aa, ${C.cyan})` }}
        />
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full" style={{ background: C.purple }} />
            <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-slate-400">Revenue billed</p>
          </div>
          <p className="mt-1 font-heading text-2xl font-semibold tabular-nums text-white">{money(revenue)}</p>
        </div>
        <div>
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full" style={{ background: C.cyan }} />
            <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-slate-400">Settlements recorded</p>
          </div>
          <p className="mt-1 font-heading text-2xl font-semibold tabular-nums text-white">{money(collected)}</p>
          {methodTotal > 0 && (
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
              {methods.slice(0, 4).map((m) => (
                <span key={m.name} className="text-[11px] text-slate-400 tabular-nums">
                  {m.name} {Math.round((m.value / methodTotal) * 100)}%
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
