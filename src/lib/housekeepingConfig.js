const DEFAULT_HOUSEKEEPING_CONFIG = {
  minutesPerCheckout: 30,
  minutesPerStayover: 15,
  hourlyWage: 16.50,
  targetLaborRevenuePercent: 15.0
};

const STORAGE_KEY = 'rri_housekeeping_config_';

/**
 * Retrieves housekeeping productivity standards for a specific property.
 * @param {string} propertyId
 * @returns {Object} Productivity parameters
 */
export function getHousekeepingConfig(propertyId = 'default') {
  try {
    const raw = localStorage.getItem(`${STORAGE_KEY}${propertyId}`);
    if (!raw) return { ...DEFAULT_HOUSEKEEPING_CONFIG, propertyId };
    const parsed = JSON.parse(raw);
    return {
      minutesPerCheckout: Number(parsed.minutesPerCheckout) || DEFAULT_HOUSEKEEPING_CONFIG.minutesPerCheckout,
      minutesPerStayover: Number(parsed.minutesPerStayover) || DEFAULT_HOUSEKEEPING_CONFIG.minutesPerStayover,
      hourlyWage: Number(parsed.hourlyWage) || DEFAULT_HOUSEKEEPING_CONFIG.hourlyWage,
      targetLaborRevenuePercent: Number(parsed.targetLaborRevenuePercent) || DEFAULT_HOUSEKEEPING_CONFIG.targetLaborRevenuePercent,
      propertyId
    };
  } catch {
    return { ...DEFAULT_HOUSEKEEPING_CONFIG, propertyId };
  }
}

/**
 * Updates housekeeping productivity standards for a property.
 * @param {string} propertyId
 * @param {Object} newConfig
 */
export function saveHousekeepingConfig(propertyId, newConfig = {}) {
  const current = getHousekeepingConfig(propertyId);
  const merged = {
    ...current,
    minutesPerCheckout: Math.max(10, Math.min(90, Number(newConfig.minutesPerCheckout) || current.minutesPerCheckout)),
    minutesPerStayover: Math.max(5, Math.min(45, Number(newConfig.minutesPerStayover) || current.minutesPerStayover)),
    hourlyWage: Math.max(7.25, Number(newConfig.hourlyWage) || current.hourlyWage),
    targetLaborRevenuePercent: Math.max(5, Math.min(40, Number(newConfig.targetLaborRevenuePercent) || current.targetLaborRevenuePercent))
  };

  localStorage.setItem(`${STORAGE_KEY}${propertyId}`, JSON.stringify(merged));
  return merged;
}
