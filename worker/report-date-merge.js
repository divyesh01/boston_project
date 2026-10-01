// A newer report owns every row for the dates it actually contains. Dates
// absent from that report keep their older rows, including zero-value days.
export function reportBusinessDate(row) {
  return String(row.date || row.business_date || row.shift_date || '').slice(0, 10);
}

export function mergeReportDates(olderReports, incoming, propertyId) {
  const days = new Map();
  for (const report of [...olderReports, incoming]) {
    const groups = new Map();
    for (const item of report) {
      const key = `${item.entity}:${reportBusinessDate(item.row)}`;
      const rows = groups.get(key) || [];
      rows.push({ entity: item.entity, row: { ...item.row, property_id: propertyId } });
      groups.set(key, rows);
    }
    for (const [key, rows] of groups) days.set(key, rows);
  }
  return [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).flatMap(([, rows]) => rows);
}
