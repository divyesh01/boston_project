import React, { useState } from 'react';
import Card from '@/components/ui-exec/Card';
import { buildServiceStatement, assessWage } from '@/lib/laborPolicy';
import OvertimeWorksheet from './OvertimeWorksheet';
import { getEnterpriseConfig } from '@/lib/enterpriseConfigEngine';
import { SERVICE_STATEMENT_KEY } from '@/lib/enterpriseSchema';
import { readScopedJsonSetting, writeJsonSetting, flushCloudSettingSync } from '@/lib/settingsStore';
import { money2 } from '@/lib/hotel';
import { sanitizeCsvCell } from '@/lib/securityUtils';
import { useAuth } from '@/lib/AuthContext';
import { useQuery } from '@tanstack/react-query';
import { db } from '@/api/base44Client';
import { readHotelDataRows } from '@/lib/hotelDataQuery';

const input = 'rounded-lg border border-white/15 bg-[#0A1628] px-3 py-2 text-sm text-white';
export default function SharedServiceStatements({ properties, businessDate }) {
  const { user } = useAuth();
  let permissions = user?.permissions;
  try { if (typeof permissions === 'string') permissions = JSON.parse(permissions); } catch { permissions = {}; }
  const canSave = ['owner', 'admin'].includes(String(user?.role).toLowerCase()) || permissions?.manage_settings === true;
  const [employerId, setEmployerId] = useState(''), [serviceId, setServiceId] = useState(''), [employeeId, setEmployeeId] = useState('');
  const [runId, setRunId] = useState(''), [hours, setHours] = useState(''), [otHours, setOtHours] = useState('0');
  const [fica, setFica] = useState('0'), [comp, setComp] = useState('0'), [statement, setStatement] = useState(null), [message, setMessage] = useState('');
  const employer = properties.find(p => String(p.id) === employerId), service = properties.find(p => String(p.id) === serviceId);
  const staffQ = useQuery({ queryKey: ['staff', employerId], enabled: !!employer,
    queryFn: () => readHotelDataRows(db.entities.Staff, { property_id: employerId }, 'employee_name') });
  const payrollQ = useQuery({ queryKey: ['payroll', employerId], enabled: !!employer,
    queryFn: () => readHotelDataRows(db.entities.PayrollRun, { property_id: employerId }, '-pay_period_start') });
  const staff = staffQ.data || [], payroll = payrollQ.data || [];
  const ownStaff = staff.filter(s => String(s.property_id) === employerId);
  const employee = ownStaff.find(s => String(s.id) === employeeId);
  // Legacy runs may lack a stable employee reference. Choose the source
  // explicitly; never assign it by matching a person's name.
  const runs = payroll.filter(p => String(p.property_id) === employerId && ['paid', 'approved'].includes(p.payroll_status));
  const source = runs.find(p => String(p.id) === runId);
  const clear = () => { setStatement(null); setMessage(''); };
  const preview = () => {
    clear();
    try {
      if (!employee || !source) throw new Error('Choose the employee identity and corresponding source payroll run.');
      if (source.employee_id != null && String(source.employee_id) !== String(employee.employee_id || employee.id)) throw new Error('Source run belongs to a different employee identity.');
      if (source.pay_type !== 'hourly') throw new Error('An hourly source run is required for an hours-based statement.');
      const previous = readScopedJsonSetting(SERVICE_STATEMENT_KEY, [], employerId);
      const already = previous.flatMap(s => s.lines || []).filter(l => String(l.source_id) === runId);
      const allocated = already.reduce((n, l) => n + Number(l.hours), 0), allocatedOt = already.reduce((n, l) => n + Number(l.overtime_hours), 0);
      if (Number(hours) + allocated > Number(source.hours) || Number(otHours) + allocatedOt > Number(source.overtime_hours || 0)) throw new Error('Allocation exceeds the source run’s remaining regular or overtime hours.');
      setStatement(buildServiceStatement({ employer, service, employee: { id: `${employerId}:${employee.employee_id || employee.id}`, name: employee.employee_name },
        lines: [{ source_id: runId, date: source.pay_period_end, hours: Number(hours), overtime_hours: Number(otHours), rate: Number(source.base_rate), overtime_rate: Number(source.overtime_rate || Number(source.base_rate) * 1.5) }], fica_rate: Number(fica) / 100, workers_comp_rate: Number(comp) / 100 }));
    } catch (e) { setMessage(e.message); }
  };
  const save = () => {
    if (!statement || !canSave) return;
    const previous = readScopedJsonSetting(SERVICE_STATEMENT_KEY, [], employerId);
    const value = { ...statement, id: crypto.randomUUID(), created_at: new Date().toISOString() };
    if (previous.length >= 200) { setMessage('Statement storage limit reached; archive reviewed statements before saving.'); return; }
    if (!writeJsonSetting(SERVICE_STATEMENT_KEY, [...previous, value], employerId)) { setMessage('Could not store the statement.'); return; }
    flushCloudSettingSync().catch(e => setMessage(e.message));
    setStatement(null); setMessage('Draft stored. It does not create a payroll payment, expense or transfer. Check Settings for server acknowledgement.');
  };
  const download = (value = statement) => {
    if (!value) return;
    const rows = [['Status', 'Employer', 'Receiving property', 'Employee identity', 'Source run', 'Business date', 'Regular hours', 'Overtime hours', 'Wages', 'FICA', 'Workers comp', 'Total'],
      ...value.lines.map(l => [value.status, value.employer_name, value.service_name, value.employee_identity, l.source_id, l.date, l.hours, l.overtime_hours, l.amount, '', '', '']),
      ['STATEMENT TOTAL', value.employer_name, value.service_name, value.employee_identity, '', '', '', '', value.wage_total, value.fica, value.workers_comp, value.total]];
    const csv = rows.map(row => row.map(v => `"${String(sanitizeCsvCell(String(v))).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = 'shared-service-draft.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const config = employer ? getEnterpriseConfig(employer.id, businessDate, employer) : {};
  const wageIssues = ownStaff.flatMap(s => assessWage(s, employerId, businessDate).issues.map(issue => `${s.employee_name}: ${issue}`));
  return <Card title="Shared services and labor review" subtitle="Keep the original employer and payment intact. Allocate documented services to another accessible property using source payroll references.">
    <div className="space-y-4 text-sm text-slate-300">
    {employer && (staffQ.isPending || payrollQ.isPending) && <p role="status">Loading this employer's staff and payroll sources…</p>}
    {employer && (staffQ.isError || payrollQ.isError) && <p className="text-red-300" role="alert">Could not load payroll sources. <button onClick={() => { staffQ.refetch(); payrollQ.refetch(); }}>Retry</button></p>}
    <div className="grid gap-3 sm:grid-cols-2">
      <label>Employer property<select className={`block w-full ${input}`} value={employerId} onChange={e => { setEmployerId(e.target.value); setEmployeeId(''); setRunId(''); clear(); }}><option value="">Select employer</option>{properties.map(p => <option key={p.id} value={String(p.id)}>{p.name}</option>)}</select></label>
      <label>Receiving property<select className={`block w-full ${input}`} value={serviceId} onChange={e => { setServiceId(e.target.value); clear(); }}><option value="">Select receiving property</option>{properties.filter(p => String(p.id) !== employerId).map(p => <option key={p.id} value={String(p.id)}>{p.name}</option>)}</select></label>
      <label>Employee identity<select className={`block w-full ${input}`} value={employeeId} onChange={e => { setEmployeeId(e.target.value); clear(); }}><option value="">Select employee</option>{ownStaff.map(s => <option key={s.id} value={String(s.id)}>{s.employee_id || s.id} · {s.employee_name}</option>)}</select></label>
      <label>Source paid / approved run<select className={`block w-full ${input}`} value={runId} onChange={e => { setRunId(e.target.value); clear(); }}><option value="">Confirm corresponding payroll run</option>{runs.map(p => <option key={p.id} value={String(p.id)}>{p.employee_name} · {p.pay_period_start} → {p.pay_period_end}</option>)}</select></label>
      {[['Regular hours allocated', hours, setHours], ['Overtime hours allocated', otHours, setOtHours], ['FICA burden (%)', fica, setFica], ['Workers compensation burden (%)', comp, setComp]].map(([label, value, set]) => <label key={label}>{label}<input className={`block w-full ${input}`} type="number" min="0" step="0.01" value={value} onChange={e => { set(e.target.value); clear(); }} /></label>)}
    </div>
    {employer && <p className="text-xs">Employer of record: {config.employer_of_record || 'needs configuration'} · reviewed labor policy {config.labor_policy ? 'configured' : 'missing'}. Daily and weekly overtime require dated shifts and a configured employer group.</p>}
    {wageIssues.length > 0 && <details className="text-amber-200"><summary>Labor review: {wageIssues.length} items</summary>{wageIssues.map((issue, i) => <p key={i} className="mt-1 text-xs">{issue}</p>)}</details>}
    <OvertimeWorksheet key={`${employerId}:${employeeId}`} employerId={employerId} employeeIdentity={employee ? `${employerId}:${employee.employee_id || employee.id}` : ''} employerGroup={config.employer_group_id} properties={properties} />
    <button className="rounded border border-cyan-400/30 px-3 py-2 text-cyan-200" onClick={preview}>Preview statement</button>
    {statement && <div className="space-y-3 rounded-xl border border-emerald-400/20 p-3"><p>Draft wages {money2(statement.wage_total)} + FICA {money2(statement.fica)} + workers compensation {money2(statement.workers_comp)} = {money2(statement.total)}</p><p className="text-xs">Confirm source identity and allocation before recording a separate intercompany payable. This draft does not assess joint-employer status.</p><div className="flex gap-3"><button disabled={!canSave} className="rounded border border-white/15 p-2 disabled:opacity-40" onClick={save}>Store draft</button><button className="rounded border border-white/15 p-2" onClick={() => download(statement)}>Download draft CSV</button></div></div>}
    {employerId && <details className="space-y-2 rounded-xl border border-white/10 p-3 text-xs"><summary>Stored service statement drafts</summary>{readScopedJsonSetting(SERVICE_STATEMENT_KEY, [], employerId).map(row => <div key={row.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-white/10 py-2"><p>{row.employee_name} | {row.service_name} | {row.status} | {money2(row.total)}</p><button className="rounded border border-white/15 p-2" onClick={() => download(row)}>Download draft</button></div>)}</details>}
    {!canSave && <p className="text-xs">Settings permission is required to store statement drafts.</p>}
    {message && <p className="text-amber-200" role="status">{message}</p>}
    </div>
  </Card>;
}
