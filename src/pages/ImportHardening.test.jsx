import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";
import { getQueueMetrics, confirmForceImportToggle, confirmBatchForceImport, validateQueueProperty } from "@/lib/importQueueHelpers";
import { importRateLimiter, operationalActionRateLimiter, destructiveActionRateLimiter, securityActionRateLimiter } from "@/lib/rateLimiters";

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
        filter: vi.fn().mockReturnValue({ get: vi.fn().mockResolvedValue([]) }),
        create: vi.fn().mockResolvedValue({ id: "upl-1" }),
      },
    },
  },
  listImportSessions: (...args) => mockListImportSessions(...args),
  rollbackImportSession: (...args) => mockRollbackImportSession(...args),
}));

vi.mock("@/lib/reportParsers", () => ({
  REPORT_TYPES: [
    { key: "occupancy", label: "Occupancy Summary" },
    { key: "source", label: "Source Summary" },
  ],
  scanReport: vi.fn().mockResolvedValue({
    type: "occupancy",
    totalRows: 10,
    sections: [{ name: "Occupancy", rows: 10 }],
    validation: { ok: true, findings: [] },
  }),
  importReport: vi.fn().mockResolvedValue({ count: 10, excluded: 0, importId: "imp-123" }),
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
  sha256File: vi.fn().mockResolvedValue("mock-sha"),
}));

vi.mock("@/lib/dailyAggregates", () => ({
  rebuildDailyAggregates: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/query-client", () => ({
  queryClientInstance: { invalidateQueries: vi.fn() },
}));

vi.mock("@/lib/uploadGuard", () => ({
  inspectUploadFile: vi.fn().mockResolvedValue({ safe: true }),
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

describe("Import UX Hardening Pass", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCanAccessProperty.mockImplementation(() => true);
    window.alert = vi.fn();
    window.confirm = vi.fn(() => true);
    mockProperties = [
      { id: "prop-middleboro", name: "Red Roof Middleboro" },
    ];
    mockIncompleteSessions = [];
  });

  describe("Task 1: Rate Limiter Domain Isolation", () => {
    it("ensures operational, import, destructive, and security limiters operate independently", () => {
      importRateLimiter.reset();
      operationalActionRateLimiter.reset();
      destructiveActionRateLimiter.reset();
      securityActionRateLimiter.reset();

      // Exhaust operational limiter (budget: 120/min)
      for (let i = 0; i < 120; i++) {
        expect(operationalActionRateLimiter.check().allowed).toBe(true);
      }
      expect(operationalActionRateLimiter.check().allowed).toBe(false);

      // Import limiter MUST still be allowed with full budget
      expect(importRateLimiter.check().allowed).toBe(true);
      // Destructive limiter MUST still be allowed
      expect(destructiveActionRateLimiter.check().allowed).toBe(true);
      // Security limiter MUST still be allowed
      expect(securityActionRateLimiter.check().allowed).toBe(true);
    });
  });

  describe("Task 2: Import Queue Metrics & Batch Semantics", () => {
    it("computes queue metrics accurately for mixed statuses", () => {
      const queue = [
        { key: "1", status: "ready", scan: { type: "occupancy" } },
        { key: "2", status: "ready", scan: { type: "source" } },
        { key: "3", status: "done", count: 15, excluded: 2 },
        { key: "4", status: "error", error: "Bad date" },
        { key: "5", status: "duplicate", error: "Duplicate file" },
        { key: "6", status: "scanning" },
      ];

      const metrics = getQueueMetrics(queue);
      expect(metrics.readyCount).toBe(2);
      expect(metrics.queuedCount).toBe(1); // status === 'scanning'
      expect(metrics.doneItems.length).toBe(1);
      expect(metrics.errorItems.length).toBe(1);
      expect(metrics.duplicateItems.length).toBe(1);
      expect(metrics.batchImported).toBe(15);
      expect(metrics.batchExcluded).toBe(2);
    });
  });

  describe("Task 3: Force Import Confirmation & Targeting", () => {
    it("requires confirmation naming the target property before enabling Force Import", () => {
      window.confirm = vi.fn(() => false);
      const res = confirmForceImportToggle({ propertyName: "Red Roof Middleboro", enabling: true });
      expect(res).toBe(false);
      expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("Red Roof Middleboro"));
      expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("Force Import"));
    });

    it("requires batch confirmation naming property and file count", () => {
      window.confirm = vi.fn(() => true);
      const res = confirmBatchForceImport({ propertyName: "Red Roof Middleboro", count: 8 });
      expect(res).toBe(true);
      expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("8 reports"));
      expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("Red Roof Middleboro"));
    });
  });

  describe("Task 4 & 5: Interrupted Session Recovery & Property Consistency", () => {
    it("renders interrupted session recovery banner and calls rollbackImportSession", async () => {
      mockIncompleteSessions = [
        {
          id: "sess-interrupted-1",
          importId: "sess-interrupted-1",
          propertyId: "prop-middleboro",
          status: "in_progress",
          reportType: "occupancy",
          startedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        },
      ];

      render(<Import />);

      await waitFor(() => {
        expect(screen.getByText(/interrupted import session/i)).toBeDefined();
      });

      const rollbackBtn = screen.getByText(/Roll back interrupted/i);
      expect(rollbackBtn).toBeDefined();

      fireEvent.click(rollbackBtn);

      await waitFor(() => {
        expect(mockRollbackImportSession).toHaveBeenCalledWith("sess-interrupted-1");
      });
    });

    it("validates that scan target matches selected property", () => {
      const valid = validateQueueProperty({
        item: { scan: { propertyId: "prop-middleboro" } },
        propertyId: "prop-middleboro",
        accessibleProperties: [{ id: "prop-middleboro" }],
      });
      expect(valid.ok).toBe(true);

      const invalid = validateQueueProperty({
        item: { scan: { propertyId: "prop-other" } },
        propertyId: "prop-middleboro",
        accessibleProperties: [{ id: "prop-middleboro" }],
      });
      expect(invalid.ok).toBe(false);
      expect(invalid.error).toContain('was scanned for property "prop-other"');
    });
  });
});
