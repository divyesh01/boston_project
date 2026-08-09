import React, { useMemo } from "react";
import Card from "@/components/ui-exec/Card";
import { useOccupancy } from "@/lib/useHotelData";
import { C, num, pct, money, money2, avg, inventoryInScope, occupancyStats } from "@/lib/hotel";
import { useGlobalFilters } from "@/lib/useGlobalFilters";

// NOTE ON WHAT THIS PAGE CAN AND CANNOT SHOW.
//
// The imported data is daily aggregates: rooms_sold, down_rooms, occupancy and
// revenue per business date. There is no per-room record anywhere in the schema,
// so a live housekeeping board (room 214 = dirty) is not derivable.
//
// This page used to render a numbered grid of `propRooms` tiles and colour them
// by array index — rooms 1..avgOccupied "occupied", the next block "vacant", the
// remainder "out of order". That looked exactly like a real room-status board
// and was pure decoration: room numbers were positional, not actual. It has been
// replaced with a proportional mix bar plus an explicit statement of what the
// data does and does not cover.
export default function RoomBoard() {
  const { dateRange, property, properties, months } = useGlobalFilters();
  const { data: occ = [], isLoading } = useOccupancy(dateRange, property, months);

  const isPortfolio = property === "all" || Array.isArray(property);
  const inventory = inventoryInScope(property, properties);
  const propName = isPortfolio
    ? (Array.isArray(property) ? `${property.length} Properties` : "Portfolio")
    : (properties.find((p) => p.id === property)?.name || "Property");

  const stats = useMemo(() => {
    if (!occ.length) {
      return { avgOccupied: 0, avgOoo: 0, avgVacant: 0, occupancy: 0, adr: 0, days: 0, downNights: 0, oooLoss: 0 };
    }
    const s = occupancyStats(occ, properties);
    const avgOccupied = Math.round(avg(occ, "rooms_sold"));
    const avgOoo = Math.round(avg(occ, "down_rooms"));
    // Out-of-service room-nights across the period, and the revenue they could
    // have earned at the ADR actually achieved. Both sides are real imported
    // figures — no assumed capture rate.
    const downNights = occ.reduce((a, r) => a + (Number(r.down_rooms) || 0), 0);
    return {
      avgOccupied,
      avgOoo,
      avgVacant: Math.max(0, inventory - avgOccupied - avgOoo),
      occupancy: s.occupancy,
      adr: s.adr,
      days: s.days,
      downNights,
      oooLoss: downNights * s.adr,
    };
  }, [occ, properties, inventory]);

  if (isLoading) return <p className="text-slate-500">Loading property board…</p>;

  const mix = [
    ["Occupied", stats.avgOccupied, C.purple],
    ["Vacant", stats.avgVacant, C.green],
    ["Out of service", stats.avgOoo, C.coral],
  ].filter(([, v]) => Number(v) > 0);
  const mixTotal = mix.reduce((a, [, v]) => a + Number(v), 0) || 1;

  return (
    <div className="space-y-6">
      <header>
        <p className="text-[11px] uppercase tracking-[0.3em] text-[#00D4FF]">Module 4</p>
        <h1 className="mt-2 font-heading text-3xl font-semibold text-white">Room Utilisation</h1>
        <p className="mt-1 text-sm text-slate-400">
          {propName} · {inventory} rooms · {dateRange.from || "—"} → {dateRange.to || "—"} · {stats.days} day average
        </p>
      </header>

      {!occ.length ? (
        <Card title="No occupancy data in this period">
          <p className="text-sm text-slate-400">
            Import an Occupancy report for {dateRange.from || "this range"} → {dateRange.to || ""} to populate this page.
          </p>
        </Card>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
            {[
              ["Avg Occupied", num(stats.avgOccupied), C.purple],
              ["Avg Vacant", num(stats.avgVacant), C.green],
              ["Avg Out of Service", num(stats.avgOoo), C.coral],
              ["Occupancy", pct(stats.occupancy), C.cyan],
              ["ADR", money2(stats.adr), C.amber],
            ].map(([label, value, color]) => (
              <div key={label} className="rounded-2xl border border-white/5 bg-[#0F1F35]/80 p-4">
                <p className="text-[11px] uppercase tracking-widest text-slate-400">{label}</p>
                <p className="mt-2 font-heading text-2xl font-semibold" style={{ color: String(color) }}>{value}</p>
              </div>
            ))}
          </div>

          {stats.downNights > 0 && (
            <Card title="Revenue lost to out-of-service rooms">
              <p className="text-sm text-slate-300">
                <span className="font-heading text-2xl font-semibold" style={{ color: C.coral }}>
                  {money(stats.oooLoss)}
                </span>{" "}
                of room revenue was unavailable to sell across this period.
              </p>
              <p className="mt-2 text-sm text-slate-400">
                {num(stats.downNights)} out-of-service room-night{stats.downNights === 1 ? "" : "s"} at the{" "}
                {money2(stats.adr)} ADR actually achieved. Both figures come from the imported occupancy report —
                this is the revenue those rooms would have earned at your own average rate, not a forecast.
              </p>
            </Card>
          )}

          <Card
            title={`Average room mix · ${stats.days}-day average`}
            subtitle="Share of physical inventory by state, averaged across the selected period"
          >
            <div className="flex h-8 w-full overflow-hidden rounded-lg">
              {mix.map(([label, value, color]) => (
                <div
                  key={label}
                  title={`${label}: ${value} rooms`}
                  className="flex items-center justify-center text-[10px] font-medium text-white/90"
                  style={{ width: `${(Number(value) / mixTotal) * 100}%`, background: `${color}66`, borderRight: "1px solid #0F1F35" }}
                >
                  {(Number(value) / mixTotal) > 0.08 ? value : ""}
                </div>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap gap-4">
              {mix.map(([label, value, color]) => (
                <span key={label} className="flex items-center gap-2 text-xs text-slate-400">
                  <span className="h-2.5 w-2.5 rounded-sm" style={{ background: String(color) }} />
                  {label} · {num(value)} ({pct(Number(value) / mixTotal)})
                </span>
              ))}
            </div>
            <p className="mt-4 border-t border-white/5 pt-3 text-xs text-slate-500">
              The imported reports carry daily totals only, so this is an average mix across {stats.days} day
              {stats.days === 1 ? "" : "s"} — not a live per-room status. Which specific room is occupied, clean or
              out of service is not present in the data.
            </p>
          </Card>
        </>
      )}
    </div>
  );
}
