// Enhanced commission rates model — supports percentage, fixed $, actual, or none
// Each source can be tax-exempt (OTA pre-deducts) or taxable (walk-in/direct)
// Global CC/debit card processing fee applies to card charges and refunds

import { notifySettingsChanged } from "@/lib/settingsBus";
import {
  readObjectSetting,
  readRawSetting,
  reportDiscardedSetting,
  writeJsonSetting,
  writeRawSetting,
} from "@/lib/settingsStore";

const RATES_KEY = "rri_commission_rates_v2";
const CC_FEE_KEY = "rri_cc_fee_rate";
const CC_REFUNDS_KEY = "rri_cc_fee_refunds_v1";

const DEFAULT_RATES = {
  "EXPEDIA": { type: "percentage", rate: 0.15, taxExempt: false },
  "EXPEDIA HOTEL COLLECT": { type: "percentage", rate: 0.15, taxExempt: false },
  "BOOKING.COM HOTEL COLLECT": { type: "percentage", rate: 0.15, taxExempt: false },
  "BOOKING": { type: "percentage", rate: 0.15, taxExempt: false },
  "HOTELS.COM": { type: "percentage", rate: 0.18, taxExempt: false },
  "AGODA": { type: "percentage", rate: 0.18, taxExempt: false },
  "SABRE": { type: "percentage", rate: 0.10, taxExempt: false },
  "AIRBNB": { type: "percentage", rate: 0.03, taxExempt: false },
  "IDS": { type: "percentage", rate: 0.12, taxExempt: false },
  "OTHER OTA": { type: "percentage", rate: 0.15, taxExempt: false },
  "WALK-IN": { type: "none", rate: 0, taxExempt: true },
  "PROPERTY BOOKING": { type: "none", rate: 0, taxExempt: true },
  "RR WEBSITE": { type: "none", rate: 0, taxExempt: true },
  "RED ROOF APP": { type: "none", rate: 0, taxExempt: true },
  "WEBSITE": { type: "none", rate: 0, taxExempt: true },
  "APP": { type: "none", rate: 0, taxExempt: true },
  "CRS": { type: "none", rate: 0, taxExempt: true },
  "CONTACT CENTER": { type: "none", rate: 0, taxExempt: true },
  "GROUP BLOCK": { type: "none", rate: 0, taxExempt: true },
};

const DEFAULT_CC_FEE = 0.025; // 2.5%

// Normalize old format (plain number) to new format
function normalizeRate(val) {
  let r;
  if (typeof val === "number") r = { type: "percentage", rate: val, taxExempt: false };
  else if (val && typeof val === "object") r = { type: val.type || "percentage", rate: val.rate || 0, taxExempt: !!val.taxExempt };
  else r = { type: "none", rate: 0, taxExempt: false };
  // Clamp percentage rates to [0,1); other types (fixed $, actual) keep raw value.
  if (r.type === "percentage") r.rate = Math.max(0, Math.min(0.9999, Number(r.rate) || 0));
  return r;
}

export function getCommissionRates(propertyId = "*") {
  const stored = readObjectSetting(RATES_KEY, {}, propertyId);
  const out = {};
  for (const [key, val] of Object.entries({ ...DEFAULT_RATES, ...stored })) {
    out[key] = normalizeRate(val);
  }
  return out;
}

/**
 * @param {Object} rates
 * @param {string} [propertyId]
 * @returns {boolean} true only if the rates are now stored. A false return means
 *   the app is still computing commission at the PREVIOUS rates, so a caller that
 *   shows a "Saved" affordance must check it.
 */
export function setCommissionRates(rates, propertyId = "*") {
  const saved = writeJsonSetting(RATES_KEY, rates, propertyId);
  notifySettingsChanged();
  return saved;
}

export function getCcFeeRate(propertyId = "*") {
  const v = readRawSetting(CC_FEE_KEY, null, propertyId);
  if (v === null) return DEFAULT_CC_FEE;
  const n = parseFloat(v);
  if (Number.isNaN(n)) {
    reportDiscardedSetting(CC_FEE_KEY, "stored value is not a number", v);
    return DEFAULT_CC_FEE;
  }
  return Math.max(0, Math.min(0.9999, n));
}

/**
 * @param {number} rate
 * @param {string} [propertyId]
 * @returns {boolean} true only if the fee is now stored.
 */
export function setCcFeeRate(rate, propertyId = "*") {
  let n = Number(rate);
  if (Number.isNaN(n)) n = DEFAULT_CC_FEE;
  const saved = writeRawSetting(CC_FEE_KEY, String(Math.max(0, Math.min(0.9999, n))), propertyId);
  notifySettingsChanged();
  return saved;
}

// Whether the card processing fee also applies to card refunds
export function getCcFeeOnRefunds(propertyId = "*") {
  return readRawSetting(CC_REFUNDS_KEY, null, propertyId) === "1";
}

/**
 * @param {boolean} enabled
 * @param {string} [propertyId]
 * @returns {boolean} true only if the switch is now stored.
 */
export function setCcFeeOnRefunds(enabled, propertyId = "*") {
  const saved = writeRawSetting(CC_REFUNDS_KEY, enabled ? "1" : "0", propertyId);
  notifySettingsChanged();
  return saved;
}

export const COMMISSION_TYPES = [
  ["percentage", "%"],
  ["fixed", "$"],
  ["actual", "Actual"],
  ["none", "None"],
];