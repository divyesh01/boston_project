/**
 * hotelkey-schema-registry.js
 * Worker-runtime canonical schema registry for HotelKey operational and financial reports.
 *
 * Worker runtime cannot import from src/, so this provides the server-authoritative
 * validation for report headers, financial checksum invariants, and unknown field quarantine.
 */

export const REGISTRY_VERSION = '1.0.0';

/** @type {Record<string, { reportType: string, requiredHeaders: string[], optionalHeaders: string[], knownAliases: string[] }>} */
export const HOTELKEY_SCHEMA_REGISTRY = {
  occupancy: {
    reportType: 'occupancy',
    requiredHeaders: ['date', 'room_revenue', 'rooms_sold', 'total_rooms'],
    optionalHeaders: [
      'day_of_week', 'other_room_revenue', 'total_revenue', 'down_rooms',
      'vacant_rooms', 'clean_rooms', 'dirty_rooms', 'stayover_rooms',
      'same_day_bookings', 'comp_rooms', 'house_rooms', 'zero_rate_rooms',
      'day_use_rooms', 'no_shows', 'cancellations', 'total_guests',
      'adr', 'occupancy', 'revpar',
    ],
    knownAliases: ['Occupancy Summary', 'Occupancy Summary Report', 'HotelKey Occupancy', 'occupancy_summary'],
  },
  gross_revenue: {
    reportType: 'gross_revenue',
    requiredHeaders: ['date', 'room_rent'],
    optionalHeaders: [
      'day_of_week', 'misc_charge', 'system_charge', 'food', 'event',
      'bar', 'laundry', 'phone', 'other', 'non_revenue', 'advance_deposit',
      'beverage', 'total_revenue',
    ],
    knownAliases: ['Gross Revenue Report', 'Daily Gross Revenue', 'Manager Report Revenue', 'gross_revenue'],
  },
  source: {
    reportType: 'source',
    requiredHeaders: ['date', 'source', 'net_revenue'],
    optionalHeaders: ['code', 'stays', 'adr', 'occupancy_contribution', 'revpar_contribution', 'day_of_week'],
    knownAliases: ['Source Report', 'Revenue by Source', 'Channel Mix Report', 'source_summary'],
  },
  payments: {
    reportType: 'payments',
    requiredHeaders: ['date', 'total'],
    optionalHeaders: [
      'day_of_week', 'cash', 'check', 'visa', 'master', 'mastercard',
      'amex', 'discover', 'direct_bill', 'wire_transfer', 'corpay',
      'loyalty_certificate', 'loyalty_discount', 'vip_pass', 'other',
      'closed_balance_folio',
    ],
    knownAliases: ['Payment Summary', 'Payments by Tender', 'Daily Payments', 'payment_summary'],
  },
  clerk: {
    reportType: 'clerk',
    requiredHeaders: ['shift_date', 'clerk_name'],
    optionalHeaders: ['payment_type', 'record_type', 'actual', 'adjusted', 'net_today', 'amount', 'transaction_count'],
    knownAliases: ['Clerk Shift Report', 'User Shift Summary', 'Front Desk Shift', 'clerk_summary'],
  },
  hotel_statistics: {
    reportType: 'hotel_statistics',
    requiredHeaders: ['metric_description'],
    optionalHeaders: ['business_date', 'current_day', 'mtd', 'ytd', 'last_year_mtd', 'last_year_ytd', 'budget_mtd', 'budget_ytd'],
    knownAliases: ['Hotel Statistics Report', 'Statistics Snapshot', 'Management Statistics', 'hotel_stats'],
  },
  transactions: {
    reportType: 'transactions',
    requiredHeaders: ['date', 'transaction_code', 'amount'],
    optionalHeaders: [
      'time', 'username', 'transaction_type', 'charge_category',
      'sub_charge_type', 'outlet_name', 'ledger_side', 'payment_method',
      'account_class', 'employee_label', 'folio_number', 'confirmation_number',
      'room_number', 'guest_name', 'guest_first_name', 'guest_last_name',
      'card_last4', 'quantity', 'adults', 'remarks',
    ],
    knownAliases: ['All Transactions', 'Daily Transaction Journal', 'Guest Ledger Detail', 'all_transactions'],
  },
  adjustments_refunds: {
    reportType: 'adjustments_refunds',
    requiredHeaders: ['date', 'amount'],
    optionalHeaders: ['record_type', 'username', 'reason', 'room_number', 'folio_number', 'tax_amount', 'payment_method', 'guest_name', 'notes'],
    knownAliases: ['Adjustments and Refunds', 'Adjustments & Refunds Report', 'Refund Journal', 'adjustments_refunds'],
  },
};

export function validateReportHeaders(reportType, headers) {
  const schema = HOTELKEY_SCHEMA_REGISTRY[reportType];
  if (!schema) return { valid: false, missingHeaders: [], quarantinedHeaders: headers || [] };
  const normalizedInput = (headers || []).map((h) => String(h || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_'));
  const knownSet = new Set([...schema.requiredHeaders, ...schema.optionalHeaders]);
  const missingHeaders = schema.requiredHeaders.filter((req) => !normalizedInput.includes(req));
  const quarantinedHeaders = normalizedInput.filter((h) => h && !knownSet.has(h));
  return {
    valid: missingHeaders.length === 0,
    missingHeaders,
    quarantinedHeaders,
  };
}
