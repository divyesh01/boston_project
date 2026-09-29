// src/components/dashboard/ScheduleReportDialog.jsx
// Modal dialog allowing hotel owners to schedule automated delivery of
// the Monthly Owner Performance Packet (.xlsx) to their executive inbox.

import React, { useState } from 'react';
import { Calendar, Clock, Mail, Check, X, Shield, Send, Sparkles } from 'lucide-react';
import { toast } from 'sonner';

export default function ScheduleReportDialog({ isOpen, onClose, onSendTest }) {
  const [frequency, setFrequency] = useState('weekly');
  const [deliveryDay, setDeliveryDay] = useState('mon');
  const [deliveryTime, setDeliveryTime] = useState('06:00');
  const [emails, setEmails] = useState('owner@hotel.test.local');
  const [includeProvenance, setIncludeProvenance] = useState(true);

  if (!isOpen) return null;

  function handleSave(e) {
    e.preventDefault();
    try {
      localStorage.setItem('scheduled_report_config', JSON.stringify({
        frequency,
        deliveryDay,
        deliveryTime,
        emails,
        includeProvenance,
        updatedAt: new Date().toISOString(),
      }));
      toast.success(`Owner packet scheduled for ${frequency} delivery at ${deliveryTime} ET`);
      onClose();
    } catch (err) {
      toast.error('Failed to save schedule');
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="schedule-dialog-title"
        className="w-full max-w-lg rounded-2xl border border-white/10 bg-slate-900 p-6 shadow-2xl relative animate-in fade-in zoom-in-95 duration-200"
      >
        {/* Close Button */}
        <button
          onClick={onClose}
          aria-label="Close schedule dialog"
          className="absolute right-4 top-4 rounded-lg p-1.5 text-slate-400 hover:bg-white/5 hover:text-white transition-colors"
        >
          <X className="h-5 w-5" />
        </button>

        {/* Dialog Header */}
        <div className="flex items-center gap-3 border-b border-white/5 pb-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
            <Calendar className="h-5 w-5" />
          </div>
          <div>
            <h2 id="schedule-dialog-title" className="text-lg font-bold text-white tracking-wide">
              Schedule Automated Owner Packets
            </h2>
            <p className="text-xs text-slate-400">
              Receive compiled multi-sheet Excel workbooks before your morning briefing.
            </p>
          </div>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSave} className="mt-5 space-y-4">
          {/* Delivery Frequency */}
          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-2">
              Delivery Frequency
            </label>
            <div className="grid grid-cols-3 gap-2">
              {[
                { id: 'daily', label: 'Daily' },
                { id: 'weekly', label: 'Weekly (Mon)' },
                { id: 'monthly', label: 'Monthly (1st)' },
              ].map((opt) => (
                <button
                  type="button"
                  key={opt.id}
                  onClick={() => setFrequency(opt.id)}
                  className={`flex items-center justify-center rounded-xl border py-2.5 text-xs font-medium transition-all ${
                    frequency === opt.id
                      ? 'border-indigo-500 bg-indigo-500/15 text-white shadow-sm'
                      : 'border-white/5 bg-slate-800/50 text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Delivery Time & Timezone */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                Delivery Time
              </label>
              <div className="relative">
                <input
                  type="time"
                  value={deliveryTime}
                  onChange={(e) => setDeliveryTime(e.target.value)}
                  className="w-full rounded-xl border border-white/10 bg-slate-800/80 px-3 py-2 text-xs text-white focus:border-indigo-500 focus:outline-none"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                Timezone
              </label>
              <div className="rounded-xl border border-white/10 bg-slate-800/40 px-3 py-2 text-xs text-slate-400">
                America/New_York (Eastern)
              </div>
            </div>
          </div>

          {/* Recipient Emails */}
          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1.5">
              Recipient Email Addresses
            </label>
            <div className="relative">
              <Mail className="absolute left-3 top-2.5 h-4 w-4 text-slate-500" />
              <input
                type="text"
                value={emails}
                onChange={(e) => setEmails(e.target.value)}
                placeholder="owner@hotel.test.local, partner@hotel.test.local"
                className="w-full rounded-xl border border-white/10 bg-slate-800/80 pl-9 pr-3 py-2 text-xs text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
                required
              />
            </div>
            <p className="mt-1 text-[11px] text-slate-500">
              Comma-separated list of executive or accountant emails.
            </p>
          </div>

          {/* Audit Verification Toggle */}
          <div className="rounded-xl border border-white/5 bg-slate-800/30 p-3 flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <Shield className="h-4 w-4 text-emerald-400" />
              <div>
                <div className="text-xs font-medium text-slate-200">Include Immutable Provenance</div>
                <div className="text-[10px] text-slate-500">Appends Sheet 5 SHA-256 raw file audit hashes</div>
              </div>
            </div>
            <input
              type="checkbox"
              checked={includeProvenance}
              onChange={(e) => setIncludeProvenance(e.target.checked)}
              className="h-4 w-4 rounded border-white/10 bg-slate-700 text-indigo-600 focus:ring-0 cursor-pointer"
            />
          </div>

          {/* Footer Actions */}
          <div className="mt-6 flex items-center justify-between border-t border-white/5 pt-4">
            <button
              type="button"
              onClick={() => {
                if (onSendTest) onSendTest();
                toast.success('Test Owner Packet dispatched to ' + emails);
              }}
              className="flex items-center gap-1.5 rounded-xl border border-white/10 px-3 py-2 text-xs font-medium text-slate-300 hover:bg-white/5 transition-colors"
            >
              <Send className="h-3.5 w-3.5" /> Send Test Now
            </button>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-xl border border-white/5 px-3 py-2 text-xs text-slate-400 hover:text-white transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="flex items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-indigo-600/20 hover:bg-indigo-500 transition-all"
              >
                <Check className="h-3.5 w-3.5" /> Save Automation
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
