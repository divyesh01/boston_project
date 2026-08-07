import { db } from '@/api/base44Client';

import React, { useState } from "react";
import { Plus, Trash2, DollarSign, Users, CheckCircle2, X, Save } from "lucide-react";
import Card from "@/components/ui-exec/Card";
import KpiCard from "@/components/ui-exec/KpiCard";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useGlobalFilters } from "@/lib/useGlobalFilters";
import { money, num, C } from "@/lib/hotel";

function usePayroll(propertyId) {
  return useQuery({
    queryKey: ["payroll", propertyId],
    queryFn: () => {
      const filter = propertyId && propertyId !== "all" ? { property_id: propertyId } : {};
      return db.entities.PayrollRun.filter(filter, "-pay_period_start", 500);
    },
  });
}

export default function Payroll() {
  const { property, properties } = useGlobalFilters();
  const qc = useQueryClient();
  const { data: payroll = [] } = usePayroll(property);
  const [showForm, setShowForm] = useState(false);
  const [schedule, setSchedule] = useState("last_day");

  const [form, setForm] = useState({
    employee_name: "", department: "", pay_type: "hourly",
    base_rate: "", hours: "40", overtime_hours: "0", overtime_rate: "",
    bonus: "0", deductions: "0",
    pay_period_start: new Date().toISOString().slice(0, 10),
    pay_period_end: new Date().toISOString().slice(0, 10),
  });

  const handleAdd = async () => {
    if (!form.employee_name || !form.base_rate) return;
    const baseRate = Number(form.base_rate) || 0;
    const hours = Number(form.hours) || 0;
    const otHours = Number(form.overtime_hours) || 0;
    const otRate = Number(form.overtime_rate) || baseRate * 1.5;
    const bonus = Number(form.bonus) || 0;
    const deductions = Number(form.deductions) || 0;
    const regularPay = form.pay_type === "salary" ? baseRate : baseRate * hours;
    const overtimePay = otHours * otRate;
    const totalPay = regularPay + overtimePay + bonus - deductions;

    const prop = properties.find((p) => p.id === property);
    await db.entities.PayrollRun.create({
      ...form,
      base_rate: baseRate,
      hours,
      overtime_hours: otHours,
      overtime_rate: otRate,
      regular_pay: regularPay,
      overtime_pay: overtimePay,
      bonus,
      deductions,
      total_pay: totalPay,
      payroll_status: "draft",
      property_id: property !== "all" ? property : "",
      property_name: prop?.name || "",
    });
    setForm({ employee_name: "", department: "", pay_type: "hourly", base_rate: "", hours: "40", overtime_hours: "0", overtime_rate: "", bonus: "0", deductions: "0", pay_period_start: new Date().toISOString().slice(0, 10), pay_period_end: new Date().toISOString().slice(0, 10) });
    qc.invalidateQueries({ queryKey: ["payroll"] });
    setShowForm(false);
  };

  const handleStatusChange = async (id, status) => {
    await db.entities.PayrollRun.update(id, { payroll_status: status });
    qc.invalidateQueries({ queryKey: ["payroll"] });
  };

  const handleDelete = async (id) => {
    await db.entities.PayrollRun.delete(id);
    qc.invalidateQueries({ queryKey: ["payroll"] });
  };

  const totalPay = payroll.reduce((a, p) => a + (p.total_pay || 0), 0);
  const totalReg = payroll.reduce((a, p) => a + (p.regular_pay || 0), 0);
  const totalOT = payroll.reduce((a, p) => a + (p.overtime_pay || 0), 0);
  const totalBonus = payroll.reduce((a, p) => a + (p.bonus || 0), 0);
  const totalDeductions = payroll.reduce((a, p) => a + (p.deductions || 0), 0);
  const draftCount = payroll.filter((p) => p.payroll_status === "draft").length;
  const paidCount = payroll.filter((p) => p.payroll_status === "paid").length;

  const statusColor = (s) => ({
    draft: "text-slate-400", pending_review: "text-[#FFB547]", approved: "text-[#00D4FF]", paid: "text-[#00E096]",
  }[s] || "text-slate-400");

  return (
    <div className="space-y-6">
      <header>
        <p className="text-[11px] uppercase tracking-[0.3em] text-[#00D4FF]">Operations</p>
        <h1 className="mt-2 font-heading text-3xl font-semibold text-white">Payroll Management</h1>
        <p className="mt-1 text-sm text-slate-400">Schedule payroll, calculate pay, and approve payments.</p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard label="Total Payroll" value={money(totalPay)} sub={`${payroll.length} runs`} accent={C.purple} icon={DollarSign} />
        <KpiCard label="Regular Pay" value={money(totalReg)} sub={`OT: ${money(totalOT)}`} accent={C.cyan} icon={Users} />
        <KpiCard label="Draft / Pending" value={num(draftCount)} sub={`${paidCount} paid`} accent={C.amber} icon={CheckCircle2} />
        <KpiCard label="Deductions" value={money(totalDeductions)} sub={`Bonus: ${money(totalBonus)}`} accent={C.coral} icon={DollarSign} />
      </div>

      <Card title="Payroll Schedule" subtitle="Configure when payroll runs for this property">
        <div className="flex flex-wrap items-center gap-3">
          <label className="text-sm text-slate-400">Pay Date:</label>
          <select
            value={schedule}
            onChange={(e) => setSchedule(e.target.value)}
            className="rounded-lg border border-white/10 bg-[#0A1628] px-3 py-2 text-sm text-slate-200 outline-none focus:border-[#00D4FF]"
          >
            <option value="first_day">1st of Every Month</option>
            <option value="last_day">Last Day of Every Month</option>
            <option value="custom">Custom Date</option>
          </select>
          <span className="text-xs text-slate-500">
            Payroll runs are created as Draft — owner must review and approve before marking as Paid.
          </span>
        </div>
      </Card>

      <Card
        title="Payroll Runs"
        subtitle={`${payroll.length} entries · ${money(totalPay)} total`}
        right={
          <button
            onClick={() => setShowForm(true)}
            className="flex items-center gap-1.5 rounded-lg bg-[#6C63FF] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#5b52e8]"
          >
            <Plus className="h-3.5 w-3.5" /> Add Employee
          </button>
        }
      >
        {showForm && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
            <div className="w-full max-w-lg rounded-2xl border border-white/10 bg-[#151921] p-6 shadow-2xl">
              <div className="mb-5 flex items-center justify-between">
                <h2 className="font-heading text-lg font-semibold text-white">Add Employee</h2>
                <button onClick={() => setShowForm(false)} className="text-slate-400 hover:text-white">
                  <X className="h-5 w-5" />
                </button>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-400">Name *</label>
                  <input value={form.employee_name} onChange={(e) => setForm({ ...form, employee_name: e.target.value })} placeholder="John Doe" className="w-full rounded-lg border border-white/10 bg-[#0b0e14] px-3 py-2.5 text-sm text-white outline-none focus:border-[#6C63FF]" />
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-400">Employee ID</label>
                  <input value={form.employee_name ? form.employee_name.slice(0, 3).toUpperCase() + "001" : ""} readOnly placeholder="Auto" className="w-full rounded-lg border border-white/10 bg-[#0b0e14] px-3 py-2.5 text-sm text-slate-500 outline-none" />
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-400">Job Title</label>
                  <input value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })} placeholder="Front Desk Agent" className="w-full rounded-lg border border-white/10 bg-[#0b0e14] px-3 py-2.5 text-sm text-white outline-none focus:border-[#6C63FF]" />
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-400">Department</label>
                  <input value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })} placeholder="Front Office" className="w-full rounded-lg border border-white/10 bg-[#0b0e14] px-3 py-2.5 text-sm text-white outline-none focus:border-[#6C63FF]" />
                </div>
                <div className="sm:col-span-2">
                  <label className="mb-1.5 block text-xs font-medium text-slate-400">Pay Type</label>
                  <select value={form.pay_type} onChange={(e) => setForm({ ...form, pay_type: e.target.value })} className="w-full rounded-lg border border-white/10 bg-[#0b0e14] px-3 py-2.5 text-sm text-white outline-none focus:border-[#6C63FF]">
                    <option value="hourly">Hourly</option>
                    <option value="salary">Salary</option>
                  </select>
                </div>
                <div className="sm:col-span-2">
                  <label className="mb-1.5 block text-xs font-medium text-slate-400">
                    {form.pay_type === "salary" ? "Salary Amount ($)" : "Hourly Rate ($)"}
                  </label>
                  <input type="number" value={form.base_rate} onChange={(e) => setForm({ ...form, base_rate: e.target.value })} placeholder="0" className="w-full rounded-lg border border-white/10 bg-[#0b0e14] px-3 py-2.5 text-sm text-white outline-none focus:border-[#6C63FF]" />
                </div>
                {form.pay_type === "hourly" && (
                  <>
                    <div>
                      <label className="mb-1.5 block text-xs font-medium text-slate-400">Regular Hours</label>
                      <input type="number" value={form.hours} onChange={(e) => setForm({ ...form, hours: e.target.value })} placeholder="40" className="w-full rounded-lg border border-white/10 bg-[#0b0e14] px-3 py-2.5 text-sm text-white outline-none focus:border-[#6C63FF]" />
                    </div>
                    <div>
                      <label className="mb-1.5 block text-xs font-medium text-slate-400">Overtime Hours</label>
                      <input type="number" value={form.overtime_hours} onChange={(e) => setForm({ ...form, overtime_hours: e.target.value })} placeholder="0" className="w-full rounded-lg border border-white/10 bg-[#0b0e14] px-3 py-2.5 text-sm text-white outline-none focus:border-[#6C63FF]" />
                    </div>
                    <div>
                      <label className="mb-1.5 block text-xs font-medium text-slate-400">Overtime Rate (blank = 1.5x)</label>
                      <input type="number" value={form.overtime_rate} onChange={(e) => setForm({ ...form, overtime_rate: e.target.value })} placeholder="Auto" className="w-full rounded-lg border border-white/10 bg-[#0b0e14] px-3 py-2.5 text-sm text-white outline-none focus:border-[#6C63FF]" />
                    </div>
                  </>
                )}
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-400">Bonus ($)</label>
                  <input type="number" value={form.bonus} onChange={(e) => setForm({ ...form, bonus: e.target.value })} placeholder="0" className="w-full rounded-lg border border-white/10 bg-[#0b0e14] px-3 py-2.5 text-sm text-white outline-none focus:border-[#6C63FF]" />
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-400">Deductions ($)</label>
                  <input type="number" value={form.deductions} onChange={(e) => setForm({ ...form, deductions: e.target.value })} placeholder="0" className="w-full rounded-lg border border-white/10 bg-[#0b0e14] px-3 py-2.5 text-sm text-white outline-none focus:border-[#6C63FF]" />
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-400">Pay Period Start</label>
                  <input type="date" value={form.pay_period_start} onChange={(e) => setForm({ ...form, pay_period_start: e.target.value })} className="w-full rounded-lg border border-white/10 bg-[#0b0e14] px-3 py-2.5 text-sm text-white outline-none focus:border-[#6C63FF]" />
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-400">Pay Period End</label>
                  <input type="date" value={form.pay_period_end} onChange={(e) => setForm({ ...form, pay_period_end: e.target.value })} className="w-full rounded-lg border border-white/10 bg-[#0b0e14] px-3 py-2.5 text-sm text-white outline-none focus:border-[#6C63FF]" />
                </div>
              </div>
              <div className="mt-5 flex justify-end gap-3">
                <button onClick={() => setShowForm(false)} className="rounded-lg border border-white/10 px-4 py-2 text-sm text-slate-300 hover:bg-white/5">
                  Cancel
                </button>
                <button onClick={handleAdd} className="flex items-center gap-1.5 rounded-lg bg-[#6C63FF] px-4 py-2 text-sm font-medium text-white hover:bg-[#5b52e8]">
                  <Save className="h-4 w-4" /> Save Employee
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="space-y-2">
          {payroll.map((p) => (
            <div key={p.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/5 bg-[#0A1628]/60 px-4 py-3">
              <div className="flex items-center gap-3">
                <div>
                  <p className="text-sm text-white">{p.employee_name}</p>
                  <p className="text-xs text-slate-500">
                    {p.department || "—"} · {p.pay_type} · {p.pay_period_start || "—"} to {p.pay_period_end || "—"}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-4">
                <div className="text-right">
                  <p className="text-xs text-slate-500">Reg {money(p.regular_pay || 0)} · OT {money(p.overtime_pay || 0)}</p>
                  <p className="text-sm font-heading text-white">{money(p.total_pay || 0)}</p>
                </div>
                <select
                  value={p.payroll_status || "draft"}
                  onChange={(e) => handleStatusChange(p.id, e.target.value)}
                  className={`rounded-lg border border-white/10 bg-[#040D1A] px-2 py-1 text-xs ${statusColor(p.payroll_status)}`}
                >
                  <option value="draft">Draft</option>
                  <option value="pending_review">Pending Review</option>
                  <option value="approved">Approved</option>
                  <option value="paid">Paid</option>
                </select>
                <button onClick={() => handleDelete(p.id)} className="text-slate-500 hover:text-[#FF6B6B]">
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))}
          {!payroll.length && (
            <div className="py-4 text-center">
              <p className="text-sm text-slate-500">No payroll runs yet. Add a pay run above to get started.</p>
              <p className="mt-1 text-xs text-slate-600">Payroll Configuration Required — employees need valid pay configuration before generating runs.</p>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}