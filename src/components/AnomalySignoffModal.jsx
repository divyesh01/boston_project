import React, { useState } from 'react';
import { CheckCircle2, X, AlertCircle } from 'lucide-react';
import { signOffShiftAnomaly } from '@/lib/anomalySignoff';

export default function AnomalySignoffModal({ isOpen, onClose, shift, manager, propertyId, onResolved }) {
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  if (!isOpen || !shift) return null;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!notes.trim()) {
      setError('Please provide resolution notes before signing off.');
      return;
    }

    setLoading(true);
    setError('');

    try {
      await signOffShiftAnomaly({
        shiftId: shift.id,
        managerUserId: manager?.id || 'mgr_admin',
        managerName: manager?.username || manager?.name || 'Manager',
        resolutionNotes: notes,
        propertyId
      });
      if (onResolved) onResolved(shift.id);
      onClose();
    } catch (err) {
      setError(err.message || 'Failed to record manager sign-off.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl border border-gray-100">
        <div className="flex items-center justify-between border-b pb-3">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-5 w-5 text-emerald-600" />
            <h3 className="font-bold text-gray-900 text-base">Manager Shift Audit Sign-Off</h3>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="my-4 space-y-2 text-xs bg-gray-50 p-3.5 rounded-xl border border-gray-200">
          <div className="flex justify-between text-gray-600">
            <span>Clerk:</span> <strong className="text-gray-900">{shift.clerk_name}</strong>
          </div>
          <div className="flex justify-between text-gray-600">
            <span>Shift Date:</span> <span className="font-mono text-gray-900">{shift.shift_date}</span>
          </div>
          <div className="flex justify-between text-gray-600">
            <span>Cash Adjustments:</span> <strong className="text-red-700">${Number(shift.cash_adjustments || 0).toFixed(2)}</strong>
          </div>
          <div className="flex justify-between text-gray-600">
            <span>Rate Overrides:</span> <strong className="text-gray-900">{shift.rate_overrides_count || 0} times</strong>
          </div>
        </div>

        {error && (
          <div className="mb-4 flex items-center gap-2 text-xs text-red-700 bg-red-50 p-2.5 rounded-lg border border-red-200">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <label className="block text-xs font-semibold text-gray-700 mb-1.5">
            Resolution & Justification Notes *
          </label>
          <textarea
            rows={3}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="e.g., Verified guest cash deposit refund for early checkout in room 204. Drawer balanced."
            className="w-full rounded-xl border border-gray-300 p-2.5 text-xs focus:border-red-600 focus:ring-1 focus:ring-red-600 outline-none"
          />

          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="px-4 py-2 text-xs font-medium text-gray-700 bg-gray-100 rounded-xl hover:bg-gray-200 transition"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="px-4 py-2 text-xs font-semibold text-white bg-emerald-600 rounded-xl hover:bg-emerald-700 transition shadow-sm"
            >
              {loading ? 'Recording...' : 'Approve & Clear Exception'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
