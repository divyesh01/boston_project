// hotel_statistics daily/revenue snapshot scanner, extracted verbatim from
// reportParsers.js.
//
// It moved as one whole behaviour family: `scanHotelStatistics` is the entire
// family. It references no helper or constant defined elsewhere in
// reportParsers.js, so nothing had to be split or duplicated to move it.
//
// This is the entry point for the daily statistics snapshot: it delegates metric
// parsing to parseHotelReport and then shapes the section/validation result the
// importer consumes.
//
// Guarded by scripts/probe-import-validation.mjs (three hotel_statistics scans
// through the public scanReport path), scripts/verify-statistics.mjs and
// scripts/verify-coexistence.mjs.
//
// No mutation in scripts/probe-hotelkey-mutations.mjs anchors inside this family,
// so unlike the transaction family this module is not covered by the mutation
// net: the harness's 11 anchors all resolve elsewhere and needed no change for
// this move.

import { parseHotelReport } from "@/lib/universalParser";
import { validateImport, makeFinding, SEVERITY } from "@/lib/importValidation";

export async function scanHotelStatistics(rawRows, fileUrl, meta) {
  // Use pre-read CSV text if available, otherwise reconstruct from rawRows
  const csvText = meta.csvText || rawRows.map(row => row.map(cell => {
    if (cell === null || cell === undefined) return '';
    const str = String(cell);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  }).join(',')).join('\n');
  
  // Parse using universal parser
  const importId = meta.importId || `imp_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
  const parseResult = await parseHotelReport(csvText, {
    propertyId: meta.propertyId || '',
    propertyName: meta.propertyName || '',
    businessDate: meta.businessDate || '',
    sourceFile: meta.sourceFile || fileUrl,
    fileModified: meta.fileModified || null,
    importId,
  });
  
  // Convert metrics to preview format
  const _preview = parseResult.metrics.slice(0, 20).map(m => ({
    section: m.section,
    metric: m.metric_name,
    category: m.metric_category,
    period: m.period_label,
    value: m.value,
    unit: m.unit,
    original: m.original_value,
  }));

  // Map parsed sections into the uniform { name, rows, preview } shape the UI renders.
  const sections = parseResult.sections.map(s => {
    const metrics = parseResult.metrics.filter(m => m.section === s.name);
    return {
      name: s.name,
      rows: s.rowCount,
      metricCount: metrics.length,
      periodHeaders: s.periodHeaders || [],
      preview: metrics.slice(0, 5).map(m => ({
        metric: m.metric_name,
        category: m.metric_category,
        period: m.period_label,
        value: m.value,
        unit: m.unit,
      })),
    };
  });

  // The snapshot's own integrity signals — metric names the parser did not
  // recognise, and anything parseHotelReport itself reported — used to be
  // returned and never read. Routed through validateImport they gate the import
  // like every other type: a file that yields no metrics is not imported, and a
  // renamed metric is named on screen instead of quietly arriving as `unknown`.
  //
  // `stackedSections` because this export is a column of section titles, each
  // with its own period headers and widths: the single-header raggedness and
  // unknown-column checks would report the file's normal shape as damage.
  const unknownNames = [...new Set((parseResult.unknownMetrics || []).map((u) => u.metricName))];
  const validation = validateImport({
    rawRows,
    rows: parseResult.metrics,
    type: "hotel_statistics",
    stackedSections: true,
    extraFindings: [
      unknownNames.length
        ? makeFinding("structural", SEVERITY.WARNING, "unknown_metrics",
          `${unknownNames.length} metric name(s) were not recognised and will import as uncategorised: ${unknownNames.slice(0, 8).join(", ")}${unknownNames.length > 8 ? "…" : ""}.`,
          { count: unknownNames.length, metrics: unknownNames })
        : null,
      ...(parseResult.errors || []).map((message) =>
        makeFinding("structural", SEVERITY.ERROR, "parser_error", String(message))),
    ],
  });

  return {
    type: "hotel_statistics",
    sections,
    totalRows: parseResult.metrics.length,
    rowsToImport: parseResult.metrics,
    metrics: parseResult.metrics,
    unknownMetrics: parseResult.unknownMetrics,
    errors: parseResult.errors,
    validation,
    fileHash: parseResult.fileHash,
    businessDate: parseResult.businessDate,
    businessDateSource: parseResult.businessDateSource,
    meta,
  };
}
