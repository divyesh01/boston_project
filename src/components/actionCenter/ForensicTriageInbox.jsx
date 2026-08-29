import React, { useState, useMemo } from 'react';
import {
  ShieldAlert, ShieldCheck, AlertTriangle, CheckCircle, Search, Filter,
  DollarSign, Clock, User, Home, ArrowRight, Check, X, Sparkles
} from 'lucide-react';
import {
  SEVERITY_LEVELS,
  REVIEW_STATES,
  OWNER_PRESETS,
  applyOwnerPreset,
} from '../../lib/ownerForensicEngine.js';
import {
  persistOwnerReviewAction,
  persistWhitelistRule,
} from '../../lib/ownerForensicPersistence.js';
import { toast } from '../ui/use-toast';

const SEVERITY_STYLE = {
  [SEVERITY_LEVELS.CRITICAL]: { badge: 'bg-red-500/20 text-red-400 border-red-500/30', border: 'border-l-red-500', icon: ShieldAlert },
  [SEVERITY_LEVELS.HIGH]: { badge: 'bg-amber-500/20 text-amber-400 border-amber-500/30', border: 'border-l-amber-500', icon: AlertTriangle },
  [SEVERITY_LEVELS.MEDIUM]: { badge: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30', border: 'border-l-yellow-500', icon: AlertTriangle },
  [SEVERITY_LEVELS.LOW]: { badge: 'bg-blue-500/20 text-blue-400 border-blue-500/30', border: 'border-l-blue-500', icon: CheckCircle },
  [SEVERITY_LEVELS.WHITELISTED]: { badge: 'bg-purple-500/20 text-purple-400 border-purple-500/30', border: 'border-l-purple-500', icon: ShieldCheck },
  [SEVERITY_LEVELS.EXPECTED_ROUTINE]: { badge: 'bg-slate-500/20 text-slate-400 border-slate-500/30', border: 'border-l-slate-500', icon: CheckCircle },
  [SEVERITY_LEVELS.RESOLVED]: { badge: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30', border: 'border-l-emerald-500', icon: CheckCircle },
};

export default function ForensicTriageInbox({
  anomalies = [],
  propertyId = 'default',
  onStateChange,
}) {
  const [preset, setPreset] = useState('CRITICAL_HIGH');
  const [search, setSearch] = useState('');
  const [actionInProgress, setActionInProgress] = useState(null);

  const filtered = useMemo(() => {
    let list = anomalies;

    if (preset === 'CRITICAL_HIGH') {
      list = list.filter((a) => (a.severity === SEVERITY_LEVELS.CRITICAL || a.severity === SEVERITY_LEVELS.HIGH) && a.reviewState === REVIEW_STATES.UNREVIEWED);
    } else if (preset !== 'ALL') {
      list = applyOwnerPreset(list, preset);
    }

    if (search.trim()) {
      const q = search.toLowerCase().trim();
      list = list.filter((a) =>
        String(a.folioNumber || '').toLowerCase().includes(q) ||
        String(a.roomNumber || '').toLowerCase().includes(q) ||
        String(a.username || '').toLowerCase().includes(q) ||
        String(a.whyFlagged || '').toLowerCase().includes(q) ||
        String(a.transactionCode || '').toLowerCase().includes(q)
      );
    }

    return list;
  }, [anomalies, preset, search]);

  const handleAction = async (anomaly, newState) => {
    setActionInProgress(anomaly.id);
    try {
      await persistOwnerReviewAction({
        propertyId,
        anomalyId: anomaly.id,
        previousState: anomaly.reviewState,
        newState,
        actor: 'Owner',
        reason: `Owner triage: marked as ${newState}`,
      });

      toast({
        title: `Anomaly marked as ${newState}`,
        description: `Audit trail updated for folio ${anomaly.folioNumber || 'N/A'}.`,
      });

      if (onStateChange) onStateChange();
    } catch (err) {
      toast({
        title: 'Action failed',
        description: err.message,
        variant: 'destructive',
      });
    } finally {
      setActionInProgress(null);
    }
  };

  const handleWhitelist = async (anomaly) => {
    setActionInProgress(anomaly.id);
    try {
      await persistWhitelistRule({
        propertyId,
        rule: {
          folioNumber: anomaly.folioNumber,
          roomNumber: anomaly.roomNumber,
          authorizedRate: anomaly.amount,
          reason: 'Owner authorized stay from Action Center triage',
        },
        actor: 'Owner',
      });

      await persistOwnerReviewAction({
        propertyId,
        anomalyId: anomaly.id,
        previousState: anomaly.reviewState,
        newState: REVIEW_STATES.WHITELISTED,
        actor: 'Owner',
        reason: 'Added to approved whitelist',
      });

      toast({
        title: 'Whitelist Rule Added',
        description: `Folio ${anomaly.folioNumber || 'N/A'} is now an approved stay. Future rate deviations will re-alert.`,
      });

      if (onStateChange) onStateChange();
    } catch (err) {
      toast({
        title: 'Whitelist failed',
        description: err.message,
        variant: 'destructive',
      });
    } finally {
      setActionInProgress(null);
    }
  };

  return (
    <div className="rounded-2xl border border-white/10 bg-[#0F1F35]/90 p-5 backdrop-blur-md">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-white/5 pb-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-red-500/20 text-red-400">
              <ShieldAlert className="h-4 w-4" />
            </span>
            <h3 className="font-heading text-base font-semibold text-white">Owner Forensic Triage Inbox</h3>
            <span className="rounded-full bg-red-500/20 px-2 py-0.5 text-xs font-semibold text-red-400">
              {filtered.length} prioritized
            </span>
          </div>
          <p className="mt-1 text-xs text-slate-400">
            Explainable anomaly queue. Zero alert fatigue, 100% financial evidence preserved.
          </p>
        </div>

        {/* Search */}
        <div className="relative min-w-[220px]">
          <Search className="absolute left-3 top-2.5 h-3.5 w-3.5 text-slate-500" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search folio, clerk, room..."
            className="w-full rounded-xl border border-white/10 bg-[#0A1628] py-1.5 pl-9 pr-3 text-xs text-white placeholder-slate-500 focus:border-[#6C63FF] focus:outline-none"
          />
        </div>
      </div>

      {/* Preset Filter Bar */}
      <div className="mt-4 flex flex-wrap gap-1.5 overflow-x-auto pb-1">
        {[
          ['CRITICAL_HIGH', '🚨 Critical & High Queue'],
          ['ALL', 'All Anomalies'],
          [OWNER_PRESETS.HIGH_RISK_CASH_AND_VOIDS, '💵 Cash & Voids'],
          [OWNER_PRESETS.DEEP_DISCOUNTS_AND_FREE_STAYS, '🏷️ Deep Discounts & Comps'],
          [OWNER_PRESETS.OFF_SHIFT_MANUAL_ACTIVITY, '🌙 Off-Shift Manual'],
          [OWNER_PRESETS.HOUSE_STAFF_AUDIT, '🏢 House & Staff Stays'],
        ].map(([key, label]) => (
          <button
            key={key}
            onClick={() => setPreset(key)}
            className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
              preset === key
                ? 'bg-[#6C63FF] text-white shadow-sm'
                : 'border border-white/5 bg-[#0A1628]/60 text-slate-400 hover:bg-white/5 hover:text-white'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Anomaly Cards List */}
      <div className="mt-4 space-y-3">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-white/10 py-10 text-center">
            <CheckCircle className="h-8 w-8 text-emerald-400/60" />
            <p className="mt-2 text-sm font-medium text-slate-300">All prioritized items reviewed</p>
            <p className="mt-0.5 text-xs text-slate-500">No unreviewed anomalies match the selected filter.</p>
          </div>
        ) : (
          filtered.slice(0, 15).map((a) => {
            const style = SEVERITY_STYLE[a.severity] || SEVERITY_STYLE[SEVERITY_LEVELS.MEDIUM];
            const isProcessing = actionInProgress === a.id;

            return (
              <div
                key={a.id}
                className={`group rounded-xl border border-white/5 border-l-4 ${style.border} bg-[#0A1628]/80 p-4 transition-all hover:border-white/15`}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  {/* Left info */}
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className={`rounded-md border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${style.badge}`}>
                        {a.severity}
                      </span>
                      <span className="text-xs font-semibold text-white">
                        {a.date} · {a.time || 'Time N/A'}
                      </span>
                      {a.isOnShift ? (
                        <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[9px] text-emerald-400">On Shift</span>
                      ) : (
                        <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[9px] text-amber-400">Off Shift</span>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-300">
                      <span><strong>Folio:</strong> {a.folioNumber || '—'}</span>
                      <span><strong>Room:</strong> {a.roomNumber || '—'}</span>
                      <span><strong>Clerk:</strong> {a.username || '—'}</span>
                      <span><strong>Category:</strong> {a.accountCategory}</span>
                    </div>

                    {/* WHY THIS WAS FLAGGED (Explainable reason) */}
                    <div className="mt-2 rounded-lg bg-white/[0.03] p-2 text-xs leading-relaxed text-slate-300">
                      <strong className="text-amber-400">Why flagged: </strong>
                      {a.whyFlagged}
                    </div>
                  </div>

                  {/* Right Amount & Actions */}
                  <div className="flex flex-col items-end gap-2">
                    <div className="text-right">
                      <p className="text-[10px] uppercase tracking-wider text-slate-500">Amount</p>
                      <p className="font-mono text-base font-bold text-white">
                        ${Math.abs(a.amount).toFixed(2)}
                      </p>
                    </div>

                    {/* Quick Triage Buttons */}
                    <div className="flex items-center gap-1.5">
                      <button
                        disabled={isProcessing}
                        onClick={() => handleAction(a, REVIEW_STATES.APPROVED)}
                        className="flex items-center gap-1 rounded-md bg-emerald-500/20 px-2 py-1 text-[11px] font-medium text-emerald-300 hover:bg-emerald-500/30"
                        title="Approve this stay"
                      >
                        <Check className="h-3 w-3" /> Approve
                      </button>

                      <button
                        disabled={isProcessing}
                        onClick={() => handleWhitelist(a)}
                        className="flex items-center gap-1 rounded-md bg-purple-500/20 px-2 py-1 text-[11px] font-medium text-purple-300 hover:bg-purple-500/30"
                        title="Add to Whitelist (re-alerts if behavior changes)"
                      >
                        <Sparkles className="h-3 w-3" /> Whitelist
                      </button>

                      <button
                        disabled={isProcessing}
                        onClick={() => handleAction(a, REVIEW_STATES.RESOLVED)}
                        className="flex items-center gap-1 rounded-md bg-slate-500/20 px-2 py-1 text-[11px] font-medium text-slate-300 hover:bg-slate-500/30"
                        title="Mark resolved"
                      >
                        Resolve
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
