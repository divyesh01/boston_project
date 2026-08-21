// scripts/probe-password-policy.mjs
//
// Playbook items #17 (the PBKDF2 second round is weaker than the file claims)
// and #18 (dead code in the password-strength validator), plus the defect that
// looking at #18 properly turned up: the SERVER-side password gate is weaker
// than the policy the client advertises.
//
// ─── #17, and why the fix must not change a single bit ───────────────────────
//
// src/lib/security.js declared:
//
//     const PBKDF2_ITERATIONS = 300000; // Increased from 150k
//     const DERIVATION_ROUNDS = 2;
//     ...
//     let key = await deriveKey(password, saltHex, PBKDF2_ITERATIONS);
//     for (let i = 1; i < DERIVATION_ROUNDS; i++)
//       key = await deriveKey(password, intermediateSalt, PBKDF2_ITERATIONS / DERIVATION_ROUNDS);
//
// so round 1 runs 300,000 iterations and round 2 runs 150,000 — a total of
// 450,000, while the header advertised "300000" and called the chaining "a
// memory-hard parameter simulation". Neither description is true: the total is
// 450k, and chained PBKDF2 buys CPU time only. PBKDF2 has no memory cost to
// tune, which is the entire reason Argon2id exists.
//
// The division is the actual bug. `PBKDF2_ITERATIONS / DERIVATION_ROUNDS` ties
// two unrelated numbers together, so setting DERIVATION_ROUNDS = 3 to "add a
// round" silently produces 300k + 100k + 100k = 500k rather than the 900k the
// author would expect, and every round after the first is weaker than the first
// by construction.
//
// It cannot be fixed by rebalancing the iterations. hashPassword's output IS the
// stored credential: every User row holds a hash derived under exactly this
// schedule. Changing round 1 to 225,000 and round 2 to 225,000 keeps the same
// 450,000 total and still invalidates every stored hash — locking every existing
// account out of the system on deploy. So the fix here is REPRESENTATIONAL: the
// same two numbers, stated explicitly instead of derived by division, with the
// total documented honestly.
//
// Section 1 is what makes that claim checkable. It is a known-answer test: three
// fixed (password, salt) pairs and the hex their hashes MUST equal. The expected
// values were measured against the pre-fix code, so a refactor that alters the
// schedule in any way — iteration counts, round count, salt slicing, key length,
// hex encoding — fails here loudly. That is exactly the behaviour you want
// guarding a value whose silent change is a hotel-wide lockout.
//
// ─── #18: the "dead code" is not dead, and that is the finding ───────────────
//
// The playbook claimed the trailing `return "Password does not meet complexity
// requirements."` was unreachable because the regex above it re-tests the four
// character classes already checked. The first half is right — the lookaheads
// are redundant. The conclusion is wrong, and measurement is what showed it:
//
//     validatePasswordStrength("Ab1!cdef\nghij")
//       -> "Password does not meet complexity requirements."
//
// JavaScript's `$` (no `m` flag) matches only at the very end of input, and `.`
// never matches a line terminator, so `^(?=...).+$` fails for any password
// containing U+000A, U+000D, U+2028 or U+2029 — including the trailing newline
// that comes free with a paste out of a password manager or a text file. Those
// passwords are refused, which is defensible, but they are refused by ACCIDENT
// and told only that they "do not meet complexity requirements" while every
// visible requirement is satisfied. A user cannot act on that.
//
// So the fix makes the rule explicit and deletes the redundant regex, and the
// generic message goes away because nothing can reach it any more. Section 5
// pins the important half of that: the accept/reject DECISION is unchanged for
// every input (checked against a reference implementation of the old logic over
// a fuzz that includes line terminators) and only the message a rejected user
// sees improves.
//
// ─── The real security defect in this area ──────────────────────────────────
//
// Grepping for the validator's other copies is what found it. The policy the UI
// enforces is 12 characters with four classes and no 3-in-a-row repeat. The two
// SERVER copies — base44/functions/custom_user_admin/entry.js and
// base44/functions/custom_auth_reset_password/entry.js — enforced 8 characters
// with three classes and no repeat rule, so "Abcdefg1" was a valid password as
// far as the only gate that cannot be bypassed was concerned. The client rule is
// a hint; the server rule is the policy. custom_auth_reset_password is reachable
// by an unauthenticated caller holding a reset token, and its own header comment
// says "a password set here is a password that signs in everywhere".
//
// Section 7 therefore does not compare the two files' text and stop there. It
// extracts each server copy's function body, evaluates it, and requires the
// server's accept/reject decision to match the client's for every input in the
// same fuzz. Text comparison would pass two identically-wrong copies.
//
// ─── One more thing sections 6 exists for ───────────────────────────────────
//
// generateTemporaryPassword builds 16 characters and guarantees one of each
// class, but nothing in it avoids a 3-in-a-row repeat — which the validator
// rejects. Users.jsx generates a temporary password and then validates it, so a
// small share of admin-initiated resets fail on a password the app generated
// itself. Section 6 measures the rate rather than reasoning about it.

