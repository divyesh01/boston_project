import { classifyRefund, REFUND_CLASSIFICATION } from "@/lib/refundClassification";

// Automated financial anomaly & fraud detection engine.
//
// Pure, zero-dependency detection over normalized transaction rows (the shape
// produced by src/lib/transactionNorm.js). Every detector returns an array of
// alert objects for owner review; nothing here touches storage, so the same
// functions run under the test harness, in the CSV import pipeline, and in a
// future server-side cron with identical results.
//
// Detection rules:
//   1. rate_override          — room charge rate > 50% below the property's
//                               average ADR (baseline computed from the batch,
//                               overridable via options.adr).
//   2. excessive_adjustments  — a username whose negative adjustments/credits
//                               exceed $200 on a single day.
//   3. off_hours_posting      — manual room / cash / credit postings between
//                               01:00 and 05:00 by non-system accounts.

export const ANOMALY_TYPES = {
  RATE_OVERRIDE: "rate_override",
  EXCESSIVE_ADJUSTMENTS: "excessive_adjustments",
  OFF_HOURS_POSTING: "off_hours_posting",
};

export const DEFAULT_THRESHOLDS = {
  rateOverrideRatio: 0.5, // flag room rates > 50% below ADR
  adjustmentAmount: 200,  // total negative adjustments per user/day
  offHoursStart: 1,       // 01:00
  offHoursEnd: 5,         // 05:00 (exclusive)
};

