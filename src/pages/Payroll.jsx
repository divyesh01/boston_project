import { db, runInTransaction } from '@/api/base44Client';

import React, { useState } from "react";
import { Plus, Trash2, DollarSign, CheckCircle2, X, Save, Zap, CalendarClock, Power, UserPlus, Target, TrendingUp, History, Loader2, ArrowLeft, Wallet } from "lucide-react";
import Card from "@/components/ui-exec/Card";
import Button from "@/components/ui-exec/Button";
import Input from "@/components/ui-exec/Input";
import Select from "@/components/ui-exec/Select";
import { EmptyState, ErrorState } from "@/components/ui/status";
import KpiCard from "@/components/ui-exec/KpiCard";
import StatusBadge from "@/components/ui-exec/StatusBadge";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useGlobalFilters } from "@/lib/useGlobalFilters";
import { num, pct, C, PROPERTY, money2 } from "@/lib/hotel";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { reserveEmployeeId } from "@/lib/employeeId";
import { sumCents, fromCents } from "@/lib/decimal";
import { guardDestructiveAction } from "@/lib/deleteGuard";
import { toast } from "sonner";
import { sfx } from "@/lib/sound";
import {
  calculatePay,
  buildPayrollRunRecord,
  generateMonthPeriods,
  nextPayrollDate,
  previousMonth,
  monthPeriod,
  normalizeMonth,
  sumCommittedPay,
  MONTHS,
  iso,
  lastDayOf,
  monthLabel,
} from "@/lib/payrollCalc";

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

// Occupancy rows for the projection range — used for an estimated ADR and the
// "payroll vs revenue" break-even picture. Reuses the same date+property scoping
// the rest of the app applies.
function useOccupancyRange(from, to, propertyId) {
  return useQuery({
    queryKey: ["payroll-occupancy", from, to, Array.isArray(propertyId) ? propertyId.join(",") : propertyId],
    queryFn: async () => {
      const filter = {};
      if (from && to) filter.date = { $gte: from, $lte: to };
      if (propertyId && propertyId !== "all") {
        if (Array.isArray(propertyId)) {
          if (propertyId.length > 0) filter.property_id = { $in: propertyId };
        } else {
          filter.property_id = propertyId;
        }
      }
      return db.entities.OccupancyDay.filter(filter, "date", 100000);
    },
  });
}

