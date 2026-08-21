// Shared by the auth pages (Login, Register, and any page that resumes a flow
// after sign-in, e.g. the MCP OAuth consent page). Keep the redirect
// validation in one place — it is security-sensitive and easy to drift.

// Resolve ?returnTo= to a safe same-origin path, else "/".
//
// The same-origin check alone is not enough: a value like /.//evil.com or
// /\evil.com parses same-origin but normalizes to a protocol-relative
// //evil.com when assigned to location.href — an open redirect. So require the
// resolved path to be exactly one leading slash (no "//" prefix, no backslash).
export function safeReturnTo() {
  const raw = new URLSearchParams(window.location.search).get("returnTo");
  if (!raw) return "/dashboard";
  try {
    const url = new URL(raw, window.location.origin);
    if (url.origin !== window.location.origin) return "/";
    // Strip the app-bootstrap params, so a crafted returnTo cannot poison the
    // session that is about to be issued. Normal app-flow params (e.g. the OAuth
    // consent ctx) are kept.
    //
    // access_token is the live one, and the mechanism is in the SDK, not in this
    // repo: createClient() calls getAccessToken() while constructing
    // (node_modules/@base44/sdk/dist/client.js), and that helper
    // (dist/utils/auth-utils.js) reads ?access_token= from the URL, writes it to
    // localStorage under both 'base44_access_token' and 'token', then hides the
    // parameter with history.replaceState. Nothing in this app issues a base44
    // bearer token, so a value there is always someone else's.
    //
    // src/api/base44Client.js#refuseUrlSuppliedAccessToken now drops that
    // parameter before the SDK is constructed, which covers the direct-link case
    // this function cannot see. This list stays as the second layer on the
    // post-login hop, and it is deliberately wider than that one parameter:
    // app_id, app_base_url, functions_version and from_url are the bootstrap set
    // read by src/lib/app-params.js, whose getAppParamValue() prefers a URL
    // parameter over the configured value and persists it with no validation on
    // app_id or functions_version. That module has no importer today, so it is
    // tree-shaken out and cannot run — but it is one `import` away from being a
    // repoint-the-client vulnerability, and stripping the params costs nothing.
    // scripts/probe-app-config.mjs fails if anything starts importing it.
    for (const p of ["access_token", "clear_access_token", "app_id", "app_base_url", "functions_version", "from_url"]) {
      url.searchParams.delete(p);
    }
    const path = url.pathname + url.search;
    if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return "/";
    return path;
  } catch {
    return "/";
  }
}
