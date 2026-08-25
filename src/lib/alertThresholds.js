import { readObjectSetting, writeJsonSetting } from "@/lib/settingsStore";

const KEY = "rri_alert_thresholds";

const DEFAULTS = {
  revenueDecreasePct: 0.10,
  occupancyDecreasePoints: 0.10,
  occupancyThreshold: 0.60,
};

export function getAlertThresholds() {
  return { ...DEFAULTS, ...readObjectSetting(KEY, {}) };
}

/**
 * @param {Object} thresholds
 * @returns {boolean} true only if the thresholds are now stored
 */
export function saveAlertThresholds(thresholds) {
  return writeJsonSetting(KEY, thresholds);
}