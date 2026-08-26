import { classifyRefund, REFUND_CLASSIFICATION, refundEvidenceText } from "@/lib/refundClassification";

export const REFUND_FILTERS_DEFAULT = {
  classification: "ALL",
  method: "ALL",
  from: "",
  to: "",
  room: "",
  evidence: "",
  minAmount: "",
  maxAmount: "",
  hideDepositReturns: false,
};

function safeNumber(value) {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function filterAuditRefunds(rows = [], filters = {}) {
  const settings = { ...REFUND_FILTERS_DEFAULT, ...filters };
  const min = safeNumber(settings.minAmount);
  const max = safeNumber(settings.maxAmount);
  const room = String(settings.room || "").trim().toLowerCase();
  const evidence = String(settings.evidence || "").trim().toLowerCase();
  return rows.map((row) => ({ ...row, refundClassification: row.refundClassification || classifyRefund(row) }))
    .filter((row) => {
      const classification = row.refundClassification;
      const date = String(row.date || "").slice(0, 10);
      const amount = classification.amount;
      if (settings.method !== "ALL" && String(row.paymentTypeRefunded || "").toUpperCase() !== settings.method) return false;
      if (settings.classification === "CASH_ROOM_RENT" && !(classification.isCash && classification.kind === REFUND_CLASSIFICATION.ROOM_RENT_REFUND)) return false;
      if (settings.classification !== "ALL" && settings.classification !== "CASH_ROOM_RENT" && classification.kind !== settings.classification) return false;
      if (settings.hideDepositReturns && classification.kind === REFUND_CLASSIFICATION.DEPOSIT_RETURN) return false;
      if (settings.from && (!date || date < settings.from)) return false;
      if (settings.to && (!date || date > settings.to)) return false;
      if (room && !String(row.roomNumber || "").toLowerCase().includes(room)) return false;
      if (evidence && !`${refundEvidenceText(row)} ${classification.label} ${classification.reason}`.toLowerCase().includes(evidence)) return false;
      if (min !== null && amount < min) return false;
      if (max !== null && amount > max) return false;
      return true;
    })
    .sort((a, b) => {
      const priority = (row) => row.refundClassification.isCash && row.refundClassification.kind === REFUND_CLASSIFICATION.ROOM_RENT_REFUND ? 0 : row.refundClassification.kind === REFUND_CLASSIFICATION.ROOM_RENT_REFUND ? 1 : row.refundClassification.kind === REFUND_CLASSIFICATION.NEEDS_REVIEW ? 2 : 3;
      return priority(a) - priority(b) || String(b.date || "").localeCompare(String(a.date || "")) || String(b.time || "").localeCompare(String(a.time || ""));
    });
}

export function refundFilterTotal(rows = []) {
  return rows.reduce((sum, row) => sum + (row.refundClassification?.amount ?? Math.abs(Number(row.amount) || 0)), 0);
}
