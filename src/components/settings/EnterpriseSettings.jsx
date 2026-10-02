import React, { useState } from 'react';
import Card from '@/components/ui-exec/Card';
import { useGlobalFilters } from '@/lib/useGlobalFilters';
import { useSettingsVersion } from '@/hooks/useSettingsVersion';
import { getPropertyProfile, getEnterpriseConfig, savePropertyProfile, previewBulkPolicy, applyBulkPolicy, saveEnterpriseTemplate, saveEnterpriseDefaults } from '@/lib/enterpriseConfigEngine';
import { CLUSTERS, PMS_ADAPTERS } from '@/lib/enterpriseSchema';
import { closeNightAudit } from '@/lib/businessDate';
import { flushCloudSettingSync } from '@/lib/settingsStore';
import { useAuth } from '@/lib/AuthContext';
import { money2 } from '@/lib/hotel';

const inputClass = 'w-full rounded-lg border border-white/15 bg-[#0A1628] px-3 py-2 text-sm text-white';
function Field({ label, value, onChange, type = 'text', disabled = false, step = undefined }) {
  return <label className="space-y-1 text-xs text-slate-400"><span>{label}</span><input className={inputClass} type={type} value={value ?? ''} disabled={disabled} step={step} onChange={e => onChange(e.target.value)} /></label>;
}
const numeric = value => value === '' ? undefined : Number(value);

