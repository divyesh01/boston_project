import { describe, it, expect } from "vitest";
import {
  parseTime,
  minutesBetween,
  weekBounds,
  normalisePunch,
  shiftDurationMinutes,
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

  // The AM/PM branch used to validate nothing: "11:99 PM" returned 1479 and
  // "25:00 AM" returned 60, because the hour was reduced mod 12 before any
  // range check. A minute-of-day above 1439 is what let a shift measure >24h.
  it("rejects an out-of-range AM/PM time instead of wrapping it", () => {
    expect(parseTime("11:99 PM")).toBeNull();
    expect(parseTime("25:00 AM")).toBeNull();
    expect(parseTime("99:99 PM")).toBeNull();
    expect(parseTime("13:30 AM")).toBe(90); // in-contract: hour mod 12, unchanged
  });

  it("rejects a numeric minute-of-day outside one day", () => {
    expect(parseTime(0)).toBe(0);
    expect(parseTime(1439)).toBe(1439);
    expect(parseTime(1440)).toBeNull();
    expect(parseTime(3000)).toBeNull();
    expect(parseTime(-60)).toBeNull();
    expect(parseTime(Number.POSITIVE_INFINITY)).toBeNull();
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

  // Two times of day can only describe 0..1439 minutes. When the punches carry
  // their own dates, the span is measured from them instead — a 49-hour shift
  // used to read as 60 paid minutes with no flag at all.
  it("measures a multi-day span from the punch dates and refuses it", () => {
    const p = normalisePunch({
      date: "2026-03-07",
      employee_name: "Moin",
      clock_in: "2026-03-07 09:00",
      clock_out: "2026-03-09 10:00",
    });
    expect(p.durationMinutes).toBe(2940);
    expect(shiftDurationMinutes(p)).toBe(2940);
    expect(p.flags).toContain("shift_exceeds_24h");
  });

  it("flags a clock-out dated before the clock-in", () => {
    const p = normalisePunch({
      date: "2026-03-07",
      employee_name: "Moin",
      clock_in: "2026-03-07 22:00",
      clock_out: "2026-03-06 06:00",
    });
    expect(p.flags).toContain("negative_shift_duration");
    expect(shiftDurationMinutes(p)).toBe(0);
  });

  it("leaves a legitimate dated overnight shift at 8 hours", () => {
    const p = normalisePunch({
      date: "2026-03-07",
      employee_name: "Moin",
      clock_in: "2026-03-07 22:00",
      clock_out: "2026-03-08 06:00",
    });
    expect(shiftDurationMinutes(p)).toBe(480);
    expect(p.flags).not.toContain("shift_exceeds_24h");
    expect(p.flags).not.toContain("negative_shift_duration");
  });
});

describe("impossible shifts are never paid", () => {
  // The flag existed before and was decorative: reconcileTimecards skipped only
  // shifts with a MISSING punch, so a pair measuring 1,449 minutes was paid
  // 24.15h ($362.25 at $15/h) with "shift_exceeds_24h" attached. The backend
  // copy always skipped it, so the cron and the Payroll page disagreed.
  it("pays 0 for a >24h shift but keeps it visible", () => {
    const weeks = reconcileTimecards(
      [{
        employee_name: "Moin",
        shift_date: "2026-03-07",
        clock_in: "2026-03-07 09:00",
        clock_out: "2026-03-09 10:00",
      }],
      { rates: { Moin: { base_rate: 15 } } }
    );
    expect(weeks[0].paid_minutes).toBe(0);
    expect(weeks[0].total_pay).toBe(0);
    expect(weeks[0].shifts).toHaveLength(1);
    expect(weeks[0].flags).toContain("shift_exceeds_24h");
  });

  it("still pays the sound shifts in a week that holds a broken one", () => {
    const weeks = reconcileTimecards(
      [
        { employee_name: "Moin", shift_date: "2026-03-02", clock_in: "08:00", clock_out: "16:00" },
        { employee_name: "Moin", shift_date: "2026-03-03", clock_in: "08:00", clock_out: "16:00" },
        { employee_name: "Moin", shift_date: "2026-03-04", clock_in: "2026-03-04 09:00", clock_out: "2026-03-06 09:00" },
      ],
      { rates: { Moin: { base_rate: 15 } } }
    );
    expect(weeks[0].paid_minutes).toBe(900); // 2 x (480 - 30)
    expect(weeks[0].total_pay).toBe(225);
    expect(weeks[0].flags).toContain("shift_exceeds_24h");
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
