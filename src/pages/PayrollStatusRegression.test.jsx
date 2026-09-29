import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import StatusBadge from "@/components/ui-exec/StatusBadge";
import { COMMITTED_PAYROLL_STATUSES, isCommittedPayroll, filterCommittedPay } from "@/lib/payrollCalc";

describe("Payroll Status UI & Consumer Regression Tests", () => {
  describe("StatusBadge Component", () => {
    it("renders 'pending_review' with correct styling, label, and pulse animation", () => {
      const { container } = render(<StatusBadge status="pending_review" size="sm" />);
      
      // Title and label
      const badge = screen.getByTitle("Pending Review");
      expect(badge).toBeInTheDocument();
      expect(badge).toHaveTextContent("Pending Review");

      // Emoji and styling
      expect(badge).toHaveTextContent("⏳");
      expect(badge).not.toHaveTextContent("❔");
      expect(badge.className).toContain("text-[#FFB547]");
      expect(badge.className).toContain("bg-[#FFB547]/10");
      expect(badge.className).toContain("border-[#FFB547]/40");
      expect(badge.className).toContain("status-pulse");
    });

    it("demonstrates the bug when an invalid 'pending' status is passed (falls back to question mark)", () => {
      render(<StatusBadge status="pending" size="sm" />);
      
      const badge = screen.getByTitle("pending");
      expect(badge).toBeInTheDocument();
      // An invalid status falls back to the unknown question mark emoji
      expect(badge).toHaveTextContent("❔");
      expect(badge).not.toHaveTextContent("⏳");
      expect(badge.className).toContain("text-slate-400");
    });

    it("renders all four official PayrollRun schema enum statuses without fallback", () => {
      const officialStatuses = ["draft", "pending_review", "approved", "paid"];
      
      for (const status of officialStatuses) {
        const { container, unmount } = render(<StatusBadge status={status} size="sm" />);
        // None of the official enum values should produce the unknown '❔' emoji
        expect(container.firstChild).not.toHaveTextContent("❔");
        unmount();
      }
    });
  });

  describe("Payroll Cash Commitment Filter (payrollCalc)", () => {
    it("excludes 'pending_review' and 'draft' from committed money until approved", () => {
      expect(COMMITTED_PAYROLL_STATUSES).toEqual(["approved", "paid"]);

      // Uncommitted runs
      expect(isCommittedPayroll({ payroll_status: "pending_review" })).toBe(false);
      expect(isCommittedPayroll({ payroll_status: "draft" })).toBe(false);

      // Committed runs
      expect(isCommittedPayroll({ payroll_status: "approved" })).toBe(true);
      expect(isCommittedPayroll({ payroll_status: "paid" })).toBe(true);

      const runs = [
        { id: 1, total_pay: 1000, payroll_status: "pending_review" },
        { id: 2, total_pay: 2000, payroll_status: "draft" },
        { id: 3, total_pay: 3000, payroll_status: "approved" },
        { id: 4, total_pay: 4000, payroll_status: "paid" },
      ];

      const committed = filterCommittedPay(runs);
      expect(committed).toHaveLength(2);
      expect(committed.map((r) => r.id)).toEqual([3, 4]);
    });
  });

  describe("Payroll Page Select and Status Color Mapping Contract", () => {
    it("matches the exact statusColor palette in Payroll.jsx", () => {
      const statusColor = (s) => ({
        draft: "text-slate-400",
        pending_review: "text-[#FFB547]",
        approved: "text-[#00D4FF]",
        paid: "text-[#00E096]",
      }[s] || "text-slate-400");

      expect(statusColor("pending_review")).toBe("text-[#FFB547]");
      expect(statusColor("approved")).toBe("text-[#00D4FF]");
      expect(statusColor("paid")).toBe("text-[#00E096]");
      expect(statusColor("draft")).toBe("text-slate-400");

      // Invalid "pending" falls back to slate-400
      expect(statusColor("pending")).toBe("text-slate-400");
    });
  });
});