function amountOf(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function fmt(v) {
  return `$${round2(v).toFixed(2)}`;
}

function hourOfTime(time) {
  if (time == null) return null;
  const s = String(time).trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const ap = (m[4] || "").toUpperCase();
  if (ap === "PM" && h < 12) h += 12;
  if (ap === "AM" && h === 12) h = 0;
  return h >= 0 && h <= 23 ? h : null;
}

export function isRoomCharge(row) {
  const code = String(row?.transaction_code || "").toUpperCase();
  const cat = String(row?.charge_category || "");
  const desc = String(row?.transaction_description || "").toUpperCase();
  return code === "RR" || /ROOM RENT/.test(cat.toUpperCase()) || /ROOM/i.test(desc);
}

export function isCashPosting(row) {
  const code = String(row?.transaction_code || "").toUpperCase();
  const pm = String(row?.payment_method || "").toUpperCase();
  const desc = String(row?.transaction_description || "").toUpperCase();
  return code === "CASH" || pm === "CASH" || /CASH/.test(desc);
}

export function isCreditPosting(row) {
  const type = String(row?.transaction_type || "").toUpperCase();
  const side = String(row?.ledger_side || "");
  const desc = String(row?.transaction_description || "").toUpperCase();
  return type === "REFUND" || side === "payment" || /CREDIT|DEPOSIT RETURN/.test(desc);
}

function isManualPosting(row) {
  return isRoomCharge(row) || isCashPosting(row) || isCreditPosting(row);
}

function postingKind(row) {
  if (isCashPosting(row)) return "cash";
  if (isCreditPosting(row)) return "credit";
  return "room";
}

// Off-hours postings are "manual ... by non-system accounts": the PMS/automation
// users (hkcrsuser, hkiotuser) are unattended integrations and are excluded.
function isNonSystemAccount(row) {
  const cls = String(row?.account_class || "");
  if (cls === "system") return false;
  const u = String(row?.username || "").trim().toLowerCase();
  if (!u) return false;
  if (u === "hkcrsuser" || u === "hkiotuser") return false;
  if (!u.includes("@")) return false;
  return true;
}

function alertFor(alert_type, row, { severity, detail, amount, rule }) {
  const date = String(row?.date || "").slice(0, 10) || "";
  const username = String(row?.username || "");
  const folio_number = String(row?.folio_number || "");
  const transaction_code = String(row?.transaction_code || "");
  return {
    alert_type,
    severity,
    date,
    username,
    account_class: String(row?.account_class || ""),
    transaction_code,
    charge_category: String(row?.charge_category || ""),
    folio_number,
    room_number: String(row?.room_number || ""),
    amount: round2(amount),
    detail,
    rule,
    dedupe_key: [alert_type, date, username, folio_number, transaction_code, round2(amount)].join("|"),
  };
}

// 1. Rate override — room charge rates more than `rateOverrideRatio` below the
// property's average ADR. ADR is the mean of positive room-charge amounts in the
// batch, or options.adr when the caller has an authoritative figure.
export function detectRateOverrides(rows, options = {}) {
  if (!Array.isArray(rows) || !rows.length) return [];
  const ratio = Number.isFinite(options.rateOverrideRatio)
    ? options.rateOverrideRatio
    : DEFAULT_THRESHOLDS.rateOverrideRatio;

  const roomRows = rows.filter(isRoomCharge);
  if (!roomRows.length) return [];

  let adr = options.adr;
  if (!(adr > 0)) {
    const positives = roomRows.map((r) => amountOf(r.amount)).filter((a) => a > 0);
    adr = positives.length ? positives.reduce((s, a) => s + a, 0) / positives.length : 0;
  }
  if (!(adr > 0)) return [];

  const threshold = adr * ratio;
  const flags = [];
  for (const row of roomRows) {
    const amt = amountOf(row.amount);
    if (amt < 0) continue;
    if (amt < threshold) {
      flags.push(alertFor(ANOMALY_TYPES.RATE_OVERRIDE, row, {
        severity: "high",
        detail: `Room charge ${fmt(amt)} is more than 50% below property ADR ${fmt(adr)}`,
        amount: amt,
        rule: { adr: round2(adr), threshold: round2(threshold), ratio },
      }));
    }
  }
  return flags;
}

// 2. Excessive adjustments — a username whose total negative adjustment/credit
// amount on a single day exceeds `adjustmentAmount`. Credits carry the sign the
// PMS emitted, so an adjustment is simply any negative amount.
export function detectExcessiveAdjustments(rows, options = {}) {
  if (!Array.isArray(rows) || !rows.length) return [];
  const threshold = Number.isFinite(options.adjustmentAmount)
    ? options.adjustmentAmount
    : DEFAULT_THRESHOLDS.adjustmentAmount;

  const buckets = new Map();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const amt = amountOf(row.amount);
    if (amt >= 0) continue;
    const username = String(row.username || "unknown");
    const day = String(row.date || "").slice(0, 10) || "unknown";
    const key = `${username}||${day}`;
    if (!buckets.has(key)) buckets.set(key, { username, date: day, total: 0, rows: [] });
    buckets.get(key).total += Math.abs(amt);
    buckets.get(key).rows.push(row);
  }

  const flags = [];
  for (const b of buckets.values()) {
    if (b.total > threshold) {
      const rep = b.rows.reduce(
        (a, c) => (Math.abs(amountOf(c.amount)) > Math.abs(amountOf(a.amount)) ? c : a),
        b.rows[0]
      );
      flags.push(alertFor(ANOMALY_TYPES.EXCESSIVE_ADJUSTMENTS, rep, {
        severity: "high",
        detail: `${b.username} posted ${fmt(b.total)} in negative adjustments/credits on ${b.date}`,
        amount: b.total,
        rule: { threshold, count: b.rows.length },
      }));
    }
  }
  return flags;
}

// 3. Off-hours postings — manual room / cash / credit postings between
// `offHoursStart` and `offHoursEnd` (inclusive start, exclusive end) by
// non-system accounts.
export function detectOffHoursPostings(rows, options = {}) {
  if (!Array.isArray(rows) || !rows.length) return [];
  const start = Number.isFinite(options.offHoursStart)
    ? options.offHoursStart
    : DEFAULT_THRESHOLDS.offHoursStart;
  const end = Number.isFinite(options.offHoursEnd)
    ? options.offHoursEnd
    : DEFAULT_THRESHOLDS.offHoursEnd;

  const flags = [];
  for (const row of rows) {
    if (!isManualPosting(row)) continue;
    if (!isNonSystemAccount(row)) continue;
    const hour = hourOfTime(row.time);
    if (hour === null || hour < start || hour >= end) continue;
    flags.push(alertFor(ANOMALY_TYPES.OFF_HOURS_POSTING, row, {
      severity: "medium",
      detail: `Manual ${postingKind(row)} posting by ${row.username} at ${row.time}`,
      amount: amountOf(row.amount),
      rule: { hour, window: [start, end] },
    }));
  }
  return flags;
}

