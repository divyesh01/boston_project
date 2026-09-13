// scripts/canary/fixture-generator.mjs
// Deterministic synthetic HotelKey fixture generator with ugly variants and expected-result oracles.

import { sha256Hex, buildNormalizedBundle, compressPayloadGzip } from '../../src/lib/bulkImportPipeline.js';
import { contentHash, normalizedContent, REPORT_ENTITY } from '../../worker/bulk-contract.js';

/**
 * Fast deterministic pseudo-random number generator (Mulberry32).
 * @param {number|string} seedInput
 */
export function createRng(seedInput) {
  let s = 0;
  if (typeof seedInput === 'string') {
    for (let i = 0; i < seedInput.length; i++) {
      s = (Math.imul(31, s) + seedInput.charCodeAt(i)) >>> 0;
    }
  } else {
    s = (seedInput >>> 0) || 123456789;
  }

  return function next() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const REPORT_TYPES = Object.freeze([
  'transactions',
  'adjustments_refunds',
  'source',
  'occupancy',
  'gross_revenue',
  'payments',
  'clerk',
  'hotel_statistics',
  'timecard',
]);

/**
 * Format a date as YYYY-MM-DD given day offset.
 * @param {number} dayOffset
 * @returns {string}
 */
export function offsetDate(dayOffset = 0, baseYear = 2026, baseMonth = 9, baseDay = 1) {
  const d = new Date(Date.UTC(baseYear, baseMonth - 1, baseDay + dayOffset));
  return d.toISOString().slice(0, 10);
}

/**
 * Generate synthetic CSV text and structured scan data for a specific report type.
 * @param {string} reportType
 * @param {number} rowCount
 * @param {object} [options]
 * @param {number|string} [options.seed]
 * @param {boolean} [options.bom]
 * @param {boolean} [options.quotedCommas]
 * @param {boolean} [options.escapedQuotes]
 * @param {boolean} [options.newlinesInQuotes]
 * @param {boolean} [options.negativeAmounts]
 * @param {boolean} [options.extraWhitespace]
 * @param {boolean} [options.repeatedHeader]
 */
export function generateSyntheticCsv(reportType, rowCount = 5, options = {}) {
  const rng = createRng(options.seed ?? `${reportType}-${rowCount}`);
  const {
    bom = false,
    quotedCommas = false,
    escapedQuotes = false,
    newlinesInQuotes = false,
    negativeAmounts = false,
    extraWhitespace = false,
    repeatedHeader = false,
  } = options;

  let headers = [];
  const rows = [];
  const scanRows = [];

  switch (reportType) {
    case 'transactions': {
      headers = ['Date', 'Time', 'Folio Number', 'Room Number', 'Guest Name', 'Transaction Code', 'Description', 'Amount', 'Clerk Name'];
      for (let i = 0; i < rowCount; i++) {
        const date = offsetDate(i % 14);
        const time = `${String(8 + (i % 12)).padStart(2, '0')}:15:00`;
        const folio = `F${10000 + i}`;
        const room = String(101 + (i % 40));
        let guest = `Guest ${i + 1}`;
        if (quotedCommas && i % 3 === 0) guest = `"Doe, John #${i + 1}"`;
        if (escapedQuotes && i % 5 === 0) guest = `"Special ""VIP"" Guest"`;
        const code = (i % 2 === 0) ? 'RM' : 'TAX';
        let desc = (code === 'RM') ? 'Room Charge' : 'State & City Tax';
        if (newlinesInQuotes && i % 7 === 0) desc = `"Room Charge\nLate Checkout"`;
        let amtNum = +(50 + (rng() * 150)).toFixed(2);
        if (negativeAmounts && i % 4 === 0) amtNum = -amtNum;
        const amountStr = amtNum < 0 ? `-$${Math.abs(amtNum).toFixed(2)}` : `$${amtNum.toFixed(2)}`;
        const clerk = `Clerk_${(i % 4) + 1}`;

        rows.push([date, time, folio, room, guest, code, desc, amountStr, clerk].join(','));
        scanRows.push({
          date,
          time,
          folio_number: folio,
          room_number: room,
          guest_name: guest.replace(/^"|"$/g, '').replace(/""/g, '"'),
          transaction_code: code,
          description: desc.replace(/^"|"$/g, '').replace(/""/g, '"'),
          amount: amtNum,
          clerk_name: clerk,
          dedupe_key: `${folio}|${code}|${i}`,
        });
      }
      break;
    }

    case 'adjustments_refunds': {
      headers = ['Date', 'Time', 'Username', 'Room Number', 'Transaction Number', 'Reason', 'Adjusted Amount', 'Type'];
      for (let i = 0; i < rowCount; i++) {
        const date = offsetDate(i % 14);
        const time = '14:30:00';
        const user = `user_${(i % 3) + 1}`;
        const room = String(201 + (i % 20));
        const txn = `TX${20000 + i}`;
        let reason = 'Customer Satisfaction';
        if (quotedCommas && i % 2 === 0) reason = `"AC issue, Room ${room}"`;
        let amtNum = +(10 + (rng() * 40)).toFixed(2);
        const isRefund = i % 2 === 1;
        const type = isRefund ? 'Refund' : 'Adjustment';
        const amtStr = `$${amtNum.toFixed(2)}`;

        rows.push([date, time, user, room, txn, reason, amtStr, type].join(','));
        scanRows.push({
          date,
          time,
          username: user,
          roomNumber: room,
          transactionNumber: txn,
          reason: reason.replace(/^"|"$/g, ''),
          adjustedAmount: amtNum,
          record_type: isRefund ? 'refund' : 'adj',
        });
      }
      break;
    }

    case 'source': {
      headers = ['Date', 'Source', 'Code', 'Rooms Sold', 'Room Revenue', 'ADR'];
      const sources = [
        { name: 'Direct', code: 'DIR' },
        { name: 'Expedia', code: 'EXP' },
        { name: 'Booking.com', code: 'BDC' },
      ];
      for (let i = 0; i < rowCount; i++) {
        const date = offsetDate(Math.floor(i / sources.length));
        const s = sources[i % sources.length];
        const sold = Math.floor(5 + rng() * 20);
        const rev = +(sold * (70 + rng() * 30)).toFixed(2);
        const adr = +(rev / sold).toFixed(2);

        rows.push([date, s.name, s.code, String(sold), `$${rev.toFixed(2)}`, `$${adr.toFixed(2)}`].join(','));
        scanRows.push({
          date,
          source: s.name,
          code: s.code,
          rooms_sold: sold,
          room_revenue: rev,
          adr,
        });
      }
      break;
    }

    case 'occupancy': {
      headers = ['Date', 'Rooms Available', 'Rooms Sold', 'Comp Rooms', 'Out of Order', 'Occupancy Rate'];
      for (let i = 0; i < rowCount; i++) {
        const date = offsetDate(i);
        const avail = 50;
        const sold = Math.floor(25 + rng() * 25);
        const comp = Math.floor(rng() * 3);
        const ooo = Math.floor(rng() * 2);
        const occRate = +((sold / avail) * 100).toFixed(1);

        rows.push([date, String(avail), String(sold), String(comp), String(ooo), `${occRate}%`].join(','));
        scanRows.push({
          date,
          rooms_available: avail,
          rooms_sold: sold,
          comp_rooms: comp,
          out_of_order: ooo,
          occupancy_rate: occRate,
        });
      }
      break;
    }

    case 'gross_revenue': {
      headers = ['Date', 'Room Revenue', 'Tax', 'Food & Beverage', 'Other Revenue', 'Total Revenue'];
      for (let i = 0; i < rowCount; i++) {
        const date = offsetDate(i);
        const roomRev = +(2000 + rng() * 1500).toFixed(2);
        const tax = +(roomRev * 0.12).toFixed(2);
        const fb = +(100 + rng() * 50).toFixed(2);
        const other = +(20 + rng() * 30).toFixed(2);
        const total = +(roomRev + tax + fb + other).toFixed(2);

        rows.push([date, `$${roomRev.toFixed(2)}`, `$${tax.toFixed(2)}`, `$${fb.toFixed(2)}`, `$${other.toFixed(2)}`, `$${total.toFixed(2)}`].join(','));
        scanRows.push({
          date,
          room_revenue: roomRev,
          tax,
          food_beverage: fb,
          other_revenue: other,
          total_revenue: total,
        });
      }
      break;
    }

    case 'payments': {
      headers = ['Date', 'Cash', 'Visa', 'MasterCard', 'Amex', 'Discover', 'Direct Bill', 'Total Payments'];
      for (let i = 0; i < rowCount; i++) {
        const date = offsetDate(i);
        const cash = +(100 + rng() * 200).toFixed(2);
        const visa = +(800 + rng() * 600).toFixed(2);
        const mc = +(400 + rng() * 300).toFixed(2);
        const amex = +(200 + rng() * 200).toFixed(2);
        const disc = +(50 + rng() * 100).toFixed(2);
        const bill = 0;
        const total = +(cash + visa + mc + amex + disc + bill).toFixed(2);

        rows.push([date, `$${cash.toFixed(2)}`, `$${visa.toFixed(2)}`, `$${mc.toFixed(2)}`, `$${amex.toFixed(2)}`, `$${disc.toFixed(2)}`, `$${bill.toFixed(2)}`, `$${total.toFixed(2)}`].join(','));
        scanRows.push({
          date,
          cash,
          visa,
          mastercard: mc,
          amex,
          discover: disc,
          direct_bill: bill,
          total_payments: total,
          total,
        });
      }
      break;
    }

    case 'clerk': {
      headers = ['Shift Date', 'Clerk Name', 'Payment Type', 'Amount', 'Record Type', 'Section Key'];
      for (let i = 0; i < rowCount; i++) {
        const date = offsetDate(i % 7);
        const clerk = `Clerk_${(i % 3) + 1}`;
        const pType = (i % 2 === 0) ? 'Visa' : 'Cash';
        const amt = +(150 + rng() * 300).toFixed(2);
        const recType = (i % 5 === 0) ? 'drop' : 'payment';
        const sec = 'front_desk';

        rows.push([date, clerk, pType, `$${amt.toFixed(2)}`, recType, sec].join(','));
        scanRows.push({
          shift_date: date,
          clerk_name: clerk,
          payment_type: pType,
          amount: amt,
          record_type: recType,
          _sectionKey: sec,
        });
      }
      break;
    }

    case 'hotel_statistics': {
      headers = ['Business Date', 'Section', 'Metric Name', 'Period', 'Property ID', 'Value'];
      for (let i = 0; i < rowCount; i++) {
        const date = offsetDate(i % 10);
        const sec = 'Summary';
        const metric = `Metric_${(i % 4) + 1}`;
        const period = 'Day';
        const val = +(50 + rng() * 100).toFixed(2);

        rows.push([date, sec, metric, period, 'PROP_TEST', String(val)].join(','));
        scanRows.push({
          business_date: date,
          section: sec,
          metric_name: metric,
          period,
          property_id: 'PROP_TEST',
          value: val,
        });
      }
      break;
    }

    case 'timecard': {
      headers = ['Employee Name', 'Shift Date', 'Clock In', 'Clock Out', 'Total Hours', 'Department'];
      for (let i = 0; i < rowCount; i++) {
        const emp = `Employee_${(i % 5) + 1}`;
        const date = offsetDate(i % 14);
        const cin = '08:00';
        const cout = '16:30';
        const hrs = 8.5;
        const dept = (i % 2 === 0) ? 'Front Desk' : 'Housekeeping';

        rows.push([emp, date, cin, cout, String(hrs), dept].join(','));
        scanRows.push({
          employee_name: emp,
          shift_date: date,
          clock_in: cin,
          clock_out: cout,
          total_hours: hrs,
          department: dept,
        });
      }
      break;
    }

    default:
      throw new Error(`Unsupported report type: ${reportType}`);
  }

  const lines = [headers.join(',')];
  for (let i = 0; i < rows.length; i++) {
    if (repeatedHeader && i > 0 && i % 50 === 0) {
      lines.push(headers.join(','));
    }
    if (extraWhitespace && i % 10 === 0) {
      lines.push('   '); // blank whitespace row
    }
    lines.push(extraWhitespace ? `${rows[i]}   ` : rows[i]);
  }

  let rawCsv = lines.join('\n') + '\n';
  if (bom) {
    rawCsv = '\uFEFF' + rawCsv;
  }

  // ScanResult formatted for buildNormalizedBundle
  const scanResult = {
    type: reportType,
    totalRows: scanRows.length,
    validation: { ok: true, errors: [] },
  };

  if (reportType === 'clerk') {
    scanResult.payments = scanRows.filter((r) => r.record_type === 'payment');
    scanResult.drops = scanRows.filter((r) => r.record_type === 'drop');
    scanResult.clerkPayments = scanRows.filter((r) => r.record_type !== 'payment' && r.record_type !== 'drop');
  } else if (reportType === 'adjustments_refunds') {
    scanResult.adjustments = scanRows.filter((r) => r.record_type === 'adj');
    scanResult.refunds = scanRows.filter((r) => r.record_type === 'refund');
  } else if (reportType === 'hotel_statistics') {
    scanResult.metrics = scanRows;
  } else {
    scanResult.rowsToImport = scanRows;
  }

  return {
    rawCsv,
    scanResult,
    rowCount: scanRows.length,
  };
}

/**
 * Generates synthetic fixture and computes full deterministic oracle expectations.
 * @param {object} params
 * @param {string} params.reportType
 * @param {number} [params.rowCount]
 * @param {string} [params.accountId]
 * @param {string} [params.propertyId]
 * @param {string} [params.propertyName]
 * @param {string} [params.fileName]
 * @param {object} [params.options]
 * @returns {Promise<{
 *   rawBytes: Uint8Array,
 *   rawSha256: string,
 *   rawCanonicalKey: string,
 *   scanResult: object,
 *   bundle: object,
 *   normalizedHash: string,
 *   bundleCanonicalKey: string,
 *   compressedBundle: Uint8Array,
 *   payloadSha256: string,
 *   rowCount: number,
 *   entityCounts: Record<string, number>,
 *   minDate: string|null,
 *   maxDate: string|null,
 *   reportType: string,
 * }>}
 */
export async function generateFixtureWithOracle({
  reportType,
  rowCount = 5,
  accountId = 'canary-acc-1',
  propertyId = 'canary-prop-1',
  propertyName = 'Canary Red Roof Inn',
  fileName = 'report.csv',
  options = {},
}) {
  const { rawCsv, scanResult } = generateSyntheticCsv(reportType, rowCount, options);
  const rawBytes = new TextEncoder().encode(rawCsv);
  const rawSha256 = await sha256Hex(rawBytes);
  const rawCanonicalKey = `rri-raw/${accountId}/${propertyId}/${rawSha256}`;

  const bundleId = `canary_${Date.now()}_${rawSha256.slice(0, 8)}`;
  const bundle = buildNormalizedBundle(
    scanResult,
    { propertyId, propertyName, sourceFile: fileName },
    bundleId
  );

  const parsedBundleItems = bundle.ndjson
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  const normalizedHash = await contentHash(normalizedContent(parsedBundleItems));
  const bundleCanonicalKey = `rri-data/${accountId}/${propertyId}/${normalizedHash}`;

  const compressedBundle = await compressPayloadGzip(bundle.ndjson);
  const payloadSha256 = await sha256Hex(compressedBundle);

  return {
    rawBytes,
    rawSha256,
    rawCanonicalKey,
    scanResult,
    bundle,
    normalizedHash,
    bundleCanonicalKey,
    compressedBundle,
    payloadSha256,
    rowCount: bundle.totalRowCount,
    entityCounts: bundle.entityCounts,
    minDate: bundle.minDate,
    maxDate: bundle.maxDate,
    reportType,
  };
}
