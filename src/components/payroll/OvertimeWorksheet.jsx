import React, { useState } from 'react';
import { allocateOvertime } from '@/lib/laborPolicy';
import { getEnterpriseConfig } from '@/lib/enterpriseConfigEngine';

export default function OvertimeWorksheet({ employerId, employeeIdentity, employerGroup, properties }) {
  const [shifts, setShifts] = useState([]), [result, setResult] = useState(null), [error, setError] = useState('');
  const edit = (i, key, value) => { setShifts(shifts.map((s, k) => k === i ? { ...s, [key]: value } : s)); setResult(null); };
  const calculate = () => {
    try {
      if (!employerGroup || !employeeIdentity || !shifts.length) throw new Error('Configure the employer group and select an employee; add dated shifts.');
      const policies = shifts.map(s => getEnterpriseConfig(employerId, s.date).labor_policy);
      if (policies.some(p => !p)) throw new Error('Every shift needs a reviewed labor policy for its date.');
      if (new Set(policies.map(p => JSON.stringify(p))).size !== 1) throw new Error('The shifts cross labor-policy periods. Review the transition before allocating overtime.');
      setResult(allocateOvertime(shifts.map(s => ({ ...s, employee_identity: employeeIdentity, employer_group: employerGroup })), policies[0])); setError('');
    } catch (e) { setError(e.message); setResult(null); }
  };
  return <details className="space-y-3 rounded-xl border border-white/10 p-3 text-xs text-slate-300"><summary>Daily and weekly overtime worksheet</summary><p className="pt-2">Enter shifts in chronological order within each date. Use the same employee identity across service locations. Configure an employer group after reviewing the employment relationship. Results are a review worksheet and do not post payroll.</p>
    {shifts.map((s, i) => <div key={s.source_id} className="flex flex-wrap gap-2"><label>Date<input aria-label={`Shift ${i + 1} date`} className="ml-1 rounded bg-[#0A1628] p-2" type="date" value={s.date} onChange={e => edit(i, 'date', e.target.value)} /></label><label>Hours<input aria-label={`Shift ${i + 1} hours`} className="ml-1 w-20 rounded bg-[#0A1628] p-2" type="number" min="0" max="24" step="0.01" value={s.hours} onChange={e => edit(i, 'hours', Number(e.target.value))} /></label><label>Service property<select className="ml-1 rounded bg-[#0A1628] p-2" value={s.property_id} onChange={e => edit(i, 'property_id', e.target.value)}><option value="">Select property</option>{properties.map(p => <option key={p.id} value={String(p.id)}>{p.name}</option>)}</select></label><label className="flex items-center gap-1"><input type="checkbox" checked={s.reporting_pay_applies} onChange={e => edit(i, 'reporting_pay_applies', e.target.checked)} />Reporting pay applies</label><button className="text-red-300" onClick={() => { setShifts(shifts.filter((_, k) => k !== i)); setResult(null); }}>Remove</button></div>)}
    <div className="flex gap-2"><button className="rounded border border-white/15 p-2" onClick={() => { setShifts([...shifts, { source_id: crypto.randomUUID(), date: '', hours: 0, property_id: '', reporting_pay_applies: false }]); setResult(null); }}>Add shift</button><button className="rounded border border-cyan-400/30 p-2" onClick={calculate}>Review overtime</button></div>
    {error && <p className="text-amber-300" role="alert">{error}</p>}
    {result && <div className="overflow-auto"><table className="w-full text-left"><thead><tr><th>Date</th><th>Regular</th><th>Overtime</th><th>Reporting pay hours</th><th>Sick leave accrual</th></tr></thead><tbody>{result.map(s => <tr key={s.source_id}><td>{s.date}</td><td>{s.regular_hours.toFixed(2)}</td><td>{s.overtime_hours.toFixed(2)}</td><td>{s.reporting_hours.toFixed(2)}</td><td>{s.sick_leave_accrued.toFixed(4)}</td></tr>)}</tbody></table></div>}
  </details>;
}
