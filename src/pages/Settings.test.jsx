import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const state = vi.hoisted(() => ({
  rates: { EXPEDIA: { type: "percentage", rate: 0.15, taxExempt: false } },
  ccFee: 0.025,
  ccRefunds: false,
  taxRows: [],
  alertThresholds: {
    revenueDecreasePct: 0.1,
    occupancyDecreasePoints: 0.1,
    occupancyThreshold: 0.6,
  },
  revenueThresholds: {
    highRevenueThreshold: 6100,
    mediumRevenueThreshold: 3200,
  },
  refuseRevenueWrite: false,
  properties: [],
}));

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  flush: vi.fn().mockResolvedValue(true),
  rotate: vi.fn(),
  invalidateQueries: vi.fn(),
  rebuild: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/components/settings/EnterpriseSettings", () => ({ default: () => null }));
vi.mock("@/components/settings/SettingsConflictNotice", () => ({ default: () => null }));

vi.mock("@/lib/AuthContext", () => ({
  useAuth: () => ({
    user: {
      id: "owner-1",
      username: "owner",
      full_name: "Owner",
      email: "owner@example.com",
      role: "owner",
      property_access: "all",
      mfa_enabled: false,
    },
    logout: vi.fn(),
  }),
}));

vi.mock("@/lib/useHotelData", () => ({
  useProperties: () => ({
    data: state.properties,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  }),
}));

vi.mock("@/api/base44Client", () => ({
  db: {
    audit: { log: vi.fn().mockResolvedValue(undefined) },
    entities: {
      Property: {
        list: vi.fn().mockResolvedValue([]),
        filter: vi.fn().mockResolvedValue([]),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      },
    },
    auth: {},
    functions: {},
  },
}));

vi.mock("@/api/localDb", () => ({
  default: {},
}));

vi.mock("@/lib/commissionRates", () => ({
  COMMISSION_TYPES: [
    ["percentage", "Percentage"],
    ["fixed", "Fixed"],
    ["none", "None"],
  ],
  getCommissionRates: () => state.rates,
  setCommissionRates: (value) => { state.rates = value; return true; },
  getCcFeeRate: () => state.ccFee,
  setCcFeeRate: (value) => { state.ccFee = Number(value); return true; },
  getCcFeeOnRefunds: () => state.ccRefunds,
  setCcFeeOnRefunds: (value) => { state.ccRefunds = Boolean(value); return true; },
}));

vi.mock("@/lib/alertThresholds", () => ({
  getAlertThresholds: () => ({ ...state.alertThresholds }),
  saveAlertThresholds: (value) => { state.alertThresholds = { ...value }; return true; },
}));

vi.mock("@/lib/revenueThresholds", () => ({
  getRevenueThresholds: () => ({ ...state.revenueThresholds }),
  saveRevenueThresholds: (value) => {
    if (state.refuseRevenueWrite) return false;
    state.revenueThresholds = { ...value };
    return true;
  },
}));

vi.mock("@/lib/taxSettings", () => ({
  getTaxSettings: () => state.taxRows.map((row) => ({ ...row })),
  saveTaxSettings: (value) => { state.taxRows = value.map((row) => ({ ...row })); return true; },
}));

vi.mock("@/lib/settingsStore", () => ({
  flushCloudSettingSync: (...args) => mocks.flush(...args),
  setEditingSettingsLock: vi.fn(),
  isEditingSettingsLocked: () => false,
  getSettingsSyncState: () => ({ conflict: null, pending: 0, saving: false, error: null }),
  subscribeSettingsSync: () => () => {},
  reviewSettingsConflict: vi.fn(),
  resolveSettingsConflict: vi.fn(),
}));

vi.mock("@/lib/settingsBus", () => ({
  subscribeSettingsChange: () => () => {},
  subscribeSettingsConflict: () => () => {},
}));

vi.mock("@/lib/dailyAggregates", () => ({
  rebuildDailyAggregates: (...args) => mocks.rebuild(...args),
}));

