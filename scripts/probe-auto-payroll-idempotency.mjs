// Exercise the real backend handler with in-memory Base44 entities.
// Run: node scripts/probe-auto-payroll-idempotency.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import crypto from "node:crypto";
import { findDuplicatePayroll } from "./report-duplicate-payroll.mjs";

const source = readFileSync(new URL("../base44/functions/autoPayroll/entry.ts", import.meta.url), "utf8");
const compiled = stripTypeScriptTypes(source, { mode: "strip" })
  .replace(/^import .*;$/gm, "")
  .replace("export default async function runAutoPayroll", "async function runAutoPayroll")
  + "\nrunAutoPayroll;";
class PayrollDay extends Date {
  constructor(...args) {
    if (args.length === 0) super("2025-02-28T12:00:00Z");
    else super(...args);
  }
}

function handlerFor(staff, runs, options = {}) {
  const audits = [];
  let createAttempt = 0;
  const entities = {
    Staff: { filter: async (query, _sort, limit = 50, skip = 0) =>
      staff.filter((row) => row.active === query.active).slice(skip, skip + limit) },
    PayrollRun: {
      filter: async ({ pay_period_end }, _sort, limit = 50, skip = 0) => {
        if (options.readFails) throw new Error("payroll lookup unavailable");
        if (options.readReturnsNull) return null;
        const snapshot = runs.filter((run) => run.pay_period_end === pay_period_end).slice(skip, skip + limit);
        if (options.readBarrier) await options.readBarrier();
        return snapshot;
      },
      create: async (record) => {
        createAttempt += 1;
        if (createAttempt === options.failCreateAt) throw new Error("payroll create unavailable");
        runs.push(record);
        return record;
      },
    },
    TimecardPunch: { filter: async (_query, _sort, limit = 50, skip = 0) =>
      (options.punches || []).slice(skip, skip + limit) },
    AuditLog: {
      filter: async () => audits.slice(-1),
      create: async (record) => { audits.push(record); return record; },
    },
  };
  return runInNewContext(compiled, {
    createClientFromRequest: () => ({ asServiceRole: { entities } }),
    secrets: { get: (key) => key === "CRON_SECRET" ? "test-cron" : "test-audit" },
    crypto,
    Response,
    Date: PayrollDay,
    console,
  });
}

async function callRaw(handler, body) {
  const response = await handler({
    headers: new Headers({ authorization: "Bearer test-cron" }),
    json: async () => body,
  });
  return { status: response.status, body: await response.json() };
}

async function call(handler, body) {
  const result = await callRaw(handler, body);
  assert.equal(result.status, 200);
  return result.body;
}

for (const [label, propertyId] of [["missing", undefined], ["present", "property-1"]]) {
  const staff = [{
    active: true,
    employee_name: "Alex",
    property_id: propertyId,
    base_rate: 15,
    pay_type: "hourly",
    hours: 8,
  }];
  const runs = [];
  const handler = handlerFor(staff, runs);
  const body = { year: 2025, month: 1 };

  const first = await call(handler, body);
  assert.equal(first.createdCount, 1, `${label}: first month-end run creates payroll`);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].property_id, propertyId || "");
  assert.equal(runs[0].total_pay, 120);

  const second = await call(handler, body);
  assert.equal(second.createdCount, 0, `${label}: second month-end run must not duplicate payroll`);
  assert.equal(second.skippedCount, 1);
  assert.equal(runs.length, 1, `${label}: only one run may be stored`);

  const forced = await call(handler, { ...body, force: true });
  assert.equal(forced.createdCount, 0, `${label}: forced rerun must not duplicate payroll`);
  assert.equal(forced.skippedCount, 1);
  assert.equal(runs.length, 1);
  console.log(`PASS ${label} property ID: first run created one; second and forced runs skipped it`);
}

