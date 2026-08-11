import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React, { useMemo, useState, useRef } from "react";
import { format, parseISO } from "date-fns";
import { Download } from "lucide-react";
import ResponsiveSelect from "@/components/ui/ResponsiveSelect";
import Card from "@/components/ui-exec/Card";
import UniversalChart from "@/components/charts/UniversalChart";
import ChartToolbar from "@/components/charts/ChartToolbar";
import { useOccupancy, useSources, useGrossRevenue, useUploads } from "@/lib/useHotelData";
import { aggregate, downloadCsv, downloadExcel, num, inRange } from "@/lib/hotel";
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
const Select = ({ value, onChange, options }) => (_jsx(ResponsiveSelect, { value: value, onValueChange: onChange, options: options }));
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
        if (!hasDate || !dateRange.from || !dateRange.to)
            return rows;
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
    return (_jsxs("div", { className: "space-y-6", children: [_jsxs("header", { children: [_jsx("p", { className: "text-[11px] uppercase tracking-[0.3em] text-[#00D4FF]", children: "Module 5" }), _jsx("h1", { className: "mt-2 font-heading text-3xl font-semibold text-white", children: "Universal Chart Builder" }), _jsx("p", { className: "mt-1 text-sm text-slate-400", children: "Pick any column for grouping and any column for values." })] }), _jsxs("div", { className: "grid gap-4 rounded-2xl border border-white/5 bg-[#0F1F35]/60 p-5 sm:grid-cols-2 xl:grid-cols-5", children: [_jsxs("div", { children: [_jsx("label", { className: "mb-1.5 block text-[11px] uppercase tracking-widest text-slate-400", children: "Dataset" }), _jsx(Select, { value: dsKey, onChange: setDsKey, options: datasets.map((d) => [d.key, d.label]) })] }), _jsxs("div", { children: [_jsx("label", { className: "mb-1.5 block text-[11px] uppercase tracking-widest text-slate-400", children: "Group by (X)" }), _jsx(Select, { value: g || "", onChange: setGroupBy, options: columns.map((c) => [c, c]) })] }), _jsxs("div", { children: [_jsx("label", { className: "mb-1.5 block text-[11px] uppercase tracking-widest text-slate-400", children: "Value (Y)" }), _jsx(Select, { value: v || "", onChange: setValueKey, options: columns.map((c) => [c, c]) })] }), _jsxs("div", { children: [_jsx("label", { className: "mb-1.5 block text-[11px] uppercase tracking-widest text-slate-400", children: "Aggregation" }), _jsx(Select, { value: agg, onChange: setAgg, options: AGGS })] }), _jsxs("div", { children: [_jsx("label", { className: "mb-1.5 block text-[11px] uppercase tracking-widest text-slate-400", children: "Chart type" }), _jsx(Select, { value: type, onChange: setType, options: CHARTS })] })] }), _jsxs(Card, { title: chartTitle, subtitle: `${num(filteredRows.length)} source rows · ${data.length} groups`, right: _jsx(ChartToolbar, { targetRef: chartRef, title: chartTitle, dateRange: dateRangeText }), children: [_jsx("div", { ref: chartRef, children: _jsx(UniversalChart, { data: data, type: type }) }), _jsx("p", { className: "mt-3 text-xs text-slate-500", children: dateRangeText })] }), _jsx(Card, { title: "Summary Table", right: _jsxs("div", { className: "flex gap-2", children: [_jsxs("button", { onClick: () => downloadCsv(data, `${g}_${v}_${agg}.csv`), className: "flex items-center gap-2 rounded-lg bg-[#6C63FF] px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[#5b52e8]", children: [_jsx(Download, { className: "h-3.5 w-3.5" }), " Export CSV"] }), _jsxs("button", { onClick: () => downloadExcel(data, `${g}_${v}_${agg}.xlsx`), className: "flex items-center gap-2 rounded-lg bg-[#107C41] px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[#0e6b38]", children: [_jsx(Download, { className: "h-3.5 w-3.5" }), " Export Excel"] })] }), children: _jsx("div", { className: "max-h-80 overflow-auto", children: _jsxs("table", { className: "w-full text-sm", children: [_jsx("thead", { className: "sticky top-0 bg-[#0F1F35] text-left text-[11px] uppercase tracking-widest text-slate-500", children: _jsxs("tr", { children: [_jsx("th", { className: "py-2", children: g }), _jsx("th", { className: "py-2 text-right", children: `${agg} (${v})` })] }) }), _jsx("tbody", { children: data.map((d) => (_jsxs("tr", { className: "border-t border-white/5", children: [_jsx("td", { className: "py-2 text-slate-300", children: d.name }), _jsx("td", { className: "py-2 text-right tabular-nums text-white", children: formatNumber(d.value, 'auto') })] }, d.name))) })] }) }) })] }));
}
