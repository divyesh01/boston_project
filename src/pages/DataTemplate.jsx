import React, { useState } from "react";
import { FileSpreadsheet, Download, Table, Building2, Calendar, DollarSign, Users, CreditCard, Receipt, Info } from "lucide-react";
import Card from "@/components/ui-exec/Card";
import { downloadCsv } from "@/lib/hotel";

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

  return (
    <div className="space-y-6">
      <header>
        <p className="text-[11px] uppercase tracking-[0.3em] text-[#00D4FF]">Data Specification</p>
        <h1 className="mt-2 font-heading text-3xl font-semibold text-white">Master Excel Template</h1>
        <p className="mt-1 text-sm text-slate-400">
          Exactly what data you need for one day of hotel operations. Prepare these sheets and upload via Import or Manual Entry.
        </p>
      </header>

      <Card
        title="How to prepare your master Excel"
        subtitle="One workbook, one tab per report type — 3 months of daily data"
      >
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-xl border border-[#6C63FF]/20 bg-[#6C63FF]/[0.06] p-4">
              <Building2 className="h-5 w-5 text-[#6C63FF]" />
              <p className="mt-2 text-sm font-medium text-white">1. One Tab Per Report</p>
              <p className="mt-1 text-xs text-slate-400">Create 5 tabs: Occupancy, Gross Revenue, Source, Payment, Clerk</p>
            </div>
            <div className="rounded-xl border border-[#00D4FF]/20 bg-[#00D4FF]/[0.06] p-4">
              <Calendar className="h-5 w-5 text-[#00D4FF]" />
              <p className="mt-2 text-sm font-medium text-white">2. One Row Per Day</p>
              <p className="mt-1 text-xs text-slate-400">Each day = one row. 90 rows for 3 months of data.</p>
            </div>
            <div className="rounded-xl border border-[#00E096]/20 bg-[#00E096]/[0.06] p-4">
              <Table className="h-5 w-5 text-[#00E096]" />
              <p className="mt-2 text-sm font-medium text-white">3. Use Exact Column Names</p>
              <p className="mt-1 text-xs text-slate-400">Headers must match the field names below exactly.</p>
            </div>
            <div className="rounded-xl border border-[#FFB547]/20 bg-[#FFB547]/[0.06] p-4">
              <DollarSign className="h-5 w-5 text-[#FFB547]" />
              <p className="mt-2 text-sm font-medium text-white">4. Numbers Only</p>
              <p className="mt-1 text-xs text-slate-400">No $ signs or commas in currency fields. Use 4250.00 not $4,250</p>
            </div>
          </div>

          <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-[#0A1628]/60 p-4">
            <Info className="h-5 w-5 shrink-0 text-[#00D4FF]" />
            <div className="flex-1">
              <p className="text-sm text-slate-200">For 3 months of data, you need approximately:</p>
              <p className="mt-1 text-xs text-slate-400">
                <span className="text-white">90 rows</span> in Occupancy · <span className="text-white">90 rows</span> in Gross Revenue ·
                <span className="text-white"> ~270 rows</span> in Source (multiple channels/day) ·
                <span className="text-white"> 90 rows</span> in Payment · <span className="text-white">~180 rows</span> in Clerk
              </p>
            </div>
            <button
              onClick={handleDownloadAll}
              className="flex items-center gap-1.5 rounded-lg bg-[#6C63FF] px-4 py-2 text-sm font-medium text-white hover:bg-[#5b52e8]"
            >
              <Download className="h-4 w-4" /> Download All Templates
            </button>
          </div>
        </div>
      </Card>

      {REPORT_SPECS.map((spec) => {
        const Icon = spec.icon;
        const isOpen = expanded === spec.key;
        return (
          <Card key={spec.key}>
            <button
              onClick={() => setExpanded(isOpen ? null : spec.key)}
              className="flex w-full items-center justify-between"
            >
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl" style={{ background: `${spec.color}15` }}>
                  <Icon className="h-5 w-5" style={{ color: spec.color }} />
                </div>
                <div className="text-left">
                  <h3 className="font-heading text-sm font-semibold text-white">{spec.title}</h3>
                  <p className="text-xs text-slate-400">{spec.description}</p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs text-slate-500">{spec.fields.length} fields</span>
                <button
                  onClick={(e) => { e.stopPropagation(); handleDownload(spec); }}
                  className="flex items-center gap-1 rounded-lg border border-white/10 px-2.5 py-1.5 text-xs text-slate-300 hover:border-[#00D4FF]/30"
                >
                  <Download className="h-3 w-3" /> CSV
                </button>
              </div>
            </button>

            {isOpen && (
              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-[11px] uppercase tracking-widest text-slate-500">
                      <th className="pb-2 pr-4">Field Name</th>
                      <th className="pb-2 pr-4">Type</th>
                      <th className="pb-2 pr-4">Required?</th>
                      <th className="pb-2">Example Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {spec.fields.map((f) => (
                      <tr key={f.name} className="border-t border-white/5">
                        <td className="py-2 pr-4 font-mono text-xs text-[#00D4FF]">{f.name}</td>
                        <td className="py-2 pr-4 text-xs text-slate-400">{f.type}</td>
                        <td className="py-2 pr-4">
                          {f.required ? (
                            <span className="rounded-full bg-[#FF6B6B]/10 px-2 py-0.5 text-[10px] text-[#FF6B6B]">Required</span>
                          ) : (
                            <span className="rounded-full bg-slate-700/30 px-2 py-0.5 text-[10px] text-slate-400">Optional</span>
                          )}
                        </td>
                        <td className="py-2 font-mono text-xs text-slate-300">{f.example}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        );
      })}

      <Card title="Property Setup" subtitle="Also needed in Settings — one row per property">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-widest text-slate-500">
                <th className="pb-2 pr-4">Field</th>
                <th className="pb-2 pr-4">Type</th>
                <th className="pb-2">Example</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-t border-white/5"><td className="py-2 pr-4 font-mono text-xs text-[#00D4FF]">code</td><td className="py-2 pr-4 text-xs text-slate-400">Text</td><td className="py-2 font-mono text-xs text-slate-300">RRI1416</td></tr>
              <tr className="border-t border-white/5"><td className="py-2 pr-4 font-mono text-xs text-[#00D4FF]">name</td><td className="py-2 pr-4 text-xs text-slate-400">Text</td><td className="py-2 font-mono text-xs text-slate-300">Red Roof Inn Middleborough</td></tr>
              <tr className="border-t border-white/5"><td className="py-2 pr-4 font-mono text-xs text-[#00D4FF]">rooms</td><td className="py-2 pr-4 text-xs text-slate-400">Number</td><td className="py-2 font-mono text-xs text-slate-300">100</td></tr>
              <tr className="border-t border-white/5"><td className="py-2 pr-4 font-mono text-xs text-[#00D4FF]">address</td><td className="py-2 pr-4 text-xs text-slate-400">Text</td><td className="py-2 font-mono text-xs text-slate-300">123 Main St</td></tr>
              <tr className="border-t border-white/5"><td className="py-2 pr-4 font-mono text-xs text-[#00D4FF]">city</td><td className="py-2 pr-4 text-xs text-slate-400">Text</td><td className="py-2 font-mono text-xs text-slate-300">Middleborough</td></tr>
              <tr className="border-t border-white/5"><td className="py-2 pr-4 font-mono text-xs text-[#00D4FF]">state</td><td className="py-2 pr-4 text-xs text-slate-400">Text</td><td className="py-2 font-mono text-xs text-slate-300">MA</td></tr>
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}