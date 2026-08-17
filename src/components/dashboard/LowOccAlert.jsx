import React, { useState } from "react";
import { AlertTriangle, ChevronDown, ChevronUp, Lightbulb } from "lucide-react";
import { money, money2, pct, num, getOccThreshold } from "@/lib/hotel";

export default function LowOccAlert({ occRows, sources }) {
  const [expanded, setExpanded] = useState(null);
  const threshold = getOccThreshold();

  const lowDays = occRows
    .filter((r) => Number(r.occupancy || 0) < threshold)
    .sort((a, b) => Number(a.occupancy) - Number(b.occupancy));

  if (!lowDays.length) return null;

  const getBookings = (date) => {
    const daySources = sources.filter((s) => String(s.date).slice(0, 10) === String(date).slice(0, 10));
    return daySources.reduce((a, s) => a + (Number(s.stays) || 0), 0);
  };

  const suggestedActions = (occ) => {
    const actions = [];
    if (occ < 0.4) {
      actions.push("Launch last-minute flash sale on OTAs");
      actions.push("Offer deep discount for direct bookings tonight");
      actions.push("Consider reducing room rates by 15-20%");
    } else if (occ < threshold) {
      actions.push("Promote same-day booking discounts");
      actions.push("Reach out to corporate accounts for last-minute bookings");
      actions.push("Adjust OTA pricing to increase visibility");
    }
    actions.push("Review cancellation policy to reduce no-shows");
    return actions;
  };

  return (
    <div className="rounded-2xl border border-[#FF6B6B]/20 bg-[#FF6B6B]/[0.04] p-4">
      <div className="mb-3 flex items-center gap-2">
        <AlertTriangle className="h-5 w-5 text-[#FF6B6B]" />
        <p className="text-sm font-medium text-white">
          🔴 Low Occupancy Alert · {lowDays.length} day{lowDays.length === 1 ? "" : "s"} below {(threshold * 100).toFixed(0)}%
        </p>
      </div>

      <div className="space-y-2">
        {lowDays.slice(0, 10).map((r) => {
          const idx = expanded === r.date;
          const bookings = getBookings(r.date);
          const available = (Number(r.total_rooms) || 100) - (Number(r.rooms_sold) || 0);
          return (
            <div key={r.date} className="rounded-xl border border-white/10 bg-[#0A1628]/60">
              <button
                onClick={() => setExpanded(idx ? null : r.date)}
                className="flex w-full items-center justify-between px-4 py-3 text-left"
              >
                <div className="flex items-center gap-3">
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#FF6B6B]/15 text-xs font-semibold text-[#FF6B6B]">
                    {pct(r.occupancy, 0)}
                  </span>
                  <div>
                    <p className="text-sm text-white">{String(r.date).slice(0, 10)}</p>
                    <p className="text-xs text-slate-500">{r.property_name || ""}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-xs text-slate-400">Target: {(threshold * 100).toFixed(0)}%</span>
                  {idx ? <ChevronUp className="h-4 w-4 text-slate-400" /> : <ChevronDown className="h-4 w-4 text-slate-400" />}
                </div>
              </button>
              {idx && (
                <div className="border-t border-white/5 px-4 py-3">
                  <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
                    <div>
                      <p className="text-[10px] uppercase tracking-widest text-slate-500">Revenue</p>
                      <p className="text-sm text-white">{money(r.room_revenue)}</p>
                    </div>
                    <div>
                      <p className="text-[10px] uppercase tracking-widest text-slate-500">ADR</p>
                      <p className="text-sm text-white">{money2(r.adr)}</p>
                    </div>
                    <div>
                      <p className="text-[10px] uppercase tracking-widest text-slate-500">RevPAR</p>
                      <p className="text-sm text-white">{money2(r.revpar)}</p>
                    </div>
                    <div>
                      <p className="text-[10px] uppercase tracking-widest text-slate-500">Bookings</p>
                      <p className="text-sm text-white">{num(bookings)}</p>
                    </div>
                    <div>
                      <p className="text-[10px] uppercase tracking-widest text-slate-500">Rooms Sold</p>
                      <p className="text-sm text-white">{num(r.rooms_sold)}</p>
                    </div>
                    <div>
                      <p className="text-[10px] uppercase tracking-widest text-slate-500">Available</p>
                      <p className="text-sm text-white">{num(available)}</p>
                    </div>
                  </div>
                  <div className="mt-3 rounded-lg bg-[#FFB547]/[0.06] p-3">
                    <p className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-[#FFB547]">
                      <Lightbulb className="h-3.5 w-3.5" /> Suggested actions
                    </p>
                    <ul className="mt-2 space-y-1">
                      {suggestedActions(Number(r.occupancy)).map((a, i) => (
                        <li key={i} className="text-xs text-slate-300">• {a}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}
            </div>
          );
        })}
        {lowDays.length > 10 && (
          <p className="text-center text-xs text-slate-500">+ {lowDays.length - 10} more days below threshold</p>
        )}
      </div>
    </div>
  );
}