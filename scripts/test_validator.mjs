// Validator test suite for src/lib/validator.js.
//
// Runs the REAL shipped validation functions over the passing and failing cases
// a production form will actually hit: null, undefined, empty strings, wrong
// types, boundary lengths, and format edge cases. Every function must return a
// boolean and must never throw.
//
// Run: node scripts/test_validator.mjs

import { register } from "node:module";
register(new URL("./resolve-alias.mjs", import.meta.url));

const {
  isValidEmail,
  isValidUsername,
} = await import("@/lib/validator");

let pass = 0;
let fail = 0;
const T = (name, cond, detail = "") => {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`);
  }
};

// ─────────────────────────────── isValidEmail ───────────────────────────────
console.log("\n=== isValidEmail (RFC 5322) ===");
T("user@example.com", isValidEmail("user@example.com") === true);
T("u.ser+tag@sub.domain.test", isValidEmail("u.ser+tag@sub.domain.test") === true);
T("MixedCase@Example.COM (case-insensitive)", isValidEmail("MixedCase@Example.COM") === true);
T("  padded@example.com  ", isValidEmail("  padded@example.com  ") === true);
T("quoted local part rejected (practical subset)", isValidEmail(`"a b"@example.com`) === false);
T("TLD is required", isValidEmail("user@example") === false);
T("empty domain", isValidEmail("user@") === false);
T("empty local", isValidEmail("@example.com") === false);
T("double @", isValidEmail("a@b@c.test") === false);
T("embedded space", isValidEmail("user name@example.com") === false);
T("consecutive dots in local", isValidEmail("a..b@example.com") === false);
T("leading dot in local", isValidEmail(".ab@example.com") === false);
T("trailing dot in domain", isValidEmail("user@example..com") === false);
T("empty string", isValidEmail("") === false);
T("whitespace only", isValidEmail("   ") === false);
T("over 254 chars", isValidEmail(`${"a".repeat(64)}@${"b".repeat(190)}.com`) === false);
T("null", isValidEmail(null) === false);
T("undefined", isValidEmail(undefined) === false);
T("number input", isValidEmail(123) === false);
T("object input", isValidEmail({}) === false);

// ─────────────────────────────── isValidUsername ────────────────────────────
console.log("\n=== isValidUsername (3-30 alnum/underscore) ===");
T("abc", isValidUsername("abc") === true);
T("a_b_c9", isValidUsername("a_b_c9") === true);
T("30 characters", isValidUsername("a".repeat(30)) === true);
T("31 characters", isValidUsername("a".repeat(31)) === false);
T("2 characters", isValidUsername("ab") === false);
T("hyphen rejected", isValidUsername("a-bc") === false);
T("dot rejected", isValidUsername("a.bc") === false);
T("embedded space", isValidUsername("a b") === false);
T("empty string", isValidUsername("") === false);
T("padded value passes", isValidUsername("  abc  ") === true);
T("null", isValidUsername(null) === false);
T("undefined", isValidUsername(undefined) === false);
T("number input", isValidUsername(123) === false);

// ─────────────────────────────── resilience ─────────────────────────────────
console.log("\n=== Defensive: never throws on hostile input ===");
const hostile = [null, undefined, 0, 1, NaN, Infinity, [], [1], {}, { a: 1 }, Symbol("x"), () => {}];
for (const bad of hostile) {
  for (const fn of [isValidEmail, isValidUsername]) {
    let threw = false;
    try {
      fn(bad);
    } catch {
      threw = true;
    }
    T(`${fn.name}(${typeof bad === "symbol" ? "Symbol" : JSON.stringify(bad)}) does not throw`, !threw);
  }
}

console.log(`\n${"=".repeat(62)}\n  ${pass} passed, ${fail} failed\n${"=".repeat(62)}`);
console.log(`\n${fail === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
