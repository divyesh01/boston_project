const KEY = "rri_revenue_thresholds";

const DEFAULTS = {
  highRevenueThreshold: 6000,
  mediumRevenueThreshold: 3500,
};

export function getRevenueThresholds() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || "{}") };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveRevenueThresholds(thresholds) {
  localStorage.setItem(KEY, JSON.stringify(thresholds));
}

export function getRevenueColor(revenue) {
  const { highRevenueThreshold, mediumRevenueThreshold } = getRevenueThresholds();
  if (revenue >= highRevenueThreshold) return "#4ade80";
  if (revenue >= mediumRevenueThreshold) return "#94a3b8";
  return "#ff6b6b";
}

export function getRevenueGroup(revenue) {
  const { highRevenueThreshold, mediumRevenueThreshold } = getRevenueThresholds();
  if (revenue >= highRevenueThreshold) return "high";
  if (revenue >= mediumRevenueThreshold) return "medium";
  return "low";
}

export function getRevenueGroupLabel(group) {
  return { high: "High-Performing Days", medium: "Medium Days", low: "Low-Performing Days" }[group] || group;
}