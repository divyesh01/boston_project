// scripts/seed-bundle-lineage.mjs
// Seeds chronological quarter lineage records into import_bundle_lineage in remote D1 staging.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npxCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js");
const stagingConfig = path.join(ROOT, "wrangler.staging.jsonc");

const now = new Date().toISOString();
const sql = `
INSERT OR REPLACE INTO import_bundle_lineage (account_id, successor_bundle_id, predecessor_bundle_id, created_at) VALUES
  ('ACCOUNT_A', 'raw_733bd4ed-271e-4e92-925d-669cb475a4fa', 'raw_2e57f571-e1ef-40cb-b414-f1d32aa84f99', '${now}'),
  ('ACCOUNT_A', 'raw_f8fce13f-7918-4d22-98d5-106f2e9acb02', 'raw_733bd4ed-271e-4e92-925d-669cb475a4fa', '${now}'),
  ('ACCOUNT_A', 'raw_83dbcbcd-2d55-4181-9902-3cfe36bae34f', 'raw_c3dd6946-9595-479c-9c5c-e6b2aa31d4d1', '${now}'),
  ('ACCOUNT_A', 'raw_0b88007d-b7e2-4f24-9517-5c96d6f2b080', 'raw_83dbcbcd-2d55-4181-9902-3cfe36bae34f', '${now}'),
  ('ACCOUNT_A', 'raw_a5eb9ca6-da06-49f8-91ba-81c26bfc6000', 'raw_5f17fcaa-c80b-4dc9-8e32-86f588402e5b', '${now}'),
  ('ACCOUNT_A', 'raw_acb61a54-dccf-4d0d-beb0-36da64fcd266', 'raw_a5eb9ca6-da06-49f8-91ba-81c26bfc6000', '${now}');
`;

import { writeFileSync, unlinkSync } from "node:fs";

const tempSqlFile = path.join(ROOT, "scripts", "temp_seed_lineage.sql");
writeFileSync(tempSqlFile, sql, "utf8");

try {
  const res = spawnSync(
    process.execPath,
    [npxCli, "wrangler", "d1", "execute", "DB", "--config", stagingConfig, "--remote", `--file=${tempSqlFile}`, "--json"],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
  );

  if (res.error) {
    console.error("Execution error:", res.error);
    process.exit(1);
  }

  if (res.status !== 0) {
    console.error("Wrangler error:", res.stderr || res.stdout);
    process.exit(res.status || 1);
  }

  console.log("Successfully seeded chronological bundle lineage into import_bundle_lineage.");
  console.log(res.stdout);
} finally {
  try { unlinkSync(tempSqlFile); } catch {}
}
