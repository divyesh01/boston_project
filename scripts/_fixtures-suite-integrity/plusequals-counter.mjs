// Counts with `pass += 1` instead of `pass++`. Both are failure counters; the auditor
// used to recognise only the second form, so three shipped suites (probe-hotel,
// probe-capacity-per-day, probe-upload-guard) read as having no assertions whatsoever.
// All three were mutated to force one failure and all three exited 1.
let pass = 0;
let fail = 0;
const failures = [];

const eq = (label, actual, expected) => {
  if (actual === expected) {
    pass += 1;
  } else {
    fail += 1;
    failures.push(label);
  }
};

const two = [1, 1].reduce((a, b) => a + b, 0);
eq("two ones sum to two", two, 2);

console.log(`\n${fail === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
