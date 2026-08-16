// Universal Hotel Data Ingestion Engine
// Adaptive, structure-agnostic parser for any HotelKey/PMS report format

import { parseCsvText, parseAmount, convertDate, isIsoDate } from './csvParser.js';

// ─── Section Header Detection ───
// Recognizes repeated header rows like "Description | Actual Today | M-T-D | LY-M-T-D | Y-T-D | LY-T-D"
const SECTION_HEADER_PATTERNS = [
  ['description', 'actual today', 'm-t-d', 'ly-m-t-d', 'y-t-d', 'ly-t-d'],
  ['description', 'actual', 'mtd', 'ly mtd', 'ytd', 'ly ytd'],
  ['metric', 'today', 'mtd', 'ly mtd', 'ytd', 'ly ytd'],
];

function isSectionHeaderRow(row) {
  if (!row || row.length === 0) return false;

  // Exact match for "Description" in column 0 per user specification
  const col0 = String(row[0] || '').trim();
  if (col0 === 'Description') {
    return true;
  }

  if (row.length < 3) return false;
  const normalized = row.map(c => String(c || '').trim().toLowerCase()).filter(c => c);
  if (normalized.length < 3) return false;
  
  // Check against known patterns
  for (const pattern of SECTION_HEADER_PATTERNS) {
    let matches = 0;
    for (const kw of pattern) {
      if (normalized.some(c => c === kw || c.includes(kw))) matches++;
    }
    if (matches >= 3) return true; // At least 3 keywords match
  }
  
  // Generic: first col is "description" or "metric" and others look like periods
  const first = normalized[0];
  if (first === 'description' || first === 'metric' || first === 'description / metric') {
    const periodKeywords = ['today', 'mtd', 'ytd', 'actual', 'period', 'month', 'year', 'ly'];
    const periodMatches = normalized.slice(1).filter(c => periodKeywords.some(kw => c.includes(kw))).length;
    if (periodMatches >= 2) return true;
  }
  
  return false;
}

function extractPeriodHeaders(headerRow) {
  const periods = [];
  headerRow.forEach((cell, idx) => {
    if (idx === 0) return; // Skip first column (Description/Metric)
    const normalized = String(cell || '').trim();
    if (!normalized) return;
    periods.push({ index: idx, label: normalized, normalized: normalizePeriodLabel(normalized) });
  });
  return periods;
}

