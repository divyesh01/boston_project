// Refund classification for the Clerk Audit. An amount alone cannot prove why
// money left the property: deposit wording is evidence, and an unlabeled $100
// record stays visible for review rather than being silently misclassified.

const DEPOSIT_NOTE = /\b(?:cash\s+)?(?:(?:guest|security|incidental)\s+)?deposi(?:t|ot|te)?(?:\s+(?:refund|return|back))?\b|\b(?:refund|return)\s+(?:cash\s+)?(?:(?:guest|security|incidental)\s+)?deposi(?:t|ot|te)?\b/i;
const ROOM_RENT_NOTE = /\b(?:room\s*(?:rent|rate|charge)|customer\s+satisfaction|early\s+departure|guest\s+complaint|hospitality)\b/i;

export const REFUND_CLASSIFICATION = {
  DEPOSIT_RETURN: "deposit_return",
  ROOM_RENT_REFUND: "room_rent_refund",
  NEEDS_REVIEW: "needs_review",
};

export function refundEvidenceText(row = {}) {
  return [row.remarks, row.refundCode, row.paymentDetail, row.reasonCode, row.chargeType]
    .filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

export function classifyRefund(row = {}) {
  const amount = Math.abs(Number(row.amount) || 0);
  const evidence = refundEvidenceText(row);
  const paymentType = String(row.paymentTypeRefunded || row.payment_type || "").trim().toUpperCase();
  const isCash = paymentType === "CASH";
  if (DEPOSIT_NOTE.test(evidence)) return { kind: REFUND_CLASSIFICATION.DEPOSIT_RETURN, label: "Deposit return", reason: "Refund note identifies a guest/security/incidental deposit return.", isCash, amount };
  if (Math.abs(amount - 100) <= 0.01) return { kind: REFUND_CLASSIFICATION.NEEDS_REVIEW, label: "Needs review", reason: "Exact $100 with no deposit-return note; amount alone is not proof.", isCash, amount };
  const explicitRoomRent = ROOM_RENT_NOTE.test(evidence);
  return { kind: REFUND_CLASSIFICATION.ROOM_RENT_REFUND, label: explicitRoomRent ? "Room-rent refund" : "Possible room-rent refund", reason: explicitRoomRent ? "Refund note indicates a room/rate/service-related adjustment." : "No deposit-return evidence was supplied; confirm the folio before assigning a cause.", isCash, amount };
}
