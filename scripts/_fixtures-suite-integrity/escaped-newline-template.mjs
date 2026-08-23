// Fixture: Escaped newline template string (\nPASSED: ...)
import assert from 'node:assert';

let pass = 0;
let fail = 0;

// A non-constant comparison on purpose: `if (true === true)` is what this fixture
// used until 2026-08-23, and eslint's no-constant-binary-expression rule made
// `npm run lint` exit 1 on the whole repo because of it. The fixture only needs the
// counters to be genuinely mutable — the STATIC SHAPE the classifier reads is the
// escaped-newline template summary on line 13, which is unchanged.
const actual = 1 + 1;
if (actual === 2) {
  pass++;
} else {
  fail++;
}

console.log(`\nPASSED: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
