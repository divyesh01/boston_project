import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { db } from '@/api/base44Client';
import React, { useState, useMemo } from "react";
import { Plus, Trash2, TrendingUp, TrendingDown, Wallet, Receipt, Users, DollarSign } from "lucide-react";
import Card from "@/components/ui-exec/Card";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useGlobalFilters, MONTHS_LONG } from "@/lib/useGlobalFilters";
import { useOccupancy, usePaymentData } from "@/lib/useHotelData";
import { money, sum, inRange, pct, C } from "@/lib/hotel";
import { filterCommittedPay } from "@/lib/payrollCalc";
import { refundTotal } from "@/lib/paymentNorm";
import { toast } from "sonner";
import { EXPENSE_CATEGORIES, EXPENSE_FREQUENCIES, EXPENSE_STATUSES, expenseLabel, frequencyLabel, isStandardCategory, slugifyCategory } from "@/lib/expenseCategories";
import { getCsrfToken, sensitiveActionRateLimiter, validateCsrfToken, rotateCsrfToken, sanitizeCsvCell } from "@/lib/securityUtils";
function useExpenses(propertyId) {
    return useQuery({
        queryKey: ["expenses", Array.isArray(propertyId) ? propertyId.join(",") : propertyId],
        queryFn: () => {
            const filter = {};
            if (propertyId && propertyId !== "all") {
                if (Array.isArray(propertyId)) {
                    if (propertyId.length > 0)
                        filter.property_id = { $in: propertyId };
                }
                else {
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
                    if (propertyId.length > 0)
                        filter.property_id = { $in: propertyId };
                }
                else {
                    filter.property_id = propertyId;
                }
            }
            return db.entities.PayrollRun.filter(filter, "-pay_period_start", 100000);
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
    const grossRevenue = sum(occRows, "total_revenue");
    const refundsAndAdjustments = refundTotal(payRows);
    const netRevenue = grossRevenue - refundsAndAdjustments;
    // Cost calculations (scoped to the selected period so they match the revenue window)
    const expensesInPeriod = useMemo(() => expenses.filter((e) => inRange(e.expense_date, dateRange.from, dateRange.to)), [expenses, dateRange]);
    // Committed runs only, so the payroll cost here matches Money Kept.
    const payrollInPeriod = useMemo(() => filterCommittedPay(payroll).filter((p) => inRange(p.pay_period_start, dateRange.from, dateRange.to)), [payroll, dateRange]);
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
        }
        catch {
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
            if (expFilterCat !== "all" && e.category !== expFilterCat)
                return false;
            if (expFilterTax === "taxable" && !e.taxable)
                return false;
            if (expFilterTax === "exempt" && e.taxable)
                return false;
            if (expSearch.trim()) {
                const s = expSearch.toLowerCase();
                if (!String(e.expense_name || "").toLowerCase().includes(s) &&
                    !String(e.vendor || "").toLowerCase().includes(s) &&
                    !String(e.category || "").toLowerCase().includes(s))
                    return false;
            }
            return true;
        });
    }, [expenses, expFilterCat, expFilterTax, expSearch]);
    const taxableExpenses = expenses.filter((e) => e.taxable !== false);
    const exemptExpenses = expenses.filter((e) => e.taxable === false);
    const taxableAmount = taxableExpenses.reduce((a, e) => a + (e.amount || 0), 0);
    const exemptAmount = exemptExpenses.reduce((a, e) => a + (e.amount || 0), 0);
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
        if (!payrollForm.employee_name)
            return;
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
        rotateCsrfToken();
    };
    const handleDelete = async (id) => {
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
        try {
            await db.entities.Expense.delete(id);
            toast.success("Expense deleted.");
        }
        catch {
            toast.error("Could not delete the expense.");
            return;
        }
        qc.invalidateQueries({ queryKey: ["expenses"] });
        rotateCsrfToken();
    };
    const handleDeletePayroll = async (id) => {
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
        await db.entities.PayrollRun.delete(id);
        qc.invalidateQueries({ queryKey: ["payroll"] });
        rotateCsrfToken();
    };
    const handleStatusChange = async (id, status) => {
        await db.entities.Expense.update(id, { payment_status: status });
        qc.invalidateQueries({ queryKey: ["expenses"] });
    };
    const statusColor = (s) => ({
        paid: "text-[#00E096]", unpaid: "text-[#FFB547]", scheduled: "text-[#00D4FF]", overdue: "text-[#FF6B6B]",
    }[s] || "text-slate-400");
    return (_jsxs("div", { className: "space-y-6", "data-page-content": true, children: [_jsxs("header", { children: [_jsx("p", { className: "text-[11px] uppercase tracking-[0.3em] text-[#00D4FF]", children: "Financial Planning" }), _jsx("h1", { className: "mt-2 font-heading text-3xl font-semibold text-white", children: "Business Expenses & Profit Planner" }), _jsx("p", { className: "mt-1 text-sm text-slate-400", children: "Manage payroll, track operating expenses, and calculate break-even targets." }), _jsxs("p", { className: "mt-2 text-xs text-slate-500", children: [propName, " \u00B7 ", periodLabel, " \u00B7 ", year] })] }), _jsx(Card, { title: "Revenue", subtitle: "Gross revenue from imported reports, refunds & adjustments, and net revenue", children: _jsxs("div", { className: "grid gap-4 sm:grid-cols-3", children: [_jsxs("div", { className: "rounded-xl border border-white/5 bg-[#0A1628]/60 p-4", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsx("p", { className: "text-xs uppercase tracking-widest text-slate-500", children: "Gross Revenue (Imported)" }), _jsx(DollarSign, { className: "h-4 w-4 text-slate-600" })] }), _jsx("p", { className: "mt-2 font-heading text-2xl font-semibold text-white", children: money(grossRevenue) }), _jsxs("p", { className: "mt-1 text-xs text-slate-500", children: ["From ", occRows.length, " days of occupancy data"] })] }), _jsxs("div", { className: "rounded-xl border border-[#FF6B6B]/10 bg-[#FF6B6B]/[0.03] p-4", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsx("p", { className: "text-xs uppercase tracking-widest text-slate-500", children: "Refunds & Adjustments" }), _jsx(TrendingDown, { className: "h-4 w-4 text-[#FF6B6B]/60" })] }), _jsxs("p", { className: "mt-2 font-heading text-2xl font-semibold text-[#FF6B6B]", children: ["-", money(refundsAndAdjustments)] }), _jsx("p", { className: "mt-1 text-xs text-slate-500", children: "Folio closures, loyalty discounts" })] }), _jsxs("div", { className: "rounded-xl border border-[#00E096]/10 bg-[#00E096]/[0.03] p-4", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsx("p", { className: "text-xs uppercase tracking-widest text-slate-500", children: "Net Revenue" }), _jsx(TrendingUp, { className: "h-4 w-4 text-[#00E096]/60" })] }), _jsx("p", { className: "mt-2 font-heading text-2xl font-semibold text-[#00E096]", children: money(netRevenue) }), _jsx("p", { className: "mt-1 text-xs text-slate-500", children: "Gross \u2212 Refunds" })] })] }) }), _jsx(Card, { title: "Costs & Expenses", subtitle: "Payroll and operating expenses for the selected period", children: _jsxs("div", { className: "grid gap-4 sm:grid-cols-3", children: [_jsxs("div", { className: "rounded-xl border border-white/5 bg-[#0A1628]/60 p-4", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsx("p", { className: "text-xs uppercase tracking-widest text-slate-500", children: "Total Employee Payroll" }), _jsx(Users, { className: "h-4 w-4 text-slate-600" })] }), _jsx("p", { className: "mt-2 font-heading text-2xl font-semibold text-white", children: money(totalPayroll) }), _jsxs("p", { className: "mt-1 text-xs text-slate-500", children: [payrollInPeriod.length, " payroll records"] })] }), _jsxs("div", { className: "rounded-xl border border-white/5 bg-[#0A1628]/60 p-4", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsx("p", { className: "text-xs uppercase tracking-widest text-slate-500", children: "Total Operating Expenses" }), _jsx(Receipt, { className: "h-4 w-4 text-slate-600" })] }), _jsx("p", { className: "mt-2 font-heading text-2xl font-semibold text-white", children: money(operatingExpenses) }), _jsxs("p", { className: "mt-1 text-xs text-slate-500", children: [expensesInPeriod.length, " expense entries"] })] }), _jsxs("div", { className: "rounded-xl border border-white/5 bg-[#0A1628]/60 p-4", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsx("p", { className: "text-xs uppercase tracking-widest text-slate-500", children: "Total Monthly Costs" }), _jsx(Wallet, { className: "h-4 w-4 text-slate-600" })] }), _jsx("p", { className: "mt-2 font-heading text-2xl font-semibold text-[#FFB547]", children: money(totalCosts) }), _jsx("p", { className: "mt-1 text-xs text-slate-500", children: "Payroll + Operating Expenses" })] })] }) }), _jsxs(Card, { title: "Estimated Operating Profit", subtitle: "Net Revenue \u2212 Payroll \u2212 Operating Expenses", children: [_jsxs("div", { className: "grid gap-4 sm:grid-cols-2 lg:grid-cols-4", children: [_jsxs("div", { className: "rounded-xl border border-white/5 bg-[#0A1628]/60 p-4", children: [_jsx("p", { className: "text-xs uppercase tracking-widest text-slate-500", children: "Net Revenue" }), _jsx("p", { className: "mt-1 font-heading text-xl font-semibold text-white", children: money(netRevenue) })] }), _jsxs("div", { className: "rounded-xl border border-white/5 bg-[#0A1628]/60 p-4", children: [_jsx("p", { className: "text-xs uppercase tracking-widest text-slate-500", children: "Total Costs" }), _jsx("p", { className: "mt-1 font-heading text-xl font-semibold text-[#FFB547]", children: money(totalCosts) })] }), _jsxs("div", { className: "rounded-xl border border-white/5 bg-[#0A1628]/60 p-4", children: [_jsx("p", { className: "text-xs uppercase tracking-widest text-slate-500", children: "Profit Margin" }), _jsx("p", { className: "mt-1 font-heading text-xl font-semibold", style: { color: profitMargin >= 0 ? C.green : C.coral }, children: pct(profitMargin) })] }), _jsxs("div", { className: `rounded-xl border p-4 ${operatingProfit >= 0 ? "border-[#00E096]/15 bg-[#00E096]/[0.05]" : "border-[#FF6B6B]/15 bg-[#FF6B6B]/[0.05]"}`, children: [_jsx("p", { className: "text-xs uppercase tracking-widest text-slate-500", children: "Operating Profit" }), _jsxs("p", { className: `mt-1 font-heading text-xl font-semibold ${operatingProfit >= 0 ? "text-[#00E096]" : "text-[#FF6B6B]"}`, children: [operatingProfit >= 0 ? "+" : "", money(operatingProfit)] })] })] }), _jsxs("div", { className: "mt-4 rounded-xl border border-white/5 bg-[#0A1628]/60 p-4", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsxs("div", { children: [_jsx("p", { className: "text-sm text-slate-300", children: "Break-Even Target" }), _jsxs("p", { className: "text-xs text-slate-500", children: ["Revenue needed at ", targetMargin, "% margin target"] })] }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsx("label", { className: "text-xs text-slate-400", children: "Target Margin:" }), _jsx("input", { type: "number", min: "0", max: "100", value: targetMargin, onChange: (e) => setTargetMargin(Number(e.target.value)), className: "w-20 rounded-lg border border-white/10 bg-[#040D1A] px-3 py-1.5 text-right text-sm text-slate-200 outline-none focus:border-[#00D4FF]" }), _jsx("span", { className: "text-sm text-slate-400", children: "%" })] })] }), _jsxs("div", { className: "mt-3 grid gap-3 sm:grid-cols-3", children: [_jsxs("div", { children: [_jsx("p", { className: "text-xs text-slate-500", children: "Target Revenue" }), _jsx("p", { className: "font-heading text-lg text-[#00D4FF]", children: targetMargin > 0 ? money(targetRevenue) : "—" })] }), _jsxs("div", { children: [_jsx("p", { className: "text-xs text-slate-500", children: "Current Revenue" }), _jsx("p", { className: "font-heading text-lg text-white", children: money(netRevenue) })] }), _jsxs("div", { children: [_jsx("p", { className: "text-xs text-slate-500", children: "Remaining to Target" }), _jsx("p", { className: `font-heading text-lg ${revenueRemaining <= 0 ? "text-[#00E096]" : "text-[#FFB547]"}`, children: targetMargin > 0 ? money(Math.max(0, revenueRemaining)) : "—" })] })] })] })] }), _jsxs("div", { className: "grid gap-4 lg:grid-cols-2", children: [_jsxs(Card, { title: "Expense Tracker", subtitle: `${filteredExpenses.length} of ${expenses.length} expenses · ${money(operatingExpenses)} total`, right: _jsxs("button", { onClick: () => setShowForm(!showForm), className: "flex items-center gap-1.5 rounded-lg bg-[#6C63FF] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#5b52e8]", children: [_jsx(Plus, { className: "h-3.5 w-3.5" }), " Add Expense"] }), children: [showForm && (_jsxs("div", { className: "mb-4 grid gap-3 rounded-xl border border-white/10 bg-[#0A1628] p-4 sm:grid-cols-2 lg:grid-cols-3", children: [_jsx("input", { value: form.expense_name, onChange: (e) => setForm({ ...form, expense_name: e.target.value }), placeholder: "Expense name", className: "rounded-lg border border-white/10 bg-[#040D1A] px-3 py-2 text-sm text-slate-200 outline-none focus:border-[#00D4FF]" }), _jsx("input", { value: form.vendor, onChange: (e) => setForm({ ...form, vendor: e.target.value }), placeholder: "Vendor", className: "rounded-lg border border-white/10 bg-[#040D1A] px-3 py-2 text-sm text-slate-200 outline-none focus:border-[#00D4FF]" }), _jsxs("select", { value: customCategory, onChange: (e) => setForm({ ...form, category: e.target.value === "__custom__" ? "__custom__" : e.target.value, customCat: "" }), className: "rounded-lg border border-white/10 bg-[#040D1A] px-3 py-2 text-sm text-slate-200 outline-none focus:border-[#00D4FF]", "aria-label": "Expense category", children: [EXPENSE_CATEGORIES.map((c) => _jsx("option", { value: c.key, children: c.label }, c.key)), _jsx("option", { value: "__custom__", children: "Custom category\u2026" })] }), customSelected && (_jsx("input", { value: form.customCat, onChange: (e) => setForm({ ...form, customCat: e.target.value }), placeholder: form.category === "__custom__" ? "e.g. Snow Removal" : "Custom category name", className: "rounded-lg border border-white/10 bg-[#040D1A] px-3 py-2 text-sm text-slate-200 outline-none focus:border-[#00D4FF]", "aria-label": "Custom category name" })), _jsx("select", { value: form.frequency, onChange: (e) => setForm({ ...form, frequency: e.target.value }), className: "rounded-lg border border-white/10 bg-[#040D1A] px-3 py-2 text-sm text-slate-200 outline-none focus:border-[#00D4FF]", children: EXPENSE_FREQUENCIES.map((f) => _jsx("option", { value: f.key, children: f.label }, f.key)) }), _jsx("input", { type: "number", value: form.amount, onChange: (e) => setForm({ ...form, amount: e.target.value }), placeholder: "Amount $", className: "rounded-lg border border-white/10 bg-[#040D1A] px-3 py-2 text-sm text-slate-200 outline-none focus:border-[#00D4FF]" }), _jsx("input", { type: "date", value: form.expense_date, onChange: (e) => setForm({ ...form, expense_date: e.target.value }), className: "rounded-lg border border-white/10 bg-[#040D1A] px-3 py-2 text-sm text-slate-200 outline-none focus:border-[#00D4FF]" }), _jsxs("label", { className: "flex items-center gap-2 text-sm text-slate-300", children: [_jsx("input", { type: "checkbox", checked: form.taxable !== false, onChange: (e) => setForm({ ...form, taxable: e.target.checked }), className: "h-4 w-4 rounded border-white/20" }), "Taxable"] }), _jsx("button", { onClick: handleAdd, className: "rounded-lg bg-[#00E096] px-4 py-2 text-sm font-medium text-[#040D1A] hover:bg-[#00c885]", children: "Save Expense" })] })), _jsxs("div", { className: "mb-4 flex flex-wrap items-center gap-2", children: [_jsx("input", { type: "text", value: expSearch, onChange: (e) => setExpSearch(e.target.value), placeholder: "Search expenses\u2026", className: "flex-1 rounded-lg border border-white/10 bg-[#040D1A] px-3 py-2 text-sm text-slate-200 outline-none focus:border-[#00D4FF]" }), _jsxs("select", { value: expFilterCat, onChange: (e) => setExpFilterCat(e.target.value), className: "rounded-lg border border-white/10 bg-[#040D1A] px-3 py-2 text-xs text-slate-200", children: [_jsx("option", { value: "all", children: "All Categories" }), EXPENSE_CATEGORIES.map((c) => _jsx("option", { value: c.key, children: c.label }, c.key)), customCats.map((c) => _jsx("option", { value: c, children: expenseLabel(c) }, c))] }), _jsxs("select", { value: expFilterTax, onChange: (e) => setExpFilterTax(e.target.value), className: "rounded-lg border border-white/10 bg-[#040D1A] px-3 py-2 text-xs text-slate-200", children: [_jsx("option", { value: "all", children: "All Tax" }), _jsx("option", { value: "taxable", children: "Taxable" }), _jsx("option", { value: "exempt", children: "Exempt" })] })] }), _jsxs("div", { className: "mb-4 grid grid-cols-2 gap-3", children: [_jsxs("div", { className: "rounded-lg border border-[#00E096]/10 bg-[#00E096]/[0.03] p-3", children: [_jsx("p", { className: "text-[10px] uppercase tracking-widest text-slate-500", children: "Taxable Expenses" }), _jsx("p", { className: "mt-1 font-heading text-lg text-[#00E096]", children: money(taxableAmount) }), _jsxs("p", { className: "text-xs text-slate-500", children: [taxableExpenses.length, " items"] })] }), _jsxs("div", { className: "rounded-lg border border-[#FFB547]/10 bg-[#FFB547]/[0.03] p-3", children: [_jsx("p", { className: "text-[10px] uppercase tracking-widest text-slate-500", children: "Tax-Exempt" }), _jsx("p", { className: "mt-1 font-heading text-lg text-[#FFB547]", children: money(exemptAmount) }), _jsxs("p", { className: "text-xs text-slate-500", children: [exemptExpenses.length, " items"] })] })] }), _jsxs("div", { className: "max-h-80 space-y-2 overflow-auto", children: [filteredExpenses.map((e) => (_jsxs("div", { className: "flex items-center justify-between rounded-xl border border-white/5 bg-[#0A1628]/60 px-4 py-3", children: [_jsx("div", { className: "flex items-center gap-3", children: _jsxs("div", { children: [_jsx("p", { className: "text-sm text-white", children: e.expense_name }), _jsxs("p", { className: "text-xs text-slate-500", children: [e.vendor || "—", " \u00B7 ", expenseLabel(e.category), " \u00B7 ", frequencyLabel(e.frequency)] })] }) }), _jsxs("div", { className: "flex items-center gap-3", children: [_jsx("button", { onClick: () => handleToggleTaxable(e.id, e.taxable), className: `rounded-full px-2 py-0.5 text-[10px] ${e.taxable !== false ? "bg-[#00E096]/10 text-[#00E096]" : "bg-[#FFB547]/10 text-[#FFB547]"}`, title: "Toggle taxable status", children: e.taxable !== false ? "Taxable" : "Exempt" }), _jsx("span", { className: "text-sm tabular-nums text-slate-300", children: money(e.amount || 0) }), _jsx("select", { value: e.payment_status || "unpaid", onChange: (ev) => handleStatusChange(e.id, ev.target.value), className: `rounded-lg border border-white/10 bg-[#040D1A] px-2 py-1 text-xs ${statusColor(e.payment_status)}`, children: EXPENSE_STATUSES.map((s) => _jsx("option", { value: s.key, children: s.label }, s.key)) }), _jsx("button", { onClick: () => handleDelete(e.id), className: "text-slate-500 hover:text-[#FF6B6B]", children: _jsx(Trash2, { className: "h-4 w-4" }) })] })] }, e.id))), !filteredExpenses.length && _jsx("p", { className: "text-sm text-slate-500", children: "No expenses match your filters." })] })] }), _jsxs(Card, { title: "Payroll Records", subtitle: `${payroll.length} records · ${money(totalPayroll)} total`, right: _jsxs("button", { onClick: () => setShowPayrollForm(!showPayrollForm), className: "flex items-center gap-1.5 rounded-lg bg-[#6C63FF] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#5b52e8]", children: [_jsx(Plus, { className: "h-3.5 w-3.5" }), " Add Payroll"] }), children: [showPayrollForm && (_jsxs("div", { className: "mb-4 grid gap-3 rounded-xl border border-white/10 bg-[#0A1628] p-4 sm:grid-cols-2 lg:grid-cols-3", children: [_jsx("input", { value: payrollForm.employee_name, onChange: (e) => setPayrollForm({ ...payrollForm, employee_name: e.target.value }), placeholder: "Employee name", className: "rounded-lg border border-white/10 bg-[#040D1A] px-3 py-2 text-sm text-slate-200 outline-none focus:border-[#00D4FF]" }), _jsx("input", { value: payrollForm.department, onChange: (e) => setPayrollForm({ ...payrollForm, department: e.target.value }), placeholder: "Department", className: "rounded-lg border border-white/10 bg-[#040D1A] px-3 py-2 text-sm text-slate-200 outline-none focus:border-[#00D4FF]" }), _jsxs("select", { value: payrollForm.pay_type, onChange: (e) => setPayrollForm({ ...payrollForm, pay_type: e.target.value }), className: "rounded-lg border border-white/10 bg-[#040D1A] px-3 py-2 text-sm text-slate-200 outline-none focus:border-[#00D4FF]", children: [_jsx("option", { value: "hourly", children: "Hourly" }), _jsx("option", { value: "salary", children: "Salary" })] }), _jsx("input", { type: "number", value: payrollForm.base_rate, onChange: (e) => setPayrollForm({ ...payrollForm, base_rate: e.target.value }), placeholder: "Base rate $", className: "rounded-lg border border-white/10 bg-[#040D1A] px-3 py-2 text-sm text-slate-200 outline-none focus:border-[#00D4FF]" }), _jsx("input", { type: "number", value: payrollForm.hours, onChange: (e) => setPayrollForm({ ...payrollForm, hours: e.target.value }), placeholder: "Hours", className: "rounded-lg border border-white/10 bg-[#040D1A] px-3 py-2 text-sm text-slate-200 outline-none focus:border-[#00D4FF]" }), _jsx("input", { type: "number", value: payrollForm.overtime_hours, onChange: (e) => setPayrollForm({ ...payrollForm, overtime_hours: e.target.value }), placeholder: "OT hours", className: "rounded-lg border border-white/10 bg-[#040D1A] px-3 py-2 text-sm text-slate-200 outline-none focus:border-[#00D4FF]" }), _jsx("input", { type: "number", value: payrollForm.bonus, onChange: (e) => setPayrollForm({ ...payrollForm, bonus: e.target.value }), placeholder: "Bonus $", className: "rounded-lg border border-white/10 bg-[#040D1A] px-3 py-2 text-sm text-slate-200 outline-none focus:border-[#00D4FF]" }), _jsx("input", { type: "number", value: payrollForm.deductions, onChange: (e) => setPayrollForm({ ...payrollForm, deductions: e.target.value }), placeholder: "Deductions $", className: "rounded-lg border border-white/10 bg-[#040D1A] px-3 py-2 text-sm text-slate-200 outline-none focus:border-[#00D4FF]" }), _jsx("button", { onClick: handleAddPayroll, className: "rounded-lg bg-[#00E096] px-4 py-2 text-sm font-medium text-[#040D1A] hover:bg-[#00c885]", children: "Save Payroll" })] })), _jsxs("div", { className: "max-h-80 space-y-2 overflow-auto", children: [payroll.map((p) => (_jsxs("div", { className: "flex items-center justify-between rounded-xl border border-white/5 bg-[#0A1628]/60 px-4 py-3", children: [_jsxs("div", { children: [_jsx("p", { className: "text-sm text-white", children: p.employee_name }), _jsxs("p", { className: "text-xs text-slate-500", children: [p.department, " \u00B7 ", p.pay_type, " \u00B7 ", p.hours || 0, "h"] })] }), _jsxs("div", { className: "flex items-center gap-3", children: [_jsx("span", { className: "text-sm tabular-nums text-slate-300", children: money(p.total_pay || 0) }), _jsx("button", { onClick: () => handleDeletePayroll(p.id), className: "text-slate-500 hover:text-[#FF6B6B]", children: _jsx(Trash2, { className: "h-4 w-4" }) })] })] }, p.id))), !payroll.length && _jsx("p", { className: "text-sm text-slate-500", children: "No payroll records yet. Add your first above." })] })] })] })] }));
}
