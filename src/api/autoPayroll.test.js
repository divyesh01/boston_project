import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";

// The shims below are deliberate PARTIAL doubles, so each assignment carries its
// own `any` cast: Node's WebCrypto stands in for the DOM `Crypto`, a Map stands
// in for `Storage` (no `length`/`key` — nothing under test reads them), and
// `screen` only needs width/height. The casts are scoped to these four lines so
// the rest of the file stays fully type-checked.
globalThis.crypto ??= /** @type {any} */ (await import("node:crypto").then((m) => m.webcrypto));
if (!globalThis.crypto?.subtle) globalThis.crypto = /** @type {any} */ (await import("node:crypto").then((m) => m.webcrypto));

const __store = new Map();
const __storage = {
  getItem: (k) => (__store.has(k) ? __store.get(k) : null),
  setItem: (k, v) => __store.set(k, String(v)),
  removeItem: (k) => __store.delete(k),
  clear: () => __store.clear(),
};
globalThis.localStorage = /** @type {any} */ (__storage);
globalThis.sessionStorage = /** @type {any} */ (__storage);
globalThis.window = /** @type {any} */ (globalThis);
globalThis.screen = /** @type {any} */ ({ width: 1920, height: 1080 });
if (globalThis.navigator === undefined) {
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: "test-harness", language: "en-US" },
    configurable: true,
  });
}

const { db, listImportSessions } = await import("@/api/base44Client");
const { default: localDb } = await import("@/api/localDb");
const PINNED = { year: 2026, month: 2 }; // March 2026 (0-based)

async function seedStaff(name, baseRate, hours = 0) {
  await localDb.Staff.add({
    employee_name: name,
    employee_id: "pin",
    active: true,
    pay_type: "hourly",
    base_rate: baseRate,
    hours,
    overtime_hours: 0,
    overtime_rate: 0,
    property_id: "P1",
    property_name: "Pin Prop",
  });
}

// The local autoPayroll path now enforces an Owner/Admin privilege gate (#5):
// it resolves the current session via auth.me() and refuses to generate runs
// without one. Every test therefore seeds an owner + logs in so the function
// exercises its normal (authorized) path rather than the forbidden branch.
const OWNER_USER = "owner_pin";

async function loginOwner() {
  db.auth.me = async () => ({ id: 'mock-owner', username: OWNER_USER, role: 'owner', is_active: true, is_locked: false });
}

async function punch(name, shiftDate, clockIn, clockOut) {
  await localDb.TimecardPunch.add({
    property_id: "P1",
    employee_name: name,
    shift_date: shiftDate,
    clock_in: clockIn,
    clock_out: clockOut,
  });
}

beforeEach(async () => {
  await localDb.open();
  await Promise.all(localDb.tables.map((t) => t.clear()));
  localStorage.clear();
  sessionStorage.clear();
  // Seed + authenticate an owner so the privilege gate in runLocalAutoPayroll
  // sees an authorized actor. Done AFTER clearing storage so the session lands
  // in a clean store.
  await loginOwner();
});

