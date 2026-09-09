import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
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

vi.mock("@/api/base44Client", () => ({
  db: {
    DailyLedger: { filter: vi.fn().mockReturnValue({ get: vi.fn().mockResolvedValue([]) }) },
    MonthlyCityLedger: { filter: vi.fn().mockReturnValue({ get: vi.fn().mockResolvedValue([]) }) },
    ManagerFlash: { filter: vi.fn().mockReturnValue({ get: vi.fn().mockResolvedValue([]) }) },
    RollbackLedger: { filter: vi.fn().mockReturnValue({ get: vi.fn().mockResolvedValue([]) }) },
    ImportSession: { filter: vi.fn().mockReturnValue({ get: vi.fn().mockResolvedValue([]) }) },
  },
  listImportSessions: vi.fn().mockResolvedValue([]),
  rollbackImportSession: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/lib/reportParsers", () => ({
  REPORT_TYPES: [
    { key: "daily_ledger", name: "Daily Ledger" },
  ],
  scanReport: vi.fn(),
  importReport: vi.fn(),
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
  rebuildDailyAggregates: vi.fn(),
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
  default: ({ value, onChange, options, placeholder }) => (
    <select
      data-testid="property-select"
      value={value}
      onChange={(e) => onChange(e.target.value)}
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
});
