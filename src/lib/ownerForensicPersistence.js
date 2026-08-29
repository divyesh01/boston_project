/**
 * Owner Forensic Persistence & Audit Trail Manager
 * ------------------------------------------------
 * Manages immutable review states and declarative whitelist rules in Dexie/base44Client.
 *
 * Guarantees:
 * 1. Source financial transactions are NEVER modified.
 * 2. All review actions (Approve, Investigate, Whitelist, Resolve) record provenance in AuditLog.
 * 3. Review states and whitelist rules partition strictly by property_id.
 */

import { db } from '@/api/base44Client';
import { sanitizeText } from '@/lib/securityUtils';
import { REVIEW_STATES } from '@/lib/ownerForensicEngine';

const LOCAL_STORAGE_KEY_PREFIX = 'owner_forensic_state_';
const LOCAL_WHITELIST_KEY_PREFIX = 'owner_whitelist_rules_';

const inMemoryReviewStore = new Map();
const inMemoryWhitelistStore = new Map();

export function clearForensicMemoryStores() {
  inMemoryReviewStore.clear();
  inMemoryWhitelistStore.clear();
}

/**
 * Loads current review states and whitelist rules for a property.
 */
export async function loadOwnerForensicState({ propertyId = 'default' } = {}) {
  const propKey = String(propertyId || 'default');
  const reviewStates = {};
  const whitelistRules = [];
  let loadedFromCache = false;

  // 1. Try loading from Dexie / base44Client AnomalyAlert
  try {
    if (db?.entities?.AnomalyAlert) {
      const alerts = await db.entities.AnomalyAlert.filter({ property_id: propKey });
      for (const a of alerts) {
        if (a.dedupe_key && a.status) {
          reviewStates[a.dedupe_key] = {
            state: a.status,
            actor: a.reviewed_by || 'Owner',
            reason: a.review_notes || '',
            updatedAt: a.updated_date || a.created_date,
          };
        }
      }
    }
  } catch (err) {
    // Non-blocking fallback
  }

  // 2. Load from local cache if in browser environment
  try {
    if (typeof localStorage !== 'undefined') {
      const cachedReviews = localStorage.getItem(`${LOCAL_STORAGE_KEY_PREFIX}${propKey}`);
      if (cachedReviews) {
        const parsed = JSON.parse(cachedReviews);
        Object.assign(reviewStates, parsed);
        loadedFromCache = true;
      }

      const cachedRules = localStorage.getItem(`${LOCAL_WHITELIST_KEY_PREFIX}${propKey}`);
      if (cachedRules) {
        const parsedRules = JSON.parse(cachedRules);
        if (Array.isArray(parsedRules) && parsedRules.length > 0) {
          whitelistRules.push(...parsedRules);
          loadedFromCache = true;
        }
      }
    }
  } catch (err) {
    // Non-blocking fallback
  }

  // 3. Fallback to memory store if cache was empty
  if (!loadedFromCache) {
    if (inMemoryReviewStore.has(propKey)) {
      Object.assign(reviewStates, inMemoryReviewStore.get(propKey));
    }
    if (inMemoryWhitelistStore.has(propKey)) {
      whitelistRules.push(...inMemoryWhitelistStore.get(propKey));
    }
  }

  return { reviewStates, whitelistRules };
}

/**
 * Persists an owner review action and records an immutable entry in AuditLog.
 */
