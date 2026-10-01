// A newer report owns every row for the dates it actually contains. Dates
// absent from that report keep their older rows, including zero-value days.
export function reportBusinessDate(row) {
  return String(row.date || row.business_date || row.shift_date || '').slice(0, 10);
}

// Feed reports newest first so older overlapping rows can be discarded as each
// file is read. Memory then grows with retained days, not the whole import history.
export function createReportDateAccumulator(propertyId, maxBytes = Infinity) {
  const days = new Map();
  const encoder = new TextEncoder();
  let byteLength = 0;
  function add(report) {
    const groups = new Map();
    for (const item of report) {
      const key = `${item.entity}:${reportBusinessDate(item.row)}`;
      if (days.has(key)) continue;
      const rows = groups.get(key) || [];
      const normalized = { entity: item.entity, row: { ...item.row, property_id: propertyId } };
      byteLength += encoder.encode(JSON.stringify(normalized)).byteLength + 1;
      if (byteLength > maxBytes) {
        throw Object.assign(new Error('Combined report exceeds supported size; existing reports remain unchanged'), {
          code: 'REPORT_MERGE_LIMIT',
        });
      }
      rows.push(normalized);
      groups.set(key, rows);
    }
    for (const [key, rows] of groups) days.set(key, rows);
  }
  return { add, rows: () => [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).flatMap(([, rows]) => rows) };
}

export function mergeReportDates(olderReports, incoming, propertyId) {
  const accumulator = createReportDateAccumulator(propertyId);
  accumulator.add(incoming);
  for (let index = olderReports.length - 1; index >= 0; index--) accumulator.add(olderReports[index]);
  return accumulator.rows();
}
