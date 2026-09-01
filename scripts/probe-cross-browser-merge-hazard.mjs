// PROBE: two browsers cannot be merged into one database, because none of the
// keys that would have to line up is stable across browsers.
//
// This is a CHARACTERIZATION probe. It asserts that the hazard EXISTS and it is
// expected to PASS. It is the evidence behind a decision the owner has already
// taken — existing data reaches the shared database from ONE canonical browser
// and every other browser's local data is discarded, never merged. If a later
// change makes any of these assertions fail, the premise of that decision has
// moved and it must be revisited, not quietly outlived.
// scripts/verify-no-auto-merge.mjs is the standing gate; this file is the proof.
//
// THREE INDEPENDENT COLLISIONS, all rooted in Dexie `++id` autoincrement being a
// per-browser counter with no global meaning:
//
// 1. SAME HOTEL, DIFFERENT LOCAL id  ->  DOUBLE COUNT
//    transactionDedupeKey() in src/lib/transactionNorm.js is
//      [property_id, date, time, folio_number, transaction_code, amount, occurrence]
//    joined with "|". property_id leads it. Two browsers that both hold the
//    Middleborough property, one as id 1 and one as id 2 because that browser
//    happened to create a different property first, produce disjoint key sets for
//    byte-identical source rows. The row-level dedupe guard
//    (existingTxnDedupeKeys, the real function importReport uses) therefore
//    suppresses nothing and every transaction lands twice.
//
//    And it cannot be repaired by inserting both Property rows either: localDb v22
//    declares `Property: '++id, &code, ...'`, so a second row with the same `code`
//    is refused outright. `code` is in fact the ONLY cross-browser-stable
//    identifier the schema has — which is why a merge would have to remap ids,
//    and remapping invalidates every dedupe_key already stored.
//
// 2. DIFFERENT HOTELS, SAME LOCAL id  ->  SILENT FUSION
//    Two browsers that each created their first property get id 1 for two
//    different hotels. Identical folio/date/code/amount rows from the two hotels
//    then produce IDENTICAL dedupe keys, and the guard deletes nothing — it
//    SUPPRESSES the incoming row. The second hotel's revenue does not double, it
//    disappears.
//
// 3. employee_id  ->  TWO PEOPLE, ONE PAYROLL ROW
//    IdSequence (localDb v23) is keyed on the employee-id prefix and is
//    deliberately NOT property-scoped, with the reason written into the schema
//    comment: "the payroll de-dupe key carries no property_id, so an id must be
//    unique across the whole account". That reasoning is correct WITHIN one
//    browser and has no force across two. src/lib/employeeId.js answers the
//    desync objection with a second defence — the counter is floored by the
//    highest suffix VISIBLE IN THE LIVE STAFF LIST, "so a device with no counter
//    row (fresh install, restored backup, cleared storage) still cannot issue
//    below an id that demonstrably exists". Section 4 shows that defence holding
//    within one browser and having no force across two: a second browser lacks
//    the counter row AND the staff list, so there is nothing to floor against,
//    and it issues JOH001 again to a different person. employee_id is a real join
//    key — Payroll.jsx de-duplicates historical runs on
//    `(employee_id || id || employee_name, pay_period_end)` and
//    timecardCalc.reconcileTimecards groups on `${employeeKey}||${weekStart}` —
//    so section 4 merges two different people's hours into one row and prints the
//    total.
//
// The prefix is the first three letters of the name (employeeIdPrefix), so the
// colliding pairs below are deliberately chosen to share one: John / Johanna /
// Johnathan / Johnny all prefix to JOH. Two people whose names differ in the
// first three letters cannot collide, which is exactly why the collision has to
// be demonstrated with names that can.
//
// Run: node --import ./scripts/_loader-boot.mjs scripts/probe-cross-browser-merge-hazard.mjs

await import("fake-indexeddb/auto");
globalThis.crypto ??= (await import("node:crypto")).webcrypto;

const __store = new Map();
const __storage = {
  getItem: (k) => (__store.has(k) ? __store.get(k) : null),
  setItem: (k, v) => __store.set(k, String(v)),
  removeItem: (k) => __store.delete(k),
  clear: () => __store.clear(),
};
globalThis.localStorage = __storage;
globalThis.sessionStorage = __storage;
globalThis.window = globalThis;
if (globalThis.navigator === undefined) {
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: "harness", language: "en-US" },
    configurable: true,
  });
}

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..");

