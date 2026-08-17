import React, { useMemo } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, ClipboardList, BedDouble, Gauge } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useOccupancy } from "@/lib/useHotelData";
import { useGlobalFilters } from "@/lib/useGlobalFilters";
import { db } from "@/api/base44Client";
import { money, num, inRange } from "@/lib/hotel";
import { sumCommittedPay } from "@/lib/payrollCalc";

const THEMES = {
  emerald: {
    icon: ClipboardList,
    title: "Payroll",
    description: "Payroll runs on the final day of every month for all active staff and lands Approved.",
    to: "/payroll",
    action: "Open Payroll",
    text: "#00E096",
  },
  cyan: {
    icon: BedDouble,
    title: "Room Sales",
    description: "Live rooms-sold board with nightly performance across every property.",
    to: "/rooms",
    action: "Open Room Board",
    text: "#00D4FF",
  },
  gold: {
    icon: Gauge,
    title: "Revenue",
    description: "Gross revenue, occupancy and RevPAR in one executive view.",
    to: "/",
    action: "Open Executive Hub",
    text: "#FFB547",
  },
};

function ModuleCard({ theme, statLabel, statValue, statSub }) {
  const t = THEMES[theme];
  const Icon = t.icon;
  return (
    <Link
      to={t.to}
      className="fx-clickable group relative block overflow-hidden rounded-2xl border border-white/[0.06] bg-[#0F1F35]/90 p-5 transition-all duration-300 hover:-translate-y-1"
      style={{ boxShadow: rgba("#000000", 0.45) }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = t.text;
        e.currentTarget.style.boxShadow = `0 0 30px ${rgba(t.text, 0.35)}, 0 0 2px ${rgba(t.text, 0.6)}`;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = "rgba(255,255,255,0.06)";
        e.currentTarget.style.boxShadow = rgba("#000000", 0.45);
      }}
    >
      <div
        className="pointer-events-none absolute -top-16 -right-16 h-40 w-40 rounded-full opacity-40 blur-2xl transition-opacity duration-300 group-hover:opacity-100"
        style={{ background: `radial-gradient(circle, ${rgba(t.text, 0.18)}, transparent 70%)` }}
      />
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-[2px]"
        style={{ background: `linear-gradient(90deg, transparent, ${t.text}, transparent)` }}
      />
      <div className="relative flex items-center gap-3">
        <span
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border"
          style={{ borderColor: rgba(t.text, 0.4), background: rgba(t.text, 0.1), color: t.text }}
        >
          <Icon className="h-5 w-5" />
        </span>
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em]" style={{ color: t.text }}>
            {t.title}
          </p>
          <h3 className="mt-0.5 font-heading text-lg font-semibold text-white">{t.title} Module</h3>
        </div>
      </div>

      <div className="relative mt-5">
        <p className="text-[10px] uppercase tracking-widest text-slate-500">{statLabel}</p>
        <p className="mt-1 font-heading text-3xl font-semibold tabular-nums text-white">{statValue}</p>
        {statSub && <p className="mt-1 text-xs text-slate-400">{statSub}</p>}
      </div>

      <p className="relative mt-2 text-xs leading-relaxed text-slate-400">{t.description}</p>

      <p
        className="relative mt-4 flex items-center gap-1.5 text-xs font-medium opacity-80 transition-opacity group-hover:opacity-100"
        style={{ color: t.text }}
      >
        {t.action}
        <ArrowRight className="h-3.5 w-3.5 transition-transform duration-300 group-hover:translate-x-1" />
      </p>
    </Link>
  );
}

// 6-digit hex → rgba
function rgba(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

export default function ModuleCards() {
  const { dateRange, property, months } = useGlobalFilters();
  // `months` was hardcoded to [] here while every other card on the dashboard
  // passes it, so in Multi-Month mode these three tiles summed the whole
  // envelope range while the KPIs above them summed only the picked months.
  const { data: occ = [], isLoading } = useOccupancy(dateRange, property, months);

  // Payroll used to be an unscoped `list(..., 500)`: it ignored both the
  // property selection and the period, so the tile reported every run ever
  // recorded across the whole portfolio while sitting beside period-scoped
  // revenue. It also used the bare key ["payroll"], which missed the
  // ["payroll", propertyKey] cache that Dashboard, ActionCenter, MoneyKept and
  // Forecasting already share — so it paid for its own extra scan to get a
  // worse answer. Join that cache and scope by pay_period_start in memory, the
  // same field and idiom actionCenter.js and calculationService.js use.
  const propertyKey = Array.isArray(property) ? property.join(",") : property;
  const propFilter = property && property !== "all"
    ? (Array.isArray(property) ? { property_id: { $in: property } } : { property_id: property })
    : {};
  const { data: allPayroll = [] } = useQuery({
    queryKey: ["payroll", propertyKey],
    queryFn: () => db.entities.PayrollRun.filter(propFilter, "-pay_period_start", 100000),
  });
  const payroll = useMemo(
    () => allPayroll.filter((p) => inRange(p.pay_period_start, dateRange.from, dateRange.to)),
    [allPayroll, dateRange]
  );

  const stats = useMemo(() => {
    const rowsSold = occ.reduce((a, r) => a + (Number(r.rooms_sold) || 0), 0);
    const revenue = occ.reduce((a, r) => a + (Number(r.room_revenue) || 0), 0);
    const approved = payroll.filter((p) => p.payroll_status === "approved").length;
    // Card headline shows committed cost, matching Money Kept rather than the
    // gross of every draft.
    const totalPay = sumCommittedPay(payroll);
    return {
      payroll: {
        statLabel: "Approved Run",
        statValue: approved ? `${num(approved)} approved` : "No runs in period",
        statSub: payroll.length
          ? `${num(payroll.length)} runs · ${money(totalPay)} total`
          : "no payroll runs in this date range",
      },
      rooms: {
        statLabel: "Rooms Sold",
        statValue: isLoading ? "—" : num(rowsSold),
        statSub: occ.length ? `${num(occ.length)} days tracked` : "no data yet",
      },
      revenue: {
        statLabel: "Gross Revenue",
        statValue: isLoading ? "—" : money(revenue),
        statSub: occ.length ? `${num(occ.length)} days tracked` : "no data yet",
      },
    };
  }, [occ, payroll, isLoading]);

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-[11px] uppercase tracking-[0.3em] text-slate-500">Command Center</p>
        <span className="text-[10px] text-slate-600">Tap a module to jump in</span>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <ModuleCard theme="emerald" {...stats.payroll} />
        <ModuleCard theme="cyan" {...stats.rooms} />
        <ModuleCard theme="gold" {...stats.revenue} />
      </div>
    </section>
  );
}