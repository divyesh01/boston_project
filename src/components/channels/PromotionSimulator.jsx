import React, { useState } from 'react';
import Card from '@/components/ui-exec/Card';
import { calculatePromotionStack } from '@/lib/promotionStacking';
import { PROMOTION_KEY } from '@/lib/enterpriseSchema';
import { readScopedJsonSetting, writeJsonSetting, flushCloudSettingSync } from '@/lib/settingsStore';
import { money2 } from '@/lib/hotel';
import { useAuth } from '@/lib/AuthContext';

const example = { nightly_rate: 120, discounts: [{ name: 'Genius', rate: .15 }, { name: 'Mobile', rate: .10 }], commission_rate: .18, card_rate: .034, break_even: 88 };
export default function PromotionSimulator({ propertyId }) {
  const { user } = useAuth();
  let permissions = user?.permissions;
  try { if (typeof permissions === 'string') permissions = JSON.parse(permissions); } catch { permissions = {}; }
  const canSave = ['owner', 'admin'].includes(String(user?.role).toLowerCase()) || permissions?.manage_settings === true || permissions?.manage_ota_commissions === true;
  const [form, setForm] = useState(() => readScopedJsonSetting(PROMOTION_KEY, example, propertyId));
  const [message, setMessage] = useState('');
  let result, error;
  try { result = calculatePromotionStack(form); } catch (e) { error = e.message; }
  const field = (key, label, percent = false) => <label className="space-y-1 text-xs text-slate-400"><span>{label}</span><input type="number" min="0" step="0.01" value={percent ? form[key] * 100 : form[key]} className="w-full rounded-lg border border-white/15 bg-[#0A1628] px-3 py-2 text-white" onChange={e => setForm({ ...form, [key]: Number(e.target.value) / (percent ? 100 : 1) })} /></label>;
  return <Card title="Promotion stacking and room margin" subtitle="Scenario only. Example inputs are editable; saving never changes reservations or the financial ledger.">
    <div className="space-y-4"><div className="grid gap-3 sm:grid-cols-4">{field('nightly_rate', 'Listed nightly rate ($)')}{field('commission_rate', 'OTA commission (%)', true)}{field('card_rate', 'Card fee (%)', true)}{field('break_even', 'Room break-even cost ($)')}</div>
      <div className="flex flex-wrap gap-3">{form.discounts.map((d, i) => <label key={i} className="text-xs text-slate-400">{d.name} discount (%)<input className="ml-2 w-24 rounded border border-white/15 bg-[#0A1628] p-2 text-white" type="number" min="0" max="100" value={d.rate * 100} onChange={e => setForm({ ...form, discounts: form.discounts.map((row, k) => k === i ? { ...row, rate: Number(e.target.value) / 100 } : row) })} /></label>)}</div>
      {result && <div className="space-y-2 text-sm text-slate-300"><p>Listed {money2(result.listed)}{result.steps.map((s, i) => <span key={i}> → {s.name} {money2(s.remaining)}</span>)}</p><p>Commission {money2(result.commission)} + card fee {money2(result.card)} on discounted revenue {money2(result.discounted)}</p><p className={result.belowBreakEven ? 'text-red-300' : 'text-emerald-300'}>Net retained {money2(result.net)} · room contribution {money2(result.contribution)}{result.belowBreakEven ? ' · below configured break-even' : ''}</p></div>}
      {(error || message) && <p className="text-sm text-amber-200" role="status">{error || message}</p>}
      <button disabled={!!error || !canSave} className="rounded-lg border border-cyan-400/30 px-3 py-2 text-sm text-cyan-200 disabled:opacity-40" onClick={() => { if (!canSave) return; if (!writeJsonSetting(PROMOTION_KEY, form, propertyId)) { setMessage('Could not store the scenario.'); return; } flushCloudSettingSync().catch(e => setMessage(e.message)); setMessage('Scenario stored locally; check Settings for cloud save status.'); }}>Save this property’s scenario</button>
      {!canSave && <p className="text-xs text-slate-400">You can preview a scenario; saving requires settings or commission permission.</p>}
    </div>
  </Card>;
}
