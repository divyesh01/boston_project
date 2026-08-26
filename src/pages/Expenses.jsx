import { db } from '@/api/base44Client';

import React, { useState, useMemo } from "react";
import { Plus, Trash2, TrendingUp, TrendingDown, Wallet, Receipt, Users, DollarSign } from "lucide-react";
import Card from "@/components/ui-exec/Card";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useRef } from "react";
import { useGlobalFilters, MONTHS_LONG } from "@/lib/useGlobalFilters";
import { useOccupancy, usePaymentData } from "@/lib/useHotelData";
import { sum, inRange, pct, C, money2 } from "@/lib/hotel";
// `hours` on a timecard-derived PayrollRun is an exact quotient of worked minutes
// (2,243 min renders as 37.38333333333333), because the money is computed from the
// minutes and rounding the hours first is what used to lose cents. Hours are a
// reading for humans, so they are formatted here rather than at the source.
import { formatNumber } from "@/lib/decimal";
import { calculatePay, filterCommittedPay } from "@/lib/payrollCalc";
import { refundTotal } from "@/lib/paymentNorm";
import { toast } from "sonner";
import { EXPENSE_CATEGORIES, EXPENSE_FREQUENCIES, EXPENSE_STATUSES, expenseLabel, frequencyLabel, isStandardCategory, slugifyCategory } from "@/lib/expenseCategories";
import { getCsrfToken, sensitiveActionRateLimiter, validateCsrfToken, rotateCsrfToken, sanitizeCsvCell } from "@/lib/securityUtils";
import { guardDestructiveAction } from "@/lib/deleteGuard";
import { ErrorState } from "@/components/ui/status";

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
      return db.entities.Expense.filter(filter, "-expense_date", 100000);
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
      return db.entities.PayrollRun.filter(filter, "-pay_period_start", 100000);
    },
  });
}