// Combined entry point used by the CSV import pipeline. Returns every alert
// produced by all three rules. Defensively returns [] for non-array input.
export function detectAnomalies(rows, options = {}) {
  if (!Array.isArray(rows)) return [];
  return [
    ...detectRateOverrides(rows, options),
    ...detectExcessiveAdjustments(rows, options),
    ...detectOffHoursPostings(rows, options),
  ];
}

export default detectAnomalies;

// ─── Clerk Audit: Adjustments & Refunds Anomaly Detection ──────────────
//
// Separate detection pipeline for HotelKey "Adjustments and Refunds Activity"
// CSV reports. Operates on parsed adjustment/refund objects (the shape produced
// by scanAdjustmentsRefunds in reportParsers.js), NOT on TransactionLine rows.
//
// Detection rules:
//   1. cash_refund_skimming       — cash refund ≥ $50, high risk of deposit
//                                   return fraud.
//   2. repeated_adjustment_loop   — 3+ adjustments on the same room in one day,
//                                   possible revenue suppression pattern.
//   3. large_uncategorized_writeoff — vague reason code with amount ≥ $50.
//   4. off_hours_adjustment       — adjustment or refund posted 23:00–06:00.
//
// Additionally, a per-clerk risk score matrix aggregates total flags, refunded
// amount, and adjusted amount into HIGH / MEDIUM / LOW risk levels.

export const CLERK_ANOMALY_TYPES = {
  CASH_REFUND_SKIMMING: "cash_refund_skimming",
  REPEATED_ADJUSTMENT_LOOP: "repeated_adjustment_loop",
  LARGE_UNCATEGORIZED_WRITEOFF: "large_uncategorized_writeoff",
  OFF_HOURS_ADJUSTMENT: "off_hours_adjustment",
  DEPOSIT_REFUND: "deposit_refund",
  ROOM_RENT_REFUND: "room_rent_refund",
};

export const CLERK_THRESHOLDS = {
  cashRefundMinAmount: 50,        // $50 minimum to flag a cash refund
  repeatedAdjustmentCount: 3,     // 3+ adjustments on same room/day
  largeWriteoffMinAmount: 50,     // $50 minimum for vague-reason flag
  offHoursStart: 23,              // 23:00
  offHoursEnd: 6,                 // 06:00 (exclusive)
  highRiskFlagCount: 3,           // 3+ flags → HIGH risk clerk
  highRiskAdjustedAmount: 300,    // >$300 total adjusted → HIGH risk clerk
  microSkimCount: 3,              // 3+ small cash refunds in a shift
  microSkimMaxAmount: 20,         // under $20 is considered a micro-skim
  graveyardStart: 1,              // 01:00 AM
  graveyardEnd: 5,                // 05:00 AM
};

const VAGUE_REASON_CODES = new Set([
  "OTHER ADJUSTMENTS",
  "AR BILLING ADJUSTMENT",
  "HOSPITALITY ADJUSTMENT",
]);

const SUSPICIOUS_REMARKS_PATTERN = /(error|mistake|wrong room|guest complain|per manager|accident)/i;
const EXACT_RATES = new Set([49, 59, 69, 79, 89, 99, 109, 119, 129, 139, 149, 159, 169, 179, 189, 199]);

