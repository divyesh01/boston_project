import React, { useEffect, useState } from 'react';
import { getSettingsSyncState, subscribeSettingsSync, reviewSettingsConflict, resolveSettingsConflict, flushCloudSettingSync } from '@/lib/settingsStore';

export default function SettingsConflictNotice() {
  const [state, setState] = useState(getSettingsSyncState);
  const [review, setReview] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  useEffect(() => subscribeSettingsSync(() => { setState(getSettingsSyncState()); setReview(null); }), []);
  const act = async fn => { setBusy(true); setError(''); try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(false); } };
  if (!state.conflict && !state.pending) return null;
  return <div className="space-y-3 rounded-xl border border-amber-400/30 bg-amber-400/5 p-4 text-sm text-slate-200" role="status">
    <p>{state.conflict ? 'Settings need review. Your draft is preserved; automatic saving is paused.' : `${state.pending} setting changes ${state.saving ? 'saving to the server' : 'waiting for server acknowledgement'}.`}</p>
    {state.error && <p className="text-red-300">{state.error}</p>}
    {state.conflict && <button disabled={busy} className="rounded border border-white/20 px-3 py-2" onClick={() => act(async () => setReview(await reviewSettingsConflict()))}>Review current server values</button>}
    {!state.conflict && !state.saving && <button disabled={busy} className="rounded border border-white/20 px-3 py-2" onClick={() => act(flushCloudSettingSync)}>Retry saving</button>}
    {review && <div className="space-y-3">
      <p>Server revision {review.revision}. Applying your draft replaces only the settings listed below.</p>
      <div className="max-h-72 overflow-auto">
        {review.drafts.map(d => <details key={`${d.propertyId}:${d.key}`} className="border-t border-white/10 py-2">
          <summary>Property {d.propertyId} · {d.key.replace(/^rri_/, '').replace(/_/g, ' ')}</summary>
          <div className="grid gap-3 py-2 md:grid-cols-2"><div><p>Server value</p><pre className="whitespace-pre-wrap break-all text-xs">{JSON.stringify(d.propertyId === '*' ? review.settings[d.key] : review.settings._byProperty?.[d.propertyId]?.[d.key], null, 2) || 'Unconfigured'}</pre></div><div><p>Your draft</p><pre className="whitespace-pre-wrap break-all text-xs">{JSON.stringify(d.value, null, 2)}</pre></div></div>
        </details>)}
      </div>
      <div className="flex flex-wrap gap-3"><button disabled={busy} className="rounded border border-white/20 px-3 py-2" onClick={() => act(() => resolveSettingsConflict(review, false))}>Discard listed drafts and load server values</button><button disabled={busy} className="rounded border border-amber-400/40 px-3 py-2" onClick={() => act(() => resolveSettingsConflict(review, true))}>Apply my reviewed draft</button></div>
    </div>}
    {error && <p className="text-red-300" role="alert">{error}</p>}
  </div>;
}
