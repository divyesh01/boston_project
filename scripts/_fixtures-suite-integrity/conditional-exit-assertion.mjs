// No counter and no summary line, but NOT vacuous: the condition can fail the run. A
// conditional that leads to a non-zero exit is the most primitive real assertion there
// is, and two shipped probes (probe-csrf-host-prefix, probe-csvParser-data-loss) assert
// only this way. Both were mutated and both exited 1.
//
// It is still a contract violation — NO_SUMMARY, not VALID — because the runner cannot
// read a machine-readable verdict off it. "Can fail" and "reports what it found" are
// two separate requirements and this fixture pins the difference.
const cookie = "__Host-csrf_token=abc";

if (!cookie.startsWith("__Host-")) {
  console.error("FAIL: cookie is missing the __Host- prefix");
  process.exit(1);
}

console.log("ok: prefix present");