export default function Payroll() {
  const { property, properties } = useGlobalFilters();
  const qc = useQueryClient();
  const payrollQ = usePayroll(property);
  const staffQ = useStaff();
  const { data: payroll = [] } = payrollQ;
  const { data: staff = [] } = staffQ;
  // "No payroll runs yet" on a failed read looks like a month nobody has been paid
  // for, which is exactly the state that prompts someone to run payroll twice.
  const readFailed = payrollQ.isError ? payrollQ : staffQ.isError ? staffQ : null;
  const retryReads = () => { payrollQ.refetch(); staffQ.refetch(); };

  const [showForm, setShowForm] = useState(false);
  const [showStaffForm, setShowStaffForm] = useState(false);
  const [showHistoricalForm, setShowHistoricalForm] = useState(false);
  const [form, setForm] = useState(EMPTY_RUN);
  const [staffForm, setStaffForm] = useState(EMPTY_STAFF);
  // Default the range to last month. `getMonth() - 1` underflows to -1 every
  // January, which produced a December period stamped with the wrong year, so
  // the pair is normalised.
  const prevMonth = previousMonth();
  const [historicalForm, setHistoricalForm] = useState({
    fromMonth: prevMonth.month,
    fromYear: prevMonth.year,
    toMonth: prevMonth.month,
    toYear: prevMonth.year,
    status: "paid",
    useStaffDirectory: true,
    customEntries: [],
    monthlyOverrides: {}, // { "staffId-monthYear": { bonus, deductions, hours, overtime_hours } }
  });
  const [historicalStep, setHistoricalStep] = useState("configure"); // configure | preview
  const [historicalPreview, setHistoricalPreview] = useState(null);
  const [running, setRunning] = useState(false);
  const [engineMsg, setEngineMsg] = useState(null);

  // ─── Quick Add: one employee, one month, one amount ───
  const [showQuickAdd, setShowQuickAdd] = useState(false);
  const [quickForm, setQuickForm] = useState({
    employee_name: "",
    department: "",
    amount: "",
    month: prevMonth.month,
    year: prevMonth.year,
    status: "paid",
    saveToStaff: false,
  });
  const [quickErr, setQuickErr] = useState(null);

  // ─── Projection & break-even state ───
  const now = new Date();
  const defFrom = iso(now.getFullYear(), 0, 1);
  const defTo = iso(now.getFullYear(), 11, 31);
  const [projectFrom, setProjectFrom] = useState(defFrom);
  const [projectTo, setProjectTo] = useState(defTo);
  const [occPct, setOccPct] = useState(60);
  const [adrOverride, setAdrOverride] = useState("");
  const [projection, setProjection] = useState(null);

  const { data: occRows = [] } = useOccupancyRange(projectFrom || undefined, projectTo || undefined, property);

  const activeStaff = staff.filter((s) => s.active !== false);

  const propFor = () => {
    // `property` is "all", an id, or an array of ids from the global filter.
    const id = Array.isArray(property) ? property[0] : property;
    if (!id || id === "all") return null;
    return properties.find((x) => x.id === id) || null;
  };

  // Every money surface (dashboard Money Kept, Action Center, Expenses,
  // Forecasting, ModuleCards) reads payroll under the ["payroll", propertyKey]
  // key, so invalidating the ["payroll"] prefix refreshes all of them. Writing
  // payroll without this leaves the dashboard showing a stale "money kept".
  const invalidateMoney = () => {
    qc.invalidateQueries({ queryKey: ["payroll"] });
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
    const payCalc = calculatePay({
      pay_type: form.pay_type,
      base_rate: form.base_rate,
      hours: form.hours,
      overtime_hours: form.overtime_hours,
      overtime_rate: form.overtime_rate,
      bonus: form.bonus,
      deductions: form.deductions,
    });

    const propertyId = property !== "all" ? (Array.isArray(property) ? property[0] : property) : "";
    if (!propertyId) {
      alert("Please select a specific property from the global filter before adding payroll.");
      return;
    }

    const p = propFor();
    await db.entities.PayrollRun.create({
      ...form,
      ...payCalc,
      payroll_status: "draft",
      property_id: propertyId,
      property_name: p?.name || "",
    });
    setForm(EMPTY_RUN);
    sfx.success();
    invalidateMoney();
    setShowForm(false);
  };

  // ─── Quick Add: record a flat amount already paid for one whole month ───
  //
  // The manual "Add Entry" form asks for rate x hours and two period dates,
  // which is the wrong shape when the owner simply knows "I paid Moin $3,000
  // for July". This takes the amount directly, derives the period from the
  // month, and books it as salary so `calculatePay` treats base_rate as the
  // full amount rather than multiplying it by hours.
  const quickPeriod = monthPeriod(quickForm.year, quickForm.month);

  const quickDuplicate = (() => {
    const name = quickForm.employee_name.trim().toLowerCase();
    if (!name) return null;
    return payroll.find(
      (p) =>
        String(p.employee_name || "").trim().toLowerCase() === name &&
        p.pay_period_end === quickPeriod.periodEnd
    ) || null;
  })();

  const handleQuickAdd = async () => {
    if (running) return;
    const name = quickForm.employee_name.trim();
    const amount = Number(quickForm.amount);

    if (!name) { setQuickErr("Enter the employee's name."); return; }
    if (!(amount > 0)) { setQuickErr("Enter an amount greater than zero."); return; }
    if (quickDuplicate) {
      setQuickErr(`${name} already has a payroll run for ${quickPeriod.label}. Delete it first if you want to replace it.`);
      return;
    }

    setRunning(true);
    setQuickErr(null);
    try {
      const p = propFor();
      const propertyId = property !== "all" ? (Array.isArray(property) ? property[0] : property) : "";
      if (!propertyId) {
        setQuickErr("Please select a specific property from the global filter before adding payroll.");
        setRunning(false);
        return;
      }
      const propertyName = p?.name || "";

      // Match against the staff directory so the run carries the same
      // employee_id the engine would use — that is what makes the historical
      // poster's duplicate check see this run later.
      const existingStaff = activeStaff.find(
        (s) => String(s.employee_name || "").trim().toLowerCase() === name.toLowerCase()
      );

      const payCalc = calculatePay({ pay_type: "salary", base_rate: amount });
      const record = buildPayrollRunRecord({
        staff: {
          employee_name: name,
          department: quickForm.department || existingStaff?.department || "",
          pay_type: "salary",
          employee_id: existingStaff?.employee_id || "",
        },
        payCalc,
        periodStart: quickPeriod.periodStart,
        periodEnd: quickPeriod.periodEnd,
        status: quickForm.status,
        propertyId,
        propertyName,
        autoGenerated: false,
        employeeId: existingStaff?.employee_id || "",
      });

      await db.entities.PayrollRun.create(record);

      // Optionally add them to the directory so the monthly engine picks them
      // up from here on, instead of the owner re-entering the amount forever.
      if (quickForm.saveToStaff && !existingStaff) {
        // Reserved, not derived: the id is persisted before use so a deleted
        // employee's id can never be handed to this new hire (see employeeId.js).
        const reservedId = await reserveEmployeeId(name, staff);
        await db.entities.Staff.create({
          employee_name: name,
          department: quickForm.department || "",
          pay_type: "salary",
          base_rate: amount,
          hours: 0,
          overtime_hours: 0,
          overtime_rate: 0,
          bonus: 0,
          deductions: 0,
          active: true,
          employee_id: reservedId,
          property_id: propertyId,
          property_name: propertyName,
        });
        qc.invalidateQueries({ queryKey: ["staff"] });
      }

      try {
        await db.audit.log({
          username: "system",
          action: "Payroll Quick Add",
          detail: `${name} — ${money2(amount)} for ${quickPeriod.label} (${quickForm.status}).`,
        });
      } catch (e) {
        console.error("[audit] quick payroll:", e);
      }

      invalidateMoney();
      setEngineMsg({ status: "ok", message: `Recorded ${money2(amount)} for ${name} — ${quickPeriod.label}.` });
      setQuickForm((f) => ({ ...f, employee_name: "", department: "", amount: "", saveToStaff: false }));
      setShowQuickAdd(false);
      sfx.success();
    } catch (e) {
      console.error("[quickPayroll]", e);
      setQuickErr(e.message || "Could not save the payroll entry.");
      sfx.error();
    } finally {
      setRunning(false);
    }
  };

  // ─── Staff directory (input for the automated engine) ───
  const handleAddStaff = async () => {
    if (!staffForm.employee_name || !staffForm.base_rate) return;
    const baseRate = Number(staffForm.base_rate) || 0;
    const p = propFor();
    // Reserved before the create so two rapid clicks cannot both be issued the
    // same id, and so a departed employee's id is never reissued.
    const reservedId = await reserveEmployeeId(staffForm.employee_name, staff);
    await db.entities.Staff.create({
      ...staffForm,
      base_rate: baseRate,
      hours: Number(staffForm.hours) || 0,
      overtime_hours: Number(staffForm.overtime_hours) || 0,
      overtime_rate: Number(staffForm.overtime_rate) || baseRate * 1.5,
      bonus: Number(staffForm.bonus) || 0,
      deductions: Number(staffForm.deductions) || 0,
      employee_id: reservedId,
      property_id: property !== "all" ? (Array.isArray(property) ? property[0] : property) : "",
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

  const handleDeleteStaff = async (s) => {
    // Matched by name because PayrollRun stores employee_name, not a link to this
    // record (base44/entities/PayrollRun.jsonc has no staff_id). Normalised, because
    // a missed match under-reports — it would tell the owner no pay history exists
    // when it does, which is the one number worth knowing before removing someone.
    const nameKey = String(s?.employee_name || "").trim().toLowerCase();
    const ownRuns = nameKey
      ? payroll.filter((r) => String(r?.employee_name || "").trim().toLowerCase() === nameKey)
      : [];
    const ownRunCents = sumCents(ownRuns.map((r) => r?.total_pay || 0));

    const gate = guardDestructiveAction({
      title: `Remove ${s?.employee_name || "this staff member"} from the directory?`,
      lines: [
        `${s?.employee_id || "no employee id"} · ${s?.department || "no department"} · ${money2(s?.base_rate || 0)}${s?.pay_type === "salary" ? "/mo" : "/hr"}`,
        "They will no longer appear in future payroll runs or projections.",
      ],
      dependents: [{
        label: ownRuns.length === 1 ? "payroll run" : "payroll runs",
        count: ownRuns.length,
        detail: `${money2(fromCents(ownRunCents))} already recorded`,
      }],
    });
    if (!gate.ok) {
      if (gate.message) toast.error(gate.message);
      return;
    }
    try {
      await db.entities.Staff.delete(s.id);
    } catch (e) {
      sfx.error();
      toast.error(`Could not remove ${s?.employee_name || "the staff member"}: ${e?.message || e}`);
      return;
    }
    gate.complete();
    sfx.pop();
    qc.invalidateQueries({ queryKey: ["staff"] });
    toast.success(`${s?.employee_name || "Staff member"} removed from the directory.`);
  };

  // ─── Post Historical Payroll (bulk create for past months) ───
  const generateHistoricalPreview = () => {
    const { fromMonth, fromYear, toMonth, toYear, status, useStaffDirectory, monthlyOverrides } = historicalForm;
    if (fromYear > toYear || (fromYear === toYear && fromMonth > toMonth)) {
      setEngineMsg({ status: "failed", message: "End date must be after start date." });
      sfx.error();
      return null;
    }
    if (useStaffDirectory && !activeStaff.length) {
      setEngineMsg({ status: "failed", message: "No active staff in directory. Add staff first." });
      sfx.error();
      return null;
    }

    const periods = generateMonthPeriods(fromYear, fromMonth, toYear, toMonth);
    const staffSource = useStaffDirectory ? activeStaff : historicalForm.customEntries.filter(e => e.employee_name && Number(e.base_rate) > 0);
    if (!staffSource.length) {
      setEngineMsg({ status: "failed", message: "No staff to process." });
      sfx.error();
      return null;
    }

    const preview = [];
    let totalRuns = 0;
    let totalSkipped = 0;
    let totalAmount = 0;
    // Amount that will actually be written — skipped rows already exist, so
    // counting them would overstate what this action changes.
    let newAmount = 0;

    for (const period of periods) {
      for (const s of staffSource) {
        // Check if already exists for this staff + period (use employee_id if available)
        const staffId = s.employee_id || s.id || s.employee_name;
        const existing = payroll.find(r => {
          const rId = r.employee_id || r.id || r.employee_name;
          return rId === staffId && r.pay_period_end === period.periodEnd;
        });
        
        const overrideKey = `${staffId}-${period.year}-${period.month}`;
        const override = monthlyOverrides[overrideKey] || {};
        
        const payCalc = calculatePay({
          pay_type: s.pay_type,
          base_rate: s.base_rate,
          hours: override.hours ?? s.hours,
          overtime_hours: override.overtime_hours ?? s.overtime_hours,
          overtime_rate: s.overtime_rate,
          bonus: override.bonus ?? s.bonus,
          deductions: override.deductions ?? s.deductions,
        });

        totalAmount += payCalc.total_pay;

        preview.push({
          staffId,
          staffName: s.employee_name,
          department: s.department,
          payType: s.pay_type,
          period: period.label,
          periodStart: period.periodStart,
          periodEnd: period.periodEnd,
          payCalc,
          existing: !!existing,
          status: existing ? "skipped" : status,
          override: Object.keys(override).length > 0,
        });

        if (existing) {
          totalSkipped++;
        } else {
          totalRuns++;
          newAmount += payCalc.total_pay;
        }
      }
    }

    return {
      periods,
      staffCount: staffSource.length,
      totalRuns,
      totalSkipped,
      totalAmount,
      newAmount,
      items: preview,
    };
  };

  const handlePreviewHistorical = () => {
    const preview = generateHistoricalPreview();
    if (preview) {
      setHistoricalPreview(preview);
      setHistoricalStep("preview");
    }
  };

  // ─── Historical modal derived state ───
  //
  // The summary previously read `activeStaff.length || customEntries.length`,
  // which reports the directory count even in Custom Entries mode, and the
  // month span was computed inline from raw month numbers. Both are derived
  // once here from the selected mode so the summary, the button label and the
  // disabled rule can never disagree.
  const historicalCustomValid = historicalForm.customEntries.filter(
    (e) => e.employee_name && Number(e.base_rate) > 0
  );
  const historicalSourceCount = historicalForm.useStaffDirectory
    ? activeStaff.length
    : historicalCustomValid.length;

  const historicalMonthCount = (() => {
    const a = normalizeMonth(historicalForm.fromYear, historicalForm.fromMonth);
    const b = normalizeMonth(historicalForm.toYear, historicalForm.toMonth);
    const span = (b.year - a.year) * 12 + (b.month - a.month) + 1;
    return span > 0 ? span : 0;
  })();

  const historicalPlannedRuns = historicalSourceCount * historicalMonthCount;

  // Previously the Post button also required `activeStaff.length`, so Custom
  // Entries mode stayed disabled even with valid rows typed in.
  const historicalReady = historicalSourceCount > 0 && historicalMonthCount > 0;

  const handleBackToConfigure = () => {
    setHistoricalPreview(null);
    setHistoricalStep("configure");
  };

  const closeHistorical = () => {
    setShowHistoricalForm(false);
    setHistoricalPreview(null);
    setHistoricalStep("configure");
  };

  // Posting is only reachable from the preview step, which is what populates
  // `historicalPreview`. Guarding on it here (rather than silently returning as
  // before) means a missing preview is a bug, not a dead button.
  const handlePostHistorical = async () => {
    if (running) return;
    if (!historicalPreview) { handlePreviewHistorical(); return; }

    setRunning(true);
    setHistoricalStep("posting");
    setEngineMsg(null);

    try {
      const p = propFor();
      const propertyId = property !== "all" ? (Array.isArray(property) ? property[0] : property) : "";
      const propertyName = p?.name || "";
      const { fromMonth, fromYear, toMonth, toYear, status, useStaffDirectory, monthlyOverrides } = historicalForm;
      const periods = generateMonthPeriods(fromYear, fromMonth, toYear, toMonth);
      const staffSource = useStaffDirectory ? activeStaff : historicalForm.customEntries.filter(e => e.employee_name && Number(e.base_rate) > 0);

      // Build all records to create
      const recordsToCreate = [];
      let created = 0;
      let skipped = 0;

      for (const period of periods) {
        for (const s of staffSource) {
          const staffId = s.employee_id || s.id || s.employee_name;
          const existing = payroll.find(r => {
            const rId = r.employee_id || r.id || r.employee_name;
            return rId === staffId && r.pay_period_end === period.periodEnd;
          });
          
          if (existing) { skipped++; continue; }

          const overrideKey = `${staffId}-${period.year}-${period.month}`;
          const override = monthlyOverrides[overrideKey] || {};
          
          const payCalc = calculatePay({
            pay_type: s.pay_type,
            base_rate: s.base_rate,
            hours: override.hours ?? s.hours,
            overtime_hours: override.overtime_hours ?? s.overtime_hours,
            overtime_rate: s.overtime_rate,
            bonus: override.bonus ?? s.bonus,
            deductions: override.deductions ?? s.deductions,
          });

          const record = buildPayrollRunRecord({
            staff: s,
            payCalc,
            periodStart: period.periodStart,
            periodEnd: period.periodEnd,
            status,
            propertyId,
            propertyName,
            autoGenerated: false,
            employeeId: staffId,
          });

          recordsToCreate.push(record);
          created++;
        }
      }

      if (recordsToCreate.length > 0) {
        // Use transaction + bulkCreate for atomicity and performance
        await runInTransaction(async () => {
          await db.entities.PayrollRun.bulkCreate(recordsToCreate);
        });

        // Audit log for bulk historical posting
        // Total the records actually written rather than reading it off the
        // preview, so the audit line stays true even if the preview is stale.
        const postedTotal = fromCents(sumCents(recordsToCreate.map((r) => r.total_pay || 0)));
        try {
          await db.audit.log({
            username: "system",
            action: "Historical Payroll Posted",
            detail: `Posted ${created} historical payroll run(s) for ${staffSource.length} staff over ${periods.length} month(s). Total: ${money2(postedTotal)}. Skipped ${skipped} existing.`,
          });
        } catch (e) {
          console.error("[audit] historical payroll:", e);
        }
      }

      invalidateMoney();
      setShowHistoricalForm(false);
      setHistoricalPreview(null);
      setHistoricalStep("configure");
      setEngineMsg({ status: "ok", message: `Historical payroll posted: ${created} run(s) created, ${skipped} skipped (already exist).` });
      sfx.success();
    } catch (e) {
      console.error("[postHistorical]", e);
      setEngineMsg({ status: "failed", message: e.message || "Failed to post historical payroll." });
      sfx.error();
    } finally {
      setRunning(false);
      setHistoricalStep("configure");
    }
  };

  // ─── Payroll run status ops ───
  const handleStatusChange = async (id, status) => {
    await db.entities.PayrollRun.update(id, { payroll_status: status });
    sfx.pop();
    // Status drives whether the run counts toward money kept, so this must
    // refresh the dashboard too, not just the local list.
    invalidateMoney();
  };

  const handleDelete = async (p) => {
    // A committed run is money that left the business. Deleting one does not
    // just remove a row — it raises reported Money Kept by the same amount,
    // because only approved and paid runs are subtracted from it. The operator
    // is told that explicitly rather than being asked "are you sure?".
    const committed = p?.payroll_status === "approved" || p?.payroll_status === "paid";
    const gate = guardDestructiveAction({
      title: `Delete the payroll run for ${p?.employee_name || "this employee"}?`,
      lines: [
        `${money2(p?.total_pay || 0)} · ${p?.pay_period_start || "—"} to ${p?.pay_period_end || "—"} · marked ${p?.payroll_status || "draft"}`,
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
    } catch (e) {
      sfx.error();
      toast.error(`Could not delete the payroll run: ${e?.message || e}. Nothing was removed.`);
      return;
    }
    gate.complete();
    sfx.pop();
    invalidateMoney();
    toast.success(`Payroll run for ${p?.employee_name || "employee"} deleted.`);
  };

  // ─── Projection & break-even engine ───
  // Runs payroll for the selected range (past months read existing runs, current
  // & future months are forecast from active staff) then computes, per month:
  //   1. Simulated/adjusted monthly payroll cost.
  //   2. Revenue at the target occupancy % × daily rooms × ADR.
  //   3. Payroll as a % of that revenue (payroll ratio).
  //   4. Break-even: occupancy % at which nights sold exactly cover payroll.
  const totalRooms = () => {
    if (property === "all") {
      const sumRooms = properties.reduce((s, p) => s + (p.rooms || 0), 0);
      return sumRooms || PROPERTY.rooms;
    }
    const ids = Array.isArray(property) ? property : [property];
    const matched = properties.filter((p) => ids.includes(p.id));
    const sumRooms = matched.reduce((s, p) => s + (p.rooms || 0), 0);
    return sumRooms || PROPERTY.rooms;
  };

  const estAdr = (() => {
    const rev = occRows.reduce((a, r) => a + (r.room_revenue || 0), 0);
    const sold = occRows.reduce((a, r) => a + (r.rooms_sold || 0), 0);
    return sold > 0 ? rev / sold : 0;
  })();
  const adr = Number(adrOverride) || estAdr || 0;

  // Monthly payroll row source: prefer the real (logged) runs when the month is
  // already in the books; otherwise model every active staff member's pay.
  //
  // Deliberately NOT filtered through filterCommittedPay, unlike every consumer
  // that reports money kept or profit for a real period. This is a forward
  // break-even projection against hypothetical revenue, so a draft run is the best
  // available estimate of what that month will cost — excluding it would understate
  // the projection. Do not "correct" this to match the dashboard: the two are
  // answering different questions.
  function payrollForMonth(periodEnd) {
    const actual = payroll.filter((p) => p.pay_period_end === periodEnd);
    if (actual.length) {
      return {
        source: "Actual",
        count: actual.length,
        regular: fromCents(sumCents(actual.map((p) => p.regular_pay || 0))),
        overtime: fromCents(sumCents(actual.map((p) => p.overtime_pay || 0))),
        bonus: fromCents(sumCents(actual.map((p) => p.bonus || 0))),
        deductions: fromCents(sumCents(actual.map((p) => p.deductions || 0))),
        total: fromCents(sumCents(actual.map((p) => p.total_pay || 0))),
      };
    }
    let count = 0, regular = 0, overtime = 0, bonus = 0, deductions = 0;
    for (const s of activeStaff) {
      if (!s.employee_name || !(Number(s.base_rate) > 0)) continue;
      const baseRate = Number(s.base_rate) || 0;
      const hours = Number(s.hours) || 0;
      const otH = Number(s.overtime_hours) || 0;
      const otR = Number(s.overtime_rate) || baseRate * 1.5;
      const bns = Number(s.bonus) || 0;
      const ded = Number(s.deductions) || 0;
      const reg = s.pay_type === "salary" ? baseRate : baseRate * hours;
      regular += reg; overtime += otH * otR; bonus += bns; deductions += ded; count++;
    }
    return { source: "Projected", count, regular, overtime, bonus, deductions, total: regular + overtime + bonus - deductions };
  }

  const handleRunProjection = () => {
    if (running) return;
    if (!projectFrom || !projectTo) { setProjection(null); return; }
    if (projectTo < projectFrom) { setProjection({ error: "End date must be after the start date." }); return; }
    const rooms = totalRooms();
    if (!(rooms > 0)) { setProjection({ error: "No room count found for the selected property." }); return; }
    if (!(adr > 0)) { setProjection({ error: "No ADR available. Enter a daily rate to compute break-even." }); return; }

    const fromY = Number(projectFrom.slice(0, 4));
    const fromM = Number(projectFrom.slice(5, 7)) - 1;
    const toY = Number(projectTo.slice(0, 4));
    const toM = Number(projectTo.slice(5, 7)) - 1;

    const rows = [];
    let y = fromY, m = fromM;
    while (y < toY || (y === toY && m <= toM)) {
      const days = lastDayOf(y, m);
      const periodEnd = iso(y, m, lastDayOf(y, m));
      const pay = payrollForMonth(periodEnd);
      const revenue = rooms * days * (occPct / 100) * adr;
      const breakEvenOcc = adr > 0 ? (pay.total > 0 ? (pay.total / (rooms * days * adr)) * 100 : 0) : 0;
      rows.push({ label: monthLabel(y, m), days, ...pay, revenueAtOcc: revenue, breakEvenOcc });
      if (m === 11) { m = 0; y++; } else { m++; }
    }

    const totalPay7 = rows.reduce((a, r) => a + r.total, 0);
    const totalRev = rows.reduce((a, r) => a + r.revenueAtOcc, 0);
    const months = rows.length;
    setProjection({
      rows,
      totalPay: totalPay7,
      totalRev,
      months,
      rooms,
      adr,
      avgMonthly: months ? totalPay7 / months : 0,
      avgRevMonthly: months ? totalRev / months : 0,
      payrollRatio: totalRev > 0 ? (totalPay7 / totalRev) * 100 : 0,
      breakEvenOcc: totalPay7 > 0 ? (totalPay7 / (months * rooms * 30.44 * adr)) * 100 : 0,
    });
    sfx.success();
  };

  // ─── KPIs ───
  const totalPay = fromCents(sumCents(payroll.map((p) => p.total_pay || 0)));
  // What the dashboard actually deducts: approved + paid only. Showing it next
  // to the gross total is what tells the owner why the two figures differ.
  const committedPay = sumCommittedPay(payroll);
  const totalOT = fromCents(sumCents(payroll.map((p) => p.overtime_pay || 0)));
  const totalBonus = fromCents(sumCents(payroll.map((p) => p.bonus || 0)));
  const totalDeductions = fromCents(sumCents(payroll.map((p) => p.deductions || 0)));
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
        <KpiCard label="Total Payroll" value={money2(totalPay)} sub={`${payroll.length} runs · OT ${money2(totalOT)}`} accent={C.green} icon={DollarSign} />
        <KpiCard label="Deducted From Cash" value={money2(committedPay)} sub={draftCount ? `${draftCount} draft not counted` : "All runs counted"} accent={C.cyan} icon={Wallet} />
        <KpiCard label="Approved" value={num(approvedCount)} sub={`${paidCount} paid · ${draftCount} draft`} accent={C.amber} icon={CheckCircle2} />
        <KpiCard label="Deductions" value={money2(totalDeductions)} sub={`Bonus: ${money2(totalBonus)}`} accent={C.coral} icon={DollarSign} />
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
            {/* Run Payroll Now is the single action this panel exists to offer,
                so it is the only `primary` in the cluster. Quick Add and Post
                Historical are alternate entry paths into the same ledger, not the
                answer to the panel's question, so both read as `soft` — two
                identical-looking secondaries side by side is the same shape
                Statistics already uses for its two exports.

                fx-clickable is carried across deliberately. It is not a colour or
                a geometry the primitive owns: it suppresses the mobile tap
                highlight and adds a touch-only press scale, and dropping it would
                be an unrequested behaviour change on touch devices. */}
            <Button
              variant="soft"
              onClick={() => { setQuickErr(null); setShowQuickAdd(true); }}
              disabled={running}
              className="fx-clickable"
            >
              <Wallet className="h-4 w-4" /> Quick Add
            </Button>
            <Button
              variant="soft"
              onClick={() => { setHistoricalStep("configure"); setHistoricalPreview(null); setShowHistoricalForm(true); }}
              disabled={running}
              className="fx-clickable"
            >
              <History className="h-4 w-4" /> Post Historical
            </Button>
            <Button
              variant="primary"
              onClick={handleRunEngine}
              disabled={running}
              className="fx-clickable"
            >
              <Zap className={`h-4 w-4 ${running ? "animate-pulse" : ""}`} />
              {running ? "Running…" : "Run Payroll Now"}
            </Button>
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

      {/* ─── Payroll projection & break-even ─── */}
      <Card
        title="Payroll Projection & Break-Even"
        subtitle="Run payroll across a date range — past months use logged runs, the current month and future months are forecast from your active staff — then compare the cost against revenue at your occupancy target."
        right={
          /* `primary`: the only control in this Card's header, and running the
             projection is the whole point of the panel. `sm` matches the 32px
             header actions the page already uses.

             BARE block comment, deliberately. `right=` opens a JavaScript
             expression slot, not a JSX children position, so the braced JSX
             comment form is a syntax error here — the inner brace opens a second
             expression the parser then cannot close, and it fails on the next
             attribute name. Same applies to the two other `right=` slots below.

             No icon size class: Button's BASE carries `[&_svg]:size-4` as a
             descendant selector at specificity (0,1,1), which outranks any
             `h-*`/`w-*` on the svg itself at (0,1,0). Writing a size here would
             claim 14px and render 16px. */
          <Button variant="primary" size="sm" onClick={handleRunProjection} disabled={running} className="fx-clickable">
            <Target /> Run Projection
          </Button>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-slate-400">From (period start)</label>
            <Input type="date" value={projectFrom} onChange={(e) => setProjectFrom(e.target.value)} />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-slate-400">To (period end)</label>
            <Input type="date" value={projectTo} onChange={(e) => setProjectTo(e.target.value)} />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-slate-400">Target occupancy %</label>
            <Input type="number" min="0" max="100" value={occPct} onChange={(e) => setOccPct(Number(e.target.value) || 0)} />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-slate-400">
              ADR ($/room) {!adrOverride && estAdr > 0 ? "(auto)" : ""}
            </label>
            <Input type="number" min="0" value={adrOverride} onChange={(e) => setAdrOverride(e.target.value)} placeholder={estAdr ? String(Math.round(estAdr * 100) / 100) : "e.g. 120"} />
            {!adrOverride && estAdr > 0 && (
              <p className="mt-1 flex items-center gap-1 text-[10px] text-slate-500">
                <TrendingUp className="h-3 w-3" /> Estimated from {occRows.length.toLocaleString()} occupancy days
              </p>
            )}
          </div>
        </div>

        {projection?.error && (
          <div className="mt-4 rounded-xl border border-[#FF6B6B]/30 bg-[#FF6B6B]/[0.08] p-3 text-sm text-[#FF6B6B]">
            {projection.error}
          </div>
        )}

        {projection?.rows && !projection.error && (
          <div className="mt-5 space-y-4">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-xl border border-[#00D4FF]/30 bg-[#00D4FF]/[0.06] p-3">
                <p className="text-[10px] uppercase tracking-widest text-slate-500">Payroll — {projection.months} mo</p>
                <p className="mt-1 font-heading text-2xl font-semibold text-white">{money2(projection.totalPay)}</p>
                <p className="mt-0.5 text-[10px] text-slate-500">{money2(projection.avgMonthly)} / month average</p>
              </div>
              <div className="rounded-xl border border-[#00E096]/30 bg-[#00E096]/[0.06] p-3">
                <p className="text-[10px] uppercase tracking-widest text-slate-500">Revenue @ {occPct}% occ</p>
                <p className="mt-1 font-heading text-2xl font-semibold text-white">{money2(projection.totalRev)}</p>
                <p className="mt-0.5 text-[10px] text-slate-500">{money2(projection.avgRevMonthly)} / month · {projection.rooms} rooms</p>
              </div>
              <div className="rounded-xl border border-[#FFB547]/30 bg-[#FFB547]/[0.06] p-3">
                <p className="text-[10px] uppercase tracking-widest text-slate-500">Payroll % of revenue</p>
                <p className="mt-1 font-heading text-2xl font-semibold text-white">{pct(projection.payrollRatio / 100)}</p>
                <p className="mt-0.5 text-[10px] text-slate-500">Lower is healthier · target under 25–30%</p>
              </div>
              <div className="rounded-xl border border-white/10 bg-[#0A1628]/60 p-3">
                <p className="text-[10px] uppercase tracking-widest text-slate-500">Break-even occupancy</p>
                <p className="mt-1 font-heading text-2xl font-semibold text-white">{pct(projection.breakEvenOcc / 100)}</p>
                <p className="mt-0.5 text-[10px] text-slate-500">Occupancy needed to fully cover payroll</p>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-white/10 text-[10px] uppercase tracking-widest text-slate-500">
                    <th className="py-2 pr-3">Month</th>
                    <th className="py-2 px-3 text-right">Payroll</th>
                    <th className="py-2 px-3 text-right">Rev @ {occPct}%</th>
                    <th className="py-2 px-3 text-right">Payroll %</th>
                    <th className="py-2 px-3 text-right">Break-even occ</th>
                    <th className="py-2 px-3 text-right">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {projection.rows.map((r, i) => (
                    <tr key={i} className="border-b border-white/5">
                      <td className="py-2 pr-3 font-medium text-white">{r.label}</td>
                      <td className="py-2 px-3 text-right tabular-nums text-white">{money2(r.total)}</td>
                      <td className="py-2 px-3 text-right tabular-nums text-slate-300">{money2(r.revenueAtOcc)}</td>
                      <td className="py-2 px-3 text-right tabular-nums text-[#FFB547]">{r.revenueAtOcc > 0 ? pct(r.total / r.revenueAtOcc) : "—"}</td>
                      <td className="py-2 px-3 text-right tabular-nums text-[#00D4FF]">{pct(r.breakEvenOcc / 100)}</td>
                      <td className="py-2 px-3 text-right">
                        <StatusBadge status={r.source === "Actual" ? "paid" : "pending_review"} size="sm" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="rounded-xl border border-[#00E096]/20 bg-[#00E096]/[0.04] p-3 text-xs text-slate-300">
              <p className="font-medium text-[#00E096]">Reading the break-even</p>
              <p className="mt-1">
                With {projection.rooms} rooms at {money2(projection.adr)}/night you need <span className="font-semibold text-white">{pct(projection.breakEvenOcc / 100)}</span> occupancy for room revenue alone to cover your
                {money2(projection.totalPay)} payroll ({money2(projection.avgMonthly)}/mo). At {occPct}% occupancy you pull {money2(projection.avgRevMonthly)}/month of room revenue — your payroll runs {pct(projection.payrollRatio / 100)} of it.
              </p>
            </div>
          </div>
        )}
      </Card>

      {/* ─── Staff directory ─── */}
      <Card
        title="Staff Directory"
        subtitle={`${num(staff.length)} staff · ${num(activeStaff.length)} active — the engine pays active staff every month-end`}
        right={
          /* Bare block comment — expression slot, see the projection Card above.
             `primary`: the one action this panel offers. The empty-state twin
             below is `soft` so the two never compete. */
          <Button variant="primary" size="sm" onClick={() => setShowStaffForm(true)} className="fx-clickable">
            <UserPlus /> Add Staff
          </Button>
        }
      >
        {showStaffForm && (
          <DialogPrimitive.Root open={showStaffForm} onOpenChange={setShowStaffForm}>
            <DialogPrimitive.Portal>
              <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
              <DialogPrimitive.Content 
                className="fixed inset-0 z-50 flex items-center justify-center p-4 outline-none pointer-events-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
                aria-describedby={undefined}
              >
                <div className="w-full max-w-lg rounded-2xl border border-[#00E096]/30 bg-[#151921] p-6 shadow-2xl pointer-events-auto" style={{ boxShadow: "0 0 30px rgba(0,224,150,0.15)" }}>
              <div className="mb-5 flex items-center justify-between">
                <DialogPrimitive.Title className="font-heading text-lg font-semibold text-white">Add Staff Member</DialogPrimitive.Title>
                <DialogPrimitive.Close className="text-slate-400 hover:text-white" aria-label="Close">
                  <X className="h-5 w-5" />
                </DialogPrimitive.Close>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-400">Full Name *</label>
                  <Input value={staffForm.employee_name} onChange={(e) => setStaffForm({ ...staffForm, employee_name: e.target.value })} placeholder="Jane Smith" />
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-400">Department</label>
                  <Input value={staffForm.department} onChange={(e) => setStaffForm({ ...staffForm, department: e.target.value })} placeholder="Front Office" />
                </div>
                <div className="sm:col-span-2">
                  <label className="mb-1.5 block text-xs font-medium text-slate-400">Pay Type</label>
                  <Select value={staffForm.pay_type} onChange={(e) => setStaffForm({ ...staffForm, pay_type: e.target.value })}>
                    <option value="hourly">Hourly</option>
                    <option value="salary">Salary</option>
                  </Select>
                </div>
                <div className="sm:col-span-2">
                  <label className="mb-1.5 block text-xs font-medium text-slate-400">
                    {staffForm.pay_type === "salary" ? "Salary Amount ($/month)" : "Hourly Rate ($)"}
                  </label>
                  <Input type="number" value={staffForm.base_rate} onChange={(e) => setStaffForm({ ...staffForm, base_rate: e.target.value })} placeholder="0" />
                </div>
                {staffForm.pay_type === "hourly" && (
                  <>
                    <div>
                      <label className="mb-1.5 block text-xs font-medium text-slate-400">Hours / Month</label>
                      <Input type="number" value={staffForm.hours} onChange={(e) => setStaffForm({ ...staffForm, hours: e.target.value })} placeholder="160" />
                    </div>
                    <div>
                      <label className="mb-1.5 block text-xs font-medium text-slate-400">Overtime Hours</label>
                      <Input type="number" value={staffForm.overtime_hours} onChange={(e) => setStaffForm({ ...staffForm, overtime_hours: e.target.value })} placeholder="0" />
                    </div>
                    <div>
                      <label className="mb-1.5 block text-xs font-medium text-slate-400">Overtime Rate (blank = 1.5x)</label>
                      <Input type="number" value={staffForm.overtime_rate} onChange={(e) => setStaffForm({ ...staffForm, overtime_rate: e.target.value })} placeholder="Auto" />
                    </div>
                  </>
                )}
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-400">Bonus ($)</label>
                  <Input type="number" value={staffForm.bonus} onChange={(e) => setStaffForm({ ...staffForm, bonus: e.target.value })} placeholder="0" />
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-400">Deductions ($)</label>
                  <Input type="number" value={staffForm.deductions} onChange={(e) => setStaffForm({ ...staffForm, deductions: e.target.value })} placeholder="0" />
                </div>
              </div>
              <div className="mt-5 flex justify-end gap-3">
                <Button variant="secondary" onClick={() => setShowStaffForm(false)}>
                  Cancel
                </Button>
                <Button variant="primary" onClick={handleAddStaff}>
                  <Save className="h-4 w-4" /> Save Staff
                </Button>
              </div>
              </div>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
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
                      {s.department || "—"} · {s.pay_type} · {s.pay_type === "salary" ? money2(s.base_rate) + "/mo" : money2(s.base_rate) + "/hr"}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <StatusBadge status={isActive ? "active" : "inactive"} size="sm" />
                  {/* NOT a SegmentedControl. This is a single button that flips
                      one boolean, and the handler computes the flip from the
                      current value — `handleToggleStaff(s.id, s.active)`. A
                      segmented control would have to hand the target value in
                      instead, which is a logic change, and it only fires when the
                      clicked item is NOT already selected, which is the opposite
                      of what a re-clickable toggle needs. The variant carries the
                      state (soft when active, neutral when not) and the caption
                      still says which, so colour is not the only signal.

                      Power's `h-3 w-3` is dropped: Button's `[&_svg]:size-4`
                      descendant selector outranks it, so the icon renders at 16px
                      either way — the same 16px-in-28px ratio the primitive's own
                      `xs` size is designed around. */}
                  <Button
                    variant={isActive ? "soft" : "secondary"}
                    size="xs"
                    onClick={() => handleToggleStaff(s.id, s.active)}
                    title={isActive ? "Deactivate (excluded from payroll)" : "Activate (included in payroll)"}
                  >
                    <Power /> {isActive ? "Active" : "Inactive"}
                  </Button>
                  {/* `ghost`, not `danger`: this affordance carries no text, and
                      `danger` would make colour the sole signal of a destructive
                      action (WCAG 1.4.1). The destructive hover cue is preserved
                      via the semantic token rather than the hex it replaces.
                      aria-label is additive beyond a pure visual conversion —
                      flagged in the report, trivially revertible — but a
                      `size="icon"` button with no accessible name is not a
                      control I am willing to leave behind. */}
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => handleDeleteStaff(s)}
                    aria-label={`Remove ${s.employee_name || "staff member"} from the directory`}
                    title="Remove from directory"
                    className="hover:text-[var(--data-negative)]"
                  >
                    <Trash2 />
                  </Button>
                </div>
              </div>
            );
          })}
          {!staff.length && (
            <div className="py-4 text-center">
              <p className="text-sm text-slate-500">No staff yet. Add staff members — the automated engine pays every active member on month-end.</p>
              {/* `soft`, not `primary`: the Card header's Add Staff is already
                  the panel's primary and both call the same setter, so a second
                  primary would put two competing answers on one panel. */}
              <Button variant="soft" size="sm" onClick={() => setShowStaffForm(true)} className="mt-3">
                <UserPlus /> Add First Staff Member
              </Button>
            </div>
          )}
        </div>
      </Card>

      {/* ─── Payroll runs ─── */}
      <Card
        title="Payroll Runs"
        subtitle={`${payroll.length} entries · ${money2(totalPay)} total`}
        right={
          /* Bare block comment — expression slot, see the projection Card above.
             C-017 site: this was white on indigo at 4.32:1. `primary` because it
             is the only control in this Card's header and adding an entry is the
             panel's action. */
          <Button variant="primary" size="sm" onClick={() => setShowForm(true)} className="fx-clickable">
            <Plus /> Add Entry
          </Button>
        }
      >
        {showForm && (
          <DialogPrimitive.Root open={showForm} onOpenChange={setShowForm}>
            <DialogPrimitive.Portal>
              <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
              <DialogPrimitive.Content 
                className="fixed inset-0 z-50 flex items-center justify-center p-4 outline-none pointer-events-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
                aria-describedby={undefined}
              >
                <div className="w-full max-w-lg rounded-2xl border border-white/10 bg-[#151921] p-6 shadow-2xl pointer-events-auto">
              <div className="mb-5 flex items-center justify-between">
                <DialogPrimitive.Title className="font-heading text-lg font-semibold text-white">Add Payroll Entry</DialogPrimitive.Title>
                <DialogPrimitive.Close className="text-slate-400 hover:text-white" aria-label="Close">
                  <X className="h-5 w-5" />
                </DialogPrimitive.Close>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-400">Name *</label>
                  <Input value={form.employee_name} onChange={(e) => setForm({ ...form, employee_name: e.target.value })} placeholder="John Doe" />
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-400">Department</label>
                  <Input value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })} placeholder="Front Office" />
                </div>
                <div className="sm:col-span-2">
                  <label className="mb-1.5 block text-xs font-medium text-slate-400">Pay Type</label>
                  <Select value={form.pay_type} onChange={(e) => setForm({ ...form, pay_type: e.target.value })}>
                    <option value="hourly">Hourly</option>
                    <option value="salary">Salary</option>
                  </Select>
                </div>
                <div className="sm:col-span-2">
                  <label className="mb-1.5 block text-xs font-medium text-slate-400">
                    {form.pay_type === "salary" ? "Salary Amount ($)" : "Hourly Rate ($)"}
                  </label>
                  <Input type="number" value={form.base_rate} onChange={(e) => setForm({ ...form, base_rate: e.target.value })} placeholder="0" />
                </div>
                {form.pay_type === "hourly" && (
                  <>
                    <div>
                      <label className="mb-1.5 block text-xs font-medium text-slate-400">Regular Hours</label>
                      <Input type="number" value={form.hours} onChange={(e) => setForm({ ...form, hours: e.target.value })} placeholder="40" />
                    </div>
                    <div>
                      <label className="mb-1.5 block text-xs font-medium text-slate-400">Overtime Hours</label>
                      <Input type="number" value={form.overtime_hours} onChange={(e) => setForm({ ...form, overtime_hours: e.target.value })} placeholder="0" />
                    </div>
                    <div>
                      <label className="mb-1.5 block text-xs font-medium text-slate-400">Overtime Rate (blank = 1.5x)</label>
                      <Input type="number" value={form.overtime_rate} onChange={(e) => setForm({ ...form, overtime_rate: e.target.value })} placeholder="Auto" />
                    </div>
                  </>
                )}
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-400">Bonus ($)</label>
                  <Input type="number" value={form.bonus} onChange={(e) => setForm({ ...form, bonus: e.target.value })} placeholder="0" />
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-400">Deductions ($)</label>
                  <Input type="number" value={form.deductions} onChange={(e) => setForm({ ...form, deductions: e.target.value })} placeholder="0" />
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-400">Pay Period Start</label>
                  <Input type="date" value={form.pay_period_start} onChange={(e) => setForm({ ...form, pay_period_start: e.target.value })} />
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-400">Pay Period End</label>
                  <Input type="date" value={form.pay_period_end} onChange={(e) => setForm({ ...form, pay_period_end: e.target.value })} />
                </div>
              </div>
              <div className="mt-5 flex justify-end gap-3">
                <Button variant="secondary" onClick={() => setShowForm(false)}>
                  Cancel
                </Button>
                {/* C-017 site: white on indigo at 4.32:1. `primary` — it is the
                    dialog's affirmative action and Cancel is the only rival. */}
                <Button variant="primary" onClick={handleAdd}>
                  <Save /> Save Entry
                </Button>
              </div>
              </div>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
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
                  <p className="text-xs text-slate-500">Reg {money2(p.regular_pay || 0)} · OT {money2(p.overtime_pay || 0)}</p>
                  <p className="text-sm font-heading text-white">{money2(p.total_pay || 0)}</p>
                </div>
                {/* Content-width, not the primitive's default w-full: this sits in
                    a flex row beside the money column, so BOTH the wrapper and the
                    field need w-auto or the select eats the row. statusColor's
                    class lands after the field's own text colour in cn(), so
                    tailwind-merge lets the status hue win — the same behaviour the
                    raw select had. aria-label is additive: this control has no
                    label element of any kind, and it writes payroll status. */}
                <Select
                  value={p.payroll_status || "draft"}
                  onChange={(e) => handleStatusChange(p.id, e.target.value)}
                  aria-label={`Payroll status for ${p.employee_name || "this run"}`}
                  wrapperClassName="w-auto"
                  className={`w-auto text-xs ${statusColor(p.payroll_status)}`}
                >
                  <option value="draft">Draft</option>
                  <option value="pending_review">Pending Review</option>
                  <option value="approved">Approved</option>
                  <option value="paid">Paid</option>
                </Select>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => handleDelete(p)}
                  aria-label={`Delete the payroll run for ${p.employee_name || "this employee"}`}
                  title="Delete payroll run"
                  className="hover:text-[var(--data-negative)]"
                >
                  <Trash2 />
                </Button>
              </div>
            </div>
          ))}
          {!payroll.length && (
            readFailed ? (
              <ErrorState
                title="Could not load payroll runs"
                description="Runs may exist that are not shown. Do not run payroll again until this loads — that would pay the same period twice."
                error={readFailed.error}
                onRetry={retryReads}
              />
            ) : (
              <EmptyState
                icon={Wallet}
                title="No payroll runs yet"
                description="Add staff above and hit “Run Payroll Now”, or add an entry manually. Engine-generated runs are auto-approved on the last day of the month."
              />
            )
          )}
        </div>
      </Card>

      {/* ─── Quick Add Payroll Modal ─── */}
      {showQuickAdd && (
        <DialogPrimitive.Root open={showQuickAdd} onOpenChange={setShowQuickAdd}>
          <DialogPrimitive.Portal>
            <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
            <DialogPrimitive.Content 
              className="fixed inset-0 z-50 flex items-center justify-center p-4 outline-none pointer-events-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
              aria-describedby={undefined}
            >
              <div className="w-full max-w-md rounded-2xl border border-[#00E096]/30 bg-[#151921] p-6 shadow-2xl pointer-events-auto" style={{ boxShadow: "0 0 30px rgba(0,224,150,0.15)" }}>
                <div className="mb-1 flex items-center justify-between">
                  <DialogPrimitive.Title className="font-heading text-lg font-semibold text-white">Quick Add Payroll</DialogPrimitive.Title>
                  <DialogPrimitive.Close className="text-slate-400 hover:text-white" aria-label="Close">
                    <X className="h-5 w-5" />
                  </DialogPrimitive.Close>
                </div>
            <p className="mb-5 text-xs text-slate-500">
              Record a flat amount you already paid for a whole month. No rates or hours needed.
            </p>

            <div className="space-y-4">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-slate-400">Employee *</label>
                <Input
                  list="quick-staff-names"
                  value={quickForm.employee_name}
                  onChange={(e) => { setQuickForm({ ...quickForm, employee_name: e.target.value }); setQuickErr(null); }}
                  placeholder="Moin"
                />
                <datalist id="quick-staff-names">
                  {activeStaff.map((s) => <option key={s.id} value={s.employee_name} />)}
                </datalist>
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-medium text-slate-400">Amount Paid ($) *</label>
                {/* text-lg/font-semibold kept: this is the one figure the dialog
                    exists to capture, and the emphasis is deliberate, not chrome.
                    tailwind-merge drops the field's own text-sm in its favour. */}
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={quickForm.amount}
                  onChange={(e) => { setQuickForm({ ...quickForm, amount: e.target.value }); setQuickErr(null); }}
                  placeholder="3000"
                  className="text-lg font-semibold"
                />
                <p className="mt-1 text-[10px] text-slate-500">The full amount for the month, take-home as you paid it.</p>
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-medium text-slate-400">Month Paid For</label>
                <div className="flex items-center gap-2">
                  {/* wrapperClassName carries the flex-1 the raw select had. The
                      field keeps its default w-full, which a flex-basis of 0%
                      overrides for the main size, so the geometry is unchanged. */}
                  <Select
                    value={quickForm.month}
                    onChange={(e) => { setQuickForm({ ...quickForm, month: Number(e.target.value) }); setQuickErr(null); }}
                    wrapperClassName="flex-1"
                  >
                    {MONTHS.map((m, i) => <option key={i} value={i}>{m}</option>)}
                  </Select>
                  <Input
                    type="number"
                    min="2020"
                    max="2030"
                    value={quickForm.year}
                    onChange={(e) => { setQuickForm({ ...quickForm, year: Number(e.target.value) }); setQuickErr(null); }}
                    className="w-24"
                  />
                </div>
                <p className="mt-1 text-[10px] text-slate-500">
                  Covers {quickPeriod.periodStart} → {quickPeriod.periodEnd}
                </p>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-400">Department</label>
                  <Input
                    value={quickForm.department}
                    onChange={(e) => setQuickForm({ ...quickForm, department: e.target.value })}
                    placeholder="Front Office"
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-400">Status</label>
                  <Select
                    value={quickForm.status}
                    onChange={(e) => setQuickForm({ ...quickForm, status: e.target.value })}
                  >
                    <option value="paid">Paid</option>
                    <option value="approved">Approved</option>
                    <option value="draft">Draft (not counted)</option>
                  </Select>
                </div>
              </div>

              <label className="flex cursor-pointer items-start gap-2">
                {/* Native TOGGLE branch — no sizing classes passed, which is what
                    keeps it a 16px checkbox instead of a 36px w-full trough. The
                    accent moves from a hand-typed emerald to the brand token. */}
                <Input
                  type="checkbox"
                  checked={quickForm.saveToStaff}
                  onChange={(e) => setQuickForm({ ...quickForm, saveToStaff: e.target.checked })}
                  className="mt-0.5"
                />
                <span className="text-xs text-slate-300">
                  Also add to Staff Directory as a {money2(Number(quickForm.amount) || 0)}/month salary
                  <span className="block text-[10px] text-slate-500">So the monthly engine pays them automatically from now on.</span>
                </span>
              </label>

              {quickForm.status === "draft" ? (
                <div className="rounded-xl border border-[#FFB547]/30 bg-[#FFB547]/[0.06] p-3 text-xs text-[#FFB547]">
                  Drafts are not deducted from money kept. Use Approved or Paid to have this reduce your dashboard figure.
                </div>
              ) : (
                <div className="rounded-xl border border-[#00E096]/20 bg-[#00E096]/[0.04] p-3 text-xs text-slate-300">
                  {money2(Number(quickForm.amount) || 0)} will be deducted from Money Kept for {quickPeriod.label}.
                </div>
              )}

              {(quickErr || quickDuplicate) && (
                <div className="rounded-xl border border-[#FF6B6B]/30 bg-[#FF6B6B]/[0.08] p-3 text-xs text-[#FF6B6B]">
                  {quickErr || `${quickForm.employee_name.trim()} already has a run for ${quickPeriod.label}.`}
                </div>
              )}
            </div>

            <div className="mt-5 flex justify-end gap-3">
              <Button variant="secondary" onClick={() => setShowQuickAdd(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={handleQuickAdd}
                disabled={running || !quickForm.employee_name.trim() || !(Number(quickForm.amount) > 0) || !!quickDuplicate}
              >
                {running
                  ? <><Loader2 className="animate-spin" /> Saving…</>
                  : <><Save /> Record Payroll</>}
              </Button>
              </div>
            </div>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
      )}

      {/* ─── Post Historical Payroll Modal ─── */}
      {showHistoricalForm && (
        <DialogPrimitive.Root open={showHistoricalForm} onOpenChange={closeHistorical}>
          <DialogPrimitive.Portal>
            <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
            <DialogPrimitive.Content 
              className="fixed inset-0 z-50 flex items-center justify-center p-4 outline-none pointer-events-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
              aria-describedby={undefined}
            >
              <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-2xl border border-[#6C63FF]/30 bg-[#151921] p-6 shadow-2xl pointer-events-auto">
                <div className="mb-5 flex items-center justify-between">
                  <div>
                    <DialogPrimitive.Title className="font-heading text-lg font-semibold text-white">Post Historical Payroll</DialogPrimitive.Title>
                    <p className="mt-0.5 text-xs text-slate-500">
                      {historicalStep === "configure" ? "Step 1 of 2 · choose the range" : "Step 2 of 2 · review before posting"}
                    </p>
                  </div>
                  <DialogPrimitive.Close className="text-slate-400 hover:text-white" aria-label="Close">
                    <X className="h-5 w-5" />
                  </DialogPrimitive.Close>
                </div>

            {historicalStep !== "configure" && historicalPreview && (
              <div className="space-y-5">
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="rounded-xl border border-[#00E096]/30 bg-[#00E096]/[0.06] p-3">
                    <p className="text-[10px] uppercase tracking-widest text-slate-500">Will Create</p>
                    <p className="mt-1 font-heading text-2xl font-semibold text-white">{num(historicalPreview.totalRuns)}</p>
                    <p className="mt-0.5 text-[10px] text-slate-500">{historicalPreview.periods.length} month(s) · {historicalPreview.staffCount} staff</p>
                  </div>
                  <div className="rounded-xl border border-[#6C63FF]/30 bg-[#6C63FF]/[0.06] p-3">
                    <p className="text-[10px] uppercase tracking-widest text-slate-500">Total Amount</p>
                    <p className="mt-1 font-heading text-2xl font-semibold text-white">{money2(historicalPreview.newAmount)}</p>
                    <p className="mt-0.5 text-[10px] text-slate-500">Deducted from money kept</p>
                  </div>
                  <div className="rounded-xl border border-[#FFB547]/30 bg-[#FFB547]/[0.06] p-3">
                    <p className="text-[10px] uppercase tracking-widest text-slate-500">Skipped</p>
                    <p className="mt-1 font-heading text-2xl font-semibold text-white">{num(historicalPreview.totalSkipped)}</p>
                    <p className="mt-0.5 text-[10px] text-slate-500">Already recorded</p>
                  </div>
                </div>

                <div className="max-h-72 overflow-y-auto rounded-xl border border-white/5">
                  <table className="w-full text-left text-xs">
                    <thead className="sticky top-0 bg-[#0A1628]">
                      <tr className="border-b border-white/10 text-[10px] uppercase tracking-widest text-slate-500">
                        <th className="py-2 px-3">Employee</th>
                        <th className="py-2 px-3">Period</th>
                        <th className="py-2 px-3 text-right">Amount</th>
                        <th className="py-2 px-3 text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {historicalPreview.items.map((it, i) => (
                        <tr key={i} className={`border-b border-white/5 ${it.existing ? "opacity-45" : ""}`}>
                          <td className="py-2 px-3 text-white">
                            {it.staffName}
                            <span className="ml-1 text-slate-500">{it.department ? `· ${it.department}` : ""}</span>
                          </td>
                          <td className="py-2 px-3 text-slate-400">{it.period}</td>
                          <td className="py-2 px-3 text-right tabular-nums text-white">{money2(it.payCalc.total_pay)}</td>
                          <td className="py-2 px-3 text-right">
                            {it.existing
                              ? <span className="text-[#FFB547]">Skip</span>
                              : <span className="text-[#00E096]">Create</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="flex justify-end gap-3 pt-4 border-t border-white/10">
                  <Button variant="secondary" onClick={handleBackToConfigure} disabled={running}>
                    <ArrowLeft /> Back
                  </Button>
                  <Button
                    variant="primary"
                    onClick={handlePostHistorical}
                    disabled={running || historicalPreview.totalRuns === 0}
                  >
                    {running
                      ? <><Loader2 className="animate-spin" /> Posting…</>
                      : <><Save /> Post {historicalPreview.totalRuns} Run(s)</>}
                  </Button>
                </div>
              </div>
            )}

            {historicalStep === "configure" && (
            <div className="space-y-5">
              {/* Mode Selection */}
              <div className="space-y-3">
                <label className="block text-xs font-medium text-slate-400">Data Source</label>
                <div className="flex items-center gap-4">
                  {/* Kept as native radios, NOT converted to a SegmentedControl.
                      A segmented control fires onChange only when the clicked item
                      is not already selected and hands the caller a value, so these
                      two independent no-argument handlers would have to be collapsed
                      into one — a logic change. Native radios also keep the
                      `name`-based grouping and arrow-key roving that
                      SegmentedControl deliberately does not implement. */}
                  <label className="flex items-center gap-2 cursor-pointer">
                    <Input
                      type="radio"
                      name="hist-source"
                      checked={historicalForm.useStaffDirectory}
                      onChange={() => setHistoricalForm(f => ({ ...f, useStaffDirectory: true }))}
                    />
                    <span className="text-sm text-white">Use Staff Directory (recommended)</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <Input
                      type="radio"
                      name="hist-source"
                      checked={!historicalForm.useStaffDirectory}
                      onChange={() => setHistoricalForm(f => ({ ...f, useStaffDirectory: false }))}
                    />
                    <span className="text-sm text-white">Custom Entries</span>
                  </label>
                </div>
                <p className="text-xs text-slate-500">
                  {historicalForm.useStaffDirectory
                    ? "Creates payroll runs for all active staff from the Staff Directory for each month in range."
                    : "Manually add individual staff entries for the period."}
                </p>
              </div>

              {/* Date Range */}
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-400">From Month</label>
                  <div className="flex items-center gap-2">
                    <Select
                      value={historicalForm.fromMonth}
                      onChange={(e) => setHistoricalForm(f => ({ ...f, fromMonth: Number(e.target.value) }))}
                      wrapperClassName="flex-1"
                    >
                      {MONTHS.map((m, i) => <option key={i} value={i}>{m}</option>)}
                    </Select>
                    <Input
                      type="number"
                      min="2020"
                      max="2030"
                      value={historicalForm.fromYear}
                      onChange={(e) => setHistoricalForm(f => ({ ...f, fromYear: Number(e.target.value) }))}
                      className="w-24"
                    />
                  </div>
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-400">To Month</label>
                  <div className="flex items-center gap-2">
                    <Select
                      value={historicalForm.toMonth}
                      onChange={(e) => setHistoricalForm(f => ({ ...f, toMonth: Number(e.target.value) }))}
                      wrapperClassName="flex-1"
                    >
                      {MONTHS.map((m, i) => <option key={i} value={i}>{m}</option>)}
                    </Select>
                    <Input
                      type="number"
                      min="2020"
                      max="2030"
                      value={historicalForm.toYear}
                      onChange={(e) => setHistoricalForm(f => ({ ...f, toYear: Number(e.target.value) }))}
                      className="w-24"
                    />
                  </div>
                </div>
              </div>

              {/* Status */}
              <div>
                <label className="mb-1.5 block text-xs font-medium text-slate-400">Status for Created Runs</label>
                <Select
                  value={historicalForm.status}
                  onChange={(e) => setHistoricalForm(f => ({ ...f, status: e.target.value }))}
                >
                  <option value="paid">Paid</option>
                  <option value="approved">Approved</option>
                  <option value="pending_review">Pending Review</option>
                  <option value="draft">Draft</option>
                </Select>
                <p className="mt-1 text-xs text-slate-500">Historical payments should typically be "Paid".</p>
              </div>

              {/* Staff Preview / Custom Entries */}
              {historicalForm.useStaffDirectory ? (
                <div className="rounded-xl border border-white/5 bg-[#0A1628]/60 p-4 max-h-60 overflow-y-auto">
                  <p className="mb-3 text-xs font-medium text-slate-400">
                    Will create runs for {activeStaff.length} active staff member(s) per month:
                  </p>
                  <ul className="space-y-1 text-sm">
                    {activeStaff.slice(0, 10).map((s) => (
                      <li key={s.id} className="flex items-center justify-between text-white">
                        <span>{s.employee_name} ({s.department || "—"})</span>
                        <span className="text-slate-400">
                          {s.pay_type === "salary" ? money2(s.base_rate) + "/mo" : money2(s.base_rate) + "/hr"}
                        </span>
                      </li>
                    ))}
                    {activeStaff.length > 10 && (
                      <li className="text-xs text-slate-500">+ {activeStaff.length - 10} more...</li>
                    )}
                  </ul>
                  {!activeStaff.length && (
                    <p className="text-center text-slate-500 py-4">No active staff. Add staff in the Staff Directory first.</p>
                  )}
                </div>
              ) : (
                <div className="space-y-3">
                  <p className="text-xs font-medium text-slate-400">Custom Entries (add one per staff member)</p>
                  {historicalForm.customEntries.map((entry, idx) => (
                    <div key={idx} className="grid gap-2 sm:grid-cols-4">
                      <Input
                        placeholder="Name"
                        value={entry.employee_name}
                        onChange={(e) => setHistoricalForm(f => ({
                          ...f,
                          customEntries: f.customEntries.map((en, i) => i === idx ? { ...en, employee_name: e.target.value } : en)
                        }))}
                      />
                      <Input
                        placeholder="Department"
                        value={entry.department}
                        onChange={(e) => setHistoricalForm(f => ({
                          ...f,
                          customEntries: f.customEntries.map((en, i) => i === idx ? { ...en, department: e.target.value } : en)
                        }))}
                      />
                      <Select
                        value={entry.pay_type}
                        onChange={(e) => setHistoricalForm(f => ({
                          ...f,
                          customEntries: f.customEntries.map((en, i) => i === idx ? { ...en, pay_type: e.target.value } : en)
                        }))}
                      >
                        <option value="hourly">Hourly</option>
                        <option value="salary">Salary</option>
                      </Select>
                      <Input
                        type="number"
                        placeholder="Rate"
                        value={entry.base_rate}
                        onChange={(e) => setHistoricalForm(f => ({
                          ...f,
                          customEntries: f.customEntries.map((en, i) => i === idx ? { ...en, base_rate: e.target.value } : en)
                        }))}
                      />
                    </div>
                  ))}
                  {/* `link`, with the box collapsed: these are inline text
                      affordances in a stack, not chrome, so the size's h-9/px-4
                      would give them a button footprint they never had. */}
                  <Button
                    variant="link"
                    size="sm"
                    className="h-auto px-0"
                    onClick={() => setHistoricalForm(f => ({
                      ...f,
                      customEntries: [...f.customEntries, { employee_name: "", department: "", pay_type: "hourly", base_rate: "", hours: "40", overtime_hours: "0", overtime_rate: "", bonus: "0", deductions: "0" }]
                    }))}
                  >
                    + Add Another Staff Entry
                  </Button>
                  {!historicalForm.customEntries.length && (
                    <Button
                      variant="link"
                      size="sm"
                      className="h-auto px-0"
                      onClick={() => setHistoricalForm(f => ({
                        ...f,
                        customEntries: [{ employee_name: "", department: "", pay_type: "hourly", base_rate: "", hours: "40", overtime_hours: "0", overtime_rate: "", bonus: "0", deductions: "0" }]
                      }))}
                    >
                      Add First Staff Entry
                    </Button>
                  )}
                </div>
              )}

              {/* Summary */}
              <div className="rounded-xl border border-[#6C63FF]/30 bg-[#6C63FF]/[0.06] p-4">
                <p className="text-xs font-medium text-[#6C63FF]">Summary</p>
                <p className="mt-1 text-sm text-white">
                  Will create payroll runs for <strong>{num(historicalSourceCount)}</strong> staff member(s) ×{" "}
                  <strong>{num(historicalMonthCount)}</strong> month(s) ={" "}
                  <strong>{num(historicalPlannedRuns)}</strong> run(s).
                </p>
                <p className="mt-1 text-xs text-slate-500">Existing runs for the same staff + period will be skipped.</p>
              </div>

              {/* Actions — configure step reviews first, it never posts blind */}
              <div className="flex justify-end gap-3 pt-4 border-t border-white/10">
                <Button variant="secondary" onClick={closeHistorical}>
                  Cancel
                </Button>
                {/* C-017 site: white on indigo at 4.32:1. `primary` — Review is
                    the step's forward action and Cancel is the only rival. */}
                <Button
                  variant="primary"
                  onClick={handlePreviewHistorical}
                  disabled={running || !historicalReady}
                >
                  <Target />
                  Review {historicalPlannedRuns > 0 ? `${historicalPlannedRuns} Run(s)` : "Payroll"}
                </Button>
                </div>
              </div>
            )}
            </div>
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        </DialogPrimitive.Root>
      )}
    </div>
  );
}