// Give a Node harness an authenticated, all-property identity.
//
// Why every harness that touches db.entities now needs this: property scoping in
// src/api/base44Client.js used to FAIL OPEN — an unauthenticated caller resolved
// to "no restriction" and read every row in the database. That was blocker B3,
// and it is why these suites passed for years without ever signing in.
//
// Now that resolution fails CLOSED, an unauthenticated harness sees an empty
// database and its writes are refused with "Access denied: Cannot create records
// for unauthorized property". So the suites have to say who they are.
//
// This deliberately goes through the real db.auth.login(), not a hand-written
// session record: it exercises the launch gate in the same direction production
// does, so if that gate ever starts refusing owners, these suites fail loudly
// instead of quietly testing a path no real user can reach.
//
// Usage — after any DB reset/seed, before the first db.entities call:
//
//   import { signInAsAllPropertyOwner } from "./_harness-auth.mjs";
//   await signInAsAllPropertyOwner();
//
// Call it again after anything that clears the User table or localStorage
// (localDb.delete(), a full tables.map(t => t.clear()), localStorage.clear()) —
// both the user row and the session record live in exactly those places.
// It is idempotent, so calling it twice is free.

const OWNER_ID = "harness_owner";
const EMAIL = "harness-owner@probe.local";
const PASSWORD = "Harness-Owner-Password-1!";
// 32 hex chars: browserHashPassword reads the salt as hex.
const SALT = "0123456789abcdef0123456789abcdef";

export async function signInAsAllPropertyOwner() {
  // Relative specifiers, not the "@/" alias: some harnesses run without
  // scripts/resolve-alias.mjs registered. Both spellings resolve to the same
  // file URL, so this is still the same module instance (and the same open Dexie
  // connection) the calling harness is using.
  const localDb = (await import("../src/api/localDb.js")).default;
  const { db, invalidatePropertyAccess, browserHashPassword } = await import("../src/api/base44Client.js");

  const password_hash = "$pbkdf2$" + (await browserHashPassword(PASSWORD, SALT));
  const row = {
    id: OWNER_ID,
    username: "harness_owner",
    email: EMAIL,
    full_name: "Harness Owner",
    role: "owner",
    property_access: "all",
    is_active: true,
    is_locked: false,
    mfa_enabled: false,
    failed_login_count: 0,
    salt: SALT,
    password_hash,
    created_date: new Date().toISOString(),
  };

  const existing = await localDb.User.get(OWNER_ID);
  if (existing) await localDb.User.update(OWNER_ID, row);
  else await localDb.User.add(row);

  await db.auth.login(EMAIL, PASSWORD);
  // The authorization snapshot is cached for 30s; login through functions.invoke
  // already drops it, but a harness that wrote the user row directly may have a
  // stale "signed out" snapshot from before. Cheap insurance either way.
  invalidatePropertyAccess();

  const me = await db.auth.me();
  if (!me || me.id !== OWNER_ID) {
    throw new Error(
      `[_harness-auth] sign-in did not take effect (auth.me() => ${JSON.stringify(me)}). ` +
      `Every db.entities read after this point would return zero rows and every write would be refused.`,
    );
  }
  return me;
}
