import React, { useMemo } from "react";
import { CostCoverageNotice } from "@/components/OwnerTrustNotices";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  ArrowRight, Wrench, AlertTriangle, TrendingUp, BadgeCheck,
  DollarSign, Percent, Gauge, Target, Sparkles,
} from "lucide-react";
import Card from "@/components/ui-exec/Card";
import KpiCard from "@/components/ui-exec/KpiCard";
import { db } from "@/api/base44Client";
import { useOccupancy, useSources, usePaymentData } from "@/lib/useHotelData";
import { useGlobalFilters } from "@/lib/useGlobalFilters";
import { getOccThreshold, money2, pct, formatDayLabel, localTodayIso } from "@/lib/hotel";
import { buildActionCenter } from "@/lib/actionCenter";
import { distanceColor, getEventsInRange, getUpcomingEventDays } from "@/lib/eventSchedule";
import { ErrorState } from "@/components/ui/status";

// Pick up productivity ticks describing each bucket's tone
const TONE = {
  red: { label: "Fix Today", color: "#FF6B6B", icon: Wrench, ring: "#FF6B6B", dot: "bg-[#FF6B6B]" },
  amber: { label: "Investigate", color: "#FFB547", icon: AlertTriangle, ring: "#FFB547", dot: "bg-[#FFB547]" },
  green: { label: "Opportunity", color: "#00E096", icon: TrendingUp, ring: "#00E096", dot: "bg-[#00E096]" },
  cyan: { label: "Keep Doing", color: "#00D4FF", icon: BadgeCheck, ring: "#00D4FF", dot: "bg-[#00D4FF]" },
};

