// Per-property tax configuration with effective date windows.
// Records: { property_id, state_rate, city_rate, other_rate, effective_start, effective_end }
// Rates are stored as fractions (0.057 = 5.7%). property_id "*" or "" = all properties (default).
// Imported PMS tax lines (state_tax / city_tax / other_tax on GrossRevenueDay) always take
// precedence; these rates are only used to estimate taxes when reports don't provide them.

import { getTaxRate } from "@/lib/taxConfig";

const TAX_SETTINGS_KEY = "rri_tax_settings_v1";

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export function getTaxSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(TAX_SETTINGS_KEY) || "[]");
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

export function saveTaxSettings(list) {
  localStorage.setItem(TAX_SETTINGS_KEY, JSON.stringify(list || []));
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
    const legacy = getTaxRate() || 0;
    return { state: legacy, city: 0, other: 0, legacy: true };
  }
  const best = [...pool].sort((a, b) =>
    String(b.effective_start || "").localeCompare(String(a.effective_start || ""))
  )[0];
  return {
    state: num(best.state_rate),
    city: num(best.city_rate),
    other: num(best.other_rate),
    legacy: false,
  };
}
