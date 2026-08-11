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
