import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import React from "react";
import { destructiveActionRateLimiter } from "@/lib/rateLimiters";

// Mock dependencies for Import component
const mockCanAccessProperty = vi.fn((id) => true);
let mockProperties = [];
let mockUploads = [];
let mockIncompleteSessions = [];

vi.mock("@/lib/AuthContext", () => ({
  useAuth: () => ({
    user: { role: "owner", email: "owner@test.local" },
    canAccessProperty: mockCanAccessProperty,
  }),
}));

vi.mock("@/lib/useHotelData", () => ({
  useProperties: () => ({ data: mockProperties, isLoading: false }),
  useUploads: () => ({ data: mockUploads, isLoading: false, refetch: vi.fn() }),
}));

const mockUploadedReportCreate = vi.fn().mockResolvedValue({ id: "upl-1" });
const mockUploadedReportFilter = vi.fn().mockReturnValue({ get: vi.fn().mockResolvedValue([]) });
const mockUploadFile = vi.fn().mockResolvedValue({ file_url: "blob://test" });
const mockScanReport = vi.fn();
const mockImportReport = vi.fn();
const mockRollbackImportSession = vi.fn().mockResolvedValue({ success: true, deleted: 5 });
const mockListImportSessions = vi.fn().mockImplementation(() => Promise.resolve(mockIncompleteSessions));

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
  listImportSessions: (...args) => mockListImportSessions(...args),
  rollbackImportSession: (...args) => mockRollbackImportSession(...args),
}));

vi.mock("@/lib/reportParsers", () => ({
  REPORT_TYPES: [
    { key: "occupancy", label: "Occupancy Summary", name: "Occupancy Summary" },
    { key: "source", label: "Source Summary", name: "Source Summary" },
  ],
  scanReport: (...args) => mockScanReport(...args),
  importReport: (...args) => mockImportReport(...args),
}));

vi.mock("@/lib/importReset", () => ({
  clearAllImportedData: vi.fn().mockResolvedValue({ deletedRows: 10, sessions: 1, ledgerRows: 2 }),
}));

vi.mock("@/lib/actionTimeout", () => ({
  compensateLateCreate: vi.fn(),
  withActionTimeout: vi.fn((p) => p),
}));

vi.mock("@/lib/securityUtils", () => ({
  getCsrfToken: () => "mock-csrf-token",
  validateCsrfToken: () => true,
  rotateCsrfToken: vi.fn(),
  sensitiveActionRateLimiter: { check: () => ({ allowed: true, retryAfter: 0 }), reset: vi.fn() },
  sha256File: vi.fn().mockImplementation(async (f) => `sha-${f.name}`),
}));

