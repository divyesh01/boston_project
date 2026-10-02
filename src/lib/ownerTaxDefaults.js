import { queryClientInstance } from "@/lib/query-client";

// Owner-provided rates for RRI274 (2026-10-01), not a location-wide tax rule.
// Resolve its database ID from the authorized property roster; another hotel's
// rates must not change just because it is added to this portfolio.
export function getOwnerTaxDefaults(propertyId = "*") {
  const properties = /** @type {any[]} */ (queryClientInstance.getQueryData(["properties"]) || []);
  const matches = properties.filter(p => String(p.code || "").trim().toUpperCase() === "RRI274");
  if (matches.length !== 1 || matches[0].id == null || matches[0].id === "") return [];
  const property = matches[0];
  if (propertyId !== "*" && String(propertyId) !== String(property.id)) return [];
  return [{
    property_id: property.id,
    state_rate: 0.0575,
    city_rate: 0.06,
    other_rate: 0,
    effective_start: "",
    effective_end: "",
    rate_basis: "owner_default",
  }];
}

export function isLegacyCombinedTax(row) {
  return row?.rate_basis !== "configured_jurisdictions" &&
    [0.115, 0.117].some(rate => Math.abs(Number(row?.state_rate) - rate) < 1e-9) &&
    Number(row?.city_rate || 0) === 0 && Number(row?.other_rate || 0) === 0;
}
