import { readJsonSetting, readScopedJsonSetting, writeJsonSetting, queueCloudSettingSync } from './settingsStore.js';
import { notifySettingsChanged, getSettingsVersion } from './settingsBus.js';
import { ENTERPRISE_PROFILE_KEY, ENTERPRISE_DEFAULT_KEY, ENTERPRISE_TEMPLATE_KEY, CLUSTERS, validateEnterpriseProfile, validateEnterpriseTemplates, validatePeriods } from './enterpriseSchema.js';
import { isBusinessDate } from './businessDate.js';

export function getPropertyProfile(propertyId) {
  return readScopedJsonSetting(ENTERPRISE_PROFILE_KEY, null, propertyId);
}
let cachedVersion = -1, cachedTemplates = {}, cachedDefaults = [];
function effective(periods, date) {
  if (!isBusinessDate(date)) return {};
  return (Array.isArray(periods) ? periods : []).filter(p => (!p.effective_start || date >= p.effective_start) && (!p.effective_end || date <= p.effective_end))
    .sort((a, b) => String(a.effective_start || '').localeCompare(String(b.effective_start || '')))
    .reduce((out, p) => ({ ...out, ...p }), {});
}
export function getEnterpriseConfig(propertyId, date, property = {}) {
  const profile = getPropertyProfile(propertyId) || {};
  const version = getSettingsVersion();
  if (cachedVersion !== version) {
    cachedTemplates = readJsonSetting(ENTERPRISE_TEMPLATE_KEY, { states: {}, regions: {} });
    cachedDefaults = readJsonSetting(ENTERPRISE_DEFAULT_KEY, []);
    cachedVersion = version;
  }
  const templates = cachedTemplates, defaults = cachedDefaults;
  const state = profile.state || property.state || '';
  const region = profile.region || '';
  const policy = { ...effective(defaults, date), ...effective(templates.states?.[state], date), ...effective(templates.regions?.[region], date), ...effective(profile.periods, date) };
  const cluster = CLUSTERS[policy.cluster] || {};
  return { ...cluster, ...policy, property_id: propertyId, state, region, timezone: profile.timezone || null, current_business_date: profile.current_business_date || null,
    night_audit_status: profile.night_audit_status || 'OPEN', pms: profile.pms || 'hotelkey', employer_of_record: profile.employer_of_record || null, employer_group_id: profile.employer_group_id || null,
    capacity: policy.capacity ?? (Number(property.rooms) > 0 ? Number(property.rooms) : null), configured: Object.keys(profile).length > 0 };
}
export function savePropertyProfile(propertyId, profile) {
  if (propertyId == null || ['', '*', 'all'].includes(String(propertyId)) || Array.isArray(propertyId)) throw new Error('Select one property.');
  validateEnterpriseProfile(profile);
  if (!writeJsonSetting(ENTERPRISE_PROFILE_KEY, profile, String(propertyId))) throw new Error('Could not store the property profile.');
  notifySettingsChanged();
}
export function saveEnterpriseTemplate(bucket, name, periods) {
  validatePeriods(periods);
  const templates = readJsonSetting(ENTERPRISE_TEMPLATE_KEY, { states: {}, regions: {} });
  if (!['states', 'regions'].includes(bucket) || !name) throw new Error('Select a state or region.');
  const old = templates[bucket]?.[name] || [];
  const merged = [...old.filter(p => !periods.some(n => (n.effective_start || '') === (p.effective_start || ''))), ...periods];
  const next = { ...templates, [bucket]: { ...templates[bucket], [name]: merged } };
  validateEnterpriseTemplates(next);
  if (!writeJsonSetting(ENTERPRISE_TEMPLATE_KEY, next)) throw new Error('Could not save the template.');
  notifySettingsChanged();
}
export function saveEnterpriseDefaults(periods) {
  const old = readJsonSetting(ENTERPRISE_DEFAULT_KEY, []);
  const merged = [...old.filter(p => !periods.some(n => (n.effective_start || '') === (p.effective_start || ''))), ...periods];
  validatePeriods(merged);
  if (!writeJsonSetting(ENTERPRISE_DEFAULT_KEY, merged)) throw new Error('Could not save global defaults.');
  notifySettingsChanged();
}

// Preview and validate the entire roster before mutating any local profile.
export function previewBulkPolicy(properties, period) {
  validatePeriods([period]);
  return properties.map(property => {
    const before = getPropertyProfile(property.id) || { periods: [] };
    const periods = [...(before.periods || []).filter(p => p.effective_start !== period.effective_start || (p.effective_end || '') !== (period.effective_end || '')), period];
    const after = validateEnterpriseProfile({ ...before, periods });
    return { property, before, after };
  });
}
export function applyBulkPolicy(preview) {
  if (!preview.length || preview.length > 100) throw new Error('Select 1–100 properties.');
  preview.forEach(row => validateEnterpriseProfile(row.after));
  // One local write, then one cloud batch. No partially updated local portfolio.
  const byProperty = readJsonSetting('rri_settings_by_property', {});
  for (const row of preview) byProperty[String(row.property.id)] = { ...byProperty[String(row.property.id)], [ENTERPRISE_PROFILE_KEY]: row.after };
  if (!writeJsonSetting('rri_settings_by_property', byProperty)) throw new Error('Could not store the bulk changes.');
  for (const row of preview) queueCloudSettingSync(ENTERPRISE_PROFILE_KEY, row.after, row.property.id);
  notifySettingsChanged();
}
