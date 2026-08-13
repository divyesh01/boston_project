import { describe, it, expect } from "vitest";
import {
  parseTime,
  minutesBetween,
  weekBounds,
  normalisePunch,
  applyBreaks,
  reconcileTimecards,
  weeksToPayrollRuns,
} from "@/lib/timecardCalc";

describe("parseTime", () => {
  it("parses 24h HH:MM", () => {
    expect(parseTime("08:00")).toBe(480);
    expect(parseTime("23:30")).toBe(1410);
  });

  it("parses AM/PM", () => {
    expect(parseTime("8:00 AM")).toBe(480);
    expect(parseTime("8:00 PM")).toBe(1200);
    expect(parseTime("12:00 PM")).toBe(720);
    expect(parseTime("12:00 AM")).toBe(0);
    expect(parseTime("03:21 PM")).toBe(921);
  });

  it("parses ISO datetimes by taking the time part", () => {
    expect(parseTime("2026-03-07 03:21 PM")).toBe(921);
    expect(parseTime("2026-03-07T03:21 PM")).toBe(921);
  });

  it("returns null for junk", () => {
    expect(parseTime("")).toBeNull();
    expect(parseTime("not-a-time")).toBeNull();
    expect(parseTime("25:99")).toBeNull();
    expect(parseTime(null)).toBeNull();
  });
});

describe("minutesBetween", () => {
  it("computes a normal day shift", () => {
    expect(minutesBetween(480, 960)).toBe(480); // 8:00 -> 16:00 = 8h
  });

  it("handles overnight crossing midnight", () => {
    expect(minutesBetween(1380, 360)).toBe(420); // 23:00 -> 06:00 = 7h
  });
});

describe("weekBounds", () => {
  it("finds a Sunday week start", () => {
    // 2026-03-04 is a Wednesday.
    expect(weekBounds("2026-03-04", 0)).toEqual({
      weekStart: "2026-03-01",
      weekEnd: "2026-03-07",
    });
  });

  it("finds a Monday week start", () => {
    expect(weekBounds("2026-03-04", 1)).toEqual({
      weekStart: "2026-03-02",
      weekEnd: "2026-03-08",
    });
  });
});

describe("normalisePunch", () => {
  it("flags a missing clock-out", () => {
    const p = normalisePunch({ date: "2026-03-04", employee_name: "Moin", clock_in: "08:00" });
    expect(p.flags).toContain("missing_clock_out");
    expect(p.clockOut).toBeNull();
  });

  it("flags a missing date", () => {
    const p = normalisePunch({ employee_name: "Moin", clock_in: "08:00" });
    expect(p.flags).toContain("missing_date");
  });

  it("flags shifts that wrap a full 24h (two days mislabeled as one)", () => {
    const p = normalisePunch({ date: "2026-03-04", employee_name: "Moin", clock_in: "08:00", clock_out: "08:00" });
    expect(p.flags).toContain("shift_exceeds_24h");
  });
});

describe("applyBreaks", () => {
  it("deducts a default unpaid break after 6h", () => {
    const shift = { date: "2026-03-04", clockIn: 480, clockOut: 960, flags: [] }; // 8h
    const r = applyBreaks(shift, {});
    expect(r.paidMinutes).toBe(480 - 30);
    expect(r.breakMinutes).toBe(30);
    expect(r.flags).toContain("unpaid_break_applied");
  });

  it("does not deduct for a short shift", () => {
    const shift = { date: "2026-03-04", clockIn: 480, clockOut: 540, flags: [] }; // 1h
    const r = applyBreaks(shift, {});
    expect(r.paidMinutes).toBe(60);
    expect(r.breakMinutes).toBe(0);
  });

  it("respects an explicit break_minutes", () => {
    const shift = { date: "2026-03-04", clockIn: 480, clockOut: 960, break_minutes: 15, flags: [] };
    const r = applyBreaks(shift, {});
    expect(r.paidMinutes).toBe(480 - 15);
  });
});

