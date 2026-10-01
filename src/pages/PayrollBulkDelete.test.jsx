import { describe, it, expect, vi, beforeEach } from "vitest";
import { money2 } from "@/lib/hotel";

describe("Payroll Bulk Delete & Selection Logic", () => {
  const sampleRuns = [
    { id: "run-1", employee_name: "Moin", total_pay: 3000, payroll_status: "paid" },
    { id: "run-2", employee_name: "Navin", total_pay: 1800, payroll_status: "paid" },
    { id: "run-3", employee_name: "Alice", total_pay: 2200, payroll_status: "draft" },
    { id: "run-4", employee_name: "Bob", total_pay: 1500, payroll_status: "pending_review" },
    { id: "run-5", employee_name: "Charlie", total_pay: 2500, payroll_status: "approved" },
  ];

  describe("Selection State Helpers", () => {
    it("toggles single run selection correctly", () => {
      let selected = [];
      const toggle = (id) => {
        selected = selected.includes(id)
          ? selected.filter((item) => item !== id)
          : [...selected, id];
      };

      toggle("run-1");
      expect(selected).toEqual(["run-1"]);

      toggle("run-2");
      expect(selected).toEqual(["run-1", "run-2"]);

      toggle("run-1");
      expect(selected).toEqual(["run-2"]);
    });

    it("toggles select-all across all visible runs", () => {
      let selected = [];
      const isAllSelected = () => sampleRuns.length > 0 && selected.length === sampleRuns.length;
      const toggleAll = () => {
        if (isAllSelected()) {
          selected = [];
        } else {
          selected = sampleRuns.map((r) => r.id);
        }
      };

      // Initially empty -> Select All
      toggleAll();
      expect(selected).toEqual(["run-1", "run-2", "run-3", "run-4", "run-5"]);
      expect(isAllSelected()).toBe(true);

      // All selected -> Deselect All
      toggleAll();
      expect(selected).toEqual([]);
      expect(isAllSelected()).toBe(false);
    });

    it("filters out stale selected IDs that no longer exist in payroll list", () => {
      const selected = ["run-1", "deleted-run-99"];
      const valid = selected.filter((id) => sampleRuns.some((r) => r.id === id));
      expect(valid).toEqual(["run-1"]);
    });
  });

  describe("Financial Calculation for Bulk Selection", () => {
    it("computes total pay and committed pay accurately", () => {
      const selectedIds = ["run-1", "run-3", "run-5"]; // paid: 3000, draft: 2200, approved: 2500
      const selectedRuns = sampleRuns.filter((r) => selectedIds.includes(r.id));

      const totalPay = selectedRuns.reduce((sum, r) => sum + (Number(r.total_pay) || 0), 0);
      expect(totalPay).toBe(7700);

      const committed = selectedRuns.filter(
        (r) => r.payroll_status === "approved" || r.payroll_status === "paid"
      );
      expect(committed).toHaveLength(2); // run-1 (paid), run-5 (approved)

      const committedTotal = committed.reduce((sum, r) => sum + (Number(r.total_pay) || 0), 0);
      expect(committedTotal).toBe(5500);
    });
  });

  describe("Destructive Action Guard & Bulk Deletion Contract", () => {
    let mockBulkDelete;
    let mockInvalidateMoney;
    let mockToastSuccess;
    let mockToastError;
    let mockGateComplete;

    beforeEach(() => {
      mockBulkDelete = vi.fn().mockResolvedValue({ success: true });
      mockInvalidateMoney = vi.fn();
      mockToastSuccess = vi.fn();
      mockToastError = vi.fn();
      mockGateComplete = vi.fn();
    });

    const executeBulkDelete = async ({
      selectedIds,
      runs,
      guardDestructiveAction,
    }) => {
      const validSelectedIds = selectedIds.filter((id) => runs.some((r) => r.id === id));
      const selectedRuns = runs.filter((p) => validSelectedIds.includes(p.id));
      if (!selectedRuns.length) return;

      const totalSelectedPay = selectedRuns.reduce((sum, r) => sum + (Number(r?.total_pay) || 0), 0);
      const committedRuns = selectedRuns.filter(
        (r) => r?.payroll_status === "approved" || r?.payroll_status === "paid"
      );
      const committedTotal = committedRuns.reduce((sum, r) => sum + (Number(r?.total_pay) || 0), 0);

      const lines = [
        `${selectedRuns.length} payroll run(s) totaling ${money2(totalSelectedPay)}.`,
        committedRuns.length > 0
          ? `This includes ${committedRuns.length} approved/paid run(s) totaling ${money2(committedTotal)}. Deleting them removes pay already committed and will increase reported Money Kept by ${money2(committedTotal)}.`
          : "None of these runs are approved or paid, so Money Kept will not change.",
      ];

      const gate = guardDestructiveAction({
        title: `Delete ${selectedRuns.length} selected payroll run${selectedRuns.length === 1 ? "" : "s"}?`,
        lines,
      });

      if (!gate.ok) {
        if (gate.message) mockToastError(gate.message);
        return;
      }

      try {
        await mockBulkDelete(validSelectedIds);
        gate.complete();
        mockInvalidateMoney();
        mockToastSuccess(`Deleted ${selectedRuns.length} payroll run(s).`);
      } catch (e) {
        mockToastError(`Could not delete selected payroll runs: ${e?.message || e}. Nothing was removed.`);
      }
    };

    it("aborts and does not call bulkDelete if the user cancels confirmation", async () => {
      const mockGuard = vi.fn().mockReturnValue({ ok: false, reason: "cancelled", message: "" });

      await executeBulkDelete({
        selectedIds: ["run-1", "run-2"],
        runs: sampleRuns,
        guardDestructiveAction: mockGuard,
      });

      expect(mockGuard).toHaveBeenCalledTimes(1);
      expect(mockGuard.mock.calls[0][0].title).toBe("Delete 2 selected payroll runs?");
      expect(mockBulkDelete).not.toHaveBeenCalled();
      expect(mockInvalidateMoney).not.toHaveBeenCalled();
    });

    it("warns about committed pay and calls bulkDelete on user confirmation", async () => {
      const mockGuard = vi.fn().mockReturnValue({
        ok: true,
        reason: "allowed",
        message: "",
        complete: mockGateComplete,
      });

      await executeBulkDelete({
        selectedIds: ["run-1", "run-2", "run-3"], // 2 paid, 1 draft
        runs: sampleRuns,
        guardDestructiveAction: mockGuard,
      });

      expect(mockGuard).toHaveBeenCalledTimes(1);
      const callArgs = mockGuard.mock.calls[0][0];
      expect(callArgs.title).toBe("Delete 3 selected payroll runs?");
      expect(callArgs.lines[0]).toContain("3 payroll run(s) totaling $7,000.00");
      expect(callArgs.lines[1]).toContain("This includes 2 approved/paid run(s) totaling $4,800.00");

      expect(mockBulkDelete).toHaveBeenCalledWith(["run-1", "run-2", "run-3"]);
      expect(mockGateComplete).toHaveBeenCalled();
      expect(mockInvalidateMoney).toHaveBeenCalled();
      expect(mockToastSuccess).toHaveBeenCalledWith("Deleted 3 payroll run(s).");
    });
  });
});
