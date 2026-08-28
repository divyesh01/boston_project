import React from 'react';
import Card from '@/components/ui-exec/Card';

// There is no production OTA adapter in this standalone build. Do not expose
// the legacy simulation: its sample reservations must never enter owner data.
export default function ChannelManager() {
  return (
    <div className="space-y-6">
      <header>
        <p className="text-[11px] uppercase tracking-[0.3em] text-[#00D4FF]">Operations</p>
        <h1 className="mt-2 font-heading text-3xl font-semibold text-white">Channel Manager</h1>
        <p className="mt-2 text-sm text-slate-300">OTA connections are unavailable in this standalone app.</p>
      </header>
      <Card title="No live OTA connection" subtitle="Connection, reservation sync, and rate publishing are disabled.">
        <p className="text-sm leading-relaxed text-slate-300">Use each OTA’s own dashboard to manage rates, availability, and bookings. Imported reports in this app are for analysis; they do not update your OTA accounts.</p>
        <div className="mt-5 grid gap-3 sm:grid-cols-3">
          {['Booking.com', 'Expedia', 'Airbnb'].map((name) => (
            <div key={name} className="rounded-xl border border-white/10 p-4">
              <h2 className="font-semibold text-white">{name}</h2>
              <p className="mt-1 text-sm text-slate-300">Not connected</p>
              <button type="button" disabled aria-label={`${name} connection unavailable`} className="mt-3 min-h-11 w-full cursor-not-allowed rounded-lg border border-white/20 px-3 py-2 text-sm text-slate-400">Unavailable</button>
            </div>
          ))}
        </div>
        <p className="mt-4 text-sm text-amber-200">No sample reservations will be imported from this page. Real sync requires a separately implemented and verified server integration.</p>
      </Card>
    </div>
  );
}
