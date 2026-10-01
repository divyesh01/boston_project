// Hotel-local identifiers are meaningful only inside their property. JSON tuples
// keep identifiers containing separators distinct without changing display names.
export function propertyRecordKey(row, ...parts) {
  const propertyId = row?.property_id ?? "";
  return JSON.stringify([typeof propertyId, propertyId, ...parts.map((part) => String(part ?? ""))]);
}

export function propertyDisplayName(row, properties = []) {
  const id = String(row?.property_id ?? "");
  const property = properties.find((item) => String(item.id) === id);
  return property?.name || row?.property_name || id || "Unassigned property";
}
