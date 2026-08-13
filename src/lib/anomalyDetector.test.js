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
  it("flags an exact $100 refund as a deposit refund (LOW severity)", () => {
    const { flaggedAnomalies } = detectClerkAnomalies({
      refunds: [mkRefund({ amount: 100 })],
    });

    const deposit = flaggedAnomalies.filter((f) => f.ruleId === CLERK_ANOMALY_TYPES.DEPOSIT_REFUND);
    expect(deposit).toHaveLength(1);
    expect(deposit[0].severity).toBe("LOW");
    expect(deposit[0].amount).toBe(100);
  });

  it("never flags a $100 amount as a room-rent refund at the same time", () => {
    const { flaggedAnomalies } = detectClerkAnomalies({
      refunds: [mkRefund({ amount: 100 })],
    });

    const roomRent = flaggedAnomalies.filter((f) => f.ruleId === CLERK_ANOMALY_TYPES.ROOM_RENT_REFUND);
    expect(roomRent).toHaveLength(0);
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

  it("respects the deposit tolerance (100.009 ≈ $100)", () => {
    const { flaggedAnomalies } = detectClerkAnomalies({
      refunds: [mkRefund({ amount: 100.009 })],
    });

    const deposit = flaggedAnomalies.filter((f) => f.ruleId === CLERK_ANOMALY_TYPES.DEPOSIT_REFUND);
    expect(deposit).toHaveLength(1);
  });

  it("treats $100 ± beyond tolerance as a room-rent refund", () => {
    const { flaggedAnomalies } = detectClerkAnomalies({
      refunds: [mkRefund({ amount: 100.02 })],
    });

    const deposit = flaggedAnomalies.filter((f) => f.ruleId === CLERK_ANOMALY_TYPES.DEPOSIT_REFUND);
    const roomRent = flaggedAnomalies.filter((f) => f.ruleId === CLERK_ANOMALY_TYPES.ROOM_RENT_REFUND);
    expect(deposit).toHaveLength(0);
    expect(roomRent).toHaveLength(1);
  });

  it("builds per-clerk deposit vs room-rent risk totals", () => {
    const { clerkRiskScores } = detectClerkAnomalies({
      refunds: [
        mkRefund({ amount: 100 }),
        mkRefund({ amount: 100, date: "2026-07-05" }),
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