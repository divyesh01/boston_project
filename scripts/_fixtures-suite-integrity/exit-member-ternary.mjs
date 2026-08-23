// The exit status is derived from a MEMBER expression, not a bare identifier:
// `process.exit(failures.length ? 1 : 0)`. The old identifier class `[a-zA-Z0-9_]+`
// stopped at the `.`, so scripts/verify-import-rollback.mjs — which ends in exactly this
// line — was reported as having no exit path at all. Mutating it proved otherwise (rc=1).
let pass = 0;
const failures = [];

const two = [1, 1].reduce((a, b) => a + b, 0);
if (two === 2) {
  pass += 1;
} else {
  failures.push("two ones should sum to two");
}

console.log(`\n${failures.length === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
