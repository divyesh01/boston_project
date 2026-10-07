import React from "react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const { mutationLedger, fakeLocalDb, userHolder, toastCalls } = vi.hoisted(() => {
  const mutationLedger = {
    transactions: 0,
    clears: {},
    bulkPuts: {},
    secureStores: {},
  };

  const mockStores = ["Property", "TransactionLine", "OccupancyDay"];

  const fakeLocalDb = {
    name: "test-hotel-db",
    verno: 1,
    tables: mockStores.map((name) => ({ name })),
    async transaction(mode, tables, callback) {
      mutationLedger.transactions += 1;
      return await callback();
    },
  };

  for (const name of mockStores) {
    fakeLocalDb[name] = {
      name,
      async toArray() {
        return [];
      },
      async clear() {
        mutationLedger.clears[name] = (mutationLedger.clears[name] || 0) + 1;
      },
      async bulkPut(rows) {
        mutationLedger.bulkPuts[name] = [...(mutationLedger.bulkPuts[name] || []), ...rows];
      },
    };
  }

  const userHolder = {
    current: {
      id: "owner-1",
      username: "owner",
      role: "owner",
      property_access: "all",
    },
  };

  const toastCalls = [];

  return { mutationLedger, fakeLocalDb, userHolder, toastCalls };
});

function resetLedger() {
  mutationLedger.transactions = 0;
  mutationLedger.clears = {};
  mutationLedger.bulkPuts = {};
  mutationLedger.secureStores = {};
}

vi.mock("@/api/localDb", () => ({
  default: fakeLocalDb,
}));

vi.mock("@/api/base44Client", () => ({
  db: {
    auth: {
      me: vi.fn(async () => userHolder.current),
    },
    audit: {
      log: vi.fn(async () => undefined),
    },
    entities: {
      Property: { list: vi.fn(async () => []), filter: vi.fn(async () => []) },
    },
  },
}));

vi.mock("@/lib/securityUtils", () => ({
  getCsrfToken: () => "valid-csrf",
  validateCsrfToken: () => true,
  rotateCsrfToken: vi.fn(),
  secureRetrieve: vi.fn(async () => []),
  secureStore: vi.fn(async (key, value) => {
    mutationLedger.secureStores[key] = value;
    return true;
  }),
  sanitizeText: (v) => String(v ?? ""),
  sanitizeAlphanumeric: (v) => String(v ?? "").replace(/[^a-z0-9_-]/gi, ""),
  sanitizeCsvCell: (v) => String(v ?? ""),
}));

vi.mock("@/lib/exportData", () => ({
  downloadBlob: vi.fn(),
  stampFilename: (base, ext) => `${base}-stamped${ext}`,
}));

vi.mock("@/lib/launchPolicy", () => ({
  hasAllPropertyAccess: (user) => user?.role === "owner" || user?.property_access === "all",
}));

vi.mock("@/components/ui/use-toast", () => ({
  toast: (opts) => {
    toastCalls.push(opts);
  },
}));

vi.mock("@/lib/rateLimiters", () => ({
  operationalActionRateLimiter: { check: () => ({ allowed: true, retryAfter: 0 }) },
  destructiveActionRateLimiter: { check: () => ({ allowed: true, retryAfter: 0 }) },
  securityActionRateLimiter: { check: () => ({ allowed: true, retryAfter: 0 }) },
}));

vi.mock("@/lib/AuthContext", () => ({
  useAuth: () => ({
    user: userHolder.current,
    logout: vi.fn(),
  }),
}));

vi.mock("@/lib/useHotelData", () => ({
  useProperties: () => ({
    data: [],
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  }),
}));

vi.mock("@/components/settings/EnterpriseSettings", () => ({ default: () => null }));
vi.mock("@/components/settings/SettingsConflictNotice", () => ({ default: () => null }));
vi.mock("@/components/PasswordConfirmDialog", () => ({ default: () => null }));

vi.mock("@/lib/commissionRates", () => ({
  COMMISSION_TYPES: [["percentage", "Percentage"]],
  getCommissionRates: () => ({}),
  setCommissionRates: () => true,
  getCcFeeRate: () => 0.025,
  setCcFeeRate: () => true,
  getCcFeeOnRefunds: () => false,
  setCcFeeOnRefunds: () => true,
}));

