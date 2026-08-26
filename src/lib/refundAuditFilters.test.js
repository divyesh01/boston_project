import { describe, expect, it } from "vitest";
import { filterAuditRefunds, refundFilterTotal } from "./refundAuditFilters";

const rows = [
  { date: "2026-04-25", roomNumber: "101", amount: 100, paymentTypeRefunded: "CARD", remarks: "Deposit refund" },
  { date: "2026-04-26", roomNumber: "102", amount: 125, paymentTypeRefunded: "CASH", remarks: "Customer satisfaction" },
  { date: "2026-04-27", roomNumber: "103", amount: 100, paymentTypeRefunded: "VISA", remarks: "S" },
];

describe("clerk audit refund filters", () => {
  it("selects only cash room-rent refunds", () => {
    const result = filterAuditRefunds(rows, { classification: "CASH_ROOM_RENT" });
    expect(result).toHaveLength(1);
    expect(result[0].roomNumber).toBe("102");
  });

  it("combines date, room, evidence, and amount filters", () => {
    const result = filterAuditRefunds(rows, { from: "2026-04-26", to: "2026-04-26", room: "102", evidence: "satisfaction", minAmount: "100", maxAmount: "130" });
    expect(result).toHaveLength(1);
    expect(refundFilterTotal(result)).toBe(125);
  });

  it("does not hide an unclear exact $100 when deposit returns are hidden", () => {
    const result = filterAuditRefunds(rows, { hideDepositReturns: true });
    expect(result.map((row) => row.roomNumber)).toEqual(["102", "103"]);
  });
});
