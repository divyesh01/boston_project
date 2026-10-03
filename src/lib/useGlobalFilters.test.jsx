import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { GlobalFiltersProvider, useGlobalFilters } from "@/lib/useGlobalFilters";

const mockState = {
  properties: [
    { id: "prop-active-1", name: "Active Hotel 1", rooms: 50, active: true },
    { id: "prop-active-2", name: "Active Hotel 2", rooms: 40, active: true },
    { id: "prop-inactive", name: "Deactivated Hotel", rooms: 30, active: false },
  ],
  allowedIds: ["prop-active-1", "prop-active-2", "prop-inactive"],
};

vi.mock("@/lib/useHotelData", () => ({
  useProperties: () => ({ data: mockState.properties }),
  useLatestDate: () => ({ data: "2026-08-10" }),
}));

vi.mock("@/lib/AuthContext", () => ({
  useAuth: () => ({
    canAccessProperty: (id) => mockState.allowedIds.includes(id),
  }),
}));

vi.mock("@/hooks/useSettingsVersion", () => ({
  useSettingsVersion: () => 1,
}));

vi.mock("@/lib/enterpriseConfigEngine", () => ({
  getPropertyProfile: () => ({ current_business_date: "2026-08-10" }),
}));

describe("useGlobalFilters active property scope and zero selection", () => {
  beforeEach(() => {
    mockState.properties = [
      { id: "prop-active-1", name: "Active Hotel 1", rooms: 50, active: true },
      { id: "prop-active-2", name: "Active Hotel 2", rooms: 40, active: true },
      { id: "prop-inactive", name: "Deactivated Hotel", rooms: 30, active: false },
    ];
    mockState.allowedIds = ["prop-active-1", "prop-active-2", "prop-inactive"];
  });

  it("filters out inactive properties (active === false) from visible dashboard scope", () => {
    const { result } = renderHook(() => useGlobalFilters(), { wrapper: GlobalFiltersProvider });

    expect(result.current.properties.map((p) => p.id)).toEqual(["prop-active-1", "prop-active-2"]);
    expect(result.current.accessibleProperties.map((p) => p.id)).toEqual(["prop-active-1", "prop-active-2"]);
    expect(result.current.properties.some((p) => p.id === "prop-inactive")).toBe(false);
  });

  it("forwards explicit active portfolio IDs array on zero selection instead of 'all' sentinel", () => {
    const { result } = renderHook(() => useGlobalFilters(), { wrapper: GlobalFiltersProvider });

    // With zero selection (selectedPropertyIds = []), property must be the array of active IDs, never "all"
    expect(result.current.property).toEqual(["prop-active-1", "prop-active-2"]);
    expect(result.current.property).not.toBe("all");
  });

  it("preserves explicit single active property selection", () => {
    const { result } = renderHook(() => useGlobalFilters(), { wrapper: GlobalFiltersProvider });

    act(() => {
      result.current.setProperty("prop-active-1");
    });

    expect(result.current.property).toBe("prop-active-1");
  });

  it("drops selected property when it becomes inactive and falls back to active portfolio without leaking inactive records", () => {
    const { result, rerender } = renderHook(() => useGlobalFilters(), { wrapper: GlobalFiltersProvider });

    act(() => {
      result.current.setProperty("prop-active-1");
    });
    expect(result.current.property).toBe("prop-active-1");

    // Deactivate prop-active-1
    mockState.properties = [
      { id: "prop-active-1", name: "Active Hotel 1", rooms: 50, active: false },
      { id: "prop-active-2", name: "Active Hotel 2", rooms: 40, active: true },
      { id: "prop-inactive", name: "Deactivated Hotel", rooms: 30, active: false },
    ];

    rerender();

    // prop-active-1 is now inactive, so it must be dropped and only prop-active-2 should remain in scope
    expect(result.current.properties.map((p) => p.id)).toEqual(["prop-active-2"]);
    // Since selected id became inactive, selection falls back to remaining active portfolio:
    expect(result.current.property).toEqual(["prop-active-2"]);
  });

  it("returns empty array for zero active properties and NEVER falls through to 'all'", () => {
    mockState.properties = [
      { id: "prop-inactive", name: "Deactivated Hotel", rooms: 30, active: false },
    ];

    const { result } = renderHook(() => useGlobalFilters(), { wrapper: GlobalFiltersProvider });

    expect(result.current.properties).toEqual([]);
    expect(result.current.property).toEqual([]);
    expect(result.current.property).not.toBe("all");
  });
});
