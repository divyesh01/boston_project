import { readObjectSetting, writeJsonSetting } from "@/lib/settingsStore";
import { notifySettingsChanged } from "@/lib/settingsBus";

const KEY = "rri_alert_thresholds";

const DEFAULTS = {
  revenueDecreasePct: 0.10,
  occupancyDecreasePoints: 0.10,
  occupancyThreshold: 0.60,
};

export function getAlertThresholds(propertyId = "*") {
  return { ...DEFAULTS, ...readObjectSetting(KEY, {}, propertyId) };
}

/**
 * @param {Object} thresholds
 * @param {string} [propertyId]
 * @returns {boolean} true only if the thresholds are now stored
 */
export function saveAlertThresholds(thresholds, propertyId = "*") {
  const saved = writeJsonSetting(KEY, thresholds, propertyId);
  notifySettingsChanged();
  return saved;
}