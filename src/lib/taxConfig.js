// Tax configuration — editable tax rate with per-booking-source tax inclusion
// Default rate: 11.70% (combined occupancy + sales tax)
// Sources: Expedia HC, Booking.com HC, Walk-in, Property Booking = taxable
// Other OTA = tax exempt

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
  try {
    const stored = JSON.parse(localStorage.getItem(TAX_KEY) || "{}");
    return {
      taxRate: typeof stored.taxRate === "number" ? stored.taxRate : DEFAULT_CONFIG.taxRate,
      taxEnabled: stored.taxEnabled !== undefined ? stored.taxEnabled : DEFAULT_CONFIG.taxEnabled,
      sources: stored.sources?.length ? stored.sources : TAX_SOURCES,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function setTaxConfig(config) {
  localStorage.setItem(TAX_KEY, JSON.stringify(config));
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