import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const SECURITY_JS = path.join(REPO, "src", "lib", "security.js");
const LOGIN_FN = path.join(REPO, "base44", "functions", "custom_auth_login", "entry.js");
const ADMIN_FN = path.join(REPO, "base44", "functions", "custom_user_admin", "entry.js");
const RESET_FN = path.join(REPO, "base44", "functions", "custom_auth_reset_password", "entry.js");
const RESET_PAGE = path.join(REPO, "src", "pages", "ResetPassword.jsx");

let pass = 0;
let fail = 0;
const failures = [];

function ok(label, cond, detail) {
  if (cond) {
    pass += 1;
  } else {
    fail += 1;
    failures.push(detail ? `${label} — ${detail}` : label);
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function eq(label, actual, expected) {
  ok(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// Structural assertions run against comment-stripped source. A probe that fails
// because a file documents its own former defect punishes the fix. The [^:]
// guard keeps "https://" out of the line-comment rule.
function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function read(file) {
  try {
    return readFileSync(file, "utf8");
  } catch (e) {
    ok(`readable: ${path.relative(REPO, file)}`, false, e.message);
    return "";
  }
}

// A crash at import is reported by verify-all as BROKEN, which reads like a
// passing suite with one fewer line. Fail loudly instead.
let mod = null;
try {
  mod = await import("@/lib/security");
} catch (e) {
  ok("src/lib/security.js imports", false, e && e.message);
}
function api(name) {
  const fn = mod && mod[name];
  if (typeof fn !== "function") {
    ok(`security.js exports ${name}()`, false, `got ${typeof fn}`);
    return () => undefined;
  }
  return fn;
}
const hashPassword = api("hashPassword");
const verifyPassword = api("verifyPassword");
const validatePasswordStrength = api("validatePasswordStrength");
const generateTemporaryPassword = api("generateTemporaryPassword");

const rawSecurity = read(SECURITY_JS);
const security = stripComments(rawSecurity);

// The character classes the policy is written in terms of. Kept here so the
// probe states the policy once and every section checks against the same thing.
const SPECIAL = /[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/;
const LINE_TERMINATORS = ["\n", "\r", "\u2028", "\u2029"];

// ── Section 1: known-answer test — the derivation schedule is frozen ──────────
console.log("\n[1] known-answer test: hashPassword must stay bit-for-bit identical");
{
  // Measured against the pre-fix code on 2026-08-20. These are not secrets and
  // not real credentials; they exist so that any change to the schedule is
  // impossible to make quietly. If you are here because this failed: you have
  // changed what every stored password hash means. That needs a
  // rehash-on-next-login migration, not an edit to security.js.
  const VECTORS = [
    ["Ab1!cdefghij",
      "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
      "ee9eeb0b434184ea39da93c90e8afac2d96839111689780cae3b7350ffb06ccf"],
    ["p@ssw0rd-LONG-enough",
      "ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100",
      "d40442bc8a7a004ae99502f0668353fdfbc4cdd203dfaf7a1093d547180a68d9"],
    ["",
      "0000000000000000000000000000000000000000000000000000000000000000",
      "18ffd7c22e0d01148c2e95bc672c9de61b8b40912b99e4952c6751c711bc525c"],
  ];
  for (const [pw, salt, expected] of VECTORS) {
    const actual = await hashPassword(pw, salt);
    eq(`hash of ${JSON.stringify(pw)} is unchanged`, actual, expected);
  }

  // Same password, different salt must diverge — guards against a refactor that
  // drops the salt on the floor while still producing 64 hex chars.
  const a = await hashPassword("Ab1!cdefghij", "00".repeat(32));
  const b = await hashPassword("Ab1!cdefghij", "01".repeat(32));
  ok("the salt still reaches the derivation", a !== b);
  ok("the digest is 256 bits of hex", /^[0-9a-f]{64}$/.test(a), `got ${a.length} chars`);
}

// ── Section 2: the schedule is stated, not computed by division ───────────────
console.log("\n[2] the iteration schedule is explicit and honestly described");
{
  ok("the PBKDF2_ITERATIONS / DERIVATION_ROUNDS division is gone",
    !/PBKDF2_ITERATIONS\s*\/\s*DERIVATION_ROUNDS/.test(security),
    "round 2's cost must not be a side effect of arithmetic on round 1's");

  const scheduleMatch = security.match(/PBKDF2_ROUND_ITERATIONS\s*=\s*Object\.freeze\(\s*\[([^\]]*)\]/);
  ok("an explicit per-round schedule is declared", !!scheduleMatch);
  if (scheduleMatch) {
    const rounds = scheduleMatch[1].split(",").map((n) => Number(n.trim())).filter((n) => Number.isFinite(n));
    eq("the schedule has two rounds", rounds.length, 2);
    eq("round 1 is 300000 iterations", rounds[0], 300000);
    eq("round 2 is 150000 iterations", rounds[1], 150000);
    eq("the honest total is 450000", rounds.reduce((s, n) => s + n, 0), 450000);
  }

  // These two feed the KAT as surely as the iteration counts do.
  ok("SALT_BYTES is still 32", /SALT_BYTES\s*=\s*32\b/.test(security));
  ok("KEY_BITS is still 256", /KEY_BITS\s*=\s*256\b/.test(security));

  // Deliberately read from the RAW source: the claim being retired is a comment,
  // so stripping comments would make this assertion unfalsifiable.
  ok("the false 'memory-hard parameter simulation' claim is gone",
    !/memory-hard parameter simulation/i.test(rawSecurity));
  ok("the false 'memory-hardness simulation' claim is gone",
    !/memory-hardness simulation/i.test(rawSecurity));
  ok("the total cost is stated somewhere in the file",
    /450[,_]?000/.test(rawSecurity),
    "a reader must be able to learn the real iteration count without doing arithmetic");
}

// ── Section 3: all three copies of the schedule agree ────────────────────────
console.log("\n[3] every copy of the hashing schedule derives the same key");
{
  // The base44 host resolves only npm:, node: and base44:runtime specifiers, so
  // the server functions cannot import security.js — the schedule is physically
  // duplicated and the copies can only be kept honest by a check like this one.
  function scheduleOf(file) {
    const code = stripComments(read(file));
    const frozen = code.match(/PBKDF2_ROUND_ITERATIONS\s*=\s*Object\.freeze\(\s*\[([^\]]*)\]/);
    if (frozen) {
      return frozen[1].split(",").map((n) => Number(n.trim())).filter((n) => Number.isFinite(n));
    }
    const base = Number((code.match(/PBKDF2_ITERATIONS\s*=\s*(\d+)/) || [])[1]);
    const rounds = Number((code.match(/DERIVATION_ROUNDS\s*=\s*(\d+)/) || [])[1]);
    if (!Number.isFinite(base) || !Number.isFinite(rounds)) return null;
    const out = [base];
    for (let i = 1; i < rounds; i++) out.push(base / rounds);
    return out;
  }

  const expected = [300000, 150000];
  for (const [label, file] of [
    ["src/lib/security.js", SECURITY_JS],
    ["custom_auth_login", LOGIN_FN],
    ["custom_user_admin", ADMIN_FN],
  ]) {
    const sched = scheduleOf(file);
    ok(`${label} derives under ${expected.join(" + ")}`,
      !!sched && sched.length === expected.length && sched.every((n, i) => n === expected[i]),
      `got ${JSON.stringify(sched)} — a mismatch here means hashes written by one path cannot be verified by another`);
  }
}

// ── Section 4: verifyPassword compares in constant time ──────────────────────
console.log("\n[4] verifyPassword");
{
  const salt = "0f".repeat(32);
  const good = await hashPassword("Ab1!cdefghij", salt);

  eq("the right password verifies", await verifyPassword("Ab1!cdefghij", salt, good), true);
  eq("a wrong password does not", await verifyPassword("Ab1!cdefghiJ", salt, good), false);
  eq("a hash differing in the last nibble does not",
    await verifyPassword("Ab1!cdefghij", salt, good.slice(0, -1) + (good.endsWith("0") ? "1" : "0")), false);
  eq("a truncated stored hash does not",
    await verifyPassword("Ab1!cdefghij", salt, good.slice(0, 32)), false);
  eq("an empty password is refused", await verifyPassword("", salt, good), false);
  eq("a missing salt is refused", await verifyPassword("Ab1!cdefghij", "", good), false);
  eq("a missing stored hash is refused", await verifyPassword("Ab1!cdefghij", salt, ""), false);

  // The file already owns a constant-time comparator and documents why it must
  // not early-return on length. Using === for the credential comparison while
  // using constantTimeEqual for 6-digit TOTP codes is backwards.
  ok("the hash comparison goes through constantTimeEqual",
    /export async function verifyPassword[\s\S]{0,400}?constantTimeEqual\s*\(/.test(security));
  ok("verifyPassword no longer compares hashes with ===",
    !/export async function verifyPassword[\s\S]{0,400}?actual\s*===\s*expectedHashHex/.test(security));
}

// ── Section 5: the validator — every rejection must be actionable ─────────────
console.log("\n[5] validatePasswordStrength: same decisions, actionable messages");
{
  // A faithful reimplementation of the PRE-FIX logic. Its only job is to prove
  // the refactor did not change who gets in.
  const OLD_TAIL = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]).+$/;
  function oldAccepts(password) {
    if (typeof password !== "string" || password.length < 12) return false;
    if (!/[a-z]/.test(password)) return false;
    if (!/[A-Z]/.test(password)) return false;
    if (!/[0-9]/.test(password)) return false;
    if (!SPECIAL.test(password)) return false;
    if (/(.)\1{2,}/.test(password)) return false;
    return OLD_TAIL.test(password);
  }

  const GENERIC = "Password does not meet complexity requirements.";

  // Each rule fires on its own, with a message naming the rule.
  const table = [
    ["short", "Ab1!cdefg", /12 characters/],
    ["no lowercase", "AB1!CDEFGHIJ", /lowercase/],
    ["no uppercase", "ab1!cdefghij", /uppercase/],
    ["no digit", "Ab!cdefghijk", /number/],
    ["no special", "Ab1cdefghijk", /special/],
    ["triple repeat", "Ab1!cdeffffgh", /repeat/],
  ];
  for (const [label, pw, re] of table) {
    const msg = validatePasswordStrength(pw);
    ok(`${label} is rejected with a message naming the rule`, typeof msg === "string" && re.test(msg),
      `got ${JSON.stringify(msg)}`);
  }
  eq("a compliant password is accepted", validatePasswordStrength("Ab1!cdefghij"), "");

  // Non-strings must not throw — Users.jsx and Setup.jsx call this on raw state.
  for (const bad of [undefined, null, 42, {}, []]) {
    const msg = validatePasswordStrength(bad);
    ok(`${JSON.stringify(bad) ?? String(bad)} is rejected without throwing`,
      typeof msg === "string" && msg.length > 0, `got ${JSON.stringify(msg)}`);
  }

  // The heart of #18: line terminators are refused, and the user is told why.
  for (const ch of LINE_TERMINATORS) {
    const pw = `Ab1!cdef${ch}ghij`;
    const msg = validatePasswordStrength(pw);
    ok(`U+${ch.charCodeAt(0).toString(16).padStart(4, "0").toUpperCase()} in the middle is rejected`,
      msg !== "", "a line terminator must not silently become part of a credential");
    ok(`U+${ch.charCodeAt(0).toString(16).padStart(4, "0").toUpperCase()} gets an actionable message`,
      msg !== GENERIC,
      `got the generic fallback, which names no rule the user can see they broke`);
  }
  const pasted = validatePasswordStrength("Ab1!cdefghij\n");
  ok("a pasted trailing newline is rejected with an actionable message",
    pasted !== "" && pasted !== GENERIC, `got ${JSON.stringify(pasted)}`);

  // A tab IS matched by `.`, so it was and remains acceptable. Pinned so the
  // new explicit rule is not quietly widened into "no whitespace".
  eq("a tab is still accepted (unchanged behaviour)", validatePasswordStrength("Ab1!cdef\tghij"), "");
  eq("a space is still accepted (unchanged behaviour)", validatePasswordStrength("Ab1! cdefghij"), "");

  // Decision equivalence over a fuzz that includes the interesting characters.
  const alphabet = "abcdefghijkmABCDEFGHJKM23456789!@#$%^&*()_+-=[]{};:'\",.<>/?\\| \t\n\r\u2028\u2029";
  let divergences = 0;
  let example = "";
  for (let n = 0; n < 20000; n++) {
    const len = 6 + Math.floor(Math.random() * 14);
    let pw = "";
    for (let i = 0; i < len; i++) pw += alphabet[Math.floor(Math.random() * alphabet.length)];
    const nowAccepts = validatePasswordStrength(pw) === "";
    if (nowAccepts !== oldAccepts(pw)) {
      divergences += 1;
      if (!example) example = JSON.stringify(pw);
    }
  }
  ok("20000 fuzzed inputs get the same accept/reject decision as before the fix",
    divergences === 0, `${divergences} diverged, e.g. ${example}`);

  // Every distinct rejection reason must be distinguishable, or "actionable" is
  // a word rather than a property.
  const messages = new Set();
  for (const [, pw] of table) messages.add(validatePasswordStrength(pw));
  messages.add(validatePasswordStrength("Ab1!cdef\nghij"));
  eq("each of the 7 rules has its own message", messages.size, 7);

  ok("the generic fallback message is gone from the source",
    !new RegExp(GENERIC.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).test(security),
    "nothing can reach it once the rule it stood in for is explicit");
  ok("the redundant four-lookahead regex is gone",
    !/\(\?=\.\*\[a-z\]\)\(\?=\.\*\[A-Z\]\)/.test(security),
    "it re-tested four conditions the lines above had already checked");
}

// ── Section 6: a generated temporary password must satisfy the policy ─────────
console.log("\n[6] generateTemporaryPassword agrees with the validator");
{
  const DRAWS = 3000;
  let rejected = 0;
  let example = "";
  let badLength = 0;
  for (let i = 0; i < DRAWS; i++) {
    const pw = generateTemporaryPassword();
    if (typeof pw !== "string" || pw.length < 16) badLength += 1;
    const msg = validatePasswordStrength(pw);
    if (msg !== "") {
      rejected += 1;
      if (!example) example = `${JSON.stringify(pw)} -> ${JSON.stringify(msg)}`;
    }
  }
  eq("every draw is at least 16 characters", badLength, 0);
  ok(`all ${DRAWS} generated temporary passwords pass validatePasswordStrength`,
    rejected === 0,
    `${rejected}/${DRAWS} were rejected by the app's own validator, e.g. ${example} — Users.jsx validates what it generates, so these are failed admin resets`);
}

// ── Section 7: the server enforces the policy the client advertises ───────────
console.log("\n[7] the server-side gate is not weaker than the client's");
{
  // Extract and evaluate rather than compare text: two identically-wrong copies
  // pass a text comparison.
  function extractValidator(file) {
    const code = read(file);
    const start = code.indexOf("function validatePasswordStrength(password) {");
    if (start === -1) return null;
    const open = code.indexOf("{", start);
    let depth = 0;
    for (let i = open; i < code.length; i++) {
      if (code[i] === "{") depth += 1;
      else if (code[i] === "}") {
        depth -= 1;
        if (depth === 0) return code.slice(open + 1, i);
      }
    }
    return null;
  }

  const bodies = new Map();
  for (const [label, file] of [["custom_user_admin", ADMIN_FN], ["custom_auth_reset_password", RESET_FN]]) {
    const body = extractValidator(file);
    ok(`${label} declares validatePasswordStrength`, !!body);
    if (body) bodies.set(label, body);
  }

  // Their own comment says they are "kept identical" to each other. Hold them to it.
  if (bodies.size === 2) {
    const [a, b] = [...bodies.values()].map((s) => s.replace(/\s+/g, " ").trim());
    ok("the two server copies are identical", a === b,
      "one was updated and the other was not — the weaker one is the policy");
  }

  // The server's decision must match the client's for the whole fuzz. The server
  // copies return null for "fine" and a string for "rejected"; the client returns
  // "" and a string.
  const alphabet = "abcdefghijkmABCDEFGHJKM23456789!@#$%^&*()_+-=[]{};:'\",.<>/?\\| \t\n\r";
  for (const [label, body] of bodies) {
    let serverFn;
    try {
      serverFn = new Function("password", body);
    } catch (e) {
      ok(`${label}'s validator evaluates`, false, e.message);
      continue;
    }
    const serverAccepts = (pw) => {
      try {
        const r = serverFn(pw);
        return r === null || r === undefined || r === "";
      } catch {
        return false;
      }
    };

    // Named cases first, so a failure says something specific.
    const cases = [
      ["8 chars, no special", "Abcdefg1"],
      ["11 chars, all classes", "Ab1!cdefghi"],
      ["no special character", "Abcdefghijk1"],
      ["triple repeat", "Ab1!cdeffffgh"],
      ["compliant", "Ab1!cdefghij"],
      ["line terminator", "Ab1!cdef\nghij"],
    ];
    for (const [name, pw] of cases) {
      const clientOk = validatePasswordStrength(pw) === "";
      eq(`${label}: ${name} — server agrees with the client`, serverAccepts(pw), clientOk);
    }

    let divergences = 0;
    let example = "";
    for (let n = 0; n < 4000; n++) {
      const len = 4 + Math.floor(Math.random() * 16);
      let pw = "";
      for (let i = 0; i < len; i++) pw += alphabet[Math.floor(Math.random() * alphabet.length)];
      const clientOk = validatePasswordStrength(pw) === "";
      if (serverAccepts(pw) !== clientOk) {
        divergences += 1;
        if (!example) example = `${JSON.stringify(pw)} server=${serverAccepts(pw)} client=${clientOk}`;
      }
    }
    ok(`${label}: 4000 fuzzed inputs decided identically to the client`,
      divergences === 0,
      `${divergences} diverged, e.g. ${example} — the server is the only gate that cannot be bypassed`);
  }

  // The one place the rule is ALSO written as a UI checklist is a protected file
  // this work may not edit. That is safe only because the page still runs the
  // shared validator as the gate, so a rule missing from the checklist is
  // enforced anyway rather than silently skipped.
  const resetPage = read(RESET_PAGE);
  ok("ResetPassword.jsx still gates on the shared validator, not only its checklist",
    /validatePasswordStrength\s*\(/.test(resetPage));
}

console.log(`\n${"─".repeat(70)}`);
if (failures.length) {
  console.log("Failures:");
  failures.forEach((f) => console.log(`  • ${f}`));
}
console.log(`PASS ${pass}   FAIL ${fail}`);
process.exit(fail ? 1 : 0);
