import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

// Mock dependencies
const mockCanAccessProperty = vi.fn((id) => true);
let mockProperties = [];
let mockUploads = [];

vi.mock("@/lib/AuthContext", () => ({
  useAuth: () => ({
    user: { role: "owner", email: "test@example.com" },
    canAccessProperty: mockCanAccessProperty,
  }),
}));

vi.mock("@/lib/useHotelData", () => ({
  useProperties: () => ({ data: mockProperties, isLoading: false }),
  useUploads: () => ({ data: mockUploads, isLoading: false, refetch: vi.fn() }),
}));

const mockUploadedReportCreate = vi.fn().mockResolvedValue({ id: "rep-1" });
const mockUploadedReportFilter = vi.fn().mockReturnValue({ get: vi.fn().mockResolvedValue([]) });
const mockUploadFile = vi.fn().mockResolvedValue({ file_url: "blob://test" });
const mockScanReport = vi.fn();
const mockImportReport = vi.fn();
const mockRebuildDailyAggregates = vi.fn().mockResolvedValue(undefined);

vi.mock("@/api/base44Client", () => ({
  db: {
    DailyLedger: { filter: vi.fn().mockReturnValue({ get: vi.fn().mockResolvedValue([]) }) },
    MonthlyCityLedger: { filter: vi.fn().mockReturnValue({ get: vi.fn().mockResolvedValue([]) }) },
    ManagerFlash: { filter: vi.fn().mockReturnValue({ get: vi.fn().mockResolvedValue([]) }) },
    RollbackLedger: { filter: vi.fn().mockReturnValue({ get: vi.fn().mockResolvedValue([]) }) },
    ImportSession: { filter: vi.fn().mockReturnValue({ get: vi.fn().mockResolvedValue([]) }) },
    entities: {
      UploadedReport: {
        filter: (...args) => mockUploadedReportFilter(...args),
        create: (...args) => mockUploadedReportCreate(...args),
      },
    },
    integrations: {
      Core: {
        UploadFile: (...args) => mockUploadFile(...args),
      },
    },
  },
  listImportSessions: vi.fn().mockResolvedValue([]),
  rollbackImportSession: vi.fn().mockResolvedValue({ success: true, deleted: 0 }),
}));

vi.mock("@/lib/reportParsers", () => ({
  REPORT_TYPES: [
    { key: "daily_ledger", label: "Daily Ledger", name: "Daily Ledger" },
    { key: "occupancy", label: "Occupancy Summary", name: "Occupancy Summary" },
  ],
  scanReport: (...args) => mockScanReport(...args),
  importReport: (...args) => mockImportReport(...args),
}));

vi.mock("@/lib/importReset", () => ({
  clearAllImportedData: vi.fn(),
}));

vi.mock("@/lib/actionTimeout", () => ({
  compensateLateCreate: vi.fn(),
  withActionTimeout: vi.fn((fn) => fn),
}));

vi.mock("@/lib/securityUtils", () => ({
  getCsrfToken: () => "csrf-token",
  validateCsrfToken: () => true,
  rotateCsrfToken: vi.fn(),
  sensitiveActionRateLimiter: { check: () => ({ allowed: true, retryAfter: 0 }) },
  sha256File: vi.fn().mockResolvedValue("mock-sha256"),
}));

vi.mock("@/lib/dailyAggregates", () => ({
  rebuildDailyAggregates: (...args) => mockRebuildDailyAggregates(...args),
}));

vi.mock("@/lib/query-client", () => ({
  queryClientInstance: { invalidateQueries: vi.fn() },
}));

vi.mock("@/lib/uploadGuard", () => ({
  inspectUploadFile: vi.fn().mockResolvedValue({ ok: true, safe: true, reason: "" }),
}));

vi.mock("@/components/BusinessMigrationCard", () => ({
  default: () => null,
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: () => ({
    getVirtualItems: () => [],
    getTotalSize: () => 0,
    scrollToOffset: vi.fn(),
  }),
}));

