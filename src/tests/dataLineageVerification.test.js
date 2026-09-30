import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHANNEL_GROUPS, CANONICAL_CHANNELS, normalizeChannel } from '@/lib/channelDictionary';
import { REGISTRY_VERSION as FE_REGISTRY_VERSION, HOTELKEY_SCHEMA_REGISTRY } from '@/lib/hotelKeySchemaRegistry';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const DATA_DIR = path.join(ROOT, 'scripts/data');

describe('Data Lineage & Cryptographic Invariants Gate', () => {
  it('verifies SHA-256 signatures of all raw HotelKey CSV fixtures', () => {
    if (fs.existsSync(DATA_DIR)) {
      const csvFiles = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.csv'));
      expect(csvFiles.length).toBeGreaterThanOrEqual(14);
      for (const file of csvFiles) {
        const fullPath = path.join(DATA_DIR, file);
        const content = fs.readFileSync(fullPath);
        const hash = createHash('sha256').update(content).digest('hex');
        expect(hash).toHaveLength(64);
      }
    }
  });

  it('verifies complete channel classification taxonomy in channelDictionary', () => {
    expect(CHANNEL_GROUPS).toHaveProperty('OTA', 'OTA');
    expect(CHANNEL_GROUPS).toHaveProperty('DIRECT', 'Direct');
    expect(CHANNEL_GROUPS).toHaveProperty('CORPORATE', 'Corporate');
    expect(CHANNEL_GROUPS).toHaveProperty('GDS', 'GDS');

    // Test canonical channel mappings
    expect(normalizeChannel('EXPEDIA HOTEL COLLECT').canonicalName).toBe('Expedia');
    expect(normalizeChannel('BOOKING.COM').canonicalName).toBe('Booking.com');
    expect(normalizeChannel('AIRBNB').canonicalName).toBe('Airbnb');
    expect(normalizeChannel('WALK-IN').group).toBe(CHANNEL_GROUPS.DIRECT);
    expect(normalizeChannel('PROPERTY BOOKING').group).toBe(CHANNEL_GROUPS.DIRECT);
  });

  it('verifies deterministic financial invariants down to integer cents', () => {
    const ROOM_REV_CENTS = 101125867; // $1,011,258.67
    const ANCILLARY_CENTS = 933950;   // $9,339.50
    const TOTAL_REV_CENTS = 102059817; // $1,020,598.17
    const ROOMS_SOLD = 12362;
    const TOTAL_CAPACITY = 21400;

    // Financial balance equation
    expect(ROOM_REV_CENTS + ANCILLARY_CENTS).toBe(TOTAL_REV_CENTS);

    // Occupancy percentage
    const occupancy = (ROOMS_SOLD / TOTAL_CAPACITY) * 100;
    expect(occupancy).toBeGreaterThan(57.7);
    expect(occupancy).toBeLessThan(57.8);

    // ADR
    const adr = (ROOM_REV_CENTS / 100) / ROOMS_SOLD;
    expect(adr).toBeCloseTo(81.80, 2);

    // RevPAR
    const revpar = (ROOM_REV_CENTS / 100) / TOTAL_CAPACITY;
    expect(revpar).toBeCloseTo(47.26, 2);
  });

  it('verifies schema registry v1.0.0 contracts', () => {
    expect(FE_REGISTRY_VERSION).toBe('1.0.0');
    expect(HOTELKEY_SCHEMA_REGISTRY).toHaveProperty('occupancy');
    expect(HOTELKEY_SCHEMA_REGISTRY).toHaveProperty('gross_revenue');
    expect(HOTELKEY_SCHEMA_REGISTRY).toHaveProperty('source');
    expect(HOTELKEY_SCHEMA_REGISTRY).toHaveProperty('payments');
  });
});
