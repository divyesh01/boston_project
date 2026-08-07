import { db } from '@/api/base44Client';

import React, { useState, useMemo } from "react";
import { Plus, Trash2, TrendingUp, TrendingDown, Wallet, Receipt, Users, DollarSign } from "lucide-react";
import Card from "@/components/ui-exec/Card";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useGlobalFilters, MONTHS_LONG } from "@/lib/useGlobalFilters";
import { useOccupancy, usePaymentData } from "@/lib/useHotelData";
import { money, sum, inRange, pct, C } from "@/lib/hotel";

const CATEGORIES = ["utilities", "payroll", "housekeeping", "maintenance", "insurance", "supplies", "marketing", "ota_commission", "taxes", "rent", "other"];
const FREQUENCIES = ["one_time", "weekly", "monthly", "quarterly", "yearly"];
const STATUSES = ["unpaid", "scheduled", "paid", "overdue"];

function useExpenses(propertyId) {
  return useQuery({
    queryKey: ["expenses", Array.isArray(propertyId) ? propertyId.join(",") : propertyId],
    queryFn: () => {
      const filter = {};
      if (propertyId && propertyId !== "all") {
        if (Array.isArray(propertyId)) {
          if (propertyId.length > 0) filter.property_id = { $in: propertyId };
        } else {
          filter.property_id = propertyId;
        }
      }
      return db.entities.Expense.filter(filter, "-expense_date", 500);
    },
  });
}

function usePayroll(propertyId) {
  return useQuery({
    queryKey: ["payroll", Array.isArray(propertyId) ? propertyId.join(",") : propertyId],
    queryFn: () => {
      const filter = {};
      if (propertyId && propertyId !== "all") {
        if (Array.isArray(propertyId)) {
          if (propertyId.length > 0) filter.property_id = { $in: propertyId };
        } else {
          filter.property_id = propertyId;
        }
      }
      return db.entities.PayrollRun.filter(filter, "-pay_period_start", 500);
    },
  });
}