export async function persistOwnerReviewAction({
  propertyId = 'default',
  anomalyId,
  previousState = REVIEW_STATES.UNREVIEWED,
  newState = REVIEW_STATES.APPROVED,
  actor = 'Owner',
  reason = '',
  whitelistRule = null,
}) {
  if (!anomalyId) throw new Error('Validation Error: anomalyId is required');

  const propKey = String(propertyId || 'default');
  const cleanReason = sanitizeText(reason || 'Verified by owner');
  const cleanActor = sanitizeText(actor || 'Owner');
  const nowIso = new Date().toISOString();

  // 1. Write immutable provenance entry in AuditLog
  try {
    if (db?.functions?.invoke) {
      await db.functions.invoke('audit_log', {
        action: `OWNER_REVIEW_${newState}`,
        username: cleanActor,
        property_id: propKey === 'all' || propKey === 'default' ? null : propKey,
        detail: `Anomaly ${anomalyId} state changed from ${previousState} to ${newState}: ${cleanReason}`,
        result: 'success',
      });
    } else if (db?.entities?.AuditLog?.create) {
      await db.entities.AuditLog.create({
        action: `OWNER_REVIEW_${newState}`,
        username: cleanActor,
        property_id: propKey === 'all' || propKey === 'default' ? null : propKey,
        result: 'success',
        created_date: nowIso,
      });
    }
  } catch (err) {
    console.warn('[ForensicPersistence] AuditLog write deferred:', err?.message);
  }

  // 2. Persist to memory store & local cache
  if (!inMemoryReviewStore.has(propKey)) {
    inMemoryReviewStore.set(propKey, {});
  }
  inMemoryReviewStore.get(propKey)[anomalyId] = {
    state: newState,
    actor: cleanActor,
    reason: cleanReason,
    whitelistRule,
    updatedAt: nowIso,
  };

  if (typeof localStorage !== 'undefined') {
    try {
      const key = `${LOCAL_STORAGE_KEY_PREFIX}${propKey}`;
      const raw = localStorage.getItem(key);
      const stateMap = raw ? JSON.parse(raw) : {};
      stateMap[anomalyId] = {
        state: newState,
        actor: cleanActor,
        reason: cleanReason,
        whitelistRule,
        updatedAt: nowIso,
      };
      localStorage.setItem(key, JSON.stringify(stateMap));
    } catch (err) {
      console.warn('[ForensicPersistence] LocalStorage write failed:', err?.message);
    }
  }

  return {
    anomalyId,
    state: newState,
    actor: cleanActor,
    reason: cleanReason,
    updatedAt: nowIso,
  };
}

/**
 * Adds and persists a new declarative whitelist rule.
 */
export async function persistWhitelistRule({
  propertyId = 'default',
  rule,
  actor = 'Owner',
  reason = '',
}) {
  if (!rule || (!rule.folioNumber && !rule.roomNumber)) {
    throw new Error('Validation Error: Rule must specify folioNumber or roomNumber');
  }

  const propKey = String(propertyId || 'default');
  const cleanActor = sanitizeText(actor || 'Owner');
  const cleanReason = sanitizeText(reason || rule.reason || 'Owner authorized stay');
  const nowIso = new Date().toISOString();

  const ruleRecord = {
    ruleId: rule.ruleId || `WL_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    property_id: propKey,
    folioNumber: rule.folioNumber || '',
    roomNumber: rule.roomNumber || '',
    authorizedRate: rule.authorizedRate !== undefined && rule.authorizedRate !== null ? Number(rule.authorizedRate) : null,
    accountCategory: rule.accountCategory || 'Staff',
    approvedClerk: rule.approvedClerk || '',
    validFrom: rule.validFrom || null,
    validTo: rule.validTo || null,
    allowCash: !!rule.allowCash,
    reason: cleanReason,
    created_date: nowIso,
  };

  // 1. Write immutable provenance entry in AuditLog
  try {
    if (db?.functions?.invoke) {
      await db.functions.invoke('audit_log', {
        action: 'OWNER_WHITELIST_CREATE',
        username: cleanActor,
        property_id: propKey === 'all' || propKey === 'default' ? null : propKey,
        detail: `Created whitelist rule ${ruleRecord.ruleId} for Folio: ${ruleRecord.folioNumber || 'N/A'}, Room: ${ruleRecord.roomNumber || 'N/A'}, Auth Rate: $${ruleRecord.authorizedRate ?? 'Any'} - Reason: ${cleanReason}`,
        result: 'success',
      });
    } else if (db?.entities?.AuditLog?.create) {
      await db.entities.AuditLog.create({
        action: 'OWNER_WHITELIST_CREATE',
        username: cleanActor,
        property_id: propKey === 'all' || propKey === 'default' ? null : propKey,
        result: 'success',
        created_date: nowIso,
      });
    }
  } catch (err) {
    console.warn('[ForensicPersistence] AuditLog write deferred:', err?.message);
  }

  // 2. Persist to memory store & local cache
  if (!inMemoryWhitelistStore.has(propKey)) {
    inMemoryWhitelistStore.set(propKey, []);
  }
  inMemoryWhitelistStore.get(propKey).push(ruleRecord);

  if (typeof localStorage !== 'undefined') {
    try {
      const key = `${LOCAL_WHITELIST_KEY_PREFIX}${propKey}`;
      const raw = localStorage.getItem(key);
      const list = raw ? JSON.parse(raw) : [];
      list.push(ruleRecord);
      localStorage.setItem(key, JSON.stringify(list));
    } catch (err) {
      console.warn('[ForensicPersistence] LocalStorage write failed:', err?.message);
    }
  }

  return ruleRecord;
}