function clerkAlertFor(ruleId, ruleName, severity, riskType, row, amount) {
  return {
    id: `${ruleId}|${row.date || ""}|${row.username || ""}|${row.roomNumber || ""}|${round2(amount)}|${row.time || ""}`,
    ruleId,
    ruleName,
    severity,
    riskType,
    date: row.date || "",
    time: row.time || "",
    username: row.username || "",
    roomNumber: row.roomNumber || "",
    reasonCode: row.reasonCode || "",
    refundCode: row.refundCode || "",
    paymentType: row.paymentTypeRefunded || "",
    amount: round2(amount),
    remarks: row.remarks || "",
    transaction: row,
  };
}

// Rule 1: Cash Refund / Deposit Skimming
function detectCashRefundSkimming(refunds, thresholds) {
  const min = thresholds.cashRefundMinAmount;
  const flags = [];
  for (const r of refunds) {
    const pt = String(r.paymentTypeRefunded || "").toUpperCase().trim();
    const amt = Math.abs(Number(r.amount) || 0);
    if (pt === "CASH" && classifyRefund(r).kind !== REFUND_CLASSIFICATION.DEPOSIT_RETURN && amt >= min) {
      flags.push(clerkAlertFor(
        CLERK_ANOMALY_TYPES.CASH_REFUND_SKIMMING,
        "Cash Refund Needs Review",
        "CRITICAL",
        "Cash Refund Review",
        r,
        r.amount,
      ));
    }
  }
  return flags;
}

// Rule 2: High-Frequency Reversal Loop — 3+ adjustments on the same room in
// one calendar day.
function detectRepeatedAdjustmentLoop(adjustments, thresholds) {
  const minCount = thresholds.repeatedAdjustmentCount;
  const buckets = new Map();
  for (const a of adjustments) {
    const key = `${a.roomNumber || "?"}|${(a.date || "").slice(0, 10)}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(a);
  }

  const flags = [];
  for (const group of buckets.values()) {
    if (group.length >= minCount) {
      for (const a of group) {
        flags.push(clerkAlertFor(
          CLERK_ANOMALY_TYPES.REPEATED_ADJUSTMENT_LOOP,
          "Repeated Adjustment Loop",
          "HIGH",
          "Repeated Adjustment Loop",
          a,
          a.adjustedAmount || a.amount || 0,
        ));
      }
    }
  }
  return flags;
}

// Rule 3: Vague Reason Code & Large Write-Off
function detectLargeUncategorizedWriteoff(adjustments, thresholds) {
  const min = thresholds.largeWriteoffMinAmount;
  const flags = [];
  for (const a of adjustments) {
    const code = String(a.reasonCode || "").toUpperCase().trim();
    const amt = Math.abs(Number(a.adjustedAmount ?? a.amount) || 0);
    if (VAGUE_REASON_CODES.has(code) && amt >= min) {
      flags.push(clerkAlertFor(
        CLERK_ANOMALY_TYPES.LARGE_UNCATEGORIZED_WRITEOFF,
        "Large Uncategorized Write-Off",
        "MEDIUM",
        "Large Uncategorized Write-Off",
        a,
        a.adjustedAmount || a.amount || 0,
      ));
    }
  }
  return flags;
}

// Rule 4: Off-Hours Adjustments/Refunds (23:00–06:00)
function detectOffHoursAdjustments(rows, thresholds) {
  const start = thresholds.offHoursStart;  // 23
  const end = thresholds.offHoursEnd;      // 6
  const flags = [];
  for (const row of rows) {
    const hour = hourOfTime(row.time);
    if (hour === null) continue;
    // 23:00–23:59 or 00:00–05:59
    const isOffHours = hour >= start || hour < end;
    if (!isOffHours) continue;
    const amt = row.adjustedAmount ?? row.amount ?? 0;
    flags.push(clerkAlertFor(
      "off_hours_adjustment",
      "Off-Hours Adjustment",
      "MEDIUM",
      "Off-Hours Adjustment",
      row,
      amt,
    ));
  }
  return flags;
}

// Rule 5: Micro-Skimming (Salami Slicing)
// >= 3 small cash refunds (< $20) by the same clerk in one day
function detectMicroSkimming(refunds, thresholds) {
  const buckets = new Map();
  for (const r of refunds) {
    const pt = String(r.paymentTypeRefunded || "").toUpperCase().trim();
    const amt = Math.abs(Number(r.amount) || 0);
    if (pt === "CASH" && classifyRefund(r).kind !== REFUND_CLASSIFICATION.DEPOSIT_RETURN && amt > 0 && amt <= thresholds.microSkimMaxAmount) {
      const key = `${r.username || "?"}|${(r.date || "").slice(0, 10)}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(r);
    }
  }

  const flags = [];
  for (const group of buckets.values()) {
    if (group.length >= thresholds.microSkimCount) {
      for (const r of group) {
        flags.push(clerkAlertFor(
          "micro_skimming",
          "Micro-Skimming Pattern",
          "CRITICAL",
          "Micro-Skimming",
          r,
          r.amount,
        ));
      }
    }
  }
  return flags;
}