export default function Expenses() {
  const { property, properties, dateRange, months, period, year } = useGlobalFilters();
  const occQ = useOccupancy(dateRange, property, months);
  const payQ = usePaymentData(dateRange, property, months);
  const { data: occ = [] } = occQ;
  const { data: payRecords = [] } = payQ;
  const qc = useQueryClient();
  const expensesQ = useExpenses(property);
  const payrollQ = usePayroll(property);
  const { data: expenses = [] } = expensesQ;
  const { data: payroll = [] } = payrollQ;
  // A failed read renders as "No expenses match your filters" — zero cost, which
  // inflates every net-profit figure derived from this page. occ/pay feed
  // grossRevenue/netRevenue, so a failure there is just as corrupting as an
  // expenses/payroll failure and must stop the page the same way.
  const readFailed = expensesQ.isError ? expensesQ : payrollQ.isError ? payrollQ : occQ.isError ? occQ : payQ.isError ? payQ : null;
  const retryReads = () => { expensesQ.refetch(); payrollQ.refetch(); occQ.refetch(); payQ.refetch(); };
  const [showForm, setShowForm] = useState(false);
  const [showPayrollForm, setShowPayrollForm] = useState(false);
  const [targetMargin, setTargetMargin] = useState(15);
  const [form, setForm] = useState({
    expense_name: "", vendor: "", category: "other", customCat: "", frequency: "one_time",
    amount: "", expense_date: new Date().toISOString().slice(0, 10), payment_status: "unpaid",
    taxable: true,
  });
  const customSelected = !isStandardCategory(form.category);
  const customCategory = customSelected ? "__custom__" : form.category;
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
  const grossRevenue = sum(occRows, "room_revenue");
  const refundsAndAdjustments = refundTotal(payRows);
  const netRevenue = grossRevenue - refundsAndAdjustments;

  // Cost calculations (scoped to the selected period so they match the revenue window)
  const expensesInPeriod = useMemo(
    () => expenses.filter((e) => inRange(e.expense_date, dateRange.from, dateRange.to)),
    [expenses, dateRange]
  );
  // Committed runs only, so the payroll cost here matches Money Kept.
  const payrollInPeriod = useMemo(
    () => filterCommittedPay(payroll).filter((p) => inRange(p.pay_period_start, dateRange.from, dateRange.to)),
    [payroll, dateRange]
  );
  const totalPayroll = sum(payrollInPeriod, "total_pay");
  const operatingExpenses = (expensesInPeriod || [])
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
    // Rate limiting for sensitive actions
    const rateLimit = sensitiveActionRateLimiter.check();
    if (!rateLimit.allowed) {
      toast.error(`Rate limited. Try again in ${Math.ceil(rateLimit.retryAfter / 60)} minutes.`);
      return;
    }
    // CSRF validation
    const csrfToken = getCsrfToken();
    if (!validateCsrfToken(csrfToken)) {
      toast.error("Invalid security token. Please refresh the page and try again.");
      rotateCsrfToken();
      return;
    }

    if (!form.expense_name || !form.amount) {
      toast.error("Expense name and amount are required.");
      return;
    }
    if (Number(form.amount) <= 0) {
      toast.error("Amount must be greater than zero.");
      return;
    }
    let category = form.category;
    if (customSelected) {
      if (form.category === "__custom__") {
        if (!String(form.customCat || "").trim()) {
          toast.error("Enter a name for the custom category.");
          return;
        }
        category = slugifyCategory(form.customCat);
      }
    }
    const prop = properties.find((p) => p.id === (Array.isArray(property) ? property[0] : property));
    try {
      await db.entities.Expense.create({
        expense_name: sanitizeCsvCell(String(form.expense_name || "").trim()),
        vendor: sanitizeCsvCell(String(form.vendor || "").trim()),
        category,
        frequency: form.frequency,
        expense_date: form.expense_date,
        payment_status: form.payment_status,
        amount: Number(form.amount) || 0,
        recurring: form.frequency !== "one_time",
        taxable: form.taxable !== false,
        property_id: property !== "all" ? (Array.isArray(property) ? property[0] : property) : "",
        property_name: prop?.name || "",
      });
      toast.success(`Expense "${form.expense_name}" saved.`);
    } catch {
      toast.error("Could not save the expense. Please try again.");
      return;
    }
    setForm({ expense_name: "", vendor: "", category: "other", customCat: "", frequency: "one_time", amount: "", expense_date: new Date().toISOString().slice(0, 10), payment_status: "unpaid", taxable: true });
    qc.invalidateQueries({ queryKey: ["expenses"] });
    setShowForm(false);
    rotateCsrfToken();
  };

  const handleToggleTaxable = async (id, current) => {
    await db.entities.Expense.update(id, { taxable: !current });
    qc.invalidateQueries({ queryKey: ["expenses"] });
  };

  const customCats = useMemo(() => [...new Set(expenses.map((e) => e.category).filter((c) => c && !isStandardCategory(c)))].sort(), [expenses]);

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

  const expParentRef = useRef();
  const expVirtualizer = useVirtualizer({
    count: filteredExpenses.length,
    getScrollElement: () => expParentRef.current,
    estimateSize: () => 64,
    overscan: 10,
  });

  const payrollParentRef = useRef();
  const payrollVirtualizer = useVirtualizer({
    count: payroll.length,
    getScrollElement: () => payrollParentRef.current,
    estimateSize: () => 64,
    overscan: 10,
  });

  const handleAddPayroll = async () => {
    // Rate limiting for sensitive actions
    const rateLimit = sensitiveActionRateLimiter.check();
    if (!rateLimit.allowed) {
      toast.error(`Rate limited. Try again in ${Math.ceil(rateLimit.retryAfter / 60)} minutes.`);
      return;
    }
    // CSRF validation
    const csrfToken = getCsrfToken();
    if (!validateCsrfToken(csrfToken)) {
      toast.error("Invalid security token. Please refresh the page and try again.");
      rotateCsrfToken();
      return;
    }

    if (!payrollForm.employee_name) return;
    const prop = properties.find((p) => p.id === (Array.isArray(property) ? property[0] : property));

    // Pay is computed by the shared calculatePay, not here.
    //
    // This handler used to do its own arithmetic, and it had no pay_type branch:
    //
    //     const reg = (Number(payrollForm.base_rate) || 0) * (Number(payrollForm.hours) || 0);
    //
    // The form above offers a Salary option, and its Hours box defaults to "40" and
    // is rendered for every pay type. So a salaried employee recorded at $3,000 was
    // written to the ledger as regular_pay $120,000 — the period salary multiplied by
    // the hours box, a 40x overstatement — stored next to pay_type: "salary", which
    // asserts the opposite. calculatePay's contract is that "salary" treats base_rate
    // as the WHOLE period amount, and it does every step in integer cents, which the
    // float `*` and `+` here did not. src/pages/Payroll.jsx's manual Add Entry has
    // always gone through it; this page was the odd one out.
    //
    // Spread order is load-bearing: payrollForm holds raw <input> strings, so payCalc
    // must land AFTER it to replace them with coerced numbers. PayrollRun.jsonc types
    // base_rate, hours, overtime_hours, overtime_rate and every *_pay field as
    // "number", and overtime_hours was the one field the old code never coerced — it
    // persisted as the string "0" from this page and as 0 from the other.
    //
    // scripts/probe-payroll-entry-parity.mjs holds both entry points to this.
    const payCalc = calculatePay({
      pay_type: payrollForm.pay_type,
      base_rate: payrollForm.base_rate,
      hours: payrollForm.hours,
      overtime_hours: payrollForm.overtime_hours,
      bonus: payrollForm.bonus,
      deductions: payrollForm.deductions,
    });
    await db.entities.PayrollRun.create({
      ...payrollForm,
      ...payCalc,
      // Money Kept only moves on approved/paid, so writing "draft" changes no figure
      // anywhere — it was already the fallback every reader applied to a run with no
      // status. It is written explicitly because the schema declares an enum and a row
      // that omits it is invalid, and because the delete dialog quotes this field back
      // to the owner before destroying the record.
      payroll_status: "draft",
      property_id: property !== "all" ? (Array.isArray(property) ? property[0] : property) : "",
      property_name: prop?.name || "",
    });
    setPayrollForm({ employee_name: "", department: "Front Desk", pay_type: "hourly", base_rate: "", hours: "40", overtime_hours: "0", bonus: "0", deductions: "0", pay_period_start: new Date().toISOString().slice(0, 10), pay_period_end: new Date().toISOString().slice(0, 10) });
    qc.invalidateQueries({ queryKey: ["payroll"] });
    setShowPayrollForm(false);
    rotateCsrfToken();
  };

  // Both deletes below already had CSRF and rate limiting but no confirmation:
  // one click on a small trash icon in a virtualised list destroyed a financial
  // record. The shared guard adds the dialog and keeps the two security checks
  // in the same order everywhere in the app.
  const handleDelete = async (x) => {
    const gate = guardDestructiveAction({
      title: `Delete the expense "${x?.expense_name || "untitled"}"?`,
      lines: [
        `${money2(x?.amount || 0)} · ${x?.vendor || "no vendor"} · ${expenseLabel(x?.category)} · ${frequencyLabel(x?.frequency)}`,
        "Net profit and break-even on this page are computed from expenses, so both will change.",
      ],
    });
    if (!gate.ok) {
      if (gate.message) toast.error(gate.message);
      return;
    }

    try {
      await db.entities.Expense.delete(x.id);
      toast.success(`Expense "${x?.expense_name || "untitled"}" deleted.`);
    } catch (err) {
      toast.error(`Could not delete the expense: ${err?.message || err}. Nothing was removed.`);
      return;
    }
    qc.invalidateQueries({ queryKey: ["expenses"] });
    gate.complete();
  };

  const handleDeletePayroll = async (p) => {
    const committed = p?.payroll_status === "approved" || p?.payroll_status === "paid";
    const gate = guardDestructiveAction({
      title: `Delete the payroll run for ${p?.employee_name || "this employee"}?`,
      lines: [
        `${money2(p?.total_pay || 0)} · ${p?.department || "no department"} · ${formatNumber(p?.hours || 0, 'auto')}h · marked ${p?.payroll_status || "draft"}`,
        committed
          ? `This run is ${p.payroll_status}, so deleting it removes the record of pay already committed and will increase reported Money Kept by ${money2(p?.total_pay || 0)}.`
          : "This run is not approved or paid, so Money Kept does not change.",
      ],
    });
    if (!gate.ok) {
      if (gate.message) toast.error(gate.message);
      return;
    }

    try {
      await db.entities.PayrollRun.delete(p.id);
      toast.success(`Payroll run for ${p?.employee_name || "employee"} deleted.`);
    } catch (err) {
      // This delete used to have no error handling at all: a rejection left the
      // row on screen with no message, which reads as "the click didn't register".
      toast.error(`Could not delete the payroll run: ${err?.message || err}. Nothing was removed.`);
      return;
    }
    qc.invalidateQueries({ queryKey: ["payroll"] });
    gate.complete();
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

      {readFailed && (
        <ErrorState
          title="Could not load costs"
          description="Expense and payroll figures below are incomplete because a read failed. Treat every net-profit and break-even number on this page as unreliable until it loads."
          error={readFailed.error}
          onRetry={retryReads}
        />
      )}

      {/* SECTION 1: Revenue */}
      <Card title="Revenue" subtitle="Gross revenue from imported reports, refunds & adjustments, and net revenue">
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="rounded-xl border border-white/5 bg-[#0A1628]/60 p-4">
            <div className="flex items-center justify-between">
              <p className="text-xs uppercase tracking-widest text-slate-500">Gross Revenue (Imported)</p>
              <DollarSign className="h-4 w-4 text-slate-600" />
            </div>
            <p className="mt-2 font-heading text-2xl font-semibold text-white">{money2(grossRevenue)}</p>
            <p className="mt-1 text-xs text-slate-500">From {occRows.length} days of occupancy data</p>
          </div>
          <div className="rounded-xl border border-[#FF6B6B]/10 bg-[#FF6B6B]/[0.03] p-4">
            <div className="flex items-center justify-between">
              <p className="text-xs uppercase tracking-widest text-slate-500">Refunds & Adjustments</p>
              <TrendingDown className="h-4 w-4 text-[#FF6B6B]/60" />
            </div>
            <p className="mt-2 font-heading text-2xl font-semibold text-[#FF6B6B]">-{money2(refundsAndAdjustments)}</p>
            <p className="mt-1 text-xs text-slate-500">Folio closures, loyalty discounts</p>
          </div>
          <div className="rounded-xl border border-[#00E096]/10 bg-[#00E096]/[0.03] p-4">
            <div className="flex items-center justify-between">
              <p className="text-xs uppercase tracking-widest text-slate-500">Net Revenue</p>
              <TrendingUp className="h-4 w-4 text-[#00E096]/60" />
            </div>
            <p className="mt-2 font-heading text-2xl font-semibold text-[#00E096]">{money2(netRevenue)}</p>
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
            <p className="mt-2 font-heading text-2xl font-semibold text-white">{money2(totalPayroll)}</p>
            <p className="mt-1 text-xs text-slate-500">{payrollInPeriod.length} payroll records</p>
          </div>
          <div className="rounded-xl border border-white/5 bg-[#0A1628]/60 p-4">
            <div className="flex items-center justify-between">
              <p className="text-xs uppercase tracking-widest text-slate-500">Total Operating Expenses</p>
              <Receipt className="h-4 w-4 text-slate-600" />
            </div>
            <p className="mt-2 font-heading text-2xl font-semibold text-white">{money2(operatingExpenses)}</p>
            <p className="mt-1 text-xs text-slate-500">{expensesInPeriod.length} expense entries</p>
          </div>
          <div className="rounded-xl border border-white/5 bg-[#0A1628]/60 p-4">
            <div className="flex items-center justify-between">
              <p className="text-xs uppercase tracking-widest text-slate-500">Total Monthly Costs</p>
              <Wallet className="h-4 w-4 text-slate-600" />
            </div>
            <p className="mt-2 font-heading text-2xl font-semibold text-[#FFB547]">{money2(totalCosts)}</p>
            <p className="mt-1 text-xs text-slate-500">Payroll + Operating Expenses</p>
          </div>
        </div>
      </Card>

      {/* SECTION 3: Estimated Operating Profit */}
      <Card title="Estimated Operating Profit" subtitle="Net Revenue − Payroll − Operating Expenses">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-xl border border-white/5 bg-[#0A1628]/60 p-4">
            <p className="text-xs uppercase tracking-widest text-slate-500">Net Revenue</p>
            <p className="mt-1 font-heading text-xl font-semibold text-white">{money2(netRevenue)}</p>
          </div>
          <div className="rounded-xl border border-white/5 bg-[#0A1628]/60 p-4">
            <p className="text-xs uppercase tracking-widest text-slate-500">Total Costs</p>
            <p className="mt-1 font-heading text-xl font-semibold text-[#FFB547]">{money2(totalCosts)}</p>
          </div>
          <div className="rounded-xl border border-white/5 bg-[#0A1628]/60 p-4">
            <p className="text-xs uppercase tracking-widest text-slate-500">Profit Margin</p>
            <p className="mt-1 font-heading text-xl font-semibold" style={{ color: profitMargin >= 0 ? C.green : C.coral }}>{pct(profitMargin)}</p>
          </div>
          <div className={`rounded-xl border p-4 ${operatingProfit >= 0 ? "border-[#00E096]/15 bg-[#00E096]/[0.05]" : "border-[#FF6B6B]/15 bg-[#FF6B6B]/[0.05]"}`}>
            <p className="text-xs uppercase tracking-widest text-slate-500">Operating Profit</p>
            <p className={`mt-1 font-heading text-xl font-semibold ${operatingProfit >= 0 ? "text-[#00E096]" : "text-[#FF6B6B]"}`}>
              {operatingProfit >= 0 ? "+" : ""}{money2(operatingProfit)}
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
              <p className="font-heading text-lg text-[#00D4FF]">{targetMargin > 0 ? money2(targetRevenue) : "—"}</p>
            </div>
            <div>
              <p className="text-xs text-slate-500">Current Revenue</p>
              <p className="font-heading text-lg text-white">{money2(netRevenue)}</p>
            </div>
            <div>
              <p className="text-xs text-slate-500">Remaining to Target</p>
              <p className={`font-heading text-lg ${revenueRemaining <= 0 ? "text-[#00E096]" : "text-[#FFB547]"}`}>
                {targetMargin > 0 ? money2(Math.max(0, revenueRemaining)) : "—"}
              </p>
            </div>
          </div>
        </div>
      </Card>

      {/* SECTION 4: Expense & Payroll Management */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card
          title="Expense Tracker"
          subtitle={`${filteredExpenses.length} of ${expenses.length} expenses · ${money2(operatingExpenses)} total`}
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
              <select
                value={customCategory}
                onChange={(e) => setForm({ ...form, category: e.target.value === "__custom__" ? "__custom__" : e.target.value, customCat: "" })}
                className="rounded-lg border border-white/10 bg-[#040D1A] px-3 py-2 text-sm text-slate-200 outline-none focus:border-[#00D4FF]"
                aria-label="Expense category"
              >
                {EXPENSE_CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                <option value="__custom__">Custom category…</option>
              </select>
              {customSelected && (
                <input
                  value={form.customCat}
                  onChange={(e) => setForm({ ...form, customCat: e.target.value })}
                  placeholder={form.category === "__custom__" ? "e.g. Snow Removal" : "Custom category name"}
                  className="rounded-lg border border-white/10 bg-[#040D1A] px-3 py-2 text-sm text-slate-200 outline-none focus:border-[#00D4FF]"
                  aria-label="Custom category name"
                />
              )}
              <select value={form.frequency} onChange={(e) => setForm({ ...form, frequency: e.target.value })} className="rounded-lg border border-white/10 bg-[#040D1A] px-3 py-2 text-sm text-slate-200 outline-none focus:border-[#00D4FF]">
                {EXPENSE_FREQUENCIES.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
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
              {EXPENSE_CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
              {customCats.map((c) => <option key={c} value={c}>{expenseLabel(c)}</option>)}
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
              <p className="mt-1 font-heading text-lg text-[#00E096]">{money2(taxableAmount)}</p>
              <p className="text-xs text-slate-500">{taxableExpenses.length} items</p>
            </div>
            <div className="rounded-lg border border-[#FFB547]/10 bg-[#FFB547]/[0.03] p-3">
              <p className="text-[10px] uppercase tracking-widest text-slate-500">Tax-Exempt</p>
              <p className="mt-1 font-heading text-lg text-[#FFB547]">{money2(exemptAmount)}</p>
              <p className="text-xs text-slate-500">{exemptExpenses.length} items</p>
            </div>
          </div>

          <div className="max-h-80 space-y-2 overflow-auto" ref={expParentRef}>
            <div style={{ height: `${expVirtualizer.getTotalSize()}px`, width: '100%', position: 'relative' }}>
              {expVirtualizer.getVirtualItems().map((virtualRow) => {
                const e = filteredExpenses[virtualRow.index];
                return (
                  <div 
                    key={e.id} 
                    style={{ 
                      position: 'absolute', 
                      top: 0, 
                      left: 0, 
                      width: '100%', 
                      height: `${virtualRow.size - 8}px`, // -8 for gap
                      transform: `translateY(${virtualRow.start}px)`
                    }}
                    className="flex items-center justify-between rounded-xl border border-white/5 bg-[#0A1628]/60 px-4 py-3"
                  >
                    <div className="flex items-center gap-3">
                      <div>
                        <p className="text-sm text-white">{e.expense_name}</p>
                        <p className="text-xs text-slate-500">{e.vendor || "—"} · {expenseLabel(e.category)} · {frequencyLabel(e.frequency)}</p>
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
                      <span className="text-sm tabular-nums text-slate-300">{money2(e.amount || 0)}</span>
                      <select
                        value={e.payment_status || "unpaid"}
                        onChange={(ev) => handleStatusChange(e.id, ev.target.value)}
                        className={`rounded-lg border border-white/10 bg-[#040D1A] px-2 py-1 text-xs ${statusColor(e.payment_status)}`}
                      >
                        {EXPENSE_STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                      </select>
                      <button onClick={() => handleDelete(e)} className="text-slate-500 hover:text-[#FF6B6B]">
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
            {!filteredExpenses.length && <p className="text-sm text-slate-500">No expenses match your filters.</p>}
          </div>
        </Card>

        <Card
          title="Payroll Records"
          subtitle={`${payroll.length} records · ${money2(totalPayroll)} total`}
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

          <div className="max-h-80 space-y-2 overflow-auto" ref={payrollParentRef}>
            <div style={{ height: `${payrollVirtualizer.getTotalSize()}px`, width: '100%', position: 'relative' }}>
              {payrollVirtualizer.getVirtualItems().map((virtualRow) => {
                const p = payroll[virtualRow.index];
                return (
                  <div 
                    key={p.id} 
                    style={{ 
                      position: 'absolute', 
                      top: 0, 
                      left: 0, 
                      width: '100%', 
                      height: `${virtualRow.size - 8}px`,
                      transform: `translateY(${virtualRow.start}px)`
                    }}
                    className="flex items-center justify-between rounded-xl border border-white/5 bg-[#0A1628]/60 px-4 py-3"
                  >
                    <div>
                      <p className="text-sm text-white">{p.employee_name}</p>
                      <p className="text-xs text-slate-500">{p.department} · {p.pay_type} · {formatNumber(p.hours || 0, 'auto')}h</p>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-sm tabular-nums text-slate-300">{money2(p.total_pay || 0)}</span>
                      <button onClick={() => handleDeletePayroll(p)} className="text-slate-500 hover:text-[#FF6B6B]">
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
            {!payroll.length && <p className="text-sm text-slate-500">No payroll records yet. Add your first above.</p>}
          </div>
        </Card>
      </div>
    </div>
  );
}