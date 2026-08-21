import React, { useMemo, useState, useRef } from "react";
import { format, parseISO } from "date-fns";
import { Download } from "lucide-react";
import ResponsiveSelect from "@/components/ui/ResponsiveSelect";
import Card from "@/components/ui-exec/Card";
import UniversalChart from "@/components/charts/UniversalChart";
import ChartToolbar from "@/components/charts/ChartToolbar";
import { useOccupancy, useSources, useGrossRevenue, useUploads } from "@/lib/useHotelData";
import { aggregate, num, inRange } from "@/lib/hotel";
import { downloadCsv, downloadExcel, stampFilename } from "@/lib/exportData";
import { toast } from "@/components/ui/use-toast";
import { formatNumber } from "@/lib/decimal";
import { useGlobalFilters } from "@/lib/useGlobalFilters";
import { ErrorState } from "@/components/ui/status";

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
  const occQ = useOccupancy(dateRange, property, months);
  const srcQ = useSources(dateRange, property, months);
  const grossQ = useGrossRevenue(dateRange, property, months);
  const uploadsQ = useUploads();
  const { data: occ = [] } = occQ;
  const { data: src = [] } = srcQ;
  const { data: gross = [] } = grossQ;
  const { data: uploads = [] } = uploadsQ;

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

  const cols = columns.length ? columns : [];
  const g = cols.includes(groupBy) ? groupBy : cols[0];
  const v = cols.includes(valueKey) ? valueKey : cols[cols.length - 1];
  const data = useMemo(() => (filteredRows.length && g && v ? aggregate(filteredRows, g, v, agg) : []), [filteredRows, g, v, agg]);

  const dateRangeText = hasDate && dateRange.from && dateRange.to
    ? `Showing ${format(parseISO(dateRange.from), "MMM d")} – ${format(parseISO(dateRange.to), "MMM d, yyyy")} (${filteredRows.length} rows)`
    : "All data";

  const chartTitle = `${agg.toUpperCase()} of ${v} by ${g}`;

  // The two export buttons used to pass hotel.js's raw `{name, value}` rows straight
  // out, which produced a file headed `name,value` — the owner then had to remember
  // which grouping and which aggregation those two anonymous columns represented.
  // The spec below reuses the exact strings rendered in the Summary Table header, so
  // the file is self-describing: `Rate Plan`, `sum (room_revenue)`.
  //
  // Routing through @/lib/exportData also brings the formula-injection guard to this
  // page. It matters more here than anywhere else in the app: `g` can be ANY column,
  // including free-text guest names and rate-plan descriptions that came from an
  // imported CSV, and those group labels land in the first column of the export.
  //
  // BEST OUTCOME NOTE: derive export headers from the same expressions the table
  // renders (`{g}`, `` `${agg} (${v})` ``) rather than re-deriving them. A copy would
  // drift the moment either label changes.
  const exportChart = (fmt) => {
    try {
      const isExcel = fmt === "excel";
      const n = (isExcel ? downloadExcel : downloadCsv)(data, {
        filename: stampFilename(`chart_${agg}_${v}_by_${g}`, isExcel ? "xlsx" : "csv"),
        columns: [
          { key: "name", label: g || "Group" },
          { key: "value", label: `${agg} (${v || "value"})` },
        ],
        sheetName: chartTitle,
      });
      toast({
        title: `Exported ${n.toLocaleString()} group${n === 1 ? "" : "s"}`,
        description: `${chartTitle} · ${dateRangeText}`,
      });
    } catch (e) {
      // Previously a click with no groups downloaded a header-only file and said
      // nothing, which is indistinguishable from a browser that blocked the download.
      toast({
        variant: "destructive",
        title: "Nothing exported",
        description: e?.message || String(e),
      });
    }
  };

  return (
    <div className="space-y-6">
      <header>
        <p className="text-[11px] uppercase tracking-[0.3em] text-[#00D4FF]">Module 5</p>
        <h1 className="mt-2 font-heading text-3xl font-semibold text-white">Universal Chart Builder</h1>
        <p className="mt-1 text-sm text-slate-400">Pick any column for grouping and any column for values.</p>
      </header>

      {/* Without this, a failed read still populated the dataset dropdown but drew an
          empty chart and a "0 groups" summary table — identical to a dataset that
          genuinely has no rows. */}
      {(occQ.isError || srcQ.isError || grossQ.isError || uploadsQ.isError) && (
        <ErrorState
          title="Could not load the chart datasets"
          description="Every bar, slice, and table row below is built from these reads, and at least one failed. An empty chart here means the data did not arrive, not that the dataset is empty."
          error={occQ.error || srcQ.error || grossQ.error || uploadsQ.error}
          onRetry={() => { occQ.refetch(); srcQ.refetch(); grossQ.refetch(); uploadsQ.refetch(); }}
        />
      )}

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
          <div className="flex gap-2">
            <button
              onClick={() => exportChart("csv")}
              className="flex items-center gap-2 rounded-lg bg-[#6C63FF] px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[#5b52e8]"
            >
              <Download className="h-3.5 w-3.5" /> Export CSV
            </button>
            <button
              onClick={() => exportChart("excel")}
              className="flex items-center gap-2 rounded-lg bg-[#107C41] px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[#0e6b38]"
            >
              <Download className="h-3.5 w-3.5" /> Export Excel
            </button>
          </div>
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