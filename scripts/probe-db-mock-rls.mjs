// probe-db-mock-rls.mjs
//
// Regression probe for two defect classes that a naive find/replace reintroduces:
//
//   1. base44/functions/*/entry.* declaring a fake `db` shim
//      (`const db = globalThis.__B44_DB__ || {...}`) and then calling `db.*`
//      instead of the real SDK client from `createClientFromRequest(req)`.
//      The shim's methods resolve to empty arrays / null / {}, so every read
//      returns "no rows" and every write is silently discarded. Because the
//      shim satisfies the type checker, `tsc --noEmit` and eslint are both
//      blind to it — this probe is the only automated guard. (eslint.config.js
//      ignores base44/** entirely.)
//
//   2. Property-scoped entity RLS rules whose $and/$or operators are flipped.
//      The canonical rule is
//          $and[ is_active, $or[ admin, owner, property_access ] ]
//      A flipped inner $or -> $and demands one user be admin AND owner at the
//      same instant (nobody can read). A flipped outer $and -> $or lets ANY
//      active user through regardless of role or property (cross-property data
//      leak). Both failure modes are invisible to every other suite because
//      RLS is enforced by the Base44 host, not by this codebase.
//
// Also asserts the two audit writers that were previously wired to the shim
// still sign their rows, since audit_verify reports a hashless row as tampered.
//
// Usage: node scripts/probe-db-mock-rls.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const warnings = [];
const notes = [];

// ── helpers ───────────────────────────────────────────────────────────────────

// Strip // and /* */ comments while preserving line numbering, so a `db.`
// mentioned in prose (audit_clear/entry.js has one) is not a false positive.
// The `[^:]` guard keeps "https://..." from being treated as a comment.
function stripCommentsPerLine(src) {
  const out = [];
  let inBlock = false;
  for (const raw of src.split(/\r?\n/)) {
    let line = raw;
    if (inBlock) {
      const end = line.indexOf("*/");
      if (end === -1) {
        out.push("");
        continue;
      }
      line = line.slice(end + 2);
      inBlock = false;
    }
    let guard = 0;
    while (guard++ < 50) {
      const open = line.indexOf("/*");
      if (open === -1) break;
      const close = line.indexOf("*/", open + 2);
      if (close === -1) {
        line = line.slice(0, open);
        inBlock = true;
        break;
      }
      line = line.slice(0, open) + line.slice(close + 2);
    }
    line = line.replace(/(^|[^:])\/\/.*$/, "$1");
    out.push(line);
  }
  return out;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (typeof a !== "object") return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  if (Array.isArray(a)) return a.every((v, i) => deepEqual(v, b[i]));
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

// ── 1. no fake `db` shim, and no `db.*` call sites, in any serverless function ─

const FN_DIR = path.join(ROOT, "base44", "functions");
const fnFiles = fs
  .readdirSync(FN_DIR)
  .flatMap((dir) => {
    const d = path.join(FN_DIR, dir);
    if (!fs.statSync(d).isDirectory()) return [];
    return fs
      .readdirSync(d)
      .filter((f) => /^entry\.(ts|js)$/.test(f))
      .map((f) => path.join(d, f));
  })
  .sort();

if (fnFiles.length === 0) failures.push("no base44/functions/*/entry.* files found — probe cannot assert anything");

for (const file of fnFiles) {
  const rel = path.relative(ROOT, file).replace(/\\/g, "/");
  const src = fs.readFileSync(file, "utf8");

  if (/globalThis\s*\.\s*__B44_DB__/.test(src)) {
    const line = src.split(/\r?\n/).findIndex((l) => /__B44_DB__/.test(l)) + 1;
    failures.push(`${rel}:${line} declares the fake __B44_DB__ db shim — reads return [] and writes are discarded`);
  }

  const codeLines = stripCommentsPerLine(src);
  codeLines.forEach((line, i) => {
    if (/(^|[^\w$.])db\s*\./.test(line)) {
      failures.push(`${rel}:${i + 1} calls the shim: ${line.trim().slice(0, 96)}`);
    }
  });
}
notes.push(`scanned ${fnFiles.length} serverless entry files for the db shim`);

// ── 2. property-scoped entity RLS must match the canonical operator nesting ────

const ENT_DIR = path.join(ROOT, "base44", "entities");

// Any entity that scopes rows by {{user.property_access}} is property-scoped and
// must carry byte-identical read and write rules. Detecting them by that marker
// (rather than a hardcoded list) means a newly added property-scoped entity is
// covered automatically instead of silently skipped.
const canonicalRule = {
  $and: [
    { user_condition: { is_active: true } },
    {
      $or: [
        { user_condition: { role: "admin" } },
        { user_condition: { role: "owner" } },
        { "data.property_id": { $in: "{{user.property_access}}" } },
      ],
    },
  ],
};

const entFiles = fs
  .readdirSync(ENT_DIR)
  .filter((f) => f.endsWith(".jsonc"))
  .sort();
let scoped = 0;
const scopedRules = [];

for (const f of entFiles) {
  const abs = path.join(ENT_DIR, f);
  const raw = fs.readFileSync(abs, "utf8");
  if (!raw.includes("{{user.property_access}}")) continue;
  scoped++;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    failures.push(`base44/entities/${f} is not parseable JSON: ${err.message.slice(0, 80)}`);
    continue;
  }

  const rls = parsed.rls;
  if (!rls) {
    failures.push(`base44/entities/${f} references property_access but declares no rls block`);
    continue;
  }

  for (const mode of ["read", "write"]) {
    const rule = rls[mode];
    if (!rule) {
      failures.push(`base44/entities/${f} rls.${mode} is missing`);
      continue;
    }
    scopedRules.push({ file: f, mode, rule });
    if (deepEqual(rule, canonicalRule)) continue;

    const outer = Object.keys(rule)[0];
    const innerObj = Array.isArray(rule[outer]) ? rule[outer].find((c) => c && (c.$and || c.$or)) : null;
    const inner = innerObj ? Object.keys(innerObj)[0] : "(none)";
    const detail =
      outer !== "$and"
        ? `outer operator is ${outer}, must be $and — as written, ANY active user passes regardless of role or property`
        : inner !== "$or"
          ? `inner operator is ${inner}, must be $or — as written, a user must be admin AND owner simultaneously, so nobody passes`
          : "structure differs from the canonical rule";
    failures.push(`base44/entities/${f} rls.${mode}: ${detail}`);
  }
}
notes.push(`checked ${scoped} property-scoped entities (of ${entFiles.length}) against the canonical RLS rule`);

