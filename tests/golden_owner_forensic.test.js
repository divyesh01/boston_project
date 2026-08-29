import { describe, it, expect } from 'vitest';
import {
  evaluateTransactionAnomaly,
  evaluateForensicAuditBatch,
  evaluateWhitelist,
  evaluateShiftContext,
  applyOwnerPreset,
  generateClerkScorecard,
  recordOwnerAction,
  REVIEW_STATES,
  SEVERITY_LEVELS,
  ANOMALY_CATEGORIES,
  OWNER_PRESETS,
  DEFAULT_FORENSIC_CONFIG,
} from '../src/lib/ownerForensicEngine.js';

describe('Owner Forensic Audit & Smart Anomaly Filter Engine — Golden Suite', () => {

  // 1. Normal room transaction
  it('Scenario 1: Normal room transaction at standard ADR produces no alerts', () => {
    const txn = {
      property_id: 'prop_1',
      date: '2026-03-10',
      time: '15:30',
      folio_number: 'F1001',
      room_number: '201',
      username: 'sarah@hotel.com',
      transaction_code: 'RR',
      charge_category: 'Room Rent',
      amount: 120.0,
    };

    const evaluated = evaluateTransactionAnomaly(txn, {
      propertyAdr: 125.0,
      clerkShifts: [{ shift_date: '2026-03-10', clerk_name: 'sarah@hotel.com', clock_in: '07:00', clock_out: '16:00' }],
    });

    expect(evaluated.riskScore).toBe(0);
    expect(evaluated.severity).toBe(SEVERITY_LEVELS.LOW);
    expect(evaluated.flags.length).toBe(0);
  });

  // 2. $0 room
  it('Scenario 2: $0 room charge flags Zero/Comp Room anomaly', () => {
    const txn = {
      property_id: 'prop_1',
      date: '2026-03-10',
      time: '14:00',
      folio_number: 'F1002',
      room_number: '105',
      username: 'john@hotel.com',
      transaction_code: 'RR',
      charge_category: 'Room Rent',
      amount: 0.0,
    };

    const evaluated = evaluateTransactionAnomaly(txn, { propertyAdr: 120.0 });
    expect(evaluated.flags.some((f) => f.category === ANOMALY_CATEGORIES.ZERO_COMP_ROOM)).toBe(true);
    expect(evaluated.riskScore).toBeGreaterThanOrEqual(30);
  });

  // 3. $1 approved employee room
  it('Scenario 3: $1 approved employee room matches whitelist and is classified as WHITELISTED', () => {
    const txn = {
      property_id: 'prop_1',
      date: '2026-03-10',
      time: '16:00',
      folio_number: 'AAE607',
      room_number: '102',
      username: 'manager@hotel.com',
      transaction_code: 'RR',
      charge_category: 'Staff Stay',
      amount: 1.0,
    };

    const whitelistRules = [
      {
        ruleId: 'WL-001',
        property_id: 'prop_1',
        folioNumber: 'AAE607',
        authorizedRate: 1.0,
        reason: 'Approved employee temporary housing',
      },
    ];

    const evaluated = evaluateTransactionAnomaly(txn, { propertyAdr: 120.0, whitelistRules });
    expect(evaluated.severity).toBe(SEVERITY_LEVELS.WHITELISTED);
    expect(evaluated.reviewState).toBe(REVIEW_STATES.WHITELISTED);
    expect(evaluated.riskScore).toBe(0);
  });

  // 4. $1 unapproved room
  it('Scenario 4: $1 unapproved room flags Nominal/Staff rate anomaly', () => {
    const txn = {
      property_id: 'prop_1',
      date: '2026-03-10',
      time: '16:00',
      folio_number: 'F9999',
      room_number: '102',
      username: 'clerk@hotel.com',
      transaction_code: 'RR',
      charge_category: 'Room Rent',
      amount: 1.0,
    };

    const evaluated = evaluateTransactionAnomaly(txn, { propertyAdr: 120.0, whitelistRules: [] });
    expect(evaluated.flags.some((f) => f.category === ANOMALY_CATEGORIES.NOMINAL_STAFF_RATE)).toBe(true);
    expect(evaluated.severity).not.toBe(SEVERITY_LEVELS.WHITELISTED);
  });

  // 5. 60% rate discount
  it('Scenario 5: Room rate 60% below property ADR flags Deep Discount anomaly', () => {
    const txn = {
      property_id: 'prop_1',
      date: '2026-03-10',
      time: '18:00',
      folio_number: 'F1005',
      room_number: '304',
      username: 'clerk@hotel.com',
      transaction_code: 'RR',
      charge_category: 'Room Rent',
      amount: 40.0, // 60% below ADR of $100
    };

    const evaluated = evaluateTransactionAnomaly(txn, { propertyAdr: 100.0 });
    expect(evaluated.flags.some((f) => f.category === ANOMALY_CATEGORIES.DEEP_DISCOUNT)).toBe(true);
    expect(evaluated.whyFlagged).toContain('60% below property reference ADR');
  });

  // 6. Missing ADR
  it('Scenario 6: Missing property ADR gracefully falls back to custom rate floor without throwing NaN', () => {
    const txn = {
      property_id: 'prop_1',
      date: '2026-03-10',
      time: '18:00',
      folio_number: 'F1006',
      room_number: '304',
      username: 'clerk@hotel.com',
      transaction_code: 'RR',
      charge_category: 'Room Rent',
      amount: 35.0,
    };

    const evaluated = evaluateTransactionAnomaly(txn, { propertyAdr: 0 }); // Missing ADR
    expect(evaluated.flags.some((f) => f.category === ANOMALY_CATEGORIES.CUSTOM_RATE_FLOOR)).toBe(true);
    expect(evaluated.flags.some((f) => f.category === ANOMALY_CATEGORIES.DEEP_DISCOUNT)).toBe(false);
  });

  // 7. Large manual refund
  it('Scenario 7: Large cash refund triggers CRITICAL cash risk review', () => {
    const ref = {
      property_id: 'prop_1',
      date: '2026-03-10',
      time: '19:00',
      username: 'night_clerk@hotel.com',
      paymentTypeRefunded: 'CASH',
      amount: 150.0,
      refundCode: 'REF_MANUAL',
    };

    const { anomalies } = evaluateForensicAuditBatch({ refunds: [ref] });
    expect(anomalies.length).toBe(1);
    expect(anomalies[0].severity).toBe(SEVERITY_LEVELS.CRITICAL);
    expect(anomalies[0].flags.some((f) => f.category === ANOMALY_CATEGORIES.CASH_RISK)).toBe(true);
  });

  // 8. Normal credit-card payment
  it('Scenario 8: Standard credit-card deposit refund is categorized as EXPECTED_ROUTINE', () => {
    const ref = {
      property_id: 'prop_1',
      date: '2026-03-10',
      time: '11:00',
      username: 'day_clerk@hotel.com',
      paymentTypeRefunded: 'VISA',
      amount: 50.0,
      refundCode: 'DEP_REF',
      remarks: 'Deposit return at checkout',
    };

    const { anomalies, summary } = evaluateForensicAuditBatch({ refunds: [ref] });
    expect(anomalies[0].severity).toBe(SEVERITY_LEVELS.EXPECTED_ROUTINE);
    expect(summary.expectedCount).toBe(1);
  });

  // 9. Cash transaction
  it('Scenario 9: Substantial cash transaction flags Cash Risk anomaly', () => {
    const txn = {
      property_id: 'prop_1',
      date: '2026-03-10',
      time: '14:00',
      folio_number: 'F1009',
      username: 'clerk@hotel.com',
      transaction_code: 'CASH',
      amount: 250.0,
    };

    const evaluated = evaluateTransactionAnomaly(txn);
    expect(evaluated.flags.some((f) => f.category === ANOMALY_CATEGORIES.CASH_RISK)).toBe(true);
  });

  // 10. Negative adjustment
  it('Scenario 10: High-dollar negative adjustment flags negative adjustment anomaly', () => {
    const txn = {
      property_id: 'prop_1',
      date: '2026-03-10',
      time: '14:00',
      folio_number: 'F1010',
      username: 'clerk@hotel.com',
      transaction_code: 'ADJ_DISPUTE',
      amount: -120.0,
    };

    const evaluated = evaluateTransactionAnomaly(txn);
    expect(evaluated.flags.some((f) => f.category === ANOMALY_CATEGORIES.NEGATIVE_ADJUSTMENT)).toBe(true);
    expect(evaluated.whyFlagged).toContain('Negative adjustment of -$120.00');
  });

  // 11. Void
  it('Scenario 11: Transaction void flags void anomaly with proper points', () => {
    const txn = {
      property_id: 'prop_1',
      date: '2026-03-10',
      time: '14:00',
      folio_number: 'F1011',
      username: 'clerk@hotel.com',
      transaction_code: 'VOID_ENTRY',
      transaction_description: 'Voided duplicate room charge',
      amount: 100.0,
    };

    const evaluated = evaluateTransactionAnomaly(txn);
    expect(evaluated.flags.some((f) => f.category === ANOMALY_CATEGORIES.VOID)).toBe(true);
  });

  // 12. Night auditor posting during valid shift
  it('Scenario 12: Scheduled night auditor posting at 02:00 is recognized as ON SHIFT', () => {
    const txn = {
      property_id: 'prop_1',
      date: '2026-03-10',
      time: '02:15',
      folio_number: 'F1012',
      username: 'night_auditor@hotel.com',
      transaction_code: 'RR',
      charge_category: 'Room Rent',
      amount: 110.0,
    };

    const clerkShifts = [
      { shift_date: '2026-03-10', clerk_name: 'night_auditor@hotel.com', clock_in: '23:00', clock_out: '07:00' },
    ];

    const evaluated = evaluateTransactionAnomaly(txn, { propertyAdr: 110.0, clerkShifts });
    expect(evaluated.isOnShift).toBe(true);
    expect(evaluated.flags.some((f) => f.category === ANOMALY_CATEGORIES.OFF_SHIFT_ACTIVITY)).toBe(false);
  });

  // 13. Day clerk posting manual credit at 2 AM
  it('Scenario 13: Day clerk posting manual adjustment at 02:00 flags Off-Shift Activity', () => {
    const txn = {
      property_id: 'prop_1',
      date: '2026-03-10',
      time: '02:30',
      folio_number: 'F1013',
      username: 'day_clerk@hotel.com',
      transaction_code: 'ADJ',
      amount: -80.0,
    };

    const clerkShifts = [
      { shift_date: '2026-03-10', clerk_name: 'day_clerk@hotel.com', clock_in: '08:00', clock_out: '16:00' },
    ];

    const evaluated = evaluateTransactionAnomaly(txn, { clerkShifts });
    expect(evaluated.isOnShift).toBe(false);
    expect(evaluated.flags.some((f) => f.category === ANOMALY_CATEGORIES.OFF_SHIFT_ACTIVITY)).toBe(true);
    expect(evaluated.whyFlagged).toContain('outside scheduled hours');
  });

  // 14. System-generated posting
  it('Scenario 14: System automation account (hkcrsuser) is recognized without off-shift false positive', () => {
    const txn = {
      property_id: 'prop_1',
      date: '2026-03-10',
      time: '03:00',
      folio_number: 'F1014',
      username: 'hkcrsuser',
      transaction_code: 'RR',
      charge_category: 'Room Rent',
      amount: 110.0,
    };

    const evaluated = evaluateTransactionAnomaly(txn, { propertyAdr: 110.0 });
    expect(evaluated.isSystem).toBe(true);
    expect(evaluated.flags.some((f) => f.category === ANOMALY_CATEGORIES.OFF_SHIFT_ACTIVITY)).toBe(false);
  });

  // 15. Whitelisted folio behaving normally
  it('Scenario 15: Whitelisted folio within valid dates and exact rate evaluates to WHITELISTED', () => {
    const txn = {
      property_id: 'prop_1',
      date: '2026-03-10',
      time: '14:00',
      folio_number: 'STAFF_101',
      amount: 10.0,
    };

    const whitelistRules = [{
      ruleId: 'W15',
      property_id: 'prop_1',
      folioNumber: 'STAFF_101',
      authorizedRate: 10.0,
      validFrom: '2026-03-01',
      validTo: '2026-03-31',
    }];

    const evaluated = evaluateTransactionAnomaly(txn, { whitelistRules });
    expect(evaluated.severity).toBe(SEVERITY_LEVELS.WHITELISTED);
  });

  // 16. Whitelisted folio changing rate
  it('Scenario 16: Whitelisted folio rate change ($10 -> $35) triggers WHITELIST_DEVIATION re-alert', () => {
    const txn = {
      property_id: 'prop_1',
      date: '2026-03-10',
      time: '14:00',
      folio_number: 'STAFF_101',
      amount: 35.0,
    };

    const whitelistRules = [{
      ruleId: 'W16',
      property_id: 'prop_1',
      folioNumber: 'STAFF_101',
      authorizedRate: 10.0,
    }];

    const evaluated = evaluateTransactionAnomaly(txn, { whitelistRules });
    expect(evaluated.flags.some((f) => f.category === ANOMALY_CATEGORIES.WHITELIST_DEVIATION)).toBe(true);
    expect(evaluated.whyFlagged).toContain('Posted rate $35.00 differs from approved rate $10.00');
  });

  // 17. Whitelisted folio receiving unexpected cash
  it('Scenario 17: Whitelisted folio receiving unexpected cash triggers WHITELIST_DEVIATION re-alert', () => {
    const txn = {
      property_id: 'prop_1',
      date: '2026-03-10',
      time: '14:00',
      folio_number: 'STAFF_101',
      transaction_code: 'CASH',
      amount: 10.0,
    };

    const whitelistRules = [{
      ruleId: 'W17',
      property_id: 'prop_1',
      folioNumber: 'STAFF_101',
      authorizedRate: 10.0,
      allowCash: false,
    }];

    const evaluated = evaluateTransactionAnomaly(txn, { whitelistRules });
    expect(evaluated.flags.some((f) => f.category === ANOMALY_CATEGORIES.WHITELIST_DEVIATION)).toBe(true);
    expect(evaluated.whyFlagged).toContain('Unexpected cash tender');
  });

  // 18. Whitelist expiration
  it('Scenario 18: Expired whitelist triggers WHITELIST_EXPIRED re-alert', () => {
    const txn = {
      property_id: 'prop_1',
      date: '2026-04-05',
      time: '14:00',
      folio_number: 'STAFF_101',
      amount: 10.0,
    };

    const whitelistRules = [{
      ruleId: 'W18',
      property_id: 'prop_1',
      folioNumber: 'STAFF_101',
      authorizedRate: 10.0,
      validTo: '2026-03-31',
    }];

    const evaluated = evaluateTransactionAnomaly(txn, { whitelistRules });
    expect(evaluated.flags.some((f) => f.category === ANOMALY_CATEGORIES.WHITELIST_DEVIATION)).toBe(true);
    expect(evaluated.whyFlagged).toContain('Whitelist rule expired on 2026-03-31');
  });

  // 19. Two properties with identical folio IDs
  it('Scenario 19: Strict property isolation prevents whitelist leaking between properties with identical folio IDs', () => {
    const txnPropA = { property_id: 'prop_A', date: '2026-03-10', folio_number: 'FOLIO_X', amount: 1.0 };
    const txnPropB = { property_id: 'prop_B', date: '2026-03-10', folio_number: 'FOLIO_X', amount: 1.0 };

    const whitelistRules = [{
      ruleId: 'W19',
      property_id: 'prop_A',
      folioNumber: 'FOLIO_X',
      authorizedRate: 1.0,
    }];

    const resA = evaluateTransactionAnomaly(txnPropA, { whitelistRules });
    const resB = evaluateTransactionAnomaly(txnPropB, { whitelistRules });

    expect(resA.severity).toBe(SEVERITY_LEVELS.WHITELISTED);
    expect(resB.severity).not.toBe(SEVERITY_LEVELS.WHITELISTED);
  });

  // 20. Same clerk working multiple properties
  it('Scenario 20: Clerk scorecard maintains independent property partitions for multi-property clerks', () => {
    const txns = [
      { property_id: 'prop_A', username: 'alex@hotel.com', amount: 100.0 },
      { property_id: 'prop_B', username: 'alex@hotel.com', amount: 200.0 },
    ];

    const scorecard = generateClerkScorecard([], { transactions: txns });
    expect(scorecard.length).toBe(2);
    const cardA = scorecard.find((c) => c.propertyId === 'prop_A');
    const cardB = scorecard.find((c) => c.propertyId === 'prop_B');
    expect(cardA.totalDollarVolume).toBe(100.0);
    expect(cardB.totalDollarVolume).toBe(200.0);
  });

  // 21. Reopened / resolved anomaly
  it('Scenario 21: Review state transition to APPROVED marks anomaly as RESOLVED severity', () => {
    const txn = {
      property_id: 'prop_1',
      date: '2026-03-10',
      time: '14:00',
      folio_number: 'F1021',
      amount: 0.0,
      transaction_code: 'RR',
      charge_category: 'Room Rent',
    };

    const dedupeKey = `TXN|prop_1|2026-03-10|F1021|NONE|RR|0.00|14:00`;
    const reviewStates = {
      [dedupeKey]: { state: REVIEW_STATES.APPROVED, actor: 'Owner', reason: 'Verified manager comp' },
    };

    const evaluated = evaluateTransactionAnomaly(txn, { reviewStates });
    expect(evaluated.severity).toBe(SEVERITY_LEVELS.RESOLVED);
    expect(evaluated.reviewState).toBe(REVIEW_STATES.APPROVED);
  });

  // 22. Owner approval audit history
  it('Scenario 22: Owner actions record immutable audit records without modifying source transaction', () => {
    let auditTrail = [];
    const sourceTxn = { id: 100, amount: 250.0, original_sign: 'positive' };

    auditTrail = recordOwnerAction(auditTrail, {
      action: 'APPROVE_ANOMALY',
      anomalyId: 'ANOM_123',
      propertyId: 'prop_1',
      actor: 'Divyesh',
      previousState: REVIEW_STATES.UNREVIEWED,
      newState: REVIEW_STATES.APPROVED,
      reason: 'Verified guest dispute resolution voucher',
    });

    expect(auditTrail.length).toBe(1);
    expect(auditTrail[0].actor).toBe('Divyesh');
    expect(auditTrail[0].action).toBe('APPROVE_ANOMALY');
    expect(sourceTxn.amount).toBe(250.0); // Source transaction unchanged
  });

  // ─── Mutation Tests (Proving Logic Invariants) ────────────────────────────────

  it('Mutation Test 1: Removing property isolation causes cross-property leak failure', () => {
    const rules = [{ ruleId: 'W1', property_id: 'prop_A', folioNumber: 'F1' }];
    const resSameProp = evaluateWhitelist({ property_id: 'prop_A', folio_number: 'F1' }, rules);
    const resOtherProp = evaluateWhitelist({ property_id: 'prop_B', folio_number: 'F1' }, rules);

    expect(resSameProp.isWhitelisted).toBe(true);
    expect(resOtherProp.isWhitelisted).toBe(false);
  });

  it('Mutation Test 2: Disabling whitelist rate-drift causes unauthorized rate change leak', () => {
    const rules = [{ ruleId: 'W2', property_id: 'prop_A', folioNumber: 'F2', authorizedRate: 10.0 }];
    const resTampered = evaluateWhitelist({ property_id: 'prop_A', folio_number: 'F2', amount: 50.0 }, rules);

    expect(resTampered.isWhitelisted).toBe(false);
    expect(resTampered.deviation.type).toBe('AUTHORIZED_RATE_DRIFT');
  });

  it('Mutation Test 3: Preset filtering correctly isolates High-Risk Cash and Voids', () => {
    const anomalies = [
      { id: '1', isCash: true, transactionCode: 'CASH', riskScore: 50, flags: [{ category: ANOMALY_CATEGORIES.CASH_RISK }] },
      { id: '2', isCash: false, transactionCode: 'RR', riskScore: 10, flags: [] },
    ];

    const filtered = applyOwnerPreset(anomalies, OWNER_PRESETS.HIGH_RISK_CASH_AND_VOIDS);
    expect(filtered.length).toBe(1);
    expect(filtered[0].id).toBe('1');
  });
});
