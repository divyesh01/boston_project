// Housekeeping productivity standards, per property.
//
// This was the eighth settings module still holding its own storage code after
// the seven in tracker #81 were routed through settingsStore.js (measured
// 2026-08-25). It had the same two defects that item was filed for, plus one of
// its own:
//
//   • the read was wrapped in a bare `catch {}` that returned built-in defaults,
//     so a corrupt or blocked store silently replaced the owner's configuration;
//   • the `localStorage.setItem` was unguarded while the function returned the
//     merged config unconditionally. At quota, or in private browsing, the write
//     threw out of a click handler — so the page's "Productivity standards
//     saved." notice never rendered and the button simply looked inert;
//   • every field was coerced with `Number(x) || fallback`, and 0 is falsy. The
//     editor's inputs report `Number(e.target.value)`, and `Number("")` is 0, so
//     clearing a field sent a real 0 that reverted to the previous value instead
//     of being clamped to the floor the clamps exist to enforce.
//
// Writers return a boolean, matching the seven modules already converted: the
// caller cannot mistake "not stored" for "stored". Readers never throw.
import {
  readObjectSetting,
  reportDiscardedSetting,
  writeJsonSetting,
} from '@/lib/settingsStore';

const DEFAULT_HOUSEKEEPING_CONFIG = {
  minutesPerCheckout: 30,
  minutesPerStayover: 15,
  hourlyWage: 16.50,
  targetLaborRevenuePercent: 15.0
};

const STORAGE_KEY = 'rri_housekeeping_config_';

// Ranges the stored value is held to. `hourlyWage` has a floor (the federal
// minimum) and deliberately no ceiling — a property may pay whatever it pays.
const LIMITS = {
  minutesPerCheckout: { min: 10, max: 90 },
  minutesPerStayover: { min: 5, max: 45 },
  hourlyWage: { min: 7.25, max: Infinity },
  targetLaborRevenuePercent: { min: 5, max: 40 }
};

const FIELDS = /** @type {Array<keyof typeof LIMITS>} */ (Object.keys(LIMITS));

/**
 * Reads a numeric field, distinguishing "not supplied" from "supplied as 0".
 * Absent, empty and non-numeric fall back; 0 does not.
 *
 * @param {*} candidate
 * @param {number} fallback
 * @returns {number}
 */
function coerceNumber(candidate, fallback) {
  if (candidate === null || candidate === undefined || candidate === '') return fallback;
  const n = Number(candidate);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * @param {string} field
 * @param {number} value
 * @returns {number}
 */
function clampField(field, value) {
  const { min, max } = LIMITS[field];
  return Math.max(min, Math.min(max, value));
}

/**
 * @param {string} propertyId
 * @returns {string}
 */
function keyFor(propertyId) {
  return `${STORAGE_KEY}${propertyId}`;
}

/**
 * Retrieves housekeeping productivity standards for a specific property.
 * Never throws: a page must not go blank over a settings key.
 *
 * @param {string} [propertyId]
 * @returns {{minutesPerCheckout: number, minutesPerStayover: number, hourlyWage: number, targetLaborRevenuePercent: number, propertyId: string}}
 */
export function getHousekeepingConfig(propertyId = 'default') {
  const key = keyFor(propertyId);
  const stored = readObjectSetting(key, null);
  const config = { ...DEFAULT_HOUSEKEEPING_CONFIG, propertyId };
  if (!stored) return config;
  for (const field of FIELDS) {
    const fallback = DEFAULT_HOUSEKEEPING_CONFIG[field];
    const value = coerceNumber(stored[field], fallback);
    // A stored value that is present but unusable is reported rather than
    // quietly swapped for a default, because every figure on the Housekeeping
    // page is derived from these four numbers.
    if (value === fallback && stored[field] !== undefined && Number(stored[field]) !== fallback) {
      reportDiscardedSetting(key, `"${field}" is not a usable number`, stored[field]);
    }
    config[field] = value;
  }
  return config;
}

/**
 * Updates housekeeping productivity standards for a property. Fields absent from
 * `newConfig` keep their stored value; fields present are clamped to `LIMITS`,
 * including a supplied 0.
 *
 * @param {string} propertyId
 * @param {Object} [newConfig]
 * @returns {boolean} true only if the standards are now stored. Read the result
 *   back with `getHousekeepingConfig` — what was clamped is what is in effect,
 *   and that is what the UI must show.
 */
export function saveHousekeepingConfig(propertyId, newConfig = {}) {
  const current = getHousekeepingConfig(propertyId);
  /** @type {Record<string, number>} */
  const merged = {};
  for (const field of FIELDS) {
    merged[field] = clampField(field, coerceNumber(newConfig[field], current[field]));
  }
  return writeJsonSetting(keyFor(propertyId), merged);
}
