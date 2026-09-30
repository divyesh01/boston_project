import { describe, it, expect, vi } from "vitest";
import {
  buildDemoForecast,
  forecastRows,
  cacheIsFresh,
  fetchOpenWeatherForecast,
  loadWeather,
} from "@/lib/weatherService";

describe("Weather Service (R14)", () => {
  it("buildDemoForecast generates current, hourly, and 5 daily entries", () => {
    const demo = buildDemoForecast(41.89, -70.91, "2026-03-30");
    expect(demo.current).toBeDefined();
    expect(typeof demo.current.temp).toBe("number");
    expect(demo.hourly).toHaveLength(8);
    expect(demo.daily).toHaveLength(5);

    for (const d of demo.daily) {
      expect(typeof d.dt).toBe("number");
      expect(typeof d.temp.day).toBe("number");
      expect(typeof d.temp.min).toBe("number");
      expect(typeof d.temp.max).toBe("number");
      expect(d.weather[0].main).toBeDefined();
    }
  });

  it("forecastRows maps OneCall payload with current and daily entries", () => {
    const rawOneCall = {
      current: { temp: 18, humidity: 50, wind_speed: 4, weather: [{ main: "Clear", description: "sunny", icon: "01d" }] },
      daily: [
        { dt: 1774968000, temp: { day: 19, min: 10, max: 22 }, weather: [{ main: "Clouds", description: "cloudy", icon: "02d" }], humidity: 55, wind_speed: 3 },
        { dt: 1775054400, temp: { day: 20, min: 12, max: 24 }, weather: [{ main: "Clear", description: "sunny", icon: "01d" }], humidity: 50, wind_speed: 4 },
      ],
    };

    const rows = forecastRows("prop-1", "2026-03-30", rawOneCall);
    expect(rows).toHaveLength(3); // 1 current + 2 forecast

    const current = rows.find((r) => r.kind === "current");
    expect(current).toBeDefined();
    expect(current.temp).toBe(18);
    expect(current.condition).toBe("Clear");

    const forecasts = rows.filter((r) => r.kind === "forecast");
    expect(forecasts).toHaveLength(2);
    expect(forecasts[0].temp_max).toBe(22);
    expect(forecasts[0].condition).toBe("Clouds");
  });

  it("forecastRows normalizes standard 5-day / 3-hour (raw.list) payload", () => {
    const rawList = {
      current: { temp: 15, humidity: 65, wind_speed: 5, weather: [{ main: "Rain", description: "light rain", icon: "10d" }] },
      list: [
        // Day 1
        { dt: 1774968000, main: { temp: 16, temp_min: 14, temp_max: 18, humidity: 70 }, wind: { speed: 5 }, weather: [{ main: "Rain" }] },
        { dt: 1774978800, main: { temp: 17, temp_min: 15, temp_max: 19, humidity: 68 }, wind: { speed: 6 }, weather: [{ main: "Rain" }] },
        // Day 2
        { dt: 1775054400, main: { temp: 20, temp_min: 16, temp_max: 22, humidity: 50 }, wind: { speed: 4 }, weather: [{ main: "Clear" }] },
      ],
    };

    const rows = forecastRows("prop-1", "2026-03-30", rawList);
    const forecasts = rows.filter((r) => r.kind === "forecast");
    expect(forecasts).toHaveLength(2);
    expect(forecasts[0].temp_max).toBe(19);
    expect(forecasts[0].temp_min).toBe(14);
    expect(forecasts[1].temp_max).toBe(22);
  });

  it("forecastRows works completely with demo forecast", () => {
    const demo = buildDemoForecast(41.89, -70.91, "2026-03-30");
    const rows = forecastRows("prop-1", "2026-03-30", demo);
    expect(rows.length).toBe(6); // 1 current + 5 daily
    expect(rows.filter((r) => r.kind === "forecast")).toHaveLength(5);
  });

  it("fetchOpenWeatherForecast validates coordinates", async () => {
    await expect(fetchOpenWeatherForecast({ lat: "not-a-number", lon: -70.91, invoke: vi.fn() }))
      .rejects.toThrow(/Invalid coordinates/);
    await expect(fetchOpenWeatherForecast({ lat: 41.89, lon: null, invoke: vi.fn() }))
      .rejects.toThrow(/Invalid coordinates/);
  });

  it("cacheIsFresh respects business date and TTL", () => {
    const now = Date.now();
    expect(cacheIsFresh([], "2026-03-30", now)).toBe(false);

    const freshRows = [{ date: "2026-03-30", created_date: new Date(now - 10 * 60 * 1000).toISOString() }];
    expect(cacheIsFresh(freshRows, "2026-03-30", now)).toBe(true);

    // Stale: older than 30 mins
    const staleRows = [{ date: "2026-03-30", created_date: new Date(now - 45 * 60 * 1000).toISOString() }];
    expect(cacheIsFresh(staleRows, "2026-03-30", now)).toBe(false);

    // Stale: different date
    expect(cacheIsFresh(freshRows, "2026-03-31", now)).toBe(false);
  });
});