{
  const runs = [{ property_id: "property-1", employee_name: "Alex", pay_period_end: "2025-02-28" }];
  const handler = handlerFor([{
    active: true,
    employee_name: "Alex",
    property_id: "property-2",
    base_rate: 15,
    pay_type: "hourly",
    hours: 8,
  }], runs);
  const body = { year: 2025, month: 1, force: true };
  assert.equal((await call(handler, body)).createdCount, 1,
    "same employee at another property still gets a run");
  assert.equal(runs.length, 2);
  assert.equal((await call(handler, body)).createdCount, 0,
    "forced rerun skips the new property without touching the other one");
  assert.equal(runs.length, 2);
  console.log("PASS property boundary: same employee at another property gets one distinct run");
}

{
  const runs = [];
  const handler = handlerFor([{
    id: "staff-1", active: true, employee_name: "Alex", property_id: "property-1",
    base_rate: 15, pay_type: "hourly", hours: 8,
  }], runs, { readFails: true });
  const result = await callRaw(handler, { year: 2025, month: 1, force: true });
  assert.equal(result.status, 500, "a failed existing-run lookup must stop payroll");
  assert.equal(runs.length, 0);
  console.log("PASS read failure: no payroll record created");
}

{
  const runs = [];
  const handler = handlerFor([{
    id: "staff-1", active: true, employee_name: "Alex", property_id: "property-1",
    base_rate: 15, hours: 8,
  }], runs, { readReturnsNull: true });
  assert.equal((await callRaw(handler, { year: 2025, month: 1, force: true })).status, 500);
  assert.equal(runs.length, 0);
  console.log("PASS invalid lookup result: no payroll record created");
}

{
  const runs = [];
  const staff = ["property-1", "property-2"].map((property_id, i) => ({
    id: `staff-${i + 1}`, active: true, employee_name: `Alex ${i + 1}`, property_id,
    base_rate: 15, pay_type: "hourly", hours: 8,
  }));
  const handler = handlerFor(staff, runs); // Deliberately returns both despite the filter query.
  const result = await call(handler, { year: 2025, month: 1, force: true, propertyId: "property-1" });
  assert.equal(result.createdCount, 1, "property request must create only its staff's run");
  assert.equal(runs[0].property_id, "property-1");
  assert.equal(runs.length, 1);
  console.log("PASS property scope: staff from another property stays untouched");
}

{
  const runs = [];
  const staff = ["staff-1", "staff-2"].map((id) => ({
    id, active: true, employee_name: id, property_id: "property-1",
    base_rate: 15, pay_type: "hourly", hours: 8,
  }));
  const handler = handlerFor(staff, runs, { failCreateAt: 2 });
  const body = { year: 2025, month: 1, force: true };
  assert.equal((await callRaw(handler, body)).status, 500);
  assert.equal(runs.length, 1, "first record survives a later create failure");
  assert.equal((await call(handler, body)).createdCount, 1, "retry creates only the missing run");
  assert.equal(runs.length, 2);
  console.log("PASS partial failure: retry creates only the missing run");
}

{
  const runs = [{
    staff_id: "staff-1", property_id: "property-1", employee_name: "Alex",
    pay_period_start: "2025-02-01", pay_period_end: "2025-02-28",
  }];
  const handler = handlerFor([
    { id: "staff-1", active: true, employee_name: "Alex", property_id: "property-1", base_rate: 15, hours: 8 },
    { id: "staff-2", active: true, employee_name: "Alex", property_id: "property-1", base_rate: 15, hours: 8 },
  ], runs);
  const body = { year: 2025, month: 1, force: true };
  const first = await call(handler, body);
  assert.equal(first.createdCount, 1, "same-name staff with a different stable ID needs a run");
  assert.equal(runs[1].staff_id, "staff-2");
  assert.equal((await call(handler, body)).createdCount, 0);
  assert.equal(runs.length, 2);
  console.log("PASS stable ID: same-name staff remain distinct");
}

