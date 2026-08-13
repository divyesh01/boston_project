const fs = require('fs');
let code = fs.readFileSync('src/api/base44Client.js', 'utf8');

// 1. Add getCsrfToken
code = code.replace(
  "import { loginRateLimiter, sanitizeEmail, sanitizeAlphanumeric, secureStore, secureRetrieve, secureRemove, createAuditEntry, getDeviceFingerprint, getClientIpHint } from '@/lib/securityUtils';",
  "import { loginRateLimiter, sanitizeEmail, sanitizeAlphanumeric, secureStore, secureRetrieve, secureRemove, createAuditEntry, getDeviceFingerprint, getClientIpHint, getCsrfToken } from '@/lib/securityUtils';"
);

// 2. Add reconcileTimecards
code = code.replace(
  "import { verifyPassword, generateTemporaryPassword, generateTotpSecret, formatTotpUri, verifyTotpToken } from '@/lib/security';",
  "import { verifyPassword, generateTemporaryPassword, generateTotpSecret, formatTotpUri, verifyTotpToken } from '@/lib/security';\nimport { reconcileTimecards } from '@/lib/timecardCalc';"
);

// 3. Update runLocalAutoPayroll logic
const oldPayrollLogic = `  const existing = await localDb.PayrollRun.filter((r) => r.pay_period_end === periodEnd).toArray();
  const paidKeys = new Set(existing.map((r) => \`\${r.property_id || "all"}::\${String(r.employee_name || "").toLowerCase()}\`));

  const created = [];
  const skipped = [];
  for (const s of staff) {
    const key = \`\${s.property_id || "all"}::\${String(s.employee_name || "").toLowerCase()}\`;
    if (paidKeys.has(key)) {
      skipped.push({ employee_name: s.employee_name, reason: "already processed for this period" });
      continue;
    }
    if (!s.employee_name || !(Number(s.base_rate) > 0)) {
      skipped.push({ employee_name: s.employee_name, reason: "missing pay configuration" });
      continue;
    }
    const baseRate = Number(s.base_rate) || 0;
    const hours = Number(s.hours) || 0;
    const otHours = Number(s.overtime_hours) || 0;
    const otRate = Number(s.overtime_rate) || baseRate * 1.5;
    const bonus = Number(s.bonus) || 0;
    const deductions = Number(s.deductions) || 0;
    
    const baseRateCents = toCents(baseRate);
    const regularPayCents = s.pay_type === "salary" ? baseRateCents : Math.round(baseRateCents * hours);
    const overtimePayCents = Math.round(toCents(otRate) * otHours);
    const totalPayCents = regularPayCents + overtimePayCents + toCents(bonus) - toCents(deductions);

    const record = {
      property_id: s.property_id || "",
      property_name: s.property_name || "",
      employee_name: s.employee_name,
      department: s.department || "",
      pay_type: s.pay_type || "hourly",
      base_rate: baseRate,
      hours,
      regular_pay: fromCents(regularPayCents),
      overtime_hours: otHours,
      overtime_rate: otRate,
      overtime_pay: fromCents(overtimePayCents),
      bonus,
      deductions,
      total_pay: fromCents(totalPayCents),
      pay_period_start: periodStart,
      pay_period_end: periodEnd,
      payroll_date: periodEnd,
      payroll_status: "approved",
      auto_generated: true,
    };
    await localDb.PayrollRun.add({ ...record, created_date: now.toISOString(), updated_date: now.toISOString() });
    created.push(record);
  }`;

