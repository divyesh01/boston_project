import React, { useState } from 'react';
import { CheckCircle2, DatabaseBackup, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import { businessData } from '@/api/base44Client';
import Card from '@/components/ui-exec/Card';
import { formatCents } from '@/lib/decimal';

const SYNC_ENABLED = import.meta.env?.VITE_USE_SERVER_DATA_SYNC === 'true';

export default function BusinessMigrationCard() {
  const [baseline, setBaseline] = useState(null);
  const [confirmed, setConfirmed] = useState(false);
  const [working, setWorking] = useState(false);
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  if (!SYNC_ENABLED) return null;

  const inspect = async () => {
    setWorking(true);
    setError('');
    setResult(null);
    try {
      const snapshot = await businessData.inspectLocalBusinessData();
      setBaseline(snapshot);
      setProgress({ phase: 'review' });
    } catch (failure) {
      setError(failure?.message || 'Local business-data inspection failed.');
    } finally {
      setWorking(false);
    }
  };

  const migrate = async () => {
    if (!baseline || !confirmed) return;
    setWorking(true);
    setError('');
    setResult(null);
    try {
      const completed = await businessData.migrateLocalData({ snapshot: baseline, onProgress: setProgress });
      setResult(completed);
    } catch (failure) {
      setError(failure?.message || 'Migration stopped. Your browser data was not cleared.');
    } finally {
      setWorking(false);
    }
  };

  const currentStep = progress?.phase === 'active' ? 4 : progress?.phase === 'upload' ? 3 : progress?.phase === 'backup' ? 2 : baseline ? 1 : 0;

  return (
    <Card title="Cross-browser business data" subtitle="Back up this browser, then make its verified dataset authoritative for this account">
      <div className="space-y-4">
        <div className="grid gap-2 sm:grid-cols-4" aria-label={`Migration step ${currentStep} of 4`}>
          {['Inspect', 'Back up', 'Upload', 'Activate'].map((label, index) => (
            <div key={label} className={`rounded-lg border px-3 py-2 text-xs ${index < currentStep ? 'border-[#00E096]/30 bg-[#00E096]/10 text-[#00E096]' : index === currentStep ? 'border-[#00D4FF]/40 bg-[#00D4FF]/10 text-[#00D4FF]' : 'border-white/10 text-slate-500'}`}>
              {index < currentStep ? '✓ ' : `${index + 1}. `}{label}
            </div>
          ))}
        </div>

        <div className="rounded-xl border border-white/10 bg-[#0A1628]/60 p-4">
          <div className="flex items-start gap-3">
            <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-[#00E096]" aria-hidden="true" />
            <div className="space-y-1 text-sm text-slate-300">
              <p className="font-medium text-white">Your existing IndexedDB data is never cleared by this migration.</p>
              <p className="text-xs leading-5 text-slate-400">A JSON backup downloads before the first server write. Interrupted uploads stay invisible and can be resumed safely; activation happens only after counts and hashes reconcile.</p>
            </div>
          </div>
        </div>

        {!baseline && (
          <button type="button" onClick={inspect} disabled={working} className="flex min-h-11 items-center gap-2 rounded-lg bg-[#6C63FF] px-4 text-sm font-medium text-white hover:bg-[#5b52e8] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#00D4FF] disabled:opacity-50">
            {working ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <DatabaseBackup className="h-4 w-4" aria-hidden="true" />}
            {working ? 'Inspecting local data…' : 'Inspect local dataset'}
          </button>
        )}

        {baseline && !result && (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Metric label="Properties" value={baseline.manifest.counts.Property} />
              <Metric label="Total records" value={baseline.total_records} />
              <Metric label="Revenue baseline" value={formatCents(baseline.manifest.financials.revenue_cents)} />
              <Metric label="Payments baseline" value={formatCents(baseline.manifest.financials.payments_cents)} />
            </div>
            <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-white/10 p-3 text-sm text-slate-300">
              <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} className="mt-1 h-4 w-4 rounded border-white/20" />
              <span>I reviewed this Browser A baseline and understand it will become the account’s authoritative server dataset.</span>
            </label>
            <div className="flex flex-wrap gap-3">
              <button type="button" onClick={migrate} disabled={working || !confirmed} className="flex min-h-11 items-center gap-2 rounded-lg bg-[#00D4FF] px-4 text-sm font-semibold text-[#040D1A] hover:bg-[#00b8e0] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#00D4FF] disabled:opacity-50">
                {working ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <DatabaseBackup className="h-4 w-4" aria-hidden="true" />}
                {working ? progress?.phase === 'upload' ? `Uploading chunk ${progress.completed_chunks} of ${progress.total_chunks}…` : 'Preparing secure migration…' : 'Back up and migrate'}
              </button>
              <button type="button" onClick={inspect} disabled={working} className="flex min-h-11 items-center gap-2 rounded-lg border border-white/15 px-4 text-sm text-slate-300 hover:bg-white/5 disabled:opacity-50">
                <RefreshCw className="h-4 w-4" aria-hidden="true" /> Re-inspect
              </button>
            </div>
          </div>
        )}

        {result && (
          <div role="status" className="flex items-start gap-3 rounded-xl border border-[#00E096]/30 bg-[#00E096]/10 p-4">
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-[#00E096]" aria-hidden="true" />
            <div>
              <p className="font-medium text-white">Authoritative migration activated</p>
              <p className="mt-1 text-xs text-slate-300">{result.status.received_records} records reconciled. Backup: {result.backup_filename}. Clean browsers can now rebuild from generation {result.generation_id}.</p>
            </div>
          </div>
        )}

        {error && (
          <div role="alert" className="rounded-xl border border-[#FF6B6B]/30 bg-[#FF6B6B]/10 p-4 text-sm text-[#FF9B9B]">
            <p>{error}</p>
            <button type="button" onClick={inspect} disabled={working} className="mt-3 min-h-11 rounded-lg border border-[#FF6B6B]/40 px-4 text-sm text-white hover:bg-[#FF6B6B]/10 disabled:opacity-50">Inspect again</button>
          </div>
        )}
      </div>
    </Card>
  );
}

function Metric({ label, value }) {
  return (
    <div className="rounded-lg border border-white/10 bg-[#040D1A]/50 p-3">
      <p className="text-[11px] uppercase tracking-wider text-slate-500">{label}</p>
      <p className="mt-1 text-lg font-semibold text-white">{value}</p>
    </div>
  );
}
