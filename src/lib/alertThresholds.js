const KEY = "rri_alert_thresholds";

const DEFAULTS = {
  revenueDecreasePct: 0.10,
  occupancyDecreasePoints: 0.10,
  occupancyThreshold: 0.60,
};

export function getAlertThresholds() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || "{}") };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveAlertThresholds(thresholds) {
  localStorage.setItem(KEY, JSON.stringify(thresholds));
}