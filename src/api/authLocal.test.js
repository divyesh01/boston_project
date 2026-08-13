import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";

globalThis.crypto ??= await import("node:crypto").then((m) => m.webcrypto);
if (!globalThis.crypto?.subtle) globalThis.crypto = await import("node:crypto").then((m) => m.webcrypto);

const __store = new Map();
const __storage = {
  getItem: (k) => (__store.has(k) ? __store.get(k) : null),
  setItem: (k, v) => __store.set(k, String(v)),
  removeItem: (k) => __store.delete(k),
  clear: () => __store.clear(),
};
globalThis.localStorage = __storage;
globalThis.sessionStorage = __storage;
globalThis.window = globalThis;
globalThis.screen = { width: 1920, height: 1080 };
if (globalThis.navigator === undefined) {
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: "test-harness", language: "en-US" },
    configurable: true,
  });
}

const { db } = await import("@/api/base44Client");
const { default: localDb } = await import("@/api/localDb");

// Mirrors the exact credentials the owner uses (same shape as Setup.jsx submit).
const OWNER = {
  username: "owner",
  email: "divyesh.boston@gmail.com",
  password: "22112004@Djvp",
  full_name: "Divyesh",
};

async function registerOwner() {
  await db.auth.registerUser({
    username: OWNER.username,
    email: OWNER.email,
    full_name: OWNER.full_name,
    role: "owner",
    permissions: "all",
    property_access: "all",
    is_active: true,
    password: OWNER.password,
    must_change_password: false,
  });
}

beforeEach(async () => {
  await localDb.open();
  await Promise.all(localDb.tables.map((t) => t.clear()));
  localStorage.clear();
  sessionStorage.clear();
});

describe("local owner auth lifecycle (setup → login → me → logout)", () => {
  it("setup: initialized() is false before any owner exists", async () => {
    expect(await db.users.initialized()).toBe(false);
  });

  it("registerUser creates the owner and initialized() flips to true", async () => {
    await registerOwner();
    expect(await db.users.initialized()).toBe(true);

    const users = await localDb.User.toArray();
    expect(users).toHaveLength(1);
    expect(users[0].role).toBe("owner");
    expect(users[0].email).toBe(OWNER.email);
    expect(users[0].password_hash.startsWith("$pbkdf2$")).toBe(true);
    // Password hash must never be exposed to the client
    expect(users[0].password_hash).not.toContain(OWNER.password);
  });

  it("registerUser rejects a second owner (bootstrap-only)", async () => {
    await registerOwner();
    await expect(
      db.auth.registerUser({
        username: "second",
        email: "second@test.local",
        role: "owner",
        password: "Another!Pass2026",
      }),
    ).rejects.toThrow();
  });

  it("login succeeds with the correct password (Setup.jsx then calls login immediately)", async () => {
    await registerOwner();
    const result = await db.auth.login(OWNER.email, OWNER.password, true);
    expect(result.user).toBeTruthy();
    expect(result.user.email).toBe(OWNER.email);
    expect(result.user.role).toBe("owner");
  });

  it("login also works with the username instead of email", async () => {
    await registerOwner();
    const result = await db.auth.login(OWNER.username, OWNER.password, true);
    expect(result.user).toBeTruthy();
  });

  it("login fails with a wrong password and never leaks the hash", async () => {
    await registerOwner();
    await expect(db.auth.login(OWNER.email, "WrongPass!2026")).rejects.toThrow(/Invalid email or password/);
  });

  it("login fails when the email does not exist", async () => {
    await registerOwner();
    await expect(db.auth.login("nobody@gmail.com", OWNER.password)).rejects.toThrow(/Invalid email or password/);
  });

  it("me() returns the logged-in user, then logout clears the session", async () => {
    await registerOwner();
    await db.auth.login(OWNER.email, OWNER.password, true);

    expect(await db.auth.isAuthenticated()).toBe(true);
    const me = await db.auth.me();
    expect(me.email).toBe(OWNER.email);
    expect(me.password_hash).toBeUndefined();

    await db.auth.logout();
    expect(await db.auth.isAuthenticated()).toBe(false);
    expect(await db.auth.me()).toBeNull();
  });
});
