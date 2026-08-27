// Payment method normalization dictionary
// Maps various source-report spellings to canonical method names

import { fromCents, sumCents } from '@/lib/decimal';

const PAYMENT_NORM = {
  "AMEX": "AMEX",
  "AMERICAN EXPRESS": "AMEX",
  "AMERICANEXPRESS": "AMEX",
  "MASTER": "MASTERCARD",
  "MASTERCARD": "MASTERCARD",
  "MASTER CARD": "MASTERCARD",
  "MC": "MASTERCARD",
  "VISA": "VISA",
  "VISA CARD": "VISA",
  "VISACARD": "VISA",
  "DISCOVER": "DISCOVER",
  "DISCOVER CARD": "DISCOVER",
  "CASH": "CASH",
  "CHECK": "CHECK",
  "CHEQUE": "CHECK",
  "CLOSED BALANCE": "CLOSED BALANCE",
  "CLOSED BALANCE FOLIO": "CLOSED BALANCE",
  "CLOSEDBALANCE": "CLOSED BALANCE",
  "FOLIO": "CLOSED BALANCE",
  "CORPAY": "CORPAY",
  "DIRECT BILL": "DIRECT BILL",
  "DIRECTBILL": "DIRECT BILL",
  "LOYALTY CERTIFICATE": "LOYALTY CERTIFICATE",
  "LOYALTYCERTIFICATE": "LOYALTY CERTIFICATE",
  "LOYALTY DISCOUNT": "LOYALTY DISCOUNT",
  "LOYALTYDISCOUNT": "LOYALTY DISCOUNT",
  "VIP PASS": "VIP PASS",
  "VIPPASS": "VIP PASS",
  "WIRE TRANSFER": "WIRE TRANSFER",
  "WIRETRANSFER": "WIRE TRANSFER",
  "OTHER": "OTHER",
};

export function normalizePaymentMethod(raw) {
  if (!raw) return "UNKNOWN";
  const upper = String(raw).trim().toUpperCase();
  return PAYMENT_NORM[upper] || upper;
}

const FIELD_LABELS = {
  cash: "Cash",
  visa: "Visa",
  master: "Mastercard",
  amex: "Amex",
  discover: "Discover",
  check: "Check",
  direct_bill: "Direct Bill",
  closed_balance_folio: "Closed Balance",
  corpay: "Corpay",
  wire_transfer: "Wire Transfer",
  loyalty_certificate: "Loyalty Certificate",
  loyalty_discount: "Loyalty Discount",
  vip_pass: "VIP Pass",
  other: "Other",
};

export function formatPaymentMethod(key) {
  return FIELD_LABELS[key] || String(key).replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export const PAYMENT_METHOD_FIELDS = Object.entries(FIELD_LABELS);

export const CARD_METHODS = ["visa", "master", "amex", "discover"];

// Payment fields that carry refunds / negative adjustments rather than tender.
//
// These are stored SIGNED. The PMS emits them as negatives — see the
// `DataTemplate` examples ("-50.00", "-20.00") and the `ManualEntry` validator,
// which allows negatives for exactly these two keys and no others — and
// `parseAmount` preserves the sign, including accounting parentheses.
//
// So sum the signed values and take the magnitude once at the end. Taking
// `abs()` per field first (the previous approach) inflates the total whenever a
// positive correction is present, because the correction adds to the refund
// instead of offsetting it.
export const REFUND_FIELDS = ["closed_balance_folio", "loyalty_discount"];

// Signed refund value for one row — negative under the convention above.
//
// Summed in integer cents (2026-08-20). Refunds are subtracted from revenue on the
// Dashboard, in Money Kept and in the Action Center, and they are also the
// denominator adjustment for the keep rate, so a residue here moves three
// different numbers by different amounts.
export function refundOf(row) {
  return fromCents(sumCents(REFUND_FIELDS.map((f) => row?.[f])));
}

// Refund magnitude for a set of payment rows.
export function refundTotal(rows) {
  return Math.abs(fromCents(sumCents((rows || []).map(refundOf))));
}

// Refund magnitude from an already-summed per-method map.
export function refundTotalFromTotals(methodTotals) {
  return Math.abs(fromCents(sumCents(REFUND_FIELDS.map((f) => methodTotals?.[f]))));
}

// Selected-period refund breakdown — the shared, cent-exact refund contract for
// any surface that needs BOTH the period total and a reconciling daily trend.
//
// The period refund is the MAGNITUDE of the sum of every signed refund row in
// the selected period (abs ONCE), never the sum of per-row or per-day magnitudes:
// a positive closed_balance_folio / loyalty_discount correction must OFFSET a
// refund, and taking abs() at the row or day boundary turns that offset into an
// inflating addition whenever it lands on a different row/day than the refund it
// corrects (Day1 -500 + Day2 +300 is a 200 refund, not 800).
//
// For a daily trend that must reconcile to that single period magnitude, each
// day's signed total is oriented by the PERIOD's direction (sign):
//   Sum(dayAlloc) = direction * Sum(daySigned) = direction * periodSigned = |periodSigned|
// so the oriented daily allocations sum EXACTLY to the period magnitude in integer
// cents. A day whose sign opposes the period reads as a negative allocation — an
// honest offset — rather than an abs()'d addition. magnitude === refundTotal(rows).
export function refundPeriodBreakdown(rows, dateOf = (r) => String(r?.date ?? "").slice(0, 10)) {
  const dayCents = new Map();
  let periodCents = 0;
  for (const r of rows || []) {
    const c = sumCents(REFUND_FIELDS.map((f) => r?.[f])); // signed cents for this row
    periodCents += c;
    const d = dateOf(r);
    dayCents.set(d, (dayCents.get(d) || 0) + c);
  }
  const direction = periodCents < 0 ? -1 : 1; // default +1 when the period nets to zero
  const magnitudeCents = Math.abs(periodCents);
  const byDay = new Map();
  for (const [d, c] of dayCents) {
    const allocationCents = direction * c;
    byDay.set(d, { signedCents: c, allocationCents, allocation: fromCents(allocationCents) });
  }
  return { periodCents, magnitudeCents, magnitude: fromCents(magnitudeCents), direction, byDay };
}