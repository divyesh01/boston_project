// Retained regression: WeatherPanel server-auth capability guard.
// Portable: target `@/components/dashboard/WeatherPanel` resolves to the real
// component in MAIN; in the isolated packet a temp config aliases it to the
// candidate. Actual `@/lib/weatherService` is used in both. Mocks cover only
// public seams (query snapshots, global filters, coords settings, db, charts).
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

import WeatherPanel from "@/components/dashboard/WeatherPanel";
import { cacheIsFresh } from "@/lib/weatherService";
import { useWeatherSnapshots } from "@/lib/useHotelData";
import { useGlobalFilters } from "@/lib/useGlobalFilters";
import { db } from "@/api/base44Client";

vi.mock("@/lib/useHotelData", () => ({ useWeatherSnapshots: vi.fn() }));
vi.mock("@/lib/useGlobalFilters", () => ({ useGlobalFilters: vi.fn() }));
vi.mock("@/lib/propertySelection", () => ({
  singleSelectedProperty: vi.fn((property, properties) =>
    property ?? (Array.isArray(properties) && properties.length === 1 ? properties[0] : null)
  ),
}));
vi.mock("@/lib/weatherSettings", () => ({
  getWeatherConfig: vi.fn(() => ({ lat: 41.89, lon: -70.91 })),
  saveWeatherConfig: vi.fn(() => true),
}));
vi.mock("@/api/base44Client", () => ({
  db: {
    functions: { invoke: vi.fn() },
    entities: {
      WeatherSnapshot: { filter: vi.fn(), delete: vi.fn(), bulkCreate: vi.fn() },
    },
  },
}));
vi.mock("recharts", () => {
  const Stub = () => null;
  return {
    ResponsiveContainer: Stub,
    LineChart: Stub,
    Line: Stub,
    XAxis: Stub,
    YAxis: Stub,
    Tooltip: Stub,
  };
});

const BIZ_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());
const DAY0 = Math.floor(new Date(`${BIZ_DATE}T12:00:00Z`).getTime() / 1000);
const RAW = {
  current: {
    temp: 21,
    feels_like: 20,
    humidity: 55,
    wind_speed: 3.5,
    weather: [{ main: "Clear", description: "clear sky", icon: "01d" }],
  },
  daily: [0, 1, 2, 3, 4].map((i) => ({
    dt: DAY0 + i * 86400,
    temp: { day: 20 + i, min: 15 + i, max: 25 + i },
    weather: [{ main: "Clear", description: "clear sky", icon: "01d" }],
    humidity: 50 + i,
    wind_speed: 3 + i * 0.2,
  })),
};

function freshRows() {
  const now = new Date().toISOString();
  return [
    { property_id: "p1", date: BIZ_DATE, kind: "current", temp: 19, created_date: now },
    { property_id: "p1", date: BIZ_DATE, kind: "forecast", temp: 20, temp_min: 15, temp_max: 25, created_date: now },
  ];
}

function cardFor(label) {
  const card = screen.getByText(label).closest("div.rounded-xl");
  expect(card).toBeTruthy();
  return card;
}

async function waitForCards() {
  await screen.findByText("Now");
  await screen.findByText("Feels Like");
}

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <WeatherPanel />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useGlobalFilters).mockReturnValue({ property: { id: "p1" }, properties: [{ id: "p1" }] });
  vi.mocked(useWeatherSnapshots, { partial: true }).mockReturnValue({ data: [], isPending: false });
  vi.mocked(db.functions.invoke).mockResolvedValue({ data: RAW });
  db.entities.WeatherSnapshot.filter.mockResolvedValue([]);
  db.entities.WeatherSnapshot.bulkCreate.mockResolvedValue(undefined);
  db.entities.WeatherSnapshot.delete.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("WeatherPanel server-auth capability guard", () => {
  it("server-auth true + empty cache: zero unsupported calls, zero persists, honest unavailable", async () => {
    vi.stubEnv("VITE_USE_SERVER_AUTH", "true");
    renderPanel();
    const el = await screen.findByText("Live weather unavailable for this property/location.");
    expect(el).toBeTruthy();
    expect(db.functions.invoke).not.toHaveBeenCalled();
    expect(db.entities.WeatherSnapshot.bulkCreate).not.toHaveBeenCalled();
  });

  it("server-auth true + fresh cache: cached rows shown, zero fetch", async () => {
    vi.stubEnv("VITE_USE_SERVER_AUTH", "true");
    const rows = freshRows();
    expect(cacheIsFresh(rows, BIZ_DATE)).toBe(true);
    vi.mocked(useWeatherSnapshots, { partial: true }).mockReturnValue({ data: rows, isPending: false });
    renderPanel();
    // Cached current row feeds the Now card and (no feels_like stored) the
    // Feels-Like fallback; each card is bound by its own label.
    await waitForCards();
    expect(cardFor("Now").textContent).toContain("19°");
    expect(cardFor("Feels Like").textContent).toContain("19°");
    expect(db.functions.invoke).not.toHaveBeenCalled();
    expect(db.entities.WeatherSnapshot.bulkCreate).not.toHaveBeenCalled();
  });

  it("server-auth true + location save: stale cache dropped, no unsupported call", async () => {
    vi.stubEnv("VITE_USE_SERVER_AUTH", "true");
    vi.mocked(useWeatherSnapshots, { partial: true }).mockReturnValue({ data: freshRows(), isPending: false });
    renderPanel();
    await waitForCards();
    expect(cardFor("Now").textContent).toContain("19°");
    fireEvent.click(screen.getByText("Configure"));
    fireEvent.change(screen.getByPlaceholderText("Latitude"), { target: { value: "42" } });
    fireEvent.click(screen.getByText("Save"));
    const el = await screen.findByText("Live weather unavailable for this property/location.");
    expect(el).toBeTruthy();
    expect(db.functions.invoke).not.toHaveBeenCalled();
  });

  it.each(["false", "absent"])(
    "legacy flag %s: invokes getWeather with coords, normalizes api rows, persists",
    async (flag) => {
      if (flag === "absent") vi.stubEnv("VITE_USE_SERVER_AUTH", undefined);
      else vi.stubEnv("VITE_USE_SERVER_AUTH", "false");
      renderPanel();
      // Actual forecastRows drops feels_like, so the true Feels-Like value is
      // the current-temp fallback; humidity proves the api row is rendered.
      await waitForCards();
      expect(cardFor("Now").textContent).toContain("21°");
      expect(cardFor("Now").textContent).toContain("Sunny");
      expect(cardFor("Feels Like").textContent).toContain("21°");
      expect(cardFor("Feels Like").textContent).toContain("55%");
      expect(db.functions.invoke).toHaveBeenCalledTimes(1);
      expect(db.functions.invoke).toHaveBeenCalledWith("getWeather", { lat: 41.89, lon: -70.91 });
      expect(db.entities.WeatherSnapshot.bulkCreate).toHaveBeenCalledTimes(1);
      const persisted = db.entities.WeatherSnapshot.bulkCreate.mock.calls[0][0];
      expect(persisted.length).toBe(6);
      expect(persisted.some((r) => r.kind === "current")).toBe(true);
    }
  );

  it("portfolio: no fetch, prompts property selection", async () => {
    vi.stubEnv("VITE_USE_SERVER_AUTH", "true");
    vi.mocked(useGlobalFilters).mockReturnValue({ property: null, properties: [{ id: "p1" }, { id: "p2" }] });
    renderPanel();
    const el = await screen.findByText("Select one property to view weather.");
    expect(el).toBeTruthy();
    expect(db.functions.invoke).not.toHaveBeenCalled();
  });
});
