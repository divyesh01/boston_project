// Probe: the two emails this app sends must carry a USABLE way to set a password,
// and must never carry a plaintext password or a link to a domain we do not own.
//
// WHAT WENT WRONG, in plain terms. Two separate emails, two separate defects.
//
//   1. THE INVITE MAIL pointed at `https://your-app.com/reset-password?token=...`.
//      `your-app.com` is a placeholder nobody filled in, so every invited user got
//      a link to a stranger's domain — carrying their own live, single-use account
//      token. The invite could not be completed AND the token was handed to a third
//      party on the way.
//
//   2. THE RESET MAIL had no link at all: "Use this token: <64 hex characters>".
//      Someone locked out had to know to open the app, find the reset page, and
//      retype 64 characters. In practice they phone the owner and the owner reads
//      the credential aloud.
//
// WHY THE ORIGIN CANNOT COME FROM THE REQUEST. The obvious fix — build the link
// from the `Host` header — is a vulnerability, and this repo has already been bitten
// by it once (custom_auth_reset_request's `isLocalHost` used to be
// `.includes('localhost')`, which `localhost.evil.com` satisfied). The reset endpoint
// is unauthenticated: anyone can trigger a mail to any address. If the link is built
// from `Host`, an attacker sends `Host: evil.example` with a victim's email and the
// victim receives an ordinary-looking mail whose link delivers their live token to
// the attacker. Section 4 below asserts that a hostile Host header changes nothing.
//
// The origin therefore comes from the `APP_BASE_URL` secret, and both branches are
// tested here: configured (a real link) and unconfigured (a pasteable code, plus a
// warning). A one-branch probe would have passed against the broken code, because
// the broken code also "contained a token".
//
// Run: node scripts/probe-welcome-email.mjs

import { register } from "node:module";
register(new URL("./resolve-base44.mjs", import.meta.url));

const runtime = await import("./stubs/base44-runtime.mjs");
const sdk = await import("./stubs/base44-sdk.mjs");

const registerFn = (await import("../base44/functions/custom_auth_register/entry.js")).default;
const resetRequestFn = (await import("../base44/functions/custom_auth_reset_request/entry.js")).default;

let pass = 0;
let fail = 0;
const failures = [];

