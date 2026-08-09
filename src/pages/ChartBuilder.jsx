import React, { useMemo, useState, useRef } from "react";
import { format, parseISO } from "date-fns";
import { Download } from "lucide-react";
import ResponsiveSelect from "@/components/ui/ResponsiveSelect";
import Card from "@/components/ui-exec/Card";
import UniversalChart from "@/components/charts/UniversalChart";
import ChartToolbar from "@/components/charts/ChartToolbar";
import { useOccupancy, useSources, useGrossRevenue, useUploads } from "@/lib/useHotelData";
import { aggregate, downloadCsv, num, inRange } from "@/lib/hotel";
import { formatNumber } from "@/lib/decimal";
import { useGlobalFilters } from "@/lib/useGlobalFilters";

const CHARTS = [
  ["bar", "📊 Bar"],
  ["hbar", "📈 Horizontal Bar"],
  ["line", "📉 Line Trend"],
  ["pie", "🥧 Pie"],
  ["donut", "🍩 Donut"],
];
const AGGS = [["sum", "Sum"], ["avg", "Average"], ["count", "Count"], ["max", "Maximum"], ["min", "Minimum"]];
const HIDDEN = ["id", "created_by_id", "created_date", "updated_date", "created_by", "is_sample"];

const Select = ({ value, onChange, options }) => (
  <ResponsiveSelect value={value} onValueChange={onChange} options={options} />
);

export default function ChartBuilder() {
  const { dateRange, property, months } = useGlobalFilters();
  const { data: occ = [] } = useOccupancy(dateRange, property, months);
  const { data: src = [] } = useSources(dateRange, property, months);
  const { data: gross = [] } = useGrossRevenue(dateRange, property, months);
  const { data: uploads = [] } = useUploads();

  const datasets = useMemo(() => {
    const base = [
      { key: "occ", label: "Occupancy Summary", rows: occ },
      { key: "src", label: "Source Summary", rows: src },
      { key: "gross", label: "Gross Revenue", rows: gross },
    ];
    uploads
      .filter((u) => (u.raw_rows || []).length)
      .forEach((u) => base.push({ key: u.id, label: `Custom · ${u.file_name}`, rows: u.raw_rows }));
    return base;
  }, [occ, src, gross, uploads]);

  const [dsKey, setDsKey] = useState("src");
  const ds = datasets.find((d) => d.key === dsKey) || datasets[0];
  const rows = ds?.rows || [];
  const columns = rows.length ? Object.keys(rows[0]).filter((k) => !HIDDEN.includes(k)) : [];
  const hasDate = columns.includes("date");

  const [groupBy, setGroupBy] = useState("source");
  const [valueKey, setValueKey] = useState("net_revenue");
  const [agg, setAgg] = useState("sum");
  const [type, setType] = useState("bar");
  const chartRef = useRef(null);

  const filteredRows = useMemo(() => {
    if (!hasDate || !dateRange.from || !dateRange.to) return rows;
    return rows.filter((r) => inRange(r.date, dateRange.from, dateRange.to));
  }, [rows, hasDate, dateRange]);

  const g = columns.includes(groupBy) ? groupBy : columns[0];
  const v = columns.includes(valueKey) ? valueKey : columns[columns.length - 1];
  const data = useMemo(() => (filteredRows.length && g && v ? aggregate(filteredRows, g, v, agg) : []), [filteredRows, g, v, agg]);

  const dateRangeText = hasDate && dateRange.from && dateRange.to
    ? `Showing ${format(parseISO(dateRange.from), "MMM d")} – ${format(parseISO(dateRange.to), "MMM d, yyyy")} (${filteredRows.length} rows)`
    : "All data";

  const chartTitle = `${agg.toUpperCase()} of ${v} by ${g}`;

  return (
    <div className="space-y-6">
      <header>
        <p className="text-[11px] uppercase tracking-[0.3em] text-[#00D4FF]">Module 5</p>
        <h1 className="mt-2 font-heading text-3xl font-semibold text-white">Universal Chart Builder</h1>
        <p className="mt-1 text-sm text-slate-400">Pick any column for grouping and any column for values.</p>
      </header>

      <div className="grid gap-4 rounded-2xl border border-white/5 bg-[#0F1F35]/60 p-5 sm:grid-cols-2 xl:grid-cols-5">
        <div>
          <label className="mb-1.5 block text-[11px] uppercase tracking-widest text-slate-400">Dataset</label>
          <Select value={dsKey} onChange={setDsKey} options={datasets.map((d) => [d.key, d.label])} />
        </div>
        <div>
          <label className="mb-1.5 block text-[11px] uppercase tracking-widest text-slate-400">Group by (X)</label>
          <Select value={g || ""} onChange={setGroupBy} options={columns.map((c) => [c, c])} />
        </div>
        <div>
          <label className="mb-1.5 block text-[11px] uppercase tracking-widest text-slate-400">Value (Y)</label>
          <Select value={v || ""} onChange={setValueKey} options={columns.map((c) => [c, c])} />
        </div>
        <div>
          <label className="mb-1.5 block text-[11px] uppercase tracking-widest text-slate-400">Aggregation</label>
          <Select value={agg} onChange={setAgg} options={AGGS} />
        </div>
        <div>
          <label className="mb-1.5 block text-[11px] uppercase tracking-widest text-slate-400">Chart type</label>
          <Select value={type} onChange={setType} options={CHARTS} />
        </div>
      </div>

      <Card
        title={chartTitle}
        subtitle={`${num(filteredRows.length)} source rows · ${data.length} groups`}
        right={<ChartToolbar targetRef={chartRef} title={chartTitle} dateRange={dateRangeText} />}
      >
        <div ref={chartRef}>
          <UniversalChart data={data} type={type} />
        </div>
        <p className="mt-3 text-xs text-slate-500">{dateRangeText}</p>
      </Card>

      <Card
        title="Summary Table"
        right={
          <button
            onClick={() => downloadCsv(data, `${g}_${v}_${agg}.csv`)}
            className="flex items-center gap-2 rounded-lg bg-[#6C63FF] px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[#5b52e8]"
          >
            <Download className="h-3.5 w-3.5" /> Export CSV
          </button>
        }
      >
        <div className="max-h-80 overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-[#0F1F35] text-left text-[11px] uppercase tracking-widest text-slate-500">
              <tr>
                <th className="py-2">{g}</th>
                <th className="py-2 text-right">{`${agg} (${v})`}</th>
              </tr>
            </thead>
            <tbody>
              {data.map((d) => (
                <tr key={d.name} className="border-t border-white/5">
                  <td className="py-2 text-slate-300">{d.name}</td>
                  <td className="py-2 text-right tabular-nums text-white">{formatNumber(d.value, 'auto')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}