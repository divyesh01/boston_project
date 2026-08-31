export const HYDRATION_TABLES = Object.freeze([
  'Property', 'OccupancyDay', 'SourceDay', 'GrossRevenueDay', 'PaymentDay',
  'ClerkShiftRecord', 'UploadedReport', 'Expense', 'PayrollRun', 'Staff',
  'Room', 'RoomStay', 'HousekeepingTask', 'WeatherSnapshot', 'Review',
  'ImportRecordIds', 'ScanResult', 'HotelMetric', 'TransactionLine',
  'AnomalyAlert', 'Reservation', 'RoomType', 'ChannelMap', 'AdjustmentRefund',
  'TimecardPunch', 'DailyFinancialAggregate', 'IdSequence',
]);

export const PROPERTY_SCOPED_TABLES = Object.freeze(
  HYDRATION_TABLES.filter((name) => !['Property', 'IdSequence'].includes(name)),
);

export const HYDRATION_SETTINGS_KEYS = Object.freeze([
  'rri_commission_rates_v2', 'rri_cc_fee_rate', 'rri_cc_fee_refunds_v1',
  'rri_tax_settings_v1', 'rri_tax_config_v1', 'rri_alert_thresholds',
  'rri_revenue_thresholds', 'rri_pricing_config', 'rri_weather_config',
  'rri_automationRules', 'rri_reportHistory',
]);

export const HYDRATION_SETTINGS_PREFIXES = Object.freeze([
  'rri_housekeeping_config_', 'rri_filters_',
]);

export function isAllowedSetting(key) {
  return HYDRATION_SETTINGS_KEYS.includes(key)
    || HYDRATION_SETTINGS_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function assertJsonValue(value, path, seen) {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object') throw new Error(`${path} is not JSON-safe`);
  if (seen.has(value)) throw new Error(`${path} contains a cycle`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${path}[${index}]`, seen));
  } else {
    for (const [key, item] of Object.entries(value)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) {
        throw new Error(`${path} contains a forbidden key`);
      }
      assertJsonValue(item, `${path}.${key}`, seen);
    }
  }
  seen.delete(value);
}

export function validateAndNormalizeSnapshot(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Snapshot must be an object');
  }
  const inputTables = input.tables;
  const inputSettings = input.settings;
  if (!inputTables || typeof inputTables !== 'object' || Array.isArray(inputTables)) {
    throw new Error('Snapshot tables must be an object');
  }
  const unknownTables = Object.keys(inputTables).filter((name) => !HYDRATION_TABLES.includes(name));
  if (unknownTables.length) throw new Error(`Unknown snapshot tables: ${unknownTables.join(', ')}`);

  const tables = {};
  for (const tableName of HYDRATION_TABLES) {
    const rows = inputTables[tableName] ?? [];
    if (!Array.isArray(rows)) throw new Error(`${tableName} must be an array`);
    if (rows.length > 500000) throw new Error(`${tableName} exceeds the row limit`);
    rows.forEach((row, index) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        throw new Error(`${tableName}[${index}] must be an object`);
      }
      assertJsonValue(row, `${tableName}[${index}]`, new WeakSet());
    });
    tables[tableName] = rows;
  }

  if (inputSettings == null) return { tables, settings: {} };
  if (typeof inputSettings !== 'object' || Array.isArray(inputSettings)) {
    throw new Error('Snapshot settings must be an object');
  }
  const settings = {};
  for (const [key, value] of Object.entries(inputSettings)) {
    if (!isAllowedSetting(key)) throw new Error(`Unknown setting key: ${key}`);
    if (typeof value !== 'string') throw new Error(`Setting ${key} must be a string`);
    settings[key] = value;
  }
  return { tables, settings };
}

export function assertSnapshotPropertyIntegrity(snapshot) {
  const propertyIds = new Set(snapshot.tables.Property.map((row) => String(row.id)));
  if (propertyIds.has('undefined') || propertyIds.has('null')) {
    throw new Error('Every Property row requires an id');
  }
  for (const tableName of PROPERTY_SCOPED_TABLES) {
    snapshot.tables[tableName].forEach((row, index) => {
      const propertyId = row.property_id;
      if (propertyId == null || !propertyIds.has(String(propertyId))) {
        throw new Error(`${tableName}[${index}] has an unknown property_id`);
      }
    });
  }
}

export function filterSnapshotForProperties(snapshot, allowedPropertyIds) {
  if (allowedPropertyIds === 'all') return snapshot;
  const allowed = new Set(allowedPropertyIds.map(String));
  const tables = { ...snapshot.tables };
  tables.Property = tables.Property.filter((row) => allowed.has(String(row.id)));
  for (const tableName of PROPERTY_SCOPED_TABLES) {
    tables[tableName] = tables[tableName].filter((row) => allowed.has(String(row.property_id)));
  }
  tables.IdSequence = [];
  return { tables, settings: {} };
}
