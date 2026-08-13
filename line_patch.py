with open('src/api/base44Client.js', 'r', encoding='utf-8') as f:
    lines = f.readlines()

out = []
skip = False
for i, line in enumerate(lines):
    # 1. Add getCsrfToken
    if "import { loginRateLimiter, sanitizeEmail, sanitizeAlphanumeric, secureStore, secureRetrieve, secureRemove, createAuditEntry, getDeviceFingerprint, getClientIpHint } from '@/lib/securityUtils';" in line:
        line = "import { loginRateLimiter, sanitizeEmail, sanitizeAlphanumeric, secureStore, secureRetrieve, secureRemove, createAuditEntry, getDeviceFingerprint, getClientIpHint, getCsrfToken } from '@/lib/securityUtils';\n"
    
    # 2. Add reconcileTimecards
    if "import { verifyPassword, generateTemporaryPassword, generateTotpSecret, formatTotpUri, verifyTotpToken } from '@/lib/security';" in line:
        line = "import { verifyPassword, generateTemporaryPassword, generateTotpSecret, formatTotpUri, verifyTotpToken } from '@/lib/security';\nimport { reconcileTimecards } from '@/lib/timecardCalc';\n"
    
    # property filter
    if "const staff = await localDb.Staff.filter((s) => s.active !== false).toArray();" in line:
        line = "  let staff = await localDb.Staff.filter((s) => s.active !== false).toArray();\n  if (params.propertyId) staff = staff.filter((s) => s.property_id === params.propertyId);\n"

    # 3. runLocalAutoPayroll logic
    if "const paidKeys = new Set(existing.map((r) => `${r.property_id || \"all\"}::${String(r.employee_name || \"\").toLowerCase()}`));" in line:
        line = line + """
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
"""

    if "const hours = Number(s.hours) || 0;" in line:
        line = '    const tc = byEmployee(String(s.employee_name || "").toLowerCase());\n    const hours = tc ? Number(tc.hours) || 0 : Number(s.hours) || 0;\n'
    if "const otHours = Number(s.overtime_hours) || 0;" in line:
        line = '    const otHours = tc ? Number(tc.overtime_hours) || 0 : Number(s.overtime_hours) || 0;\n'
    if "payroll_status: \"approved\"," in line:
        line = line + '      timecard_derived: !!tc,\n'

    # 4. invoke fallback
    if "if (functionName === 'deleteAccount') {" in line:
        out.append("""    if (functionName === 'deleteAccount' || functionName === 'audit_clear' || functionName.startsWith('auth_')) {
      const res = await fetch(`/api/functions/${functionName}`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'X-CSRF-Token': getCsrfToken()
        },
        body: JSON.stringify(params)
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => null);
        throw new Error((errData && errData.error) ? errData.error : `HTTP Error ${res.status}`);
      }
      const data = await res.json();
      
      if (functionName === 'deleteAccount') {
        await Promise.all(localDb.tables.map(t => t.clear()));
        localStorage.clear();
      } else if (functionName === 'audit_clear') {
        await localDb.AuditLog.clear();
      }
      return data;
    }
""")
        skip = True
        continue
    
    if skip and "return { success: true };" in line:
        continue
    if skip and "    }" in line:
        skip = False
        continue
    if skip:
        continue

    # 5. Rollback bug
    if "await localDb.transaction('rw', localDb.ImportRecordIds, async () => {" in line:
        continue
    if "});" in line and "let totalDeleted = 0;" in lines[i - 12]:
        continue

    out.append(line)

with open('src/api/base44Client.js', 'w', encoding='utf-8') as f:
    f.writelines(out)