// Rule 6: Graveyard Shift Cash Grabs
// Any cash refund between 01:00 and 05:00 AM
function detectGraveyardCashGrabs(refunds, thresholds) {
  const flags = [];
  for (const r of refunds) {
    const pt = String(r.paymentTypeRefunded || "").toUpperCase().trim();
    if (pt !== "CASH" || classifyRefund(r).kind === REFUND_CLASSIFICATION.DEPOSIT_RETURN) continue;
    
    const hour = hourOfTime(r.time);
    if (hour === null || hour < thresholds.graveyardStart || hour >= thresholds.graveyardEnd) continue;
    
    flags.push(clerkAlertFor(
      "graveyard_cash_grab",
      "Graveyard Shift Cash Refund",
      "CRITICAL",
      "Graveyard Cash Skim",
      r,
      r.amount,
    ));
  }
  return flags;
}

// Rule 7: Exact Rate Reversals
// Adjustment exactly matching a standard room rate ($99, $109, etc.)
function detectExactRateReversals(adjustments) {
  const flags = [];
  for (const a of adjustments) {
    const amt = Math.abs(Number(a.adjustedAmount ?? a.amount) || 0);
    if (EXACT_RATES.has(amt)) {
      flags.push(clerkAlertFor(
        "exact_rate_reversal",
        "Exact Rate Reversal",
        "HIGH",
        "Revenue Suppression",
        a,
        a.adjustedAmount || a.amount || 0,
      ));
    }
  }
  return flags;
}

// Rule 8: Suspicious Remarks
function detectSuspiciousRemarks(rows) {
  const flags = [];
  for (const row of rows) {
    if (row.remarks && SUSPICIOUS_REMARKS_PATTERN.test(row.remarks)) {
      const amt = Math.abs(Number(row.adjustedAmount ?? row.amount) || 0);
      if (amt >= 20) {
        flags.push(clerkAlertFor(
          "suspicious_remarks",
          "Suspicious Remarks",
          "HIGH",
          "Suspicious Justification",
          row,
          row.adjustedAmount ?? row.amount ?? 0,
        ));
      }
    }
  }
  return flags;
}

// Rule 9: Round Number Fraud
// Amounts perfectly divisible by $50.00
function detectRoundNumberFraud(rows) {
  const flags = [];
  for (const row of rows) {
    const amt = Math.abs(Number(row.adjustedAmount ?? row.amount) || 0);
    // Exclude very small amounts and exact rate matches (which are usually .00)
    if (amt >= 50 && amt % 50 === 0) {
      flags.push(clerkAlertFor(
        "round_number_fraud",
        "Round Number Reversal",
        "MEDIUM",
        "Fictitious Manual Entry",
        row,
        row.adjustedAmount ?? row.amount ?? 0,
      ));
    }
  }
  return flags;
}