vi.mock("@/lib/alertThresholds", () => ({
  getAlertThresholds: () => ({}),
  saveAlertThresholds: () => true,
}));

vi.mock("@/lib/revenueThresholds", () => ({
  getRevenueThresholds: () => ({ highRevenueThreshold: 5000, mediumRevenueThreshold: 3000 }),
  saveRevenueThresholds: () => true,
}));

vi.mock("@/lib/taxSettings", () => ({
  getTaxSettings: () => [],
  saveTaxSettings: () => true,
}));

vi.mock("@/lib/settingsStore", () => ({
  flushCloudSettingSync: vi.fn(),
  setEditingSettingsLock: vi.fn(),
  isEditingSettingsLocked: vi.fn(() => false),
}));

vi.mock("@/lib/settingsBus", () => ({
  subscribeSettingsChange: vi.fn(() => () => {}),
  subscribeSettingsConflict: vi.fn(() => () => {}),
}));

vi.mock("@/lib/dailyAggregates", () => ({
  rebuildDailyAggregates: vi.fn(async () => {}),
}));

import {
  isServerDataSyncEnabled,
  restoreArchive,
} from "@/lib/dbArchive";
import Settings from "@/pages/Settings";

const sampleValidParsedArchive = {
  archive: {
    format: "boston-hotel.db-archive",
    format_version: 1,
    database: "test-hotel-db",
    schema_version: 1,
    exported_at: "2026-10-04T00:00:00.000Z",
    exported_by: "owner",
    origin: "http://localhost:5173",
    counts: {
      Property: 1,
      TransactionLine: 1,
      OccupancyDay: 0,
    },
    total_rows: 2,
    excluded_stores: {
      LocalSession: "live sign-in sessions",
      PasswordResetRequest: "in-flight password-reset tokens",
    },
    checksum: "valid-checksum",
    payload: {
      stores: {
        Property: [{ id: 1, name: "Hotel Boston" }],
        TransactionLine: [{ id: 101, amount: 2500 }],
        OccupancyDay: [],
      },
      secure_slots: {
        rri_import_sessions: [{ session_id: "s1" }],
      },
      local_slots: {},
    },
  },
  storeNames: ["Property", "TransactionLine", "OccupancyDay"],
  missingStores: [],
  totalRows: 2,
  localSlotKeys: [],
  secureSlotKeys: ["rri_import_sessions"],
};

