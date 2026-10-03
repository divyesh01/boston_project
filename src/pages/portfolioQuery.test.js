// src/pages/portfolioQuery.test.js
//
// Durable regression test suite for empty selected portfolio (`property = []`).
// Verifies contractual zero records returned when property selection is empty ([]),
// while preserving single, nonempty, legacy all/undefined, and date filter behavior
// across all 5 affected property_id callers in Payroll, Expenses, and Forecasting.
//
// Uses actual unchanged entity/db query facade (readHotelDataRows, db.entities)
// and extracts the actual page queryFn/helpers from the copied page sources.

import "fake-indexeddb/auto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// ─── Synthetic Identity SDK Mock ───
/** @type {{ id: string, role: string, property_access: "all" | string[] }} */
let currentUser = { id: "u-owner", role: "owner", property_access: "all" };

const { db, invalidatePropertyAccess, primePropertyAccess } = await import("@/api/base44Client");
const { readHotelDataRows } = await import("@/lib/hotelDataQuery");
const { default: localDb } = await import("@/api/localDb");

// Synthetic identity boundary: stub db.auth.me to return the current synthetic test user
const originalAuthMe = db.auth.me;
db.auth.me = vi.fn().mockImplementation(async () => currentUser);

// ─── Portable Source Function Extraction ───
const currentDir = import.meta.dirname || path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

function extractFunction(src, signature) {
  const start = src.indexOf(signature);
  if (start < 0) throw new Error("not found: " + signature);
  let i = src.indexOf("{", start + signature.length);
  let depth = 0, end = -1;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (depth === 0) { end = j + 1; break; } }
  }
  return src.slice(start, end);
}

function buildSubject(text, deps) {
  const match = text.match(/function\s+(\w+)/);
  if (!match) throw new Error("Could not extract function name from: " + text.slice(0, 40));
  const fnName = match[1];
  const factory = new Function(...Object.keys(deps), `${text}; return ${fnName};`);
  return factory(...Object.values(deps));
}

const payrollSrc = fs.readFileSync(path.resolve(currentDir, "./Payroll.jsx"), "utf8");
const expensesSrc = fs.readFileSync(path.resolve(currentDir, "./Expenses.jsx"), "utf8");
const forecastingSrc = fs.readFileSync(path.resolve(currentDir, "./Forecasting.jsx"), "utf8");

const useQueryShim = (cfg) => ({ queryFn: cfg.queryFn, queryKey: cfg.queryKey });

const payrollUsePayroll = buildSubject(
  extractFunction(payrollSrc, "function usePayroll(propertyId)"),
  { useQuery: useQueryShim, readHotelDataRows, db }
);

const payrollUseOccupancyRange = buildSubject(
  extractFunction(payrollSrc, "function useOccupancyRange(from, to, propertyId)"),
  { useQuery: useQueryShim, readHotelDataRows, db }
);

const payrollUseStaff = buildSubject(
  extractFunction(payrollSrc, "function useStaff(propertyId)"),
  { useQuery: useQueryShim, readHotelDataRows, db }
);

const expensesUseExpenses = buildSubject(
  extractFunction(expensesSrc, "function useExpenses(propertyId)"),
  { useQuery: useQueryShim, db }
);

const expensesUsePayroll = buildSubject(
  extractFunction(expensesSrc, "function usePayroll(propertyId)"),
  { useQuery: useQueryShim, db }
);

const forecastingBuildPropertyFilter = buildSubject(
  extractFunction(forecastingSrc, "function buildPropertyFilter(property)"),
  {}
);

// ─── Synthetic Fixture Seeding ───
async function rawAdd(table, row) {
  const now = new Date().toISOString();
  await localDb[table].add({ ...row, created_date: now, updated_date: now });
}

