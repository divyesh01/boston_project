import { describe, expect, it } from "vitest";
import {
  CLERK_ANOMALY_TYPES,
  detectClerkAnomalies,
} from "@/lib/anomalyDetector";

const mkRefund = (overrides = {}) => ({
  date: "2026-07-04",
  username: "bella",
  amount: 100,
  paymentTypeRefunded: "CARD",
  ...overrides,
});

describe("deposit vs room-rent refund classification", () => {
  it("flags a note-confirmed deposit refund as LOW severity", () => {
    const { flaggedAnomalies } = detectClerkAnomalies({
      refunds: [mkRefund({ amount: 90.94, remarks: "cash deposit refund" })],
    });

    const deposit = flaggedAnomalies.filter((f) => f.ruleId === CLERK_ANOMALY_TYPES.DEPOSIT_REFUND);
    expect(deposit).toHaveLength(1);
    expect(deposit[0].severity).toBe("LOW");
    expect(deposit[0].amount).toBe(90.94);
  });

  it("does not silently classify an unlabeled $100 as a deposit or room-rent refund", () => {
    const { flaggedAnomalies } = detectClerkAnomalies({
      refunds: [mkRefund({ amount: 100 })],
    });

    expect(flaggedAnomalies.some((f) => f.ruleId === CLERK_ANOMALY_TYPES.DEPOSIT_REFUND)).toBe(false);
    expect(flaggedAnomalies.some((f) => f.ruleId === CLERK_ANOMALY_TYPES.ROOM_RENT_REFUND)).toBe(false);
    expect(flaggedAnomalies.some((f) => f.ruleId === "refund_needs_review")).toBe(true);
  });

  it("flags a non-$100 refund as a room-rent refund (MEDIUM severity)", () => {
    const { flaggedAnomalies } = detectClerkAnomalies({
      refunds: [mkRefund({ amount: 84 })],
    });

    const roomRent = flaggedAnomalies.filter((f) => f.ruleId === CLERK_ANOMALY_TYPES.ROOM_RENT_REFUND);
    expect(roomRent).toHaveLength(1);
    expect(roomRent[0].severity).toBe("MEDIUM");
    expect(roomRent[0].amount).toBe(84);
  });

  it("uses note evidence rather than a $100 tolerance", () => {
    const { flaggedAnomalies } = detectClerkAnomalies({
      refunds: [mkRefund({ amount: 100.009, remarks: "guest deposit return" })],
    });

    const deposit = flaggedAnomalies.filter((f) => f.ruleId === CLERK_ANOMALY_TYPES.DEPOSIT_REFUND);
    expect(deposit).toHaveLength(1);
  });

  it("treats a non-deposit refund as a room-rent refund", () => {
    const { flaggedAnomalies } = detectClerkAnomalies({
      refunds: [mkRefund({ amount: 100.02, remarks: "customer satisfaction" })],
    });

    const deposit = flaggedAnomalies.filter((f) => f.ruleId === CLERK_ANOMALY_TYPES.DEPOSIT_REFUND);
    const roomRent = flaggedAnomalies.filter((f) => f.ruleId === CLERK_ANOMALY_TYPES.ROOM_RENT_REFUND);
    expect(deposit).toHaveLength(0);
    expect(roomRent).toHaveLength(1);
  });

  it("builds per-clerk deposit vs room-rent risk totals", () => {
    const { clerkRiskScores } = detectClerkAnomalies({
      refunds: [
        mkRefund({ amount: 100, remarks: "deposit refund" }),
        mkRefund({ amount: 100, date: "2026-07-05", remarks: "deposit refund" }),
        mkRefund({ amount: 84 }),
      ],
    });

    const bella = clerkRiskScores.find((s) => s.username === "bella");
    expect(bella.totalDepositRefunds).toBe(200);
    expect(bella.depositRefundCount).toBe(2);
    expect(bella.totalRoomRentRefunds).toBe(84);
    expect(bella.roomRentRefundCount).toBe(1);
  });

  it("ignores refunds with no username in the risk score, but still flags them", () => {
    const { flaggedAnomalies, clerkRiskScores } = detectClerkAnomalies({
      refunds: [mkRefund({ amount: 84, username: "" })],
    });

    expect(flaggedAnomalies.some((f) => f.ruleId === CLERK_ANOMALY_TYPES.ROOM_RENT_REFUND)).toBe(true);
    expect(clerkRiskScores.some((s) => s.username === "")).toBe(false);
  });
});
