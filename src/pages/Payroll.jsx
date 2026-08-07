import { db } from '@/api/base44Client';

import React, { useState } from "react";
import { Plus, Trash2, DollarSign, Users, CheckCircle2, X, Save, Zap, CalendarClock, Power, UserPlus } from "lucide-react";
import Card from "@/components/ui-exec/Card";
import KpiCard from "@/components/ui-exec/KpiCard";
import StatusBadge from "@/components/ui-exec/StatusBadge";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useGlobalFilters } from "@/lib/useGlobalFilters";
import { money, num, C } from "@/lib/hotel";
import { sfx } from "@/lib/sound";

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const pad = (n) => String(n).padStart(2, "0");
const iso = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
const lastDayOf = (y, m) => new Date(y, m + 1, 0).getDate();
const monthLabel = (y, m) => `${MONTHS[m]} ${y}`;

// Next auto-run: the final calendar day of the current month (or next month if today is the last day)
function nextPayrollDate() {
  const now = new Date();
  const last = lastDayOf(now.getFullYear(), now.getMonth());
  if (now.getDate() < last) return iso(now.getFullYear(), now.getMonth(), last);
  const nm = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return iso(nm.getFullYear(), nm.getMonth(), lastDayOf(nm.getFullYear(), nm.getMonth()));
}

const EMPTY_RUN = {
  employee_name: "", department: "", pay_type: "hourly",
  base_rate: "", hours: "40", overtime_hours: "0", overtime_rate: "",
  bonus: "0", deductions: "0",
  pay_period_start: new Date().toISOString().slice(0, 10),
  pay_period_end: new Date().toISOString().slice(0, 10),
};

const EMPTY_STAFF = {
  employee_name: "", department: "", pay_type: "hourly",
  base_rate: "", hours: "40", overtime_hours: "0", overtime_rate: "",
  bonus: "0", deductions: "0", active: true,
};

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

function useStaff() {
  return useQuery({
    queryKey: ["staff"],
    queryFn: () => db.entities.Staff.list("employee_name", 100000),
  });
}