export default function Expenses() {
  const { property, properties, dateRange, months, period, year } = useGlobalFilters();
  const { data: occ = [] } = useOccupancy(dateRange, property, months);
  const { data: payRecords = [] } = usePaymentData(dateRange, property, months);
  const qc = useQueryClient();
  const { data: expenses = [] } = useExpenses(property);
  const { data: payroll = [] } = usePayroll(property);
  const [showForm, setShowForm] = useState(false);
  const [showPayrollForm, setShowPayrollForm] = useState(false);
  const [targetMargin, setTargetMargin] = useState(15);
  const [form, setForm] = useState({
    expense_name: "", vendor: "", category: "other", frequency: "one_time",
    amount: "", expense_date: new Date().toISOString().slice(0, 10), payment_status: "unpaid",
    taxable: true,
  });
  const [expSearch, setExpSearch] = useState("");
  const [expFilterCat, setExpFilterCat] = useState("all");
  const [expFilterTax, setExpFilterTax] = useState("all");
  const [payrollForm, setPayrollForm] = useState({
    employee_name: "", department: "Front Desk", pay_type: "hourly",
    base_rate: "", hours: "40", overtime_hours: "0", bonus: "0", deductions: "0",
    pay_period_start: new Date().toISOString().slice(0, 10),
    pay_period_end: new Date().toISOString().slice(0, 10),
  });

  const occRows = useMemo(() => occ.filter((r) => inRange(r.date, dateRange.from, dateRange.to)), [occ, dateRange]);
  const payRows = useMemo(() => payRecords.filter((r) => inRange(r.date, dateRange.from, dateRange.to)), [payRecords, dateRange]);

  // Revenue calculations
  const grossRevenue = sum(occRows, "total_revenue");
  const refundsAndAdjustments = Math.abs(sum(payRows, "closed_balance_folio")) + Math.abs(sum(payRows, "loyalty_discount"));
  const netRevenue = grossRevenue - refundsAndAdjustments;

  // Cost calculations (scoped to the selected period so they match the revenue window)
  const expensesInPeriod = useMemo(
    () => expenses.filter((e) => inRange(e.expense_date, dateRange.from, dateRange.to)),
    [expenses, dateRange]
  );
  const payrollInPeriod = useMemo(
    () => payroll.filter((p) => inRange(p.pay_period_start, dateRange.from, dateRange.to)),
    [payroll, dateRange]
  );
  const totalPayroll = sum(payrollInPeriod, "total_pay");
  const operatingExpenses = expensesInPeriod
    .filter((e) => e.category !== "payroll")
    .reduce((a, e) => a + (e.amount || 0), 0);
  const totalCosts = totalPayroll + operatingExpenses;

  // Profit
  const operatingProfit = netRevenue - totalCosts;
  const profitMargin = netRevenue > 0 ? operatingProfit / netRevenue : 0;
  const targetRevenue = targetMargin > 0 ? totalCosts / (1 - targetMargin / 100) : 0;
  const revenueRemaining = targetRevenue - netRevenue;

  const periodLabel = period === "monthly" && months.length > 0
    ? months.map((m) => MONTHS_LONG[m]).join(" + ")
    : `${dateRange.from || "—"} → ${dateRange.to || "—"}`;

  const propName = property === "all" ? "All Properties" : (Array.isArray(property) ? `${property.length} Properties` : (properties.find((p) => p.id === property)?.name || "Property"));

  const handleAdd = async () => {
    if (!form.expense_name || !form.amount) return;
    const prop = properties.find((p) => p.id === (Array.isArray(property) ? property[0] : property));
    await db.entities.Expense.create({
      ...form,
      amount: Number(form.amount) || 0,
      recurring: form.frequency !== "one_time",
      taxable: form.taxable !== false,
      property_id: property !== "all" ? (Array.isArray(property) ? property[0] : property) : "",
      property_name: prop?.name || "",
    });
    setForm({ expense_name: "", vendor: "", category: "other", frequency: "one_time", amount: "", expense_date: new Date().toISOString().slice(0, 10), payment_status: "unpaid", taxable: true });
    qc.invalidateQueries({ queryKey: ["expenses"] });
    setShowForm(false);
  };

  const handleToggleTaxable = async (id, current) => {
    await db.entities.Expense.update(id, { taxable: !current });
    qc.invalidateQueries({ queryKey: ["expenses"] });
  };

  // Filtered expenses
  const filteredExpenses = useMemo(() => {
    return expenses.filter((e) => {
      if (expFilterCat !== "all" && e.category !== expFilterCat) return false;
      if (expFilterTax === "taxable" && !e.taxable) return false;
      if (expFilterTax === "exempt" && e.taxable) return false;
      if (expSearch.trim()) {
        const s = expSearch.toLowerCase();
        if (!String(e.expense_name || "").toLowerCase().includes(s) &&
            !String(e.vendor || "").toLowerCase().includes(s) &&
            !String(e.category || "").toLowerCase().includes(s)) return false;
      }
      return true;
    });
  }, [expenses, expFilterCat, expFilterTax, expSearch]);

  const taxableExpenses = expenses.filter((e) => e.taxable !== false);
  const exemptExpenses = expenses.filter((e) => e.taxable === false);
  const taxableAmount = taxableExpenses.reduce((a, e) => a + (e.amount || 0), 0);
  const exemptAmount = exemptExpenses.reduce((a, e) => a + (e.amount || 0), 0);

  const handleAddPayroll = async () => {
    if (!payrollForm.employee_name) return;
    const prop = properties.find((p) => p.id === (Array.isArray(property) ? property[0] : property));
    const reg = (Number(payrollForm.base_rate) || 0) * (Number(payrollForm.hours) || 0);
    const otPay = (Number(payrollForm.base_rate) || 0) * 1.5 * (Number(payrollForm.overtime_hours) || 0);
    const total = reg + otPay + (Number(payrollForm.bonus) || 0) - (Number(payrollForm.deductions) || 0);
    await db.entities.PayrollRun.create({
      ...payrollForm,
      base_rate: Number(payrollForm.base_rate) || 0,
      hours: Number(payrollForm.hours) || 0,
      regular_pay: reg,
      overtime_rate: Number(payrollForm.base_rate) * 1.5 || 0,
      overtime_pay: otPay,
      bonus: Number(payrollForm.bonus) || 0,
      deductions: Number(payrollForm.deductions) || 0,
      total_pay: total,
      property_id: property !== "all" ? (Array.isArray(property) ? property[0] : property) : "",
      property_name: prop?.name || "",
    });
    setPayrollForm({ employee_name: "", department: "Front Desk", pay_type: "hourly", base_rate: "", hours: "40", overtime_hours: "0", bonus: "0", deductions: "0", pay_period_start: new Date().toISOString().slice(0, 10), pay_period_end: new Date().toISOString().slice(0, 10) });
    qc.invalidateQueries({ queryKey: ["payroll"] });
    setShowPayrollForm(false);
  };

  const handleDelete = async (id) => {
    await db.entities.Expense.delete(id);
    qc.invalidateQueries({ queryKey: ["expenses"] });
  };

  const handleDeletePayroll = async (id) => {
    await db.entities.PayrollRun.delete(id);
    qc.invalidateQueries({ queryKey: ["payroll"] });
  };

  const handleStatusChange = async (id, status) => {
    await db.entities.Expense.update(id, { payment_status: status });
    qc.invalidateQueries({ queryKey: ["expenses"] });
  };

  const statusColor = (s) => ({
    paid: "text-[#00E096]", unpaid: "text-[#FFB547]", scheduled: "text-[#00D4FF]", overdue: "text-[#FF6B6B]",
  }[s] || "text-slate-400");

  return (
    <div className="space-y-6" data-page-content>
      <header>
        <p className="text-[11px] uppercase tracking-[0.3em] text-[#00D4FF]">Financial Planning</p>
        <h1 className="mt-2 font-heading text-3xl font-semibold text-white">Business Expenses & Profit Planner</h1>
        <p className="mt-1 text-sm text-slate-400">Manage payroll, track operating expenses, and calculate break-even targets.</p>
        <p className="mt-2 text-xs text-slate-500">{propName} · {periodLabel} · {year}</p>
      </header>

      {/* SECTION 1: Revenue */}
      <Card title="Revenue" subtitle="Gross revenue from imported reports, refunds & adjustments, and net revenue">
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="rounded-xl border border-white/5 bg-[#0A1628]/60 p-4">
            <div className="flex items-center justify-between">
              <p className="text-xs uppercase tracking-widest text-slate-500">Gross Revenue (Imported)</p>
              <DollarSign className="h-4 w-4 text-slate-600" />
            </div>
            <p className="mt-2 font-heading text-2xl font-semibold text-white">{money(grossRevenue)}</p>
            <p className="mt-1 text-xs text-slate-500">From {occRows.length} days of occupancy data</p>
          </div>
          <div className="rounded-xl border border-[#FF6B6B]/10 bg-[#FF6B6B]/[0.03] p-4">
            <div className="flex items-center justify-between">
              <p className="text-xs uppercase tracking-widest text-slate-500">Refunds & Adjustments</p>
              <TrendingDown className="h-4 w-4 text-[#FF6B6B]/60" />
            </div>
            <p className="mt-2 font-heading text-2xl font-semibold text-[#FF6B6B]">-{money(refundsAndAdjustments)}</p>
            <p className="mt-1 text-xs text-slate-500">Folio closures, loyalty discounts</p>
          </div>
          <div className="rounded-xl border border-[#00E096]/10 bg-[#00E096]/[0.03] p-4">
            <div className="flex items-center justify-between">
              <p className="text-xs uppercase tracking-widest text-slate-500">Net Revenue</p>
              <TrendingUp className="h-4 w-4 text-[#00E096]/60" />
            </div>
            <p className="mt-2 font-heading text-2xl font-semibold text-[#00E096]">{money(netRevenue)}</p>
            <p className="mt-1 text-xs text-slate-500">Gross − Refunds</p>
          </div>
        </div>
      </Card>

      {/* SECTION 2: Costs & Expenses */}
      <Card title="Costs & Expenses" subtitle="Payroll and operating expenses for the selected period">
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="rounded-xl border border-white/5 bg-[#0A1628]/60 p-4">
            <div className="flex items-center justify-between">
              <p className="text-xs uppercase tracking-widest text-slate-500">Total Employee Payroll</p>
              <Users className="h-4 w-4 text-slate-600" />
            </div>
            <p className="mt-2 font-heading text-2xl font-semibold text-white">{money(totalPayroll)}</p>
            <p className="mt-1 text-xs text-slate-500">{payrollInPeriod.length} payroll records</p>
          </div>
          <div className="rounded-xl border border-white/5 bg-[#0A1628]/60 p-4">
            <div className="flex items-center justify-between">
              <p className="text-xs uppercase tracking-widest text-slate-500">Total Operating Expenses</p>
              <Receipt className="h-4 w-4 text-slate-600" />
            </div>
            <p className="mt-2 font-heading text-2xl font-semibold text-white">{money(operatingExpenses)}</p>
            <p className="mt-1 text-xs text-slate-500">{expensesInPeriod.length} expense entries</p>
          </div>
          <div className="rounded-xl border border-white/5 bg-[#0A1628]/60 p-4">
            <div className="flex items-center justify-between">
              <p className="text-xs uppercase tracking-widest text-slate-500">Total Monthly Costs</p>
              <Wallet className="h-4 w-4 text-slate-600" />
            </div>
            <p className="mt-2 font-heading text-2xl font-semibold text-[#FFB547]">{money(totalCosts)}</p>
            <p className="mt-1 text-xs text-slate-500">Payroll + Operating Expenses</p>
          </div>
        </div>
      </Card>

      {/* SECTION 3: Estimated Operating Profit */}
      <Card title="Estimated Operating Profit" subtitle="Net Revenue − Payroll − Operating Expenses">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-xl border border-white/5 bg-[#0A1628]/60 p-4">
            <p className="text-xs uppercase tracking-widest text-slate-500">Net Revenue</p>
            <p className="mt-1 font-heading text-xl font-semibold text-white">{money(netRevenue)}</p>
          </div>
          <div className="rounded-xl border border-white/5 bg-[#0A1628]/60 p-4">
            <p className="text-xs uppercase tracking-widest text-slate-500">Total Costs</p>
            <p className="mt-1 font-heading text-xl font-semibold text-[#FFB547]">{money(totalCosts)}</p>
          </div>
          <div className="rounded-xl border border-white/5 bg-[#0A1628]/60 p-4">
            <p className="text-xs uppercase tracking-widest text-slate-500">Profit Margin</p>
            <p className="mt-1 font-heading text-xl font-semibold" style={{ color: profitMargin >= 0 ? C.green : C.coral }}>{pct(profitMargin)}</p>
          </div>
          <div className={`rounded-xl border p-4 ${operatingProfit >= 0 ? "border-[#00E096]/15 bg-[#00E096]/[0.05]" : "border-[#FF6B6B]/15 bg-[#FF6B6B]/[0.05]"}`}>
            <p className="text-xs uppercase tracking-widest text-slate-500">Operating Profit</p>
            <p className={`mt-1 font-heading text-xl font-semibold ${operatingProfit >= 0 ? "text-[#00E096]" : "text-[#FF6B6B]"}`}>
              {operatingProfit >= 0 ? "+" : ""}{money(operatingProfit)}
            </p>
          </div>
        </div>

        <div className="mt-4 rounded-xl border border-white/5 bg-[#0A1628]/60 p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-slate-300">Break-Even Target</p>
              <p className="text-xs text-slate-500">Revenue needed at {targetMargin}% margin target</p>
            </div>
            <div className="flex items-center gap-2">
              <label className="text-xs text-slate-400">Target Margin:</label>
              <input
                type="number" min="0" max="100" value={targetMargin}
                onChange={(e) => setTargetMargin(Number(e.target.value))}
                className="w-20 rounded-lg border border-white/10 bg-[#040D1A] px-3 py-1.5 text-right text-sm text-slate-200 outline-none focus:border-[#00D4FF]"
              />
              <span className="text-sm text-slate-400">%</span>
            </div>
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <div>
              <p className="text-xs text-slate-500">Target Revenue</p>
              <p className="font-heading text-lg text-[#00D4FF]">{targetMargin > 0 ? money(targetRevenue) : "—"}</p>
            </div>
            <div>
              <p className="text-xs text-slate-500">Current Revenue</p>
              <p className="font-heading text-lg text-white">{money(netRevenue)}</p>
            </div>
            <div>
              <p className="text-xs text-slate-500">Remaining to Target</p>
              <p className={`font-heading text-lg ${revenueRemaining <= 0 ? "text-[#00E096]" : "text-[#FFB547]"}`}>
                {targetMargin > 0 ? money(Math.max(0, revenueRemaining)) : "—"}
              </p>
            </div>
          </div>
        </div>
      </Card>

      {/* SECTION 4: Expense & Payroll Management */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card
          title="Expense Tracker"
          subtitle={`${filteredExpenses.length} of ${expenses.length} expenses · ${money(operatingExpenses)} total`}
          right={
            <button
              onClick={() => setShowForm(!showForm)}
              className="flex items-center gap-1.5 rounded-lg bg-[#6C63FF] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#5b52e8]"
            >
              <Plus className="h-3.5 w-3.5" /> Add Expense
            </button>
          }
        >
          {showForm && (
            <div className="mb-4 grid gap-3 rounded-xl border border-white/10 bg-[#0A1628] p-4 sm:grid-cols-2 lg:grid-cols-3">
              <input value={form.expense_name} onChange={(e) => setForm({ ...form, expense_name: e.target.value })} placeholder="Expense name" className="rounded-lg border border-white/10 bg-[#040D1A] px-3 py-2 text-sm text-slate-200 outline-none focus:border-[#00D4FF]" />
              <input value={form.vendor} onChange={(e) => setForm({ ...form, vendor: e.target.value })} placeholder="Vendor" className="rounded-lg border border-white/10 bg-[#040D1A] px-3 py-2 text-sm text-slate-200 outline-none focus:border-[#00D4FF]" />
              <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className="rounded-lg border border-white/10 bg-[#040D1A] px-3 py-2 text-sm text-slate-200 outline-none focus:border-[#00D4FF]">
                {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <select value={form.frequency} onChange={(e) => setForm({ ...form, frequency: e.target.value })} className="rounded-lg border border-white/10 bg-[#040D1A] px-3 py-2 text-sm text-slate-200 outline-none focus:border-[#00D4FF]">
                {FREQUENCIES.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
              <input type="number" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} placeholder="Amount $" className="rounded-lg border border-white/10 bg-[#040D1A] px-3 py-2 text-sm text-slate-200 outline-none focus:border-[#00D4FF]" />
              <input type="date" value={form.expense_date} onChange={(e) => setForm({ ...form, expense_date: e.target.value })} className="rounded-lg border border-white/10 bg-[#040D1A] px-3 py-2 text-sm text-slate-200 outline-none focus:border-[#00D4FF]" />
              <label className="flex items-center gap-2 text-sm text-slate-300">
                <input type="checkbox" checked={form.taxable !== false} onChange={(e) => setForm({ ...form, taxable: e.target.checked })} className="h-4 w-4 rounded border-white/20" />
                Taxable
              </label>
              <button onClick={handleAdd} className="rounded-lg bg-[#00E096] px-4 py-2 text-sm font-medium text-[#040D1A] hover:bg-[#00c885]">Save Expense</button>
            </div>
          )}

          {/* Search & filters */}
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <input type="text" value={expSearch} onChange={(e) => setExpSearch(e.target.value)} placeholder="Search expenses…" className="flex-1 rounded-lg border border-white/10 bg-[#040D1A] px-3 py-2 text-sm text-slate-200 outline-none focus:border-[#00D4FF]" />
            <select value={expFilterCat} onChange={(e) => setExpFilterCat(e.target.value)} className="rounded-lg border border-white/10 bg-[#040D1A] px-3 py-2 text-xs text-slate-200">
              <option value="all">All Categories</option>
              {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <select value={expFilterTax} onChange={(e) => setExpFilterTax(e.target.value)} className="rounded-lg border border-white/10 bg-[#040D1A] px-3 py-2 text-xs text-slate-200">
              <option value="all">All Tax</option>
              <option value="taxable">Taxable</option>
              <option value="exempt">Exempt</option>
            </select>
          </div>

          {/* Tax summary */}
          <div className="mb-4 grid grid-cols-2 gap-3">
            <div className="rounded-lg border border-[#00E096]/10 bg-[#00E096]/[0.03] p-3">
              <p className="text-[10px] uppercase tracking-widest text-slate-500">Taxable Expenses</p>
              <p className="mt-1 font-heading text-lg text-[#00E096]">{money(taxableAmount)}</p>
              <p className="text-xs text-slate-500">{taxableExpenses.length} items</p>
            </div>
            <div className="rounded-lg border border-[#FFB547]/10 bg-[#FFB547]/[0.03] p-3">
              <p className="text-[10px] uppercase tracking-widest text-slate-500">Tax-Exempt</p>
              <p className="mt-1 font-heading text-lg text-[#FFB547]">{money(exemptAmount)}</p>
              <p className="text-xs text-slate-500">{exemptExpenses.length} items</p>
            </div>
          </div>

          <div className="max-h-80 space-y-2 overflow-auto">
            {filteredExpenses.map((e) => (
              <div key={e.id} className="flex items-center justify-between rounded-xl border border-white/5 bg-[#0A1628]/60 px-4 py-3">
                <div className="flex items-center gap-3">
                  <div>
                    <p className="text-sm text-white">{e.expense_name}</p>
                    <p className="text-xs text-slate-500">{e.vendor || "—"} · {e.category} · {e.frequency}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => handleToggleTaxable(e.id, e.taxable)}
                    className={`rounded-full px-2 py-0.5 text-[10px] ${e.taxable !== false ? "bg-[#00E096]/10 text-[#00E096]" : "bg-[#FFB547]/10 text-[#FFB547]"}`}
                    title="Toggle taxable status"
                  >
                    {e.taxable !== false ? "Taxable" : "Exempt"}
                  </button>
                  <span className="text-sm tabular-nums text-slate-300">{money(e.amount || 0)}</span>
                  <select
                    value={e.payment_status || "unpaid"}
                    onChange={(ev) => handleStatusChange(e.id, ev.target.value)}
                    className={`rounded-lg border border-white/10 bg-[#040D1A] px-2 py-1 text-xs ${statusColor(e.payment_status)}`}
                  >
                    {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                  <button onClick={() => handleDelete(e.id)} className="text-slate-500 hover:text-[#FF6B6B]">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ))}
            {!filteredExpenses.length && <p className="text-sm text-slate-500">No expenses match your filters.</p>}
          </div>
        </Card>

        <Card
          title="Payroll Records"
          subtitle={`${payroll.length} records · ${money(totalPayroll)} total`}
          right={
            <button
              onClick={() => setShowPayrollForm(!showPayrollForm)}
              className="flex items-center gap-1.5 rounded-lg bg-[#6C63FF] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#5b52e8]"
            >
              <Plus className="h-3.5 w-3.5" /> Add Payroll
            </button>
          }
        >
          {showPayrollForm && (
            <div className="mb-4 grid gap-3 rounded-xl border border-white/10 bg-[#0A1628] p-4 sm:grid-cols-2 lg:grid-cols-3">
              <input value={payrollForm.employee_name} onChange={(e) => setPayrollForm({ ...payrollForm, employee_name: e.target.value })} placeholder="Employee name" className="rounded-lg border border-white/10 bg-[#040D1A] px-3 py-2 text-sm text-slate-200 outline-none focus:border-[#00D4FF]" />
              <input value={payrollForm.department} onChange={(e) => setPayrollForm({ ...payrollForm, department: e.target.value })} placeholder="Department" className="rounded-lg border border-white/10 bg-[#040D1A] px-3 py-2 text-sm text-slate-200 outline-none focus:border-[#00D4FF]" />
              <select value={payrollForm.pay_type} onChange={(e) => setPayrollForm({ ...payrollForm, pay_type: e.target.value })} className="rounded-lg border border-white/10 bg-[#040D1A] px-3 py-2 text-sm text-slate-200 outline-none focus:border-[#00D4FF]">
                <option value="hourly">Hourly</option>
                <option value="salary">Salary</option>
              </select>
              <input type="number" value={payrollForm.base_rate} onChange={(e) => setPayrollForm({ ...payrollForm, base_rate: e.target.value })} placeholder="Base rate $" className="rounded-lg border border-white/10 bg-[#040D1A] px-3 py-2 text-sm text-slate-200 outline-none focus:border-[#00D4FF]" />
              <input type="number" value={payrollForm.hours} onChange={(e) => setPayrollForm({ ...payrollForm, hours: e.target.value })} placeholder="Hours" className="rounded-lg border border-white/10 bg-[#040D1A] px-3 py-2 text-sm text-slate-200 outline-none focus:border-[#00D4FF]" />
              <input type="number" value={payrollForm.overtime_hours} onChange={(e) => setPayrollForm({ ...payrollForm, overtime_hours: e.target.value })} placeholder="OT hours" className="rounded-lg border border-white/10 bg-[#040D1A] px-3 py-2 text-sm text-slate-200 outline-none focus:border-[#00D4FF]" />
              <input type="number" value={payrollForm.bonus} onChange={(e) => setPayrollForm({ ...payrollForm, bonus: e.target.value })} placeholder="Bonus $" className="rounded-lg border border-white/10 bg-[#040D1A] px-3 py-2 text-sm text-slate-200 outline-none focus:border-[#00D4FF]" />
              <input type="number" value={payrollForm.deductions} onChange={(e) => setPayrollForm({ ...payrollForm, deductions: e.target.value })} placeholder="Deductions $" className="rounded-lg border border-white/10 bg-[#040D1A] px-3 py-2 text-sm text-slate-200 outline-none focus:border-[#00D4FF]" />
              <button onClick={handleAddPayroll} className="rounded-lg bg-[#00E096] px-4 py-2 text-sm font-medium text-[#040D1A] hover:bg-[#00c885]">Save Payroll</button>
            </div>
          )}

          <div className="max-h-80 space-y-2 overflow-auto">
            {payroll.map((p) => (
              <div key={p.id} className="flex items-center justify-between rounded-xl border border-white/5 bg-[#0A1628]/60 px-4 py-3">
                <div>
                  <p className="text-sm text-white">{p.employee_name}</p>
                  <p className="text-xs text-slate-500">{p.department} · {p.pay_type} · {p.hours || 0}h</p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-sm tabular-nums text-slate-300">{money(p.total_pay || 0)}</span>
                  <button onClick={() => handleDeletePayroll(p.id)} className="text-slate-500 hover:text-[#FF6B6B]">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ))}
            {!payroll.length && <p className="text-sm text-slate-500">No payroll records yet. Add your first above.</p>}
          </div>
        </Card>
      </div>
    </div>
  );
}