{
  const runs = [];
  const duplicate = { id: "staff-1", active: true, employee_name: "Alex", property_id: "property-1", base_rate: 15, hours: 8 };
  const handler = handlerFor([duplicate, { ...duplicate }], runs);
  assert.equal((await call(handler, { year: 2025, month: 1, force: true })).createdCount, 1,
    "duplicate staff entries in one response may create only one run");
  assert.equal(runs.length, 1);
  console.log("PASS repeated staff row: one run per stable ID");
}

{
  const runs = [{
    property_id: "property-1", employee_name: "Old Name",
    staff_id: "staff-1", pay_period_start: "2025-02-01", pay_period_end: "2025-02-28",
  }];
  const handler = handlerFor([{
    id: "staff-1", active: true, employee_name: "New Name", property_id: "property-1",
    base_rate: 15, hours: 8,
  }], runs);
  assert.equal((await call(handler, { year: 2025, month: 1, force: true })).createdCount, 0,
    "a name change cannot create a second run for the same Staff ID");
  assert.equal(runs.length, 1);
  console.log("PASS name change: stable Staff ID prevents a second run");
}

{
  const runs = [{
    property_id: "property-1", employee_name: "Alex",
    pay_period_start: "2025-02-01", pay_period_end: "2025-02-28",
  }];
  const handler = handlerFor([{
    id: "staff-1", active: true, employee_name: "Alex", property_id: "property-1",
    base_rate: 15, hours: 8,
  }], runs);
  assert.equal((await call(handler, { year: 2025, month: 1, force: true })).createdCount, 0,
    "an older name-only run must still prevent a duplicate");
  assert.equal(runs.length, 1);
  console.log("PASS legacy run: name-only record still prevents a duplicate");
}

{
  const runs = [];
  const staff = ["property-1", "property-2"].map((property_id, i) => ({
    id: `staff-${i + 1}`, active: true, employee_name: "Alex", property_id,
    base_rate: 10, pay_type: "hourly", hours: 0,
  }));
  const punches = [
    { property_id: "property-1", employee_name: "Alex", shift_date: "2025-02-03", clock_in: "08:00", clock_out: "12:00" },
    { property_id: "property-2", employee_name: "Alex", shift_date: "2025-02-03", clock_in: "08:00", clock_out: "16:00" },
  ];
  const handler = handlerFor(staff, runs, { punches });
  assert.equal((await call(handler, { year: 2025, month: 1, force: true })).createdCount, 2);
  assert.equal(runs.find((run) => run.property_id === "property-1").total_pay, 40);
  assert.equal(runs.find((run) => run.property_id === "property-2").total_pay, 75);
  console.log("PASS timecard boundary: same-name staff at different properties keep separate hours");
}

{
  const runs = [];
  const handler = handlerFor([{
    id: "staff-1", employee_id: "E1", active: true, employee_name: "New Name",
    property_id: "property-1", base_rate: 10, hours: 0,
  }], runs, { punches: [{
    property_id: "property-1", employee_id: "E1", employee_name: "Old Name",
    shift_date: "2025-02-03", clock_in: "08:00", clock_out: "12:00",
  }] });
  await call(handler, { year: 2025, month: 1, force: true });
  assert.equal(runs[0].total_pay, 40, "timecard follows employee ID through a name change");
  console.log("PASS timecard identity: employee ID survives a name change");
}

{
  const runs = [];
  const handler = handlerFor([
    { id: "staff-1", employee_id: "E1", active: true, employee_name: "Alex", property_id: "property-1", base_rate: 10, hours: 3 },
    { id: "staff-2", employee_id: "E2", active: true, employee_name: "Alex", property_id: "property-1", base_rate: 10, hours: 5 },
  ], runs, { punches: [{
    property_id: "property-1", employee_name: "Alex", shift_date: "2025-02-03",
    clock_in: "08:00", clock_out: "12:00",
  }] });
  await call(handler, { year: 2025, month: 1, force: true });
  assert.deepEqual(runs.map((run) => run.total_pay), [30, 50],
    "a punch without employee ID cannot be assigned to two same-name staff");
  console.log("PASS ambiguous timecard: no unidentified hours copied to two people");
}