// ── 3. the rules must BEHAVE correctly, not merely look canonical ─────────────
//
// TESTING.md §1: "Never assume code works based on static visual inspection
// alone." §2 above is precisely that — a deep-equal against a literal. It would
// accept a rule that is canonical in shape but wrong in meaning, and it cannot
// state what the rule DOES. So interpret each shipped rule the way the Base44
// host does, and assert the whole access matrix — including the negative case
// SECURITY.md §3 requires: property A must not be able to see property B.
//
// The evaluator is deliberately total: any node it does not recognise THROWS
// rather than defaulting to allow or deny, so a future rule form cannot be
// silently mis-scored as passing.
function evaluateRule(rule, user, row) {
  if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
    throw new Error(`unsupported rule node: ${JSON.stringify(rule)}`);
  }
  const keys = Object.keys(rule);
  if (keys.length !== 1) throw new Error(`rule node needs exactly 1 key, got [${keys.join(", ")}]`);
  const key = keys[0];
  const val = rule[key];

  if (key === "$and") {
    if (!Array.isArray(val) || val.length === 0) throw new Error("$and needs a non-empty array");
    return val.every((c) => evaluateRule(c, user, row));
  }
  if (key === "$or") {
    if (!Array.isArray(val) || val.length === 0) throw new Error("$or needs a non-empty array");
    return val.some((c) => evaluateRule(c, user, row));
  }
  if (key === "user_condition") {
    return Object.entries(val).every(([field, expected]) => user[field] === expected);
  }
  if (key === "data.property_id") {
    if (!val || val.$in !== "{{user.property_access}}") {
      throw new Error(`unsupported property_id matcher: ${JSON.stringify(val)}`);
    }
    return Array.isArray(user.property_access) && user.property_access.includes(row.property_id);
  }
  throw new Error(`unsupported rule operator: ${key}`);
}

