/**
 * hotelKeySchemaRegistry.js
 * Canonical Versioned Schema Registry for HotelKey Operational and Financial Reports.
 *
 * Enforces explicit contracts, required headers, natural keys, financial invariants,
 * deduplication policies, and unknown field quarantine across all HotelKey CSV formats.
 */

export const REGISTRY_VERSION = '1.0.0';

/**
 * @typedef {Object} HotelKeyReportSchema
 * @property {string} reportType
 * @property {string} schemaVersion
 * @property {string} displayName
 * @property {string[]} requiredHeaders
 * @property {string[]} optionalHeaders
 * @property {string[]} knownAliases
 * @property {'business_date' | 'transaction_timestamp' | 'shift_date'} datePolicy
 * @property {string[]} naturalKey
 * @property {'daily_supersession' | 'row_dedupe_hash' | 'transaction_trailer_checksum'} dedupePolicy
 * @property {{ field?: string, toleranceCents?: number, trailerKeyword?: string } | null} financialChecksum
 * @property {string[]} entitiesProduced
 * @property {string[]} canonicalMetrics
 * @property {'quarantine_warn' | 'allow_extra'} unknownFieldPolicy
 */

/** @type {Record<string, HotelKeyReportSchema>} */
export const HOTELKEY_SCHEMA_REGISTRY = {
  occupancy: {
    reportType: 'occupancy',
    schemaVersion: '1.0.0',
    displayName: 'Occupancy Summary',
    requiredHeaders: ['date', 'room_revenue', 'rooms_sold', 'total_rooms'],
    optionalHeaders: [
      'day_of_week', 'other_room_revenue', 'total_revenue', 'down_rooms',
      'vacant_rooms', 'clean_rooms', 'dirty_rooms', 'stayover_rooms',
      'same_day_bookings', 'comp_rooms', 'house_rooms', 'zero_rate_rooms',
      'day_use_rooms', 'no_shows', 'cancellations', 'total_guests',
      'adr', 'occupancy', 'revpar',
    ],
    knownAliases: [
      'Occupancy Summary', 'Occupancy Summary Report', 'HotelKey Occupancy',
      'occupancy_summary', 'Daily Occupancy',
    ],
    datePolicy: 'business_date',
    naturalKey: ['date'],
    dedupePolicy: 'daily_supersession',
    financialChecksum: { field: 'room_revenue', toleranceCents: 1 },
    entitiesProduced: ['OccupancyDay'],
    canonicalMetrics: ['roomRevenue', 'roomsSold', 'totalRooms', 'adr', 'occupancy', 'revpar'],
    unknownFieldPolicy: 'quarantine_warn',
  },

  gross_revenue: {
    reportType: 'gross_revenue',
    schemaVersion: '1.0.0',
    displayName: 'Gross Revenue (Manager Report)',
    requiredHeaders: ['date', 'room_rent'],
    optionalHeaders: [
      'day_of_week', 'misc_charge', 'system_charge', 'food', 'event',
      'bar', 'laundry', 'phone', 'other', 'non_revenue', 'advance_deposit',
      'beverage', 'total_revenue',
    ],
    knownAliases: [
      'Gross Revenue Report', 'Daily Gross Revenue', 'Manager Report Revenue',
      'gross_revenue', 'Gross Revenue by Department',
    ],
    datePolicy: 'business_date',
    naturalKey: ['date'],
    dedupePolicy: 'daily_supersession',
    financialChecksum: { field: 'room_rent', toleranceCents: 1 },
    entitiesProduced: ['GrossRevenueDay'],
    canonicalMetrics: ['roomRent', 'miscCharges', 'foodRevenue', 'ancillaryTotal'],
    unknownFieldPolicy: 'quarantine_warn',
  },

  source: {
    reportType: 'source',
    schemaVersion: '1.0.0',
    displayName: 'Source / Channel Performance',
    requiredHeaders: ['date', 'source', 'net_revenue'],
    optionalHeaders: [
      'code', 'stays', 'adr', 'occupancy_contribution', 'revpar_contribution',
      'day_of_week',
    ],
    knownAliases: [
      'Source Report', 'Revenue by Source', 'Channel Mix Report',
      'source_summary', 'Market Segment',
    ],
    datePolicy: 'business_date',
    naturalKey: ['date', 'source'],
    dedupePolicy: 'daily_supersession',
    financialChecksum: { field: 'net_revenue', toleranceCents: 1 },
    entitiesProduced: ['SourceDay'],
    canonicalMetrics: ['netRevenue', 'stays', 'channelShare', 'otaShare'],
    unknownFieldPolicy: 'quarantine_warn',
  },

  payments: {
    reportType: 'payments',
    schemaVersion: '1.0.0',
    displayName: 'Payment Tender Summary',
    requiredHeaders: ['date', 'total'],
    optionalHeaders: [
      'day_of_week', 'cash', 'check', 'visa', 'master', 'mastercard',
      'amex', 'discover', 'direct_bill', 'wire_transfer', 'corpay',
      'loyalty_certificate', 'loyalty_discount', 'vip_pass', 'other',
      'closed_balance_folio',
    ],
    knownAliases: [
      'Payment Summary', 'Payments by Tender', 'Daily Payments',
      'payment_summary', 'Deposit and Payment Report',
    ],
    datePolicy: 'business_date',
    naturalKey: ['date'],
    dedupePolicy: 'daily_supersession',
    financialChecksum: { field: 'total', toleranceCents: 1 },
    entitiesProduced: ['PaymentDay'],
    canonicalMetrics: ['paymentTotal', 'creditCardTotal', 'cashTotal', 'directBillTotal'],
    unknownFieldPolicy: 'quarantine_warn',
  },

  clerk: {
    reportType: 'clerk',
    schemaVersion: '1.0.0',
    displayName: 'Clerk Shift Summary',
    requiredHeaders: ['shift_date', 'clerk_name'],
    optionalHeaders: [
      'payment_type', 'record_type', 'actual', 'adjusted', 'net_today',
      'amount', 'transaction_count',
    ],
    knownAliases: [
      'Clerk Shift Report', 'User Shift Summary', 'Front Desk Shift',
      'clerk_summary',
    ],
    datePolicy: 'shift_date',
    naturalKey: ['shift_date', 'clerk_name', 'payment_type'],
    dedupePolicy: 'daily_supersession',
    financialChecksum: null,
    entitiesProduced: ['ClerkShiftRecord'],
    canonicalMetrics: ['clerkActual', 'clerkAdjusted', 'clerkNet'],
    unknownFieldPolicy: 'quarantine_warn',
  },

  hotel_statistics: {
    reportType: 'hotel_statistics',
    schemaVersion: '1.0.0',
    displayName: 'Hotel Statistics Snapshot',
    requiredHeaders: ['metric_description'],
    optionalHeaders: [
      'business_date', 'current_day', 'mtd', 'ytd', 'last_year_mtd',
      'last_year_ytd', 'budget_mtd', 'budget_ytd',
    ],
    knownAliases: [
      'Hotel Statistics Report', 'Statistics Snapshot', 'Management Statistics',
      'hotel_stats',
    ],
    datePolicy: 'business_date',
    naturalKey: ['business_date', 'metric_description'],
    dedupePolicy: 'daily_supersession',
    financialChecksum: null,
    entitiesProduced: ['HotelMetric'],
    canonicalMetrics: ['ytdRevPAR', 'ytdADR', 'ytdOccupancy', 'mtdRoomRevenue'],
    unknownFieldPolicy: 'quarantine_warn',
  },

  transactions: {
    reportType: 'transactions',
    schemaVersion: '1.0.0',
    displayName: 'All Transactions / Guest Ledger',
    requiredHeaders: ['date', 'transaction_code', 'amount'],
    optionalHeaders: [
      'time', 'username', 'transaction_type', 'charge_category',
      'sub_charge_type', 'outlet_name', 'ledger_side', 'payment_method',
      'account_class', 'employee_label', 'folio_number', 'confirmation_number',
      'room_number', 'guest_name', 'guest_first_name', 'guest_last_name',
      'card_last4', 'quantity', 'adults', 'remarks',
    ],
    knownAliases: [
      'All Transactions', 'Daily Transaction Journal', 'Guest Ledger Detail',
      'all_transactions', 'Detailed Transactions',
    ],
    datePolicy: 'transaction_timestamp',
    naturalKey: ['date', 'time', 'folio_number', 'transaction_code', 'amount'],
    dedupePolicy: 'transaction_trailer_checksum',
    financialChecksum: { trailerKeyword: 'total', toleranceCents: 1 },
    entitiesProduced: ['TransactionLine'],
    canonicalMetrics: ['transactionVolume', 'totalCharges', 'totalCredits'],
    unknownFieldPolicy: 'quarantine_warn',
  },

  adjustments_refunds: {
    reportType: 'adjustments_refunds',
    schemaVersion: '1.0.0',
    displayName: 'Adjustments & Refunds',
    requiredHeaders: ['date', 'amount'],
    optionalHeaders: [
      'record_type', 'username', 'reason', 'room_number', 'folio_number',
      'tax_amount', 'payment_method', 'guest_name', 'notes',
    ],
    knownAliases: [
      'Adjustments and Refunds', 'Adjustments & Refunds Report', 'Refund Journal',
      'adjustments_refunds', 'Front Desk Adjustments',
    ],
    datePolicy: 'transaction_timestamp',
    naturalKey: ['date', 'username', 'amount', 'room_number'],
    dedupePolicy: 'row_dedupe_hash',
    financialChecksum: null,
    entitiesProduced: ['AdjustmentRefund'],
    canonicalMetrics: ['totalRefunds', 'totalAdjustments', 'leakageRate'],
    unknownFieldPolicy: 'quarantine_warn',
  },
};

