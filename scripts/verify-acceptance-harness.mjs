// verify-acceptance-harness.mjs
//
// Clean-clone-safe entry point for the real-data acceptance harness.
// Private HotelKey exports are intentionally gitignored. When they are absent this
// suite reports SKIP (not PASS); when they are present it executes the real harness.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, "data");
const HARNESS = path.join(HERE, "acceptance-harness.mjs");

const REQUIRED = [
  "Occupancy Summary midelboro.csv",
  "Source Summary (1).csv",
  "Gross Revenue Report midelboro.csv",
  "Payments Summary.csv",
  "Payments Summary (1).csv",
  "Payments Summary (2).csv",
  "Source Summary.csv",
  "Source Summary (2).csv",
  "Source Summary (3).csv",
  "Clerk Shift.csv",
];

const missing = REQUIRED.filter((name) => !existsSync(path.join(DATA, name)));
if (missing.length > 0) {
  console.log(
    `SKIP: verify-acceptance-harness.mjs — local HotelKey fixture(s) are not committed: ${missing.join(", ")}. Run this suite on an authorized workstation with scripts/data populated; CI uses the committed synthetic HotelKey corpus instead.`,
  );
  process.exit(0);
}

if (!existsSync(HARNESS)) {
  console.error("FAILED: 0 passed, 1 failed — acceptance-harness.mjs is missing");
  process.exit(1);
}

const run = spawnSync(process.execPath, [HARNESS], {
  cwd: path.resolve(HERE, ".."),
  env: process.env,
  encoding: "utf8",
  maxBuffer: 32 * 1024 * 1024,
});

if (run.stdout) process.stdout.write(run.stdout);
if (run.stderr) process.stderr.write(run.stderr);

if (run.error || run.status !== 0) {
  console.error(
    `FAILED: 0 passed, 1 failed — acceptance harness exited ${run.status ?? "without status"}${run.error ? `: ${run.error.message}` : ""}`,
  );
  process.exit(run.status || 1);
}

console.log("PASSED: 1 real-data acceptance harness passed, 0 failed");
process.exit(0);
