// Payment method normalization dictionary
// Maps various source-report spellings to canonical method names

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