const newPayrollLogic = `  const existing = await localDb.PayrollRun.filter((r) => r.pay_period_end === periodEnd).toArray();
  const paidKeys = new Set(existing.map((r) => \`\${r.property_id || "all"}::\${String(r.employee_name || "").toLowerCase()}\`));

  let timecardWeeks = [];
  try {
    const allPunches = await localDb.TimecardPunch.toArray() || [];
    const punches = allPunches.filter(
      (p) =>
        (!params.propertyId || p.property_id === params.propertyId) &&
        String(p.shift_date || "").slice(0, 10) >= periodStart &&
        String(p.shift_date || "").slice(0, 10) <= periodEnd
    );
    if (punches.length) {
      const staffNames = new Set(staff.map((s) => String(s.employee_name).trim().toLowerCase()));
      timecardWeeks = reconcileTimecards(punches).filter((w) => staffNames.has(String(w.employeeKey || "").toLowerCase()));
    }
  } catch (err) {
    timecardWeeks = [];
  }

  const byEmployee = (low) => {
    const weeks = timecardWeeks.filter((w) => String(w.employeeKey || "").toLowerCase() === low);
    if (!weeks.length) return null;
    return weeks.reduce(
      (acc, w) => ({
        hours: acc.hours + (Number(w.hours) || 0),
        overtime_hours: acc.overtime_hours + (Number(w.overtime_hours) || 0),
      }),
      { hours: 0, overtime_hours: 0 }
    );
  };

  const created = [];
  const skipped = [];
  for (const s of staff) {
    const key = \`\${s.property_id || "all"}::\${String(s.employee_name || "").toLowerCase()}\`;
    if (paidKeys.has(key)) {
      skipped.push({ employee_name: s.employee_name, reason: "already processed for this period" });
      continue;
    }
    if (!s.employee_name || !(Number(s.base_rate) > 0)) {
      skipped.push({ employee_name: s.employee_name, reason: "missing pay configuration" });
      continue;
    }
    const baseRate = Number(s.base_rate) || 0;
    
    const tc = byEmployee(String(s.employee_name || "").toLowerCase());
    const hours = tc ? Number(tc.hours) || 0 : Number(s.hours) || 0;
    const otHours = tc ? Number(tc.overtime_hours) || 0 : Number(s.overtime_hours) || 0;
    const otRate = Number(s.overtime_rate) || baseRate * 1.5;
    const bonus = Number(s.bonus) || 0;
    const deductions = Number(s.deductions) || 0;
    
    const baseRateCents = toCents(baseRate);
    const regularPayCents = s.pay_type === "salary" ? baseRateCents : Math.round(baseRateCents * hours);
    const overtimePayCents = Math.round(toCents(otRate) * otHours);
    const totalPayCents = regularPayCents + overtimePayCents + toCents(bonus) - toCents(deductions);

    const record = {
      property_id: s.property_id || "",
      property_name: s.property_name || "",
      employee_name: s.employee_name,
      department: s.department || "",
      pay_type: s.pay_type || "hourly",
      base_rate: baseRate,
      hours,
      regular_pay: fromCents(regularPayCents),
      overtime_hours: otHours,
      overtime_rate: otRate,
      overtime_pay: fromCents(overtimePayCents),
      bonus,
      deductions,
      total_pay: fromCents(totalPayCents),
      pay_period_start: periodStart,
      pay_period_end: periodEnd,
      payroll_date: periodEnd,
      payroll_status: "approved",
      auto_generated: true,
      timecard_derived: !!tc,
    };
    await localDb.PayrollRun.add({ ...record, created_date: now.toISOString(), updated_date: now.toISOString() });
    created.push(record);
  }`;

code = code.replace(oldPayrollLogic, newPayrollLogic);

// 4. Update invoke fallback
const oldInvokeLogic = `    if (functionName === 'deleteAccount') {
      // Clear all local data
      await Promise.all(localDb.tables.map(t => t.clear()));
      localStorage.clear();
      return { success: true };
    }`;

const newInvokeLogic = `    if (functionName === 'deleteAccount' || functionName === 'audit_clear' || functionName.startsWith('auth_')) {
      const res = await fetch(\`/api/functions/\${functionName}\`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'X-CSRF-Token': getCsrfToken()
        },
        body: JSON.stringify(params)
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => null);
        throw new Error((errData && errData.error) ? errData.error : \`HTTP Error \${res.status}\`);
      }
      const data = await res.json();
      
      if (functionName === 'deleteAccount') {
        await Promise.all(localDb.tables.map(t => t.clear()));
        localStorage.clear();
      } else if (functionName === 'audit_clear') {
        await localDb.AuditLog.clear();
      }
      return data;
    }`;

code = code.replace(oldInvokeLogic, newInvokeLogic);

// 5. Fix the rollbackImportSession Dexie transaction
const oldRollbackLogic = `  let totalDeleted = 0;
  await localDb.transaction('rw', localDb.ImportRecordIds, async () => {
    for (const row of pending) {
      const ids = row.record_ids;
      if (!ids?.length) continue;
      await entities[row.entity].bulkDelete(ids);
      totalDeleted += ids.length;
      await localDb.ImportRecordIds.update(row.id, {
        status: 'rolled_back',
        rolled_back_at: new Date().toISOString(),
      });
    }
  });`;

const newRollbackLogic = `  let totalDeleted = 0;
  for (const row of pending) {
    const ids = row.record_ids;
    if (!ids?.length) continue;
    await entities[row.entity].bulkDelete(ids);
    totalDeleted += ids.length;
    await localDb.ImportRecordIds.update(row.id, {
      status: 'rolled_back',
      rolled_back_at: new Date().toISOString(),
    });
  }`;

code = code.replace(oldRollbackLogic, newRollbackLogic);

fs.writeFileSync('src/api/base44Client.js', code);
