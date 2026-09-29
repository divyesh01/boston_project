import { describe, it, expect } from 'vitest';
import {
  HOTELKEY_SCHEMA_REGISTRY,
  resolveCanonicalReportType,
  validateReportHeaders,
  quarantineRowFields,
} from '../lib/hotelKeySchemaRegistry.js';

describe('HotelKey Versioned Schema Registry', () => {
  it('contains valid definitions for all 8 core report types', () => {
    const expectedTypes = [
      'occupancy',
      'gross_revenue',
      'source',
      'payments',
      'clerk',
      'hotel_statistics',
      'transactions',
      'adjustments_refunds',
    ];

    for (const type of expectedTypes) {
      const schema = HOTELKEY_SCHEMA_REGISTRY[type];
      expect(schema).toBeDefined();
      expect(schema.reportType).toBe(type);
      expect(schema.schemaVersion).toBe('1.0.0');
      expect(schema.requiredHeaders.length).toBeGreaterThan(0);
      expect(schema.entitiesProduced.length).toBeGreaterThan(0);
      expect(schema.canonicalMetrics.length).toBeGreaterThan(0);
    }
  });

  it('correctly resolves known report aliases to canonical types', () => {
    expect(resolveCanonicalReportType('Occupancy Summary')).toBe('occupancy');
    expect(resolveCanonicalReportType('occupancy_summary')).toBe('occupancy');
    expect(resolveCanonicalReportType('Gross Revenue Report')).toBe('gross_revenue');
    expect(resolveCanonicalReportType('Revenue by Source')).toBe('source');
    expect(resolveCanonicalReportType('Payments by Tender')).toBe('payments');
    expect(resolveCanonicalReportType('All Transactions')).toBe('transactions');
    expect(resolveCanonicalReportType('Adjustments and Refunds')).toBe('adjustments_refunds');
    expect(resolveCanonicalReportType('Unknown Weird Report')).toBeNull();
  });

  it('validates required headers and flags missing ones', () => {
    // Valid occupancy headers
    const validOcc = validateReportHeaders('occupancy', ['date', 'room_revenue', 'rooms_sold', 'total_rooms', 'adr']);
    expect(validOcc.valid).toBe(true);
    expect(validOcc.missingHeaders).toEqual([]);
    expect(validOcc.quarantinedHeaders).toEqual([]);

    // Missing room_revenue
    const missingOcc = validateReportHeaders('occupancy', ['date', 'rooms_sold', 'total_rooms']);
    expect(missingOcc.valid).toBe(false);
    expect(missingOcc.missingHeaders).toContain('room_revenue');
    expect(missingOcc.warnings.length).toBeGreaterThan(0);
  });

  it('quarantines unknown drifted headers without failing valid reports', () => {
    const drifted = validateReportHeaders('occupancy', [
      'date',
      'room_revenue',
      'rooms_sold',
      'total_rooms',
      'unknown_hotelkey_ai_metric_2026',
    ]);
    expect(drifted.valid).toBe(true);
    expect(drifted.missingHeaders).toEqual([]);
    expect(drifted.quarantinedHeaders).toContain('unknown_hotelkey_ai_metric_2026');
    expect(drifted.warnings[0]).toContain('Quarantined 1 unknown fields');
  });

  it('quarantines unknown row fields into a separate bag', () => {
    const rawRow = {
      date: '2026-08-01',
      room_revenue: 12500,
      rooms_sold: 80,
      total_rooms: 100,
      some_random_drifted_column: 'unexpected data',
    };

    const { sanitizedRow, quarantinedFields } = quarantineRowFields('occupancy', rawRow);
    expect(sanitizedRow.date).toBe('2026-08-01');
    expect(sanitizedRow.room_revenue).toBe(12500);
    expect(sanitizedRow.some_random_drifted_column).toBeUndefined();
    expect(quarantinedFields.some_random_drifted_column).toBe('unexpected data');
  });
});