vi.mock("@/components/ui/ResponsiveSelect", () => ({
  default: ({ value, onValueChange, onChange, options, placeholder }) => (
    <select
      data-testid="property-select"
      value={value}
      onChange={(e) => (onValueChange || onChange)?.(e.target.value)}
    >
      <option value="">{placeholder || "Select"}</option>
      {options?.map(([v, l]) => (
        <option key={v} value={v}>
          {l}
        </option>
      ))}
    </select>
  ),
}));

import Import from "./Import";

describe("Import.jsx property auto-selection and upload guards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCanAccessProperty.mockImplementation(() => true);
    mockUploadedReportCreate.mockResolvedValue({ id: "rep-1" });
    mockUploadedReportFilter.mockReturnValue({ get: vi.fn().mockResolvedValue([]) });
    mockUploadFile.mockResolvedValue({ file_url: "blob://test" });
    mockRebuildDailyAggregates.mockResolvedValue(undefined);
    mockScanReport.mockResolvedValue({
      type: "daily_ledger",
      totalRows: 10,
      sections: [{ name: "Daily Ledger", rows: 10 }],
      validation: { ok: true, findings: [] },
      meta: { propertyId: "prop-middleboro", propertyName: "Red Roof Middleboro" },
    });
    mockImportReport.mockResolvedValue({ count: 10, excluded: 0, importId: "imp-1" });
    window.alert = vi.fn();
  });

  it("auto-selects propertyId when exactly 1 accessible property is available", () => {
    mockProperties = [
      { id: "prop-middleboro", name: "Red Roof Middleboro" },
    ];

    render(<Import />);

    const select = /** @type {HTMLSelectElement} */ (screen.getByTestId("property-select"));
    expect(select.value).toBe("prop-middleboro");
    expect(screen.getByText(/Drop multiple/i)).toBeDefined();
  });

  it("does NOT auto-select propertyId when multiple accessible properties are available", () => {
    mockProperties = [
      { id: "prop-1", name: "Hotel Alpha" },
      { id: "prop-2", name: "Hotel Beta" },
    ];

    render(<Import />);

    const select = /** @type {HTMLSelectElement} */ (screen.getByTestId("property-select"));
    expect(select.value).toBe("");
    expect(screen.getByText("Select a property before importing reports.")).toBeDefined();
  });

  it("blocks file drop when no property is selected", () => {
    mockProperties = [
      { id: "prop-1", name: "Hotel Alpha" },
      { id: "prop-2", name: "Hotel Beta" },
    ];

    render(<Import />);

    const dropZone = screen.getByText("Select a property before importing reports.").closest("label");
    expect(dropZone).toBeDefined();

    const dummyFile = new File(["dummy content"], "test.csv", { type: "text/csv" });
    if (dropZone) {
      fireEvent.drop(dropZone, {
        dataTransfer: { files: [dummyFile] },
      });
    }

    expect(window.alert).toHaveBeenCalledWith("Select a property before importing reports.");
  });

  it("disables file input when no property is selected", () => {
    mockProperties = [
      { id: "prop-1", name: "Hotel Alpha" },
      { id: "prop-2", name: "Hotel Beta" },
    ];

    const { container } = render(<Import />);
    const fileInput = /** @type {HTMLInputElement | null} */ (container.querySelector('input[type="file"]'));
    expect(fileInput?.disabled).toBe(true);
  });

  it("enables file input when a single property is auto-selected", () => {
    mockProperties = [
      { id: "prop-middleboro", name: "Red Roof Middleboro" },
    ];

    const { container } = render(<Import />);
    const fileInput = /** @type {HTMLInputElement | null} */ (container.querySelector('input[type="file"]'));
    expect(fileInput?.disabled).toBe(false);
  });

  describe("Flow Tests: Stale Property Snapshot Recovery and Authorization Ladder", () => {
    it("Test 1 (Real Screenshot Flow): recovers stuck stale-property queue item to canonical property on retry without re-upload", async () => {
      // Setup initial state: file scanned under a property that subsequently became stale
      mockProperties = [
        { id: "prop-stale", name: "Old Stale Property" },
      ];
      mockCanAccessProperty.mockImplementation((id) => id === "prop-stale");
      mockScanReport.mockResolvedValueOnce({
        type: "daily_ledger",
        totalRows: 10,
        sections: [{ name: "Daily Ledger", rows: 10 }],
        validation: { ok: true, findings: [] },
        meta: { propertyId: "prop-stale", propertyName: "Old Stale Property" },
      });
      // Initial import fails (reproducing failure state)
      mockImportReport.mockRejectedValueOnce(new Error("Initial scan failure"));

      const { container, rerender } = render(<Import />);

      // Drop file into queue
      const dummyFile = new File(["col1,col2\n1,2"], "test-report.csv", { type: "text/csv" });
      const fileInput = container.querySelector('input[type="file"]');
      expect(fileInput).toBeDefined();
      fireEvent.change(fileInput, { target: { files: [dummyFile] } });

      // Wait for file scan to finish
      await waitFor(() => {
        expect(screen.getByText("test-report.csv")).toBeDefined();
      });

      // Click Import to trigger the error state
      const importBtn = screen.getByRole("button", { name: /^import$/i });
      fireEvent.click(importBtn);

      // Verify item entered error state with Retry button
      await waitFor(() => {
        expect(screen.getByRole("button", { name: /^retry$/i })).toBeDefined();
      });

      // Now simulate property update to canonical property: only prop-middleboro is accessible
      mockProperties = [
        { id: "prop-middleboro", name: "Red Roof Middleboro" },
      ];
      mockCanAccessProperty.mockImplementation((id) => id === "prop-middleboro");
      mockImportReport.mockResolvedValueOnce({ count: 10, excluded: 0, importId: "imp-123" });

      // Rerender with updated property access
      rerender(<Import />);

      // Click Retry on the stuck item
      const retryBtn = screen.getByRole("button", { name: /^retry$/i });
      fireEvent.click(retryBtn);

      // Verify canonical property assignment and successful import
      await waitFor(() => {
        expect(mockImportReport).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            propertyId: "prop-middleboro",
            propertyName: "Red Roof Middleboro",
          })
        );
      });

      expect(mockUploadedReportCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          property_id: "prop-middleboro",
          property_name: "Red Roof Middleboro",
        })
      );

      expect(mockRebuildDailyAggregates).toHaveBeenCalledWith({
        propertyId: "prop-middleboro",
      });

      // Assert row updates to success/done without error loop
      await waitFor(() => {
        expect(screen.getByText(/10 rows/i)).toBeDefined();
      });
      expect(screen.queryByText(/no longer accessible or authorized/i)).toBeNull();
    });

    it("Test 2 (Multi-Property Negative Flow): fails closed and prompts user selection when multiple properties exist (0 rows written)", async () => {
      // Initially drop file under a temporary property
      mockScanReport.mockResolvedValueOnce({
        type: "daily_ledger",
        totalRows: 10,
        sections: [{ name: "Daily Ledger", rows: 10 }],
        validation: { ok: true, findings: [] },
        meta: { propertyId: "prop-stale", propertyName: "Old Stale" },
      });
      mockImportReport.mockRejectedValueOnce(new Error("Initial error"));

      mockProperties = [{ id: "prop-stale", name: "Old Stale" }];
      mockCanAccessProperty.mockImplementation((id) => id === "prop-stale");

      const { container, rerender } = render(<Import />);
      const dummyFile = new File(["col1,col2\n1,2"], "test-multi.csv", { type: "text/csv" });
      const fileInput = container.querySelector('input[type="file"]');
      fireEvent.change(fileInput, { target: { files: [dummyFile] } });

      await waitFor(() => {
        expect(screen.getByText("test-multi.csv")).toBeDefined();
      });

      // Trigger initial error
      const importBtn = screen.getByRole("button", { name: /^import$/i });
      fireEvent.click(importBtn);

      await waitFor(() => {
        expect(screen.getByRole("button", { name: /^retry$/i })).toBeDefined();
      });

      // Now switch to multi-property environment with NO property selected in dropdown
      mockProperties = [
        { id: "prop-alpha", name: "Hotel Alpha" },
        { id: "prop-beta", name: "Hotel Beta" },
      ];
      mockCanAccessProperty.mockImplementation(() => true);
      mockImportReport.mockClear();
      mockUploadedReportCreate.mockClear();

      rerender(<Import />);

      // Click Retry on the failed file
      const retryBtn = screen.getByRole("button", { name: /^retry$/i });
      fireEvent.click(retryBtn);

      // Assert fail-closed: 0 calls to importReport, 0 calls to UploadedReport.create (0 rows written)
      await waitFor(() => {
        expect(screen.getByText(/Multiple accessible properties available/i)).toBeDefined();
      });
      expect(mockImportReport).not.toHaveBeenCalled();
      expect(mockUploadedReportCreate).not.toHaveBeenCalled();
    });

    it("Test 3 (Revoked Property Attack Flow): prevents cross-property pollution when property access is revoked", async () => {
      // Step A: Queue item has snapshot for prop-revoked
      mockProperties = [{ id: "prop-revoked", name: "Revoked Property" }];
      mockCanAccessProperty.mockImplementation((id) => id === "prop-revoked");
      mockScanReport.mockResolvedValueOnce({
        type: "daily_ledger",
        totalRows: 10,
        meta: { propertyId: "prop-revoked", propertyName: "Revoked Property" },
      });
      mockImportReport.mockRejectedValueOnce(new Error("Initial failure"));

      const { container, rerender } = render(<Import />);
      const dummyFile = new File(["col1,col2\n1,2"], "test-attack.csv", { type: "text/csv" });
      const fileInput = container.querySelector('input[type="file"]');
      fireEvent.change(fileInput, { target: { files: [dummyFile] } });

      await waitFor(() => {
        expect(screen.getByText("test-attack.csv")).toBeDefined();
      });

      // Trigger error state
      fireEvent.click(screen.getByRole("button", { name: /^import$/i }));
      await waitFor(() => {
        expect(screen.getByRole("button", { name: /^retry$/i })).toBeDefined();
      });

      // Access to prop-revoked is REVOKED
      // Sub-case A: 2 other properties exist, none selected -> fail closed
      mockProperties = [
        { id: "prop-other-1", name: "Other 1" },
        { id: "prop-other-2", name: "Other 2" },
      ];
      mockCanAccessProperty.mockImplementation((id) => id !== "prop-revoked");
      mockImportReport.mockClear();
      mockUploadedReportCreate.mockClear();

      rerender(<Import />);

      fireEvent.click(screen.getByRole("button", { name: /^retry$/i }));

      // Must fail closed, never touch prop-revoked or write data
      await waitFor(() => {
        expect(screen.getByText(/Multiple accessible properties available/i)).toBeDefined();
      });
      expect(mockImportReport).not.toHaveBeenCalled();
      expect(mockUploadedReportCreate).not.toHaveBeenCalled();

      // Sub-case B: Only 1 legitimate property exists (prop-canonical-b)
      mockProperties = [
        { id: "prop-canonical-b", name: "Canonical B" },
      ];
      mockCanAccessProperty.mockImplementation((id) => id === "prop-canonical-b");
      mockImportReport.mockResolvedValueOnce({ count: 10, excluded: 0, importId: "imp-safe" });

      rerender(<Import />);

      // Retry now safely reassigns to canonical property
      fireEvent.click(screen.getByRole("button", { name: /^retry$/i }));

      await waitFor(() => {
        expect(mockImportReport).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            propertyId: "prop-canonical-b",
          })
        );
      });
      expect(mockUploadedReportCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          property_id: "prop-canonical-b",
        })
      );
      // Verify prop-revoked was NEVER used
      expect(mockImportReport).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ propertyId: "prop-revoked" })
      );
    });
  });
});
