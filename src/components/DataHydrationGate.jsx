import { useEffect, useState } from 'react';
import { AlertTriangle, Cloud, Database, Loader2 } from 'lucide-react';
import { useAuth } from '@/lib/AuthContext';
import {
  acceptAuthoritativeServerData,
  authorizeServerBootstrap,
  getHydrationState,
  hydrateAccountData,
  startAccountSync,
  stopAccountSync,
  subscribeHydration,
} from '@/lib/dataHydration';

function GateCard({ icon, title, description, children, busy = false }) {
  return (
    <main
      className="fixed inset-0 z-50 flex items-center justify-center bg-[#040D1A] p-6"
      aria-busy={busy}
    >
      <section className="w-full max-w-lg rounded-2xl border border-white/10 bg-[#0F1F35] p-6 shadow-2xl">
        <div className="flex items-start gap-4">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[#6C63FF]/15 text-[#A9A4FF]">
            {icon}
          </div>
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-white">{title}</h1>
            <p className="mt-1 text-sm leading-6 text-slate-300">{description}</p>
          </div>
        </div>
        {children ? <div className="mt-6">{children}</div> : null}
      </section>
    </main>
  );
}

export default function DataHydrationGate({ children }) {
  const { user } = useAuth();
  const [hydration, setHydration] = useState(getHydrationState);
  const [actionPending, setActionPending] = useState(false);

  useEffect(() => subscribeHydration(setHydration), []);

  useEffect(() => {
    if (!user?.id) return undefined;
    void hydrateAccountData({ accountId: String(user.id) });
    return () => stopAccountSync();
  }, [user?.id]);

  useEffect(() => {
    if (hydration.phase === 'ready') startAccountSync();
  }, [hydration.phase]);

  const retry = () => {
    if (user?.id) void hydrateAccountData({ accountId: String(user.id), force: true });
  };

  const hydrationMatchesUser = user?.id && hydration.accountId === String(user.id);
  if (hydrationMatchesUser && hydration.phase === 'ready' && hydration.hydrationComplete) return children;

  if (hydrationMatchesUser && hydration.phase === 'needs-bootstrap') {
    const summary = hydration.localSummary || {};
    return (
      <GateCard
        icon={<Database className="h-5 w-5" aria-hidden="true" />}
        title="Make this account available on every device"
        description="This browser contains hotel data, but the account has no server copy yet. Nothing has been uploaded or deleted. Review the counts, then authorize the first secure account snapshot."
      >
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <div className="rounded-xl bg-white/5 p-3">
            <dt className="text-slate-400">Properties</dt>
            <dd className="mt-1 text-xl font-semibold text-white">{summary.properties || 0}</dd>
          </div>
          <div className="rounded-xl bg-white/5 p-3">
            <dt className="text-slate-400">Data rows</dt>
            <dd className="mt-1 text-xl font-semibold text-white">{summary.rows || 0}</dd>
          </div>
          <div className="rounded-xl bg-white/5 p-3">
            <dt className="text-slate-400">Reports</dt>
            <dd className="mt-1 text-xl font-semibold text-white">{summary.reports || 0}</dd>
          </div>
          <div className="rounded-xl bg-white/5 p-3">
            <dt className="text-slate-400">Settings</dt>
            <dd className="mt-1 text-xl font-semibold text-white">{summary.settings || 0}</dd>
          </div>
        </dl>
        <button
          type="button"
          disabled={actionPending}
          onClick={async () => {
            setActionPending(true);
            await authorizeServerBootstrap();
            setActionPending(false);
          }}
          className="mt-5 flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-[#6C63FF] px-4 py-3 text-sm font-semibold text-white transition hover:bg-[#7A73FF] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#A9A4FF] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0F1F35] disabled:cursor-wait disabled:opacity-60"
        >
          {actionPending ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Cloud className="h-4 w-4" aria-hidden="true" />}
          {actionPending ? 'Creating secure account copy…' : 'Authorize secure account sync'}
        </button>
      </GateCard>
    );
  }

  if (hydrationMatchesUser && hydration.phase === 'conflict') {
    return (
      <GateCard
        icon={<AlertTriangle className="h-5 w-5 text-amber-300" aria-hidden="true" />}
        title="Browser data needs review"
        description={hydration.hydrationError || 'This browser has data that does not match the authoritative account copy. Nothing was overwritten.'}
      >
        <button
          type="button"
          disabled={actionPending}
          onClick={async () => {
            const confirmed = window.confirm(
              'Replace only this browser cache with the authoritative server copy? The server data will not be changed.',
            );
            if (!confirmed) return;
            setActionPending(true);
            await acceptAuthoritativeServerData();
            setActionPending(false);
          }}
          className="min-h-11 w-full rounded-xl border border-amber-300/30 bg-amber-300/10 px-4 py-3 text-sm font-semibold text-amber-100 transition hover:bg-amber-300/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300 disabled:cursor-wait disabled:opacity-60"
        >
          {actionPending ? 'Restoring server copy…' : 'Use authoritative server data on this browser'}
        </button>
      </GateCard>
    );
  }

  if (hydrationMatchesUser && hydration.phase === 'error') {
    return (
      <GateCard
        icon={<AlertTriangle className="h-5 w-5 text-red-300" aria-hidden="true" />}
        title="Hotel data could not be restored"
        description={hydration.hydrationError || 'The account data request failed. KPI pages remain hidden so stale or zero values are not mistaken for real results.'}
      >
        <button
          type="button"
          onClick={retry}
          className="min-h-11 w-full rounded-xl bg-white/10 px-4 py-3 text-sm font-semibold text-white transition hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
        >
          Retry restoration
        </button>
      </GateCard>
    );
  }

  return (
    <GateCard
      busy
      icon={<Loader2 className="h-5 w-5 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
      title="Restoring your hotel data"
      description="Properties, reports, financial data, payroll, settings, and dashboard totals are loading from the account server. KPI pages will appear only after this finishes."
    >
      <p className="text-sm text-slate-400" role="status" aria-live="polite">
        Verifying account and property scope…
      </p>
    </GateCard>
  );
}
