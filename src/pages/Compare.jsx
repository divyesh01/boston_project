import React, { useMemo } from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import CompareCard from "@/components/compare/CompareCard";
import CompareBars from "@/components/compare/CompareBars";
import ChannelRevenue from "@/components/compare/ChannelRevenue";
import { useOccupancy, useSources } from "@/lib/useHotelData";
import { useGlobalFilters } from "@/lib/useGlobalFilters";
import { money, money2, num, pct, inRange, occupancyStats } from "@/lib/hotel";

export default function Compare() {
  const { dateRange, compareDateRange, channel, property, properties, months, compareMonths } = useGlobalFilters();
  const { data: occ = [], isLoading } = useOccupancy(dateRange, property, months);
  const { data: prevOcc = [] } = useOccupancy(compareDateRange, property, compareMonths);
  const { data: sources = [] } = useSources(dateRange, property, months);

  // Shared engine — capacity is summed per property, so portfolio mode no longer
  // collapses to a flat 100 rooms and this page cannot disagree with Dashboard.
  const stats = (rows) => occupancyStats(rows, properties);

  const sa = stats(occ.filter((x) => inRange(x.date, dateRange.from, dateRange.to)));
  const sb = stats(prevOcc.filter((x) => inRange(x.date, compareDateRange.from, compareDateRange.to)));

  const srcRows = useMemo(() => {
    let r = sources.filter((x) => inRange(x.date, dateRange.from, dateRange.to));
    if (channel !== "all") r = r.filter((x) => x.source === channel || x.code === channel);
    return r;
  }, [sources, dateRange, channel]);

  if (isLoading) return <p className="text-slate-500">Loading comparison engine…</p>;

  return (
    <div className="space-y-6">
      <header>
        <p className="text-[11px] uppercase tracking-[0.3em] text-[#00D4FF]">Module 3</p>
        <h1 className="mt-2 font-heading text-3xl font-semibold text-white">Multi-Period Comparison</h1>
        <p className="mt-1 text-sm text-slate-400">
          Period A: {dateRange.from || "—"} → {dateRange.to || "—"} · Period B: {compareDateRange.from || "—"} → {compareDateRange.to || "—"}
        </p>
      </header>

      <Tabs defaultValue="period">
        <TabsList className="bg-[#0A1628]">
          <TabsTrigger value="period" className="data-[state=active]:bg-[#6C63FF]/15 data-[state=active]:text-white">
            Period Comparison
          </TabsTrigger>
          <TabsTrigger value="channel" className="data-[state=active]:bg-[#6C63FF]/15 data-[state=active]:text-white">
            Revenue by Channel
          </TabsTrigger>
        </TabsList>

        <TabsContent value="period" className="mt-6 space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <CompareCard label="Revenue" a={sa.revenue} b={sb.revenue} format={money} />
            <CompareCard label="Rooms Sold" a={sa.roomsSold} b={sb.roomsSold} format={num} />
            <CompareCard label="ADR" a={sa.adr} b={sb.adr} format={money2} />
            <CompareCard label="Occupancy" a={sa.occupancy} b={sb.occupancy} format={(v) => pct(v)} />
          </div>

          <CompareBars
            dateRange={`Period A: ${dateRange.from} to ${dateRange.to} | Period B: ${compareDateRange.from} to ${compareDateRange.to}`}
            data={[
              { metric: "Revenue ($k)", "Period A": Math.round(sa.revenue / 100) / 10, "Period B": Math.round(sb.revenue / 100) / 10 },
              { metric: "Rooms Sold", "Period A": sa.roomsSold, "Period B": sb.roomsSold },
              { metric: "ADR ($)", "Period A": Math.round(sa.adr), "Period B": Math.round(sb.adr) },
            ]}
          />
          <p className="text-xs text-slate-500">
            Period A: {sa.days} days · Period B: {sb.days} days
          </p>
        </TabsContent>

        <TabsContent value="channel" className="mt-6">
          <ChannelRevenue rows={srcRows} dateRange={`Period A: ${dateRange.from} to ${dateRange.to}`} />
        </TabsContent>
      </Tabs>
    </div>
  );
}