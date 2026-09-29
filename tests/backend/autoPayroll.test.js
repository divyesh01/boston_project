import { describe, it, expect, vi, beforeEach } from "vitest";

const state = {
  session: { user_id: "123", is_revoked: false, expires_at: "2099-01-01T00:00:00.000Z" },
  user: { id: "123", is_active: true, is_locked: false, role: "admin", property_access: "all" },
  staff: [],
  punches: [],
  payrollRuns: [],
  auditRows: [],
};

function makeEntities() {
  return {
    Session: { filter: async () => (state.session ? [state.session] : []) },
    User: { get: async () => state.user },
    Staff: {
      filter: async (query = {}) => {
        return state.staff.filter((s) => {
          for (const [k, v] of Object.entries(query)) {
            if (s[k] !== v) return false;
          }
          return true;
        });
      },
    },
    TimecardPunch: {
      filter: async (query = {}) => {
        return state.punches.filter((p) => {
          for (const [k, v] of Object.entries(query)) {
            if (p[k] !== v) return false;
          }
          return true;
        });
      },
    },
    PayrollRun: {
      filter: async (query = {}) => {
        return state.payrollRuns.filter((r) => {
          for (const [k, v] of Object.entries(query)) {
            if (r[k] !== v) return false;
          }
          return true;
        });
      },
      create: async (row) => {
        const item = { id: `pr_${state.payrollRuns.length + 1}`, ...row };
        state.payrollRuns.push(item);
        return item;
      },
    },
    AuditLog: {
      filter: async () => state.auditRows,
      create: async (row) => {
        const item = { id: `a_${state.auditRows.length + 1}`, ...row };
        state.auditRows.push(item);
        return item;
      },
    },
  };
}

const makeClient = () => ({
  asServiceRole: {
    entities: makeEntities(),
  },
});

vi.mock("npm:@base44/sdk@^0.8.41", () => ({ createClientFromRequest: () => makeClient() }));
vi.mock("base44:runtime", () => ({
  secrets: {
    get: (name) => {
      if (name === "CRON_SECRET") return "test-cron-secret";
      if (name === "AUDIT_CHAIN_SECRET") return "test-audit-secret";
      return "test-secret";
    },
  },
}));

const runAutoPayroll = (await import("../../base44/functions/autoPayroll/entry.ts")).default;

function makeCronReq(body) {
  const headers = new Map([
    ["authorization", "Bearer test-cron-secret"],
    ["content-type", "application/json"],
  ]);
  return {
    headers: {
      get: (k) => headers.get(k.toLowerCase()) ?? null,
    },
    json: async () => body,
  };
}

