// THE NEGATIVE THAT KEEPS THE WIDENED EXIT-PATH PATTERN HONEST.
//
// This fixture has a counter and a summary line, but its only exit assignment is a bare
// success: `process.exitCode = 0`. There is no way for it to report failure to the
// runner, so it must classify as NO_EXIT_PATH.
//
// If a future change makes `process.exitCode` count as a fail path unconditionally,
// this fixture is what fails. Do not "fix" it by relaxing the expectation.
let pass = 0;
let fail = 0;

const two = [1, 1].reduce((a, b) => a + b, 0);
if (two === 2) {
  pass += 1;
} else {
  fail += 1;
}

console.log(`PASSED: ${pass} passed, ${fail} failed`);
process.exitCode = 0;
