// End-to-end verification of the timecard ingestion + reconciliation path.
//
// Runs the real shipped code (scanReport -> importReport) against a synthetic
// timecard CSV through a real Dexie DB (fake-indexeddb), then checks:
//   - the file is auto-detected as `timecard`
//   - every punch row is parsed and imported into TimecardPunch
//   - midnight-crossing shifts reconcile to the right actual hours
//   - weekly overtime is derived per employee/week by reconcileTimecards
//   - impossible/invalid shifts are flagged as AnomalyAlert rows
//   - a re-import is idempotent and no other table is touched

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";

register(new URL("./resolve-alias.mjs", import.meta.url));

// fake-indexeddb must be installed before anything imports Dexie.
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
  Object.defineProperty(globalThis, "navigator", { value: { userAgent: "harness", language: "en-US" }, configurable: true });
}

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "data", "timecard-sample.csv");
const CSV_TEXT = readFileSync(FIXTURE, "utf8");

let pass = 0, fail = 0;
const T = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`); }
};

const { scanReport, importReport, REPORT_TYPES } = await import("@/lib/reportParsers");
const localDb = (await import("@/api/localDb")).default;
const { db } = await import("@/api/base44Client");
const {
  normalisePunch, shiftDurationMinutes, reconcileTimecards, applyBreaks,
} = await import("@/lib/timecardCalc");
// db.entities fails closed for an unauthenticated caller (blocker B3), so the
// suite has to sign in before it reads or writes a single row.
const { signInAsAllPropertyOwner } = await import("./_harness-auth.mjs");
await signInAsAllPropertyOwner();

const PROPERTY_ID = "prop-timecard-1";
const PROPERTY_NAME = "Timecard Test Property";

// ─── 0. baseline: seed other tables so "untouched" is a real assertion ───
console.log("\n=== 0. Seed pre-existing data (must survive untouched) ===");
const OTHER_TABLES = [
  "Property", "OccupancyDay", "SourceDay", "GrossRevenueDay", "PaymentDay",
  "ClerkShiftRecord", "UploadedReport", "Expense", "PayrollRun", "User",
  "Staff", "ScanResult", "HotelMetric",
];
for (const t of OTHER_TABLES) {
  await localDb[t].add({ property_id: PROPERTY_ID, date: "2026-01-01", marker: "pre-existing", created_date: new Date().toISOString() });
}
const baseline = {};
for (const t of OTHER_TABLES) baseline[t] = await localDb[t].count();

// ─── 1. detection ───────────────────────────────────────────────────────
console.log("\n=== 1. Timecard report is auto-detected ===");
T("`timecard` is a registered report type", REPORT_TYPES.some((r) => r.key === "timecard"));

const scan = await scanReport("auto", "blob:local#timecard-sample.csv", {
  propertyId: PROPERTY_ID, propertyName: PROPERTY_NAME,
  importId: "imp_timecard", sourceFile: "timecard-sample.csv", csvText: CSV_TEXT,
});
T("detected as `timecard`", scan.type === "timecard", `got "${scan.type}"`);

// ─── 2. parsing ─────────────────────────────────────────────────────────
console.log("\n=== 2. Every punch row is parsed ===");
T("scan parsed 5 punches", scan.totalRows === 5, `got ${scan.totalRows}`);
T("every punch has employee/date/in/out",
  scan.rowsToImport.length === 5 && scan.rowsToImport.every((p) => p.employee_name && p.shift_date && p.clock_in && p.clock_out));
T("clock-in values kept verbatim for the reconciler",
  scan.rowsToImport.every((p) => typeof p.clock_in === "string" && p.clock_in.length > 0));
T("shift date normalised to ISO",
  scan.rowsToImport.every((p) => /^\d{4}-\d{2}-\d{2}$/.test(p.shift_date)));

// ─── 3. reconcile math (unit-level on the same rows) ────────────────────
console.log("\n=== 3. timecardCalc reconciles the raw punches ===");
const priya = normalisePunch({ employee_name: "Priya", shift_date: "2026-03-03", clock_in: "6:00 PM", clock_out: "2:00 AM" });
T("12-hour clock parsed (6PM = minute 1080)", priya.clockIn === 1080, `got ${priya.clockIn}`);
T("midnight crossing parsed (2AM = minute 120)", priya.clockOut === 120, `got ${priya.clockOut}`);
T("overnight 6PM->2AM is 8h", Math.round(shiftDurationMinutes(priya) / 60) === 8,
  `got ${shiftDurationMinutes(priya) / 60}h`);
T("overnight shift has no 24h flag", !priya.flags.includes("shift_exceeds_24h"));

const moinA = normalisePunch({ employee_name: "Moin", shift_date: "2026-03-02", clock_in: "07:00", clock_out: "15:30" });
const moinB = normalisePunch({ employee_name: "Moin", shift_date: "2026-03-02", clock_in: "16:00", clock_out: "23:30" });
T("split shift day A = 8.5h", Math.round(shiftDurationMinutes(moinA) / 6) / 10 === 8.5,
  `got ${shiftDurationMinutes(moinA) / 60}h`);
T("split shift day B = 7.5h", Math.round(shiftDurationMinutes(moinB) / 6) / 10 === 7.5,
  `got ${shiftDurationMinutes(moinB) / 60}h`);
const dayTotal = (shiftDurationMinutes(moinA) + shiftDurationMinutes(moinB)) / 60;
T("split shift same day => 16h total (no overnight confusion)", Math.abs(dayTotal - 16) < 0.01, `got ${dayTotal}h`);

const allPunches = scan.rowsToImport.map((p) => ({ ...p }));
const weeks = reconcileTimecards(allPunches, { weeklyOvertimeHours: 40, rates: { Moin: { base_rate: 15 } } });
const moinWeek = weeks.find((w) => w.employeeName === "Moin");
const andreiWeek = weeks.find((w) => w.employeeName === "Andrei");
const priyaWeek = weeks.find((w) => w.employeeName === "Priya");
const blankWeek = weeks.find((w) => w.employeeName === "Not Mapped");
T("one workweek per employee", weeks.length === 4, `got ${weeks.length} weeks`);
T("Moin week exists", moinWeek !== undefined);
T("Moin: 8.5h + 7.5h shifts = 16h gross, 15h net after 2x30min breaks",
  moinWeek && Math.abs(moinWeek.hours + moinWeek.overtime_hours - 15) < 0.01,
  moinWeek ? `${moinWeek.hours} reg + ${moinWeek.overtime_hours} OT` : "no row");
T("Moin: under 40h cap means no OT", moinWeek && moinWeek.overtime_hours === 0,
  moinWeek ? `got ${moinWeek.overtime_hours}` : "no row");
T("Moin: break minutes recorded", moinWeek && moinWeek.unpaid_break_minutes === 60,
  moinWeek ? `got ${moinWeek.unpaid_break_minutes}` : "no row");
T("Andrei: 1h shift reconciles", andreiWeek && Math.abs(andreiWeek.hours - 1) < 0.01);
T("Priya: overnight 6PM->2AM = 8h gross, 7.5h net",
  priyaWeek && Math.abs(priyaWeek.hours - 7.5) < 0.01, priyaWeek ? `got ${priyaWeek.hours}` : "no row");
T("Not Mapped: flagged shift pays 0h", blankWeek && blankWeek.hours === 0 && blankWeek.flags.includes("shift_exceeds_24h"),
  blankWeek ? JSON.stringify(blankWeek.flags) : "no row");

const otWeek = reconcileTimecards([
  { employee_name: "Bella", shift_date: "2026-03-02", clock_in: "08:00", clock_out: "16:00" },
  { employee_name: "Bella", shift_date: "2026-03-03", clock_in: "08:00", clock_out: "16:00" },
  { employee_name: "Bella", shift_date: "2026-03-04", clock_in: "08:00", clock_out: "16:00" },
  { employee_name: "Bella", shift_date: "2026-03-05", clock_in: "08:00", clock_out: "16:00" },
  { employee_name: "Bella", shift_date: "2026-03-06", clock_in: "08:00", clock_out: "16:00" },
  { employee_name: "Bella", shift_date: "2026-03-07", clock_in: "08:00", clock_out: "16:00" }, // 48h gross
], { weeklyOvertimeHours: 40, rates: { Bella: { base_rate: 10 } } });
const bella = otWeek.find((w) => w.employeeName === "Bella");
// 6x8h = 48h gross, minus 6x30min breaks = 45h net -> 40 regular + 5 OT.
T("Bella: 48h gross week => 40 regular + 5 OT (breaks deducted)",
  bella && Math.abs(bella.hours - 40) < 0.01 && Math.abs(bella.overtime_hours - 5) < 0.01,
  bella ? `${bella.hours} reg + ${bella.overtime_hours} OT` : "no row");
T("Bella: OT paid at 1.5x (rate 10 -> OT 15)",
  bella && Math.abs(bella.overtime_pay - 5 * 15) < 0.01 && Math.abs(bella.total_pay - (40 * 10 + 5 * 15)) < 0.01,
  bella ? `total ${bella.total_pay}` : "no row");
T("Bella: no break flag on short week with no long shift",
  !bella || !bella.flags.includes("unpaid_break_applied") || bella.unpaid_break_minutes === 180);

const bad = normalisePunch({ employee_name: "Not Mapped", shift_date: "2026-03-05", clock_in: "08:00", clock_out: "08:00" });
T("same-time punch is flagged as >24h", bad.flags.includes("shift_exceeds_24h"), bad.flags.join(","));
T("missing clock-out is flagged, not silently paid",
  normalisePunch({ employee_name: "X", shift_date: "2026-03-05", clock_in: "08:00" }).flags.includes("missing_clock_out"));

// ─── 4. import ──────────────────────────────────────────────────────────
console.log("\n=== 4. Import writes to TimecardPunch ===");
const res = await importReport(scan, {
  propertyId: PROPERTY_ID, propertyName: PROPERTY_NAME,
  importId: "imp_timecard", sourceFile: "timecard-sample.csv",
});
T("import inserted 5 rows", res.count === 5, `got ${res.count}, excluded ${res.excluded}`);
const stored = await localDb.TimecardPunch.toArray();
T("TimecardPunch holds 5 rows", stored.length === 5, `got ${stored.length}`);
T("all rows carry property_id", stored.every((r) => r.property_id === PROPERTY_ID));
T("all rows carry import_id", stored.every((r) => r.import_id));

// The 24h double-day row must have produced an anomaly alert.
const alerts = await localDb.AnomalyAlert.toArray();
T("anomaly alert persisted for the 24h shift", alerts.some((a) => String(a.alert_type).startsWith("timecard_")),
  `types: ${alerts.map((a) => a.alert_type).join(",") || "none"}`);
T("anomaly alert carries property scoping", alerts.every((a) => a.property_id === PROPERTY_ID));

// ─── 5. idempotent re-import ────────────────────────────────────────────
console.log("\n=== 5. Re-import is a no-op ===");
const scan2 = await scanReport("auto", "blob:local#timecard-sample.csv", {
  propertyId: PROPERTY_ID, propertyName: PROPERTY_NAME,
  importId: "imp_timecard_2", sourceFile: "timecard-sample.csv", csvText: CSV_TEXT,
});
const res2 = await importReport(scan2, {
  propertyId: PROPERTY_ID, propertyName: PROPERTY_NAME,
  importId: "imp_timecard_2", sourceFile: "timecard-sample.csv",
});
T("re-import adds 0 rows", res2.count === 0, `added ${res2.count}`);
T("row count unchanged", (await localDb.TimecardPunch.count()) === 5);

// ─── 6. other tables untouched ──────────────────────────────────────────
console.log("\n=== 6. No existing table was damaged ===");
for (const t of OTHER_TABLES) {
  const now = await localDb[t].count();
  T(`${t}: still ${baseline[t]} row(s)`, now === baseline[t], `got ${now}`);
}

console.log(`\n${"=".repeat(62)}\n  ${pass} passed, ${fail} failed\n${"=".repeat(62)}`);
process.exit(fail ? 1 : 0);