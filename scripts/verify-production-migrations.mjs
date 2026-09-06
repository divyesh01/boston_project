// scripts/verify-production-migrations.mjs
// Verifies that sequential execution of migrations-production/*.sql creates
// a fully operational schema compatible with worker/business-sync.js.

import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { makeRunner, assert, assertEqual } from "./_worker-testkit.mjs";

const run = makeRunner("verify-production-migrations");
const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations-production", import.meta.url));

const db = new DatabaseSync(":memory:");
db.exec("PRAGMA foreign_keys = ON;");

await run.check("All production migrations apply sequentially without syntax or constraint errors", () => {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  assert(files.length >= 3, `Expected at least 3 migration files, found ${files.length}`);
  
  for (const file of files) {
    const fullPath = `${MIGRATIONS_DIR}/${file}`;
    const sql = readFileSync(fullPath, "utf8");
    db.exec(sql);
  }
});

await run.check("Property table contains address, phone, and created_date columns", () => {
  const columns = db.prepare("PRAGMA table_info(property)").all().map((r) => r.name);
  assert(columns.includes("address"), "property missing address column");
  assert(columns.includes("phone"), "property missing phone column");
  assert(columns.includes("created_date"), "property missing created_date column");
});

await run.check("business-sync.js property insertion succeeds against migrated schema", () => {
  db.prepare("INSERT INTO account (id, name, created_date) VALUES (?, ?, ?)").run("acc_test", "Test Account", "2026-01-01T00:00:00Z");
  
  const insertStmt = db.prepare(
    "INSERT INTO property (id,account_id,code,name,rooms,address,city,state,phone,active,created_date) " +
    "VALUES (?,?,?,?,?,?,?,?,?,?,?) " +
    "ON CONFLICT(account_id,code) DO UPDATE SET " +
    "name=excluded.name,rooms=excluded.rooms,address=excluded.address,city=excluded.city,state=excluded.state,phone=excluded.phone,active=excluded.active,created_date=excluded.created_date"
  );

  insertStmt.run(
    "prop_server_123",
    "acc_test",
    "RRI-BOS",
    "Red Roof Inn Boston-Woburn",
    100,
    "19 Commerce Way",
    "Woburn",
    "MA",
    "781-935-7110",
    1,
    "2026-01-01T00:00:00Z"
  );

  const row = db.prepare("SELECT * FROM property WHERE id = ?").get("prop_server_123");
  assert(row, "property record was not inserted");
  assertEqual(row.address, "19 Commerce Way", "address persisted");
  assertEqual(row.phone, "781-935-7110", "phone persisted");
  assertEqual(row.created_date, "2026-01-01T00:00:00Z", "created_date persisted");
});

run.done();
if (process.exitCode) process.exit(1);
console.log("PASSED: All production migrations verified against runtime operations.");