const BUCKETS = [
  ["fix", "Fix Today", "Pain the property is feeling right now"],
  ["investigate", "Investigate", "Money movement that deserves a second look"],
  ["opportunity", "Opportunity", "Money you can still make"],
  ["keepDoing", "Keep Doing", "What's working — protect it"],
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

function ActionCard({ action }) {
  const tone = TONE[action.tone] || TONE.amber;
  const Icon = tone.icon;
  return (
    <div className="group relative overflow-hidden rounded-2xl border border-white/5 bg-[#0F1F35]/80 p-4 transition-all duration-300 hover:border-white/15">
      <div className="absolute inset-x-0 top-0 h-[2px]" style={{ background: `linear-gradient(90deg, transparent, ${tone.color}88, transparent)` }} />
      <div className="flex items-start gap-3">
        <div
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl"
          style={{ background: `${tone.color}1f`, color: tone.color }}
        >
          <Icon className="h-4.5 w-4.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-widest" style={{ background: `${tone.color}1a`, color: tone.color }}>
              {tone.label}
            </span>
            {typeof action.impact === "number" && (
              <span className="text-[10px] text-slate-500">impact ~${Math.round(action.impact).toLocaleString()}</span>
            )}
          </div>
          <p className="mt-1.5 font-heading text-sm font-semibold leading-snug text-white">{action.title}</p>
          <p className="mt-1 text-xs leading-relaxed text-slate-400">{action.detail}</p>

          {action.metrics && (
            <div className="mt-3 grid grid-cols-3 gap-2">
              {action.metrics.map(([label, value]) => (
                <div key={label} className="rounded-lg border border-white/5 bg-[#0A1628]/60 px-2 py-1.5">
                  <p className="text-[9px] uppercase tracking-wider text-slate-500">{label}</p>
                  <p className="mt-0.5 text-xs tabular-nums text-slate-200">{value}</p>
                </div>
              ))}
            </div>
          )}

          {action.to && (
            <Link
              to={action.to}
              className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-[#6C63FF] transition-colors hover:text-[#9B8CFF]"
            >
              View related report <ArrowRight className="h-3 w-3" />
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}

export default function ActionCenter() {
  const { dateRange, property, properties, months, channel } = useGlobalFilters();
  const occQ = useOccupancy(dateRange, property, months);
  const sourcesQ = useSources(dateRange, property, months);
  const payQ = usePaymentData(dateRange, property, months);
  const { data: occ = [] } = occQ;
  const { data: sources = [] } = sourcesQ;
  const { data: payRows = [] } = payQ;

  const propertyKey = Array.isArray(property) ? property.join(",") : property;
  const propFilter = useMemo(() => buildPropertyFilter(property), [property]);

  const expensesQ = useQuery({
    queryKey: ["expenses", propertyKey],
    queryFn: () => db.entities.Expense.filter(propFilter, "-expense_date", 100000),
  });
  const payrollQ = useQuery({
    queryKey: ["payroll", propertyKey],
    queryFn: () => db.entities.PayrollRun.filter(propFilter, "-pay_period_start", 100000),
  });
  const { data: expenses = [] } = expensesQ;
  const { data: payroll = [] } = payrollQ;

  // Every lane on this page is a judgement about whether something needs attention, and
  // an empty lane renders as "Nothing here — good." If any of the five reads failed,
  // that sentence is a false all-clear — the most dangerous thing this page can say. So
  // one failed read blocks the whole page rather than a lane.
  const reads = [occQ, sourcesQ, payQ, expensesQ, payrollQ];
  const failed = reads.find((q) => q.isError);
  const retryAll = () => reads.forEach((q) => q.refetch());

  // Previous equal-length window for period-over-period deltas
  const prevRange = useMemo(() => {
    if (!dateRange.from || !dateRange.to) return { from: "", to: "" };
    const days = Math.round((new Date(dateRange.to).getTime() - new Date(dateRange.from).getTime()) / 86400000) + 1;
    const prevTo = new Date(new Date(dateRange.from).getTime() - 86400000);
    const prevFrom = new Date(prevTo.getTime() - (days - 1) * 86400000);
    return { from: prevFrom.toISOString().slice(0, 10), to: prevTo.toISOString().slice(0, 10) };
  }, [dateRange]);

  const prevEnabled = !!(prevRange.from && prevRange.to);
  const { data: prevOcc = [] } = useOccupancy(prevRange, property, [], prevEnabled);

  // Events for the current date range, one-time and recurring. The expansion
  // lives in eventSchedule.js -- this page used to carry its own copy of both
  // datasets and both loops, which is how the same date defect shipped in three
  // places at once. See BRAIN_TROUBLESHOOTING.md 29.
  const eventsInRange = useMemo(() => getEventsInRange(dateRange), [dateRange]);

  // Always-visible horizon: the next 5 upcoming event days from today,
  // independent of the selected date range, so the owner always has a
  // forward-looking plan of at least 5 event dates. `from` is a date-only key in
  // the operator's own calendar, so today's events count as upcoming.
  const upcomingDays = useMemo(() => getUpcomingEventDays({ from: localTodayIso(), limit: 5 }), []);

  const roomCounts = useMemo(() => {
    if (property === "all" || Array.isArray(property)) {
      const map = {};
      properties.forEach((p) => { map[p.id] = p.rooms || 100; });
      return map;
    }
    return { [property]: properties.find((p) => p.id === property)?.rooms || 100 };
  }, [property, properties]);

  const model = useMemo(() => {
    const occRows = occ.filter((r) => {
      const d = String(r.date || "").slice(0, 10);
      return d >= (dateRange.from || "") && d <= (dateRange.to || "");
    });
    const srcRows = sources
      .filter((r) => {
        const d = String(r.date || "").slice(0, 10);
        return d >= (dateRange.from || "") && d <= (dateRange.to || "");
      })
      .filter((x) => channel === "all" || x.source === channel || x.code === channel);
    return buildActionCenter({
      occRows,
      srcRows,
      payRows,
      expenses,
      payroll,
      roomCounts,
      dateRange,
      prevOccRows: prevOcc,
      eventsInRange,
    });
  }, [occ, sources, payRows, expenses, payroll, roomCounts, dateRange, prevOcc, channel, eventsInRange]);

  const { premise, buckets, top3, meta } = model;
  const propName = property === "all"
    ? "All Properties"
    : Array.isArray(property)
      ? `${property.length} Properties`
      : (properties.find((p) => p.id === property)?.name || "Property");

  return (
    <div className="space-y-6">
      <header>
        <p className="text-[11px] uppercase tracking-[0.3em] text-[#00D4FF]">Owner Operating System</p>
        <h1 className="mt-2 font-heading text-3xl font-semibold text-white">Owner Action Center</h1>
        <p className="mt-1 text-sm text-slate-400">
          What happened · why · what's going wrong · what to do next. {propName} · {dateRange.from || "—"} → {dateRange.to || "—"}
        </p>
      </header>

      {failed ? (
        <ErrorState
          title="Could not build the action list"
          description="At least one of the reads behind this page failed, so no recommendations are shown. An empty list here would read as “nothing needs attention”, which cannot be confirmed."
          error={failed.error}
          onRetry={retryAll}
        />
      ) : reads.some((query) => query.isLoading) ? (
        <p role="status" className="rounded-xl border border-white/10 p-4 text-sm text-slate-300">Loading the records behind your action list…</p>
      ) : (
        <>
      <CostCoverageNotice expenses={expenses} payroll={payroll} dateRange={dateRange} />
      {/* ── Premise: snapshot of the money ── */}
      <Card title="Where you stand" subtitle="Computed from imported data for this period">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <KpiCard label="Revenue" value={money2(premise.revenue)} accent="#6C63FF" icon={DollarSign} sub={`${meta.comparedToPrev ? 'vs ' + money2(meta.prevStats?.revenue) : 'no previous window'}`} />
          <KpiCard label="Occupancy" value={pct(premise.occupancy)} accent="#00D4FF" icon={Percent} sub={`target ${pct(getOccThreshold())}`} />
          <KpiCard label="ADR" value={money2(premise.adr)} accent="#00E096" icon={Gauge} sub={`RevPAR ${money2(premise.revpar)}`} />
          <KpiCard label="Est. money kept" value={money2(premise.keepRate ? premise.revenue * premise.keepRate : 0)} accent="#FFB547" icon={Target} sub="pre-tax · after fees, payroll & expenses" />
        </div>
      </Card>

      {/* ── Upcoming Events (Demand Intelligence) ── */}
      <Card
        title="Upcoming Events"
        subtitle="Next 5 event dates ahead — use for dynamic pricing"
        right={<Target className="h-4 w-4 text-[#FFB547]" />}
      >
        {upcomingDays.length > 0 ? (
          <div className="space-y-3">
            {upcomingDays.map(([date, dayEvents]) => {
                  const demandColors = {
                    'Maximum': 'bg-red-500/20 text-red-400 border-red-500/30',
                    'Very High': 'bg-orange-500/20 text-orange-400 border-orange-500/30',
                    'High': 'bg-amber-500/20 text-amber-400 border-amber-500/30',
                    'Moderate to High': 'bg-lime-500/20 text-lime-400 border-lime-500/30',
                    'Moderate': 'bg-blue-500/20 text-blue-400 border-blue-500/30',
                  };
                  const peakEvent = dayEvents.reduce((p, e) => {
                    const order = { 'Maximum': 4, 'Very High': 3, 'High': 2, 'Moderate to High': 1.5, 'Moderate': 1 };
                    return (order[e.demand] || 0) > (order[p.demand] || 0) ? e : p;
                  });
                  // Same defect as the calendar dialog: new Date("2026-08-01")
                  // parses as UTC midnight and rendered as "Fri, Jul 31" here —
                  // directly above the correct raw date on the next line.
                  const dayOfWeek = formatDayLabel(date, { weekday: 'short', month: 'short', day: 'numeric' });
                  return (
                    <div key={date} className="rounded-xl border border-white/5 bg-[#0A1628]/60 p-4">
                      <div className="flex items-start gap-4">
                        <div className="flex-shrink-0 w-24 text-center">
                          <p className="font-heading text-xl font-semibold text-white">{dayOfWeek}</p>
                          <p className="text-xs text-slate-500">{date}</p>
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-3">
                            <span className={`rounded-full px-3 py-1 text-xs font-medium uppercase tracking-wider border ${demandColors[peakEvent.demand] || demandColors.Moderate}`}>
                              {peakEvent.demand} Demand
                            </span>
                            {dayEvents.some(e => e.recurring) && (
                              <span className="rounded-full px-3 py-1 text-xs font-medium bg-purple-500/20 text-purple-400 border border-purple-500/30">Recurring</span>
                            )}
                          </div>
                          <div className="space-y-3">
                            {dayEvents.slice(0, 3).map((e, idx) => (
                              <div key={`${date}-${idx}`} className="space-y-1">
                                <div className="flex items-center gap-2 text-base text-slate-300">
                                  <span className="text-sm w-16" style={{ color: distanceColor(e.distance) }}>{e.distance} mi</span>
                                  <span className="font-medium" style={{ color: distanceColor(e.distance) }}>{e.name}</span>
                                  {e.time && <span className="text-sm text-slate-500">· {e.time}</span>}
                                </div>
                                <div className="pl-20 text-sm leading-relaxed text-slate-500">
                                  {e.venue}{e.address && e.address !== "Regional" ? ` — ${e.address}` : ""}
                                  {e.priceRange ? ` · ${e.priceRange}` : ""}
                                  {e.holiday && e.holiday !== "Holiday Season" ? ` · ${e.holiday}` : ""}
                                </div>
                              </div>
                            ))}
                            {dayEvents.length > 3 && (
                              <p className="text-sm text-slate-500 mt-1">+ {dayEvents.length - 3} more event{dayEvents.length - 3 > 1 ? 's' : ''} this day</p>
                            )}
                          </div>
                        </div>
                        <div className="flex-shrink-0 text-right">
                          <p className="font-heading text-base font-semibold text-[#00E096]">
                            {dayEvents.length} event{dayEvents.length > 1 ? 's' : ''}
                          </p>
                          <p className="text-xs text-slate-500">Peak: {peakEvent.demand}</p>
                        </div>
                      </div>
                    </div>
                  );
                })}
          </div>
        ) : (
          <p className="rounded-xl border border-dashed border-white/10 bg-white/[0.02] px-4 py-3 text-sm text-slate-500">No upcoming events found.</p>
        )}
      </Card>

      {/* ── Top 3 highest-value actions ── */}
      <Card
        title="Today's highest-value actions"
        subtitle="Ranked by estimated dollar impact"
        right={<Sparkles className="h-4 w-4 text-[#00D4FF]" />}
      >
        <div className="grid gap-4 lg:grid-cols-3">
          {top3.map((a, i) => (
            <ActionCard key={a.key || i} action={a} />
          ))}
          {top3.length === 0 && (
            <p className="text-sm text-slate-500">No actionable items yet — import more data, or everything is healthy.</p>
          )}
        </div>
      </Card>

      {/* ── Bucket lanes ── */}
      {BUCKETS.map(([key, label, desc]) => {
        const items = buckets[key] || [];
        return (
          <div key={key}>
            <div className="mb-3 flex items-center gap-2">
              <h3 className="font-heading text-base font-semibold text-white">{label}</h3>
              <span className="rounded-full bg-white/5 px-2 py-0.5 text-[11px] text-slate-400">{items.length}</span>
              <span className="hidden text-xs text-slate-500 sm:inline">· {desc}</span>
            </div>
            {items.length ? (
              <div className="grid gap-4 lg:grid-cols-2">
                {items.map((a, i) => <ActionCard key={a.key || i} action={a} />)}
              </div>
            ) : (
              <p className="rounded-xl border border-dashed border-white/10 bg-white/[0.02] px-4 py-3 text-sm text-slate-500">Nothing here — good.</p>
            )}
          </div>
        );
      })}

      <p className="text-xs text-slate-600">
        Estimates are computed locally from imported occupancy, source, payment, expense and payroll data — they are not financial advice and may not reflect every billing nuance.
      </p>
        </>
      )}
    </div>
  );
}
