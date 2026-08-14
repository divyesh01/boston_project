import React, { useState } from 'react';
import { TrendingUp, Check } from 'lucide-react';
import { applyDynamicRateOverride } from '@/lib/pricingOverride';

export default function PricingOverrideButton({ propertyId, recommendedRate, roomType, reason, user, onRateApplied }) {
  const [loading, setLoading] = useState(false);
  const [applied, setApplied] = useState(false);

  const handleApply = async () => {
    if (!propertyId || !recommendedRate) return;
    setLoading(true);

    try {
      await applyDynamicRateOverride({
        propertyId,
        newRate: recommendedRate,
        roomType: roomType || 'Standard King',
        justification: reason || 'Approved Dynamic Yield Recommendation',
        user
      });
      setApplied(true);
      if (onRateApplied) onRateApplied(recommendedRate);
      setTimeout(() => setApplied(false), 3000);
    } catch (err) {
      alert(`Could not apply rate: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      type="button"
      onClick={handleApply}
      disabled={loading || applied}
      className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition shadow-sm ${
        applied
          ? 'bg-emerald-600 text-white'
          : 'bg-red-700 text-white hover:bg-red-800'
      } disabled:opacity-75`}
    >
      {applied ? (
        <>
          <Check className="h-3.5 w-3.5" />
          <span>Rate Active (${Number(recommendedRate).toFixed(0)})</span>
        </>
      ) : (
        <>
          <TrendingUp className="h-3.5 w-3.5" />
          <span>{loading ? 'Applying...' : `Apply $${Number(recommendedRate).toFixed(0)}/night`}</span>
        </>
      )}
    </button>
  );
}