/**
 * Normalizes a raw report title/alias to a registered canonical reportType.
 * @param {string} rawType
 * @returns {string | null}
 */
export function resolveCanonicalReportType(rawType) {
  if (!rawType || typeof rawType !== 'string') return null;
  const clean = rawType.trim().toLowerCase().replace(/[-_]/g, ' ');
  for (const [type, schema] of Object.entries(HOTELKEY_SCHEMA_REGISTRY)) {
    if (type.toLowerCase() === clean.replace(/\s+/g, '_')) return type;
    if (schema.displayName.toLowerCase() === clean) return type;
    for (const alias of schema.knownAliases) {
      if (alias.toLowerCase() === clean) return type;
    }
  }
  return null;
}

/**
 * Validates a list of CSV headers against the canonical schema.
 * @param {string} reportType
 * @param {string[]} headers
 * @returns {{
 *   valid: boolean,
 *   schemaVersion: string,
 *   missingHeaders: string[],
 *   knownHeaders: string[],
 *   quarantinedHeaders: string[],
 *   warnings: string[]
 * }}
 */
export function validateReportHeaders(reportType, headers) {
  const schema = HOTELKEY_SCHEMA_REGISTRY[reportType];
  if (!schema) {
    return {
      valid: false,
      schemaVersion: '0.0.0',
      missingHeaders: [],
      knownHeaders: [],
      quarantinedHeaders: headers || [],
      warnings: [`Unrecognized report type: ${reportType}`],
    };
  }

  const normalizedInput = (headers || []).map((h) =>
    String(h || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_')
  );
  const knownSet = new Set([...schema.requiredHeaders, ...schema.optionalHeaders]);

  const missingHeaders = schema.requiredHeaders.filter(
    (req) => !normalizedInput.includes(req)
  );

  const knownHeaders = [];
  const quarantinedHeaders = [];
  const warnings = [];

  for (const h of normalizedInput) {
    if (!h) continue;
    if (knownSet.has(h)) {
      knownHeaders.push(h);
    } else {
      quarantinedHeaders.push(h);
    }
  }

  if (missingHeaders.length > 0) {
    warnings.push(`Missing required headers for ${schema.displayName}: ${missingHeaders.join(', ')}`);
  }
  if (quarantinedHeaders.length > 0) {
    warnings.push(
      `Quarantined ${quarantinedHeaders.length} unknown fields for ${schema.displayName}: ${quarantinedHeaders.join(', ')}`
    );
  }

  return {
    valid: missingHeaders.length === 0,
    schemaVersion: schema.schemaVersion,
    missingHeaders,
    knownHeaders,
    quarantinedHeaders,
    warnings,
  };
}

/**
 * Quarantines unmapped fields from a parsed row into a separate `_quarantine` bag
 * so unexpected or drifted HotelKey columns never corrupt financial invariants.
 *
 * @param {string} reportType
 * @param {Record<string, unknown>} rawRow
 * @returns {{ sanitizedRow: Record<string, unknown>, quarantinedFields: Record<string, unknown> }}
 */
export function quarantineRowFields(reportType, rawRow) {
  const schema = HOTELKEY_SCHEMA_REGISTRY[reportType];
  if (!schema || !rawRow || typeof rawRow !== 'object') {
    return { sanitizedRow: /** @type {Record<string, unknown>} */ (rawRow || {}), quarantinedFields: /** @type {Record<string, unknown>} */ ({}) };
  }

  const knownSet = new Set([...schema.requiredHeaders, ...schema.optionalHeaders, 'property_id', 'import_id', 'source_file', 'created_date']);
  /** @type {Record<string, unknown>} */
  const sanitizedRow = {};
  /** @type {Record<string, unknown>} */
  const quarantinedFields = {};

  for (const [key, value] of Object.entries(rawRow)) {
    const normKey = key.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
    if (knownSet.has(normKey) || key.startsWith('_')) {
      sanitizedRow[key] = value;
    } else {
      quarantinedFields[key] = value;
    }
  }

  return { sanitizedRow, quarantinedFields };
}