vi.mock("@/lib/dailyAggregates", () => ({
  rebuildDailyAggregates: vi.fn().mockResolvedValue(undefined),
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

// Mock executeBulkImport, deleteBundleOnServer, and replacement flow helpers
const mockExecuteBulkImport = vi.fn();
const mockDeleteBundleOnServer = vi.fn().mockResolvedValue({ ok: true });
const mockFetchPendingRawArchives = vi.fn().mockResolvedValue([]);
const mockDownloadRawArchiveFromServer = vi.fn();
const mockFetchActiveManifests = vi.fn().mockResolvedValue([]);
const mockFetchManifestById = vi.fn();

vi.mock("@/lib/bulkImportPipeline", async (importOriginal) => {
  const actual = /** @type {Record<string, any>} */ (await importOriginal());
  return {
    ...actual,
    executeBulkImport: (...args) => mockExecuteBulkImport(...args),
    deleteBundleOnServer: (...args) => mockDeleteBundleOnServer(...args),
    fetchPendingRawArchives: (...args) => mockFetchPendingRawArchives(...args),
    downloadRawArchiveFromServer: (...args) => mockDownloadRawArchiveFromServer(...args),
    fetchActiveManifests: (...args) => mockFetchActiveManifests(...args),
    fetchManifestById: (...args) => mockFetchManifestById(...args),
  };
});

import Import from "./Import";

describe("Import <=18-File Batch & Regression Coverage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCanAccessProperty.mockImplementation(() => true);
    window.alert = vi.fn();
    window.confirm = vi.fn(() => true);
    mockProperties = [
      { id: "prop-boston", name: "Red Roof Boston" },
    ];
    mockIncompleteSessions = [];
    mockScanReport.mockResolvedValue({
      type: "occupancy",
      totalRows: 100,
      rowsToImport: Array(100).fill({}),
      sections: [{ name: "Occupancy", rows: 100 }],
      validation: { ok: true, findings: [] },
    });
    mockExecuteBulkImport.mockResolvedValue({
      ok: true,
      bulk: true,
      count: 100,
      excluded: 0,
      importId: "bulk-imp-1",
    });
    mockUploadedReportFilter.mockResolvedValue([]);
    mockFetchPendingRawArchives.mockResolvedValue([]);
    mockDownloadRawArchiveFromServer.mockReset();
    mockFetchActiveManifests.mockResolvedValue([]);
    mockFetchManifestById.mockReset();
  });

  it("allows a batch of 18 files without client throttle or budget block", async () => {
    const { container } = render(<Import />);

    // Create 18 CSV files
    const files = Array.from({ length: 18 }, (_, i) =>
      new File([`date,rooms\n2026-01-${String(i + 1).padStart(2, "0")},50`], `report_${i + 1}.csv`, { type: "text/csv" })
    );

    const input = container.querySelector('input[type="file"]');
    fireEvent.change(input, { target: { files } });

    // Wait for all 18 files to finish scanning and enter ready state
    await waitFor(() => {
      expect(screen.getByText("report_18.csv")).toBeDefined();
    }, { timeout: 10000 });

    await waitFor(() => {
      expect(screen.getAllByText("Ready to import")).toHaveLength(18);
    }, { timeout: 10000 });

    // Verify none of the 18 files are blocked by budget
    expect(screen.queryByText(/Exceeds write budget/i)).toBeNull();

    // Find and click "Import All"
    const importAllBtn = /** @type {HTMLButtonElement} */ (screen.getByRole("button", { name: /import all/i }));
    expect(importAllBtn.disabled).toBe(false);
    fireEvent.click(importAllBtn);

    // Wait for all 18 files to complete
    await waitFor(() => {
      expect(mockExecuteBulkImport).toHaveBeenCalledTimes(18);
    }, { timeout: 15000 });

    // Verify alert was never called for rate limit or budget block
    expect(window.alert).not.toHaveBeenCalledWith(expect.stringContaining("Too many requests"));
    expect(window.alert).not.toHaveBeenCalledWith(expect.stringContaining("80,000 writes"));
  });

  it("marks duplicates and prevents duplicate import unless force import is enabled", async () => {
    // Mock duplicate detection to return duplicate for duplicate.csv
    mockExecuteBulkImport.mockResolvedValueOnce({
      duplicate: true,
      reason: "Duplicate file — already imported. Use Force Import to re-import.",
    });

    const { container } = render(<Import />);
    const dupFile = new File(["col\n1"], "duplicate.csv", { type: "text/csv" });

    fireEvent.change(container.querySelector('input[type="file"]'), { target: { files: [dupFile] } });

    await waitFor(() => {
      expect(screen.getByText("duplicate.csv")).toBeDefined();
    });

    const importBtn = screen.getByRole("button", { name: /^import$/i });
    fireEvent.click(importBtn);

    await waitFor(() => {
      expect(screen.getByText(/already imported.*Force Import/i)).toBeDefined();
    });

    // Force import toggle
    const forceImportToggle = screen.getByRole("checkbox");
    fireEvent.click(forceImportToggle);

    // Now mock non-duplicate success on force import
    mockExecuteBulkImport.mockResolvedValueOnce({
      ok: true,
      bulk: true,
      count: 100,
      excluded: 0,
      importId: "bulk-imp-force",
    });

    const retryBtn = screen.getByRole("button", { name: /^retry$/i });
    fireEvent.click(retryBtn);

    await waitFor(() => {
      expect(screen.getByText(/100 rows/i)).toBeDefined();
    });
  });

  it("handles retry single and retry failed path when an error occurs", async () => {
    // First attempt fails
    mockExecuteBulkImport.mockRejectedValueOnce(new Error("Network glitch during upload"));

    const { container } = render(<Import />);
    const file = new File(["col\n1"], "flaky.csv", { type: "text/csv" });

    fireEvent.change(container.querySelector('input[type="file"]'), { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByText("flaky.csv")).toBeDefined();
    });

    const importBtn = screen.getByRole("button", { name: /^import$/i });
    fireEvent.click(importBtn);

    // Enters error status
    await waitFor(() => {
      expect(screen.getByText(/Network glitch during upload/i)).toBeDefined();
    });

    // Retry single button is shown
    const retryBtn = screen.getByRole("button", { name: /^retry$/i });
    expect(retryBtn).toBeDefined();

    // Second attempt succeeds
    mockExecuteBulkImport.mockResolvedValueOnce({
      ok: true,
      bulk: true,
      count: 50,
      excluded: 0,
      importId: "bulk-imp-flaky",
    });

    fireEvent.click(retryBtn);

    await waitFor(() => {
      expect(screen.getByText(/50 rows/i)).toBeDefined();
    });
  });

  it("preserves destructive action rate limiters on Clear All", async () => {
    mockUploads = [{ id: "upl-1", file_name: "test.csv", report_type: "occupancy", rows_imported: 10 }];
    const spy = vi.spyOn(destructiveActionRateLimiter, "check").mockReturnValueOnce({
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 900 * 1000,
      blocked: true,
      retryAfter: 900,
    });

    render(<Import />);
    const clearBtn = screen.getByRole("button", { name: /clear all imported data/i });
    fireEvent.click(clearBtn);

    expect(spy).toHaveBeenCalled();
    expect(window.alert).toHaveBeenCalledWith(expect.stringContaining("Too many requests"));
    spy.mockRestore();
  });

  it("treats Free-plan estimated D1 budget as non-blocking telemetry for cloud bulk import", async () => {
    mockScanReport.mockResolvedValueOnce({
      type: "occupancy",
      totalRows: 50000,
      rowsToImport: Array(50000).fill({}),
      sections: [{ name: "Occupancy", rows: 50000 }],
      validation: { ok: true, findings: [] },
    });

    const { container } = render(<Import />);
    const bigFile = new File(["date,rooms\n2026-01-01,50"], "large_report.csv", { type: "text/csv" });

    fireEvent.change(container.querySelector('input[type="file"]'), { target: { files: [bigFile] } });

    await waitFor(() => {
      expect(screen.getByText("large_report.csv")).toBeDefined();
    });

    await waitFor(() => {
      expect(screen.getByText("Ready to import")).toBeDefined();
    });

    // Should NOT be blocked by budget
    expect(screen.queryByText(/Exceeds write budget/i)).toBeNull();

    // Import button should be enabled
    const importBtn = /** @type {HTMLButtonElement} */ (screen.getByRole("button", { name: /^import$/i }));
    expect(importBtn.disabled).toBe(false);

    // Clicking import proceeds to cloud bulk pipeline
    fireEvent.click(importBtn);

    await waitFor(() => {
      expect(mockExecuteBulkImport).toHaveBeenCalledWith(
        expect.objectContaining({ type: "occupancy" }),
        expect.objectContaining({ propertyId: "prop-boston" })
      );
    });
  });

  it("prompts explicit replacement dialog when report overlaps active import, and activates successfully with predecessor revision", async () => {
    mockScanReport.mockResolvedValueOnce({
      type: "hotel_statistics",
      totalRows: 14,
      rowsToImport: Array(14).fill({}),
      sections: [{ name: "Revenue", rows: 14 }],
      validation: { ok: true, findings: [] },
    });

    const overlapErr = Object.assign(new Error("Report overlaps an active import; select its replacement explicitly"), {
      code: "IMPORT_REPLACEMENT_REQUIRED",
      status: 409,
      existing_bundle_id: "active_hotel_stats_prev",
      existing_bundle: {
        id: "active_hotel_stats_prev",
        original_file_name: "Hotel Statistics (1).csv",
        revision: 1,
        row_count: 14,
        min_date: "2026-08-01",
        max_date: "2026-08-07",
      },
      candidates: [
        {
          id: "active_hotel_stats_prev",
          original_file_name: "Hotel Statistics (1).csv",
          revision: 1,
          row_count: 14,
          min_date: "2026-08-01",
          max_date: "2026-08-07",
        }
      ]
    });

    mockExecuteBulkImport.mockRejectedValueOnce(overlapErr);

    const { container } = render(<Import />);
    const file = new File(["Date,Metric\n2026-08-01,ADR"], "Hotel Statistics.csv", { type: "text/csv" });
    fireEvent.change(container.querySelector('input[type="file"]'), { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByText("Hotel Statistics.csv")).toBeDefined();
    });

    const importBtn = screen.getByRole("button", { name: /^import$/i });
    fireEvent.click(importBtn);

    // Dialog appears immediately for single import with explicit replacement details
    await waitFor(() => {
      expect(screen.getByText("Explicit Report Replacement Required")).toBeDefined();
      expect(screen.getByText("Hotel Statistics (1).csv")).toBeDefined();
      expect(screen.getByText(/Revision 1 · Active/i)).toBeDefined();
    });

    // Cancel dialog to verify the queue row retains the "Select Replacement Report" action
    const cancelBtn = screen.getByRole("button", { name: /cancel/i });
    fireEvent.click(cancelBtn);

    await waitFor(() => {
      expect(screen.queryByText("Explicit Report Replacement Required")).toBeNull();
      expect(screen.getByText(/explicit replacement required/i)).toBeDefined();
    });

    // Re-open from the dedicated queue action button
    const selectBtn = screen.getByRole("button", { name: /select replacement report/i });
    expect(selectBtn).toBeDefined();
    fireEvent.click(selectBtn);

    await waitFor(() => {
      expect(screen.getByText("Explicit Report Replacement Required")).toBeDefined();
    });

    // Mock successful replacement activation
    mockExecuteBulkImport.mockResolvedValueOnce({
      ok: true,
      bulk: true,
      count: 14,
      excluded: 0,
      importId: "bulk-imp-replaced",
    });

    const confirmBtn = screen.getByRole("button", { name: /confirm & replace report/i });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(mockExecuteBulkImport).toHaveBeenCalledWith(
        expect.objectContaining({ type: "hotel_statistics" }),
        expect.objectContaining({
          supersedesBundleId: "active_hotel_stats_prev",
          expectedRevision: 1,
        })
      );
    });

    // Dialog closes and item completes
    await waitFor(() => {
      expect(screen.queryByText("Explicit Report Replacement Required")).toBeNull();
      expect(screen.getByText(/14 rows/i)).toBeDefined();
    });
  });

  it("resumes server-archived original without device upload, resolves overlap conflict, and replaces predecessor", async () => {
    const pendingArchive = {
      id: "arch_source_1",
      raw_archive_id: "arch_source_1",
      server_property_id: "prop-boston",
      report_type: "source",
      original_file_name: "Source Summary (1).csv",
      file_size: 433742,
    };

    mockFetchPendingRawArchives
      .mockResolvedValueOnce([pendingArchive])
      .mockResolvedValueOnce([]); // after replacement, cleared

    mockDownloadRawArchiveFromServer.mockResolvedValueOnce({
      buffer: new TextEncoder().encode("Date,Source\n2026-08-01,OTA"),
      contentType: "text/csv",
    });

    mockScanReport.mockResolvedValueOnce({
      type: "source",
      totalRows: 50,
      rowsToImport: Array(50).fill({}),
      sections: [{ name: "Source", rows: 50 }],
      validation: { ok: true, findings: [] },
    });

    const overlapErr = Object.assign(new Error("Report overlaps an active import; select its replacement explicitly"), {
      code: "IMPORT_REPLACEMENT_REQUIRED",
      status: 409,
      existing_bundle_id: "active_source_summary_prev",
      existing_bundle: {
        id: "active_source_summary_prev",
        original_file_name: "Source Summary.csv",
        revision: 2,
        row_count: 50,
      },
      candidates: [
        {
          id: "active_source_summary_prev",
          original_file_name: "Source Summary.csv",
          revision: 2,
          row_count: 50,
        }
      ]
    });

    // First attempt from server resume triggers overlap conflict
    mockExecuteBulkImport.mockRejectedValueOnce(overlapErr);

    render(<Import />);

    // UI finds the server-archived original
    await waitFor(() => {
      expect(screen.getByText(/Found 1 server-archived original file awaiting processing/i)).toBeDefined();
      expect(screen.getByText(/These original files are safely stored in the R2 archive/i)).toBeDefined();
    });

    const resumeBtn = screen.getByRole("button", { name: /Resume Source Summary \(1\)\.csv \(source\)/i });
    fireEvent.click(resumeBtn);

    // Verify downloaded from server storage, zero local device upload
    await waitFor(() => {
      expect(mockDownloadRawArchiveFromServer).toHaveBeenCalledWith("arch_source_1");
    });

    // Dialog opens with zero re-upload notification
    await waitFor(() => {
      expect(screen.getByText("Explicit Report Replacement Required")).toBeDefined();
      expect(screen.getByText(/Resuming safely from server storage\. Zero device re-upload required\./i)).toBeDefined();
      expect(screen.getByText("Source Summary.csv")).toBeDefined();
      expect(screen.getByText(/Revision 2 · Active/i)).toBeDefined();
    });

    // Confirm replacement
    mockExecuteBulkImport.mockResolvedValueOnce({
      ok: true,
      bulk: true,
      count: 50,
      excluded: 0,
      importId: "bulk-imp-resumed-replaced",
    });

    const confirmBtn = screen.getByRole("button", { name: /confirm & replace report/i });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(mockExecuteBulkImport).toHaveBeenCalledWith(
        expect.objectContaining({ type: "source" }),
        expect.objectContaining({
          supersedesBundleId: "active_source_summary_prev",
          expectedRevision: 2,
          resumeManifest: pendingArchive,
        })
      );
    });

    // Dialog closes and pending archives refreshed
    await waitFor(() => {
      expect(screen.queryByText("Explicit Report Replacement Required")).toBeNull();
      expect(screen.queryByText(/awaiting processing/i)).toBeNull();
    });
  });

  it("handles multi-predecessor replacement requiring all active overlapping reports to be superseded", async () => {
    const pendingArchive = {
      id: "raw_source_multi",
      raw_archive_id: "raw_source_multi",
      server_property_id: "prop-boston",
      report_type: "source",
      original_file_name: "Source Summary (1).csv",
      file_size: 433742,
    };

    mockFetchPendingRawArchives
      .mockResolvedValueOnce([pendingArchive])
      .mockResolvedValueOnce([]);

    mockDownloadRawArchiveFromServer.mockResolvedValueOnce({
      buffer: new TextEncoder().encode("Date,Source\n2026-08-01,OTA"),
      contentType: "text/csv",
    });

    mockScanReport.mockResolvedValueOnce({
      type: "source",
      totalRows: 7918,
      rowsToImport: Array(7918).fill({}),
      sections: [{ name: "Source", rows: 7918 }],
      validation: { ok: true, findings: [] },
    });

    const candidates = [
      { id: "pred_q1", original_file_name: "Source_Summary_Q1.csv", revision: 2177, row_count: 3330 },
      { id: "pred_q2", original_file_name: "Source_Summary_Q2.csv", revision: 2401, row_count: 3367 },
      { id: "pred_q3", original_file_name: "Source_Summary_Q3.csv", revision: 2402, row_count: 1221 },
    ];

    const overlapErr = Object.assign(new Error("Report overlaps an active import; select its replacement explicitly"), {
      code: "IMPORT_REPLACEMENT_REQUIRED",
      status: 409,
      existing_bundle_id: "pred_q1",
      existing_bundle: candidates[0],
      candidates,
    });

    mockExecuteBulkImport.mockRejectedValueOnce(overlapErr);

    render(<Import />);

    await waitFor(() => {
      expect(screen.getByText(/Found 1 server-archived original file awaiting processing/i)).toBeDefined();
    });

    const resumeBtn = screen.getByRole("button", { name: /Resume Source Summary \(1\)\.csv \(source\)/i });
    fireEvent.click(resumeBtn);

    // Dialog opens with multi-report warning and all 3 candidates
    await waitFor(() => {
      expect(screen.getByText("Explicit Report Replacement Required")).toBeDefined();
      expect(screen.getByText(/Multi-Report Replacement/i)).toBeDefined();
      expect(screen.getByText("Source_Summary_Q1.csv")).toBeDefined();
      expect(screen.getByText("Source_Summary_Q2.csv")).toBeDefined();
      expect(screen.getByText("Source_Summary_Q3.csv")).toBeDefined();
    });

    // Confirm button is ready
    mockExecuteBulkImport.mockResolvedValueOnce({
      ok: true,
      bulk: true,
      count: 7918,
      excluded: 0,
      importId: "bulk-imp-multi-replaced",
    });

    const confirmBtn = screen.getByRole("button", { name: /confirm & replace report/i });
    expect(confirmBtn).not.toBeDisabled();
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(mockExecuteBulkImport).toHaveBeenCalledWith(
        expect.objectContaining({ type: "source" }),
        expect.objectContaining({
          predecessors: [
            { id: "pred_q1", expected_revision: 2177 },
            { id: "pred_q2", expected_revision: 2401 },
            { id: "pred_q3", expected_revision: 2402 },
          ],
          supersedesBundleId: "pred_q1",
          expectedRevision: 2177,
          resumeManifest: pendingArchive,
        })
      );
    });

    await waitFor(() => {
      expect(screen.queryByText("Explicit Report Replacement Required")).toBeNull();
    });
  });
});
