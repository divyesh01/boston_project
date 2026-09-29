// Exercise the real backend handler with in-memory Base44 entities.
// Run: node scripts/probe-auto-payroll-idempotency.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import crypto from "node:crypto";

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

function handlerFor(staff, runs) {
  const audits = [];
  const entities = {
    Staff: { filter: async () => staff },
    PayrollRun: {
      filter: async ({ pay_period_end }) => runs.filter((run) => run.pay_period_end === pay_period_end),
      create: async (record) => { runs.push(record); return record; },
    },
    TimecardPunch: { filter: async () => [] },
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

async function call(handler, body) {
  const response = await handler({
    headers: new Headers({ authorization: "Bearer test-cron" }),
    json: async () => body,
  });
  assert.equal(response.status, 200);
  return response.json();
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