function ok(label, cond, detail = "") {
  if (cond) {
    pass += 1;
  } else {
    fail += 1;
    failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title) {
  console.log(`\n── ${title}`);
}

const CSRF = "test-csrf";
const PASSWORD = "MySuperSecretPassword123!";
const EMAIL = "owner@example.com";

// A 64-hex reset token, which is what randomBytes(32).toString('hex') produces.
const TOKEN_RE = /\b[0-9a-f]{64}\b/;

function makeReq({ body, host = "app.test", csrf = CSRF } = {}) {
  const headers = new Headers({
    "x-csrf-token": csrf,
    cookie: `__Host-csrf_token=${csrf}`,
    host,
  });
  return { headers, json: async () => body };
}

/**
 * Run one registration against a fresh in-memory backend and return the mail.
 * A fresh backend per case matters: the register function refuses a duplicate
 * email, so reusing one store would make every case after the first take the
 * "already registered" branch and send no mail at all — a green probe proving
 * nothing.
 */
async function invite({ appBaseUrl, host = "app.test", username = "owner1", email = EMAIL }) {
  const db = sdk.__installBackend({ users: [], sessions: [] });
  runtime.__clearSecrets();
  if (appBaseUrl) runtime.__setSecret("APP_BASE_URL", appBaseUrl);
  const res = await registerFn(makeReq({
    host,
    body: { userData: { username, email, password: PASSWORD, role: "owner" } },
  }));
  return { res, body: await res.json(), emails: db.__emails() };
}

/** Same, for a password-reset request against an existing active user. */
async function resetRequest({ appBaseUrl, host = "app.test", email = EMAIL }) {
  const db = sdk.__installBackend({
    users: [{
      id: "u1", username: "owner1", email, is_active: true, is_locked: false,
      role: "owner", password_hash: "$scrypt$deadbeef", salt: "00",
    }],
    sessions: [],
  });
  runtime.__clearSecrets();
  if (appBaseUrl) runtime.__setSecret("APP_BASE_URL", appBaseUrl);
  const res = await resetRequestFn(makeReq({ host, body: { identifier: email } }));
  return { res, body: await res.json(), emails: db.__emails() };
}

// ── 1. The invite mail, with an origin configured ───────────────────────────
section("1. Invite mail — APP_BASE_URL configured");
{
  const { res, body, emails } = await invite({ appBaseUrl: "https://rri.example.com" });
  ok("registration succeeds", res.status === 200 && body.success === true, JSON.stringify(body));
  ok("exactly one email is sent", emails.length === 1, `${emails.length} sent`);
  const mail = emails[0] || { body: "", to: "" };

  ok("addressed to the invited user", mail.to === EMAIL, mail.to);
  ok("carries a full reset LINK on the configured origin",
    mail.body.includes("https://rri.example.com/reset-password?token="), mail.body);
  ok("the link carries a real 64-hex token", TOKEN_RE.test(mail.body));
  ok("the placeholder domain is gone",
    !/your-app\.com/i.test(mail.body),
    "the original defect: every invite linked to a domain nobody owns");
  ok("the plaintext password is NOT in the body", !mail.body.includes(PASSWORD));
  ok("the response reports that a link was sent", body.invite_link === true, JSON.stringify(body));
  ok("the response reports the mail was sent", body.invite_email_sent === true, JSON.stringify(body));
  ok("the response does NOT return the token itself",
    !TOKEN_RE.test(JSON.stringify(body)),
    "a single-use credential belongs in the mailbox that proves the address, not in an API reply");
}

// ── 2. The invite mail, with NO origin configured ───────────────────────────
section("2. Invite mail — APP_BASE_URL missing (fail soft, loudly)");
{
  const { res, body, emails } = await invite({ appBaseUrl: null, username: "owner2", email: "owner2@example.com" });
  ok("registration still succeeds", res.status === 200 && body.success === true, JSON.stringify(body));
  const mail = emails[0] || { body: "" };
  ok("an email is still sent", emails.length === 1, `${emails.length} sent`);
  ok("it carries the one-time code so a reset is still possible", TOKEN_RE.test(mail.body), mail.body);
  ok("it explains why there is no link", /APP_BASE_URL/.test(mail.body), mail.body);
  ok("it does NOT invent a domain",
    !/https?:\/\//.test(mail.body),
    "guessing the domain is how host-header injection works; no link is safer than a wrong one");
  ok("the plaintext password is NOT in the body", !mail.body.includes(PASSWORD));
  ok("the response flags the missing link", body.invite_link === false, JSON.stringify(body));
}

// ── 3. The reset mail, both branches ────────────────────────────────────────
section("3. Reset mail");
{
  const withOrigin = await resetRequest({ appBaseUrl: "https://rri.example.com" });
  ok("reset request succeeds", withOrigin.res.status === 200, String(withOrigin.res.status));
  const mail = withOrigin.emails[0] || { body: "" };
  ok("one reset email is sent", withOrigin.emails.length === 1, `${withOrigin.emails.length} sent`);
  ok("carries a full reset LINK on the configured origin",
    mail.body.includes("https://rri.example.com/reset-password?token="), mail.body);
  ok("the link carries a real 64-hex token", TOKEN_RE.test(mail.body));
  ok("says what to do if it was not you",
    /was not you/i.test(mail.body),
    "an unexpected reset mail is the first sign of an attempted takeover");

  const withoutOrigin = await resetRequest({ appBaseUrl: null });
  const mail2 = withoutOrigin.emails[0] || { body: "" };
  ok("without an origin, the code is still delivered", TOKEN_RE.test(mail2.body), mail2.body);
  ok("without an origin, no domain is invented", !/https?:\/\//.test(mail2.body), mail2.body);
}

// ── 4. A hostile Host header must not reach the link ────────────────────────
section("4. Host header cannot steer the link (host-header injection)");
{
  // The attack: an unauthenticated caller triggers a reset for a victim and
  // supplies their own Host. If the link were built from it, the victim's live
  // token would be delivered to the attacker's server by the victim's own click.
  const hostile = "evil.example";
  const cases = [
    { name: "invite", run: () => invite({ appBaseUrl: "https://rri.example.com", host: hostile, username: "owner3", email: "owner3@example.com" }) },
    { name: "reset", run: () => resetRequest({ appBaseUrl: "https://rri.example.com", host: hostile }) },
  ];
  for (const c of cases) {
    const { emails } = await c.run();
    const body = (emails[0] || { body: "" }).body;
    ok(`${c.name}: the attacker's host does not appear in the mail`,
      !body.includes(hostile), body);
    ok(`${c.name}: the link still points at the configured origin`,
      body.includes("https://rri.example.com/reset-password?token="), body);
  }

  // And with NO configured origin, a hostile Host must not become the fallback.
  const { emails } = await resetRequest({ appBaseUrl: null, host: hostile });
  ok("unconfigured + hostile host: still no link at all",
    !/https?:\/\//.test((emails[0] || { body: "" }).body),
    (emails[0] || { body: "" }).body);
}

// ── 5. A malformed or unsafe APP_BASE_URL is refused, not used ──────────────
section("5. APP_BASE_URL validation");
{
  const bad = [
    ["not a url at all", "rri.example.com"],
    ["plain http on a public host", "http://rri.example.com"],
    ["a javascript: scheme", "javascript:alert(1)"],
    ["an empty string", "   "],
  ];
  for (const [label, value] of bad) {
    const { emails } = await resetRequest({ appBaseUrl: value });
    const body = (emails[0] || { body: "" }).body;
    ok(`refuses ${label} and falls back to the code`,
      !/https?:\/\//.test(body) && TOKEN_RE.test(body),
      `${label} -> ${body.slice(0, 120)}`);
  }
  // http IS allowed on loopback, because that is a developer's own machine and
  // there is no network for the token to cross.
  const local = await resetRequest({ appBaseUrl: "http://localhost:5173" });
  ok("allows http on localhost (a developer's own machine)",
    (local.emails[0] || { body: "" }).body.includes("http://localhost:5173/reset-password?token="),
    (local.emails[0] || { body: "" }).body);
  // A path or query pasted into the setting must not survive: only the origin is
  // used, so it cannot alter what the link means.
  const messy = await resetRequest({ appBaseUrl: "https://rri.example.com/some/path?x=1" });
  ok("keeps only the origin from a pasted URL with a path",
    (messy.emails[0] || { body: "" }).body.includes("https://rri.example.com/reset-password?token="),
    (messy.emails[0] || { body: "" }).body);
}

// ── 6. The two copies of appOrigin() have not drifted ──────────────────────
section("6. APP_ORIGIN_V1 exists in both functions and matches");
{
  // The base44 host allows no module sharing between functions, so this helper
  // necessarily exists twice. Comments asking for lockstep are not a mechanism;
  // this is. Compare the function bodies character-for-character after
  // whitespace normalisation.
  const { readFileSync } = await import("node:fs");
  const path = await import("node:path");
  const { REPO_ROOT } = await import("./_repo-root.mjs");
  const read = (p) => readFileSync(path.join(REPO_ROOT, p), "utf8");
  const files = [
    "base44/functions/custom_auth_register/entry.js",
    "base44/functions/custom_auth_reset_request/entry.js",
  ];
  const bodies = files.map((f) => {
    const src = read(f);
    ok(`${path.basename(path.dirname(f))} carries the APP_ORIGIN_V1 marker`,
      src.includes("APP_ORIGIN_V1"));
    const m = src.match(/function appOrigin\(\)\s*\{[\s\S]*?\n\}/);
    ok(`${path.basename(path.dirname(f))} defines appOrigin()`, !!m);
    return m ? m[0].replace(/\s+/g, " ").trim() : `MISSING:${f}`;
  });
  ok("both copies of appOrigin() are identical", bodies[0] === bodies[1],
    "they have drifted — one function will build a link the other refuses");
}

console.log(`\n─── RESULT: ${pass} passed, ${fail} failed ───`);
if (fail > 0) {
  console.log(`Failures:\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
console.log("PASSED: both emails carry a usable, non-forgeable way to set a password.");
process.exit(0);
