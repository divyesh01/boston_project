import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";

// The shims below are deliberate PARTIAL doubles, so each assignment carries its
// own `any` cast: Node's WebCrypto stands in for the DOM `Crypto`, a Map stands
// in for `Storage` (no `length`/`key` — nothing under test reads them), and
// `screen` only needs width/height. The casts are scoped to these four lines so
// the rest of the file stays fully type-checked.
globalThis.crypto ??= /** @type {any} */ (await import("node:crypto").then((m) => m.webcrypto));
if (!globalThis.crypto?.subtle) globalThis.crypto = /** @type {any} */ (await import("node:crypto").then((m) => m.webcrypto));

const __store = new Map();
const __storage = {
  getItem: (k) => (__store.has(k) ? __store.get(k) : null),
  setItem: (k, v) => __store.set(k, String(v)),
  removeItem: (k) => __store.delete(k),
  clear: () => __store.clear(),
};
globalThis.localStorage = /** @type {any} */ (__storage);
globalThis.sessionStorage = /** @type {any} */ (__storage);
globalThis.window = /** @type {any} */ (globalThis);
globalThis.screen = /** @type {any} */ ({ width: 1920, height: 1080 });
if (globalThis.navigator === undefined) {
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: "test-harness", language: "en-US" },
    configurable: true,
  });
}

const { db } = await import("@/api/base44Client");
const { default: localDb } = await import("@/api/localDb");

// The owner fixture. Same SHAPE as a real Setup.jsx submit, deliberately not the
// same VALUES.
//
// This used to hardcode the repository owner's personal email address. Nothing
// in the test needed it — `db.auth.login` only cares that the string it is given
// matches the string that was registered — so the only thing the real address
// added was a permanent copy of the owner's identity in a tracked file and in
// every clone of the repo. A test that names a real person is a test that leaks
// one.
//
// `@test.local` is a reserved, non-routable domain (RFC 6761), so this address
// can never resolve to a real mailbox even if a future test is wired to send
// mail. The password is a fixture value, not anyone's credential; it is long
// enough to satisfy validatePasswordStrength (12+ chars, upper, lower, digit,
// symbol) so the registration path under test is the real one and not the
// rejection path. scripts/probe-no-real-credentials.mjs fails if a routable
// address or a credential-shaped literal reappears here.
const OWNER = {
  username: "owner",
  email: "owner@test.local",
  password: "MockSecurePass#2026",
  full_name: "Test Owner",
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
    await expect(db.auth.login("nobody@test.local", OWNER.password)).rejects.toThrow(/Invalid email or password/);
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