describe("reconcileTimecards", () => {
  it("splits regular vs overtime at 40h/week", () => {
    const punches = [];
    // 5 days x 10h = 50h in one week, $10/hr -> 40 regular + 10 OT.
    // Breaks disabled so the math is exactly 50h.
    for (let d = 2; d <= 6; d++) {
      const day = `2026-02-0${d}`;
      punches.push({ date: day, employee_name: "A", clock_in: "08:00", clock_out: "18:00" });
    }
    const weeks = reconcileTimecards(punches, { deductBreaks: false, rates: { A: { base_rate: 10 } } });
    expect(weeks).toHaveLength(1);
    expect(weeks[0].hours).toBe(40);
    expect(weeks[0].overtime_hours).toBe(10);
    expect(weeks[0].regular_pay).toBe(400);
    expect(weeks[0].overtime_pay).toBe(150); // 10h * $15
    expect(weeks[0].total_pay).toBe(550);
  });

  it("applies break policy before splitting OT (50h raw -> 47.5h paid)", () => {
    const punches = [];
    for (let d = 2; d <= 6; d++) {
      punches.push({ date: `2026-02-0${d}`, employee_name: "A", clock_in: "08:00", clock_out: "18:00" });
    }
    const weeks = reconcileTimecards(punches, { rates: { A: { base_rate: 10 } } });
    expect(weeks[0].hours).toBe(40); // 47.5h paid, cap 40
    expect(weeks[0].overtime_hours).toBe(7.5); // 47.5 - 40
    expect(weeks[0].unpaid_break_minutes).toBe(150); // 5 x 30min
  });

  it("excludes shifts with a missing punch from pay but flags them", () => {
    const punches = [
      { date: "2026-03-04", employee_name: "B", clock_in: "08:00", clock_out: "16:00" },
      { date: "2026-03-05", employee_name: "B", clock_in: "09:00" }, // no clock out
    ];
    const weeks = reconcileTimecards(punches, { rates: { B: { base_rate: 10 } } });
    expect(weeks).toHaveLength(1);
    expect(weeks[0].hours).toBe(7.5); // 8h - 30min break
    expect(weeks[0].flags).toContain("missing_clock_out");
  });

  it("groups by employee and week", () => {
    const punches = [
      { date: "2026-03-02", employee_name: "A", clock_in: "08:00", clock_out: "16:00" },
      { date: "2026-03-02", employee_name: "B", clock_in: "09:00", clock_out: "17:00" },
    ];
    const weeks = reconcileTimecards(punches, { rates: {} });
    expect(weeks).toHaveLength(2);
  });

  it("does not collapse employees when employee_id is an empty string", () => {
    const punches = [
      { date: "2026-03-02", employee_name: "A", employee_id: "", clock_in: "08:00", clock_out: "16:00" },
      { date: "2026-03-02", employee_name: "B", employee_id: "", clock_in: "09:00", clock_out: "17:00" },
    ];
    const weeks = reconcileTimecards(punches, { rates: {} });
    expect(weeks).toHaveLength(2);
    expect(weeks.map((w) => w.employeeKey).sort()).toEqual(["A", "B"]);
  });

  it("handles an overnight shift", () => {
    const punches = [
      { date: "2026-03-04", employee_name: "Night", clock_in: "23:00", clock_out: "06:00" },
    ];
    const weeks = reconcileTimecards(punches, { rates: { Night: { base_rate: 10 } } });
    // 23:00 -> 06:00 = 7h raw; 7h > 6h so a 30min unpaid break applies -> 6.5h
    expect(weeks[0].hours).toBe(6.5);
  });
});

describe("weeksToPayrollRuns", () => {
  it("produces payroll-shaped records", () => {
    const weeks = reconcileTimecards(
      [{ date: "2026-03-02", employee_name: "A", clock_in: "08:00", clock_out: "16:00" }],
      { rates: { A: { base_rate: 10 } } }
    );
    const runs = weeksToPayrollRuns(weeks, {
      propertyId: "p1",
      propertyName: "Phoenix West",
      status: "approved",
    });
    expect(runs).toHaveLength(1);
    expect(runs[0].payroll_status).toBe("approved");
    expect(runs[0].timecard_derived).toBe(true);
    expect(runs[0].property_id).toBe("p1");
    expect(runs[0].employee_name).toBe("A");
  });
});
