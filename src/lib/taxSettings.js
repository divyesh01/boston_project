// Per-property tax configuration with effective date windows.
// Records: { property_id, state_rate, city_rate, other_rate, effective_start, effective_end }
// Rates are stored as fractions (0.057 = 5.7%). property_id "*" or "" = all properties (default).
// Imported PMS tax lines (state_tax / city_tax / other_tax on GrossRevenueDay) always take
// precedence; these rates are only used to estimate taxes when reports don't provide them.

import { getTaxRate } from "@/lib/taxConfig";
import { notifySettingsChanged } from "@/lib/settingsBus";
import { readJsonSetting, reportDiscardedSetting, writeJsonSetting } from "@/lib/settingsStore";

const TAX_SETTINGS_KEY = "rri_tax_settings_v1";

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export function getTaxSettings() {
  const raw = readJsonSetting(TAX_SETTINGS_KEY, []);
  if (Array.isArray(raw)) return raw;
  // Dropping this silently discards every configured tax period, and the caller
  // then falls back to the single legacy rate as though none had been set up.
  reportDiscardedSetting(TAX_SETTINGS_KEY, `expected a list of tax periods, stored value is ${typeof raw}`);
  return [];
}

/**
 * @param {Array} list
 * @returns {boolean} true only if the tax periods are now stored. A false return
 *   means the PREVIOUS tax periods are still what every tax figure is computed
 *   from, so a caller that reports success must check it.
 */
export function saveTaxSettings(list) {
  const saved = writeJsonSetting(TAX_SETTINGS_KEY, list || []);
  notifySettingsChanged();
  return saved;
}

// Resolve the tax rates that apply to a property on a specific date.
// Falls back to the legacy combined tax rate (state) when nothing is configured.
export function getEffectiveTaxRates(propertyId, dateStr) {
  const q = String(dateStr || "").slice(0, 10) || "9999-12-31";
  const recs = getTaxSettings().filter(
    (r) =>
      (r.property_id === propertyId || r.property_id === "*" || !r.property_id) &&
      (!r.effective_start || q >= String(r.effective_start).slice(0, 10)) &&
      (!r.effective_end || q <= String(r.effective_end).slice(0, 10))
  );
  const specific = recs.filter((r) => r.property_id === propertyId);
  const pool = specific.length ? specific : recs;
  if (!pool.length) {
    const legacy = Math.max(0, Math.min(1, getTaxRate() || 0));
    return { state: legacy, city: 0, other: 0, legacy: true };
  }
  const best = [...pool].sort((a, b) =>
    String(b.effective_start || "").localeCompare(String(a.effective_start || ""))
  )[0];
  const clamp = (v) => Math.max(0, Math.min(1, num(v)));
  return {
    state: clamp(best.state_rate),
    city: clamp(best.city_rate),
    other: clamp(best.other_rate),
    legacy: false,
  };
}
