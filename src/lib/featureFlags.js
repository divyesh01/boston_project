// src/lib/featureFlags.js
// Client-side feature flag manager supporting progressive rollout and instant rollbacks.

import { useState, useEffect } from 'react';

export const FEATURE_FLAGS = {
  LUXURY_UI_ENABLED: 'LUXURY_UI_ENABLED',
  OTA_SIMULATOR_ENABLED: 'OTA_SIMULATOR_ENABLED',
  SCHEDULED_REPORTS_ENABLED: 'SCHEDULED_REPORTS_ENABLED',
  BATCH_ACTIONS_ENABLED: 'BATCH_ACTIONS_ENABLED',
};

const DEFAULT_FLAGS = {
  [FEATURE_FLAGS.LUXURY_UI_ENABLED]: true,
  [FEATURE_FLAGS.OTA_SIMULATOR_ENABLED]: true,
  [FEATURE_FLAGS.SCHEDULED_REPORTS_ENABLED]: true,
  [FEATURE_FLAGS.BATCH_ACTIONS_ENABLED]: true,
};

/**
 * Checks whether a feature flag is enabled.
 *
 * @param {string} flag
 * @returns {boolean}
 */
export function isFeatureEnabled(flag) {
  if (typeof window === 'undefined') return DEFAULT_FLAGS[flag] ?? false;
  try {
    const stored = localStorage.getItem(`ff_${flag}`);
    if (stored !== null) return stored === 'true';
  } catch {}
  return DEFAULT_FLAGS[flag] ?? false;
}

/**
 * Sets the value of a feature flag.
 *
 * @param {string} flag
 * @param {boolean} enabled
 */
export function setFeatureFlag(flag, enabled) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(`ff_${flag}`, String(enabled));
    window.dispatchEvent(new CustomEvent('feature_flag_changed', { detail: { flag, enabled } }));
  } catch {}
}

/**
 * React hook to reactively consume a feature flag.
 *
 * @param {string} flag
 * @returns {boolean}
 */
export function useFeatureFlag(flag) {
  const [enabled, setEnabled] = useState(() => isFeatureEnabled(flag));

  useEffect(() => {
    function handleUpdate(e) {
      if (e.detail?.flag === flag) {
        setEnabled(e.detail.enabled);
      }
    }
    window.addEventListener('feature_flag_changed', handleUpdate);
    return () => window.removeEventListener('feature_flag_changed', handleUpdate);
  }, [flag]);

  return enabled;
}
