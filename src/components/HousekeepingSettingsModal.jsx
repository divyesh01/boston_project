import React, { useState } from 'react';
import { Settings, X, Save } from 'lucide-react';
import { getHousekeepingConfig, saveHousekeepingConfig } from '@/lib/housekeepingConfig';

// NOTE (2026-08-25): this component has ZERO importers. The live editor for these
// standards is inline in src/pages/Housekeeping.jsx, which duplicates it. Kept as
// found rather than deleted; it is updated here only because saveHousekeepingConfig
// now returns a boolean instead of the merged config, and a dead file that calls a
// changed contract is a trap for whoever revives it.
export default function HousekeepingSettingsModal({ isOpen, onClose, propertyId, onSaved }) {
  const [config, setConfig] = useState(() => getHousekeepingConfig(propertyId));
  const [error, setError] = useState(null);

  if (!isOpen) return null;

  const handleSubmit = (e) => {
    e.preventDefault();
    // saveHousekeepingConfig returns whether the write landed, and clamps each
    // field, so the stored values are read back rather than assumed.
    if (!saveHousekeepingConfig(propertyId, config)) {
      setError('Could not save — browser storage is full or blocked. The previous standards are still in effect.');
      return;
    }
    const stored = getHousekeepingConfig(propertyId);
    setConfig(stored);
    if (onSaved) onSaved(stored);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl border border-gray-100">
        <div className="flex items-center justify-between border-b pb-3">
          <div className="flex items-center gap-2 text-gray-900 font-bold text-sm">
            <Settings className="h-4 w-4 text-red-700" />
            <h3>Housekeeping Labor Standards</h3>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="mt-4 space-y-3.5 text-xs">
          {error && (
            <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-2 text-red-700">
              {error}
            </p>
          )}
          <div>
            <label className="block font-medium text-gray-700 mb-1">
              Checkout Turnover Cleaning Time (Minutes)
            </label>
            <input
              type="number"
              min="15"
              max="90"
              value={config.minutesPerCheckout}
              onChange={(e) => setConfig({ ...config, minutesPerCheckout: Number(e.target.value) })}
              className="w-full rounded-lg border border-gray-300 p-2 focus:ring-1 focus:ring-red-600 outline-none"
            />
          </div>

          <div>
            <label className="block font-medium text-gray-700 mb-1">
              Stayover Refresh Time (Minutes)
            </label>
            <input
              type="number"
              min="5"
              max="45"
              value={config.minutesPerStayover}
              onChange={(e) => setConfig({ ...config, minutesPerStayover: Number(e.target.value) })}
              className="w-full rounded-lg border border-gray-300 p-2 focus:ring-1 focus:ring-red-600 outline-none"
            />
          </div>

          <div>
            <label className="block font-medium text-gray-700 mb-1">
              Average Hourly Housekeeping Wage ($/hr)
            </label>
            <input
              type="number"
              step="0.25"
              min="7.25"
              value={config.hourlyWage}
              onChange={(e) => setConfig({ ...config, hourlyWage: Number(e.target.value) })}
              className="w-full rounded-lg border border-gray-300 p-2 focus:ring-1 focus:ring-red-600 outline-none"
            />
          </div>

          <div className="mt-5 flex justify-end gap-2 pt-2 border-t">
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-2 text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200 transition font-medium"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="inline-flex items-center gap-1.5 px-4 py-2 bg-red-700 text-white rounded-lg hover:bg-red-800 transition font-semibold"
            >
              <Save className="h-3.5 w-3.5" />
              Save Standards
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