export default function Payroll() {
  const { property, properties } = useGlobalFilters();
  const qc = useQueryClient();
  const { data: payroll = [] } = usePayroll(property);
  const { data: staff = [] } = useStaff();
  const [showForm, setShowForm] = useState(false);
  const [showStaffForm, setShowStaffForm] = useState(false);
  const [form, setForm] = useState(EMPTY_RUN);
  const [staffForm, setStaffForm] = useState(EMPTY_STAFF);
  const [running, setRunning] = useState(false);
  const [engineMsg, setEngineMsg] = useState(null);

  const activeStaff = staff.filter((s) => s.active !== false);

  const propFor = () => {
    const p = properties.find((x) => x.id === property);
    return p || null;
  };

  // ─── Automated engine ───
  const handleRunEngine = async () => {
    if (running) return;
    setRunning(true);
    setEngineMsg(null);
    try {
      const res = await db.functions.invoke("autoPayroll", { force: true });
      const data = res?.data || res || {};
      setEngineMsg(data);
      if (data.status === "ok") sfx.success();
      else sfx.pop();
      qc.invalidateQueries({ queryKey: ["payroll"] });
    } catch (e) {
      console.error("[autoPayroll]", e);
      setEngineMsg({ status: "failed", message: e.message || "Engine failed to run." });
      sfx.error();
    }
    setRunning(false);
  };

  // ─── Manual payroll run (single entry) ───
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

    const p = propFor();
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
      property_name: p?.name || "",
    });
    setForm(EMPTY_RUN);
    sfx.success();
    qc.invalidateQueries({ queryKey: ["payroll"] });
    setShowForm(false);
  };

  // ─── Staff directory (input for the automated engine) ───
  const handleAddStaff = async () => {
    if (!staffForm.employee_name || !staffForm.base_rate) return;
    const baseRate = Number(staffForm.base_rate) || 0;
    const p = propFor();
    await db.entities.Staff.create({
      ...staffForm,
      base_rate: baseRate,
      hours: Number(staffForm.hours) || 0,
      overtime_hours: Number(staffForm.overtime_hours) || 0,
      overtime_rate: Number(staffForm.overtime_rate) || baseRate * 1.5,
      bonus: Number(staffForm.bonus) || 0,
      deductions: Number(staffForm.deductions) || 0,
      employee_id: (staffForm.employee_name.slice(0, 3).toUpperCase() + String(staff.length + 1).padStart(3, "0")),
      property_id: property !== "all" ? property : "",
      property_name: p?.name || "",
    });
    setStaffForm(EMPTY_STAFF);
    sfx.success();
    qc.invalidateQueries({ queryKey: ["staff"] });
    setShowStaffForm(false);
  };

  const handleToggleStaff = async (id, active) => {
    await db.entities.Staff.update(id, { active: active !== false ? false : true });
    sfx.pop();
    qc.invalidateQueries({ queryKey: ["staff"] });
  };

  const handleDeleteStaff = async (id) => {
    await db.entities.Staff.delete(id);
    sfx.pop();
    qc.invalidateQueries({ queryKey: ["staff"] });
  };

  // ─── Payroll run status ops ───
  const handleStatusChange = async (id, status) => {
    await db.entities.PayrollRun.update(id, { payroll_status: status });
    sfx.pop();
    qc.invalidateQueries({ queryKey: ["payroll"] });
  };

  const handleDelete = async (id) => {
    await db.entities.PayrollRun.delete(id);
    sfx.pop();
    qc.invalidateQueries({ queryKey: ["payroll"] });
  };

  // ─── KPIs ───
  const totalPay = payroll.reduce((a, p) => a + (p.total_pay || 0), 0);
  const totalReg = payroll.reduce((a, p) => a + (p.regular_pay || 0), 0);
  const totalOT = payroll.reduce((a, p) => a + (p.overtime_pay || 0), 0);
  const totalBonus = payroll.reduce((a, p) => a + (p.bonus || 0), 0);
  const totalDeductions = payroll.reduce((a, p) => a + (p.deductions || 0), 0);
  const draftCount = payroll.filter((p) => p.payroll_status === "draft").length;
  const approvedCount = payroll.filter((p) => p.payroll_status === "approved").length;
  const paidCount = payroll.filter((p) => p.payroll_status === "paid").length;
  const lastRun = payroll.length
    ? payroll.map((p) => p.pay_period_end || "").filter(Boolean).sort().at(-1)
    : null;

  const statusColor = (s) => ({
    draft: "text-slate-400", pending_review: "text-[#FFB547]", approved: "text-[#00D4FF]", paid: "text-[#00E096]",
  }[s] || "text-slate-400");

  return (
    <div className="space-y-6">
      <header>
        <p className="text-[11px] uppercase tracking-[0.3em] text-[#00E096]">Operations · Automated</p>
        <h1 className="mt-2 font-heading text-3xl font-semibold text-white">Payroll Management</h1>
        <p className="mt-1 text-sm text-slate-400">
          Payroll is executed automatically on the final day of every month for all active staff.
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard label="Total Payroll" value={money(totalPay)} sub={`${payroll.length} runs`} accent={C.green} icon={DollarSign} />
        <KpiCard label="Regular Pay" value={money(totalReg)} sub={`OT: ${money(totalOT)}`} accent={C.cyan} icon={Users} />
        <KpiCard label="Approved" value={num(approvedCount)} sub={`${paidCount} paid · ${draftCount} draft`} accent={C.amber} icon={CheckCircle2} />
        <KpiCard label="Deductions" value={money(totalDeductions)} sub={`Bonus: ${money(totalBonus)}`} accent={C.coral} icon={DollarSign} />
      </div>

      {/* ─── Automated Payroll Engine ─── */}
      <div
        className="relative overflow-hidden rounded-2xl border border-[#00E096]/30 bg-[#0F1F35]/80 p-5"
        style={{ boxShadow: "0 0 34px rgba(0,224,150,0.18), inset 0 0 40px rgba(0,224,150,0.04)" }}
      >
        <div className="absolute inset-x-0 top-0 h-[2px]" style={{ background: "linear-gradient(90deg, transparent, #00E096, transparent)" }} />
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 items-center justify-center rounded-xl border border-[#00E096]/40 bg-[#00E096]/10 text-[#00E096]">
              <Zap className="h-5 w-5" />
            </span>
            <div>
              <h3 className="font-heading text-sm font-semibold tracking-wide text-white">Automated Payroll Engine</h3>
              <p className="mt-0.5 text-xs text-slate-400">
                Cron <code className="rounded bg-black/40 px-1.5 py-0.5 font-mono text-[10px] text-[#00E096]">0 9 28-31 * *</code> · runs on the last calendar day, so 28, 29, 30 and 31-day months are all handled.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <StatusBadge status={activeStaff.length ? "active" : "inactive"} size="sm" />
            <button
              onClick={handleRunEngine}
              disabled={running}
              className="fx-clickable flex items-center gap-2 rounded-lg bg-[#00E096] px-4 py-2 text-sm font-semibold text-[#04251A] transition-all hover:bg-[#4FE3C1] disabled:opacity-50"
            >
              <Zap className={`h-4 w-4 ${running ? "animate-pulse" : ""}`} />
              {running ? "Running…" : "Run Payroll Now"}
            </button>
          </div>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-white/5 bg-[#0A1628]/60 p-3">
            <p className="text-[10px] uppercase tracking-widest text-slate-500">Next Auto Run</p>
            <p className="mt-1 flex items-center gap-1.5 text-sm font-medium text-white">
              <CalendarClock className="h-3.5 w-3.5 text-[#00E096]" />
              {nextPayrollDate()}
            </p>
            <p className="mt-0.5 text-[10px] text-slate-500">Final day of current month (auto-detected)</p>
          </div>
          <div className="rounded-xl border border-white/5 bg-[#0A1628]/60 p-3">
            <p className="text-[10px] uppercase tracking-widest text-slate-500">Active Staff</p>
            <p className="mt-1 text-sm font-medium text-white">
              {num(activeStaff.length)} <span className="text-slate-500">of {num(staff.length)}</span>
            </p>
            <p className="mt-0.5 text-[10px] text-slate-500">Processed each month-end → status Approved</p>
          </div>
          <div className="rounded-xl border border-white/5 bg-[#0A1628]/60 p-3">
            <p className="text-[10px] uppercase tracking-widest text-slate-500">Last Processed Period</p>
            <p className="mt-1 text-sm font-medium text-white">{lastRun || "—"}</p>
            <p className="mt-0.5 text-[10px] text-slate-500">Idempotent — no double runs per period</p>
          </div>
        </div>

        {engineMsg && (
          <div
            className={`mt-4 rounded-xl border p-3 text-sm ${
              engineMsg.status === "failed"
                ? "border-[#FF6B6B]/30 bg-[#FF6B6B]/[0.08] text-[#FF6B6B]"
                : engineMsg.status === "skipped"
                  ? "border-[#FFB547]/20 bg-[#FFB547]/[0.06] text-[#FFB547]"
                  : "border-[#00E096]/30 bg-[#00E096]/[0.06] text-[#00E096]"
            }`}
          >
            <p className="font-medium">
              {engineMsg.status === "failed" ? "⛔ Engine failed" : engineMsg.status === "skipped" ? "⏳ Payroll skipped" : "✅ Payroll executed"}
            </p>
            <p className="mt-1 text-xs opacity-90">{engineMsg.message || engineMsg.error}</p>
            {engineMsg.createdCount !== undefined && (
              <p className="mt-1 text-xs opacity-80">
                {engineMsg.createdCount} run(s) created · {engineMsg.skippedCount} skipped · Period {engineMsg.periodStart} → {engineMsg.periodEnd}
              </p>
            )}
          </div>
        )}
      </div>

      {/* ─── Staff directory ─── */}
      <Card
        title="Staff Directory"
        subtitle={`${num(staff.length)} staff · ${num(activeStaff.length)} active — the engine pays active staff every month-end`}
        right={
          <button
            onClick={() => setShowStaffForm(true)}
            className="fx-clickable flex items-center gap-1.5 rounded-lg bg-[#00E096] px-3 py-1.5 text-xs font-semibold text-[#04251A] hover:bg-[#4FE3C1]"
          >
            <UserPlus className="h-3.5 w-3.5" /> Add Staff
          </button>
        }
      >
        {showStaffForm && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
            <div className="w-full max-w-lg rounded-2xl border border-[#00E096]/30 bg-[#151921] p-6 shadow-2xl" style={{ boxShadow: "0 0 30px rgba(0,224,150,0.15)" }}>
              <div className="mb-5 flex items-center justify-between">
                <h2 className="font-heading text-lg font-semibold text-white">Add Staff Member</h2>
                <button onClick={() => setShowStaffForm(false)} className="text-slate-400 hover:text-white">
                  <X className="h-5 w-5" />
                </button>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-400">Full Name *</label>
                  <input value={staffForm.employee_name} onChange={(e) => setStaffForm({ ...staffForm, employee_name: e.target.value })} placeholder="Jane Smith" className="w-full rounded-lg border border-white/10 bg-[#0b0e14] px-3 py-2.5 text-sm text-white outline-none focus:border-[#00E096]" />
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-400">Department</label>
                  <input value={staffForm.department} onChange={(e) => setStaffForm({ ...staffForm, department: e.target.value })} placeholder="Front Office" className="w-full rounded-lg border border-white/10 bg-[#0b0e14] px-3 py-2.5 text-sm text-white outline-none focus:border-[#00E096]" />
                </div>
                <div className="sm:col-span-2">
                  <label className="mb-1.5 block text-xs font-medium text-slate-400">Pay Type</label>
                  <select value={staffForm.pay_type} onChange={(e) => setStaffForm({ ...staffForm, pay_type: e.target.value })} className="w-full rounded-lg border border-white/10 bg-[#0b0e14] px-3 py-2.5 text-sm text-white outline-none focus:border-[#00E096]">
                    <option value="hourly">Hourly</option>
                    <option value="salary">Salary</option>
                  </select>
                </div>
                <div className="sm:col-span-2">
                  <label className="mb-1.5 block text-xs font-medium text-slate-400">
                    {staffForm.pay_type === "salary" ? "Salary Amount ($/month)" : "Hourly Rate ($)"}
                  </label>
                  <input type="number" value={staffForm.base_rate} onChange={(e) => setStaffForm({ ...staffForm, base_rate: e.target.value })} placeholder="0" className="w-full rounded-lg border border-white/10 bg-[#0b0e14] px-3 py-2.5 text-sm text-white outline-none focus:border-[#00E096]" />
                </div>
                {staffForm.pay_type === "hourly" && (
                  <>
                    <div>
                      <label className="mb-1.5 block text-xs font-medium text-slate-400">Hours / Month</label>
                      <input type="number" value={staffForm.hours} onChange={(e) => setStaffForm({ ...staffForm, hours: e.target.value })} placeholder="160" className="w-full rounded-lg border border-white/10 bg-[#0b0e14] px-3 py-2.5 text-sm text-white outline-none focus:border-[#00E096]" />
                    </div>
                    <div>
                      <label className="mb-1.5 block text-xs font-medium text-slate-400">Overtime Hours</label>
                      <input type="number" value={staffForm.overtime_hours} onChange={(e) => setStaffForm({ ...staffForm, overtime_hours: e.target.value })} placeholder="0" className="w-full rounded-lg border border-white/10 bg-[#0b0e14] px-3 py-2.5 text-sm text-white outline-none focus:border-[#00E096]" />
                    </div>
                    <div>
                      <label className="mb-1.5 block text-xs font-medium text-slate-400">Overtime Rate (blank = 1.5x)</label>
                      <input type="number" value={staffForm.overtime_rate} onChange={(e) => setStaffForm({ ...staffForm, overtime_rate: e.target.value })} placeholder="Auto" className="w-full rounded-lg border border-white/10 bg-[#0b0e14] px-3 py-2.5 text-sm text-white outline-none focus:border-[#00E096]" />
                    </div>
                  </>
                )}
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-400">Bonus ($)</label>
                  <input type="number" value={staffForm.bonus} onChange={(e) => setStaffForm({ ...staffForm, bonus: e.target.value })} placeholder="0" className="w-full rounded-lg border border-white/10 bg-[#0b0e14] px-3 py-2.5 text-sm text-white outline-none focus:border-[#00E096]" />
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-400">Deductions ($)</label>
                  <input type="number" value={staffForm.deductions} onChange={(e) => setStaffForm({ ...staffForm, deductions: e.target.value })} placeholder="0" className="w-full rounded-lg border border-white/10 bg-[#0b0e14] px-3 py-2.5 text-sm text-white outline-none focus:border-[#00E096]" />
                </div>
              </div>
              <div className="mt-5 flex justify-end gap-3">
                <button onClick={() => setShowStaffForm(false)} className="rounded-lg border border-white/10 px-4 py-2 text-sm text-slate-300 hover:bg-white/5">
                  Cancel
                </button>
                <button onClick={handleAddStaff} className="flex items-center gap-1.5 rounded-lg bg-[#00E096] px-4 py-2 text-sm font-semibold text-[#04251A] hover:bg-[#4FE3C1]">
                  <Save className="h-4 w-4" /> Save Staff
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="space-y-2">
          {staff.map((s) => {
            const isActive = s.active !== false;
            return (
              <div key={s.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/5 bg-[#0A1628]/60 px-4 py-3">
                <div className="flex items-center gap-3">
                  <div>
                    <p className="text-sm text-white">{s.employee_name}</p>
                    <p className="text-xs text-slate-500">
                      {s.department || "—"} · {s.pay_type} · {s.pay_type === "salary" ? money(s.base_rate) + "/mo" : money(s.base_rate) + "/hr"}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <StatusBadge status={isActive ? "active" : "inactive"} size="sm" />
                  <button
                    onClick={() => handleToggleStaff(s.id, s.active)}
                    className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs transition-colors ${
                      isActive
                        ? "border-[#00E096]/40 bg-[#00E096]/10 text-[#00E096] hover:bg-[#00E096]/20"
                        : "border-white/10 bg-white/5 text-slate-500 hover:text-slate-300"
                    }`}
                    title={isActive ? "Deactivate (excluded from payroll)" : "Activate (included in payroll)"}
                  >
                    <Power className="h-3 w-3" /> {isActive ? "Active" : "Inactive"}
                  </button>
                  <button onClick={() => handleDeleteStaff(s.id)} className="text-slate-500 hover:text-[#FF6B6B]">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            );
          })}
          {!staff.length && (
            <div className="py-4 text-center">
              <p className="text-sm text-slate-500">No staff yet. Add staff members — the automated engine pays every active member on month-end.</p>
              <button
                onClick={() => setShowStaffForm(true)}
                className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-[#00E096]/40 bg-[#00E096]/10 px-3 py-1.5 text-xs font-medium text-[#00E096] hover:bg-[#00E096]/20"
              >
                <UserPlus className="h-3.5 w-3.5" /> Add First Staff Member
              </button>
            </div>
          )}
        </div>
      </Card>

      {/* ─── Payroll runs ─── */}
      <Card
        title="Payroll Runs"
        subtitle={`${payroll.length} entries · ${money(totalPay)} total`}
        right={
          <button
            onClick={() => setShowForm(true)}
            className="fx-clickable flex items-center gap-1.5 rounded-lg bg-[#6C63FF] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#5b52e8]"
          >
            <Plus className="h-3.5 w-3.5" /> Add Entry
          </button>
        }
      >
        {showForm && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
            <div className="w-full max-w-lg rounded-2xl border border-white/10 bg-[#151921] p-6 shadow-2xl">
              <div className="mb-5 flex items-center justify-between">
                <h2 className="font-heading text-lg font-semibold text-white">Add Payroll Entry</h2>
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
                  <Save className="h-4 w-4" /> Save Entry
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="space-y-2">
          {payroll.map((p) => (
            <div key={p.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/5 bg-[#0A1628]/60 px-4 py-3">
              <div className="flex items-center gap-3">
                <StatusBadge status={p.payroll_status || "draft"} size="sm" />
                <div>
                  <p className="text-sm text-white">{p.employee_name}</p>
                  <p className="text-xs text-slate-500">
                    {p.department || "—"} · {p.pay_type} · {p.pay_period_start || "—"} to {p.pay_period_end || "—"}
                    {p.auto_generated && <span className="ml-1 text-[#00E096]">· ⚙ auto</span>}
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
              <p className="text-sm text-slate-500">No payroll runs yet. Add staff above and hit “Run Payroll Now”, or add an entry manually.</p>
              <p className="mt-1 text-xs text-slate-600">Engine-generated runs are auto-approved on the last day of the month.</p>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}