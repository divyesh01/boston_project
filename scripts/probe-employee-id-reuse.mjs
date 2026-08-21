// Probe for the "employee_id is reused after a delete and inherits the previous
// person's payroll history" defect (launch item #1).
//
// THE DEFECT. `nextEmployeeId` derived the next suffix from the ids present in
// the *current* staff array. Deleting the highest-numbered person under a prefix
// removes that id from the set, so `maxSuffix` rewinds and the very next hire
// under the same prefix is issued the id that was just freed.
//
// WHY THAT IS CORRUPTION, NOT COSMETICS. `src/lib/employeeId.js` used to claim
// employee_id "is not referenced as a key anywhere else". That is false:
//
//   * src/pages/Payroll.jsx:425-428 de-duplicates historical payroll runs on
//     `(employee_id, pay_period_end)`. A reissued id makes the new hire's runs
//     look like they already exist, so they are silently SKIPPED.
//   * src/lib/timecardCalc.js keyOf() groups punches by employee_id, so the new
//     hire's hours merge with the departed employee's hours into one payroll row.
//   * src/api/localDb.js indexes TimecardPunch on employee_id.
//
// THE FIX UNDER TEST. A persisted, monotonic per-prefix high-water counter
// (Dexie store `IdSequence`) that only ever moves forward, so an id is never
// reissued even after a hard delete. The counter is also floored by the highest
// suffix visible in the live staff list, so a fresh device (or a wiped counter)
// can never rewind below an id that demonstrably exists.
//
// Run: node --import ./scripts/_loader-boot.mjs scripts/probe-employee-id-reuse.mjs

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