function normalizePeriodLabel(label) {
  const s = label.toLowerCase().trim()
    .replace(/[-_\s]+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
  // Map common variations
  const map = {
    'actual_today': 'actual_today',
    'today': 'actual_today',
    'm_t_d': 'mtd',
    'mtd': 'mtd',
    'month_to_date': 'mtd',
    'ly_m_t_d': 'ly_mtd',
    'ly_mtd': 'ly_mtd',
    'last_year_mtd': 'ly_mtd',
    'y_t_d': 'ytd',
    'ytd': 'ytd',
    'year_to_date': 'ytd',
    'ly_t_d': 'ly_ytd',
    'ly_ytd': 'ly_ytd',
    'last_year_ytd': 'ly_ytd',
  };
  return map[s] || s;
}

// ─── Metric Normalization ───
function normalizeMetricName(name) {
  if (!name) return '';
  return String(name).trim()
    .replace(/\s+/g, ' ')
    .replace(/[._]+$/, '') // trailing dots
    .replace(/^\.+/, ''); // leading dots
}

// Known metric categories for semantic grouping
const METRIC_CATEGORIES = {
  room_inventory: [
    'total rooms', 'clean', 'dirty', 'out of order', 'rooms available to sell',
    'same day checkout', 'stay overs', 'stayovers', 'comp rooms', 'house rooms',
    'room sold', 'rooms sold excluding comp house use rooms',
    'down rooms', 'vacant rooms', 'clean rooms', 'dirty rooms',
    'stayover rooms', 'same day bookings', 'zero rate rooms', 'day use rooms',
  ],
  occupancy: [
    'occupancy including down comp house use rooms',
    'occupancy excluding down comp house use rooms',
    'occupancy including down rooms and excluding comp house use rooms',
    'occupancy excluding down rooms and including comp house use rooms',
    'occupancy', 'occ',
  ],
  adr_revpar: [
    'adr including comp house use rooms', 'adr excluding comp house use rooms',
    'adr', 'revpar with out of order rooms', 'revpar', 'revpar without ooo rooms',
    'average rate per adult', 'average revenue per adult',
  ],
  revenue: [
    'taxable room revenue', 'exempt room revenue', 'taxable other revenue',
    'exempt other revenue', 'extra cleaning', 'pet charge', 'property damage',
    'long distance phone and fax', 'vending revenue', 'strobe detector',
    'misc non-tax', 'ar billing adjustments-acctg only', 'restaurant charges',
    'service animal', 'crib', 'breakfast', 'redicard member', 'late check out',
    'front', 'smoking', 'banquet income', 'movie rental', 'gratuity',
    'upper floor', 'shuttle and courtesy', 'misc tax', 'early check in',
    'closed caption', 'meeting room', 'parking', 'first floor', 'av rental',
    'microfridge', 'ticket sales', 'back', 'non-smoking', 'misc goods',
    'office services', 'laundry valet', 'laundry', 'pet fee',
    'room rent', 'misc charge', 'system', 'food', 'event', 'bar', 'laundry', 'phone', 'other',
    'non revenue', 'advance deposit', 'beverage',
  ],
  tax: [
    'taxable state tax', 'exempted state tax', 'taxable county tax',
    'exempted county tax', 'taxable city tax', 'exempted city tax',
    'state tax', 'city tax', 'other tax', 'local tax',
  ],
  payments: [
    'cash', 'amex', 'discover', 'master', 'other', 'visa', 'check',
    'closed balance folio', 'corpay', 'direct bill', 'wire transfer',
    'loyalty certificate', 'loyalty discount', 'vip pass',
  ],
  guests: [
    'adults', 'children', 'total guests', 'average adults per person',
    'arrivals', 'departures', 'group rooms',
  ],
  reservations: [
    'non walk-in reservations', 'walk ins', 'walk-ins', 'total reservations',
    'cancellation for today\'s arrival', 'cancellations for future',
    'total cancellations', 'room nights created', 'room nights cancelled',
    'no shows', 'checked out today',
  ],
  forecast: [
    'tomorrows arrivals', 'guest count for tomorrows arrivals',
    'tomorrows departures', 'guest count for tomorrows departures',
    'occupancy % for tomorrow', 'occupancy % for the next 7 days',
    'occupancy % for the next 31 days',
  ],
};

// Does this row aggregate other rows rather than carry its own measurement?
//
// This has to stay narrow. METRIC_CATEGORIES above catalogues 'total rooms',
// 'total guests', 'total reservations' and 'total cancellations' as first-class
// metrics, and Occupancy Summary exports ship them as ordinary columns — so a
// blanket "name starts with total" rule silently deleted four real leaf metrics
// on every import. 'Total Rooms' is the property's room count, which occupancy
// and RevPAR math both lean on.
//
// In this format the genuine section totals carry an EMPTY description
// (`"","$5,145.86","$17,145.92",...`), and those are already skipped by the
// `!metricName` guard in the extract loop. What is left is a bare 'Total' or
// 'Subtotal' label with no metric identity of its own, so that is all this
// matches. Anything the catalogue recognises is a real metric, never an artifact.
//
// Rows matching this are still parsed and stored, flagged `is_total` — callers
// that sum a section exclude them instead of the parser throwing them away.
function isAggregateRow(metricName, category) {
  if (category !== 'unknown') return false;
  const lower = metricName.toLowerCase();
  return lower === 'total' || lower === 'grand total' || lower === 'subtotal' || lower === 'sub total';
}

function categorizeMetric(metricName) {
  const normalized = metricName.toLowerCase().trim();
  for (const [category, keywords] of Object.entries(METRIC_CATEGORIES)) {
    for (const kw of keywords) {
      if (normalized === kw.toLowerCase() || normalized.includes(kw.toLowerCase())) {
        return category;
      }
    }
  }
  return 'unknown';
}

// ─── Value Parsing ───
function parseValue(rawValue, periodLabel) {
  if (rawValue === null || rawValue === undefined) return { value: null, unit: 'unknown', original: '' };
  const s = String(rawValue).trim();
  if (!s || s === '-' || s === '—') return { value: null, unit: 'unknown', original: s };
  
  const original = s;
  let value = null;
  let unit = 'unknown';
  
  // Percentage
  if (s.endsWith('%')) {
    const num = parseFloat(s.replace(/[%,]/g, ''));
    if (!isNaN(num)) {
      value = num;
      unit = 'percentage';
    }
  }
  // Currency (including negative in parens)
  else if (s.startsWith('$') || s.startsWith('(') || (s.startsWith('-') && /\d/.test(s))) {
    const parsed = parseAmount(s);
    if (parsed !== null) {
      value = parsed;
      unit = 'currency';
    }
  }
  // Plain number (count)
  else {
    const num = parseFloat(s.replace(/,/g, ''));
    if (!isNaN(num)) {
      value = num;
      // Heuristic: if period is a percentage-type metric, treat as percentage
      if (periodLabel && (periodLabel.includes('occupancy') || periodLabel.includes('%') || periodLabel.includes('rate'))) {
        unit = 'percentage';
      } else if (value === Math.floor(value) && value < 10000) {
        unit = 'count';
      } else {
        unit = 'number';
      }
    }
  }
  
  return { value, unit, original };
}

// ─── Business Date Derivation ───
//
// Hotel Statistics exports carry no date column anywhere in the file — the
// columns are relative ("Actual Today", "M-T-D", "Y-T-D"), so the snapshot's
// date lives entirely outside the data. Nothing supplied one, so every metric
// imported with `business_date: ""`. That left the rows unplaceable on a
// timeline and made two different days' snapshots indistinguishable.
//
// So we derive one, in descending order of trustworthiness, and record WHICH
// source was used in `business_date_source` so the UI can say "date taken from
// the filename" rather than presenting a guess as fact.
function localIsoDate(d) {
  // Deliberately not toISOString(): that converts to UTC first, which rolls the
  // date backwards for anyone west of Greenwich for most of the day.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function isRealDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  // Round-trip through a local Date to reject 2026-02-30 and friends.
  const probe = new Date(y, mo - 1, d);
  return probe.getFullYear() === y && probe.getMonth() === mo - 1 && probe.getDate() === d;
}

// Pull a date out of a filename like "Hotel Statistics 2026-02-14.csv" or
// "hotel_stats_02-14-2026.csv". Conservative on purpose: a filename such as
// "Hotel Statistics (1).csv" must yield nothing rather than a wrong date.
export function dateFromFileName(name) {
  const s = String(name || '');
  const candidates = [
    /(\d{4})[-_.](\d{1,2})[-_.](\d{1,2})/,          // 2026-02-14
    /(\d{1,2})[-_.](\d{1,2})[-_.](\d{4})/,          // 02-14-2026 (US order)
  ];
  const iso = candidates[0].exec(s);
  if (iso) {
    const c = `${iso[1]}-${String(iso[2]).padStart(2, '0')}-${String(iso[3]).padStart(2, '0')}`;
    if (isRealDate(c)) return c;
  }
  const us = candidates[1].exec(s);
  if (us) {
    const c = `${us[3]}-${String(us[1]).padStart(2, '0')}-${String(us[2]).padStart(2, '0')}`;
    if (isRealDate(c)) return c;
  }
  // "14-Feb-2026" / "Feb 14, 2026" — convertDate already knows these shapes.
  const worded = /(\d{1,2}-[A-Za-z]{3}-\d{2,4})|([A-Za-z]{3,9} \d{1,2}, \d{4})/.exec(s);
  if (worded) {
    const c = convertDate(worded[0]);
    if (isRealDate(c)) return c;
  }
  return '';
}

export function deriveBusinessDate({ businessDate = '', sourceFile = '', fileModified = null, now = null } = {}) {
  if (businessDate) {
    const explicit = isIsoDate(businessDate) ? String(businessDate).slice(0, 10) : convertDate(businessDate);
    if (isRealDate(explicit)) return { date: explicit, source: 'explicit' };
  }

  const fromName = dateFromFileName(sourceFile);
  if (fromName) return { date: fromName, source: 'filename' };

  // The file's own mtime is the download time for a PMS export, which is the
  // day it was run far more often than not — better than today, worse than a
  // date the operator typed.
  if (fileModified) {
    const d = new Date(fileModified);
    if (!Number.isNaN(d.getTime())) return { date: localIsoDate(d), source: 'file_modified' };
  }

  return { date: localIsoDate(now ? new Date(now) : new Date()), source: 'import_date' };
}

// ─── Main Parser ───
export async function parseHotelReport(csvText, options = {}) {
  const {
    propertyId = '',
    propertyName = '',
    businessDate = '',
    sourceFile = '',
    importId = '',
    fileModified = null,
  } = options;

  const derived = deriveBusinessDate({ businessDate, sourceFile, fileModified });
  const resolvedDate = derived.date;
  const dateSource = derived.source;

  const rawRows = parseCsvText(csvText);
  if (!rawRows.length) return { sections: [], metrics: [], errors: ['Empty file'] };
  
  const fileHash = await generateFileHash(csvText);
  
  // Step 1: Detect sections by finding header rows
  const sections = [];
  let currentSection = null;
  let currentSectionRows = [];
  let globalPeriodHeaders = null;
  
  for (let rowIdx = 0; rowIdx < rawRows.length; rowIdx++) {
    const row = rawRows[rowIdx];
    const isEmpty = !row.length || row.every(c => !c || String(c).trim() === '');
    
if (isEmpty) {
      if (currentSection && currentSectionRows.length > 0) {
        sections.push({
          name: currentSection.name,
          periodHeaders: currentSection.periodHeaders,
          rows: currentSectionRows,
          startRow: currentSection.startRow,
          endRow: rowIdx - 1,
        });
      }
      currentSection = null;
      currentSectionRows = [];
      continue;
    }
    
    // Check if this is a section header row
    if (isSectionHeaderRow(row)) {
      // Flush previous section
      if (currentSection && currentSectionRows.length > 0) {
        sections.push({
          name: currentSection.name,
          periodHeaders: currentSection.periodHeaders,
          rows: currentSectionRows,
          startRow: currentSection.startRow,
          endRow: rowIdx - 1,
        });
      }
      
      // Start new section
      const periodHeaders = extractPeriodHeaders(row);
      // Derive section name from context or use generic
      let sectionName = 'Unknown';
      // Look at next non-empty row for a clue, or use first metric
      for (let lookAhead = rowIdx + 1; lookAhead < rawRows.length; lookAhead++) {
        const nextRow = rawRows[lookAhead];
        if (nextRow && nextRow[0] && String(nextRow[0]).trim()) {
          const firstMetric = String(nextRow[0]).trim().toLowerCase();
// Check specific patterns first (order matters!)
          if (firstMetric.includes('occupancy') && !firstMetric.includes('tomorrow') && !firstMetric.includes('forecast')) sectionName = 'Occupancy';
          else if (firstMetric.includes('adr') || firstMetric.includes('revpar')) sectionName = 'ADR & RevPAR';
          else if (firstMetric.includes('revenue') || firstMetric.includes('room rent') || firstMetric.includes('misc charge')) sectionName = 'Revenue';
          else if (firstMetric.startsWith('tax') || firstMetric === 'tax') sectionName = 'Tax';
          else if (firstMetric.includes('taxable') || firstMetric.includes('exempt')) sectionName = 'Revenue';
          else if (firstMetric.includes('cash') || firstMetric.includes('amex') || firstMetric.includes('visa') || firstMetric.includes('master') || firstMetric.includes('discover')) sectionName = 'Payments';
          else if (firstMetric.includes('adult') || firstMetric.includes('guest') || firstMetric.includes('children')) sectionName = 'Guests';
          else if (firstMetric.includes('reservation') || firstMetric.includes('walk-in') || firstMetric.includes('walk in') || firstMetric.includes('cancel') || firstMetric.includes('no show') || firstMetric.includes('room night')) sectionName = 'Reservations';
          else if (firstMetric.includes('tomorrow') || firstMetric.includes('forecast') || (firstMetric.includes('occupancy') && (firstMetric.includes('tomorrow') || firstMetric.includes('forecast')))) sectionName = 'Forecast';
          else if (firstMetric.includes('room') || firstMetric.includes('total') || firstMetric.includes('clean') || firstMetric.includes('dirty') || firstMetric.includes('stay') || firstMetric.includes('comp') || firstMetric.includes('house') || firstMetric.includes('sold') || firstMetric.includes('available') || firstMetric.includes('out of order')) sectionName = 'Room Inventory';
          else sectionName = firstMetric.split(' ').slice(0, 3).join(' ');
          break;
        }
      }
      
      currentSection = {
        name: sectionName,
        periodHeaders,
        startRow: rowIdx,
      };
      currentSectionRows = [];
      globalPeriodHeaders = periodHeaders;
      continue;
    }
    
    // Data row
    if (currentSection) {
      currentSectionRows.push({ rowIdx, cells: row });
    } else {
      // Orphan row before first section - create implicit section
      if (!globalPeriodHeaders && row.length > 1) {
        globalPeriodHeaders = extractPeriodHeaders(row);
      }
      currentSection = {
        name: 'General',
        periodHeaders: globalPeriodHeaders || [],
        startRow: rowIdx,
      };
      currentSectionRows.push({ rowIdx, cells: row });
    }
  }
  
// Flush last section
  if (currentSection && currentSectionRows.length > 0) {
    sections.push({
      name: currentSection.name,
      periodHeaders: currentSection.periodHeaders,
      rows: currentSectionRows,
      startRow: currentSection.startRow,
      endRow: rawRows.length - 1,
    });
  }
  
  // Step 2: Extract metrics from each section
  const allMetrics = [];
  const errors = [];
  const unknownMetrics = [];
  
  for (const section of sections) {
    // globalPeriodHeaders stays null until a header row is seen, so a file whose
    // sections carry no period columns at all reached `.length` on null and threw
    // a raw TypeError at the operator instead of reporting an unreadable file.
    const periodHeaders = section.periodHeaders.length > 0
      ? section.periodHeaders
      : (globalPeriodHeaders || []);
    
    for (const { rowIdx, cells } of section.rows) {
      const metricName = normalizeMetricName(cells[0] || '');
      if (!metricName) continue;
      
      const category = categorizeMetric(metricName);
      const isUnknown = category === 'unknown';

      // Aggregate rows are kept, not dropped — see isAggregateRow. Storing them
      // with a flag preserves the file's own arithmetic (a section total is a
      // useful cross-check) while letting consumers avoid double counting.
      const isTotal = isAggregateRow(metricName, category);

      if (isUnknown) {
        unknownMetrics.push({ metricName, section: section.name, rowIdx });
      }
      
      // Parse each period column
      if (periodHeaders.length > 0) {
        for (const ph of periodHeaders) {
          const rawVal = cells[ph.index];
          const parsed = parseValue(rawVal, metricName);
          
          allMetrics.push({
            property_id: propertyId,
            property_name: propertyName,
            business_date: resolvedDate,
            business_date_source: dateSource,
            section: section.name,
            metric_name: metricName,
            metric_category: category,
            period: ph.normalized,
            period_label: ph.label,
            value: parsed.value,
            unit: parsed.unit,
            source_file: sourceFile,
            source_row: rowIdx + 1, // 1-indexed for human readability
            import_id: importId,
            file_hash: fileHash,
            original_value: parsed.original,
            raw_row: cells.join(' | '),
            is_unknown: isUnknown,
            is_total: isTotal,
            created_at: new Date().toISOString(),
          });
        }
      } else {
        // No period headers - treat remaining columns as values
        for (let i = 1; i < cells.length; i++) {
          const rawVal = cells[i];
          const parsed = parseValue(rawVal, metricName);
          if (parsed.value !== null || parsed.original) {
            allMetrics.push({
              property_id: propertyId,
              property_name: propertyName,
              business_date: resolvedDate,
              business_date_source: dateSource,
              section: section.name,
              metric_name: metricName,
              metric_category: category,
              period: `col_${i}`,
              period_label: `Column ${i}`,
              value: parsed.value,
              unit: parsed.unit,
              source_file: sourceFile,
              source_row: rowIdx + 1,
              import_id: importId,
              file_hash: fileHash,
              original_value: parsed.original,
              raw_row: cells.join(' | '),
              is_unknown: isUnknown,
              is_total: isTotal,
              created_at: new Date().toISOString(),
            });
          }
        }
      }
    }
  }
  
  return {
    sections: sections.map(s => ({
      name: s.name,
      periodHeaders: s.periodHeaders.map(p => p.label),
      rowCount: s.rows.length,
      startRow: s.startRow + 1,
      endRow: s.endRow + 1,
    })),
    metrics: allMetrics,
    unknownMetrics,
    errors,
    fileHash,
    businessDate: resolvedDate,
    businessDateSource: dateSource,
    totalRows: rawRows.length,
    parsedAt: new Date().toISOString(),
  };
}

// ─── Deduplication Key ───
export function makeDedupKey(metric) {
  return `${metric.property_id}|${metric.business_date}|${metric.section}|${metric.metric_name}|${metric.period}|${metric.import_id}`;
}

export function makeFileDedupKey(fileHash, propertyId, businessDate) {
  return `${fileHash}|${propertyId}|${businessDate}`;
}

// ─── File Hash Utility ───
export async function generateFileHash(text) {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

export default {
  parseHotelReport,
  makeDedupKey,
  makeFileDedupKey,
  generateFileHash,
  normalizeMetricName,
  categorizeMetric,
  parseValue,
  isSectionHeaderRow,
  extractPeriodHeaders,
  deriveBusinessDate,
  dateFromFileName,
};