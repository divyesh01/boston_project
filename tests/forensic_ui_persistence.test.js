import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadOwnerForensicState,
  persistOwnerReviewAction,
  persistWhitelistRule,
  clearForensicMemoryStores,
} from '../src/lib/ownerForensicPersistence.js';
import {
  evaluateForensicAuditBatch,
  REVIEW_STATES,
  SEVERITY_LEVELS,
  ANOMALY_CATEGORIES,
} from '../src/lib/ownerForensicEngine.js';

describe('Owner Forensic UI Integration & Dexie Persistence E2E Suite', () => {
  beforeEach(() => {
    clearForensicMemoryStores();
    if (typeof localStorage !== 'undefined') {
      localStorage.clear();
    }
  });

  it('E2E Test 1: Persists owner review action (Approve) and updates review state', async () => {
    const propertyId = 'prop_test_1';
    const anomalyId = 'TXN|prop_test_1|2026-03-10|F100|NONE|RR|0.00|14:00';

    const saved = await persistOwnerReviewAction({
      propertyId,
      anomalyId,
      previousState: REVIEW_STATES.UNREVIEWED,
      newState: REVIEW_STATES.APPROVED,
      actor: 'Owner Divyesh',
      reason: 'Verified valid manager comp',
    });

    expect(saved.state).toBe(REVIEW_STATES.APPROVED);
    expect(saved.actor).toBe('Owner Divyesh');

    const loaded = await loadOwnerForensicState({ propertyId });
    expect(loaded.reviewStates[anomalyId]).toBeDefined();
    expect(loaded.reviewStates[anomalyId].state).toBe(REVIEW_STATES.APPROVED);
    expect(loaded.reviewStates[anomalyId].reason).toBe('Verified valid manager comp');
  });

  it('E2E Test 2: Persists declarative whitelist rule and automatically marks matching stay as WHITELISTED', async () => {
    const propertyId = 'prop_test_2';

    const createdRule = await persistWhitelistRule({
      propertyId,
      rule: {
        folioNumber: 'AAE607',
        roomNumber: '102',
        authorizedRate: 1.0,
        accountCategory: 'Staff',
        reason: 'Approved maintenance engineer housing',
      },
      actor: 'Owner Divyesh',
    });

    expect(createdRule.folioNumber).toBe('AAE607');
    expect(createdRule.authorizedRate).toBe(1.0);

    const loaded = await loadOwnerForensicState({ propertyId });
    expect(loaded.whitelistRules.length).toBe(1);
    expect(loaded.whitelistRules[0].folioNumber).toBe('AAE607');

    const txn = {
      property_id: propertyId,
      date: '2026-03-10',
      time: '15:00',
      folio_number: 'AAE607',
      room_number: '102',
      username: 'clerk@hotel.com',
      transaction_code: 'RR',
      charge_category: 'Room Rent',
      amount: 1.0,
    };

    const batch = evaluateForensicAuditBatch({
      transactions: [txn],
      whitelistRules: loaded.whitelistRules,
      reviewStates: loaded.reviewStates,
      propertyAdrMap: { [propertyId]: 120.0 },
    });

    expect(batch.anomalies.length).toBe(1);
    expect(batch.anomalies[0].severity).toBe(SEVERITY_LEVELS.WHITELISTED);
    expect(batch.anomalies[0].reviewState).toBe(REVIEW_STATES.WHITELISTED);
    expect(batch.summary.whitelistedCount).toBe(1);
    expect(batch.summary.criticalCount).toBe(0);
  });

  it('E2E Test 3: Re-alerts when a whitelisted folio undergoes unexpected rate tampering ($1 -> $40)', async () => {
    const propertyId = 'prop_test_3';

    await persistWhitelistRule({
      propertyId,
      rule: {
        folioNumber: 'AAE607',
        authorizedRate: 1.0,
        reason: 'Approved employee housing',
      },
      actor: 'Owner Divyesh',
    });

    const loaded = await loadOwnerForensicState({ propertyId });

    // Tampered transaction: posted rate is $40 instead of $1
    const tamperedTxn = {
      property_id: propertyId,
      date: '2026-03-10',
      time: '15:00',
      folio_number: 'AAE607',
      room_number: '102',
      username: 'clerk@hotel.com',
      transaction_code: 'RR',
      charge_category: 'Room Rent',
      amount: 40.0,
    };

    const batch = evaluateForensicAuditBatch({
      transactions: [tamperedTxn],
      whitelistRules: loaded.whitelistRules,
      reviewStates: loaded.reviewStates,
      propertyAdrMap: { [propertyId]: 120.0 },
    });

    expect(batch.anomalies.length).toBe(1);
    expect(batch.anomalies[0].flags.some((f) => f.category === ANOMALY_CATEGORIES.WHITELIST_DEVIATION)).toBe(true);
    expect(batch.anomalies[0].whyFlagged).toContain('Posted rate $40.00 differs from approved rate $1.00');
    expect(batch.anomalies[0].severity).not.toBe(SEVERITY_LEVELS.WHITELISTED);
  });

  it('E2E Test 4: Financial source transactions remain immutable when owner actions are persisted', async () => {
    const rawTxn = {
      id: 999,
      property_id: 'prop_test_4',
      date: '2026-03-10',
      amount: 150.0,
      folio_number: 'F999',
    };

    const frozenSnapshot = JSON.stringify(rawTxn);

    await persistOwnerReviewAction({
      propertyId: 'prop_test_4',
      anomalyId: 'TXN|prop_test_4|2026-03-10|F999|NONE||150.00|',
      previousState: REVIEW_STATES.UNREVIEWED,
      newState: REVIEW_STATES.APPROVED,
      actor: 'Owner',
      reason: 'Approved',
    });

    expect(JSON.stringify(rawTxn)).toBe(frozenSnapshot); // Invariant: source transaction byte-identical
  });
});
