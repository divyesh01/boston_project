// src/components/dashboard/SmartButtonGroup.jsx
// Executive smart action toolbar grouping primary owner intelligence shortcuts.

import React from 'react';
import { Download, Sliders, Calendar, RotateCcw, Sparkles } from 'lucide-react';

/**
 * @param {Object} props
 * @param {() => void} props.onDownloadPacket
 * @param {(() => void)} [props.onOpenSchedule]
 * @param {(() => void)} [props.onOpenSimulator]
 * @param {(() => void)} [props.onClearCache]
 * @param {boolean} [props.isExporting=false]
 */
export default function SmartButtonGroup({
  onDownloadPacket,
  onOpenSchedule = undefined,
  onOpenSimulator = undefined,
  onClearCache = undefined,
  isExporting = false,
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* Primary Action: Download Owner Packet */}
      <button
        onClick={onDownloadPacket}
        disabled={isExporting}
        className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-emerald-600/20 hover:from-emerald-500 hover:to-teal-500 active:scale-[0.98] transition-all disabled:opacity-50"
      >
        <Download className="h-3.5 w-3.5" />
        {isExporting ? 'Generating Packet...' : 'Export Owner Packet (.xlsx)'}
      </button>

      {/* Secondary Action: OTA Shift Simulator */}
      {onOpenSimulator && (
        <button
          onClick={onOpenSimulator}
          className="flex items-center gap-1.5 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs font-medium text-emerald-300 hover:bg-emerald-500/20 active:scale-[0.98] transition-all"
        >
          <Sliders className="h-3.5 w-3.5" />
          OTA Shift Simulator
        </button>
      )}

      {/* Secondary Action: Schedule Automated Delivery */}
      {onOpenSchedule && (
        <button
          onClick={onOpenSchedule}
          className="flex items-center gap-1.5 rounded-xl border border-indigo-500/30 bg-indigo-500/10 px-3 py-2 text-xs font-medium text-indigo-300 hover:bg-indigo-500/20 active:scale-[0.98] transition-all"
        >
          <Calendar className="h-3.5 w-3.5" />
          Schedule Delivery
        </button>
      )}

      {/* Utility Action: Clear Local Cache */}
      {onClearCache && (
        <button
          onClick={onClearCache}
          title="Reset IndexedDB fast cache and rehydrate from server authority"
          className="flex items-center gap-1.5 rounded-xl border border-white/10 bg-slate-800/60 px-3 py-2 text-xs font-medium text-slate-400 hover:bg-slate-800 hover:text-slate-200 active:scale-[0.98] transition-all"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          Refresh Server Data
        </button>
      )}
    </div>
  );
}
