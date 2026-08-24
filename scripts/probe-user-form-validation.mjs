// Probe: the Users admin form must not report normalisation as invalid input,
// and the password help it prints must be the policy it will be judged against.
//
// WHAT WAS WRONG (tracker #49, #50, #51).
//
// 1. `Users.jsx` sanitised each field and treated ANY difference between the raw
//    input and the sanitised value as proof of bad input:
//
//        const sanitizedUsername = sanitizeAlphanumeric(form.username);
//        const sanitizedEmail = sanitizeEmail(form.email);
//        if (sanitizedUsername !== form.username || sanitizedEmail !== form.email) {
//          toast({ description: "Invalid characters in username or email." });
//          return;
//        }
//
//    `sanitizeEmail` *normalises* — it trims and lowercases. So `Divyesh@Example.com`
//    differed from its sanitised form and was refused for "invalid characters",
//    a message that is untrue, names neither field, and asks the admin to fix
//    capitalisation that every other login form on earth accepts. Section 1.
//
// 2. The same two handlers held eight bare early returns, so an admin learned one
//    problem per submit and each attempt pushed another toast onto a stack that
//    never expires (tracker #52). Section 2.
//
// 3. Both password fields advertised "At least 8 characters, upper/lowercase +
//    number" while `validatePasswordStrength` demands twelve characters, a symbol,
//    and no character three times in a row. Following the placeholder exactly got
//    you refused, one clause per attempt. Section 4.
//
// 4. The "Require password change at next login" switch was decorative: the create
//    call hard-coded `must_change_password: true`. Section 5.
//
// 5. The dialog promised "A temporary password will be generated." and then made
//    the admin invent one. `generateTemporaryPassword` existed and was wired only
//    into the reset dialog. Section 5.
//
// WHAT THIS PROBE PINS. Sections 1-3 and 6-8 exercise `validateUserForm` and the
// protected predicates it delegates to. Section 4 is the anti-drift test for
// PASSWORD_HELP: it derives one counter-example per described clause and fails if
// the text and the policy ever disagree. Section 5 reads the two pages as text,
// because a hard-coded `true` and a lying placeholder are properties of the source
// that no amount of module testing can see.
//
// Run: node --import ./scripts/_loader-boot.mjs scripts/probe-user-form-validation.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// Anti-regression string searches must look at CODE, not at comments.
//
// The first run of this probe failed twice, both times on itself: the header of
// `userFormValidation.js` quotes the old placeholder verbatim to explain what was
// wrong, and `handleGeneratePassword` quotes the old dialog sentence for the same
// reason. A search that cannot tell a defect from a description of a defect
// punishes documenting the defect — which is the one thing this repo most wants to
// keep doing. So the searches below run over comment-stripped source.
//
// The rule is deliberately crude (drop lines whose first non-space characters are
// `//`, `*`, `/*` or `{/*`) because every comment in this codebase is written that
// way, and a real parser would be a second thing to get wrong.
const codeOnly = (src) => src.split(/\r?\n/).filter((line) => {
  const t = line.trim();
  return t && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*") && !t.startsWith("{/*");
}).join("\n");

// `sanitizeText` is DOMPurify-backed, and DOMPurify without a real DOM exports an
// object with no `.sanitize` at all — it does not degrade, it throws. A stub that
// returned its input would make section 7 prove nothing, so the real sanitiser
// runs against jsdom, already a declared devDependency. Only `window` is
// replaced; _loader-boot.mjs's `document`/`location` shims stay because the SDK
// and axios are keyed to them, and DOMPurify reads `window.document`.
if (typeof globalThis.window?.document?.createElement !== "function") {
  let JSDOM;
  try {
    ({ JSDOM } = await import("jsdom"));
  } catch (err) {
    console.log("\nFATAL: jsdom could not be loaded, so the real DOMPurify-backed");
    console.log("sanitiser cannot run and section 7 would be vacuous.");
    console.log("jsdom is a declared devDependency — run `npm install`.");
    console.log(`  ${err?.message}`);
    process.exit(1);
  }
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
  globalThis.window = dom.window;
}

const { validateUserForm, USERNAME_RULE, EMAIL_RULE, PASSWORD_HELP } =
  await import("@/lib/userFormValidation");
const { sanitizeEmail, sanitizeAlphanumeric, sanitizeText, sanitizeCsvCell } =
  await import("@/lib/securityUtils");
const { isValidEmail, isValidUsername } = await import("@/lib/validator");
const { validatePasswordStrength, generateTemporaryPassword } = await import("@/lib/security");

let pass = 0;
let fail = 0;
const failures = [];

function ok(label, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  PASS ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    failures.push(label);
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function eq(label, actual, expected) {
  ok(label, actual === expected, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

// Before anything relies on it: the sanitiser must be the real one. A
// pass-through stub satisfies every assertion in section 7 while removing the
// guarantee those assertions exist to check.
{
  console.log("\n=== 0. the sanitiser under test is the real DOMPurify ===");
  const stripped = sanitizeText("<script>x()</script>keep");
  ok("sanitizeText removes a <script> element", !stripped.includes("<script") && stripped.includes("keep"), JSON.stringify(stripped));
}

// ── 1. Normalisation is not a validity signal ────────────────────────────────
{
  console.log("\n=== 1. the reported defect: normalisation was read as invalid input ===");

  // The old gate, reproduced exactly. This is the expression that shipped.
  const oldGate = (rawUsername, rawEmail) =>
    sanitizeAlphanumeric(rawUsername) !== rawUsername || sanitizeEmail(rawEmail) !== rawEmail;

  const cases = [
    { u: "Divyesh", e: "Divyesh@Example.com", why: "a capitalised email address" },
    { u: "Divyesh", e: "divyesh@example.com ", why: "a trailing space from a copy-paste" },
    { u: "Divyesh ", e: "divyesh@example.com", why: "a trailing space on the username" },
    { u: "Divyesh", e: "DIVYESH@EXAMPLE.COM", why: "an all-caps address" },
  ];

  cases.forEach(({ u, e, why }) => {
    ok(`the shipped gate refused ${why}`, oldGate(u, e) === true,
      `sanitizeAlphanumeric(${JSON.stringify(u)})=${JSON.stringify(sanitizeAlphanumeric(u))}, sanitizeEmail(${JSON.stringify(e)})=${JSON.stringify(sanitizeEmail(e))}`);
    const r = validateUserForm({ username: u, email: e });
    ok(`…and validateUserForm accepts it`, r.ok === true, r.errors.join(" | ") || "no errors");
  });

  // The message itself was the second half of the defect: it named neither field.
  const src = codeOnly(read("src/pages/Users.jsx"));
  ok("the phrase \"Invalid characters in username or email\" is gone from Users.jsx",
    !src.includes("Invalid characters in username or email"));
  ok("neither handler still compares a sanitised value against the raw field",
    !/sanitizedUsername !== \w+\.username/.test(src) && !/sanitizedEmail !== \w+\.email/.test(src));
}

// ── 2. Every problem in one answer ───────────────────────────────────────────
{
  console.log("\n=== 2. every problem is reported at once, not one per submit ===");

  const r = validateUserForm({ username: "a b", email: "not-an-email" });
  eq("a form with two bad fields returns two errors", r.errors.length, 2);
  ok("…the username error names the username rule", r.errors[0] === USERNAME_RULE, r.errors[0]);
  ok("…the email error names the email rule", r.errors[1] === EMAIL_RULE, r.errors[1]);
  ok("…and ok is false", r.ok === false);

  const empty = validateUserForm({});
  eq("an empty form returns two errors, not one", empty.errors.length, 2);
  ok("…and says each field is REQUIRED rather than malformed",
    empty.errors[0] === "Username is required." && empty.errors[1] === "Email is required.",
    empty.errors.join(" | "));

  const good = validateUserForm({ username: "jsmith", email: "j@example.com" });
  eq("a clean form returns zero errors", good.errors.length, 0);
  ok("…and ok is true", good.ok === true);

  // Errors are in field order so the joined toast reads top-to-bottom like the form.
  ok("errors arrive in field order (username before email)",
    validateUserForm({ username: "!", email: "!" }).errors.join("|") === `${USERNAME_RULE}|${EMAIL_RULE}`);

  // The page must not have reverted to a return-per-problem shape.
  const src = read("src/pages/Users.jsx");
  const collected = (src.match(/problems\.join\(" "\)|errors\.join\(" "\)/g) || []).length;
  ok("both handlers join their problems into one toast", collected >= 2, `${collected} join sites`);
}

// ── 3. Email: what is stored, and the branch that cannot fire ────────────────
{
  console.log("\n=== 3. the stored email is the normalised one ===");

  const r = validateUserForm({ username: "bob", email: "  Bob@X.COM  " });
  eq("values.email is trimmed and lowercased", r.values.email, "bob@x.com");
  ok("…so Bob@x.com and bob@x.com can no longer become two accounts",
    validateUserForm({ username: "bob", email: "bob@x.com" }).values.email === r.values.email);
  eq("values.username is trimmed but NOT case-folded", validateUserForm({ username: " Divyesh ", email: "a@b.co" }).values.username, "Divyesh");

  // The third email branch (`sanitizeEmail(email) !== email` after normalisation)
  // is documented in userFormValidation.js as a backstop that cannot fire on
  // today's two patterns. That is a measurement, so measure it.
  const locals = ["a", "ab", "a.b", "a+b", "a-b", "a_b", "a!b", "a#b", "a$b", "a%b",
    "a&b", "a'b", "a*b", "a/b", "a=b", "a?b", "a^b", "a`b", "a{b", "a|b", "a}b", "a~b",
    "first.last", "x".repeat(40)];
  const domains = ["b.co", "b.com", "sub.b.com", "a-b.com", "x.y.z.io", "b1.co", "n.museum"];
  let checked = 0;
  let disagree = 0;
  for (const l of locals) {
    for (const d of domains) {
      const e = `${l}@${d}`.toLowerCase();
      if (!isValidEmail(e)) continue;
      checked++;
      if (sanitizeEmail(e) !== e) disagree++;
    }
  }
  ok("no RFC-valid normalised address is rejected by the narrower sanitiser",
    disagree === 0, `${checked} addresses checked, ${disagree} disagreements`);
  ok("…and the corpus was actually non-trivial", checked >= 100, `${checked} addresses`);

  // The reverse direction is NOT symmetric, and that is the whole point of
  // keeping isValidEmail in front: the loose sanitiser accepts things RFC does not.
  ok("the loose sanitiser accepts a double-dot local part that isValidEmail refuses",
    sanitizeEmail("a..b@x.com") === "a..b@x.com" && isValidEmail("a..b@x.com") === false);
  ok("…and validateUserForm refuses it, because the RFC check runs first",
    validateUserForm({ username: "abc", email: "a..b@x.com" }).ok === false);
}

// ── 4. PASSWORD_HELP is the policy, in words ─────────────────────────────────
{
  console.log("\n=== 4. the password help text matches the policy it is judged by ===");

  // A password that satisfies exactly what PASSWORD_HELP promises, and nothing more.
  const compliant = "Kx7#mQ2vLp9!";
  eq("a password meeting every promise in the help text is accepted", validatePasswordStrength(compliant), "");
  ok("…and it is exactly 12 characters, the length the text names", compliant.length === 12);

  // One counter-example per described clause. Each violates ONE rule only.
  const clauses = [
    { keyword: "12 characters", sample: "Kx7#mQ2vLp!", expect: "Password must be at least 12 characters." },
    { keyword: "lowercase", sample: "KX7#MQ2VLP9!", expect: "Password must include at least one lowercase letter." },
    { keyword: "uppercase", sample: "kx7#mq2vlp9!", expect: "Password must include at least one uppercase letter." },
    { keyword: "number", sample: "Kxa#mQzvLpb!", expect: "Password must include at least one number." },
    { keyword: "symbol", sample: "Kx7amQ2vLp9b", expect: "Password must include at least one special character." },
    { keyword: "three times in a row", sample: "Kx7#mQ2vLp9aaa", expect: "Password must not contain repeating characters." },
  ];

  clauses.forEach(({ keyword, sample, expect }) => {
    ok(`PASSWORD_HELP mentions "${keyword}"`, PASSWORD_HELP.includes(keyword));
    eq(`…and the policy refuses a password that breaks only that clause`, validatePasswordStrength(sample), expect);
  });

  // The seventh rule is deliberately NOT described. Record why, and pin that it
  // is the ONLY one left out — if a rule is ever added, this count changes.
  eq("the line-break rule still exists in the policy",
    validatePasswordStrength("Kx7#mQ2v\nLp9!"), "Password must not contain line breaks.");
  ok("…and is the only rule the help text omits, because a single-line password field cannot carry a newline",
    !/line break|newline/i.test(PASSWORD_HELP));

  // The stale wording must not come back anywhere the fix can reach. Protected
  // files are exempt — and the exemption is read from PROTECTED_FILES.md rather
  // than hard-coded, so it cannot quietly widen.
  const protectedList = new Set(
    (read("PROTECTED_FILES.md").match(/`([^`]+\.(?:js|jsx|md))`/g) || [])
      .map((m) => m.slice(1, -1).replace(/\\/g, "/")),
  );
  ok("PROTECTED_FILES.md parsed into a non-empty exemption set", protectedList.size >= 10, `${protectedList.size} entries`);

  const STALE = "At least 8 characters";
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (/\.(js|jsx)$/.test(entry.name) && !protectedList.has(rel) && codeOnly(read(rel)).includes(STALE)) offenders.push(rel);
    }
  };
  walk("src");
  ok(`no unprotected source file still advertises "${STALE}"`, offenders.length === 0, offenders.join(", ") || "none");

  // Setup.jsx is protected and still carries the stale sentence. That is an owner
  // decision, not an oversight, so it is stated rather than asserted away.
  const setupStale = read("src/pages/Setup.jsx").includes("At least 8 characters");
  ok("src/pages/Setup.jsx is on the protected list, which is why its copy is untouched",
    protectedList.has("src/pages/Setup.jsx"));
  console.log(`    NOTE: Setup.jsx still advertises the old rule: ${setupStale ? "yes — needs owner authorisation" : "no — already corrected"}`);

  // Both dialogs and the self-service page must print the real rule.
  ["src/pages/Users.jsx", "src/pages/ChangePassword.jsx"].forEach((f) => {
    const s = read(f);
    ok(`${f} renders PASSWORD_HELP rather than its own wording`,
      s.includes("{PASSWORD_HELP}") && /import \{[^}]*PASSWORD_HELP[^}]*\} from "@\/lib\/userFormValidation"/.test(s));
  });
  const usersSrc = read("src/pages/Users.jsx");
  eq("Users.jsx prints it at both password fields (create and reset)",
    (usersSrc.match(/\{PASSWORD_HELP\}/g) || []).length, 2);
}

// ── 5. The two promises the dialog makes about passwords ─────────────────────
{
  console.log("\n=== 5. the create dialog keeps the promises it prints ===");
  const src = read("src/pages/Users.jsx");

  ok("the dialog no longer claims a password \"will be generated\" unprompted",
    !codeOnly(src).includes("A temporary password will be generated"));
  ok("…because it now offers to generate one",
    src.includes("handleGeneratePassword") && /onClick=\{handleGeneratePassword\}/.test(src));
  ok("…wired to the generator that already existed for resets",
    /const handleGeneratePassword[\s\S]{0,400}generateTemporaryPassword\(\)/.test(src));
  ok("…and it fills the confirm field too, so the admin is not asked to retype 16 random characters",
    /handleGeneratePassword[\s\S]{0,400}setConfirmPassword\(generated\)/.test(src));

  // A generated password must never be refused by the policy that judges it.
  // security.js redraws until compliant; 400 draws is enough to catch a
  // regression that reintroduces the ~0.4% non-compliant draw.
  let drawn = 0;
  let refused = 0;
  let shortest = Infinity;
  for (let i = 0; i < 400; i++) {
    const p = generateTemporaryPassword();
    drawn++;
    shortest = Math.min(shortest, p.length);
    if (validatePasswordStrength(p) !== "") refused++;
  }
  ok("every generated password satisfies the policy", refused === 0, `${drawn} draws, ${refused} refused`);
  ok("…and every one meets the length the help text advertises", shortest >= 12, `shortest ${shortest}`);

  // #51: the switch used to be decorative.
  const createCall = src.slice(src.indexOf("db.users.create(me, {"), src.indexOf("db.users.create(me, {") + 700);
  ok("the create call sends the switch's value, not a hard-coded true",
    createCall.includes("must_change_password: mustChange") && !/must_change_password: true/.test(createCall),
    createCall.split("\n").find((l) => l.includes("must_change_password")) || "(no line found)");
  ok("…and the value it sends is the same expression the Switch displays",
    (src.match(/form\.must_change_password !== false/g) || []).length === 2,
    `${(src.match(/form\.must_change_password !== false/g) || []).length} occurrences (handler + Switch)`);
  ok("…and the success toast no longer promises a password change the admin turned off",
    /mustChange\s*\?/.test(src));
}

// ── 6. isValidUsername dominates sanitizeAlphanumeric, for trimmed input ─────
{
  console.log("\n=== 6. dropping sanitizeAlphanumeric loses nothing (code-point sweep) ===");

  let swept = 0;
  let stripped = 0;
  const counterexamples = [];
  for (let cp = 0; cp <= 0x2ff; cp++) {
    const ch = String.fromCodePoint(cp);
    const s = `ab${ch}de`;
    if (s !== s.trim()) continue; // the module trims first; section 6b covers this
    swept++;
    const changed = sanitizeAlphanumeric(s, s.length) !== s;
    if (!changed) continue;
    stripped++;
    if (isValidUsername(s) !== false) counterexamples.push(cp);
  }
  ok("every code point 0x00-0x2FF was swept", swept === 0x300, `${swept} of 768`);
  ok("…and the sweep was not vacuous: most of those characters ARE stripped",
    stripped > 700, `${stripped} stripped`);
  ok("no trimmed string the sanitiser would alter is accepted by isValidUsername",
    counterexamples.length === 0,
    counterexamples.length ? `code points ${counterexamples.map((c) => "0x" + c.toString(16)).join(", ")}` : "0 counterexamples");

  // Strictly stronger, not equal — two witnesses, so "one check covers both" is
  // a dominance claim and not a claim that the two are interchangeable.
  ok("the regex is STRICTER: it rejects a hyphen the sanitiser keeps",
    sanitizeAlphanumeric("ab-de", 5) === "ab-de" && isValidUsername("ab-de") === false);
  const long = "a".repeat(40);
  ok("…and rejects a 40-character name the sanitiser's 50-char cap leaves alone",
    sanitizeAlphanumeric(long, long.length) === long && isValidUsername(long) === false);
  ok("…so a 40-character username is refused rather than silently truncated",
    validateUserForm({ username: long, email: "a@b.co" }).ok === false);

  console.log("\n--- 6b. the one case where the sanitiser and the regex disagree ---");
  // This is the exception the module's header names, and the reason it trims
  // BEFORE validating instead of comparing raw against sanitised.
  ok("a leading space is stripped by the sanitiser but accepted by isValidUsername",
    sanitizeAlphanumeric(" abc", 4) !== " abc" && isValidUsername(" abc") === true);
  ok("…which is exactly what the old gate misread as \"invalid characters\"",
    validateUserForm({ username: " abc", email: "a@b.co" }).ok === true);
  eq("…and the stored name is the trimmed one", validateUserForm({ username: " abc ", email: "a@b.co" }).values.username, "abc");
}

// ── 7. full_name keeps the sanitisation the old code applied ─────────────────
{
  console.log("\n=== 7. full_name is sanitised exactly as before ===");

  eq("a spreadsheet formula is neutralised with a leading quote",
    validateUserForm({ username: "abc", email: "a@b.co", full_name: "=cmd()" }).values.full_name, "'=cmd()");
  eq("…and so is a tab-prefixed payload", validateUserForm({ username: "abc", email: "a@b.co", full_name: "\t=1+1" }).values.full_name, "'\t=1+1");
  const xss = validateUserForm({ username: "abc", email: "a@b.co", full_name: "<script>x()</script>Jane" }).values.full_name;
  ok("a <script> element is removed", !xss.includes("<script"), JSON.stringify(xss));
  ok("…and the name itself survives", xss.includes("Jane"), JSON.stringify(xss));
  eq("the composition matches the expression the page used to run inline",
    validateUserForm({ username: "abc", email: "a@b.co", full_name: "-Jane" }).values.full_name,
    sanitizeCsvCell(sanitizeText("-Jane")));
  eq("a missing full_name becomes an empty string, never undefined",
    validateUserForm({ username: "abc", email: "a@b.co" }).values.full_name, "");
  ok("full_name is never a reason to refuse the form",
    validateUserForm({ username: "abc", email: "a@b.co", full_name: "=cmd()" }).ok === true);
}

// ── 8. Editing an existing account ──────────────────────────────────────────
{
  console.log("\n=== 8. the edit dialog grandfathers a stored username ===");

  // A name stored before the current rule must not block an unrelated change.
  const legacy = "old name";
  ok("the legacy name would fail the rule on its own", isValidUsername(legacy) === false);
  ok("…but saving it unchanged is allowed", validateUserForm({ username: legacy, email: "a@b.co" }, { previousUsername: legacy }).ok === true);
  ok("…and a whitespace-only difference still counts as unchanged",
    validateUserForm({ username: ` ${legacy} `, email: "a@b.co" }, { previousUsername: legacy }).ok === true);
  ok("changing it to something invalid IS refused",
    validateUserForm({ username: "n o", email: "a@b.co" }, { previousUsername: legacy }).ok === false);
  ok("changing it to something valid is allowed",
    validateUserForm({ username: "new_name", email: "a@b.co" }, { previousUsername: legacy }).ok === true);
  ok("the grandfather clause never applies in the create dialog (no previousUsername)",
    validateUserForm({ username: legacy, email: "a@b.co" }).ok === false);
  ok("…and an empty stored name does not grandfather an empty submission",
    validateUserForm({ username: "", email: "a@b.co" }, { previousUsername: "" }).ok === false);

  console.log("\n--- 8b. hostile and absent input ---");
  [undefined, null, 42, {}, [], true].forEach((v) => {
    const r = validateUserForm({ username: v, email: v, full_name: v });
    ok(`${JSON.stringify(v) ?? String(v)} is refused without throwing`, r.ok === false && r.errors.length >= 1);
    ok(`…and values are still strings`, typeof r.values.username === "string" && typeof r.values.email === "string" && typeof r.values.full_name === "string");
  });
  ok("calling with no arguments at all does not throw", validateUserForm().ok === false);
}

console.log("\n" + "─".repeat(70));
console.log(`PASS ${pass}   FAIL ${fail}`);
if (fail > 0) {
  console.log(`\nFAILED: ${pass} passed, ${fail} failed`);
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
console.log(`\nPASSED: ${pass} passed, 0 failed`);
process.exit(0);
