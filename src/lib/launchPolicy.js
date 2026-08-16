// Who may sign in to this release.
//
// Every entity read and write in this app is Dexie/IndexedDB inside the user's
// own browser (see LAUNCH_READINESS_CHECKLIST.md B5). There is no server-side
// entity path, so `db.entities`' property scoping is a correctness and
// least-surprise control, not a boundary an adversary cannot step around: anyone
// signed in can open devtools and read the raw tables.
//
// The owner's decision for this launch is therefore to admit only accounts that
// are already entitled to every property. For those accounts there is no
// confidentiality boundary left to breach, so the client-side scoping does not
// have to hold against an attacker — it only has to be right.
//
// Per-property accounts stay creatable in the Users page (their access still
// governs what the UI shows if this gate is ever lifted), but they cannot sign
// in. Lifting the gate requires moving entity reads behind server-side
// authorization first.
//
// LAUNCH_POLICY_V1 = owner | admin | property_access === 'all'
// The same rule is enforced server-side in
// base44/functions/custom_auth_login/entry.js. Keep the two in step: the server
// copy is authoritative, this one keeps a stale local session from outliving it.

export const ALL_PROPERTY_REQUIRED_MESSAGE =
  'This account is limited to specific properties. This release supports accounts with access to all properties only — ask an owner to widen this account.';

// A stable machine code for the refusal. Login.jsx flattens every other login
// error to "Invalid email or password" so it cannot be used to enumerate
// accounts; this code is how it recognises the one refusal it IS safe to show
// verbatim (the caller has already proven they hold the credentials). Matching
// on the sentence above would break the moment anyone rewords it.
// The server sends the same string in the `code` field of its 403 body.
export const ALL_PROPERTY_REQUIRED_CODE = 'ALL_PROPERTY_ACCESS_REQUIRED';

/** The refusal thrown by the offline login shim. @returns {Error & { code: string }} */
export function allPropertyRequiredError() {
  const err = /** @type {Error & { code: string }} */ (new Error(ALL_PROPERTY_REQUIRED_MESSAGE));
  err.code = ALL_PROPERTY_REQUIRED_CODE;
  return err;
}

/**
 * True when `user` is entitled to every property.
 *
 * An array that happens to list every property today is deliberately NOT
 * "all": the roster can grow, and the grant would silently stop covering it.
 *
 * @param {{ role?: string, property_access?: unknown } | null | undefined} user
 */
export function hasAllPropertyAccess(user) {
  if (!user) return false;
  if (user.role === 'owner' || user.role === 'admin') return true;
  return user.property_access === 'all';
}