const localDb = (await import("@/api/localDb")).default;
const { db } = await import("@/api/base44Client");
const { transactionDedupeKey, assignDedupeKeys } = await import("@/lib/transactionNorm");
const { existingTxnDedupeKeys } = await import("@/lib/reportParsers");
const { reserveEmployeeId, peekIdSequence } = await import("@/lib/employeeId");
const { reconcileTimecards } = await import("@/lib/timecardCalc");
const { signInAsAllPropertyOwner } = await import("./_harness-auth.mjs");

let pass = 0;
let fail = 0;
const failures = [];

function ok(label, cond, detail = "") {
  if (cond) {
    pass += 1;
    console.log(`  ok   ${label}`);
  } else {
    fail += 1;
    failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
const eq = (label, actual, expected) =>
  ok(label, actual === expected, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);

// One night's postings from a PMS transaction export, byte-identical in both
// browsers because they came from the same source file.
const SOURCE_ROWS = [
  { date: "2026-01-05", time: "08:14", folio_number: "F1001", transaction_code: "RM", transaction_type: "CHARGE", amount: 129.0, username: "clerk1", room_number: "101" },
  { date: "2026-01-05", time: "08:14", folio_number: "F1001", transaction_code: "TAX", transaction_type: "CHARGE", amount: 15.48, username: "clerk1", room_number: "101" },
  { date: "2026-01-05", time: "11:02", folio_number: "F1002", transaction_code: "RM", transaction_type: "CHARGE", amount: 149.0, username: "clerk2", room_number: "102" },
  { date: "2026-01-06", time: "09:30", folio_number: "F1003", transaction_code: "RM", transaction_type: "CHARGE", amount: 129.0, username: "clerk1", room_number: "103" },
];
const SOURCE_TOTAL = SOURCE_ROWS.reduce((s, r) => s + r.amount, 0);
const stamp = (pid) => assignDedupeKeys(SOURCE_ROWS.map((r) => ({ ...r, property_id: pid })));
const money = (n) => `$${n.toFixed(2)}`;

// Models a DIFFERENT BROWSER, not merely an emptied one.
//
// `table.clear()` deletes rows and leaves the Dexie autoincrement counters where
// they were — one Node process shares one set of counters — so an emptied
// database mints id 4, 5, 6… and "both browsers' first property is id 1" cannot
// be reproduced with it at all. Deleting and reopening the database resets the
// counters, which is the whole mechanism under test. scripts/_harness-auth.mjs
// documents localDb.delete() as a supported reset and requires re-signing in
// afterwards (the user row and the session both live in what was just deleted).
async function freshBrowser() {
  await localDb.delete();
  await localDb.open();
  __store.clear();
  await signInAsAllPropertyOwner();
}

console.log("--- PROBE: CROSS-BROWSER MERGE HAZARD (characterization) ---");
console.log(`    one night of postings, ${SOURCE_ROWS.length} rows, ${money(SOURCE_TOTAL)} of charges`);

// ── 1. The key really is prefixed by property_id ─────────────────────────────
console.log("\n[1] transactionDedupeKey is prefixed by property_id");
{
  const row = SOURCE_ROWS[0];
  eq("the key is the documented pipe-joined tuple",
    transactionDedupeKey({ ...row, property_id: 7 }, 0),
    "7|2026-01-05|08:14|F1001|RM|129|0");
  ok("the FIRST segment is the property id",
    transactionDedupeKey({ ...row, property_id: 7 }, 0).split("|")[0] === "7");
  ok("changing only property_id changes the key",
    transactionDedupeKey({ ...row, property_id: 1 }, 0) !== transactionDedupeKey({ ...row, property_id: 2 }, 0));
  ok("the occurrence index is the LAST segment (so identical postings survive)",
    transactionDedupeKey({ ...row, property_id: 7 }, 3).endsWith("|3"));
  ok("the source of truth is src/lib/transactionNorm.js",
    /row\.property_id \?\? ""/.test(fs.readFileSync(path.join(REPO, "src/lib/transactionNorm.js"), "utf8")));
}

// ── 2. Same hotel, different local id: DOUBLE COUNT ─────────────────────────
console.log("\n[2] same hotel, two browsers, different local Property.id");
{
  await freshBrowser();

  // Browser A created Middleborough first, so it is id 1.
  const a = await db.entities.Property.create({ code: "RRI-MID", name: "Red Roof Middleborough", rooms: 80, active: true });
  // Browser B created a different hotel first, so Middleborough is id 2 there.
  // Modelled by minting one throwaway property ahead of it, which is exactly how
  // the divergence happens in the field.
  await db.entities.Property.create({ code: "RRI-OTHER", name: "Red Roof Other", rooms: 40, active: true });
  const b = await db.entities.Property.create({ code: "RRI-MID-B", name: "Red Roof Middleborough", rooms: 80, active: true });

  eq("browser A holds Middleborough as id 1", a.id, 1);
  eq("browser B holds THE SAME hotel as id 3", b.id, 3);

  const rowsA = stamp(a.id);
  const rowsB = stamp(b.id);
  console.log(`        A: ${rowsA[0].dedupe_key}`);
  console.log(`        B: ${rowsB[0].dedupe_key}`);
  console.log("           ^ same hotel, same source row, same night, different key");

  const keysA = new Set(rowsA.map((r) => r.dedupe_key));
  const overlap = rowsB.filter((r) => keysA.has(r.dedupe_key));
  eq("the two browsers' key sets are DISJOINT", overlap.length, 0);

  // Now the real guard, not a replica: the exact function importReport calls.
  await db.entities.TransactionLine.bulkCreate(rowsA);
  const seenForB = await existingTxnDedupeKeys(db.entities.TransactionLine, b.id, rowsB);
  const survivorsB = rowsB.filter((r) => !seenForB.has(r.dedupe_key));
  eq("the row-level dedupe guard suppresses NOTHING from browser B",
    survivorsB.length, rowsB.length);

  await db.entities.TransactionLine.bulkCreate(survivorsB);
  const all = await localDb.TransactionLine.toArray();
  const total = all.reduce((s, r) => s + Number(r.amount || 0), 0);
  console.log(`        ledger after both uploads: ${all.length} rows, ${money(total)}`);
  console.log(`        the hotel actually posted:  ${SOURCE_ROWS.length} rows, ${money(SOURCE_TOTAL)}`);
  eq("every row landed twice", all.length, SOURCE_ROWS.length * 2);
  eq("the charge total is exactly DOUBLE the truth", total.toFixed(2), (SOURCE_TOTAL * 2).toFixed(2));

  // And the repair that looks obvious is refused by the schema.
  let constraintErr = null;
  try {
    await localDb.Property.add({ code: "RRI-MID", name: "Red Roof Middleborough (merged)", rooms: 80, active: true });
  } catch (e) {
    constraintErr = e?.name || String(e);
  }
  console.log(`        second Property row with code "RRI-MID" => ${constraintErr || "ACCEPTED"}`);
  ok("the &code unique index refuses a duplicate property code",
    constraintErr !== null, "two rows with one code would make `code` useless as the merge key");
  console.log("        => a merge MUST remap ids, and remapping invalidates every stored dedupe_key");
}

// ── 3. Different hotels, same local id: SILENT FUSION ───────────────────────
console.log("\n[3] two different hotels, both created first, both id 1");
{
  await freshBrowser();
  const h1 = await db.entities.Property.create({ code: "RRI-MID", name: "Red Roof Middleborough", rooms: 80, active: true });
  eq("hotel one is id 1 in its own browser", h1.id, 1);

  // The second browser's first property is also id 1 — a different hotel.
  const rowsMid = stamp(1);
  const rowsBoston = stamp(1); // identical source shape, different hotel entirely

  console.log(`        Middleborough: ${rowsMid[0].dedupe_key}`);
  console.log(`        Boston:        ${rowsBoston[0].dedupe_key}`);
  console.log("           ^ two different hotels, IDENTICAL key");
  eq("the keys collide exactly", rowsMid[0].dedupe_key, rowsBoston[0].dedupe_key);
  eq("every row collides, not just the first",
    rowsMid.filter((r, i) => r.dedupe_key === rowsBoston[i].dedupe_key).length, rowsMid.length);

  await db.entities.TransactionLine.bulkCreate(rowsMid);
  const seen = await existingTxnDedupeKeys(db.entities.TransactionLine, 1, rowsBoston);
  const survivors = rowsBoston.filter((r) => !seen.has(r.dedupe_key));
  console.log(`        of Boston's ${rowsBoston.length} rows, ${survivors.length} survive the guard`);
  eq("the guard suppresses the SECOND hotel's entire ledger", survivors.length, 0);

  const total = (await localDb.TransactionLine.toArray()).reduce((s, r) => s + Number(r.amount || 0), 0);
  console.log(`        ledger holds ${money(total)}; the two hotels really posted ${money(SOURCE_TOTAL * 2)}`);
  eq("so the merged ledger is missing an entire hotel's revenue",
    total.toFixed(2), SOURCE_TOTAL.toFixed(2));
  ok("and it is a SILENT loss — the guard reports rows as already-imported",
    survivors.length === 0 && rowsBoston.length > 0);
}

// ── 4. employee_id: two browsers issue the same id to different people ──────
console.log("\n[4] IdSequence is per-browser, employee_id is a join key");
{
  await freshBrowser();

  // The schema comment states the intent; assert it so a later property-scoping
  // change is caught here rather than being discovered in payroll.
  const schema = fs.readFileSync(path.join(REPO, "src/api/localDb.js"), "utf8");
  ok("IdSequence's primary key is the prefix, not an autoincrement",
    /IdSequence: 'prefix, last_seq, updated_date'/.test(schema));
  ok("IdSequence is documented as deliberately NOT property-scoped",
    /Deliberately NOT property-scoped/.test(schema));
  ok("the reason given is that the payroll de-dupe key carries no property_id",
    /payroll de-dupe key carries no\s*\n?\/\/\s*property_id/.test(schema) ||
    /de-dupe key carries no/.test(schema));

  // Browser A hires two people. reserveEmployeeId is called the way Staff.jsx
  // calls it: with the LIVE staff list read back out of the database, so the
  // documented "floored by the highest visible suffix" defence is in play.
  const staffA1 = await db.entities.Staff.create({
    property_id: 1, employee_name: "John Smith", department: "Front Desk", active: true,
    employee_id: await reserveEmployeeId("John Smith", await db.entities.Staff.list()),
  });
  const staffA2 = await db.entities.Staff.create({
    property_id: 1, employee_name: "Johanna Doe", department: "Front Desk", active: true,
    employee_id: await reserveEmployeeId("Johanna Doe", await db.entities.Staff.list()),
  });
  const a1 = staffA1.employee_id;
  const a2 = staffA2.employee_id;
  console.log(`        browser A issues: ${a1} (John Smith), ${a2} (Johanna Doe)   IdSequence JOH last_seq=${await peekIdSequence("JOH")}`);
  eq("browser A's first JOH id", a1, "JOH001");
  eq("browser A's second JOH id", a2, "JOH002");

  // POSITIVE CONTROL — the documented defence works WITHIN one browser.
  // Wipe only the counter row, as a cleared-storage/restored-backup device would,
  // and the live staff list still floors the generator above JOH002.
  await localDb.IdSequence.clear();
  eq("counter row gone", await peekIdSequence("JOH"), 0);
  const flooredByList = await reserveEmployeeId("Johnathan Reyes", await db.entities.Staff.list());
  console.log(`        same browser, counter wiped, staff list intact => ${flooredByList}`);
  eq("the live staff list alone still prevents a collision", flooredByList, "JOH003");

  // BROWSER B — a different machine. It has no counter row AND no staff list,
  // so there is nothing left to floor against. This is the case the defence
  // cannot cover, and it is not simulated by clearing one table: the database is
  // deleted and reopened.
  await freshBrowser();
  eq("browser B has no IdSequence row for JOH", await peekIdSequence("JOH"), 0);
  eq("browser B has an empty staff list", (await db.entities.Staff.list()).length, 0);

  const b1 = await reserveEmployeeId("Johnathan Reyes", await db.entities.Staff.list());
  await db.entities.Staff.create({ property_id: 1, employee_name: "Johnathan Reyes", department: "Housekeeping", active: true, employee_id: b1 });
  const b2 = await reserveEmployeeId("Johnny Alvarez", await db.entities.Staff.list());
  console.log(`        browser B issues: ${b1} (Johnathan Reyes), ${b2} (Johnny Alvarez)   two DIFFERENT people`);
  eq("browser B reissues JOH001 to a different person", b1, a1);
  eq("browser B reissues JOH002 to a different person", b2, a2);

  // The consequence, through the real reconciler. Two different people, same
  // week, same reissued employee_id.
  const punches = [
    { employee_id: "JOH001", employee_name: "John Smith",       department: "Front Desk",   shift_date: "2026-01-05", clock_in: "08:00", clock_out: "16:00" },
    { employee_id: "JOH001", employee_name: "John Smith",       department: "Front Desk",   shift_date: "2026-01-06", clock_in: "08:00", clock_out: "16:00" },
    { employee_id: "JOH001", employee_name: "Johnathan Reyes",  department: "Housekeeping", shift_date: "2026-01-07", clock_in: "08:00", clock_out: "16:00" },
    { employee_id: "JOH001", employee_name: "Johnathan Reyes",  department: "Housekeeping", shift_date: "2026-01-08", clock_in: "08:00", clock_out: "16:00" },
  ];
  const weeks = reconcileTimecards(punches, { deductBreaks: false });
  console.log(`        reconcileTimecards over 4 punches from 2 people => ${weeks.length} payroll row(s)`);
  for (const w of weeks) {
    console.log(`          ${w.employeeKey}  ${w.employeeName}  ${w.department}  ${w.hours}h  (${w.shifts.length} shifts)`);
  }
  eq("two people's punches collapse into ONE payroll row", weeks.length, 1);
  eq("that row carries the hours of BOTH people", weeks[0].hours, 32);
  ok("and it is attributed to whichever name was seen first",
    weeks[0].employeeName === "John Smith",
    `attributed to ${weeks[0].employeeName} — the other person's 16h are paid under someone else's name`);

  // The Payroll page's historical de-dupe reads the same tuple.
  const payrollSrc = fs.readFileSync(path.join(REPO, "src/pages/Payroll.jsx"), "utf8");
  ok("Payroll.jsx de-duplicates historical runs on employee_id + pay_period_end",
    /const staffId = s\.employee_id \|\| s\.id \|\| s\.employee_name/.test(payrollSrc) &&
    /rId === staffId && r\.pay_period_end === period\.periodEnd/.test(payrollSrc),
    "if this changed, re-derive the consequence above");
  console.log("        => a merged roster makes one person's run look already-posted; the other");
  console.log("           person is skipped and never paid.");
}

// ── 5. Nothing in the schema is stable across browsers except Property.code ──
//
// The positive half. A merge needs at least one identifier that means the same
// thing in both databases; this enumerates what the live schema actually offers.
console.log("\n[5] what the live schema offers a merge tool");
{
  const autoTables = localDb.tables.filter((t) => t.schema.primKey.auto === true).map((t) => t.name);
  const uniqueIdx = [];
  for (const t of localDb.tables) {
    for (const i of t.schema.indexes) if (i.unique) uniqueIdx.push(`${t.name}.${i.keyPath}`);
  }
  console.log(`        autoincrement (per-browser) primary keys: ${autoTables.length} of ${localDb.tables.length} tables`);
  console.log(`        unique indexes in the whole schema: ${uniqueIdx.length ? uniqueIdx.join(", ") : "none"}`);
  ok("most tables key on a per-browser autoincrement counter", autoTables.length >= 20,
    `${autoTables.length} tables`);
  eq("the schema has exactly ONE unique business key", uniqueIdx.length, 1);
  eq("and it is Property.code", uniqueIdx[0], "Property.code");
  console.log("        => Property.code is the only cross-browser-stable identifier that exists.");
  console.log("           Every foreign key in the app points at a local autoincrement instead.");
}

// ── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(72)}`);
console.log("VERDICT — the hazard is real and is characterized above:");
console.log(`  same hotel, different local id  -> ${money(SOURCE_TOTAL)} posted becomes ${money(SOURCE_TOTAL * 2)}`);
console.log(`  different hotels, same local id  -> one hotel's ${money(SOURCE_TOTAL)} silently suppressed`);
console.log("  employee_id reissued            -> two people, one payroll row, 32h under one name");
console.log("  only Property.code is stable across browsers; every FK is a local counter");
console.log("  => automatic multi-browser merge is not safe. ONE canonical browser; discard the rest.");
console.log("  => scripts/verify-no-auto-merge.mjs keeps that decision enforced.");
if (failures.length) {
  console.log("\nFailures (a failure here means the DECISION'S PREMISE MOVED — revisit it):");
  failures.forEach((f) => console.log(`  • ${f}`));
}
console.log(`\n${fail === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
