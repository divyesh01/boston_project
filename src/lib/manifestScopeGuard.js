export function manifestScopeMatches(manifest, requestedPropertyId) {
  const canonical = manifest?.server_property_id;
  if (typeof canonical !== 'string' || canonical === '') return false;
  if (requestedPropertyId === canonical) return true;
  const aliases = manifest?.property_aliases;
  if (!Array.isArray(aliases)) return false;
  return aliases.some(alias => alias === requestedPropertyId);
}
