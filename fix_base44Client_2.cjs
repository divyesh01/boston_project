const fs = require('fs');
let code = fs.readFileSync('src/api/base44Client.js', 'utf8');

// Use regex to replace the rollback transaction
code = code.replace(/await localDb\.transaction\('rw', localDb\.ImportRecordIds, async \(\) => \{\s*(for \([\s\S]*?\}\s*)\}\);/m, "$1");

// Use regex to inject timecard logic into runLocalAutoPayroll
const oldLogic = /const existing = await localDb\.PayrollRun\.filter\(\(r\) => r\.pay_period_end === periodEnd\)\.toArray\(\);\s*const paidKeys = new Set\(existing\.map\(\(r\) => `\$\{r\.property_id \|\| "all"\}::\$\{String\(r\.employee_name \|\| ""\)\.toLowerCase\(\)\}`\)\);\s*const created = \[\];\s*const skipped = \[\];\s*for \(const s of staff\) \{/m;

const newLogic = `const existing = await localDb.PayrollRun.filter((r) => r.pay_period_end === periodEnd).toArray();
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
  for (const s of staff) {`;

code = code.replace(oldLogic, newLogic);

const oldOtLogic = /const baseRate = Number\(s\.base_rate\) \|\| 0;\s*const hours = Number\(s\.hours\) \|\| 0;\s*const otHours = Number\(s\.overtime_hours\) \|\| 0;\s*const otRate = Number\(s\.overtime_rate\) \|\| baseRate \* 1\.5;/m;
const newOtLogic = `const baseRate = Number(s.base_rate) || 0;
    const tc = byEmployee(String(s.employee_name || "").toLowerCase());
    const hours = tc ? Number(tc.hours) || 0 : Number(s.hours) || 0;
    const otHours = tc ? Number(tc.overtime_hours) || 0 : Number(s.overtime_hours) || 0;
    const otRate = Number(s.overtime_rate) || baseRate * 1.5;`;

code = code.replace(oldOtLogic, newOtLogic);

const oldRecLogic = /payroll_status: "approved",\s*auto_generated: true,\s*\};/m;
const newRecLogic = `payroll_status: "approved",
      auto_generated: true,
      timecard_derived: !!tc,
    };`;
code = code.replace(oldRecLogic, newRecLogic);

fs.writeFileSync('src/api/base44Client.js', code);