describe("autoPayroll backend function - property isolation & timecard selection", () => {
  beforeEach(() => {
    state.staff = [];
    state.punches = [];
    state.payrollRuns = [];
    state.auditRows = [];
  });

  it("regression: request for Property A cannot create runs for Property B, and selects only Property A timecards", async () => {
    // Property A: Alice ($20/h)
    state.staff.push({
      id: "staff-A1",
      employee_name: "Alice",
      property_id: "prop-A",
      property_name: "Property Alpha",
      active: true,
      pay_type: "hourly",
      base_rate: 20,
      hours: 10, // Hand-typed fallback; should be overridden by timecard
    });

    // Property B: Bob ($30/h)
    state.staff.push({
      id: "staff-B1",
      employee_name: "Bob",
      property_id: "prop-B",
      property_name: "Property Beta",
      active: true,
      pay_type: "hourly",
      base_rate: 30,
      hours: 20, // Hand-typed fallback; should be overridden by timecard
    });

    // Punches for Alice at Property A in March 2026:
    // 5 days of 9 hours (8:00 to 17:00, 30 min unpaid break) = 8.5h net each * 5 = 42.5h (40 reg + 2.5 OT)
    for (const d of ["2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05", "2026-03-06"]) {
      state.punches.push({
        id: `punch-A-${d}`,
        property_id: "prop-A",
        employee_name: "Alice",
        shift_date: d,
        clock_in: "08:00",
        clock_out: "17:00",
      });
    }

    // Punches for Bob at Property B in March 2026:
    // 4 days of 8 hours (8:00 to 16:00, 30 min unpaid break) = 7.5h net each * 4 = 30h reg
    for (const d of ["2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05"]) {
      state.punches.push({
        id: `punch-B-${d}`,
        property_id: "prop-B",
        employee_name: "Bob",
        shift_date: d,
        clock_in: "08:00",
        clock_out: "16:00",
      });
    }

    // Run autoPayroll specifically for Property A
    const reqA = makeCronReq({ force: true, propertyId: "prop-A", year: 2026, month: 2 });
    const resA = await runAutoPayroll(reqA);
    const dataA = await resA.json();

    expect(resA.status).toBe(200);
    expect(dataA.status).toBe("ok");
    expect(dataA.createdCount).toBe(1);
    expect(dataA.skippedCount).toBe(0);

    // Verify database runs: exactly 1 run exists, and it is for Property A
    expect(state.payrollRuns).toHaveLength(1);
    const runA = state.payrollRuns[0];
    expect(runA.property_id).toBe("prop-A");
    expect(runA.employee_name).toBe("Alice");
    expect(runA.timecard_derived).toBe(true);
    expect(runA.hours).toBe(40);
    expect(runA.overtime_hours).toBe(2.5);
    expect(runA.regular_pay).toBe(800); // 40h * $20
    expect(runA.overtime_pay).toBe(75);  // 2.5h * $30
    expect(runA.total_pay).toBe(875);

    // Assert NO run was created for Property B or Bob
    const propBRuns = state.payrollRuns.filter((r) => r.property_id === "prop-B");
    expect(propBRuns).toHaveLength(0);
    const bobRuns = state.payrollRuns.filter((r) => r.employee_name === "Bob");
    expect(bobRuns).toHaveLength(0);

    // Now run autoPayroll specifically for Property B
    const reqB = makeCronReq({ force: true, propertyId: "prop-B", year: 2026, month: 2 });
    const resB = await runAutoPayroll(reqB);
    const dataB = await resB.json();

    expect(resB.status).toBe(200);
    expect(dataB.status).toBe("ok");
    expect(dataB.createdCount).toBe(1);

    // Verify database now has exactly 2 runs: one for Property A, one for Property B
    expect(state.payrollRuns).toHaveLength(2);
    const runB = state.payrollRuns.find((r) => r.property_id === "prop-B");
    expect(runB).toBeDefined();
    expect(runB.employee_name).toBe("Bob");
    expect(runB.timecard_derived).toBe(true);
    expect(runB.hours).toBe(30);
    expect(runB.overtime_hours).toBe(0);
    expect(runB.regular_pay).toBe(900); // 30h * $30
    expect(runB.total_pay).toBe(900);

    // Verify Alice was not re-processed or duplicated
    const aliceRuns = state.payrollRuns.filter((r) => r.employee_name === "Alice");
    expect(aliceRuns).toHaveLength(1);
  });

  it("regression: cross-property staff with same name selects only target property timecards", async () => {
    // Charlie at Property A ($20/h)
    state.staff.push({
      id: "staff-charlie-A",
      employee_name: "Charlie",
      property_id: "prop-A",
      property_name: "Alpha",
      active: true,
      pay_type: "hourly",
      base_rate: 20,
      hours: 0,
    });

    // Charlie at Property B ($25/h)
    state.staff.push({
      id: "staff-charlie-B",
      employee_name: "Charlie",
      property_id: "prop-B",
      property_name: "Beta",
      active: true,
      pay_type: "hourly",
      base_rate: 25,
      hours: 0,
    });

    // Punches for Charlie at Property A: two 8h shifts (7.5h net each = 15h)
    for (const d of ["2026-03-02", "2026-03-03"]) {
      state.punches.push({
        id: `punch-charlie-A-${d}`,
        property_id: "prop-A",
        employee_name: "Charlie",
        shift_date: d,
        clock_in: "08:00",
        clock_out: "16:00",
      });
    }

    // Punches for Charlie at Property B: three 8h shifts (7.5h net each = 22.5h)
    for (const d of ["2026-03-04", "2026-03-05", "2026-03-06"]) {
      state.punches.push({
        id: `punch-charlie-B-${d}`,
        property_id: "prop-B",
        employee_name: "Charlie",
        shift_date: d,
        clock_in: "08:00",
        clock_out: "16:00",
      });
    }

    // Run for Property A only
    const resA = await runAutoPayroll(makeCronReq({ force: true, propertyId: "prop-A", year: 2026, month: 2 }));
    const dataA = await resA.json();
    expect(dataA.createdCount).toBe(1);

    expect(state.payrollRuns).toHaveLength(1);
    expect(state.payrollRuns[0].property_id).toBe("prop-A");
    expect(state.payrollRuns[0].hours).toBe(15); // ONLY 15h from Prop A, NOT 37.5h combined
    expect(state.payrollRuns[0].total_pay).toBe(300); // 15h * $20

    // Run for Property B only
    const resB = await runAutoPayroll(makeCronReq({ force: true, propertyId: "prop-B", year: 2026, month: 2 }));
    const dataB = await resB.json();
    expect(dataB.createdCount).toBe(1);

    expect(state.payrollRuns).toHaveLength(2);
    const runB = state.payrollRuns.find((r) => r.property_id === "prop-B");
    expect(runB.hours).toBe(22.5); // ONLY 22.5h from Prop B
    expect(runB.total_pay).toBe(562.5); // 22.5h * $25
  });

  it("regression: request for Property with no staff creates 0 runs and touches no other property", async () => {
    state.staff.push({
      id: "staff-other",
      employee_name: "Other",
      property_id: "prop-other",
      active: true,
      pay_type: "hourly",
      base_rate: 20,
      hours: 40,
    });

    const res = await runAutoPayroll(makeCronReq({ force: true, propertyId: "prop-empty", year: 2026, month: 2 }));
    const data = await res.json();

    expect(data.status).toBe("ok");
    expect(data.runsCreated).toBe(0);
    expect(state.payrollRuns).toHaveLength(0);
  });
});
