import React, { useEffect, useState } from 'react';
import { getSettingsSyncState, subscribeSettingsSync, reviewSettingsConflict, resolveSettingsConflict, flushCloudSettingSync } from '@/lib/settingsStore';

export default function SettingsConflictNotice() {
  const [state, setState] = useState(getSettingsSyncState);
  const [review, setReview] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [choices, setChoices] = useState({});
  useEffect(() => {
    const unsubscribe = subscribeSettingsSync(() => { setState(getSettingsSyncState()); setReview(null); setChoices({}); });
    return () => { unsubscribe(); };
  }, []);
  const act = async fn => { setBusy(true); setError(''); try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(false); } };
  if (!state.conflict && !state.pending && !state.error) return null;
  const groups = new Map();
  for (const draft of review?.drafts || []) {
    const key = JSON.stringify([draft.propertyId, draft.key]);
    groups.set(key, [...(groups.get(key) || []), draft]);
  }
  const selectedIds = [...groups].flatMap(([key, drafts]) => drafts.length === 1 ? [drafts[0].draftId] : choices[key] ? [choices[key]] : []);
  const choicesComplete = selectedIds.length === groups.size && !(review?.unreadable?.length);
  const downloadRecovery = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(review.unreadable, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'settings-draft-recovery.json'; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <div className="space-y-3 rounded-xl border border-amber-400/30 bg-amber-400/5 p-4 text-sm text-slate-200" role="status">
    <p>{state.conflict ? state.conflict.code === 'SETTINGS_DRAFT_RECOVERED' ? 'Unsynced settings drafts were recovered. Review them before saving; server values are currently displayed.' : 'Settings need review. Your draft is preserved; automatic saving is paused.' : `${state.pending} setting changes ${state.saving ? 'saving to the server' : 'waiting for server acknowledgement'}.`}</p>
    {state.error && <p className="text-red-300">{state.error}</p>}
    {state.conflict && <button disabled={busy} className="rounded border border-white/20 px-3 py-2" onClick={() => act(async () => setReview(await reviewSettingsConflict()))}>Review current server values</button>}
    {!state.conflict && !state.saving && <button disabled={busy} className="rounded border border-white/20 px-3 py-2" onClick={() => act(flushCloudSettingSync)}>Retry saving</button>}
    {review && <div className="space-y-3">
      <p>Server revision {review.revision}. Applying your draft replaces only the settings listed below.</p>
      {review.unreadable?.length > 0 && <div className="space-y-2"><p>{review.unreadable.length} stored draft records could not be parsed. Download them for recovery before explicitly discarding the listed drafts.</p><button className="rounded border border-white/20 px-3 py-2" onClick={downloadRecovery}>Download unreadable draft records</button></div>}
      <div className="max-h-72 overflow-auto">
        {review.drafts.map(d => <details key={d.draftId || `${d.propertyId}:${d.key}`} className="border-t border-white/10 py-2">
          <summary>Property {d.propertyId} · {d.key.replace(/^rri_/, '').replace(/_/g, ' ')}</summary>
          {(groups.get(JSON.stringify([d.propertyId, d.key]))?.length || 0) > 1 && <label className="flex items-center gap-2 py-2"><input type="radio" name={JSON.stringify([d.propertyId, d.key])} checked={choices[JSON.stringify([d.propertyId, d.key])] === d.draftId} onChange={() => setChoices(old => ({ ...old, [JSON.stringify([d.propertyId, d.key])]: d.draftId }))} />Use this draft (created {new Date(d.createdAt).toLocaleString()})</label>}
          <div className="grid gap-3 py-2 md:grid-cols-2"><div><p>Server value</p><pre className="whitespace-pre-wrap break-all text-xs">{JSON.stringify(d.propertyId === '*' ? review.settings[d.key] : review.settings._byProperty?.[d.propertyId]?.[d.key], null, 2) || 'Unconfigured'}</pre></div><div><p>Your draft</p><pre className="whitespace-pre-wrap break-all text-xs">{JSON.stringify(d.value, null, 2)}</pre></div></div>
        </details>)}
      </div>
      {!choicesComplete && !review.unreadable?.length && <p>Several drafts exist for the same setting. Choose one for each setting before applying.</p>}
      <div className="flex flex-wrap gap-3"><button disabled={busy} className="rounded border border-white/20 px-3 py-2" onClick={() => act(() => resolveSettingsConflict(review, false))}>Discard listed drafts and load server values</button><button disabled={busy || !choicesComplete} className="rounded border border-amber-400/40 px-3 py-2" onClick={() => act(() => resolveSettingsConflict(review, true, selectedIds))}>Apply my reviewed draft</button></div>
    </div>}
    {error && <p className="text-red-300" role="alert">{error}</p>}
  </div>;
}
