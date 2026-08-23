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
  isValidAmount,
  isValidIsoDate,
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

// ─────────────────────────────── isValidAmount ──────────────────────────────
console.log("\n=== isValidAmount (finite, bounded) ===");
T("integer", isValidAmount(42) === true);
T("numeric string", isValidAmount("42") === true);
T("decimal", isValidAmount(42.5) === true);
T("zero with default min", isValidAmount(0) === true);
T("negative rejected", isValidAmount(-1) === false);
T("above default max", isValidAmount(10_000_001) === false);
T("custom lower bound", isValidAmount(5, 10) === false);
T("custom bounds", isValidAmount(50, 10, 100) === true);
T("at upper bound", isValidAmount(100, 10, 100) === true);
T("NaN rejected", isValidAmount(NaN) === false);
T("Infinity rejected", isValidAmount(Infinity) === false);
T("empty string rejected", isValidAmount("") === false);
T("non-numeric string rejected", isValidAmount("abc") === false);
T("null rejected", isValidAmount(null) === false);
T("undefined rejected", isValidAmount(undefined) === false);

// ─────────────────────────────── isValidIsoDate ─────────────────────────────
console.log("\n=== isValidIsoDate (YYYY-MM-DD, real calendar date) ===");
T("2026-02-28", isValidIsoDate("2026-02-28") === true);
T("2026-02-29 rejected (not a leap year)", isValidIsoDate("2026-02-29") === false);
T("2024-02-29 leap year", isValidIsoDate("2024-02-29") === true);
T("month 13 rejected", isValidIsoDate("2026-13-01") === false);
T("day 32 rejected", isValidIsoDate("2026-01-32") === false);
T("month 0 rejected", isValidIsoDate("2026-00-10") === false);
T("short year rejected", isValidIsoDate("26-01-01") === false);
T("slash separators rejected", isValidIsoDate("2026/01/01") === false);
T("datetime string rejected", isValidIsoDate("2026-01-01T00:00:00") === false);
T("trailing junk rejected", isValidIsoDate("2026-01-01junk") === false);
T("empty string rejected", isValidIsoDate("") === false);
T("null rejected", isValidIsoDate(null) === false);
T("number input rejected", isValidIsoDate(20260101) === false);

// ─────────────────────────────── resilience ─────────────────────────────────
console.log("\n=== Defensive: never throws on hostile input ===");
const hostile = [null, undefined, 0, 1, NaN, Infinity, [], [1], {}, { a: 1 }, Symbol("x"), () => {}];
for (const bad of hostile) {
  for (const fn of [isValidEmail, isValidUsername, isValidAmount, isValidIsoDate]) {
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
