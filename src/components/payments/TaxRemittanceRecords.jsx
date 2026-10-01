import React, { useState } from 'react';
import { TAX_REMITTANCE_KEY } from '@/lib/enterpriseSchema';
import { readScopedJsonSetting, writeJsonSetting, flushCloudSettingSync } from '@/lib/settingsStore';
import { validateRemittanceRecords } from '@/lib/taxRemittance';
import { money2 } from '@/lib/hotel';
import { notifySettingsChanged } from '@/lib/settingsBus';
import { useAuth } from '@/lib/AuthContext';

export default function TaxRemittanceRecords({ propertyId, dateRange }) {
  const { user } = useAuth();
  let permissions = user?.permissions;
  try { if (typeof permissions === 'string') permissions = JSON.parse(permissions); } catch { permissions = {}; }
  const canManage = ['owner', 'admin'].includes(String(user?.role).toLowerCase()) || permissions?.manage_settings === true;
  const [form, setForm] = useState({ date: dateRange.to || '', reference: '', taxable_base: '', state: '', city: '', other: '', reviewed: false });
  const [message, setMessage] = useState(''), [version, setVersion] = useState(0);
  const records = readScopedJsonSetting(TAX_REMITTANCE_KEY, [], propertyId);
  const save = () => {
    if (!canManage) return;
    try {
      const row = { ...form, id: crypto.randomUUID(), ...Object.fromEntries(['taxable_base', 'state', 'city', 'other'].map(key => [key, Number(form[key])])) };
      if (form.taxable_base === '') throw new Error('Enter the current total taxable room revenue for this property/date.');
      const next = validateRemittanceRecords([...records, row]);
      if (!writeJsonSetting(TAX_REMITTANCE_KEY, next, propertyId)) throw new Error('Could not store the remittance evidence.');
      notifySettingsChanged(); flushCloudSettingSync().catch(e => setMessage(e.message));
      setVersion(version + 1); setMessage('Record stored locally. Check Settings for server acknowledgement.');
    } catch (e) { setMessage(e.message); }
  };
  return <details className="space-y-3 rounded-xl border border-white/10 p-4 text-xs text-slate-300"><summary>Documented marketplace tax remittance</summary>
    <p className="pt-2">Use a statement reference and the exact current taxable base. Confirmed amounts are shown separately from hotel-remitted tax. Changed report bases require a fresh review; imported tax totals stay intact.</p>
    <div className="grid gap-3 pt-3 sm:grid-cols-3">{[['date', 'Business date', 'date'], ['reference', 'Statement reference / URL', 'text'], ['taxable_base', 'Total taxable room revenue for this date ($)', 'number'], ['state', 'State tax remitted ($)', 'number'], ['city', 'City tax remitted ($)', 'number'], ['other', 'Other tax remitted ($)', 'number']].map(([key, label, type]) => <label key={key}>{label}<input className="mt-1 w-full rounded-lg border border-white/15 bg-[#0A1628] px-3 py-2 text-white" type={type} min={type === 'number' ? '0' : undefined} step={type === 'number' ? '0.01' : undefined} value={form[key]} onChange={e => setForm({ ...form, [key]: e.target.value })} /></label>)}</div>
    <label className="flex items-center gap-2 py-2"><input type="checkbox" checked={form.reviewed} onChange={e => setForm({ ...form, reviewed: e.target.checked })} />I verified that the marketplace remitted these amounts for this business date.</label>
    <button disabled={!canManage} className="rounded border border-cyan-400/30 px-3 py-2 text-cyan-200 disabled:opacity-40" onClick={save}>Store reviewed evidence</button>
    <div className="max-h-48 space-y-2 overflow-auto pt-3">{records.filter(r => r.date >= (dateRange.from || '') && r.date <= (dateRange.to || '9999-12-31')).map(r => <div key={r.id} className="flex flex-wrap justify-between gap-2 border-t border-white/10 pt-2"><p>{r.date} · {r.reference} · taxable base {money2(r.taxable_base)} · state {money2(r.state)} / city {money2(r.city)} / other {money2(r.other)}</p><button disabled={!canManage} className="text-red-300 disabled:opacity-40" onClick={() => { if (canManage && writeJsonSetting(TAX_REMITTANCE_KEY, records.filter(row => row.id !== r.id), propertyId)) { notifySettingsChanged(); setVersion(version + 1); } }}>Remove evidence</button></div>)}</div>
    {!canManage && <p>Settings permission is required to change remittance evidence.</p>}
    {message && <p className="text-amber-300" role="status">{message}</p>}
  </details>;
}
