import React, { useMemo } from "react";
import Card from "@/components/ui-exec/Card";
import { useOccupancy } from "@/lib/useHotelData";
import { C, num, pct, money2, avg } from "@/lib/hotel";
import { useGlobalFilters } from "@/lib/useGlobalFilters";

export default function RoomBoard() {
  const { dateRange, property, properties, months } = useGlobalFilters();
  const { data: occ = [], isLoading } = useOccupancy(dateRange, property, months);

  const isPortfolio = property === "all" || Array.isArray(property);
  const propRooms = isPortfolio ? 100 : (properties.find((p) => p.id === property)?.rooms || 100);
  const propName = isPortfolio ? (Array.isArray(property) ? `${property.length} Properties` : "Portfolio") : (properties.find((p) => p.id === property)?.name || "Property");

  const stats = useMemo(() => {
    if (!occ.length) return { avgOccupied: 0, avgOoo: 0, avgVacant: 0, avgOcc: 0, avgAdr: 0, days: 0 };
    const days = occ.length;
    const avgOccupied = Math.round(avg(occ, "rooms_sold"));
    const avgOoo = Math.round(avg(occ, "down_rooms"));
    const avgVacant = Math.max(0, propRooms - avgOccupied - avgOoo);
    const totalRev = occ.reduce((a, r) => a + (Number(r.total_revenue) || 0), 0);
    const totalRooms = occ.reduce((a, r) => a + (Number(r.rooms_sold) || 0), 0);
    return {
      avgOccupied, avgOoo, avgVacant,
      avgOcc: days ? (occ.reduce((a, r) => a + (Number(r.occupancy) || 0), 0) / days) : 0,
      avgAdr: totalRooms ? totalRev / totalRooms : 0,
      days,
    };
  }, [occ, propRooms]);

  if (isLoading) return <p className="text-slate-500">Loading property board…</p>;

  const cells = Array.from({ length: propRooms }, (_, i) => {
    const n = i + 1;
    if (n <= stats.avgOccupied) return { n, status: "Occupied", color: C.purple };
    if (n <= stats.avgOccupied + stats.avgVacant) return { n, status: "Vacant Clean", color: C.green };
    return { n, status: "Out of Order", color: C.coral };
  });

  return (
    <div className="space-y-6">
      <header>
        <p className="text-[11px] uppercase tracking-[0.3em] text-[#00D4FF]">Module 4</p>
        <h1 className="mt-2 font-heading text-3xl font-semibold text-white">{propRooms}-Room Property Board</h1>
        <p className="mt-1 text-sm text-slate-400">{propName} · {dateRange.from || "—"} → {dateRange.to || "—"} · {stats.days} day average</p>
      </header>

      <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
        {[
          ["Avg Occupied", stats.avgOccupied, C.purple],
          ["Avg Vacant Clean", stats.avgVacant, C.green],
          ["Avg Out of Order", stats.avgOoo, C.coral],
          ["Avg Occupancy", null, C.cyan, pct(stats.avgOcc)],
          ["Avg ADR", null, C.amber, money2(stats.avgAdr)],
        ].map(([label, value, color, custom]) => (
          <div key={label} className="rounded-2xl border border-white/5 bg-[#0F1F35]/80 p-4">
            <p className="text-[11px] uppercase tracking-widest text-slate-400">{label}</p>
            <p className="mt-2 font-heading text-2xl font-semibold" style={{ color: String(color) }}>
              {custom !== undefined ? custom : num(value)}
            </p>
          </div>
        ))}
      </div>

      <Card
        title={`Room status · ${stats.days}-day average`}
        subtitle="Purple occupied · Green vacant clean · Red out of order — reflects average across selected period"
      >
        <div className="grid grid-cols-10 gap-1.5 sm:gap-2">
          {cells.map((c) => (
            <div
              key={c.n}
              title={`Room ${c.n} — ${c.status}`}
              className="flex aspect-square items-center justify-center rounded-lg text-[10px] font-medium text-white/90 transition-transform duration-200 hover:scale-110 sm:text-xs"
              style={{ background: `${c.color}2e`, border: `1px solid ${c.color}66` }}
            >
              {c.n}
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}