// Rule 10: refund classification. A deposit note is evidence; an amount alone
// is not. An unclear exact $100 stays visible for owner review.
function detectDepositRefunds(refunds, _thresholds) {
  const flags = [];
  for (const r of refunds) {
    const amt = Math.abs(Number(r.amount) || 0);
    const classification = classifyRefund(r);
    if (classification.kind === REFUND_CLASSIFICATION.DEPOSIT_RETURN) {
      flags.push(clerkAlertFor(
        CLERK_ANOMALY_TYPES.DEPOSIT_REFUND,
        "Deposit Return (note confirmed)",
        "LOW",
        "Deposit Refund",
        r,
        r.amount,
      ));
    } else if (classification.kind === REFUND_CLASSIFICATION.ROOM_RENT_REFUND && amt > 0) {
      flags.push(clerkAlertFor(
        CLERK_ANOMALY_TYPES.ROOM_RENT_REFUND,
        classification.label,
        "MEDIUM",
        "Room Rent Refund",
        r,
        r.amount,
      ));
    } else if (amt > 0) {
      flags.push(clerkAlertFor(
        "refund_needs_review",
        "Refund Needs Classification",
        "MEDIUM",
        "Unclear Refund",
        r,
        r.amount,
      ));
    }
  }
  return flags;
}

// Clerk Risk Score Matrix — aggregate flags and amounts per username.
function buildClerkRiskScores(flaggedAnomalies, adjustments, refunds, thresholds) {
  const map = new Map();
  const ensure = (username) => {
    if (!map.has(username)) {
      map.set(username, {
        username,
        totalFlags: 0,
        totalRefundedAmount: 0,
        totalAdjustedAmount: 0,
        totalCashRefunded: 0,
        totalDepositRefunds: 0,
        totalRoomRentRefunds: 0,
        totalNeedsReviewRefunds: 0,
        totalCashRoomRentRefunds: 0,
        depositRefundCount: 0,
        roomRentRefundCount: 0,
        needsReviewRefundCount: 0,
        riskLevel: "LOW",
        behaviorAnalysis: "",
      });
    }
    return map.get(username);
  };

  // Count flags per clerk
  for (const a of flaggedAnomalies) {
    if (a.username) ensure(a.username).totalFlags += 1;
  }

  // Sum adjustment amounts per clerk
  for (const a of adjustments) {
    if (a.username) {
      ensure(a.username).totalAdjustedAmount += Math.abs(Number(a.adjustedAmount ?? a.amount) || 0);
    }
  }

  // Sum refund amounts per clerk - track deposit vs room rent separately
  for (const r of refunds) {
    if (r.username) {
      const u = ensure(r.username);
      const amt = Math.abs(Number(r.amount) || 0);
      u.totalRefundedAmount += amt;
      const classification = classifyRefund(r);
      if (classification.isCash) {
        u.totalCashRefunded += amt;
      }
      if (classification.kind === REFUND_CLASSIFICATION.DEPOSIT_RETURN) {
        u.totalDepositRefunds += amt;
        u.depositRefundCount += 1;
      } else if (classification.kind === REFUND_CLASSIFICATION.ROOM_RENT_REFUND && amt > 0) {
        u.totalRoomRentRefunds += amt;
        u.roomRentRefundCount += 1;
        if (classification.isCash) u.totalCashRoomRentRefunds += amt;
      } else if (amt > 0) {
        u.totalNeedsReviewRefunds += amt;
        u.needsReviewRefundCount += 1;
      }
    }
  }

  // Assign risk levels & AI Insights
  for (const score of map.values()) {
    score.totalAdjustedAmount = round2(score.totalAdjustedAmount);
    score.totalRefundedAmount = round2(score.totalRefundedAmount);
    score.totalCashRefunded = round2(score.totalCashRefunded);
    score.totalDepositRefunds = round2(score.totalDepositRefunds);
    score.totalRoomRentRefunds = round2(score.totalRoomRentRefunds);
    score.totalNeedsReviewRefunds = round2(score.totalNeedsReviewRefunds);
    score.totalCashRoomRentRefunds = round2(score.totalCashRoomRentRefunds);
    
    let cashRatio = 0;
    if (score.totalRefundedAmount > 0) {
      cashRatio = score.totalCashRefunded / score.totalRefundedAmount;
    }
    score.cashRatio = cashRatio;

    // AI Behavior string generation
    let insights = [];
    if (cashRatio > 0.8 && score.totalCashRefunded > 100) {
      insights.push(`High cash-refund ratio (${Math.round(cashRatio * 100)}%). Review folios and approvals.`);
    }
    if (score.totalFlags >= thresholds.highRiskFlagCount) {
      insights.push(`Frequent flagged behavior.`);
    }
    if (score.totalAdjustedAmount > thresholds.highRiskAdjustedAmount) {
      insights.push(`Excessive write-offs.`);
    }
    // Deposit vs Room Rent analysis
    if (score.depositRefundCount > 0) {
      insights.push(`${score.depositRefundCount} deposit return(s) totaling ${round2(score.totalDepositRefunds).toFixed(2)} — confirmed by refund notes.`);
    }
    if (score.roomRentRefundCount > 0) {
      insights.push(`${score.roomRentRefundCount} room rent refund(s) totaling ${round2(score.totalRoomRentRefunds).toFixed(2)} — review for rate disputes or comps.`);
    }
    if (score.needsReviewRefundCount > 0) {
      insights.push(`${score.needsReviewRefundCount} refund(s) totaling ${round2(score.totalNeedsReviewRefunds).toFixed(2)} need classification; amount alone is not proof.`);
    }
    // High room rent refund ratio could indicate issues
    if (score.roomRentRefundCount > 3 && score.totalRoomRentRefunds > 200) {
      insights.push(`High volume of room-rent refunds — review supporting folios and approvals.`);
    }
    
    score.behaviorAnalysis = insights.length > 0 ? insights.join(" ") : "Normal behavior baseline.";

    if (score.totalFlags >= thresholds.highRiskFlagCount || score.totalAdjustedAmount > thresholds.highRiskAdjustedAmount || cashRatio >= 0.85) {
      score.riskLevel = "HIGH";
    } else if (score.totalFlags >= 1 || cashRatio >= 0.5 || score.roomRentRefundCount > 2) {
      score.riskLevel = "MEDIUM";
    } else {
      score.riskLevel = "LOW";
    }
  }

  return [...map.values()].sort((a, b) => {
    const order = { HIGH: 0, MEDIUM: 1, LOW: 2 };
    return (order[a.riskLevel] ?? 3) - (order[b.riskLevel] ?? 3) || b.totalFlags - a.totalFlags;
  });
}