const USERS = {
  "active admin": { role: "admin", is_active: true, property_access: [] },
  "active owner": { role: "owner", is_active: true, property_access: [] },
  "clerk scoped to p1": { role: "read_only", is_active: true, property_access: ["p1"] },
  "clerk with no property access": { role: "read_only", is_active: true, property_access: [] },
  "DEACTIVATED admin": { role: "admin", is_active: false, property_access: [] },
  "DEACTIVATED clerk of p1": { role: "read_only", is_active: false, property_access: ["p1"] },
};

// [who, which property's row, may they touch it?]
const MATRIX = [
  ["active admin", "p1", true],
  ["active admin", "p2", true],
  ["active owner", "p1", true],
  ["active owner", "p2", true],
  ["clerk scoped to p1", "p1", true],
  ["clerk scoped to p1", "p2", false], // SECURITY.md §3 — the multi-tenant leak
  ["clerk with no property access", "p1", false],
  ["DEACTIVATED admin", "p1", false], // is_active must outrank role
  ["DEACTIVATED clerk of p1", "p1", false],
];

function runMatrix(rule) {
  const bad = [];
  for (const [who, propertyId, expected] of MATRIX) {
    let got;
    try {
      got = evaluateRule(rule, USERS[who], { property_id: propertyId });
    } catch (err) {
      bad.push(`${who} on ${propertyId}: evaluator error: ${err.message}`);
      continue;
    }
    if (got !== expected) {
      bad.push(`${who} on a ${propertyId} row: expected ${expected ? "ALLOW" : "DENY"}, got ${got ? "ALLOW" : "DENY"}`);
    }
  }
  return bad;
}

// An assertion suite that cannot fail is decoration, not evidence. Before
// trusting the matrix, re-run it against the two corruptions actually found in
// this repo on 2026-08-19 and require that BOTH are caught.
const mutants = [
  {
    name: "outer $and flipped to $or (the cross-property leak)",
    rule: { $or: canonicalRule.$and },
    mustCatch: "clerk scoped to p1 on a p2 row",
  },
  {
    name: "inner $or flipped to $and (admin AND owner at once — nobody passes)",
    rule: { $and: [canonicalRule.$and[0], { $and: canonicalRule.$and[1].$or }] },
    mustCatch: "active admin on a p1 row",
  },
];
for (const m of mutants) {
  const caught = runMatrix(m.rule);
  if (caught.length === 0) {
    failures.push(`SELF-TEST: the access matrix does NOT detect ${m.name} — it proves nothing about the shipped rules`);
  } else if (!caught.some((c) => c.startsWith(m.mustCatch))) {
    failures.push(`SELF-TEST: the access matrix caught ${m.name} but not via the expected case (${m.mustCatch}); caught: ${caught.join("; ")}`);
  }
}
notes.push(`access matrix self-test: both historical RLS corruptions are detected (${MATRIX.length} cases per rule)`);

// Now the shipped rules.
let behavioural = 0;
for (const { file, mode, rule } of scopedRules) {
  const bad = runMatrix(rule);
  behavioural++;
  for (const b of bad) failures.push(`base44/entities/${file} rls.${mode} grants the wrong access — ${b}`);
}
notes.push(`evaluated ${behavioural} shipped rule(s) against the access matrix`);

// ── 4. AGENTS.md must not carry the injected shim — WARNING, NOT A FAILURE ───
//
// RESOLVED 2026-08-19: AGENTS.md opened with
// `const db = globalThis.__B44_DB__ || {...}` above its own heading. That is the
// most likely route by which the shim reached seven serverless functions — an
// agent reads its own rulebook and copies line 1 as the house way to query the
// database. The owner authorized its removal and the two lines are gone; this
// check stays as the regression guard.
//
// It reports a WARNING rather than a failure because AGENTS.md is item 11 on
// PROTECTED_FILES.md: if the line ever returns, no agent may delete it without
// fresh owner authorization, and a probe must not demand a fix nobody is allowed
// to make. A permanently red guard gets muted, and muting this one would also
// silence the checks above, which nothing else in the repo covers (eslint
// ignores base44/**, and tsc never sees it).
const agents = path.join(ROOT, "AGENTS.md");
if (fs.existsSync(agents) && fs.readFileSync(agents, "utf8").includes("__B44_DB__")) {
  warnings.push(
    "AGENTS.md contains injected __B44_DB__ JavaScript (line 1). That file is " +
      "PROTECTED (PROTECTED_FILES.md #11), so only the repository owner may remove it. " +
      "Until then, an agent that copies it reintroduces the exact shim checked for above.",
  );
}