export default function EnterpriseSettings() {
  const { properties, property, dateRange } = useGlobalFilters();
  const { user } = useAuth();
  useSettingsVersion();
  const [selected, setSelected] = useState(() => typeof property !== 'object' && property !== 'all' ? String(property) : '');
  const [region, setRegion] = useState(''), [tab, setTab] = useState('Properties'), [index, setIndex] = useState(0);
  const [drafts, setDrafts] = useState({}), [preview, setPreview] = useState(null), [message, setMessage] = useState('');
  const roster = region ? properties.filter(p => getPropertyProfile(p.id)?.region === region || (getPropertyProfile(p.id)?.state || p.state || '') === region) : properties;
  const p = properties.find(row => String(row.id) === selected);
  const profile = drafts[selected] || getPropertyProfile(selected) || { state: p?.state || '', region: '', timezone: '', current_business_date: '', night_audit_status: 'OPEN', pms: 'hotelkey', employer_of_record: '', periods: [] };
  const period = profile.periods?.[index] || { effective_start: dateRange.to || '', effective_end: '' };
  const cfg = p ? getEnterpriseConfig(p.id, dateRange.to, p) : {};
  const updateProfile = change => { setDrafts(old => ({ ...old, [selected]: { ...profile, ...change } })); setPreview(null); setMessage(''); };
  const updatePeriod = change => { const periods = [...(profile.periods || [])]; periods[index] = { ...period, ...change }; updateProfile({ periods }); };
  const run = fn => { try { fn(); setMessage('Draft stored locally. Check the server save status above before leaving.'); flushCloudSettingSync().catch(e => setMessage(e.message)); } catch (e) { setMessage(e.message); } };
  const regions = [...new Set(properties.flatMap(row => [getPropertyProfile(row.id)?.region, getPropertyProfile(row.id)?.state || row.state]).filter(Boolean))].sort();
  let permissions = user?.permissions;
  try { if (typeof permissions === 'string') permissions = JSON.parse(permissions); } catch { permissions = {}; }
  const canManage = ['owner', 'admin'].includes(String(user?.role).toLowerCase()) || permissions?.manage_settings === true;
  return <Card title="Portfolio configuration" subtitle="Global → state → region → property. Dated policies apply to their business dates; imported history stays intact.">
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2"><label className="text-xs text-slate-400">State / region<select className={inputClass} value={region} onChange={e => { setRegion(e.target.value); setSelected(''); setPreview(null); }}><option value="">All accessible properties</option>{regions.map(r => <option key={r}>{r}</option>)}</select></label><label className="text-xs text-slate-400">Property<select className={inputClass} value={selected} onChange={e => { setSelected(e.target.value); setIndex(0); setPreview(null); setMessage(''); }}><option value="">Select one property</option>{roster.map(row => <option key={row.id} value={String(row.id)}>{row.code} · {row.name}</option>)}</select></label></div>
      {p && <>
        <div className="flex flex-wrap gap-2" role="tablist">{['Properties', 'Thresholds', 'Taxes', 'Labor', 'Channels'].map(name => <button role="tab" aria-selected={tab === name} className={`rounded-lg border px-3 py-2 text-xs ${tab === name ? 'border-cyan-400 text-cyan-300' : 'border-white/10 text-slate-400'}`} key={name} onClick={() => setTab(name)}>{name}</button>)}</div>
        {tab === 'Properties' ? <div className="grid gap-3 sm:grid-cols-2">
          <Field label="State" value={profile.state} onChange={state => updateProfile({ state })} /><Field label="Demand region" value={profile.region} onChange={region => updateProfile({ region })} />
          <Field label="Property time zone (IANA, e.g. America/New_York)" value={profile.timezone} onChange={timezone => updateProfile({ timezone })} />
          <Field label="Current business date" type="date" value={profile.current_business_date} disabled={!!getPropertyProfile(selected)?.current_business_date} onChange={current_business_date => updateProfile({ current_business_date })} />
          <Field label="Employer of record (legal name)" value={profile.employer_of_record} onChange={employer_of_record => updateProfile({ employer_of_record })} />
          <Field label="Reviewed employer group ID for overtime" value={profile.employer_group_id} onChange={employer_group_id => updateProfile({ employer_group_id })} />
          <p className="text-xs text-slate-400">{p.rooms || 'Unconfigured'} rooms in the property roster · audit {profile.night_audit_status}. Advancing closes this date and opens the next date.</p>
          <button disabled={!canManage || !profile.current_business_date} className="rounded border border-amber-400/30 p-2 text-xs text-amber-200" onClick={() => run(() => { savePropertyProfile(selected, closeNightAudit(profile)); setDrafts(old => { const next = { ...old }; delete next[selected]; return next; }); })}>Close night audit and advance business date</button>
        </div> : <>
          <div className="grid gap-3 sm:grid-cols-3"><label className="text-xs text-slate-400">Policy period<select className={inputClass} value={index} onChange={e => setIndex(Number(e.target.value))}>{(profile.periods?.length ? profile.periods : [period]).map((row, i) => <option key={i} value={i}>{row.effective_start || 'Default'} → {row.effective_end || 'ongoing'}</option>)}</select></label><Field label="Effective from" type="date" value={period.effective_start} onChange={effective_start => updatePeriod({ effective_start })} /><Field label="Effective through (optional)" type="date" value={period.effective_end} onChange={effective_end => updatePeriod({ effective_end })} /></div>
          <button className="rounded border border-white/15 px-3 py-2 text-xs text-slate-300" onClick={() => { const periods = [...(profile.periods || []), { effective_start: dateRange.to || '', effective_end: '' }]; updateProfile({ periods }); setIndex(periods.length - 1); }}>Add policy period</button>
          {tab === 'Thresholds' && <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs text-slate-400">Demand cluster<select className={inputClass} value={period.cluster || ''} onChange={e => updatePeriod({ cluster: e.target.value || undefined })}><option value="">Inherit / existing revenue bands</option>{Object.entries(CLUSTERS).map(([key, row]) => <option key={key} value={key}>{row.label}</option>)}</select></label>
            <Field label="Capacity override (rooms)" type="number" value={period.capacity} onChange={v => updatePeriod({ capacity: numeric(v) })} />
            {[['high_revpar', 'High RevPAR target'], ['medium_revpar', 'Medium RevPAR target'], ['cpor', 'Estimated operating cost per occupied room'], ['margin_high', 'High daily room contribution target'], ['rate_floor', 'Rate floor'], ['rate_ceiling', 'Rate ceiling']].map(([key, label]) => <Field key={key} label={label} type="number" step="0.01" value={period[key]} onChange={v => updatePeriod({ [key]: numeric(v) })} />)}
            <p className="text-xs text-slate-400">Current resolved capacity: {cfg.capacity ?? 'needs setup'}. Room contribution is revenue minus occupied rooms × configured cost; it is an estimate before other costs.</p>
          </div>}
          {tab === 'Taxes' && <div className="space-y-3">
            <p className="text-xs text-slate-400">Configure reviewed rates, flat fees and exemption durations. Imported tax lines always win. Marketplace remittance needs statement evidence; a channel name does not exclude a liability.</p>
            {(period.tax_jurisdictions || []).map((j, i) => { const edit = change => updatePeriod({ tax_jurisdictions: period.tax_jurisdictions.map((row, k) => k === i ? { ...row, ...change } : row) }); return <div key={j.id} className="grid gap-3 rounded-xl border border-white/10 p-3 sm:grid-cols-3">
              <Field label="Tax name" value={j.label} onChange={label => edit({ label })} />
              <label className="text-xs text-slate-400">Jurisdiction<select className={inputClass} value={j.kind} onChange={e => edit({ kind: e.target.value })}>{['state', 'county', 'city', 'district', 'other'].map(k => <option key={k}>{k}</option>)}</select></label>
              <label className="text-xs text-slate-400">Calculation<select className={inputClass} value={j.type} onChange={e => edit({ type: e.target.value, rate: 0 })}><option value="percentage">Percentage of taxable room revenue</option><option value="flat_per_night">Amount per occupied room-night</option></select></label>
              <Field label={j.type === 'percentage' ? 'Rate (%)' : 'Fee per room-night ($)'} type="number" step="0.01" value={j.type === 'percentage' ? j.rate * 100 : j.rate} onChange={v => edit({ rate: Number(v) / (j.type === 'percentage' ? 100 : 1) })} />
              <Field label="Exempt at stay duration (nights, optional)" type="number" value={j.exempt_after_nights} onChange={v => edit({ exempt_after_nights: numeric(v) })} />
              <label className="text-xs text-slate-400">Expected remitter<select className={inputClass} value={j.remitter || 'hotel'} onChange={e => edit({ remitter: e.target.value })}><option value="hotel">Hotel</option><option value="marketplace">Marketplace with evidence</option></select></label>
              <Field label="Rate source URL / policy reference" value={j.source_url} onChange={source_url => edit({ source_url })} />
              <label className="flex items-center gap-2 text-xs text-slate-300"><input type="checkbox" checked={j.reviewed === true} onChange={e => edit({ reviewed: e.target.checked })} />I reviewed this rate and period</label>
              <button className="text-xs text-red-300" onClick={() => updatePeriod({ tax_jurisdictions: period.tax_jurisdictions.filter((_, k) => k !== i) })}>Remove jurisdiction</button>
            </div>; })}
            {!period.tax_jurisdictions && <p className="text-xs text-amber-200">No enterprise tax override for this period. Existing explicitly configured tax settings apply.</p>}
            <button className="rounded border border-white/15 px-3 py-2 text-xs text-slate-300" onClick={() => updatePeriod({ tax_jurisdictions: [...(period.tax_jurisdictions || []), { id: crypto.randomUUID(), kind: 'state', label: 'State tax', type: 'percentage', rate: 0, remitter: 'hotel', reviewed: false }] })}>Add jurisdiction</button>
          </div>}
          {tab === 'Labor' && <div className="grid gap-3 sm:grid-cols-2">
            <p className="col-span-full text-xs text-slate-400">Use reviewed state and local policy values for this period. Monthly totals alone cannot prove weekly or daily overtime.</p>
            {[['minimum_wage', 'Minimum hourly wage'], ['weekly_overtime_hours', 'Weekly overtime after hours'], ['daily_overtime_hours', 'Daily overtime after hours (optional)'], ['overtime_multiplier', 'Overtime multiplier'], ['reporting_pay_hours', 'Reporting pay minimum when applicable'], ['sick_leave_hours_per_hour', 'Sick leave accrued per worked hour'], ['workweek_start', 'Workweek start (Sunday 0 … Saturday 6)']].map(([key, label]) => <Field key={key} label={label} type="number" step="0.01" value={period.labor_policy?.[key]} onChange={v => updatePeriod({ labor_policy: { ...period.labor_policy, [key]: numeric(v) } })} />)}
            <Field label="Official policy source URL" value={period.labor_policy?.source_url} onChange={source_url => updatePeriod({ labor_policy: { ...period.labor_policy, source_url } })} />
            <label className="flex items-center gap-2 text-xs text-slate-300"><input type="checkbox" checked={period.labor_policy?.reviewed === true} onChange={e => updatePeriod({ labor_policy: { ...period.labor_policy, reviewed: e.target.checked } })} />I reviewed the applicable policy</label>
          </div>}
          {tab === 'Channels' && <label className="block text-xs text-slate-400">PMS adapter<select className={inputClass} value={profile.pms || 'hotelkey'} onChange={e => updateProfile({ pms: e.target.value })}>{PMS_ADAPTERS.map(k => <option key={k} value={k}>{k === 'canonical_csv' ? 'Mapped CSV' : k}</option>)}</select><p className="mt-2">HotelKey reports retain their existing parser. Other systems use supported daily-summary columns; unfamiliar layouts require a mapping.</p></label>}
          <div className="flex flex-wrap gap-2">
            <button disabled={!canManage} className="rounded border border-white/15 px-3 py-2 text-xs text-slate-300" onClick={() => { try { setPreview(previewBulkPolicy(roster, period)); setMessage(''); } catch (e) { setMessage(e.message); } }}>Preview this policy for {roster.length} properties in this selection</button>
            {['owner', 'admin'].includes(String(user?.role).toLowerCase()) && <><button className="rounded border border-white/15 px-3 py-2 text-xs text-slate-300" onClick={() => run(() => saveEnterpriseDefaults([period]))}>Save global default policy</button><button className="rounded border border-white/15 px-3 py-2 text-xs text-slate-300" disabled={!profile.state} onClick={() => run(() => saveEnterpriseTemplate('states', profile.state, [period]))}>Save state template</button><button className="rounded border border-white/15 px-3 py-2 text-xs text-slate-300" disabled={!profile.region} onClick={() => run(() => saveEnterpriseTemplate('regions', profile.region, [period]))}>Save region template</button></>}
          </div>
        </>}
        {preview && <div className="space-y-2 rounded-xl border border-amber-400/30 p-3 text-xs text-slate-300"><p>Apply {period.effective_start || 'default'} → {period.effective_end || 'ongoing'}; {period.cluster || 'existing cluster'}. Unrelated dates and property identities are preserved.</p>{preview.map(row => <p key={row.property.id}>{row.property.name} · {row.property.rooms || 'unknown'} rooms · high target {period.high_revpar != null || period.cluster ? money2((period.high_revpar ?? CLUSTERS[period.cluster]?.high_revpar ?? 0) * (period.capacity ?? row.property.rooms ?? 0)) : 'existing bands'}</p>)}<button disabled={!canManage} className="rounded border border-amber-400/40 px-3 py-2" onClick={() => run(() => { applyBulkPolicy(preview); setPreview(null); setDrafts({}); })}>Apply reviewed changes to these properties</button></div>}
        <button disabled={!canManage} className="rounded-lg bg-cyan-500/20 px-4 py-2 text-sm text-cyan-200" onClick={() => run(() => { savePropertyProfile(selected, profile); setDrafts(old => { const next = { ...old }; delete next[selected]; return next; }); })}>Save selected property</button>
        {message && <p className="text-sm text-amber-200" role="status">{message}</p>}
      </>}
    </div>
  </Card>;
}
