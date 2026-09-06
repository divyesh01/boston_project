// scripts/_cloudflare-transient.mjs — the known-transient Cloudflare outage
// signature for F-076.
//
// WHY THIS IS ITS OWN FILE. The remote Worker-auth probe must SKIP (not FAIL)
// when Cloudflare's control plane transiently refuses the pre-assertion
// temporary-D1 provisioning call, and that decision has to be unit-testable.
// The probe module itself cannot be imported — it provisions real Cloudflare
// resources at import time — so the classifier lives here, next to
// _verdict.mjs and _repo-root.mjs, which exist for the same importability
// reason. Leading `_` keeps it out of the verify-all discovery walks.
//
// SCOPE. Only the exact signature observed on a valid token counts: HTTP 401
// `Authentication error [code: 10000]` on the D1 create call (measured
// 2026-09-01/03: byte-identical command failed then succeeded 27s later, and
// the unchanged suite passed 8/8 on retry). A different code, a bare
// "Authentication error" with no code, or the same words from any other call
// are NOT transient — they fail loudly. Call-site scoping (only the d1-create
// catch consults this) is enforced by the probe, not here.
export function isTransientD1ProvisioningOutage(error) {
  const text = String(error?.message ?? error ?? '');
  return /Authentication error\s*\[code:\s*10000\]/.test(text);
}