// ── 5. the two former shim callers must sign their audit rows ─────────────────

for (const rel of ["base44/functions/autoPayroll/entry.ts", "base44/functions/deleteAccount/entry.ts"]) {
  const abs = path.join(ROOT, rel);
  // This was `if (!fs.existsSync(abs)) continue;`. Renaming or moving either file
  // then retired the AUDIT_CANONICAL_V1 check on it and the probe still printed
  // `✅ PROBE PASSED: ... audit rows signed.` — an unsigned row and an unread file
  // produced the same verdict. Both paths are tracked, so absence here is a broken
  // checkout or a move that did not update this list, never an optional
  // configuration; announcing it as a skip would let the rename quietly take the
  // guard with it. So it fails and it names the path.
  //
  // The `continue` on the next condition is a different animal and stays silent on
  // purpose: a function that writes no audit rows has nothing to sign.
  if (!fs.existsSync(abs)) {
    failures.push(`${rel} is missing — it is tracked, so it was renamed, moved or deleted; the AUDIT_CANONICAL_V1 signed-payload check did not run against it`);
    continue;
  }
  const src = fs.readFileSync(abs, "utf8");
  if (!/AuditLog\.create/.test(src)) continue;
  if (!src.includes("AUDIT_CANONICAL_V1")) {
    failures.push(`${rel} writes an AuditLog row without the AUDIT_CANONICAL_V1 signed payload — audit_verify reports a hashless row as tampered`);
  }
}

// ── 6. repo-root helper scripts must at least parse ───────────────────────────

const enhance = path.join(ROOT, "enhance.js");
// The `if (fs.existsSync(enhance))` that used to open this block had no else, so a
// missing enhance.js meant the parse check simply did not happen and the probe
// reported the same PASSED line. enhance.js is tracked and is not gitignored
// (`git check-ignore -v enhance.js` is empty), so its absence is a broken checkout,
// not a build that legitimately skips it — hence a failure naming the file rather
// than a skip line nobody reads.
if (!fs.existsSync(enhance)) {
  failures.push("enhance.js is missing — it is tracked and not gitignored, so the `node --check` parse test could not run; restore the file or delete this check deliberately");
} else {
  try {
    execFileSync(process.execPath, ["--check", enhance], { stdio: "pipe" });
  } catch (err) {
    const msg = String(err.stderr || err.message)
      .split("\n")
      .find((l) => /Error/.test(l)) || "syntax error";
    failures.push(`enhance.js does not parse: ${msg.trim().slice(0, 90)}`);
  }
}

// ── report ────────────────────────────────────────────────────────────────────

for (const n of notes) console.log(`   · ${n}`);
console.log("");

for (const w of warnings) console.warn(`   ⚠ OWNER ACTION REQUIRED: ${w}`);
if (warnings.length) console.log("");

// One verdict line on both paths. `behavioural` counts shipped RLS rules
// evaluated against the access matrix; `failures` also collects the static
// checks and the self-test, so the two are different populations and
// `behavioural - failures.length` was arithmetic across unrelated quantities
// (it can even go negative — there are 12 distinct failures.push sites and only
// one of them is behavioural).
console.log(`\n${failures.length === 0 ? "PASSED" : "FAILED"}: ${behavioural} passed, ${failures.length} failed`);
if (failures.length) {
  console.error(`❌ PROBE FAILED (Code 1): ${failures.length} defect(s)\n`);
  for (const f of failures) console.error(`   ✗ ${f}`);
  process.exit(1);
}

console.log("✅ PROBE PASSED: no db shim, no shim call sites, RLS operators canonical, audit rows signed.");
process.exit(failures.length > 0 ? 1 : 0);