// Combined entry point for clerk audit anomaly detection.
// Takes parsed adjustment and refund arrays (from scanAdjustmentsRefunds).
// Returns { flaggedAnomalies, clerkRiskScores }.
export function detectClerkAnomalies({ adjustments = [], refunds = [] }, options = {}) {
  const thresholds = { ...CLERK_THRESHOLDS, ...options };

  const allRows = [...adjustments, ...refunds];

  const flaggedAnomalies = [
    ...detectCashRefundSkimming(refunds, thresholds),
    ...detectRepeatedAdjustmentLoop(adjustments, thresholds),
    ...detectLargeUncategorizedWriteoff(adjustments, thresholds),
    ...detectOffHoursAdjustments(allRows, thresholds),
    ...detectMicroSkimming(refunds, thresholds),
    ...detectGraveyardCashGrabs(refunds, thresholds),
    ...detectExactRateReversals(adjustments),
    ...detectSuspiciousRemarks(allRows),
    ...detectRoundNumberFraud(allRows),
    ...detectDepositRefunds(refunds, thresholds),
  ];

  // Dedupe by id (a row can trigger multiple rules)
  const seen = new Set();
  const deduped = [];
  for (const f of flaggedAnomalies) {
    if (!seen.has(f.id)) {
      seen.add(f.id);
      deduped.push(f);
    }
  }

  const clerkRiskScores = buildClerkRiskScores(deduped, adjustments, refunds, thresholds);

  return { flaggedAnomalies: deduped, clerkRiskScores };
}
