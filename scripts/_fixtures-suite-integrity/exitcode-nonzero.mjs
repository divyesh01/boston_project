// Counts failures and reports status via `process.exitCode`, never process.exit().
// A real suite MUST do this when it leaves fetch keep-alive sockets open —
// process.exit() tears those sockets down and aborts the process on Windows + Node 26.
// See the comment block in scripts/probe-config-exposure.mjs.
let pass = 0;
let fail = 0;

const ok = (label, cond) => {
  if (cond) {
    pass += 1;
  } else {
    fail += 1;
    console.log(`  FAIL  ${label}`);
  }
};

const two = [1, 1].reduce((a, b) => a + b, 0);
ok("two ones sum to two", two === 2);

console.log(`\n${fail === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