describe("Isolated Settings/archive candidate - Mode detection & restoreArchive contract", () => {
  beforeEach(() => {
    resetLedger();
    toastCalls.length = 0;
    userHolder.current = {
      id: "owner-1",
      username: "owner",
      role: "owner",
      property_access: "all",
    };
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("dynamically evaluates isServerDataSyncEnabled matching VITE_USE_SERVER_DATA_SYNC", () => {
    vi.stubEnv("VITE_USE_SERVER_DATA_SYNC", "false");
    expect(isServerDataSyncEnabled()).toBe(false);

    vi.stubEnv("VITE_USE_SERVER_DATA_SYNC", "true");
    expect(isServerDataSyncEnabled()).toBe(true);

    vi.stubEnv("VITE_USE_SERVER_DATA_SYNC", "");
    expect(isServerDataSyncEnabled()).toBe(false);
  });

  it("server-sync mode rejects restoreArchive before any mutation occurs (zero transaction/clear/bulkPut/secureStore)", async () => {
    vi.stubEnv("VITE_USE_SERVER_DATA_SYNC", "true");
    expect(isServerDataSyncEnabled()).toBe(true);

    await expect(
      restoreArchive(sampleValidParsedArchive, { confirm: "REPLACE" }),
    ).rejects.toThrow(
      "Restore is not supported when server data sync is enabled. Database restore replaces only local browser data and cannot safely overwrite or reconcile authoritative server state.",
    );

    // Verify ZERO mutations occurred
    expect(mutationLedger.transactions).toBe(0);
    expect(Object.keys(mutationLedger.clears).length).toBe(0);
    expect(Object.keys(mutationLedger.bulkPuts).length).toBe(0);
    expect(Object.keys(mutationLedger.secureStores).length).toBe(0);
  });

  it("local-only mode enforces REPLACE confirmation before performing any mutation", async () => {
    vi.stubEnv("VITE_USE_SERVER_DATA_SYNC", "false");
    expect(isServerDataSyncEnabled()).toBe(false);

    await expect(
      restoreArchive(sampleValidParsedArchive, { confirm: "MERGE" }),
    ).rejects.toThrow(/Pass confirm: "REPLACE" to proceed/);

    expect(mutationLedger.transactions).toBe(0);
    expect(Object.keys(mutationLedger.clears).length).toBe(0);
  });

  it("local-only mode enforces owner/all-property permission check", async () => {
    vi.stubEnv("VITE_USE_SERVER_DATA_SYNC", "false");
    userHolder.current = { id: "user-2", username: "clerk", role: "staff", property_access: "prop-1" };

    await expect(
      restoreArchive(sampleValidParsedArchive, { confirm: "REPLACE" }),
    ).rejects.toThrow(/Only an owner or admin with access to every property can restore/);

    expect(mutationLedger.transactions).toBe(0);
    expect(Object.keys(mutationLedger.clears).length).toBe(0);
  });

  it("local-only mode performs genuine synthetic replacement when confirmed by authorized owner", async () => {
    vi.stubEnv("VITE_USE_SERVER_DATA_SYNC", "false");
    expect(isServerDataSyncEnabled()).toBe(false);

    const res = await restoreArchive(sampleValidParsedArchive, { confirm: "REPLACE" });
    expect(res.stores).toBe(3);
    expect(res.total_rows).toBe(2);

    expect(mutationLedger.transactions).toBe(1);
    expect(mutationLedger.clears["Property"]).toBe(1);
    expect(mutationLedger.clears["TransactionLine"]).toBe(1);
    expect(mutationLedger.bulkPuts["Property"]).toEqual([{ id: 1, name: "Hotel Boston" }]);
    expect(mutationLedger.bulkPuts["TransactionLine"]).toEqual([{ id: 101, amount: 2500 }]);
    expect(mutationLedger.secureStores["rri_import_sessions"]).toEqual([{ session_id: "s1" }]);
  });
});

describe("Isolated Settings/archive candidate - Settings UI mode-accurate behavior", () => {
  beforeEach(() => {
    resetLedger();
    toastCalls.length = 0;
    userHolder.current = {
      id: "owner-1",
      username: "owner",
      role: "owner",
      property_access: "all",
    };
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("in server-sync mode: displays truthful snapshot copy, disclaims complete cloud backup, and blocks restore", () => {
    vi.stubEnv("VITE_USE_SERVER_DATA_SYNC", "true");

    render(
      <MemoryRouter>
        <Settings />
      </MemoryRouter>,
    );

    // Truthful server-sync description
    expect(screen.getByText(/Server data sync is active\. Business data is persisted to the server\./)).toBeInTheDocument();
    expect(screen.getByText(/it is not a complete server backup and may not include records not yet loaded in this browser\./)).toBeInTheDocument();
    expect(screen.queryByText(/There is no copy on a server/)).not.toBeInTheDocument();

    // Button label
    expect(screen.getByRole("button", { name: /Download local snapshot/i })).toBeInTheDocument();

    // Incomplete snapshot notice under download
    expect(screen.getByText(/capturing a local snapshot of cached browser tables and settings\. It is a browser snapshot only and does not serve as a complete server backup\./)).toBeInTheDocument();

    // Restore block notice and disabled button
    expect(screen.getByText(/Restoring from a backup file is not supported when server data sync is enabled\./)).toBeInTheDocument();

    const chooseButton = screen.getByRole("button", { name: /Choose backup file…/i });
    expect(chooseButton).toBeDisabled();
  });

  it("in local-only mode: displays original offline copy and keeps restore action enabled", () => {
    vi.stubEnv("VITE_USE_SERVER_DATA_SYNC", "false");

    render(
      <MemoryRouter>
        <Settings />
      </MemoryRouter>,
    );

    // Original local-only text preserved
    expect(screen.getByText(/Every record in this app — staff, payroll, expenses, imported reports, commission rates and tax periods — is stored in/)).toBeInTheDocument();
    expect(screen.getByText(/There is no copy on a server\./)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Download backup/i })).toBeInTheDocument();

    const chooseButton = screen.getByRole("button", { name: /Choose backup file…/i });
    expect(chooseButton).not.toBeDisabled();
  });
});
