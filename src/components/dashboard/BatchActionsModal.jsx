// src/components/dashboard/BatchActionsModal.jsx
// Modal component for performing batch operations on multiple selected import manifests or reports.

import React from 'react';
import { CheckSquare, Trash2, Archive, AlertTriangle, X, Check } from 'lucide-react';

export default function BatchActionsModal({
  isOpen,
  onClose,
  selectedItems = [],
  onApproveAll,
  onArchiveAll,
}) {
  if (!isOpen || !selectedItems.length) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="batch-modal-title"
        className="w-full max-w-md rounded-2xl border border-white/10 bg-slate-900 p-6 shadow-2xl relative animate-in fade-in zoom-in-95 duration-200"
      >
        <button
          onClick={onClose}
          aria-label="Close batch actions modal"
          className="absolute right-4 top-4 rounded-lg p-1.5 text-slate-400 hover:bg-white/5 hover:text-white transition-colors"
        >
          <X className="h-5 w-5" />
        </button>

        <div className="flex items-center gap-3 border-b border-white/5 pb-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-500/10 text-amber-400 border border-amber-500/20">
            <CheckSquare className="h-5 w-5" />
          </div>
          <div>
            <h2 id="batch-modal-title" className="text-base font-bold text-white tracking-wide">
              Batch Manifest Actions
            </h2>
            <p className="text-xs text-slate-400">
              {selectedItems.length} report {selectedItems.length === 1 ? 'manifest' : 'manifests'} selected
            </p>
          </div>
        </div>

        <div className="mt-4 space-y-3">
          <p className="text-xs text-slate-300">
            Apply administrative status changes across all selected import manifests simultaneously.
          </p>

          <div className="max-h-40 overflow-y-auto rounded-xl border border-white/5 bg-slate-800/40 p-3 space-y-1.5 text-xs">
            {selectedItems.map((item, idx) => (
              <div key={item.id || idx} className="flex justify-between text-slate-400">
                <span className="truncate max-w-[200px] text-slate-200 font-mono text-[11px]">
                  {item.report_type || item.filename || item.id}
                </span>
                <span>{item.row_count ? `${item.row_count.toLocaleString()} rows` : item.property_id || ''}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-6 flex items-center justify-between border-t border-white/5 pt-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-white/5 px-3 py-2 text-xs text-slate-400 hover:text-white transition-colors"
          >
            Cancel
          </button>

          <div className="flex items-center gap-2">
            {onArchiveAll && (
              <button
                type="button"
                onClick={() => {
                  onArchiveAll(selectedItems);
                  onClose();
                }}
                className="flex items-center gap-1.5 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs font-semibold text-amber-300 hover:bg-amber-500/20 transition-all"
              >
                <Archive className="h-3.5 w-3.5" /> Archive Selected
              </button>
            )}

            {onApproveAll && (
              <button
                type="button"
                onClick={() => {
                  onApproveAll(selectedItems);
                  onClose();
                }}
                className="flex items-center gap-1.5 rounded-xl bg-emerald-600 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-emerald-600/20 hover:bg-emerald-500 transition-all"
              >
                <Check className="h-3.5 w-3.5" /> Verify & Activate
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
