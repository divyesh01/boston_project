// Creating a business record requires one explicit property from the current
// roster. Portfolio selection is useful for reading, but is not a write target.
export function singleSelectedProperty(selection, properties = []) {
  const ids = Array.isArray(selection) ? selection : [selection];
  if (ids.length !== 1 || ids[0] == null || ids[0] === '' || ids[0] === 'all') return null;
  const matches = properties.filter((property) => String(property.id) === String(ids[0]));
  return matches.length === 1 ? matches[0] : null;
}