{
  const runs = [];
  const handler = handlerFor([{
    id: "staff-1", active: true, employee_name: "Alex", property_id: "property-1",
    base_rate: 15, hours: 8,
  }], runs);
  assert.equal((await callRaw(handler, { year: 2025, month: 1, force: true, propertyId: " " })).status, 400);
  assert.equal(runs.length, 0, "an invalid property selector cannot expand into a global run");
  console.log("PASS invalid property selector: request rejected before payroll starts");
}

{
  const period = { property_id: "property-1", pay_period_start: "2025-02-01", pay_period_end: "2025-02-28" };
  const report = findDuplicatePayroll([
    { ...period, id: "one", staff_id: "staff-1", employee_name: "Alex" },
    { ...period, id: "two", staff_id: "staff-1", employee_name: "New Name" },
    { ...period, id: "three", staff_id: "staff-2", employee_name: "Alex" },
    { ...period, id: "four", employee_name: "Legacy" },
    { ...period, id: "five", employee_name: "Legacy" },
  ]);
  assert.equal(report.exact.length, 2, "report finds same Staff ID and name-only duplicates");
  assert.equal(report.possibleLegacy.length, 1, "report marks name-only duplicates for review");
  assert.equal(report.exact.find((group) => group.identity === "staff:staff-1").runs.length, 2);
  console.log("PASS duplicate report: stable IDs and legacy name rows are distinguished");
}

{
  const runs = Array.from({ length: 5000 }, (_, i) => ({
    property_id: "property-1", staff_id: `other-${i}`, employee_name: `Other ${i}`,
    pay_period_start: "2025-02-01", pay_period_end: "2025-02-28",
  }));
  runs.push({
    property_id: "property-1", staff_id: "staff-1", employee_name: "Alex",
    pay_period_start: "2025-02-01", pay_period_end: "2025-02-28",
  });
  const handler = handlerFor([{
    id: "staff-1", active: true, employee_name: "Alex", property_id: "property-1",
    base_rate: 15, hours: 8,
  }], runs);
  assert.equal((await call(handler, { year: 2025, month: 1, force: true })).createdCount, 0,
    "an existing run beyond the default first page must prevent a duplicate");
  assert.equal(runs.length, 5001);
  console.log("PASS paginated lookup: existing run after 5000 rows still prevents a duplicate");
}

{
  const runs = [];
  const staff = Array.from({ length: 50 }, (_, i) => ({
    id: `unconfigured-${i}`, active: true, employee_name: `Unconfigured ${i}`,
    property_id: "property-1", base_rate: 0, hours: 8,
  }));
  staff.push({ id: "staff-51", active: true, employee_name: "Paid Staff", property_id: "property-1", base_rate: 15, hours: 8 });
  const handler = handlerFor(staff, runs);
  assert.equal((await call(handler, { year: 2025, month: 1, force: true })).createdCount, 1,
    "staff after the default first page must still be processed");
  assert.equal(runs[0].staff_id, "staff-51");
  console.log("PASS paginated staff: active staff after page one is processed");
}

if (process.argv.includes("--diagnose-race")) {
  const runs = [];
  let arrivals = 0;
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const handler = handlerFor([{
    id: "staff-1", active: true, employee_name: "Alex", property_id: "property-1",
    base_rate: 15, hours: 8,
  }], runs, {
    readBarrier: async () => {
      arrivals += 1;
      if (arrivals === 2) release();
      await barrier;
    },
  });
  const body = { year: 2025, month: 1, force: true };
  await Promise.all([call(handler, body), call(handler, body)]);
  assert.equal(runs.length, 2, "the entity API still allows both concurrent creates");
  console.error("KNOWN LIMITATION: two concurrent requests can create duplicate PayrollRun rows without an atomic storage constraint");
  process.exitCode = 2;
}
