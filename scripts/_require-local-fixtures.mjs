// Local HotelKey exports are deliberately gitignored because they may contain real
// business or guest data. Suites written against those files must decline honestly on
// a clean clone instead of crashing with ENOENT and being reported as BROKEN.
//
// CI parser/import coverage comes from the committed synthetic HotelKey corpus under
// src/lib/__fixtures__/hotelkey plus its Vitest and mutation suites.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "data");

export function requireLocalFixtures(suiteName, fileNames) {
  const missing = fileNames.filter((name) => !fs.existsSync(path.join(DATA_DIR, name)));
  if (!missing.length) return DATA_DIR;

  console.log(
    `SKIP: ${suiteName} — local HotelKey fixture(s) are not committed: ${missing.join(", ")}. ` +
    "Run this suite on an authorized workstation with scripts/data populated; CI uses the committed synthetic HotelKey corpus instead."
  );
  process.exit(0);
}