async function seedDatabase() {
  await localDb.open();
  await Promise.all(localDb.tables.map((t) => t.clear()));

  // OccupancyDay fixtures
  await rawAdd("OccupancyDay", { property_id: "", date: "2026-01-15", rooms_occupied: 20, total_rooms: 50 });
  await rawAdd("OccupancyDay", { property_id: "prop-Z", date: "2026-01-15", rooms_occupied: 5, total_rooms: 10 });
  await rawAdd("OccupancyDay", { property_id: "prop-B", date: "2026-01-20", rooms_occupied: 15, total_rooms: 30 });
  await rawAdd("OccupancyDay", { property_id: "prop-A", date: "2026-01-15", rooms_occupied: 10, total_rooms: 20 });

  // PayrollRun fixtures
  await rawAdd("PayrollRun", { employee_name: "Global Pay", property_id: "", property_name: "", pay_period_start: "2026-01-31", pay_period_end: "2026-01-31", total_pay: 4500.50, payroll_status: "approved" });
  await rawAdd("PayrollRun", { employee_name: "Inactive Z", property_id: "prop-Z", property_name: "Z", pay_period_start: "2026-01-31", pay_period_end: "2026-01-31", total_pay: 700.00, payroll_status: "paid" });
  await rawAdd("PayrollRun", { employee_name: "Active B", property_id: "prop-B", property_name: "B", pay_period_start: "2026-01-31", pay_period_end: "2026-01-31", total_pay: 2000.00, payroll_status: "paid" });
  await rawAdd("PayrollRun", { employee_name: "Active A", property_id: "prop-A", property_name: "A", pay_period_start: "2026-01-31", pay_period_end: "2026-01-31", total_pay: 1000.10, payroll_status: "paid" });

  // Expense fixtures
  await rawAdd("Expense", { expense_name: "Global Exp", property_id: "", amount: 99.99, expense_date: "2026-01-16", payment_status: "unpaid", category: "other", frequency: "one_time" });
  await rawAdd("Expense", { expense_name: "Active B Exp", property_id: "prop-B", amount: 500.00, expense_date: "2026-01-20", payment_status: "unpaid", category: "maintenance", frequency: "one_time" });
  await rawAdd("Expense", { expense_name: "Active A Exp", property_id: "prop-A", amount: 1234.56, expense_date: "2026-01-15", payment_status: "unpaid", category: "utilities", frequency: "one_time" });

  // Staff fixtures (control comparison)
  await rawAdd("Staff", { employee_name: "Global Controller", property_id: "", pay_type: "salary", base_rate: 9000, active: true });
  await rawAdd("Staff", { employee_name: "Active Staff A", property_id: "prop-A", pay_type: "hourly", base_rate: 20, active: true });
  await rawAdd("Staff", { employee_name: "Active Staff B", property_id: "prop-B", pay_type: "hourly", base_rate: 25, active: true });
}

async function setRole(role) {
  if (role === "owner") {
    currentUser = { id: "u-owner", role: "owner", property_access: "all" };
  } else {
    currentUser = { id: "u-restricted", role: "employee", property_access: ["prop-A"] };
  }
  invalidatePropertyAccess();
  await primePropertyAccess({ force: true });
}