let pass = 0;
let fail = 0;
const T = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`); }
};

const localDb = (await import("@/api/localDb")).default;
const employeeIdMod = await import("@/lib/employeeId");
const { nextEmployeeId, employeeIdPrefix } = employeeIdMod;
const { reserveEmployeeId, peekIdSequence } = employeeIdMod;

// The exact de-dupe expression from src/pages/Payroll.jsx:425-428, lifted so the
// probe asserts against the real collision rule rather than a paraphrase.
const payrollKeyOf = (row) => row.employee_id || row.id || row.employee_name;
const runExistsFor = (runs, staffRow, periodEnd) => {
  const staffId = payrollKeyOf(staffRow);
  return runs.some((r) => payrollKeyOf(r) === staffId && r.pay_period_end === periodEnd);
};

console.log("=== 1. The pure generator still refuses to collide with a LIVE id ===");
{
  const staff = [
    { employee_id: "JOH001", employee_name: "John Adams" },
    { employee_id: "JOH002", employee_name: "Johan Berg" },
    { employee_id: "JOH003", employee_name: "Johnny Cash" },
  ];
  const next = nextEmployeeId("John Doe", staff);
  T("a 4th Joh* hire gets JOH004", next === "JOH004", `got ${next}`);
  T("prefix helper strips non-letters", employeeIdPrefix("Jo Smith 3rd") === "JOS",
    `got ${employeeIdPrefix("Jo Smith 3rd")}`);
  T("a nameless record falls back to EMP", employeeIdPrefix("") === "EMP");
}

console.log("\n=== 2. Deleting the highest id must NOT free it for reuse ===");
{
  // Three Joh* staff exist; JOH003 (Johnny Cash) leaves the company. His payroll
  // history stays in the books, as the delete dialog promises.
  const afterDelete = [
    { employee_id: "JOH001", employee_name: "John Adams" },
    { employee_id: "JOH002", employee_name: "Johan Berg" },
  ];
  const history = [
    { employee_id: "JOH003", employee_name: "Johnny Cash", pay_period_end: "2026-07-31", total_pay: 4200 },
  ];

  // Pure path: with only the live list to go on, the generator CANNOT know JOH003
  // was ever issued. This is why the persisted counter is required, and why the
  // historical ids must be passed in when they are available.
  const naive = nextEmployeeId("John Doe", afterDelete);
  T("pure generator with only live staff rewinds onto the freed id (documents WHY the counter is needed)",
    naive === "JOH003", `got ${naive}`);

  // Contract: when the caller can supply historical ids, the pure generator must
  // honour them.
  const withHistory = nextEmployeeId("John Doe", [...afterDelete, ...history]);
  T("pure generator skips a retired id when history is supplied",
    withHistory === "JOH004", `got ${withHistory}`);

  // And the corruption that reuse causes, stated as an executable fact.
  const reusedHire = { employee_id: naive, employee_name: "John Doe" };
  T("a reissued id makes a NEW hire's payroll run look already-posted (silent skip)",
    runExistsFor(history, reusedHire, "2026-07-31") === true,
    "this is the data-loss mechanism, asserted true against the buggy id");
  const cleanHire = { employee_id: withHistory, employee_name: "John Doe" };
  T("a never-reused id does not collide with the departed employee's run",
    runExistsFor(history, cleanHire, "2026-07-31") === false);
}

console.log("\n=== 3. The persisted counter is monotonic across deletes ===");
if (typeof reserveEmployeeId !== "function") {
  T("reserveEmployeeId is exported", false, "employeeId.js exports no persisted reservation function");
} else {
  await localDb.IdSequence.clear();
  

  const a = await reserveEmployeeId("Johnny Cash", []);
  const b = await reserveEmployeeId("Johan Berg", [{ employee_id: a }]);
  const c = await reserveEmployeeId("John Adams", [{ employee_id: a }, { employee_id: b }]);
  T("first three Joh* reservations are 001/002/003",
    a === "JOH001" && b === "JOH002" && c === "JOH003", `got ${a}, ${b}, ${c}`);

  // JOH003 is hard-deleted. Only JOH001/JOH002 remain visible.
  const live = [{ employee_id: a }, { employee_id: b }];
  const d = await reserveEmployeeId("John Doe", live);
  T("after deleting the highest id, the next reservation does NOT reuse it",
    d === "JOH004", `got ${d} (must not be ${c})`);
  T("and it is not any live id either", d !== a && d !== b);

  // Delete everything under the prefix; the counter must still not rewind.
  const e = await reserveEmployeeId("Johnathan Smith", []);
  T("with the whole prefix deleted the counter still moves forward",
    e === "JOH005", `got ${e}`);
}

console.log("\n=== 4. The counter survives a device restart (reopen) ===");
if (typeof reserveEmployeeId === "function") {
  const seqBefore = await peekIdSequence?.("JOH");
  localDb.close();
  await localDb.open();
  
  const seqAfter = await peekIdSequence?.("JOH");
  T("the persisted sequence is unchanged by a close/open cycle",
    seqBefore === seqAfter && seqAfter >= 5, `before=${seqBefore} after=${seqAfter}`);
  const f = await reserveEmployeeId("Johnson King", []);
  T("the reservation after a restart continues from the stored value",
    f === "JOH006", `got ${f}`);
}

console.log("\n=== 5. A wiped counter is floored by the live staff list (no rewind) ===");
if (typeof reserveEmployeeId === "function") {
  await localDb.IdSequence.clear();
  
  const live = [{ employee_id: "JOH009" }, { employee_id: "JOH004" }];
  const g = await reserveEmployeeId("Johanna Vance", live);
  T("an empty counter never issues below the highest live suffix",
    g === "JOH010", `got ${g}`);
  T("the floor was persisted, not just returned",
    (await peekIdSequence?.("JOH")) === 10, `stored=${await peekIdSequence?.("JOH")}`);
}

console.log("\n=== 6. Concurrent reservations cannot collide (double-click / two tabs) ===");
if (typeof reserveEmployeeId === "function") {
  await localDb.IdSequence.clear();
  
  const results = await Promise.all(
    Array.from({ length: 12 }, () => reserveEmployeeId("Casey Stone", []))
  );
  const unique = new Set(results);
  T("12 parallel reservations yield 12 distinct ids",
    unique.size === 12, `got ${unique.size} distinct: ${results.join(",")}`);
  T("they form an unbroken 1..12 run under one prefix",
    results.map((r) => Number(r.slice(3))).sort((x, y) => x - y).join(",") ===
      Array.from({ length: 12 }, (_, i) => i + 1).join(","),
    results.join(","));
}

console.log("\n=== 7. Prefix counters are independent ===");
if (typeof reserveEmployeeId === "function") {
  await localDb.IdSequence.clear();
  
  const s1 = await reserveEmployeeId("Smith Jones", []);
  const j1 = await reserveEmployeeId("Johnny Rose", []);
  const s2 = await reserveEmployeeId("Smithers Burns", []);
  T("SMI and JOH advance separately",
    s1 === "SMI001" && j1 === "JOH001" && s2 === "SMI002", `got ${s1}, ${j1}, ${s2}`);
}

console.log("\n=== 8. Imported / legacy ids above the counter are respected ===");
if (typeof reserveEmployeeId === "function") {
  await localDb.IdSequence.clear();
  
  // A CSV import seeded ids far above anything this device ever issued.
  const imported = [{ employee_id: "emp042" }, { employee_id: " EMP0100 " }];
  const n = await reserveEmployeeId("", imported);
  T("case/whitespace-insensitive match against imported ids",
    n === "EMP101", `got ${n}`);
}

console.log("\n=== 9. Reservation never returns a blank or malformed id ===");
if (typeof reserveEmployeeId === "function") {
  await localDb.IdSequence.clear();
  
  const weird = await Promise.all([
    reserveEmployeeId(null, []),
    reserveEmployeeId(undefined, []),
    reserveEmployeeId("123 456", []),
    reserveEmployeeId("Ünïcödé Nàme", []),
  ]);
  T("every id matches ^[A-Z]{1,3}\\d{3,}$",
    weird.every((w) => /^[A-Z]{1,3}\d{3,}$/.test(w)), weird.join(","));
  T("no two are equal", new Set(weird).size === weird.length, weird.join(","));
}

console.log(`\n${fail === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
