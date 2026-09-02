// scripts/verify-schema-parity.mjs — THE AUTHORITATIVE SCHEMA CONTRACT.
//
// worker/schema.sql (the off-production staging/test schema that every probe
// harness loads) and migrations-production/0001_auth_schema.sql (the schema the
// live D1 authentication database was actually built from) drifted apart, and
// that drift is the reason a missing-required-column defect (H1: INSERT INTO
// user without password_hash/salt) could pass every local suite and still fail
// in production. Ten `user` columns were nullable in staging and NOT NULL in
// production, so no harness could ever observe the failure.
//
// THE CONTRACT ENFORCED HERE:
//   Production is AUTHORITATIVE for the six authentication tables. For every
//   column, foreign key, index, CHECK constraint and primary key that exists in
//   production, the staging schema must declare it IDENTICALLY (same type, same
//   NOT NULL, same DEFAULT, same key position). Staging may declare EXTRA
//   objects only when they are listed in an explicit allowlist below, and an
//   extra column must be nullable or defaulted so a production-shaped INSERT
//   still succeeds against it.
//
// Business/hotel tables are deliberately out of scope: production is an
// auth-only database and the Worker denies the business routes unless the
// ENABLE_D1_DATA_API kill switch is on. This file governs the auth surface.
//
// Run: node scripts/verify-schema-parity.mjs
// Auto-discovered by scripts/verify-all.mjs (verify- prefix).

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { makeRunner, assert, assertEqual } from "./_worker-testkit.mjs";

const STAGING_PATH = fileURLToPath(new URL("../worker/schema.sql", import.meta.url));
const PRODUCTION_PATH = fileURLToPath(
  new URL("../migrations-production/0001_auth_schema.sql", import.meta.url),
);

/** The authentication surface both schemas must agree on, production-authoritative. */
export const AUTH_TABLES = Object.freeze([
  "account",
  "user",
  "property",
  "user_property_access",
  "app_session",
  "app_mfa_challenge",
]);

/**
 * Staging-only columns, each with the reason it may exist. Every entry MUST be
 * nullable or carry a DEFAULT, otherwise a production-shaped INSERT would fail
 * against staging and the harness would diverge again in the other direction.
 */
const STAGING_ONLY_COLUMNS = new Map([
  [
    "property",
    new Map([
      ["address", "staging-only property profile field; production stores no business profile"],
      ["phone", "staging-only property profile field; production stores no business profile"],
      ["created_date", "staging-only bookkeeping column; production omits it entirely"],
    ]),
  ],
]);

/** Staging-only NON-UNIQUE performance indexes. A staging-only UNIQUE index is a FAIL. */
const STAGING_ONLY_INDEXES = new Map([
  ["user", new Set(["idx_user_username"])],
  ["property", new Set(["idx_property_account"])],
  ["user_property_access", new Set(["idx_upa_account_user", "idx_upa_property"])],
]);

// ---------------------------------------------------------------------------
// Introspection — structural, via PRAGMA, not DDL text matching
// ---------------------------------------------------------------------------

function loadDb(path) {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(path, "utf8"));
  return db;
}

function normalizeSql(sql) {
  return String(sql || "")
    .replace(/"/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*([(),])\s*/g, "$1")
    .replace(/;+$/, "")
    .trim()
    .toLowerCase();
}

function tableSet(db) {
  return new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => row.name),
  );
}

/** PRAGMA table_info reduced to the fields that change INSERT/UPDATE behaviour. */
function columnMap(db, table) {
  const map = new Map();
  for (const row of db.prepare(`PRAGMA table_info(${table})`).all()) {
    map.set(row.name, {
      position: row.cid,
      type: String(row.type || "").toUpperCase(),
      notNull: row.notnull === 1,
      dflt: row.dflt_value === null || row.dflt_value === undefined ? null : normalizeSql(row.dflt_value),
      pk: row.pk,
    });
  }
  return map;
}

function foreignKeySet(db, table) {
  return new Set(
    db
      .prepare(`PRAGMA foreign_key_list(${table})`)
      .all()
      .map((row) =>
        [
          String(row.from).toLowerCase(),
          "->",
          `${String(row.table).toLowerCase()}.${String(row.to ?? "").toLowerCase()}`,
          `on_delete=${String(row.on_delete || "").toLowerCase()}`,
          `on_update=${String(row.on_update || "").toLowerCase()}`,
        ].join(" "),
      ),
  );
}

/**
 * Named indexes (from sqlite_master, so expression indexes such as
 * `lower(username)` are compared by their real expression) and constraint-backed
 * auto indexes (from PRAGMA, keyed by uniqueness + column list, because SQLite
 * names them positionally and the names are not stable across schemas).
 */
function indexInfo(db, table) {
  const named = new Map();
  for (const row of db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL")
    .all(table)) {
    named.set(row.name, normalizeSql(row.sql));
  }
  const auto = new Set();
  for (const row of db.prepare(`PRAGMA index_list(${table})`).all()) {
    if (row.origin === "c") continue; // CREATE INDEX — already captured above
    const cols = db
      .prepare(`PRAGMA index_info(${row.name})`)
      .all()
      .map((col) => (col.name === null ? `<expr:${col.cid}>` : String(col.name).toLowerCase()));
    auto.add(`${row.origin}|unique=${row.unique}|${cols.join(",")}`);
  }
  return { named, auto };
}

/**
 * CHECK constraints, which no PRAGMA exposes. Scanned out of the table DDL with
 * balanced-paren matching so `CHECK (property_access_mode IN ('all','specific'))`
 * is compared as a whole, formatting-insensitively.
 */
