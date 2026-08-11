import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { db, runInTransaction } from '@/api/base44Client';
import React, { useState } from "react";
import { Plus, Trash2, DollarSign, CheckCircle2, X, Save, Zap, CalendarClock, Power, UserPlus, Target, TrendingUp, History, Loader2, ArrowLeft, Wallet } from "lucide-react";
import Card from "@/components/ui-exec/Card";
import KpiCard from "@/components/ui-exec/KpiCard";
import StatusBadge from "@/components/ui-exec/StatusBadge";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useGlobalFilters } from "@/lib/useGlobalFilters";
import { money, num, pct, C, PROPERTY } from "@/lib/hotel";
import { nextEmployeeId } from "@/lib/employeeId";
import { sfx } from "@/lib/sound";
import { calculatePay, buildPayrollRunRecord, generateMonthPeriods, nextPayrollDate, previousMonth, monthPeriod, normalizeMonth, sumCommittedPay, MONTHS, iso, lastDayOf, monthLabel, } from "@/lib/payrollCalc";
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
            if (from && to)
                filter.date = { $gte: from, $lte: to };
            if (propertyId && propertyId !== "all") {
                if (Array.isArray(propertyId)) {
                    if (propertyId.length > 0)
                        filter.property_id = { $in: propertyId };
                }
                else {
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
    const { data: payroll = [] } = usePayroll(property);
    const { data: staff = [] } = useStaff();
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
        if (!id || id === "all")
            return null;
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
        if (running)
            return;
        setRunning(true);
        setEngineMsg(null);
        try {
            const res = await db.functions.invoke("autoPayroll", { force: true });
            const data = res?.data || res || {};
            setEngineMsg(data);
            if (data.status === "ok")
                sfx.success();
            else
                sfx.pop();
            qc.invalidateQueries({ queryKey: ["payroll"] });
        }
        catch (e) {
            console.error("[autoPayroll]", e);
            setEngineMsg({ status: "failed", message: e.message || "Engine failed to run." });
            sfx.error();
        }
        setRunning(false);
    };
    // ─── Manual payroll run (single entry) ───
    const handleAdd = async () => {
        if (!form.employee_name || !form.base_rate)
            return;
        const payCalc = calculatePay({
            pay_type: form.pay_type,
            base_rate: form.base_rate,
            hours: form.hours,
            overtime_hours: form.overtime_hours,
            overtime_rate: form.overtime_rate,
            bonus: form.bonus,
            deductions: form.deductions,
        });
        const p = propFor();
        await db.entities.PayrollRun.create({
            ...form,
            ...payCalc,
            payroll_status: "draft",
            property_id: property !== "all" ? property : "",
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
        if (!name)
            return null;
        return payroll.find((p) => String(p.employee_name || "").trim().toLowerCase() === name &&
            p.pay_period_end === quickPeriod.periodEnd) || null;
    })();
    const handleQuickAdd = async () => {
        if (running)
            return;
        const name = quickForm.employee_name.trim();
        const amount = Number(quickForm.amount);
        if (!name) {
            setQuickErr("Enter the employee's name.");
            return;
        }
        if (!(amount > 0)) {
            setQuickErr("Enter an amount greater than zero.");
            return;
        }
        if (quickDuplicate) {
            setQuickErr(`${name} already has a payroll run for ${quickPeriod.label}. Delete it first if you want to replace it.`);
            return;
        }
        setRunning(true);
        setQuickErr(null);
        try {
            const p = propFor();
            const propertyId = property !== "all" ? (Array.isArray(property) ? property[0] : property) : "";
            const propertyName = p?.name || "";
            // Match against the staff directory so the run carries the same
            // employee_id the engine would use — that is what makes the historical
            // poster's duplicate check see this run later.
            const existingStaff = activeStaff.find((s) => String(s.employee_name || "").trim().toLowerCase() === name.toLowerCase());
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
                    employee_id: nextEmployeeId(name, staff),
                    property_id: propertyId,
                    property_name: propertyName,
                });
                qc.invalidateQueries({ queryKey: ["staff"] });
            }
            try {
                await db.audit.log({
                    username: "system",
                    action: "Payroll Quick Add",
                    detail: `${name} — ${money(amount)} for ${quickPeriod.label} (${quickForm.status}).`,
                });
            }
            catch (e) {
                console.error("[audit] quick payroll:", e);
            }
            invalidateMoney();
            setEngineMsg({ status: "ok", message: `Recorded ${money(amount)} for ${name} — ${quickPeriod.label}.` });
            setQuickForm((f) => ({ ...f, employee_name: "", department: "", amount: "", saveToStaff: false }));
            setShowQuickAdd(false);
            sfx.success();
        }
        catch (e) {
            console.error("[quickPayroll]", e);
            setQuickErr(e.message || "Could not save the payroll entry.");
            sfx.error();
        }
        finally {
            setRunning(false);
        }
    };
    // ─── Staff directory (input for the automated engine) ───
    const handleAddStaff = async () => {
        if (!staffForm.employee_name || !staffForm.base_rate)
            return;
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
            employee_id: nextEmployeeId(staffForm.employee_name, staff),
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
                }
                else {
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
    const historicalCustomValid = historicalForm.customEntries.filter((e) => e.employee_name && Number(e.base_rate) > 0);
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
        if (running)
            return;
        if (!historicalPreview) {
            handlePreviewHistorical();
            return;
        }
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
                    if (existing) {
                        skipped++;
                        continue;
                    }
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
                const postedTotal = recordsToCreate.reduce((a, r) => a + (Number(r.total_pay) || 0), 0);
                try {
                    await db.audit.log({
                        username: "system",
                        action: "Historical Payroll Posted",
                        detail: `Posted ${created} historical payroll run(s) for ${staffSource.length} staff over ${periods.length} month(s). Total: ${money(postedTotal)}. Skipped ${skipped} existing.`,
                    });
                }
                catch (e) {
                    console.error("[audit] historical payroll:", e);
                }
            }
            invalidateMoney();
            setShowHistoricalForm(false);
            setHistoricalPreview(null);
            setHistoricalStep("configure");
            setEngineMsg({ status: "ok", message: `Historical payroll posted: ${created} run(s) created, ${skipped} skipped (already exist).` });
            sfx.success();
        }
        catch (e) {
            console.error("[postHistorical]", e);
            setEngineMsg({ status: "failed", message: e.message || "Failed to post historical payroll." });
            sfx.error();
        }
        finally {
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
    const handleDelete = async (id) => {
        await db.entities.PayrollRun.delete(id);
        sfx.pop();
        invalidateMoney();
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
        const rev = occRows.reduce((a, r) => a + (r.total_revenue || 0), 0);
        const sold = occRows.reduce((a, r) => a + (r.rooms_sold || 0), 0);
        return sold > 0 ? rev / sold : 0;
    })();
    const adr = Number(adrOverride) || estAdr || 0;
    // Monthly payroll row source: prefer the real (logged) runs when the month is
    // already in the books; otherwise model every active staff member's pay.
    function payrollForMonth(periodEnd) {
        const actual = payroll.filter((p) => p.pay_period_end === periodEnd);
        if (actual.length) {
            return {
                source: "Actual",
                count: actual.length,
                regular: actual.reduce((a, p) => a + (p.regular_pay || 0), 0),
                overtime: actual.reduce((a, p) => a + (p.overtime_pay || 0), 0),
                bonus: actual.reduce((a, p) => a + (p.bonus || 0), 0),
                deductions: actual.reduce((a, p) => a + (p.deductions || 0), 0),
                total: actual.reduce((a, p) => a + (p.total_pay || 0), 0),
            };
        }
        let count = 0, regular = 0, overtime = 0, bonus = 0, deductions = 0;
        for (const s of activeStaff) {
            if (!s.employee_name || !(Number(s.base_rate) > 0))
                continue;
            const baseRate = Number(s.base_rate) || 0;
            const hours = Number(s.hours) || 0;
            const otH = Number(s.overtime_hours) || 0;
            const otR = Number(s.overtime_rate) || baseRate * 1.5;
            const bns = Number(s.bonus) || 0;
            const ded = Number(s.deductions) || 0;
            const reg = s.pay_type === "salary" ? baseRate : baseRate * hours;
            regular += reg;
            overtime += otH * otR;
            bonus += bns;
            deductions += ded;
            count++;
        }
        return { source: "Projected", count, regular, overtime, bonus, deductions, total: regular + overtime + bonus - deductions };
    }
    const handleRunProjection = () => {
        if (running)
            return;
        if (!projectFrom || !projectTo) {
            setProjection(null);
            return;
        }
        if (projectTo < projectFrom) {
            setProjection({ error: "End date must be after the start date." });
            return;
        }
        const rooms = totalRooms();
        if (!(rooms > 0)) {
            setProjection({ error: "No room count found for the selected property." });
            return;
        }
        if (!(adr > 0)) {
            setProjection({ error: "No ADR available. Enter a daily rate to compute break-even." });
            return;
        }
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
            if (m === 11) {
                m = 0;
                y++;
            }
            else {
                m++;
            }
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
            breakEvenOcc: totalPay7 > 0 ? (totalPay7 / (months && rooms * 30.44 * adr)) * 100 : 0,
        });
        sfx.success();
    };
    // ─── KPIs ───
    const totalPay = payroll.reduce((a, p) => a + (p.total_pay || 0), 0);
    // What the dashboard actually deducts: approved + paid only. Showing it next
    // to the gross total is what tells the owner why the two figures differ.
    const committedPay = sumCommittedPay(payroll);
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
    return (_jsxs("div", { className: "space-y-6", children: [_jsxs("header", { children: [_jsx("p", { className: "text-[11px] uppercase tracking-[0.3em] text-[#00E096]", children: "Operations \u00B7 Automated" }), _jsx("h1", { className: "mt-2 font-heading text-3xl font-semibold text-white", children: "Payroll Management" }), _jsx("p", { className: "mt-1 text-sm text-slate-400", children: "Payroll is executed automatically on the final day of every month for all active staff." })] }), _jsxs("div", { className: "grid gap-4 sm:grid-cols-2 xl:grid-cols-4", children: [_jsx(KpiCard, { label: "Total Payroll", value: money(totalPay), sub: `${payroll.length} runs · OT ${money(totalOT)}`, accent: C.green, icon: DollarSign }), _jsx(KpiCard, { label: "Deducted From Cash", value: money(committedPay), sub: draftCount ? `${draftCount} draft not counted` : "All runs counted", accent: C.cyan, icon: Wallet }), _jsx(KpiCard, { label: "Approved", value: num(approvedCount), sub: `${paidCount} paid · ${draftCount} draft`, accent: C.amber, icon: CheckCircle2 }), _jsx(KpiCard, { label: "Deductions", value: money(totalDeductions), sub: `Bonus: ${money(totalBonus)}`, accent: C.coral, icon: DollarSign })] }), _jsxs("div", { className: "relative overflow-hidden rounded-2xl border border-[#00E096]/30 bg-[#0F1F35]/80 p-5", style: { boxShadow: "0 0 34px rgba(0,224,150,0.18), inset 0 0 40px rgba(0,224,150,0.04)" }, children: [_jsx("div", { className: "absolute inset-x-0 top-0 h-[2px]", style: { background: "linear-gradient(90deg, transparent, #00E096, transparent)" } }), _jsxs("div", { className: "flex flex-wrap items-center justify-between gap-4", children: [_jsxs("div", { className: "flex items-center gap-3", children: [_jsx("span", { className: "flex h-11 w-11 items-center justify-center rounded-xl border border-[#00E096]/40 bg-[#00E096]/10 text-[#00E096]", children: _jsx(Zap, { className: "h-5 w-5" }) }), _jsxs("div", { children: [_jsx("h3", { className: "font-heading text-sm font-semibold tracking-wide text-white", children: "Automated Payroll Engine" }), _jsxs("p", { className: "mt-0.5 text-xs text-slate-400", children: ["Cron ", _jsx("code", { className: "rounded bg-black/40 px-1.5 py-0.5 font-mono text-[10px] text-[#00E096]", children: "0 9 28-31 * *" }), " \u00B7 runs on the last calendar day, so 28, 29, 30 and 31-day months are all handled."] })] })] }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsx(StatusBadge, { status: activeStaff.length ? "active" : "inactive", size: "sm" }), _jsxs("button", { onClick: () => { setQuickErr(null); setShowQuickAdd(true); }, disabled: running, className: "fx-clickable flex items-center gap-2 rounded-lg border border-[#00E096]/40 bg-[#00E096]/10 px-4 py-2 text-sm font-semibold text-[#00E096] transition-colors hover:bg-[#00E096]/20 disabled:opacity-50", children: [_jsx(Wallet, { className: "h-4 w-4" }), " Quick Add"] }), _jsxs("button", { onClick: () => { setHistoricalStep("configure"); setHistoricalPreview(null); setShowHistoricalForm(true); }, disabled: running, className: "fx-clickable flex items-center gap-2 rounded-lg bg-[#6C63FF] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#5b52e8] disabled:opacity-50", children: [_jsx(History, { className: "h-4 w-4" }), " Post Historical"] }), _jsxs("button", { onClick: handleRunEngine, disabled: running, className: "fx-clickable flex items-center gap-2 rounded-lg bg-[#00E096] px-4 py-2 text-sm font-semibold text-[#04251A] transition-all hover:bg-[#4FE3C1] disabled:opacity-50", children: [_jsx(Zap, { className: `h-4 w-4 ${running ? "animate-pulse" : ""}` }), running ? "Running…" : "Run Payroll Now"] })] })] }), _jsxs("div", { className: "mt-4 grid gap-3 sm:grid-cols-3", children: [_jsxs("div", { className: "rounded-xl border border-white/5 bg-[#0A1628]/60 p-3", children: [_jsx("p", { className: "text-[10px] uppercase tracking-widest text-slate-500", children: "Next Auto Run" }), _jsxs("p", { className: "mt-1 flex items-center gap-1.5 text-sm font-medium text-white", children: [_jsx(CalendarClock, { className: "h-3.5 w-3.5 text-[#00E096]" }), nextPayrollDate()] }), _jsx("p", { className: "mt-0.5 text-[10px] text-slate-500", children: "Final day of current month (auto-detected)" })] }), _jsxs("div", { className: "rounded-xl border border-white/5 bg-[#0A1628]/60 p-3", children: [_jsx("p", { className: "text-[10px] uppercase tracking-widest text-slate-500", children: "Active Staff" }), _jsxs("p", { className: "mt-1 text-sm font-medium text-white", children: [num(activeStaff.length), " ", _jsxs("span", { className: "text-slate-500", children: ["of ", num(staff.length)] })] }), _jsx("p", { className: "mt-0.5 text-[10px] text-slate-500", children: "Processed each month-end \u2192 status Approved" })] }), _jsxs("div", { className: "rounded-xl border border-white/5 bg-[#0A1628]/60 p-3", children: [_jsx("p", { className: "text-[10px] uppercase tracking-widest text-slate-500", children: "Last Processed Period" }), _jsx("p", { className: "mt-1 text-sm font-medium text-white", children: lastRun || "—" }), _jsx("p", { className: "mt-0.5 text-[10px] text-slate-500", children: "Idempotent \u2014 no double runs per period" })] })] }), engineMsg && (_jsxs("div", { className: `mt-4 rounded-xl border p-3 text-sm ${engineMsg.status === "failed"
                            ? "border-[#FF6B6B]/30 bg-[#FF6B6B]/[0.08] text-[#FF6B6B]"
                            : engineMsg.status === "skipped"
                                ? "border-[#FFB547]/20 bg-[#FFB547]/[0.06] text-[#FFB547]"
                                : "border-[#00E096]/30 bg-[#00E096]/[0.06] text-[#00E096]"}`, children: [_jsx("p", { className: "font-medium", children: engineMsg.status === "failed" ? "⛔ Engine failed" : engineMsg.status === "skipped" ? "⏳ Payroll skipped" : "✅ Payroll executed" }), _jsx("p", { className: "mt-1 text-xs opacity-90", children: engineMsg.message || engineMsg.error }), engineMsg.createdCount !== undefined && (_jsxs("p", { className: "mt-1 text-xs opacity-80", children: [engineMsg.createdCount, " run(s) created \u00B7 ", engineMsg.skippedCount, " skipped \u00B7 Period ", engineMsg.periodStart, " \u2192 ", engineMsg.periodEnd] }))] }))] }), _jsxs(Card, { title: "Payroll Projection & Break-Even", subtitle: "Run payroll across a date range \u2014 past months use logged runs, the current month and future months are forecast from your active staff \u2014 then compare the cost against revenue at your occupancy target.", right: _jsxs("button", { onClick: handleRunProjection, disabled: running, className: "fx-clickable flex items-center gap-1.5 rounded-lg bg-[#00D4FF] px-3 py-1.5 text-xs font-semibold text-[#04251A] hover:bg-[#5BE3FF] disabled:opacity-50", children: [_jsx(Target, { className: "h-3.5 w-3.5" }), " Run Projection"] }), children: [_jsxs("div", { className: "grid gap-3 sm:grid-cols-2 lg:grid-cols-4", children: [_jsxs("div", { children: [_jsx("label", { className: "mb-1.5 block text-xs font-medium text-slate-400", children: "From (period start)" }), _jsx("input", { type: "date", value: projectFrom, onChange: (e) => setProjectFrom(e.target.value), className: "w-full rounded-lg border border-white/10 bg-[#0A1628] px-3 py-2 text-sm text-slate-200 outline-none focus:border-[#00D4FF]" })] }), _jsxs("div", { children: [_jsx("label", { className: "mb-1.5 block text-xs font-medium text-slate-400", children: "To (period end)" }), _jsx("input", { type: "date", value: projectTo, onChange: (e) => setProjectTo(e.target.value), className: "w-full rounded-lg border border-white/10 bg-[#0A1628] px-3 py-2 text-sm text-slate-200 outline-none focus:border-[#00D4FF]" })] }), _jsxs("div", { children: [_jsx("label", { className: "mb-1.5 block text-xs font-medium text-slate-400", children: "Target occupancy %" }), _jsx("input", { type: "number", min: "0", max: "100", value: occPct, onChange: (e) => setOccPct(Number(e.target.value) || 0), className: "w-full rounded-lg border border-white/10 bg-[#0A1628] px-3 py-2 text-sm text-slate-200 outline-none focus:border-[#00D4FF]" })] }), _jsxs("div", { children: [_jsxs("label", { className: "mb-1.5 block text-xs font-medium text-slate-400", children: ["ADR ($/room) ", !adrOverride && estAdr > 0 ? "(auto)" : ""] }), _jsx("input", { type: "number", min: "0", value: adrOverride, onChange: (e) => setAdrOverride(e.target.value), placeholder: estAdr ? String(Math.round(estAdr * 100) / 100) : "e.g. 120", className: "w-full rounded-lg border border-white/10 bg-[#0A1628] px-3 py-2 text-sm text-slate-200 outline-none focus:border-[#00D4FF]" }), !adrOverride && estAdr > 0 && (_jsxs("p", { className: "mt-1 flex items-center gap-1 text-[10px] text-slate-500", children: [_jsx(TrendingUp, { className: "h-3 w-3" }), " Estimated from ", occRows.length.toLocaleString(), " occupancy days"] }))] })] }), projection?.error && (_jsx("div", { className: "mt-4 rounded-xl border border-[#FF6B6B]/30 bg-[#FF6B6B]/[0.08] p-3 text-sm text-[#FF6B6B]", children: projection.error })), projection?.rows && !projection.error && (_jsxs("div", { className: "mt-5 space-y-4", children: [_jsxs("div", { className: "grid gap-3 sm:grid-cols-2 xl:grid-cols-4", children: [_jsxs("div", { className: "rounded-xl border border-[#00D4FF]/30 bg-[#00D4FF]/[0.06] p-3", children: [_jsxs("p", { className: "text-[10px] uppercase tracking-widest text-slate-500", children: ["Payroll \u2014 ", projection.months, " mo"] }), _jsx("p", { className: "mt-1 font-heading text-2xl font-semibold text-white", children: money(projection.totalPay) }), _jsxs("p", { className: "mt-0.5 text-[10px] text-slate-500", children: [money(projection.avgMonthly), " / month average"] })] }), _jsxs("div", { className: "rounded-xl border border-[#00E096]/30 bg-[#00E096]/[0.06] p-3", children: [_jsxs("p", { className: "text-[10px] uppercase tracking-widest text-slate-500", children: ["Revenue @ ", occPct, "% occ"] }), _jsx("p", { className: "mt-1 font-heading text-2xl font-semibold text-white", children: money(projection.totalRev) }), _jsxs("p", { className: "mt-0.5 text-[10px] text-slate-500", children: [money(projection.avgRevMonthly), " / month \u00B7 ", projection.rooms, " rooms"] })] }), _jsxs("div", { className: "rounded-xl border border-[#FFB547]/30 bg-[#FFB547]/[0.06] p-3", children: [_jsx("p", { className: "text-[10px] uppercase tracking-widest text-slate-500", children: "Payroll % of revenue" }), _jsx("p", { className: "mt-1 font-heading text-2xl font-semibold text-white", children: pct(projection.payrollRatio / 100) }), _jsx("p", { className: "mt-0.5 text-[10px] text-slate-500", children: "Lower is healthier \u00B7 target under 25\u201330%" })] }), _jsxs("div", { className: "rounded-xl border border-white/10 bg-[#0A1628]/60 p-3", children: [_jsx("p", { className: "text-[10px] uppercase tracking-widest text-slate-500", children: "Break-even occupancy" }), _jsx("p", { className: "mt-1 font-heading text-2xl font-semibold text-white", children: pct(projection.breakEvenOcc / 100) }), _jsx("p", { className: "mt-0.5 text-[10px] text-slate-500", children: "Occupancy needed to fully cover payroll" })] })] }), _jsx("div", { className: "overflow-x-auto", children: _jsxs("table", { className: "w-full text-left text-xs", children: [_jsx("thead", { children: _jsxs("tr", { className: "border-b border-white/10 text-[10px] uppercase tracking-widest text-slate-500", children: [_jsx("th", { className: "py-2 pr-3", children: "Month" }), _jsx("th", { className: "py-2 px-3 text-right", children: "Payroll" }), _jsxs("th", { className: "py-2 px-3 text-right", children: ["Rev @ ", occPct, "%"] }), _jsx("th", { className: "py-2 px-3 text-right", children: "Payroll %" }), _jsx("th", { className: "py-2 px-3 text-right", children: "Break-even occ" }), _jsx("th", { className: "py-2 px-3 text-right", children: "Status" })] }) }), _jsx("tbody", { children: projection.rows.map((r, i) => (_jsxs("tr", { className: "border-b border-white/5", children: [_jsx("td", { className: "py-2 pr-3 font-medium text-white", children: r.label }), _jsx("td", { className: "py-2 px-3 text-right tabular-nums text-white", children: money(r.total) }), _jsx("td", { className: "py-2 px-3 text-right tabular-nums text-slate-300", children: money(r.revenueAtOcc) }), _jsx("td", { className: "py-2 px-3 text-right tabular-nums text-[#FFB547]", children: r.revenueAtOcc > 0 ? pct(r.total / r.revenueAtOcc) : "—" }), _jsx("td", { className: "py-2 px-3 text-right tabular-nums text-[#00D4FF]", children: pct(r.breakEvenOcc / 100) }), _jsx("td", { className: "py-2 px-3 text-right", children: _jsx(StatusBadge, { status: r.source === "Actual" ? "paid" : "pending_review", size: "sm" }) })] }, i))) })] }) }), _jsxs("div", { className: "rounded-xl border border-[#00E096]/20 bg-[#00E096]/[0.04] p-3 text-xs text-slate-300", children: [_jsx("p", { className: "font-medium text-[#00E096]", children: "Reading the break-even" }), _jsxs("p", { className: "mt-1", children: ["With ", projection.rooms, " rooms at ", money(projection.adr), "/night you need ", _jsx("span", { className: "font-semibold text-white", children: pct(projection.breakEvenOcc / 100) }), " occupancy for room revenue alone to cover your", money(projection.totalPay), " payroll (", money(projection.avgMonthly), "/mo). At ", occPct, "% occupancy you pull ", money(projection.avgRevMonthly), "/month of room revenue \u2014 your payroll runs ", pct(projection.payrollRatio / 100), " of it."] })] })] }))] }), _jsxs(Card, { title: "Staff Directory", subtitle: `${num(staff.length)} staff · ${num(activeStaff.length)} active — the engine pays active staff every month-end`, right: _jsxs("button", { onClick: () => setShowStaffForm(true), className: "fx-clickable flex items-center gap-1.5 rounded-lg bg-[#00E096] px-3 py-1.5 text-xs font-semibold text-[#04251A] hover:bg-[#4FE3C1]", children: [_jsx(UserPlus, { className: "h-3.5 w-3.5" }), " Add Staff"] }), children: [showStaffForm && (_jsx("div", { className: "fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm", children: _jsxs("div", { className: "w-full max-w-lg rounded-2xl border border-[#00E096]/30 bg-[#151921] p-6 shadow-2xl", style: { boxShadow: "0 0 30px rgba(0,224,150,0.15)" }, children: [_jsxs("div", { className: "mb-5 flex items-center justify-between", children: [_jsx("h2", { className: "font-heading text-lg font-semibold text-white", children: "Add Staff Member" }), _jsx("button", { onClick: () => setShowStaffForm(false), className: "text-slate-400 hover:text-white", children: _jsx(X, { className: "h-5 w-5" }) })] }), _jsxs("div", { className: "grid gap-4 sm:grid-cols-2", children: [_jsxs("div", { children: [_jsx("label", { className: "mb-1.5 block text-xs font-medium text-slate-400", children: "Full Name *" }), _jsx("input", { value: staffForm.employee_name, onChange: (e) => setStaffForm({ ...staffForm, employee_name: e.target.value }), placeholder: "Jane Smith", className: "w-full rounded-lg border border-white/10 bg-[#0b0e14] px-3 py-2.5 text-sm text-white outline-none focus:border-[#00E096]" })] }), _jsxs("div", { children: [_jsx("label", { className: "mb-1.5 block text-xs font-medium text-slate-400", children: "Department" }), _jsx("input", { value: staffForm.department, onChange: (e) => setStaffForm({ ...staffForm, department: e.target.value }), placeholder: "Front Office", className: "w-full rounded-lg border border-white/10 bg-[#0b0e14] px-3 py-2.5 text-sm text-white outline-none focus:border-[#00E096]" })] }), _jsxs("div", { className: "sm:col-span-2", children: [_jsx("label", { className: "mb-1.5 block text-xs font-medium text-slate-400", children: "Pay Type" }), _jsxs("select", { value: staffForm.pay_type, onChange: (e) => setStaffForm({ ...staffForm, pay_type: e.target.value }), className: "w-full rounded-lg border border-white/10 bg-[#0b0e14] px-3 py-2.5 text-sm text-white outline-none focus:border-[#00E096]", children: [_jsx("option", { value: "hourly", children: "Hourly" }), _jsx("option", { value: "salary", children: "Salary" })] })] }), _jsxs("div", { className: "sm:col-span-2", children: [_jsx("label", { className: "mb-1.5 block text-xs font-medium text-slate-400", children: staffForm.pay_type === "salary" ? "Salary Amount ($/month)" : "Hourly Rate ($)" }), _jsx("input", { type: "number", value: staffForm.base_rate, onChange: (e) => setStaffForm({ ...staffForm, base_rate: e.target.value }), placeholder: "0", className: "w-full rounded-lg border border-white/10 bg-[#0b0e14] px-3 py-2.5 text-sm text-white outline-none focus:border-[#00E096]" })] }), staffForm.pay_type === "hourly" && (_jsxs(_Fragment, { children: [_jsxs("div", { children: [_jsx("label", { className: "mb-1.5 block text-xs font-medium text-slate-400", children: "Hours / Month" }), _jsx("input", { type: "number", value: staffForm.hours, onChange: (e) => setStaffForm({ ...staffForm, hours: e.target.value }), placeholder: "160", className: "w-full rounded-lg border border-white/10 bg-[#0b0e14] px-3 py-2.5 text-sm text-white outline-none focus:border-[#00E096]" })] }), _jsxs("div", { children: [_jsx("label", { className: "mb-1.5 block text-xs font-medium text-slate-400", children: "Overtime Hours" }), _jsx("input", { type: "number", value: staffForm.overtime_hours, onChange: (e) => setStaffForm({ ...staffForm, overtime_hours: e.target.value }), placeholder: "0", className: "w-full rounded-lg border border-white/10 bg-[#0b0e14] px-3 py-2.5 text-sm text-white outline-none focus:border-[#00E096]" })] }), _jsxs("div", { children: [_jsx("label", { className: "mb-1.5 block text-xs font-medium text-slate-400", children: "Overtime Rate (blank = 1.5x)" }), _jsx("input", { type: "number", value: staffForm.overtime_rate, onChange: (e) => setStaffForm({ ...staffForm, overtime_rate: e.target.value }), placeholder: "Auto", className: "w-full rounded-lg border border-white/10 bg-[#0b0e14] px-3 py-2.5 text-sm text-white outline-none focus:border-[#00E096]" })] })] })), _jsxs("div", { children: [_jsx("label", { className: "mb-1.5 block text-xs font-medium text-slate-400", children: "Bonus ($)" }), _jsx("input", { type: "number", value: staffForm.bonus, onChange: (e) => setStaffForm({ ...staffForm, bonus: e.target.value }), placeholder: "0", className: "w-full rounded-lg border border-white/10 bg-[#0b0e14] px-3 py-2.5 text-sm text-white outline-none focus:border-[#00E096]" })] }), _jsxs("div", { children: [_jsx("label", { className: "mb-1.5 block text-xs font-medium text-slate-400", children: "Deductions ($)" }), _jsx("input", { type: "number", value: staffForm.deductions, onChange: (e) => setStaffForm({ ...staffForm, deductions: e.target.value }), placeholder: "0", className: "w-full rounded-lg border border-white/10 bg-[#0b0e14] px-3 py-2.5 text-sm text-white outline-none focus:border-[#00E096]" })] })] }), _jsxs("div", { className: "mt-5 flex justify-end gap-3", children: [_jsx("button", { onClick: () => setShowStaffForm(false), className: "rounded-lg border border-white/10 px-4 py-2 text-sm text-slate-300 hover:bg-white/5", children: "Cancel" }), _jsxs("button", { onClick: handleAddStaff, className: "flex items-center gap-1.5 rounded-lg bg-[#00E096] px-4 py-2 text-sm font-semibold text-[#04251A] hover:bg-[#4FE3C1]", children: [_jsx(Save, { className: "h-4 w-4" }), " Save Staff"] })] })] }) })), _jsxs("div", { className: "space-y-2", children: [staff.map((s) => {
                                const isActive = s.active !== false;
                                return (_jsxs("div", { className: "flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/5 bg-[#0A1628]/60 px-4 py-3", children: [_jsx("div", { className: "flex items-center gap-3", children: _jsxs("div", { children: [_jsx("p", { className: "text-sm text-white", children: s.employee_name }), _jsxs("p", { className: "text-xs text-slate-500", children: [s.department || "—", " \u00B7 ", s.pay_type, " \u00B7 ", s.pay_type === "salary" ? money(s.base_rate) + "/mo" : money(s.base_rate) + "/hr"] })] }) }), _jsxs("div", { className: "flex items-center gap-3", children: [_jsx(StatusBadge, { status: isActive ? "active" : "inactive", size: "sm" }), _jsxs("button", { onClick: () => handleToggleStaff(s.id, s.active), className: `flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs transition-colors ${isActive
                                                        ? "border-[#00E096]/40 bg-[#00E096]/10 text-[#00E096] hover:bg-[#00E096]/20"
                                                        : "border-white/10 bg-white/5 text-slate-500 hover:text-slate-300"}`, title: isActive ? "Deactivate (excluded from payroll)" : "Activate (included in payroll)", children: [_jsx(Power, { className: "h-3 w-3" }), " ", isActive ? "Active" : "Inactive"] }), _jsx("button", { onClick: () => handleDeleteStaff(s.id), className: "text-slate-500 hover:text-[#FF6B6B]", children: _jsx(Trash2, { className: "h-4 w-4" }) })] })] }, s.id));
                            }), !staff.length && (_jsxs("div", { className: "py-4 text-center", children: [_jsx("p", { className: "text-sm text-slate-500", children: "No staff yet. Add staff members \u2014 the automated engine pays every active member on month-end." }), _jsxs("button", { onClick: () => setShowStaffForm(true), className: "mt-3 inline-flex items-center gap-1.5 rounded-lg border border-[#00E096]/40 bg-[#00E096]/10 px-3 py-1.5 text-xs font-medium text-[#00E096] hover:bg-[#00E096]/20", children: [_jsx(UserPlus, { className: "h-3.5 w-3.5" }), " Add First Staff Member"] })] }))] })] }), _jsxs(Card, { title: "Payroll Runs", subtitle: `${payroll.length} entries · ${money(totalPay)} total`, right: _jsxs("button", { onClick: () => setShowForm(true), className: "fx-clickable flex items-center gap-1.5 rounded-lg bg-[#6C63FF] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#5b52e8]", children: [_jsx(Plus, { className: "h-3.5 w-3.5" }), " Add Entry"] }), children: [showForm && (_jsx("div", { className: "fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm", children: _jsxs("div", { className: "w-full max-w-lg rounded-2xl border border-white/10 bg-[#151921] p-6 shadow-2xl", children: [_jsxs("div", { className: "mb-5 flex items-center justify-between", children: [_jsx("h2", { className: "font-heading text-lg font-semibold text-white", children: "Add Payroll Entry" }), _jsx("button", { onClick: () => setShowForm(false), className: "text-slate-400 hover:text-white", children: _jsx(X, { className: "h-5 w-5" }) })] }), _jsxs("div", { className: "grid gap-4 sm:grid-cols-2", children: [_jsxs("div", { children: [_jsx("label", { className: "mb-1.5 block text-xs font-medium text-slate-400", children: "Name *" }), _jsx("input", { value: form.employee_name, onChange: (e) => setForm({ ...form, employee_name: e.target.value }), placeholder: "John Doe", className: "w-full rounded-lg border border-white/10 bg-[#0b0e14] px-3 py-2.5 text-sm text-white outline-none focus:border-[#6C63FF]" })] }), _jsxs("div", { children: [_jsx("label", { className: "mb-1.5 block text-xs font-medium text-slate-400", children: "Department" }), _jsx("input", { value: form.department, onChange: (e) => setForm({ ...form, department: e.target.value }), placeholder: "Front Office", className: "w-full rounded-lg border border-white/10 bg-[#0b0e14] px-3 py-2.5 text-sm text-white outline-none focus:border-[#6C63FF]" })] }), _jsxs("div", { className: "sm:col-span-2", children: [_jsx("label", { className: "mb-1.5 block text-xs font-medium text-slate-400", children: "Pay Type" }), _jsxs("select", { value: form.pay_type, onChange: (e) => setForm({ ...form, pay_type: e.target.value }), className: "w-full rounded-lg border border-white/10 bg-[#0b0e14] px-3 py-2.5 text-sm text-white outline-none focus:border-[#6C63FF]", children: [_jsx("option", { value: "hourly", children: "Hourly" }), _jsx("option", { value: "salary", children: "Salary" })] })] }), _jsxs("div", { className: "sm:col-span-2", children: [_jsx("label", { className: "mb-1.5 block text-xs font-medium text-slate-400", children: form.pay_type === "salary" ? "Salary Amount ($)" : "Hourly Rate ($)" }), _jsx("input", { type: "number", value: form.base_rate, onChange: (e) => setForm({ ...form, base_rate: e.target.value }), placeholder: "0", className: "w-full rounded-lg border border-white/10 bg-[#0b0e14] px-3 py-2.5 text-sm text-white outline-none focus:border-[#6C63FF]" })] }), form.pay_type === "hourly" && (_jsxs(_Fragment, { children: [_jsxs("div", { children: [_jsx("label", { className: "mb-1.5 block text-xs font-medium text-slate-400", children: "Regular Hours" }), _jsx("input", { type: "number", value: form.hours, onChange: (e) => setForm({ ...form, hours: e.target.value }), placeholder: "40", className: "w-full rounded-lg border border-white/10 bg-[#0b0e14] px-3 py-2.5 text-sm text-white outline-none focus:border-[#6C63FF]" })] }), _jsxs("div", { children: [_jsx("label", { className: "mb-1.5 block text-xs font-medium text-slate-400", children: "Overtime Hours" }), _jsx("input", { type: "number", value: form.overtime_hours, onChange: (e) => setForm({ ...form, overtime_hours: e.target.value }), placeholder: "0", className: "w-full rounded-lg border border-white/10 bg-[#0b0e14] px-3 py-2.5 text-sm text-white outline-none focus:border-[#6C63FF]" })] }), _jsxs("div", { children: [_jsx("label", { className: "mb-1.5 block text-xs font-medium text-slate-400", children: "Overtime Rate (blank = 1.5x)" }), _jsx("input", { type: "number", value: form.overtime_rate, onChange: (e) => setForm({ ...form, overtime_rate: e.target.value }), placeholder: "Auto", className: "w-full rounded-lg border border-white/10 bg-[#0b0e14] px-3 py-2.5 text-sm text-white outline-none focus:border-[#6C63FF]" })] })] })), _jsxs("div", { children: [_jsx("label", { className: "mb-1.5 block text-xs font-medium text-slate-400", children: "Bonus ($)" }), _jsx("input", { type: "number", value: form.bonus, onChange: (e) => setForm({ ...form, bonus: e.target.value }), placeholder: "0", className: "w-full rounded-lg border border-white/10 bg-[#0b0e14] px-3 py-2.5 text-sm text-white outline-none focus:border-[#6C63FF]" })] }), _jsxs("div", { children: [_jsx("label", { className: "mb-1.5 block text-xs font-medium text-slate-400", children: "Deductions ($)" }), _jsx("input", { type: "number", value: form.deductions, onChange: (e) => setForm({ ...form, deductions: e.target.value }), placeholder: "0", className: "w-full rounded-lg border border-white/10 bg-[#0b0e14] px-3 py-2.5 text-sm text-white outline-none focus:border-[#6C63FF]" })] }), _jsxs("div", { children: [_jsx("label", { className: "mb-1.5 block text-xs font-medium text-slate-400", children: "Pay Period Start" }), _jsx("input", { type: "date", value: form.pay_period_start, onChange: (e) => setForm({ ...form, pay_period_start: e.target.value }), className: "w-full rounded-lg border border-white/10 bg-[#0b0e14] px-3 py-2.5 text-sm text-white outline-none focus:border-[#6C63FF]" })] }), _jsxs("div", { children: [_jsx("label", { className: "mb-1.5 block text-xs font-medium text-slate-400", children: "Pay Period End" }), _jsx("input", { type: "date", value: form.pay_period_end, onChange: (e) => setForm({ ...form, pay_period_end: e.target.value }), className: "w-full rounded-lg border border-white/10 bg-[#0b0e14] px-3 py-2.5 text-sm text-white outline-none focus:border-[#6C63FF]" })] })] }), _jsxs("div", { className: "mt-5 flex justify-end gap-3", children: [_jsx("button", { onClick: () => setShowForm(false), className: "rounded-lg border border-white/10 px-4 py-2 text-sm text-slate-300 hover:bg-white/5", children: "Cancel" }), _jsxs("button", { onClick: handleAdd, className: "flex items-center gap-1.5 rounded-lg bg-[#6C63FF] px-4 py-2 text-sm font-medium text-white hover:bg-[#5b52e8]", children: [_jsx(Save, { className: "h-4 w-4" }), " Save Entry"] })] })] }) })), _jsxs("div", { className: "space-y-2", children: [payroll.map((p) => (_jsxs("div", { className: "flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/5 bg-[#0A1628]/60 px-4 py-3", children: [_jsxs("div", { className: "flex items-center gap-3", children: [_jsx(StatusBadge, { status: p.payroll_status || "draft", size: "sm" }), _jsxs("div", { children: [_jsx("p", { className: "text-sm text-white", children: p.employee_name }), _jsxs("p", { className: "text-xs text-slate-500", children: [p.department || "—", " \u00B7 ", p.pay_type, " \u00B7 ", p.pay_period_start || "—", " to ", p.pay_period_end || "—", p.auto_generated && _jsx("span", { className: "ml-1 text-[#00E096]", children: "\u00B7 \u2699 auto" })] })] })] }), _jsxs("div", { className: "flex items-center gap-4", children: [_jsxs("div", { className: "text-right", children: [_jsxs("p", { className: "text-xs text-slate-500", children: ["Reg ", money(p.regular_pay || 0), " \u00B7 OT ", money(p.overtime_pay || 0)] }), _jsx("p", { className: "text-sm font-heading text-white", children: money(p.total_pay || 0) })] }), _jsxs("select", { value: p.payroll_status || "draft", onChange: (e) => handleStatusChange(p.id, e.target.value), className: `rounded-lg border border-white/10 bg-[#040D1A] px-2 py-1 text-xs ${statusColor(p.payroll_status)}`, children: [_jsx("option", { value: "draft", children: "Draft" }), _jsx("option", { value: "pending_review", children: "Pending Review" }), _jsx("option", { value: "approved", children: "Approved" }), _jsx("option", { value: "paid", children: "Paid" })] }), _jsx("button", { onClick: () => handleDelete(p.id), className: "text-slate-500 hover:text-[#FF6B6B]", children: _jsx(Trash2, { className: "h-4 w-4" }) })] })] }, p.id))), !payroll.length && (_jsxs("div", { className: "py-4 text-center", children: [_jsx("p", { className: "text-sm text-slate-500", children: "No payroll runs yet. Add staff above and hit \u201CRun Payroll Now\u201D, or add an entry manually." }), _jsx("p", { className: "mt-1 text-xs text-slate-600", children: "Engine-generated runs are auto-approved on the last day of the month." })] }))] })] }), showQuickAdd && (_jsx("div", { className: "fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm", children: _jsxs("div", { className: "w-full max-w-md rounded-2xl border border-[#00E096]/30 bg-[#151921] p-6 shadow-2xl", style: { boxShadow: "0 0 30px rgba(0,224,150,0.15)" }, children: [_jsxs("div", { className: "mb-1 flex items-center justify-between", children: [_jsx("h2", { className: "font-heading text-lg font-semibold text-white", children: "Quick Add Payroll" }), _jsx("button", { onClick: () => setShowQuickAdd(false), className: "text-slate-400 hover:text-white", children: _jsx(X, { className: "h-5 w-5" }) })] }), _jsx("p", { className: "mb-5 text-xs text-slate-500", children: "Record a flat amount you already paid for a whole month. No rates or hours needed." }), _jsxs("div", { className: "space-y-4", children: [_jsxs("div", { children: [_jsx("label", { className: "mb-1.5 block text-xs font-medium text-slate-400", children: "Employee *" }), _jsx("input", { list: "quick-staff-names", value: quickForm.employee_name, onChange: (e) => { setQuickForm({ ...quickForm, employee_name: e.target.value }); setQuickErr(null); }, placeholder: "Moin", className: "w-full rounded-lg border border-white/10 bg-[#0b0e14] px-3 py-2.5 text-sm text-white outline-none focus:border-[#00E096]" }), _jsx("datalist", { id: "quick-staff-names", children: activeStaff.map((s) => _jsx("option", { value: s.employee_name }, s.id)) })] }), _jsxs("div", { children: [_jsx("label", { className: "mb-1.5 block text-xs font-medium text-slate-400", children: "Amount Paid ($) *" }), _jsx("input", { type: "number", min: "0", step: "0.01", value: quickForm.amount, onChange: (e) => { setQuickForm({ ...quickForm, amount: e.target.value }); setQuickErr(null); }, placeholder: "3000", className: "w-full rounded-lg border border-white/10 bg-[#0b0e14] px-3 py-2.5 text-lg font-semibold text-white outline-none focus:border-[#00E096]" }), _jsx("p", { className: "mt-1 text-[10px] text-slate-500", children: "The full amount for the month, take-home as you paid it." })] }), _jsxs("div", { children: [_jsx("label", { className: "mb-1.5 block text-xs font-medium text-slate-400", children: "Month Paid For" }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsx("select", { value: quickForm.month, onChange: (e) => { setQuickForm({ ...quickForm, month: Number(e.target.value) }); setQuickErr(null); }, className: "flex-1 rounded-lg border border-white/10 bg-[#0b0e14] px-3 py-2.5 text-sm text-white outline-none focus:border-[#00E096]", children: MONTHS.map((m, i) => _jsx("option", { value: i, children: m }, i)) }), _jsx("input", { type: "number", min: "2020", max: "2030", value: quickForm.year, onChange: (e) => { setQuickForm({ ...quickForm, year: Number(e.target.value) }); setQuickErr(null); }, className: "w-24 rounded-lg border border-white/10 bg-[#0b0e14] px-3 py-2.5 text-sm text-white outline-none focus:border-[#00E096]" })] }), _jsxs("p", { className: "mt-1 text-[10px] text-slate-500", children: ["Covers ", quickPeriod.periodStart, " \u2192 ", quickPeriod.periodEnd] })] }), _jsxs("div", { className: "grid gap-3 sm:grid-cols-2", children: [_jsxs("div", { children: [_jsx("label", { className: "mb-1.5 block text-xs font-medium text-slate-400", children: "Department" }), _jsx("input", { value: quickForm.department, onChange: (e) => setQuickForm({ ...quickForm, department: e.target.value }), placeholder: "Front Office", className: "w-full rounded-lg border border-white/10 bg-[#0b0e14] px-3 py-2.5 text-sm text-white outline-none focus:border-[#00E096]" })] }), _jsxs("div", { children: [_jsx("label", { className: "mb-1.5 block text-xs font-medium text-slate-400", children: "Status" }), _jsxs("select", { value: quickForm.status, onChange: (e) => setQuickForm({ ...quickForm, status: e.target.value }), className: "w-full rounded-lg border border-white/10 bg-[#0b0e14] px-3 py-2.5 text-sm text-white outline-none focus:border-[#00E096]", children: [_jsx("option", { value: "paid", children: "Paid" }), _jsx("option", { value: "approved", children: "Approved" }), _jsx("option", { value: "draft", children: "Draft (not counted)" })] })] })] }), _jsxs("label", { className: "flex cursor-pointer items-start gap-2", children: [_jsx("input", { type: "checkbox", checked: quickForm.saveToStaff, onChange: (e) => setQuickForm({ ...quickForm, saveToStaff: e.target.checked }), className: "mt-0.5 h-4 w-4 accent-[#00E096]" }), _jsxs("span", { className: "text-xs text-slate-300", children: ["Also add to Staff Directory as a ", money(Number(quickForm.amount) || 0), "/month salary", _jsx("span", { className: "block text-[10px] text-slate-500", children: "So the monthly engine pays them automatically from now on." })] })] }), quickForm.status === "draft" ? (_jsx("div", { className: "rounded-xl border border-[#FFB547]/30 bg-[#FFB547]/[0.06] p-3 text-xs text-[#FFB547]", children: "Drafts are not deducted from money kept. Use Approved or Paid to have this reduce your dashboard figure." })) : (_jsxs("div", { className: "rounded-xl border border-[#00E096]/20 bg-[#00E096]/[0.04] p-3 text-xs text-slate-300", children: [money(Number(quickForm.amount) || 0), " will be deducted from Money Kept for ", quickPeriod.label, "."] })), (quickErr || quickDuplicate) && (_jsx("div", { className: "rounded-xl border border-[#FF6B6B]/30 bg-[#FF6B6B]/[0.08] p-3 text-xs text-[#FF6B6B]", children: quickErr || `${quickForm.employee_name.trim()} already has a run for ${quickPeriod.label}.` }))] }), _jsxs("div", { className: "mt-5 flex justify-end gap-3", children: [_jsx("button", { onClick: () => setShowQuickAdd(false), className: "rounded-lg border border-white/10 px-4 py-2 text-sm text-slate-300 hover:bg-white/5", children: "Cancel" }), _jsx("button", { onClick: handleQuickAdd, disabled: running || !quickForm.employee_name.trim() || !(Number(quickForm.amount) > 0) || !!quickDuplicate, className: "flex items-center gap-1.5 rounded-lg bg-[#00E096] px-4 py-2 text-sm font-semibold text-[#04251A] hover:bg-[#4FE3C1] disabled:opacity-50", children: running
                                        ? _jsxs(_Fragment, { children: [_jsx(Loader2, { className: "h-4 w-4 animate-spin" }), " Saving\u2026"] })
                                        : _jsxs(_Fragment, { children: [_jsx(Save, { className: "h-4 w-4" }), " Record Payroll"] }) })] })] }) })), showHistoricalForm && (_jsx("div", { className: "fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm", children: _jsxs("div", { className: "w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-2xl border border-[#6C63FF]/30 bg-[#151921] p-6 shadow-2xl", children: [_jsxs("div", { className: "mb-5 flex items-center justify-between", children: [_jsxs("div", { children: [_jsx("h2", { className: "font-heading text-lg font-semibold text-white", children: "Post Historical Payroll" }), _jsx("p", { className: "mt-0.5 text-xs text-slate-500", children: historicalStep === "configure" ? "Step 1 of 2 · choose the range" : "Step 2 of 2 · review before posting" })] }), _jsx("button", { onClick: closeHistorical, className: "text-slate-400 hover:text-white", children: _jsx(X, { className: "h-5 w-5" }) })] }), historicalStep !== "configure" && historicalPreview && (_jsxs("div", { className: "space-y-5", children: [_jsxs("div", { className: "grid gap-3 sm:grid-cols-3", children: [_jsxs("div", { className: "rounded-xl border border-[#00E096]/30 bg-[#00E096]/[0.06] p-3", children: [_jsx("p", { className: "text-[10px] uppercase tracking-widest text-slate-500", children: "Will Create" }), _jsx("p", { className: "mt-1 font-heading text-2xl font-semibold text-white", children: num(historicalPreview.totalRuns) }), _jsxs("p", { className: "mt-0.5 text-[10px] text-slate-500", children: [historicalPreview.periods.length, " month(s) \u00B7 ", historicalPreview.staffCount, " staff"] })] }), _jsxs("div", { className: "rounded-xl border border-[#6C63FF]/30 bg-[#6C63FF]/[0.06] p-3", children: [_jsx("p", { className: "text-[10px] uppercase tracking-widest text-slate-500", children: "Total Amount" }), _jsx("p", { className: "mt-1 font-heading text-2xl font-semibold text-white", children: money(historicalPreview.newAmount) }), _jsx("p", { className: "mt-0.5 text-[10px] text-slate-500", children: "Deducted from money kept" })] }), _jsxs("div", { className: "rounded-xl border border-[#FFB547]/30 bg-[#FFB547]/[0.06] p-3", children: [_jsx("p", { className: "text-[10px] uppercase tracking-widest text-slate-500", children: "Skipped" }), _jsx("p", { className: "mt-1 font-heading text-2xl font-semibold text-white", children: num(historicalPreview.totalSkipped) }), _jsx("p", { className: "mt-0.5 text-[10px] text-slate-500", children: "Already recorded" })] })] }), _jsx("div", { className: "max-h-72 overflow-y-auto rounded-xl border border-white/5", children: _jsxs("table", { className: "w-full text-left text-xs", children: [_jsx("thead", { className: "sticky top-0 bg-[#0A1628]", children: _jsxs("tr", { className: "border-b border-white/10 text-[10px] uppercase tracking-widest text-slate-500", children: [_jsx("th", { className: "py-2 px-3", children: "Employee" }), _jsx("th", { className: "py-2 px-3", children: "Period" }), _jsx("th", { className: "py-2 px-3 text-right", children: "Amount" }), _jsx("th", { className: "py-2 px-3 text-right", children: "Action" })] }) }), _jsx("tbody", { children: historicalPreview.items.map((it, i) => (_jsxs("tr", { className: `border-b border-white/5 ${it.existing ? "opacity-45" : ""}`, children: [_jsxs("td", { className: "py-2 px-3 text-white", children: [it.staffName, _jsx("span", { className: "ml-1 text-slate-500", children: it.department ? `· ${it.department}` : "" })] }), _jsx("td", { className: "py-2 px-3 text-slate-400", children: it.period }), _jsx("td", { className: "py-2 px-3 text-right tabular-nums text-white", children: money(it.payCalc.total_pay) }), _jsx("td", { className: "py-2 px-3 text-right", children: it.existing
                                                                ? _jsx("span", { className: "text-[#FFB547]", children: "Skip" })
                                                                : _jsx("span", { className: "text-[#00E096]", children: "Create" }) })] }, i))) })] }) }), _jsxs("div", { className: "flex justify-end gap-3 pt-4 border-t border-white/10", children: [_jsxs("button", { onClick: handleBackToConfigure, disabled: running, className: "flex items-center gap-1.5 rounded-lg border border-white/10 px-4 py-2 text-sm text-slate-300 hover:bg-white/5 disabled:opacity-50", children: [_jsx(ArrowLeft, { className: "h-4 w-4" }), " Back"] }), _jsx("button", { onClick: handlePostHistorical, disabled: running || historicalPreview.totalRuns === 0, className: "flex items-center gap-1.5 rounded-lg bg-[#00E096] px-4 py-2 text-sm font-semibold text-[#04251A] hover:bg-[#4FE3C1] disabled:opacity-50", children: running
                                                ? _jsxs(_Fragment, { children: [_jsx(Loader2, { className: "h-4 w-4 animate-spin" }), " Posting\u2026"] })
                                                : _jsxs(_Fragment, { children: [_jsx(Save, { className: "h-4 w-4" }), " Post ", historicalPreview.totalRuns, " Run(s)"] }) })] })] })), historicalStep === "configure" && (_jsxs("div", { className: "space-y-5", children: [_jsxs("div", { className: "space-y-3", children: [_jsx("label", { className: "block text-xs font-medium text-slate-400", children: "Data Source" }), _jsxs("div", { className: "flex items-center gap-4", children: [_jsxs("label", { className: "flex items-center gap-2 cursor-pointer", children: [_jsx("input", { type: "radio", name: "hist-source", checked: historicalForm.useStaffDirectory, onChange: () => setHistoricalForm(f => ({ ...f, useStaffDirectory: true })), className: "h-4 w-4 accent-[#6C63FF]" }), _jsx("span", { className: "text-sm text-white", children: "Use Staff Directory (recommended)" })] }), _jsxs("label", { className: "flex items-center gap-2 cursor-pointer", children: [_jsx("input", { type: "radio", name: "hist-source", checked: !historicalForm.useStaffDirectory, onChange: () => setHistoricalForm(f => ({ ...f, useStaffDirectory: false })), className: "h-4 w-4 accent-[#6C63FF]" }), _jsx("span", { className: "text-sm text-white", children: "Custom Entries" })] })] }), _jsx("p", { className: "text-xs text-slate-500", children: historicalForm.useStaffDirectory
                                                ? "Creates payroll runs for all active staff from the Staff Directory for each month in range."
                                                : "Manually add individual staff entries for the period." })] }), _jsxs("div", { className: "grid gap-3 sm:grid-cols-2", children: [_jsxs("div", { children: [_jsx("label", { className: "mb-1.5 block text-xs font-medium text-slate-400", children: "From Month" }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsx("select", { value: historicalForm.fromMonth, onChange: (e) => setHistoricalForm(f => ({ ...f, fromMonth: Number(e.target.value) })), className: "flex-1 rounded-lg border border-white/10 bg-[#0b0e14] px-3 py-2 text-sm text-white outline-none focus:border-[#6C63FF]", children: MONTHS.map((m, i) => _jsx("option", { value: i, children: m }, i)) }), _jsx("input", { type: "number", min: "2020", max: "2030", value: historicalForm.fromYear, onChange: (e) => setHistoricalForm(f => ({ ...f, fromYear: Number(e.target.value) })), className: "w-24 rounded-lg border border-white/10 bg-[#0b0e14] px-3 py-2 text-sm text-white outline-none focus:border-[#6C63FF]" })] })] }), _jsxs("div", { children: [_jsx("label", { className: "mb-1.5 block text-xs font-medium text-slate-400", children: "To Month" }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsx("select", { value: historicalForm.toMonth, onChange: (e) => setHistoricalForm(f => ({ ...f, toMonth: Number(e.target.value) })), className: "flex-1 rounded-lg border border-white/10 bg-[#0b0e14] px-3 py-2 text-sm text-white outline-none focus:border-[#6C63FF]", children: MONTHS.map((m, i) => _jsx("option", { value: i, children: m }, i)) }), _jsx("input", { type: "number", min: "2020", max: "2030", value: historicalForm.toYear, onChange: (e) => setHistoricalForm(f => ({ ...f, toYear: Number(e.target.value) })), className: "w-24 rounded-lg border border-white/10 bg-[#0b0e14] px-3 py-2 text-sm text-white outline-none focus:border-[#6C63FF]" })] })] })] }), _jsxs("div", { children: [_jsx("label", { className: "mb-1.5 block text-xs font-medium text-slate-400", children: "Status for Created Runs" }), _jsxs("select", { value: historicalForm.status, onChange: (e) => setHistoricalForm(f => ({ ...f, status: e.target.value })), className: "w-full rounded-lg border border-white/10 bg-[#0b0e14] px-3 py-2 text-sm text-white outline-none focus:border-[#6C63FF]", children: [_jsx("option", { value: "paid", children: "Paid" }), _jsx("option", { value: "approved", children: "Approved" }), _jsx("option", { value: "pending_review", children: "Pending Review" }), _jsx("option", { value: "draft", children: "Draft" })] }), _jsx("p", { className: "mt-1 text-xs text-slate-500", children: "Historical payments should typically be \"Paid\"." })] }), historicalForm.useStaffDirectory ? (_jsxs("div", { className: "rounded-xl border border-white/5 bg-[#0A1628]/60 p-4 max-h-60 overflow-y-auto", children: [_jsxs("p", { className: "mb-3 text-xs font-medium text-slate-400", children: ["Will create runs for ", activeStaff.length, " active staff member(s) per month:"] }), _jsxs("ul", { className: "space-y-1 text-sm", children: [activeStaff.slice(0, 10).map((s) => (_jsxs("li", { className: "flex items-center justify-between text-white", children: [_jsxs("span", { children: [s.employee_name, " (", s.department || "—", ")"] }), _jsx("span", { className: "text-slate-400", children: s.pay_type === "salary" ? money(s.base_rate) + "/mo" : money(s.base_rate) + "/hr" })] }, s.id))), activeStaff.length > 10 && (_jsxs("li", { className: "text-xs text-slate-500", children: ["+ ", activeStaff.length - 10, " more..."] }))] }), !activeStaff.length && (_jsx("p", { className: "text-center text-slate-500 py-4", children: "No active staff. Add staff in the Staff Directory first." }))] })) : (_jsxs("div", { className: "space-y-3", children: [_jsx("p", { className: "text-xs font-medium text-slate-400", children: "Custom Entries (add one per staff member)" }), historicalForm.customEntries.map((entry, idx) => (_jsxs("div", { className: "grid gap-2 sm:grid-cols-4", children: [_jsx("input", { placeholder: "Name", value: entry.employee_name, onChange: (e) => setHistoricalForm(f => ({
                                                        ...f,
                                                        customEntries: f.customEntries.map((en, i) => i === idx ? { ...en, employee_name: e.target.value } : en)
                                                    })), className: "rounded-lg border border-white/10 bg-[#0b0e14] px-3 py-2 text-sm text-white outline-none focus:border-[#6C63FF]" }), _jsx("input", { placeholder: "Department", value: entry.department, onChange: (e) => setHistoricalForm(f => ({
                                                        ...f,
                                                        customEntries: f.customEntries.map((en, i) => i === idx ? { ...en, department: e.target.value } : en)
                                                    })), className: "rounded-lg border border-white/10 bg-[#0b0e14] px-3 py-2 text-sm text-white outline-none focus:border-[#6C63FF]" }), _jsxs("select", { value: entry.pay_type, onChange: (e) => setHistoricalForm(f => ({
                                                        ...f,
                                                        customEntries: f.customEntries.map((en, i) => i === idx ? { ...en, pay_type: e.target.value } : en)
                                                    })), className: "rounded-lg border border-white/10 bg-[#0b0e14] px-3 py-2 text-sm text-white outline-none focus:border-[#6C63FF]", children: [_jsx("option", { value: "hourly", children: "Hourly" }), _jsx("option", { value: "salary", children: "Salary" })] }), _jsx("input", { type: "number", placeholder: "Rate", value: entry.base_rate, onChange: (e) => setHistoricalForm(f => ({
                                                        ...f,
                                                        customEntries: f.customEntries.map((en, i) => i === idx ? { ...en, base_rate: e.target.value } : en)
                                                    })), className: "rounded-lg border border-white/10 bg-[#0b0e14] px-3 py-2 text-sm text-white outline-none focus:border-[#6C63FF]" })] }, idx))), _jsx("button", { type: "button", onClick: () => setHistoricalForm(f => ({
                                                ...f,
                                                customEntries: [...f.customEntries, { employee_name: "", department: "", pay_type: "hourly", base_rate: "", hours: "40", overtime_hours: "0", overtime_rate: "", bonus: "0", deductions: "0" }]
                                            })), className: "text-sm text-[#6C63FF] hover:underline", children: "+ Add Another Staff Entry" }), !historicalForm.customEntries.length && (_jsx("button", { type: "button", onClick: () => setHistoricalForm(f => ({
                                                ...f,
                                                customEntries: [{ employee_name: "", department: "", pay_type: "hourly", base_rate: "", hours: "40", overtime_hours: "0", overtime_rate: "", bonus: "0", deductions: "0" }]
                                            })), className: "text-sm text-[#6C63FF] hover:underline", children: "Add First Staff Entry" }))] })), _jsxs("div", { className: "rounded-xl border border-[#6C63FF]/30 bg-[#6C63FF]/[0.06] p-4", children: [_jsx("p", { className: "text-xs font-medium text-[#6C63FF]", children: "Summary" }), _jsxs("p", { className: "mt-1 text-sm text-white", children: ["Will create payroll runs for ", _jsx("strong", { children: num(historicalSourceCount) }), " staff member(s) \u00D7", " ", _jsx("strong", { children: num(historicalMonthCount) }), " month(s) =", " ", _jsx("strong", { children: num(historicalPlannedRuns) }), " run(s)."] }), _jsx("p", { className: "mt-1 text-xs text-slate-500", children: "Existing runs for the same staff + period will be skipped." })] }), _jsxs("div", { className: "flex justify-end gap-3 pt-4 border-t border-white/10", children: [_jsx("button", { onClick: closeHistorical, className: "rounded-lg border border-white/10 px-4 py-2 text-sm text-slate-300 hover:bg-white/5", children: "Cancel" }), _jsxs("button", { onClick: handlePreviewHistorical, disabled: running || !historicalReady, className: "flex items-center gap-1.5 rounded-lg bg-[#6C63FF] px-4 py-2 text-sm font-semibold text-white hover:bg-[#5b52e8] disabled:opacity-50", children: [_jsx(Target, { className: "h-4 w-4" }), "Review ", historicalPlannedRuns > 0 ? `${historicalPlannedRuns} Run(s)` : "Payroll"] })] })] }))] }) }))] }));
}
