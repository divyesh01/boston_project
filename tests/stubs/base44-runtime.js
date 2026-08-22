// Test-only stand-in for base44's `base44:runtime` module.
//
// The deployed functions in base44/functions/** run on base44's Deno runtime and
// import `secrets` from the bare specifier "base44:runtime" (16 call sites). That
// specifier is resolved by the platform, not by npm, so under vitest it cannot
// resolve at all and the suite dies at import with a resolution error before a
// single assertion runs — the "broken, not failing" case. vitest.config.js aliases
// the specifier to this file so the suites can load.
//
// The specifier is deliberately NOT changed in base44/functions/**: Deno needs it
// spelled exactly as it is, and custom_auth_login/entry.js:204 plus
// custom_user_admin/entry.js:311 both record that the signed audit payload depends
// on those import lines staying character-for-character identical.
//
// `get` returns a fixed, obviously-fake value rather than a real-looking one so
// that a test which accidentally depends on a secret's CONTENT reads as fake in
// the failure output instead of looking plausible. A test that needs specific
// secret behaviour should still `vi.mock("base44:runtime", ...)` itself — vi.mock
// takes precedence over a resolve alias, so per-test mocks keep working.
export const secrets = {
  get: (name) => `test-secret-value-for:${name}`,
};

export default { secrets };