afterAll(() => {
  db.auth.me = originalAuthMe;
  invalidatePropertyAccess();
});
describe("Empty Selected Portfolio Contract & Caller Regression", () => {
  beforeEach(async () => {
    await seedDatabase();
  });

  describe.each(["owner", "restricted"])("Role: %s", (role) => {
    beforeEach(async () => {
      await setRole(role);
    });

    describe("1. Payroll.jsx usePayroll(propertyId)", () => {
      it("returns CONTRACT ZERO (0 rows) when property is empty array []", async () => {
        const rows = await payrollUsePayroll([]).queryFn();
        expect(rows).toEqual([]);
        expect(rows.length).toBe(0);
      });

      it("returns single property row when property is 'prop-A'", async () => {
        const rows = await payrollUsePayroll("prop-A").queryFn();
        expect(rows.length).toBe(1);
        expect(rows[0].property_id).toBe("prop-A");
      });

      it("returns nonempty array matching properties", async () => {
        const rows = await payrollUsePayroll(["prop-A", "prop-B"]).queryFn();
        const expectedCount = role === "owner" ? 2 : 1;
        expect(rows.length).toBe(expectedCount);
        rows.forEach((r) => expect(["prop-A", "prop-B"]).toContain(r.property_id));
      });

      it("preserves legacy unfiltered read when property is 'all'", async () => {
        const rows = await payrollUsePayroll("all").queryFn();
        const expectedCount = role === "owner" ? 4 : 1;
        expect(rows.length).toBe(expectedCount);
      });

      it("preserves legacy unfiltered read when property is undefined", async () => {
        const rows = await payrollUsePayroll(undefined).queryFn();
        const expectedCount = role === "owner" ? 4 : 1;
        expect(rows.length).toBe(expectedCount);
      });
    });

    describe("2. Payroll.jsx useOccupancyRange(from, to, propertyId)", () => {
      it("returns CONTRACT ZERO (0 rows) when property is empty array [] even with valid dates", async () => {
        const rows = await payrollUseOccupancyRange("2026-01-01", "2026-01-31", []).queryFn();
        expect(rows).toEqual([]);
        expect(rows.length).toBe(0);
      });

      it("returns CONTRACT ZERO (0 rows) when property is empty array [] without dates", async () => {
        const rows = await payrollUseOccupancyRange(null, null, []).queryFn();
        expect(rows).toEqual([]);
        expect(rows.length).toBe(0);
      });

      it("returns single property row when property is 'prop-A'", async () => {
        const rows = await payrollUseOccupancyRange("2026-01-01", "2026-01-31", "prop-A").queryFn();
        expect(rows.length).toBe(1);
        expect(rows[0].property_id).toBe("prop-A");
      });

      it("returns nonempty array matching properties", async () => {
        const rows = await payrollUseOccupancyRange("2026-01-01", "2026-01-31", ["prop-A", "prop-B"]).queryFn();
        const expectedCount = role === "owner" ? 2 : 1;
        expect(rows.length).toBe(expectedCount);
      });

      it("correctly excludes records outside the date filter range", async () => {
        const rows = await payrollUseOccupancyRange("2026-02-01", "2026-02-28", "prop-A").queryFn();
        expect(rows.length).toBe(0);
      });

      it("correctly preserves combined date subrange and property filtering", async () => {
        // prop-A is 2026-01-15, prop-B is 2026-01-20
        const rows = await payrollUseOccupancyRange("2026-01-01", "2026-01-18", ["prop-A", "prop-B"]).queryFn();
        expect(rows.length).toBe(1);
        expect(rows[0].property_id).toBe("prop-A");
      });

      it("preserves legacy unfiltered read when property is 'all'", async () => {
        const rows = await payrollUseOccupancyRange("2026-01-01", "2026-01-31", "all").queryFn();
        const expectedCount = role === "owner" ? 4 : 1;
        expect(rows.length).toBe(expectedCount);
      });
    });

    describe("3. Expenses.jsx usePayroll(propertyId)", () => {
      it("returns CONTRACT ZERO (0 rows) when property is empty array []", async () => {
        const rows = await expensesUsePayroll([]).queryFn();
        expect(rows).toEqual([]);
        expect(rows.length).toBe(0);
      });

      it("returns single property row when property is 'prop-A'", async () => {
        const rows = await expensesUsePayroll("prop-A").queryFn();
        expect(rows.length).toBe(1);
        expect(rows[0].property_id).toBe("prop-A");
      });

      it("returns nonempty array matching properties", async () => {
        const rows = await expensesUsePayroll(["prop-A", "prop-B"]).queryFn();
        const expectedCount = role === "owner" ? 2 : 1;
        expect(rows.length).toBe(expectedCount);
      });

      it("preserves legacy unfiltered read when property is 'all'", async () => {
        const rows = await expensesUsePayroll("all").queryFn();
        const expectedCount = role === "owner" ? 4 : 1;
        expect(rows.length).toBe(expectedCount);
      });
    });

    describe("4. Expenses.jsx useExpenses(propertyId)", () => {
      it("returns CONTRACT ZERO (0 rows) when property is empty array []", async () => {
        const rows = await expensesUseExpenses([]).queryFn();
        expect(rows).toEqual([]);
        expect(rows.length).toBe(0);
      });

      it("returns single property row when property is 'prop-A'", async () => {
        const rows = await expensesUseExpenses("prop-A").queryFn();
        expect(rows.length).toBe(1);
        expect(rows[0].property_id).toBe("prop-A");
      });

      it("returns nonempty array matching properties", async () => {
        const rows = await expensesUseExpenses(["prop-A", "prop-B"]).queryFn();
        const expectedCount = role === "owner" ? 2 : 1;
        expect(rows.length).toBe(expectedCount);
      });

      it("preserves legacy unfiltered read when property is 'all'", async () => {
        const rows = await expensesUseExpenses("all").queryFn();
        const expectedCount = role === "owner" ? 3 : 1;
        expect(rows.length).toBe(expectedCount);
      });
    });

    describe("5. Forecasting.jsx queries via buildPropertyFilter(property)", () => {
      it("returns CONTRACT ZERO for both Expense and PayrollRun when property is []", async () => {
        const filter = forecastingBuildPropertyFilter([]);
        expect(filter).toEqual({ property_id: { $in: [] } });

        const expenses = await db.entities.Expense.filter(filter, "-expense_date", 100000);
        const payroll = await db.entities.PayrollRun.filter(filter, "-pay_period_start", 100000);
        expect(expenses.length).toBe(0);
        expect(payroll.length).toBe(0);
      });

      it("returns single property records when property is 'prop-A'", async () => {
        const filter = forecastingBuildPropertyFilter("prop-A");
        expect(filter).toEqual({ property_id: "prop-A" });

        const expenses = await db.entities.Expense.filter(filter, "-expense_date", 100000);
        const payroll = await db.entities.PayrollRun.filter(filter, "-pay_period_start", 100000);
        expect(expenses.length).toBe(1);
        expect(payroll.length).toBe(1);
      });

      it("returns nonempty array matching records", async () => {
        const filter = forecastingBuildPropertyFilter(["prop-A", "prop-B"]);
        expect(filter).toEqual({ property_id: { $in: ["prop-A", "prop-B"] } });

        const expenses = await db.entities.Expense.filter(filter, "-expense_date", 100000);
        const payroll = await db.entities.PayrollRun.filter(filter, "-pay_period_start", 100000);
        const expectedCount = role === "owner" ? 2 : 1;
        expect(expenses.length).toBe(expectedCount);
        expect(payroll.length).toBe(expectedCount);
      });

      it("preserves empty filter {} when property is 'all'", async () => {
        const filter = forecastingBuildPropertyFilter("all");
        expect(filter).toEqual({});

        const expenses = await db.entities.Expense.filter(filter, "-expense_date", 100000);
        const payroll = await db.entities.PayrollRun.filter(filter, "-pay_period_start", 100000);
        const expectedExp = role === "owner" ? 3 : 1;
        const expectedPay = role === "owner" ? 4 : 1;
        expect(expenses.length).toBe(expectedExp);
        expect(payroll.length).toBe(expectedPay);
      });
    });

    describe("Staff Control Invariant", () => {
      it("useStaff([]) client filtering continues to return 0 rows", async () => {
        const rows = await payrollUseStaff([]).queryFn();
        expect(rows.length).toBe(0);
      });
    });
  });
});
