/**
 * Master Owner Forensic Audit & Smart Anomaly Filter Engine
 * --------------------------------------------------------
 * High-precision, zero-noise forensic audit engine for hotel owners.
 *
 * Core Guarantees:
 * 1. Financial Truth Invariant: Source transactions are NEVER mutated.
 * 2. Strict Property Isolation: All queries, ADR baselines, and whitelists partition by property_id.
 * 3. Declarative Whitelist with State-Change Re-Alerting: Known approved stays are classified as
 *    EXPECTED / WHITELISTED, but any deviation (rate drift, unexpected cash, refund) RE-ALERTS immediately.
 * 4. Shift-Aware & System Account Recognition: Normalizes night auditor routines vs day clerk off-shift activity.
 * 5. Explainable Risk Ranking: Multi-factor severity scoring with clear "WHY THIS WAS FLAGGED" reasons.
 * 6. Immutable Audit Trail: Owner actions (approve, flag, whitelist, resolve) record complete provenance.
 * 7. Unified Master Filter Engine & Quick Presets: One reusable filter pipeline across all forensic views.
 */

import { money2 } from './hotel.js';
import { classifyRefund, REFUND_CLASSIFICATION } from './refundClassification.js';

export function round2(n) {
  const num = Number(n);
  return Number.isFinite(num) ? Math.round(num * 100) / 100 : 0;
}

// ─── Enums & Constants ────────────────────────────────────────────────────────

export const REVIEW_STATES = {
  UNREVIEWED: 'UNREVIEWED',
  APPROVED: 'APPROVED',
  NEEDS_INVESTIGATION: 'NEEDS_INVESTIGATION',
  ESCALATED: 'ESCALATED',
  WHITELISTED: 'WHITELISTED',
  RESOLVED: 'RESOLVED',
};

export const SEVERITY_LEVELS = {
  CRITICAL: 'CRITICAL',
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW',
  EXPECTED_ROUTINE: 'EXPECTED_ROUTINE',
  WHITELISTED: 'WHITELISTED',
  RESOLVED: 'RESOLVED',
};

export const ANOMALY_CATEGORIES = {
  RATE_OVERRIDE: 'rate_override',
  ZERO_COMP_ROOM: 'zero_comp_room',
  NOMINAL_STAFF_RATE: 'nominal_staff_rate',
  DEEP_DISCOUNT: 'deep_discount',
  CUSTOM_RATE_FLOOR: 'custom_rate_floor',
  NEGATIVE_ADJUSTMENT: 'negative_adjustment',
  REFUND: 'refund',
  VOID: 'void',
  CASH_RISK: 'cash_risk',
  OFF_SHIFT_ACTIVITY: 'off_shift_activity',
  UNUSUAL_MANUAL_POSTING: 'unusual_manual_posting',
  REPEATED_ADJUSTMENT: 'repeated_adjustment',
  SUSPICIOUS_FOLIO_PATTERN: 'suspicious_folio_pattern',
  WHITELIST_DEVIATION: 'whitelist_deviation',
};

export const DEFAULT_FORENSIC_CONFIG = {
  rateFloor: 50.0,
  nominalRateMin: 0.01,
  nominalRateMax: 10.0,
  deepDiscountRatio: 0.5, // >50% below property reference ADR
  singleAdjustmentThreshold: 50.0,
  dailyFolioAdjustmentThreshold: 100.0,
  cashRiskThreshold: 50.0,
  microSkimMaxAmount: 20.0,
  microSkimCount: 3,
  graveyardStartHour: 1, // 01:00 AM
  graveyardEndHour: 5,   // 05:00 AM
  nightAuditStartHour: 23, // 23:00
  nightAuditEndHour: 6,    // 06:00
  systemAccountPatterns: ['hkcrsuser', 'hkiotuser', 'system', 'pms_auto', 'interface', 'sync'],
};

export const OWNER_PRESETS = {
  HIGH_RISK_CASH_AND_VOIDS: 'HIGH_RISK_CASH_AND_VOIDS',
  DEEP_DISCOUNTS_AND_FREE_STAYS: 'DEEP_DISCOUNTS_AND_FREE_STAYS',
  OFF_SHIFT_MANUAL_ACTIVITY: 'OFF_SHIFT_MANUAL_ACTIVITY',
  HOUSE_STAFF_AUDIT: 'HOUSE_STAFF_AUDIT',
  MORNING_OWNER_REVIEW: 'MORNING_OWNER_REVIEW',
};

// ─── Utility Helpers ──────────────────────────────────────────────────────────