describe("autoPayroll timecard integration (local path)", () => {
  it("uses reconciled timecard hours and overtime when punches cover the period", async () => {
    await seedStaff("Mona", 20, 80); // hand-typed hours (80) should be IGNORED

    // Two workweeks of 45h each → 40 reg + 5 OT per week.
    // Week 1: Sun 2026-03-01..Sat 2026-03-07 — one 9h shift × 5 days = 45h gross.

    for (const d of ["2026-03-01", "2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05"]) {
      await punch("Mona", d, "08:00", "17:00"); // 9h gross each, 8.5h net after 30-min break (shift > 6h)
    }
    // Week 2: Sun 2026-03-08.. — same pattern.
    for (const d of ["2026-03-08", "2026-03-09", "2026-03-10", "2026-03-11", "2026-03-12"]) {
      await punch("Mona", d, "08:00", "17:00");
    }

    const res = await db.functions.invoke("autoPayroll", { ...PINNED, force: true, propertyId: "P1" });
    expect(res.data.status).toBe("ok");

    const runs = await localDb.PayrollRun.toArray();
    expect(runs).toHaveLength(1);
    const run = runs[0];

    // 5 days × 8.5h net = 42.5h per week → 40 reg + 2.5 OT, twice → 80 reg + 5 OT total.
    // (45h gross - 5 × 0.5h breaks = 42.5h net)
    expect(run.hours).toBe(80);
    expect(run.overtime_hours).toBe(5);
    expect(run.timecard_derived).toBe(true);
    expect(run.regular_pay).toBe(80 * 20); // 40h × $20 × 2 weeks

    const muted = await listImportSessions();
    expect(muted).toEqual([]);
  });

  it("falls back to hand-typed Staff.hours when there are no punches", async () => {
    await seedStaff("Solo", 15, 72);

    const res = await db.functions.invoke("autoPayroll", { ...PINNED, force: true });
    expect(res.data.status).toBe("ok");

    const runs = await localDb.PayrollRun.toArray();
    expect(runs).toHaveLength(1);
    expect(runs[0].hours).toBe(72);
    expect(runs[0].overtime_hours).toBe(0);
    expect(runs[0].timecard_derived).toBe(false);
  });

  it("sums hours across multiple workweeks in the period, not just the first", async () => {
    await seedStaff("Pia", 10, 0);

    // Three separate weeks, 40h each.
    for (const d of ["2026-03-01", "2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05"]) {
      await punch("Pia", d, "08:00", "16:00"); // 8h net (no break, shift ≤ 6h? 8h > 6h so 30-min break)
    }
    for (const d of ["2026-03-08", "2026-03-09", "2026-03-10", "2026-03-11", "2026-03-12"]) {
      await punch("Pia", d, "08:00", "16:00");
    }
    for (const d of ["2026-03-15", "2026-03-16", "2026-03-17", "2026-03-18", "2026-03-19"]) {
      await punch("Pia", d, "08:00", "16:00");
    }

    await db.functions.invoke("autoPayroll", { ...PINNED, force: true });
    const runs = await localDb.PayrollRun.toArray();
    expect(runs).toHaveLength(1);

    // 5 × 8h gross - 5 × 0.5h break = 37.5h per week × 3 weeks = 112.5h, no OT.
    expect(runs[0].hours).toBe(112.5);
    expect(runs[0].overtime_hours).toBe(0);
    expect(runs[0].timecard_derived).toBe(true);
  });

  it("is idempotent — a second run for the same period skips staff already paid", async () => {
    await seedStaff("Idem", 12, 40);

    const first = await db.functions.invoke("autoPayroll", { ...PINNED, force: true });
    const second = await db.functions.invoke("autoPayroll", { ...PINNED, force: true });

    expect(first.data.createdCount).toBe(1);
    expect(second.data.createdCount).toBe(0);
    expect(second.data.skippedCount).toBe(1);

    const runs = await localDb.PayrollRun.toArray();
    expect(runs).toHaveLength(1);
  });

  it("skips staff with no pay configuration", async () => {
    await localDb.Staff.add({
      employee_name: "NoRate",
      active: true,
      pay_type: "hourly",
      base_rate: 0,
      property_id: "P1",
    });
    await seedStaff("HasRate", 12, 40);

    const res = await db.functions.invoke("autoPayroll", { ...PINNED, force: true });

    expect(res.data.createdCount).toBe(1);
    expect(res.data.skippedCount).toBe(1);
    expect(res.data.skipped[0].employee_name).toBe("NoRate");
  });

  it("does not double-count when called with a property filter", async () => {
    await seedStaff("P1Only", 12, 40);
    await localDb.Staff.add({
      employee_name: "P2Only",
      active: true,
      pay_type: "hourly",
      base_rate: 12,
      hours: 40,
      property_id: "P2",
      property_name: "P2 Prop",
    });

    const scoped = await db.functions.invoke("autoPayroll", { ...PINNED, force: true, propertyId: "P1" });
    expect(scoped.data.createdCount).toBe(1);
    const runs = await localDb.PayrollRun.toArray();
    expect(runs).toHaveLength(1);
    expect(runs[0].employee_name).toBe("P1Only");
  });
});