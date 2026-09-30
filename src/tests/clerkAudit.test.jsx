import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import ClerkAudit from "@/components/dashboard/ClerkAudit";

describe("ClerkAudit Component (R07 Cash Due & Reconciliation)", () => {
  it("sums all cash payment rows and separates electronic payments", () => {
    const records = [
      { record_type: "payment", date: "2026-09-01", payment_type: "CASH", net_today: 150.50 },
      { record_type: "payment", date: "2026-09-01", payment_type: "CASH", net_today: 100.25 },
      { record_type: "payment", date: "2026-09-01", payment_type: "VISA", net_today: 500.00 },
      { record_type: "drop", clerk_name: "Alice", amount: 250.75, shift_date: "2026-09-01" },
    ];

    render(<ClerkAudit records={records} />);

    // Expected cash drop should be 150.50 + 100.25 = 250.75
    // Actual cash drop should be 250.75
    // Status should be Matched
    expect(screen.getByText("Matched")).toBeInTheDocument();
    expect(screen.getAllByText("$250.75").length).toBeGreaterThanOrEqual(1); // Expected & Actual
    expect(screen.getByText("$500.00")).toBeInTheDocument(); // Electronic payments
    expect(screen.getByText("$750.75")).toBeInTheDocument(); // Total shift activity
  });

  it("faithfully preserves and reports cash shortage without dropping negative discrepancy", () => {
    const records = [
      { record_type: "payment", date: "2026-09-01", payment_type: "CASH", net_today: 300.00 },
      { record_type: "drop", clerk_name: "Bob", amount: 250.00, shift_date: "2026-09-01" },
    ];

    render(<ClerkAudit records={records} />);

    // Expected: 300, Actual: 250 -> Short by $50.00
    expect(screen.getByText("Short")).toBeInTheDocument();
    expect(screen.getByText(/Cash Variance:\s*-\s*\$50\.00/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Short by\s*\$50\.00/i).length).toBeGreaterThanOrEqual(1);
  });

  it("faithfully preserves and reports cash overage", () => {
    const records = [
      { record_type: "payment", date: "2026-09-01", payment_type: "CASH", net_today: 200.00 },
      { record_type: "drop", clerk_name: "Charlie", amount: 240.00, shift_date: "2026-09-01" },
    ];

    render(<ClerkAudit records={records} />);

    // Expected: 200, Actual: 240 -> Over by $40.00
    expect(screen.getByText("Over")).toBeInTheDocument();
    expect(screen.getByText(/Cash Variance:\s*\+\s*\$40\.00/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Over by\s*\$40\.00/i).length).toBeGreaterThanOrEqual(1);
  });

  it("flags sub-dollar variances (e.g. 50 cents)", () => {
    const records = [
      { record_type: "payment", date: "2026-09-01", payment_type: "CASH", net_today: 100.50 },
      { record_type: "drop", clerk_name: "Dave", amount: 100.00, shift_date: "2026-09-01" },
    ];

    render(<ClerkAudit records={records} />);

    // Variance: 0.50 short
    expect(screen.getByText("Short")).toBeInTheDocument();
    expect(screen.getByText(/Cash Variance:\s*-\s*\$0\.50/i)).toBeInTheDocument();
  });
});