function parseNum(val) {
  const n = Number(val);
  return Number.isFinite(n) ? n : 0;
}

function parseHour(timeStr) {
  if (timeStr == null) return null;
  const s = String(timeStr).trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const ap = (m[4] || '').toUpperCase();
  if (ap === 'PM' && h < 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  return h >= 0 && h <= 23 ? h : null;
}

export function isSystemAccount(username, config = DEFAULT_FORENSIC_CONFIG) {
  const u = String(username || '').trim().toLowerCase();
  if (!u) return false;
  if (!u.includes('@')) {
    // Non-email usernames without explicit names are often system accounts
    for (const pat of config.systemAccountPatterns) {
      if (u.includes(pat)) return true;
    }
  }
  for (const pat of config.systemAccountPatterns) {
    if (u === pat) return true;
  }
  return false;
}

export function isRoomCharge(row) {
  const code = String(row?.transaction_code || '').toUpperCase();
  const cat = String(row?.charge_category || '').toUpperCase();
  const desc = String(row?.transaction_description || '').toUpperCase();
  return code === 'RR' || cat.includes('ROOM RENT') || desc.includes('ROOM RENT') || desc.includes('ROOM CHARGE');
}

export function isCashTender(row) {
  const code = String(row?.transaction_code || '').toUpperCase();
  const pm = String(row?.payment_method || row?.paymentTypeRefunded || '').toUpperCase();
  const desc = String(row?.transaction_description || '').toUpperCase();
  return code === 'CASH' || pm.includes('CASH') || desc.includes('CASH');
}

export function isVoidOrReversal(row) {
  const desc = String(row?.transaction_description || row?.remarks || '').toUpperCase();
  const type = String(row?.transaction_type || '').toUpperCase();
  return desc.includes('VOID') || desc.includes('REVERSAL') || type === 'VOID';
}

// ─── Shift Matcher ────────────────────────────────────────────────────────────

export function evaluateShiftContext(item, clerkShifts = [], config = DEFAULT_FORENSIC_CONFIG) {
  const hour = parseHour(item.time);
  const itemDate = String(item.date || '').slice(0, 10);
  const username = String(item.username || '').trim().toLowerCase();
  const isSystem = isSystemAccount(username, config);

  if (isSystem) {
    return {
      isSystem: true,
      isOnShift: true,
      shiftType: 'SYSTEM_AUTOMATION',
      isGraveyardHour: false,
    };
  }

  const isGraveyardHour = hour !== null && hour >= config.graveyardStartHour && hour < config.graveyardEndHour;

  // If reliable shift records exist, find matching shift for this clerk on this date
  const matchingShift = clerkShifts.find((s) => {
    const sDate = String(s.shift_date || s.date || '').slice(0, 10);
    const sUser = String(s.clerk_name || s.username || s.employee_name || '').trim().toLowerCase();
    const propMatch = !s.property_id || !item.property_id || String(s.property_id) === String(item.property_id);
    return propMatch && sDate === itemDate && (sUser === username || username.includes(sUser) || sUser.includes(username));
  });

  if (!matchingShift) {
    // If no shift record exists, classify off-hours vs day hours
    const isOffHours = hour !== null && (hour >= config.nightAuditStartHour || hour < config.nightAuditEndHour);
    return {
      isSystem: false,
      hasShiftRecord: false,
      isOnShift: !isOffHours,
      isGraveyardHour,
      shiftType: isOffHours ? 'UNSCHEDULED_NIGHT' : 'UNSCHEDULED_DAY',
    };
  }

  // If shift record is present, inspect start/end if available
  const startHour = parseHour(matchingShift.clock_in || matchingShift.start_time);
  const endHour = parseHour(matchingShift.clock_out || matchingShift.end_time);

  let onShift = true;
  if (hour !== null && startHour !== null && endHour !== null) {
    if (startHour <= endHour) {
      onShift = hour >= startHour && hour <= endHour;
    } else {
      // Overnight shift
      onShift = hour >= startHour || hour <= endHour;
    }
  }

  return {
    isSystem: false,
    hasShiftRecord: true,
    isOnShift: onShift,
    isGraveyardHour,
    shiftType: matchingShift.department || 'SCHEDULED_SHIFT',
  };
}

// ─── Declarative Whitelist Engine & Deviation Detection ───────────────────────

export function evaluateWhitelist(item, whitelistRules = []) {
  if (!Array.isArray(whitelistRules) || whitelistRules.length === 0) {
    return { isWhitelisted: false, deviation: null, matchedRule: null };
  }

  const itemProp = String(item.property_id || '');
  const itemFolio = String(item.folio_number || item.folioNumber || '').trim().toUpperCase();
  const itemRoom = String(item.room_number || item.roomNumber || '').trim();
  const itemUser = String(item.username || '').trim().toLowerCase();
  const itemDate = String(item.date || '').slice(0, 10);
  const itemAmount = Math.abs(parseNum(item.amount ?? item.adjustedAmount));
  const isCash = isCashTender(item);

  // Find candidate rules matching property and folio or room
  for (const rule of whitelistRules) {
    if (rule.property_id && String(rule.property_id) !== itemProp) continue;

    const ruleFolio = String(rule.folioNumber || rule.folio_number || '').trim().toUpperCase();
    const ruleRoom = String(rule.roomNumber || rule.room_number || '').trim();

    const folioMatch = ruleFolio && ruleFolio === itemFolio;
    const roomMatch = ruleRoom && ruleRoom === itemRoom;

    if (!folioMatch && !roomMatch) continue;

    // Check expiration / date window
    if (rule.validFrom && itemDate && itemDate < String(rule.validFrom).slice(0, 10)) continue;
    if (rule.validTo && itemDate && itemDate > String(rule.validTo).slice(0, 10)) {
      return {
        isWhitelisted: false,
        deviation: {
          type: 'WHITELIST_EXPIRED',
          reason: `Whitelist rule expired on ${rule.validTo} (transaction date: ${itemDate})`,
          rule,
        },
        matchedRule: rule,
      };
    }

    // Check rate / amount drift
    if (rule.authorizedRate !== undefined && rule.authorizedRate !== null) {
      const authRate = parseNum(rule.authorizedRate);
      if (Math.abs(itemAmount - authRate) > 0.01) {
        return {
          isWhitelisted: false,
          deviation: {
            type: 'AUTHORIZED_RATE_DRIFT',
            reason: `Posted rate $${itemAmount.toFixed(2)} differs from approved rate $${authRate.toFixed(2)}`,
            rule,
          },
          matchedRule: rule,
        };
      }
    }

    // Check unexpected cash tender
    if (isCash && rule.allowCash !== true) {
      return {
        isWhitelisted: false,
        deviation: {
          type: 'UNEXPECTED_CASH_TENDER',
          reason: `Unexpected cash tender $${itemAmount.toFixed(2)} on whitelisted account without cash authorization`,
          rule,
        },
        matchedRule: rule,
      };
    }

    // Check unauthorized clerk
    if (rule.approvedClerk && String(rule.approvedClerk).trim().toLowerCase() !== itemUser) {
      return {
        isWhitelisted: false,
        deviation: {
          type: 'UNAUTHORIZED_CLERK',
          reason: `Transaction posted by ${item.username}, but whitelist is restricted to ${rule.approvedClerk}`,
          rule,
        },
        matchedRule: rule,
      };
    }

    // Perfect whitelist match
    return {
      isWhitelisted: true,
      deviation: null,
      matchedRule: rule,
    };
  }

  return { isWhitelisted: false, deviation: null, matchedRule: null };
}

// ─── Anomaly Evaluator for Transactions ───────────────────────────────────────

export function evaluateTransactionAnomaly(row, options = {}) {
  const config = { ...DEFAULT_FORENSIC_CONFIG, ...(options.config || {}) };
  const propertyAdr = options.propertyAdr > 0 ? options.propertyAdr : null;
  const clerkShifts = options.clerkShifts || [];
  const whitelistRules = options.whitelistRules || [];
  const reviewStates = options.reviewStates || {};

  const amt = parseNum(row.amount);
  const absAmt = Math.abs(amt);
  const isRoom = isRoomCharge(row);
  const isCash = isCashTender(row);
  const isVoid = isVoidOrReversal(row);
  const username = String(row.username || 'unknown');
  const date = String(row.date || '').slice(0, 10);
  const folio = String(row.folio_number || 'NONE');
  const room = String(row.room_number || 'NONE');
  const dedupeKey = `TXN|${row.property_id || 'p0'}|${date}|${folio}|${room}|${row.transaction_code || ''}|${absAmt.toFixed(2)}|${row.time || ''}`;

  const shiftInfo = evaluateShiftContext(row, clerkShifts, config);
  const whitelistInfo = evaluateWhitelist(row, whitelistRules);

  const flags = [];
  let riskScore = 0;

  // 1. Whitelist Deviation Re-Alert
  if (whitelistInfo.deviation) {
    riskScore += 40;
    flags.push({
      category: ANOMALY_CATEGORIES.WHITELIST_DEVIATION,
      label: 'Whitelist Deviation Re-Alert',
      detail: whitelistInfo.deviation.reason,
      points: 40,
    });
  }

  // 2. Rate Anomalies (Room Charges only)
  if (isRoom && amt >= 0) {
    if (amt === 0) {
      riskScore += 30;
      flags.push({
        category: ANOMALY_CATEGORIES.ZERO_COMP_ROOM,
        label: 'Zero Dollar / Comp Room',
        detail: `Room charge is $0.00 (Comp Stay). Requires manager verification.`,
        points: 30,
      });
    } else if (amt >= config.nominalRateMin && amt <= config.nominalRateMax) {
      riskScore += 25;
      flags.push({
        category: ANOMALY_CATEGORIES.NOMINAL_STAFF_RATE,
        label: 'Nominal / Staff Rate ($0.01 - $10)',
        detail: `Room rate $${amt.toFixed(2)} is in nominal staff/house rate range.`,
        points: 25,
      });
    } else if (propertyAdr && propertyAdr > 0 && amt < propertyAdr * config.deepDiscountRatio) {
      const discountPct = Math.round((1 - amt / propertyAdr) * 100);
      riskScore += 25;
      flags.push({
        category: ANOMALY_CATEGORIES.DEEP_DISCOUNT,
        label: `Deep Discount (${discountPct}% below ADR)`,
        detail: `Room rate $${amt.toFixed(2)} is ${discountPct}% below property reference ADR ($${propertyAdr.toFixed(2)}).`,
        points: 25,
      });
    } else if (amt < config.rateFloor) {
      riskScore += 15;
      flags.push({
        category: ANOMALY_CATEGORIES.CUSTOM_RATE_FLOOR,
        label: `Rate Below Configured Floor ($${config.rateFloor})`,
        detail: `Room rate $${amt.toFixed(2)} is below minimum floor $${config.rateFloor.toFixed(2)}.`,
        points: 15,
      });
    }
  }

  // 3. Negative Adjustments / Credits
  if (amt < 0) {
    const isBig = absAmt >= config.singleAdjustmentThreshold;
    riskScore += isBig ? 30 : 15;
    flags.push({
      category: ANOMALY_CATEGORIES.NEGATIVE_ADJUSTMENT,
      label: isBig ? 'High-Dollar Negative Adjustment' : 'Negative Adjustment',
      detail: `Negative adjustment of -$${absAmt.toFixed(2)} posted by ${username}.`,
      points: isBig ? 30 : 15,
    });
  }

  // 4. Cash Tender Risk
  if (isCash && absAmt >= config.cashRiskThreshold) {
    riskScore += 20;
    flags.push({
      category: ANOMALY_CATEGORIES.CASH_RISK,
      label: 'Substantial Cash Tender',
      detail: `Cash transaction of $${absAmt.toFixed(2)} handled by ${username}.`,
      points: 20,
    });
  }

  // 5. Void / Reversal
  if (isVoid) {
    riskScore += 25;
    flags.push({
      category: ANOMALY_CATEGORIES.VOID,
      label: 'Transaction Void / Reversal',
      detail: `Void or reversal record of $${absAmt.toFixed(2)} recorded on folio ${folio}.`,
      points: 25,
    });
  }

  // 6. Shift Mismatch / Off-Shift Activity
  if (!shiftInfo.isSystem && !shiftInfo.isOnShift && (isRoom || isCash || amt < 0 || isVoid)) {
    riskScore += 30;
    flags.push({
      category: ANOMALY_CATEGORIES.OFF_SHIFT_ACTIVITY,
      label: 'Manual Activity Outside Scheduled Shift',
      detail: `Manual posting at ${row.time || 'unknown time'} by ${username} outside scheduled hours. Requires Review.`,
      points: 30,
    });
  }

  // If Whitelisted without deviations, categorize cleanly
  if (whitelistInfo.isWhitelisted && !whitelistInfo.deviation) {
    return {
      id: dedupeKey,
      propertyId: row.property_id || '',
      date,
      time: row.time || '',
      folioNumber: folio,
      roomNumber: room,
      username,
      accountCategory: String(row.charge_category || 'Guest'),
      transactionCode: String(row.transaction_code || ''),
      amount: round2(amt),
      isCash,
      isSystem: shiftInfo.isSystem,
      isOnShift: shiftInfo.isOnShift,
      riskScore: 0,
      severity: SEVERITY_LEVELS.WHITELISTED,
      reviewState: REVIEW_STATES.WHITELISTED,
      whyFlagged: `Approved stay matching whitelist rule ${whitelistInfo.matchedRule.ruleId || ''} (${whitelistInfo.matchedRule.reason || 'Owner Authorized'}).`,
      flags: [],
      matchedRule: whitelistInfo.matchedRule,
      rawItem: row,
    };
  }

  // Determine Severity from Score
  let severity = SEVERITY_LEVELS.LOW;
  if (riskScore >= 70) severity = SEVERITY_LEVELS.CRITICAL;
  else if (riskScore >= 50) severity = SEVERITY_LEVELS.HIGH;
  else if (riskScore >= 25) severity = SEVERITY_LEVELS.MEDIUM;
  else if (riskScore > 0) severity = SEVERITY_LEVELS.LOW;
  else severity = shiftInfo.isSystem ? SEVERITY_LEVELS.EXPECTED_ROUTINE : SEVERITY_LEVELS.LOW;

  const currentReview = reviewStates[dedupeKey] || { state: REVIEW_STATES.UNREVIEWED };
  if (currentReview.state === REVIEW_STATES.RESOLVED || currentReview.state === REVIEW_STATES.APPROVED) {
    severity = SEVERITY_LEVELS.RESOLVED;
  }

  const whyFlagged = flags.length > 0
    ? flags.map((f) => f.detail).join(' | ')
    : (shiftInfo.isSystem ? 'Routine system posting.' : 'Standard transaction.');

  return {
    id: dedupeKey,
    propertyId: row.property_id || '',
    date,
    time: row.time || '',
    folioNumber: folio,
    roomNumber: room,
    username,
    accountCategory: String(row.charge_category || 'Guest'),
    transactionCode: String(row.transaction_code || ''),
    amount: round2(amt),
    isCash,
    isSystem: shiftInfo.isSystem,
    isOnShift: shiftInfo.isOnShift,
    riskScore,
    severity,
    reviewState: currentReview.state,
    reviewDetails: currentReview,
    whyFlagged,
    flags,
    rawItem: row,
  };
}

// ─── Master Batch Evaluator ───────────────────────────────────────────────────

export function evaluateForensicAuditBatch({
  transactions = [],
  adjustments = [],
  refunds = [],
  clerkShifts = [],
  whitelistRules = [],
  reviewStates = {},
  propertyAdrMap = {},
  config = DEFAULT_FORENSIC_CONFIG,
}) {
  const anomalies = [];

  // Evaluate Transactions
  for (const txn of transactions) {
    if (!txn || !txn.date) continue;
    const propId = txn.property_id || 'default';
    const propAdr = propertyAdrMap[propId] || 0;
    const evaluated = evaluateTransactionAnomaly(txn, {
      propertyAdr: propAdr,
      clerkShifts,
      whitelistRules,
      reviewStates,
      config,
    });
    if (evaluated.riskScore > 0 || evaluated.severity === SEVERITY_LEVELS.WHITELISTED) {
      anomalies.push(evaluated);
    }
  }

  // Evaluate Adjustments & Refunds from Clerk Audit records
  for (const adj of adjustments) {
    if (!adj || !adj.date) continue;
    const amt = parseNum(adj.adjustedAmount ?? adj.amount);
    const absAmt = Math.abs(amt);
    const username = String(adj.username || 'unknown');
    const date = String(adj.date || '').slice(0, 10);
    const room = String(adj.roomNumber || adj.room_number || 'NONE');
    const dedupeKey = `ADJ|${adj.property_id || 'p0'}|${date}|${username}|${room}|${absAmt.toFixed(2)}|${adj.time || ''}`;

    const shiftInfo = evaluateShiftContext(adj, clerkShifts, config);
    let riskScore = 20;
    const flags = [];

    if (absAmt >= config.singleAdjustmentThreshold) {
      riskScore += 25;
      flags.push({ category: ANOMALY_CATEGORIES.NEGATIVE_ADJUSTMENT, label: 'High Adjustment', detail: `Adjustment of $${absAmt.toFixed(2)} by ${username}.` });
    }
    if (!shiftInfo.isSystem && !shiftInfo.isOnShift) {
      riskScore += 30;
      flags.push({ category: ANOMALY_CATEGORIES.OFF_SHIFT_ACTIVITY, label: 'Off-Shift Adjustment', detail: `Adjustment posted by ${username} outside shift hours.` });
    }

    let severity = SEVERITY_LEVELS.MEDIUM;
    if (riskScore >= 70) severity = SEVERITY_LEVELS.CRITICAL;
    else if (riskScore >= 50) severity = SEVERITY_LEVELS.HIGH;

    const currentReview = reviewStates[dedupeKey] || { state: REVIEW_STATES.UNREVIEWED };
    if (currentReview.state === REVIEW_STATES.RESOLVED || currentReview.state === REVIEW_STATES.APPROVED) {
      severity = SEVERITY_LEVELS.RESOLVED;
    }

    anomalies.push({
      id: dedupeKey,
      propertyId: adj.property_id || '',
      date,
      time: adj.time || '',
      folioNumber: String(adj.folioNumber || 'NONE'),
      roomNumber: room,
      username,
      accountCategory: 'Adjustment',
      transactionCode: String(adj.reasonCode || 'ADJUSTMENT'),
      amount: -round2(absAmt),
      isCash: false,
      isSystem: shiftInfo.isSystem,
      isOnShift: shiftInfo.isOnShift,
      riskScore,
      severity,
      reviewState: currentReview.state,
      reviewDetails: currentReview,
      whyFlagged: flags.map((f) => f.detail).join(' | '),
      flags,
      rawItem: adj,
    });
  }

  for (const ref of refunds) {
    if (!ref || !ref.date) continue;
    const amt = parseNum(ref.amount);
    const absAmt = Math.abs(amt);
    const username = String(ref.username || 'unknown');
    const date = String(ref.date || '').slice(0, 10);
    const room = String(ref.roomNumber || ref.room_number || 'NONE');
    const isCash = isCashTender(ref);
    const dedupeKey = `REF|${ref.property_id || 'p0'}|${date}|${username}|${room}|${absAmt.toFixed(2)}|${ref.time || ''}`;

    const classification = classifyRefund(ref);
    const shiftInfo = evaluateShiftContext(ref, clerkShifts, config);
    let riskScore = 15;
    const flags = [];

    if (isCash && classification.kind !== REFUND_CLASSIFICATION.DEPOSIT_RETURN) {
      const isLarge = absAmt >= 100;
      const pts = isLarge ? 55 : 40;
      riskScore += pts;
      flags.push({
        category: ANOMALY_CATEGORIES.CASH_RISK,
        label: isLarge ? 'Large Cash Refund Review' : 'Cash Refund Review',
        detail: `Cash refund of $${absAmt.toFixed(2)} requiring owner verification.`,
        points: pts,
      });
    }
    if (shiftInfo.isGraveyardHour && isCash) {
      riskScore += 35;
      flags.push({ category: ANOMALY_CATEGORIES.OFF_SHIFT_ACTIVITY, label: 'Graveyard Cash Refund', detail: `Cash refund executed during graveyard window (${config.graveyardStartHour}:00 - ${config.graveyardEndHour}:00).` });
    }

    let severity = SEVERITY_LEVELS.LOW;
    if (classification.kind === REFUND_CLASSIFICATION.DEPOSIT_RETURN) {
      severity = SEVERITY_LEVELS.EXPECTED_ROUTINE;
      riskScore = 5;
    } else if (riskScore >= 70) {
      severity = SEVERITY_LEVELS.CRITICAL;
    } else if (riskScore >= 50) {
      severity = SEVERITY_LEVELS.HIGH;
    } else if (riskScore >= 25) {
      severity = SEVERITY_LEVELS.MEDIUM;
    }

    const currentReview = reviewStates[dedupeKey] || { state: REVIEW_STATES.UNREVIEWED };
    if (currentReview.state === REVIEW_STATES.RESOLVED || currentReview.state === REVIEW_STATES.APPROVED) {
      severity = SEVERITY_LEVELS.RESOLVED;
    }

    anomalies.push({
      id: dedupeKey,
      propertyId: ref.property_id || '',
      date,
      time: ref.time || '',
      folioNumber: String(ref.folioNumber || 'NONE'),
      roomNumber: room,
      username,
      accountCategory: 'Refund',
      transactionCode: String(ref.refundCode || 'REFUND'),
      amount: -round2(absAmt),
      isCash,
      isSystem: shiftInfo.isSystem,
      isOnShift: shiftInfo.isOnShift,
      riskScore,
      severity,
      reviewState: currentReview.state,
      reviewDetails: currentReview,
      whyFlagged: flags.length > 0 ? flags.map((f) => f.detail).join(' | ') : `Standard ${classification.label}.`,
      flags,
      rawItem: ref,
    });
  }

  // Deduplicate and Rank by explainable risk score (Highest risk first)
  const dedupedMap = new Map();
  for (const a of anomalies) {
    if (!dedupedMap.has(a.id) || dedupedMap.get(a.id).riskScore < a.riskScore) {
      dedupedMap.set(a.id, a);
    }
  }

  const sortedAnomalies = [...dedupedMap.values()].sort((a, b) => {
    // Unreviewed critical/high first, then by risk score descending, then newest date
    const unreviewedA = a.reviewState === REVIEW_STATES.UNREVIEWED ? 1 : 0;
    const unreviewedB = b.reviewState === REVIEW_STATES.UNREVIEWED ? 1 : 0;
    if (unreviewedA !== unreviewedB) return unreviewedB - unreviewedA;
    if (b.riskScore !== a.riskScore) return b.riskScore - a.riskScore;
    return String(b.date).localeCompare(String(a.date));
  });

  // Calculate Summary Breakdown
  const summary = {
    totalRawEvaluated: transactions.length + adjustments.length + refunds.length,
    totalAnomalies: sortedAnomalies.length,
    criticalCount: sortedAnomalies.filter((a) => a.severity === SEVERITY_LEVELS.CRITICAL && a.reviewState === REVIEW_STATES.UNREVIEWED).length,
    highCount: sortedAnomalies.filter((a) => a.severity === SEVERITY_LEVELS.HIGH && a.reviewState === REVIEW_STATES.UNREVIEWED).length,
    mediumCount: sortedAnomalies.filter((a) => a.severity === SEVERITY_LEVELS.MEDIUM && a.reviewState === REVIEW_STATES.UNREVIEWED).length,
    lowCount: sortedAnomalies.filter((a) => a.severity === SEVERITY_LEVELS.LOW && a.reviewState === REVIEW_STATES.UNREVIEWED).length,
    expectedCount: sortedAnomalies.filter((a) => a.severity === SEVERITY_LEVELS.EXPECTED_ROUTINE).length,
    whitelistedCount: sortedAnomalies.filter((a) => a.severity === SEVERITY_LEVELS.WHITELISTED).length,
    resolvedCount: sortedAnomalies.filter((a) => a.reviewState === REVIEW_STATES.RESOLVED || a.reviewState === REVIEW_STATES.APPROVED).length,
  };

  return {
    anomalies: sortedAnomalies,
    summary,
  };
}

// ─── Quick Presets ────────────────────────────────────────────────────────────

export function applyOwnerPreset(anomalies = [], presetKey, options = {}) {
  if (!Array.isArray(anomalies) || !presetKey) return anomalies;

  const yesterdayIso = options.yesterdayIso || '';

  switch (presetKey) {
    case OWNER_PRESETS.HIGH_RISK_CASH_AND_VOIDS:
      return anomalies.filter((a) => (a.isCash || a.transactionCode.includes('VOID') || a.flags.some((f) => f.category === ANOMALY_CATEGORIES.CASH_RISK || f.category === ANOMALY_CATEGORIES.VOID)) && a.riskScore >= 25);

    case OWNER_PRESETS.DEEP_DISCOUNTS_AND_FREE_STAYS:
      return anomalies.filter((a) => a.flags.some((f) => f.category === ANOMALY_CATEGORIES.ZERO_COMP_ROOM || f.category === ANOMALY_CATEGORIES.NOMINAL_STAFF_RATE || f.category === ANOMALY_CATEGORIES.DEEP_DISCOUNT || f.category === ANOMALY_CATEGORIES.CUSTOM_RATE_FLOOR));

    case OWNER_PRESETS.OFF_SHIFT_MANUAL_ACTIVITY:
      return anomalies.filter((a) => !a.isSystem && !a.isOnShift);

    case OWNER_PRESETS.HOUSE_STAFF_AUDIT:
      return anomalies.filter((a) => a.accountCategory.toLowerCase().includes('staff') || a.accountCategory.toLowerCase().includes('house') || a.flags.some((f) => f.category === ANOMALY_CATEGORIES.NOMINAL_STAFF_RATE));

    case OWNER_PRESETS.MORNING_OWNER_REVIEW:
      return anomalies.filter((a) => (a.severity === SEVERITY_LEVELS.CRITICAL || a.severity === SEVERITY_LEVELS.HIGH) && a.reviewState === REVIEW_STATES.UNREVIEWED && (!yesterdayIso || a.date === yesterdayIso));

    default:
      return anomalies;
  }
}

// ─── Clerk Scorecard Aggregator ───────────────────────────────────────────────

export function generateClerkScorecard(anomalies = [], { transactions = [], adjustments = [], refunds = [] } = {}) {
  const clerks = new Map();

  const getClerk = (name, propId) => {
    const key = `${name || 'unknown'}__${propId || 'p0'}`;
    if (!clerks.has(key)) {
      clerks.set(key, {
        clerkName: name || 'unknown',
        propertyId: propId || '',
        totalTransactions: 0,
        totalDollarVolume: 0,
        overrideCount: 0,
        adjustmentCount: 0,
        adjustmentTotal: 0,
        refundCount: 0,
        refundTotal: 0,
        cashCount: 0,
        cashTotal: 0,
        offShiftCount: 0,
        criticalAlerts: 0,
        highAlerts: 0,
        approvedAlerts: 0,
        auditSummary: 'Standard baseline operational activity.',
      });
    }
    return clerks.get(key);
  };

  // 1. Transaction baseline counts
  for (const t of transactions) {
    if (!t.username) continue;
    const c = getClerk(t.username, t.property_id);
    c.totalTransactions += 1;
    c.totalDollarVolume += Math.abs(parseNum(t.amount));
    if (isCashTender(t)) {
      c.cashCount += 1;
      c.cashTotal += Math.abs(parseNum(t.amount));
    }
  }

  // 2. Adjustments & Refunds volume
  for (const a of adjustments) {
    if (!a.username) continue;
    const c = getClerk(a.username, a.property_id);
    c.adjustmentCount += 1;
    c.adjustmentTotal += Math.abs(parseNum(a.adjustedAmount ?? a.amount));
  }

  for (const r of refunds) {
    if (!r.username) continue;
    const c = getClerk(r.username, r.property_id);
    c.refundCount += 1;
    c.refundTotal += Math.abs(parseNum(r.amount));
    if (isCashTender(r)) {
      c.cashCount += 1;
      c.cashTotal += Math.abs(parseNum(r.amount));
    }
  }

  // 3. Anomaly flags & review outcomes
  for (const a of anomalies) {
    if (!a.username) continue;
    const c = getClerk(a.username, a.propertyId);
    if (a.flags.some((f) => f.category === ANOMALY_CATEGORIES.RATE_OVERRIDE || f.category === ANOMALY_CATEGORIES.DEEP_DISCOUNT)) {
      c.overrideCount += 1;
    }
    if (!a.isOnShift && !a.isSystem) {
      c.offShiftCount += 1;
    }
    if (a.severity === SEVERITY_LEVELS.CRITICAL) c.criticalAlerts += 1;
    if (a.severity === SEVERITY_LEVELS.HIGH) c.highAlerts += 1;
    if (a.reviewState === REVIEW_STATES.APPROVED || a.reviewState === REVIEW_STATES.RESOLVED) {
      c.approvedAlerts += 1;
    }
  }

  // Format numbers & build neutral audit summaries
  return [...clerks.values()].map((c) => {
    const overrideRate = c.totalTransactions > 0 ? (c.overrideCount / c.totalTransactions) * 100 : 0;
    let auditSummary = 'Standard operational baseline.';
    if (c.criticalAlerts > 0) {
      auditSummary = `${c.criticalAlerts} critical anomaly requiring review (cash/off-shift).`;
    } else if (c.highAlerts > 2) {
      auditSummary = `Elevated rate override / write-off activity (${c.highAlerts} high items).`;
    } else if (c.offShiftCount > 0) {
      auditSummary = `${c.offShiftCount} manual transactions recorded outside scheduled shift.`;
    }

    return {
      ...c,
      overrideRatePct: round2(overrideRate),
      totalDollarVolume: round2(c.totalDollarVolume),
      adjustmentTotal: round2(c.adjustmentTotal),
      refundTotal: round2(c.refundTotal),
      cashTotal: round2(c.cashTotal),
      auditSummary,
    };
  }).sort((a, b) => (b.criticalAlerts * 100 + b.highAlerts * 10) - (a.criticalAlerts * 100 + a.highAlerts * 10));
}

// ─── Immutable Audit Trail Logger ─────────────────────────────────────────────

export function recordOwnerAction(auditTrail = [], {
  action,
  anomalyId,
  propertyId,
  actor = 'Owner',
  previousState = REVIEW_STATES.UNREVIEWED,
  newState,
  reason = '',
  whitelistRule = null,
}) {
  const record = {
    id: `ACT_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    timestamp: new Date().toISOString(),
    action,
    anomalyId,
    propertyId: propertyId || '',
    actor,
    previousState,
    newState,
    reason: reason.trim(),
    whitelistRule: whitelistRule ? { ...whitelistRule } : null,
  };

  return [...auditTrail, record];
}
