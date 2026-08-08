// Enhanced commission rates model — supports percentage, fixed $, actual, or none
// Each source can be tax-exempt (OTA pre-deducts) or taxable (walk-in/direct)
// Global CC/debit card processing fee applies to card charges and refunds

import { notifySettingsChanged } from "@/lib/settingsBus";

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

export function getCommissionRates() {
  try {
    const stored = JSON.parse(localStorage.getItem(RATES_KEY) || "{}");
    const out = {};
    for (const [key, val] of Object.entries({ ...DEFAULT_RATES, ...stored })) {
      out[key] = normalizeRate(val);
    }
    return out;
  } catch {
    return { ...DEFAULT_RATES };
  }
}

export function setCommissionRates(rates) {
  localStorage.setItem(RATES_KEY, JSON.stringify(rates));
  notifySettingsChanged();
}

export function getCcFeeRate() {
  try {
    const v = localStorage.getItem(CC_FEE_KEY);
    if (v === null) return DEFAULT_CC_FEE;
    const n = parseFloat(v);
    if (Number.isNaN(n)) return DEFAULT_CC_FEE;
    return Math.max(0, Math.min(0.9999, n));
  } catch {
    return DEFAULT_CC_FEE;
  }
}

export function setCcFeeRate(rate) {
  let n = Number(rate);
  if (Number.isNaN(n)) n = DEFAULT_CC_FEE;
  localStorage.setItem(CC_FEE_KEY, String(Math.max(0, Math.min(0.9999, n))));
  notifySettingsChanged();
}

// Whether the card processing fee also applies to card refunds
export function getCcFeeOnRefunds() {
  try {
    return localStorage.getItem(CC_REFUNDS_KEY) === "1";
  } catch {
    return false;
  }
}

export function setCcFeeOnRefunds(enabled) {
  localStorage.setItem(CC_REFUNDS_KEY, enabled ? "1" : "0");
  notifySettingsChanged();
}

export const COMMISSION_TYPES = [
  ["percentage", "%"],
  ["fixed", "$"],
  ["actual", "Actual"],
  ["none", "None"],
];