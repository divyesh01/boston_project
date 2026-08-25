// Tax configuration — editable tax rate with per-booking-source tax inclusion
// Default rate: 11.70% (combined occupancy + sales tax)
// Sources: Expedia HC, Booking.com HC, Walk-in, Property Booking = taxable
// Other OTA = tax exempt

import { notifySettingsChanged } from "@/lib/settingsBus";
import { getTaxSettings, saveTaxSettings } from "@/lib/taxSettings";
import { readObjectSetting, writeJsonSetting } from "@/lib/settingsStore";

const TAX_KEY = "rri_tax_config_v1";

export const TAX_SOURCES = [
  { key: "EXPEDIA_HC", label: "Expedia (Hotel Collect)", taxable: true },
  { key: "BOOKING_HC", label: "Booking.com (Hotel Collect)", taxable: true },
  { key: "WALK_IN", label: "Walk-in", taxable: true },
  { key: "PROPERTY_BOOKING", label: "Property Booking (Direct)", taxable: true },
  { key: "OTHER_OTA", label: "Other OTA", taxable: false },
];

const DEFAULT_CONFIG = {
  taxRate: 0.117, // 11.70%
  taxEnabled: true,
  sources: TAX_SOURCES,
};

export function getTaxConfig() {
  const stored = readObjectSetting(TAX_KEY, {});
  return {
    taxRate: typeof stored.taxRate === "number" ? stored.taxRate : DEFAULT_CONFIG.taxRate,
    taxEnabled: stored.taxEnabled !== undefined ? stored.taxEnabled : DEFAULT_CONFIG.taxEnabled,
    sources: stored.sources?.length ? stored.sources : TAX_SOURCES,
  };
}

/**
 * @param {Object} config
 * @returns {boolean} true only if the config AND the default tax period it syncs
 *   are now stored. A false return means the PREVIOUS tax rate is still what every
 *   tax figure is computed from, so a caller that closes a dialog on success — as
 *   TaxConfigModal does — must check it.
 */
export function setTaxConfig(config) {
  const saved = writeJsonSetting(TAX_KEY, config);
  const synced = syncDefaultTaxSetting(config.taxRate);
  notifySettingsChanged();
  return saved && synced;
}

/**
 * Mirrors the single legacy tax rate onto the newest catch-all tax period.
 *
 * @param {number} rate
 * @returns {boolean} true when there was nothing to write or the write landed
 */
function syncDefaultTaxSetting(rate) {
  const r = Number(rate);
  if (!Number.isFinite(r) || r <= 0) return true;
  const list = getTaxSettings();
  const defaults = list
    .map((rec, i) => ({ ...rec, _i: i }))
    .filter((rec) => rec.property_id === "*" || !rec.property_id);
  if (!defaults.length) return true;
  defaults.sort((a, b) => String(b.effective_start || "").localeCompare(String(a.effective_start || "")));
  const idx = defaults[0]._i;
  const next = [...list];
  const { _i, ...rest } = { ...next[idx], state_rate: r, city_rate: 0, other_rate: 0 };
  next[idx] = rest;
  return saveTaxSettings(next);
}

export function getTaxRate() {
  return getTaxConfig().taxRate;
}

export function isSourceTaxable(sourceKey) {
  const cfg = getTaxConfig();
  if (!cfg.taxEnabled) return false;
  const src = cfg.sources.find((s) => s.key === sourceKey);
  return src ? src.taxable : false;
}

// Calculate tax for a given room rent and source
// Tax = Room Rent × Tax Rate (if source is taxable and tax is enabled)
export function calculateTax(roomRent, sourceKey) {
  const rent = Number(roomRent) || 0;
  if (!isSourceTaxable(sourceKey)) return 0;
  return rent * getTaxRate();
}

export function formatTaxRate(rate) {
  return `${(Number(rate || 0) * 100).toFixed(2)}%`;
}