function checkSet(db, table) {
  const ddl = String(
    db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table)?.sql || "",
  );
  const found = new Set();
  const pattern = /\bcheck\s*\(/gi;
  let match = pattern.exec(ddl);
  while (match) {
    let depth = 0;
    let index = match.index + match[0].length - 1;
    const start = index;
    for (; index < ddl.length; index += 1) {
      if (ddl[index] === "(") depth += 1;
      else if (ddl[index] === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    found.add(normalizeSql(ddl.slice(start, index + 1)));
    pattern.lastIndex = index + 1;
    match = pattern.exec(ddl);
  }
  return found;
}

function describeColumn(column) {
  return `type=${column.type} notnull=${column.notNull} default=${column.dflt} pk=${column.pk}`;
}

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

const run = makeRunner("verify-schema-parity");
const staging = loadDb(STAGING_PATH);
const production = loadDb(PRODUCTION_PATH);
const stagingTables = tableSet(staging);
const productionTables = tableSet(production);

await run.check("every production auth table exists in worker/schema.sql", () => {
  for (const table of AUTH_TABLES) {
    assert(productionTables.has(table), `production schema is missing declared auth table ${table}`);
    assert(stagingTables.has(table), `worker/schema.sql is missing production auth table ${table}`);
  }
});

for (const table of AUTH_TABLES) {
  await run.check(`${table}: every production column matches exactly in staging`, () => {
    const prodCols = columnMap(production, table);
    const stageCols = columnMap(staging, table);
    // Accumulate instead of throwing on the first mismatch: a drifted schema
    // usually drifts in many columns at once, and one divergence per run would
    // turn a single repair into a dozen blind edit/re-run cycles.
    const problems = [];
    for (const [name, expected] of prodCols) {
      const actual = stageCols.get(name);
      if (!actual) {
        problems.push(`${name}: MISSING from worker/schema.sql`);
        continue;
      }
      if (describeColumn(actual) !== describeColumn(expected)) {
        problems.push(`${name}: expected [${describeColumn(expected)}] got [${describeColumn(actual)}]`);
      }
    }
    assert(problems.length === 0, `${table} diverges from production in ${problems.length} column(s):\n      - ${problems.join("\n      - ")}`);
  });

  await run.check(`${table}: staging declares no unapproved or unsafe extra column`, () => {
    const prodCols = columnMap(production, table);
    const stageCols = columnMap(staging, table);
    const allowed = STAGING_ONLY_COLUMNS.get(table) ?? new Map();
    for (const [name, column] of stageCols) {
      if (prodCols.has(name)) continue;
      assert(
        allowed.has(name),
        `${table}.${name} exists only in worker/schema.sql and is not in STAGING_ONLY_COLUMNS`,
      );
      assert(
        !column.notNull || column.dflt !== null,
        `staging-only column ${table}.${name} is NOT NULL without a DEFAULT, so a production-shaped INSERT would fail`,
      );
    }
  });

  await run.check(`${table}: production column order is preserved in staging`, () => {
    const prodNames = [...columnMap(production, table).keys()];
    const stageOrder = [...columnMap(staging, table).keys()].filter((name) => prodNames.includes(name));
    assertEqual(stageOrder.join(","), prodNames.join(","), `${table} shared column order diverges`);
  });

  await run.check(`${table}: foreign keys are identical`, () => {
    const expected = [...foreignKeySet(production, table)].sort();
    const actual = [...foreignKeySet(staging, table)].sort();
    assertEqual(actual.join(" | "), expected.join(" | "), `${table} foreign keys diverge`);
  });

  await run.check(`${table}: CHECK constraints are identical`, () => {
    const expected = [...checkSet(production, table)].sort();
    const actual = [...checkSet(staging, table)].sort();
    assertEqual(actual.join(" | "), expected.join(" | "), `${table} CHECK constraints diverge`);
  });

  await run.check(`${table}: every production index and uniqueness constraint is present`, () => {
    const expected = indexInfo(production, table);
    const actual = indexInfo(staging, table);
    for (const [name, sql] of expected.named) {
      assert(actual.named.has(name), `worker/schema.sql ${table} is missing production index ${name}`);
      assertEqual(actual.named.get(name), sql, `index ${name} diverges from production`);
    }
    for (const signature of expected.auto) {
      assert(
        actual.auto.has(signature),
        `${table} is missing a production key/uniqueness constraint: ${signature}`,
      );
    }
  });

  await run.check(`${table}: staging adds no unapproved index and no extra UNIQUE constraint`, () => {
    const expected = indexInfo(production, table);
    const actual = indexInfo(staging, table);
    const allowed = STAGING_ONLY_INDEXES.get(table) ?? new Set();
    for (const [name, sql] of actual.named) {
      if (expected.named.has(name)) continue;
      assert(allowed.has(name), `${table} index ${name} exists only in staging and is not allowlisted`);
      assert(
        !/\bcreate unique index\b/.test(sql),
        `staging-only index ${name} is UNIQUE, which production does not enforce`,
      );
    }
    for (const signature of actual.auto) {
      assert(
        expected.auto.has(signature),
        `${table} declares a key/uniqueness constraint production lacks: ${signature}`,
      );
    }
  });
}

await run.check("production remains an authentication-only database", () => {
  const businessTables = [...productionTables].filter((table) => !AUTH_TABLES.includes(table));
  assertEqual(
    businessTables.sort().join(","),
    "",
    "migrations-production declares non-auth tables; production must stay auth-only",
  );
});

run.done();
if (process.exitCode) process.exit(1);
console.log("PASSED: Worker and production authentication schema parity verified.");
