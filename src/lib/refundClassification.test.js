import { describe, expect, it } from "vitest";
import { classifyRefund, REFUND_CLASSIFICATION, refundEvidenceText } from "./refundClassification";

describe("refund classification", () => {
  it("recognizes a deposit return from its note even when the amount is not $100", () => {
    const result = classifyRefund({ amount: 90.94, paymentTypeRefunded: "CASH", remarks: "Cash deposit refund" });
    expect(result.kind).toBe(REFUND_CLASSIFICATION.DEPOSIT_RETURN);
    expect(result.isCash).toBe(true);
  });

  it("does not treat an unlabeled exact $100 as a proven deposit return", () => {
    expect(classifyRefund({ amount: 100, remarks: "S" }).kind).toBe(REFUND_CLASSIFICATION.NEEDS_REVIEW);
  });

  it("treats a non-deposit refund as room-rent review money and keeps cash visible", () => {
    const result = classifyRefund({ amount: 125, paymentTypeRefunded: "CASH", remarks: "customer satisfaction" });
    expect(result.kind).toBe(REFUND_CLASSIFICATION.ROOM_RENT_REFUND);
    expect(result.isCash).toBe(true);
  });

  it("keeps every imported evidence field available for the audit drawer", () => {
    expect(refundEvidenceText({
      remarks: "Guest complained about housekeeping",
      refundCode: "Customer satisfaction",
      paymentDetail: "Front desk approved",
      reasonCode: "Hospitality",
      chargeType: "Room charge",
    })).toBe("Guest complained about housekeeping Customer satisfaction Front desk approved Hospitality Room charge");
  });
});
