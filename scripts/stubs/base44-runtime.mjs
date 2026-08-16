// Test stub for the `base44:runtime` module that only exists inside the base44
// serverless host. Resolved by scripts/resolve-base44.mjs so probes can execute
// the REAL function entry files (base44/functions/*/entry.js) in plain Node.
//
// Only the surface those functions actually use is implemented: secrets.get().
// The probe controls the secret store, which is the whole point — the audit
// chain's behaviour with a MISSING AUDIT_CHAIN_SECRET is a thing we must be able
// to test, and in the real host you cannot unset a secret from inside a test.

const store = new Map();

export const secrets = {
  get(name) {
    return store.has(name) ? store.get(name) : undefined;
  },
};

/** Set (or with value === null, unset) a secret for the next handler call. */
export function __setSecret(name, value) {
  if (value === null || value === undefined) store.delete(name);
  else store.set(name, value);
}

export function __clearSecrets() {
  store.clear();
}
