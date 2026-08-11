import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React, { useState } from "react";
import { Download, Table, Building2, Calendar, DollarSign, Users, CreditCard, Receipt, Info } from "lucide-react";
import Card from "@/components/ui-exec/Card";
const REPORT_SPECS = [
    {
        key: "occupancy",
        title: "Daily Occupancy Summary",
        icon: Table,
        color: "#6C63FF",
        description: "One row per day per property. Tracks room counts, revenue, occupancy, ADR, RevPAR.",
        fields: [
            { name: "date", type: "Date (YYYY-MM-DD)", required: true, example: "2025-07-15" },
            { name: "day_of_week", type: "Text", required: false, example: "Tuesday" },
            { name: "room_revenue", type: "Currency", required: true, example: "4250.00" },
            { name: "other_room_revenue", type: "Currency", required: false, example: "150.00" },
            { name: "total_revenue", type: "Currency", required: true, example: "4400.00" },
            { name: "total_rooms", type: "Number", required: true, example: "100" },
            { name: "rooms_sold", type: "Number", required: true, example: "75" },
            { name: "rooms_sold_without_comp", type: "Number", required: false, example: "73" },
            { name: "down_rooms", type: "Number", required: false, example: "2" },
            { name: "vacant_rooms", type: "Number", required: false, example: "23" },
            { name: "clean_rooms", type: "Number", required: false, example: "20" },
            { name: "dirty_rooms", type: "Number", required: false, example: "3" },
            { name: "stayover_rooms", type: "Number", required: false, example: "45" },
            { name: "same_day_bookings", type: "Number", required: false, example: "8" },
            { name: "comp_rooms", type: "Number", required: false, example: "2" },
            { name: "house_rooms", type: "Number", required: false, example: "1" },
            { name: "zero_rate_rooms", type: "Number", required: false, example: "0" },
            { name: "day_use_rooms", type: "Number", required: false, example: "0" },
            { name: "no_shows", type: "Number", required: false, example: "3" },
            { name: "cancellations", type: "Number", required: false, example: "5" },
            { name: "total_guests", type: "Number", required: false, example: "120" },
            { name: "adr", type: "Currency", required: false, example: "56.67" },
            { name: "occupancy", type: "Decimal (0-1)", required: false, example: "0.75" },
            { name: "revpar", type: "Currency", required: false, example: "42.50" },
        ],
    },
    {
        key: "gross",
        title: "Daily Gross Revenue Breakdown",
        icon: DollarSign,
        color: "#00D4FF",
        description: "One row per day per property. Revenue split by department.",
        fields: [
            { name: "date", type: "Date (YYYY-MM-DD)", required: true, example: "2025-07-15" },
            { name: "day_of_week", type: "Text", required: false, example: "Tuesday" },
            { name: "room_rent", type: "Currency", required: true, example: "4250.00" },
            { name: "misc_charge", type: "Currency", required: false, example: "45.00" },
            { name: "system_charge", type: "Currency", required: false, example: "20.00" },
            { name: "food", type: "Currency", required: false, example: "0.00" },
            { name: "event", type: "Currency", required: false, example: "0.00" },
            { name: "bar", type: "Currency", required: false, example: "120.00" },
            { name: "laundry", type: "Currency", required: false, example: "15.00" },
            { name: "phone", type: "Currency", required: false, example: "5.00" },
            { name: "other", type: "Currency", required: false, example: "10.00" },
            { name: "non_revenue", type: "Currency", required: false, example: "0.00" },
            { name: "advance_deposit", type: "Currency", required: false, example: "200.00" },
            { name: "beverage", type: "Currency", required: false, example: "80.00" },
        ],
    },
    {
        key: "source",
        title: "Daily Source / Channel Revenue",
        icon: CreditCard,
        color: "#00E096",
        description: "One row per day per booking source (Booking.com, Expedia, Walk-in, etc.).",
        fields: [
            { name: "date", type: "Date (YYYY-MM-DD)", required: true, example: "2025-07-15" },
            { name: "day_of_week", type: "Text", required: false, example: "Tuesday" },
            { name: "code", type: "Text", required: false, example: "BK" },
            { name: "source", type: "Text", required: true, example: "Booking.com" },
            { name: "net_revenue", type: "Currency", required: true, example: "1200.00" },
            { name: "stays", type: "Number", required: true, example: "18" },
            { name: "adr", type: "Currency", required: false, example: "66.67" },
            { name: "occupancy_contribution", type: "Decimal", required: false, example: "0.18" },
            { name: "revpar_contribution", type: "Currency", required: false, example: "12.00" },
        ],
    },
    {
        key: "payment",
        title: "Daily Payment Method Summary",
        icon: Receipt,
        color: "#FFB547",
        description: "One row per day per property. Payment totals by method.",
        fields: [
            { name: "date", type: "Date (YYYY-MM-DD)", required: true, example: "2025-07-15" },
            { name: "day_of_week", type: "Text", required: false, example: "Tuesday" },
            { name: "cash", type: "Currency", required: false, example: "800.00" },
            { name: "check", type: "Currency", required: false, example: "0.00" },
            { name: "closed_balance_folio", type: "Currency", required: false, example: "-50.00" },
            { name: "corpay", type: "Currency", required: false, example: "0.00" },
            { name: "direct_bill", type: "Currency", required: false, example: "0.00" },
            { name: "loyalty_certificate", type: "Currency", required: false, example: "0.00" },
            { name: "loyalty_discount", type: "Currency", required: false, example: "-20.00" },
            { name: "vip_pass", type: "Currency", required: false, example: "0.00" },
            { name: "wire_transfer", type: "Currency", required: false, example: "0.00" },
            { name: "amex", type: "Currency", required: false, example: "300.00" },
            { name: "discover", type: "Currency", required: false, example: "100.00" },
            { name: "master", type: "Currency", required: false, example: "500.00" },
            { name: "visa", type: "Currency", required: false, example: "1200.00" },
            { name: "other", type: "Currency", required: false, example: "50.00" },
            { name: "total", type: "Currency", required: true, example: "3080.00" },
        ],
    },
    {
        key: "clerk",
        title: "Clerk Shift & Cash Audit",
        icon: Users,
        color: "#FF6B6B",
        description: "One row per clerk shift. Tracks payments, drops, and adjustments.",
        fields: [
            { name: "shift_date", type: "Text (timestamp)", required: true, example: "2025-07-15 03:00 PM - John D" },
            { name: "clerk_name", type: "Text", required: true, example: "John Doe" },
            { name: "record_type", type: "Enum: payment/drop/clerk_payment", required: true, example: "payment" },
            { name: "payment_type", type: "Text", required: false, example: "CASH" },
            { name: "actual", type: "Currency", required: false, example: "800.00" },
            { name: "adjusted", type: "Currency", required: false, example: "800.00" },
            { name: "net_today", type: "Currency", required: false, example: "800.00" },
            { name: "amount", type: "Currency", required: false, example: "500.00" },
            { name: "transaction_count", type: "Number", required: false, example: "12" },
        ],
    },
];
function generateTemplateCsv(spec) {
    const headers = spec.fields.map((f) => f.name);
    const exampleRow = spec.fields.map((f) => f.example || "");
    return [headers.join(","), exampleRow.join(",")].join("\n");
}
export default function DataTemplate() {
    const [expanded, setExpanded] = useState("occupancy");
    const handleDownload = (spec) => {
        const csv = generateTemplateCsv(spec);
        const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `template_${spec.key}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    };
    const handleDownloadAll = () => {
        REPORT_SPECS.forEach((spec, i) => {
            setTimeout(() => handleDownload(spec), i * 200);
        });
    };
    return (_jsxs("div", { className: "space-y-6", children: [_jsxs("header", { children: [_jsx("p", { className: "text-[11px] uppercase tracking-[0.3em] text-[#00D4FF]", children: "Data Specification" }), _jsx("h1", { className: "mt-2 font-heading text-3xl font-semibold text-white", children: "Master Excel Template" }), _jsx("p", { className: "mt-1 text-sm text-slate-400", children: "Exactly what data you need for one day of hotel operations. Prepare these sheets and upload via Import or Manual Entry." })] }), _jsx(Card, { title: "How to prepare your master Excel", subtitle: "One workbook, one tab per report type \u2014 3 months of daily data", children: _jsxs("div", { className: "space-y-4", children: [_jsxs("div", { className: "grid gap-3 sm:grid-cols-2 lg:grid-cols-4", children: [_jsxs("div", { className: "rounded-xl border border-[#6C63FF]/20 bg-[#6C63FF]/[0.06] p-4", children: [_jsx(Building2, { className: "h-5 w-5 text-[#6C63FF]" }), _jsx("p", { className: "mt-2 text-sm font-medium text-white", children: "1. One Tab Per Report" }), _jsx("p", { className: "mt-1 text-xs text-slate-400", children: "Create 5 tabs: Occupancy, Gross Revenue, Source, Payment, Clerk" })] }), _jsxs("div", { className: "rounded-xl border border-[#00D4FF]/20 bg-[#00D4FF]/[0.06] p-4", children: [_jsx(Calendar, { className: "h-5 w-5 text-[#00D4FF]" }), _jsx("p", { className: "mt-2 text-sm font-medium text-white", children: "2. One Row Per Day" }), _jsx("p", { className: "mt-1 text-xs text-slate-400", children: "Each day = one row. 90 rows for 3 months of data." })] }), _jsxs("div", { className: "rounded-xl border border-[#00E096]/20 bg-[#00E096]/[0.06] p-4", children: [_jsx(Table, { className: "h-5 w-5 text-[#00E096]" }), _jsx("p", { className: "mt-2 text-sm font-medium text-white", children: "3. Use Exact Column Names" }), _jsx("p", { className: "mt-1 text-xs text-slate-400", children: "Headers must match the field names below exactly." })] }), _jsxs("div", { className: "rounded-xl border border-[#FFB547]/20 bg-[#FFB547]/[0.06] p-4", children: [_jsx(DollarSign, { className: "h-5 w-5 text-[#FFB547]" }), _jsx("p", { className: "mt-2 text-sm font-medium text-white", children: "4. Numbers Only" }), _jsx("p", { className: "mt-1 text-xs text-slate-400", children: "No $ signs or commas in currency fields. Use 4250.00 not $4,250" })] })] }), _jsxs("div", { className: "flex items-center gap-3 rounded-xl border border-white/10 bg-[#0A1628]/60 p-4", children: [_jsx(Info, { className: "h-5 w-5 shrink-0 text-[#00D4FF]" }), _jsxs("div", { className: "flex-1", children: [_jsx("p", { className: "text-sm text-slate-200", children: "For 3 months of data, you need approximately:" }), _jsxs("p", { className: "mt-1 text-xs text-slate-400", children: [_jsx("span", { className: "text-white", children: "90 rows" }), " in Occupancy \u00B7 ", _jsx("span", { className: "text-white", children: "90 rows" }), " in Gross Revenue \u00B7", _jsx("span", { className: "text-white", children: " ~270 rows" }), " in Source (multiple channels/day) \u00B7", _jsx("span", { className: "text-white", children: " 90 rows" }), " in Payment \u00B7 ", _jsx("span", { className: "text-white", children: "~180 rows" }), " in Clerk"] })] }), _jsxs("button", { onClick: handleDownloadAll, className: "flex items-center gap-1.5 rounded-lg bg-[#6C63FF] px-4 py-2 text-sm font-medium text-white hover:bg-[#5b52e8]", children: [_jsx(Download, { className: "h-4 w-4" }), " Download All Templates"] })] })] }) }), REPORT_SPECS.map((spec) => {
                const Icon = spec.icon;
                const isOpen = expanded === spec.key;
                return (_jsxs(Card, { children: [_jsxs("button", { onClick: () => setExpanded(isOpen ? null : spec.key), className: "flex w-full items-center justify-between", children: [_jsxs("div", { className: "flex items-center gap-3", children: [_jsx("div", { className: "flex h-10 w-10 items-center justify-center rounded-xl", style: { background: `${spec.color}15` }, children: _jsx(Icon, { className: "h-5 w-5", style: { color: spec.color } }) }), _jsxs("div", { className: "text-left", children: [_jsx("h3", { className: "font-heading text-sm font-semibold text-white", children: spec.title }), _jsx("p", { className: "text-xs text-slate-400", children: spec.description })] })] }), _jsxs("div", { className: "flex items-center gap-3", children: [_jsxs("span", { className: "text-xs text-slate-500", children: [spec.fields.length, " fields"] }), _jsxs("button", { onClick: (e) => { e.stopPropagation(); handleDownload(spec); }, className: "flex items-center gap-1 rounded-lg border border-white/10 px-2.5 py-1.5 text-xs text-slate-300 hover:border-[#00D4FF]/30", children: [_jsx(Download, { className: "h-3 w-3" }), " CSV"] })] })] }), isOpen && (_jsx("div", { className: "mt-4 overflow-x-auto", children: _jsxs("table", { className: "w-full text-sm", children: [_jsx("thead", { children: _jsxs("tr", { className: "text-left text-[11px] uppercase tracking-widest text-slate-500", children: [_jsx("th", { className: "pb-2 pr-4", children: "Field Name" }), _jsx("th", { className: "pb-2 pr-4", children: "Type" }), _jsx("th", { className: "pb-2 pr-4", children: "Required?" }), _jsx("th", { className: "pb-2", children: "Example Value" })] }) }), _jsx("tbody", { children: spec.fields.map((f) => (_jsxs("tr", { className: "border-t border-white/5", children: [_jsx("td", { className: "py-2 pr-4 font-mono text-xs text-[#00D4FF]", children: f.name }), _jsx("td", { className: "py-2 pr-4 text-xs text-slate-400", children: f.type }), _jsx("td", { className: "py-2 pr-4", children: f.required ? (_jsx("span", { className: "rounded-full bg-[#FF6B6B]/10 px-2 py-0.5 text-[10px] text-[#FF6B6B]", children: "Required" })) : (_jsx("span", { className: "rounded-full bg-slate-700/30 px-2 py-0.5 text-[10px] text-slate-400", children: "Optional" })) }), _jsx("td", { className: "py-2 font-mono text-xs text-slate-300", children: f.example })] }, f.name))) })] }) }))] }, spec.key));
            }), _jsx(Card, { title: "Property Setup", subtitle: "Also needed in Settings \u2014 one row per property", children: _jsx("div", { className: "overflow-x-auto", children: _jsxs("table", { className: "w-full text-sm", children: [_jsx("thead", { children: _jsxs("tr", { className: "text-left text-[11px] uppercase tracking-widest text-slate-500", children: [_jsx("th", { className: "pb-2 pr-4", children: "Field" }), _jsx("th", { className: "pb-2 pr-4", children: "Type" }), _jsx("th", { className: "pb-2", children: "Example" })] }) }), _jsxs("tbody", { children: [_jsxs("tr", { className: "border-t border-white/5", children: [_jsx("td", { className: "py-2 pr-4 font-mono text-xs text-[#00D4FF]", children: "code" }), _jsx("td", { className: "py-2 pr-4 text-xs text-slate-400", children: "Text" }), _jsx("td", { className: "py-2 font-mono text-xs text-slate-300", children: "RRI1416" })] }), _jsxs("tr", { className: "border-t border-white/5", children: [_jsx("td", { className: "py-2 pr-4 font-mono text-xs text-[#00D4FF]", children: "name" }), _jsx("td", { className: "py-2 pr-4 text-xs text-slate-400", children: "Text" }), _jsx("td", { className: "py-2 font-mono text-xs text-slate-300", children: "Red Roof Inn Middleborough" })] }), _jsxs("tr", { className: "border-t border-white/5", children: [_jsx("td", { className: "py-2 pr-4 font-mono text-xs text-[#00D4FF]", children: "rooms" }), _jsx("td", { className: "py-2 pr-4 text-xs text-slate-400", children: "Number" }), _jsx("td", { className: "py-2 font-mono text-xs text-slate-300", children: "100" })] }), _jsxs("tr", { className: "border-t border-white/5", children: [_jsx("td", { className: "py-2 pr-4 font-mono text-xs text-[#00D4FF]", children: "address" }), _jsx("td", { className: "py-2 pr-4 text-xs text-slate-400", children: "Text" }), _jsx("td", { className: "py-2 font-mono text-xs text-slate-300", children: "123 Main St" })] }), _jsxs("tr", { className: "border-t border-white/5", children: [_jsx("td", { className: "py-2 pr-4 font-mono text-xs text-[#00D4FF]", children: "city" }), _jsx("td", { className: "py-2 pr-4 text-xs text-slate-400", children: "Text" }), _jsx("td", { className: "py-2 font-mono text-xs text-slate-300", children: "Middleborough" })] }), _jsxs("tr", { className: "border-t border-white/5", children: [_jsx("td", { className: "py-2 pr-4 font-mono text-xs text-[#00D4FF]", children: "state" }), _jsx("td", { className: "py-2 pr-4 text-xs text-slate-400", children: "Text" }), _jsx("td", { className: "py-2 font-mono text-xs text-slate-300", children: "MA" })] })] })] }) }) })] }));
}