vi.mock("@/lib/query-client", () => ({
  queryClientInstance: { invalidateQueries: (...args) => mocks.invalidateQueries(...args) },
}));

vi.mock("@/components/ui/use-toast", () => ({
  toast: (...args) => mocks.toast(...args),
}));

vi.mock("@/lib/securityUtils", () => ({
  getCsrfToken: () => "csrf",
  validateCsrfToken: () => true,
  rotateCsrfToken: (...args) => mocks.rotate(...args),
  sanitizeText: (value) => String(value ?? ""),
  sanitizeAlphanumeric: (value) => String(value ?? "").replace(/[^a-z0-9_-]/gi, ""),
  sanitizeCsvCell: (value) => String(value ?? ""),
}));

vi.mock("@/lib/rateLimiters", () => ({
  operationalActionRateLimiter: { check: () => ({ allowed: true, retryAfter: 0 }) },
  destructiveActionRateLimiter: { check: () => ({ allowed: true, retryAfter: 0 }) },
  securityActionRateLimiter: { check: () => ({ allowed: true, retryAfter: 0 }) },
}));

vi.mock("@/lib/dbArchive", () => ({
  ARCHIVE_FILE_EXT: ".json",
  downloadArchive: vi.fn(),
  inspectArchiveFile: vi.fn(() => ({ ok: false, reason: "unused" })),
  parseArchive: vi.fn(),
  restoreArchive: vi.fn(),
  isServerDataSyncEnabled: vi.fn(() => false),
}));

vi.mock("@/lib/launchPolicy", () => ({
  hasAllPropertyAccess: () => true,
}));

vi.mock("@/components/PasswordConfirmDialog", () => ({
  default: () => null,
}));

import Settings from "./Settings";

function renderSettings() {
  return render(
    <MemoryRouter>
      <Settings />
    </MemoryRouter>,
  );
}

function revenueInput(label) {
  const row = screen.getByText(label).closest("div");
  const input = row?.querySelector("input");
  if (!input) throw new Error(`input not found for ${label}`);
  return /** @type {HTMLInputElement} */ (input);
}

describe("Settings page persistence contract", () => {
  beforeEach(() => {
    state.rates = { EXPEDIA: { type: "percentage", rate: 0.15, taxExempt: false } };
    state.ccFee = 0.025;
    state.ccRefunds = false;
    state.taxRows = [];
    state.alertThresholds = {
      revenueDecreasePct: 0.1,
      occupancyDecreasePoints: 0.1,
      occupancyThreshold: 0.6,
    };
    state.revenueThresholds = {
      highRevenueThreshold: 6100,
      mediumRevenueThreshold: 3200,
    };
    state.refuseRevenueWrite = false;
    state.properties = [];
    vi.clearAllMocks();
  });

  it("loads saved revenue thresholds into the form", () => {
    renderSettings();

    expect(revenueInput("High revenue threshold (green)").value).toBe("6100");
    expect(revenueInput("Medium revenue threshold (gray)").value).toBe("3200");
  });

  it("saves an edited revenue threshold and shows the persisted value after remount", async () => {
    const first = renderSettings();
    const high = revenueInput("High revenue threshold (green)");

    fireEvent.change(high, { target: { value: "7600" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Revenue Thresholds" }));

    await waitFor(() => expect(state.revenueThresholds.highRevenueThreshold).toBe(7600));
    first.unmount();

    renderSettings();
    expect(revenueInput("High revenue threshold (green)").value).toBe("7600");
  });

  it("does not claim success when the browser refuses the explicit save", async () => {
    state.refuseRevenueWrite = true;
    renderSettings();

    fireEvent.change(revenueInput("High revenue threshold (green)"), {
      target: { value: "8800" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Revenue Thresholds" }));

    await waitFor(() => {
      expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({
        variant: "destructive",
        title: "Not saved",
      }));
    });
    expect(screen.getByRole("button", { name: "Save Revenue Thresholds" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Saved!" })).not.toBeInTheDocument();
  });
});
