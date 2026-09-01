import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("server-backed auth client wiring", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("VITE_USE_SERVER_AUTH", "true");
    vi.stubEnv("VITE_USE_D1_API", "false");
    vi.stubEnv("VITE_USE_LOCAL_AUTH", "true");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("submits the credential, then reads the HttpOnly-backed session", async () => {
    const user = { id: "U_SHARED", email: "shared@test.local", role: "owner" };
    const fetchMock = vi.fn(async (url) => {
      if (url === "/api/auth/login") return new Response(JSON.stringify({ authenticated: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
      if (url === "/api/session") return new Response(JSON.stringify({ authenticated: true, user }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
      return new Response(JSON.stringify({ error: "unexpected test request" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { db } = await import("@/api/base44Client");
    const result = await db.auth.login("shared@test.local", "MockSecurePass#2026", true, "123456");

    expect(result).toEqual({ user, session: { token: "http-only" } });
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/login", expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      body: JSON.stringify({
        identifier: "shared@test.local",
        password: "MockSecurePass#2026",
        remember: true,
        totpToken: "123456",
      }),
    }));
    expect(fetchMock).toHaveBeenCalledWith("/api/session", expect.objectContaining({ credentials: "same-origin" }));
  }, 15_000);

  it("logs out through the app session endpoint instead of Cloudflare Access", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { db } = await import("@/api/base44Client");
    await db.auth.logout();

    expect(fetchMock).toHaveBeenCalledWith("/api/auth/logout", expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      body: "{}",
    }));
  });

  it("keeps hotel entities in IndexedDB when server authentication is enabled", async () => {
    const user = { id: "U_OWNER", email: "owner@test.local", role: "owner", property_access: "all" };
    const fetchMock = vi.fn(async (url) => {
      if (url === "/api/session") return new Response(JSON.stringify({ authenticated: true, initialized: true, user }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
      return new Response(JSON.stringify({ error: "business API must remain disabled" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const [{ db }, { default: localDb }] = await Promise.all([
      import("@/api/base44Client"),
      import("@/api/localDb"),
    ]);
    await localDb.Property.clear();
    const created = await db.entities.Property.create({ code: "LOCAL-ONLY", name: "Browser Hotel" });
    const stored = await localDb.Property.get(created.id);

    expect(stored).toMatchObject({ code: "LOCAL-ONLY", name: "Browser Hotel" });
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith("/api/entities/"))).toBe(false);
  }, 15_000);
});
