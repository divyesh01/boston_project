import { db } from '@/api/base44Client';

import React, { useState } from "react";
import { useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { GitCompare, RotateCcw, Check, CalendarClock, FileDown, Building2 } from "lucide-react";
import { exportToPdf } from "@/lib/pdfExport";
import {
  useGlobalFilters, PERIODS, MONTHS_SHORT, MONTHS_LONG, PAGE_FILTERS,
} from "@/lib/useGlobalFilters";

import { queryClientInstance } from "@/lib/query-client";
import ResponsiveSelect from "@/components/ui/ResponsiveSelect";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";

const CUR_YEAR = new Date().getFullYear();
const YEARS = [CUR_YEAR - 2, CUR_YEAR - 1, CUR_YEAR, CUR_YEAR + 1].map(String);

function useFilterOptions(propertyId) {
  const clerks = useQuery({
    queryKey: ["filter-clerks", Array.isArray(propertyId) ? propertyId.join(",") : propertyId],
    queryFn: async () => {
      const filter = {};
      if (propertyId && propertyId !== "all") {
        if (Array.isArray(propertyId)) {
          if (propertyId.length > 0) filter.property_id = { $in: propertyId };
        } else {
          filter.property_id = propertyId;
        }
      }
      const rows = await db.entities.ClerkShiftRecord.filter(filter, "-created_date", 2000);
      return [...new Set(
        rows.map((r) => {
          let name = r.clerk_name || "";
          if (!name && r.payment_type) {
            const pt = r.payment_type;
            if (pt.startsWith("$")) return "";
            const m = pt.match(/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s*[AP]M\s*-\s*(.+)$/i);
            if (m) name = m[1].trim();
            else if (!/^\d{4}-/.test(pt)) name = pt;
          }
          return name;
        }).filter(Boolean)
      )].sort();
    },
    staleTime: 60 * 1000,
  });
  const sources = useQuery({
    queryKey: ["filter-sources", Array.isArray(propertyId) ? propertyId.join(",") : propertyId],
    queryFn: async () => {
      const filter = {};
      if (propertyId && propertyId !== "all") {
        if (Array.isArray(propertyId)) {
          if (propertyId.length > 0) filter.property_id = { $in: propertyId };
        } else {
          filter.property_id = propertyId;
        }
      }
      const rows = await db.entities.SourceDay.filter(filter, "date", 5000);
      return [...new Set(rows.map((r) => r.source).filter(Boolean))].sort();
    },
    staleTime: 60 * 1000,
  });
  return { clerks: clerks.data || [], sources: sources.data || [] };
}

function Field({ label, children }) {
  return (
    <div className="min-w-[120px] flex-1">
      <label className="mb-1 block text-[10px] uppercase tracking-widest text-slate-500">{label}</label>
      {children}
    </div>
  );
}

function Mini({ value, onChange, options, placeholder }) {
  return (
    <ResponsiveSelect value={value} onValueChange={onChange} options={options} placeholder={placeholder} />
  );
}

function MultiPropertySelect({ selectedIds, properties, onToggle, onClear }) {
  const [open, setOpen] = useState(false);
  const label = selectedIds.length === 0
    ? "All Properties"
    : selectedIds.length === 1
    ? (properties.find((p) => p.id === selectedIds[0])?.name || "1 Property")
    : `${selectedIds.length} Properties`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button className="flex h-9 w-full items-center justify-between rounded-lg border border-white/10 bg-[#0A1628] px-3 text-sm text-slate-200 hover:border-white/20">
          <span className="truncate">{label}</span>
          <Building2 className="ml-2 h-4 w-4 shrink-0 text-slate-500" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 border-white/10 bg-[#0F1F35] p-2" align="start">
        <div className="max-h-60 overflow-auto">
          <button
            onClick={onClear}
            className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors hover:bg-white/5 ${selectedIds.length === 0 ? "text-[#00D4FF]" : "text-slate-200"}`}
          >
            <Building2 className="h-4 w-4" /> All Properties / Portfolio
          </button>
          {properties.map((p) => (
            <label
              key={p.id}
              className="flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm text-slate-200 transition-colors hover:bg-white/5"
            >
              <Checkbox
                checked={selectedIds.includes(p.id)}
                onCheckedChange={() => onToggle(p.id)}
                className="border-white/20 data-[state=checked]:bg-[#6C63FF] data-[state=checked]:border-[#6C63FF]"
              />
              <div className="flex-1">
                <p className="truncate">{p.name}</p>
                <p className="text-xs text-slate-500">{p.code} · {p.rooms || 100} rooms</p>
              </div>
            </label>
          ))}
          {!properties.length && <p className="px-3 py-2 text-sm text-slate-500">No properties configured.</p>}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export default function GlobalControlBar() {
  const loc = useLocation();
  const f = useGlobalFilters();
  const { clerks, sources } = useFilterOptions(f.property);
  const [applied, setApplied] = useState(false);
  const [exporting, setExporting] = useState(false);

  const pageKey = loc.pathname;
  const filters = PAGE_FILTERS[pageKey] || {};

  if (pageKey === "/settings" || pageKey === "/upload") return null;

  const handleExportPdf = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const content = document.querySelector("[data-page-content]");
      if (content) {
        const propName = f.property === "all" ? "Portfolio" : (Array.isArray(f.property) ? `${f.property.length}_Properties` : (f.properties.find((p) => p.id === f.property)?.name || "Property"));
        await exportToPdf(content, `RRI_${propName}_${f.dateRange.from || "all"}_${f.dateRange.to || "latest"}.pdf`);
      }
    } catch (e) {
      console.error("PDF export failed:", e);
    }
    setExporting(false);
  };

  const yearOpts = YEARS.map((y) => [y, y]);

  const employeeOpts = [["all", "All Employees"], ...clerks.map((c) => [c, c])];
  const sourceOpts = [["all", "All Channels"], ...sources.map((s) => [s, s])];
  const payOpts = [["all", "All Payment Types"], ["CASH", "Cash"], ["VISA", "Visa"], ["MASTER", "Mastercard"], ["AMEX", "Amex"], ["DISCOVER", "Discover"], ["CARD", "Card"]];
  const reportOpts = [["all", "All Reports"], ["occupancy", "Occupancy"], ["source", "Source Summary"], ["gross", "Gross Revenue"], ["clerk", "Clerk Shift"]];

  const handleApply = async () => {
    await queryClientInstance.invalidateQueries();
    setApplied(true);
    setTimeout(() => setApplied(false), 1500);
  };

  const selectedMonthsLabel = f.months.length === 0
    ? "Current Month"
    : f.months.length === 1
    ? MONTHS_LONG[f.months[0]]
    : f.months.map((m) => MONTHS_SHORT[m]).join(" + ");

  return (
    <div className="mb-6 rounded-2xl border border-white/5 bg-[#0F1F35]/80 p-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Property">
          <MultiPropertySelect
            selectedIds={f.selectedPropertyIds}
            properties={f.properties}
            onToggle={f.toggleProperty}
            onClear={() => f.setPropertyMulti([])}
          />
        </Field>
        <div className="min-w-[110px]">
          <label className="mb-1 block text-[10px] uppercase tracking-widest text-slate-500">Period</label>
          <Mini value={f.period} onChange={f.setPeriod} options={PERIODS} placeholder="Period" />
        </div>
        <div className="min-w-[90px]">
          <label className="mb-1 block text-[10px] uppercase tracking-widest text-slate-500">Year</label>
          <Mini value={String(f.year)} onChange={(v) => f.setYear(Number(v))} options={yearOpts} placeholder="Year" />
        </div>

        {f.period === "custom" && (
          <div className="flex items-end gap-2">
            <div>
              <label className="mb-1 block text-[10px] uppercase tracking-widest text-slate-500">From</label>
              <input type="date" value={f.customFrom} onChange={(e) => f.setCustomFrom(e.target.value)} className="h-9 rounded-lg border border-white/10 bg-[#0A1628] px-2 text-sm text-slate-200 outline-none focus:border-[#00D4FF]" />
            </div>
            <span className="pb-2 text-slate-500">→</span>
            <div>
              <label className="mb-1 block text-[10px] uppercase tracking-widest text-slate-500">To</label>
              <input type="date" value={f.customTo} onChange={(e) => f.setCustomTo(e.target.value)} className="h-9 rounded-lg border border-white/10 bg-[#0A1628] px-2 text-sm text-slate-200 outline-none focus:border-[#00D4FF]" />
            </div>
          </div>
        )}

        <div className="ml-auto flex items-end gap-2">
          <button
            onClick={() => f.setCompareOn(!f.compareOn)}
            className={`flex h-9 items-center gap-2 rounded-lg border px-4 text-sm font-medium transition-all ${
              f.compareOn ? "border-[#00D4FF] bg-[#00D4FF]/15 text-[#00D4FF]" : "border-white/10 bg-[#0A1628] text-slate-400 hover:border-white/20"
            }`}
          >
            <GitCompare className="h-4 w-4" />
            Compare: {f.compareOn ? "ON" : "OFF"}
          </button>
          <button
            onClick={handleExportPdf}
            disabled={exporting}
            className="flex h-9 items-center gap-2 rounded-lg bg-[#6C63FF] px-4 text-sm font-medium text-white transition-colors hover:bg-[#5b52e8] disabled:opacity-50"
          >
            <FileDown className="h-4 w-4" />
            {exporting ? "Generating…" : "Export PDF"}
          </button>
        </div>
      </div>

      {f.period === "monthly" && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            onClick={f.goToLatestData}
            disabled={!f.latestDate}
            className="flex h-8 items-center gap-1.5 rounded-lg border border-[#00E096]/30 bg-[#00E096]/10 px-3 text-xs font-medium text-[#00E096] transition-colors hover:bg-[#00E096]/20 disabled:opacity-40"
          >
            <CalendarClock className="h-3.5 w-3.5" /> Latest Data
          </button>

          <button
            onClick={() => f.setMonths([])}
            className={`flex h-8 items-center rounded-lg border px-3 text-xs font-medium transition-all ${
              f.months.length === 0 ? "border-[#6C63FF] bg-[#6C63FF]/15 text-white" : "border-white/10 bg-[#0A1628] text-slate-400 hover:bg-white/5"
            }`}
          >
            All Months
          </button>

          <div className="grid grid-cols-6 gap-1 sm:gap-1.5">
            {MONTHS_SHORT.map((m, i) => (
              <button
                key={m}
                onClick={() => f.toggleMonth(i)}
                className={`h-8 rounded-md px-2 text-xs font-medium transition-all ${
                  f.months.includes(i) ? "bg-[#6C63FF] text-white" : "bg-[#0A1628] text-slate-400 hover:bg-white/5 hover:text-slate-200"
                }`}
              >
                {m}
              </button>
            ))}
          </div>

          <span className="text-xs text-slate-500">
            {f.months.length} month{f.months.length === 1 ? "" : "s"}: {selectedMonthsLabel}
          </span>
        </div>
      )}

      {f.compareOn && (
        <div className="mt-3 space-y-3 rounded-lg border border-[#00D4FF]/20 bg-[#00D4FF]/[0.04] p-3">
          <div className="flex flex-wrap items-end gap-3">
            <span className="text-[10px] uppercase tracking-widest text-[#00D4FF]">Compare to</span>
            <div className="min-w-[110px]">
              <Mini value={f.comparePeriod} onChange={f.setComparePeriod} options={PERIODS} placeholder="Period" />
            </div>
            <div className="min-w-[90px]">
              <Mini value={String(f.compareYear)} onChange={(v) => f.setCompareYear(Number(v))} options={yearOpts} placeholder="Year" />
            </div>
          </div>
          {f.comparePeriod === "monthly" && (
            <div className="grid grid-cols-6 gap-1 sm:gap-1.5">
              {MONTHS_SHORT.map((m, i) => (
                <button
                  key={m}
                  onClick={() => {
                    const next = f.compareMonths.includes(i)
                      ? f.compareMonths.filter((x) => x !== i)
                      : [...f.compareMonths, i].sort((a, b) => a - b);
                    f.setCompareMonths(next);
                  }}
                  className={`h-8 rounded-md px-2 text-xs font-medium transition-all ${
                    f.compareMonths.includes(i) ? "bg-[#00D4FF] text-[#040D1A]" : "bg-[#0A1628] text-slate-400 hover:bg-white/5 hover:text-slate-200"
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {(filters.employee || filters.paymentType || filters.channel || filters.reportType) && (
        <div className="mt-3 flex flex-wrap items-end gap-3">
          {filters.employee && (
            <Field label="Employee">
              <Mini value={f.employee} onChange={f.setEmployee} options={employeeOpts} placeholder="All Employees" />
            </Field>
          )}
          {filters.paymentType && (
            <Field label="Payment Type">
              <Mini value={f.paymentType} onChange={f.setPaymentType} options={payOpts} placeholder="All Payment Types" />
            </Field>
          )}
          {filters.channel && (
            <Field label="Channel">
              <Mini value={f.channel} onChange={f.setChannel} options={sourceOpts} placeholder="All Channels" />
            </Field>
          )}
          {filters.reportType && (
            <Field label="Report Type">
              <Mini value={f.reportType} onChange={f.setReportType} options={reportOpts} placeholder="All Reports" />
            </Field>
          )}
        </div>
      )}

      <div className="mt-3 flex items-center gap-2">
        <button
          onClick={handleApply}
          className="flex h-9 items-center gap-2 rounded-lg bg-[#6C63FF] px-5 text-sm font-medium text-white transition-colors hover:bg-[#5b52e8]"
        >
          {applied ? <Check className="h-4 w-4 text-[#00E096]" /> : <Check className="h-4 w-4" />}
          {applied ? "Applied!" : "Apply"}
        </button>
        <button
          onClick={f.reset}
          className="flex h-9 items-center gap-2 rounded-lg border border-white/10 px-4 text-sm text-slate-400 transition-colors hover:border-[#FF6B6B]/60 hover:text-[#FF6B6B]"
        >
          <RotateCcw className="h-4 w-4" /> Reset
        </button>
        <span className="ml-auto text-xs tabular-nums text-slate-500">
          {f.dateRange.from || "—"} → {f.dateRange.to || "—"}
          {f.latestDate && <span className="ml-2 text-[#00E096]">Data through: {f.latestDate}</span>}
        </span>
      </div>
    </div>
  );
}