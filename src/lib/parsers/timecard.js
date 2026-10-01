import { rowsToObjects, convertDate, isIsoDate } from "@/lib/csvParser";

// ─── Timecard (Clock In/Out) ───────────────────────────────────────────
//
// HotelKey / payroll timecard exports, regardless of the exporter, carry one
// row per shift: an employee, a date, and a clock-in/clock-out pair. Column
// names vary wildly ("Clock In", "Time In", "clock_in", "Start Time"), but the
// values are always readable time-of-day strings. The parser keeps the times
// verbatim so the reconciler (src/lib/timecardCalc.js) can normalise them and
// compute hours/OT; only the date is normalised to ISO at scan time.

export function scanTimecard(rawRows, meta, objects) {
  const punches = [];
  const rejected = [];

  // Column-name normalisation mirrors COLUMN_MAP: map synonyms to canonical keys.
  const TIME_CANON = {
    "employee name": "employee_name", "employee": "employee_name", "name": "employee_name",
    "employee id": "employee_id", "emp id": "employee_id", "id": "employee_id", "employee number": "employee_id",
    "department": "department", "dept": "department",
    "date": "shift_date", "shift date": "shift_date", "day": "shift_date", "work date": "shift_date",
    "clock in": "clock_in", "clock_in": "clock_in", "time in": "clock_in", "time_in": "clock_in",
    "start time": "clock_in", "start": "clock_in", "in": "clock_in",
    "clock out": "clock_out", "clock_out": "clock_out", "time out": "clock_out", "time_out": "clock_out",
    "end time": "clock_out", "end": "clock_out", "out": "clock_out",
    "break": "break_minutes", "break minutes": "break_minutes", "break time": "break_minutes",
    "overtime": "overtime_hours", "ot": "overtime_hours", "overtime hours": "overtime_hours",
  };

  const canonical = (h) => TIME_CANON[String(h || "").trim().toLowerCase()];

  // Prefer AI-extracted objects (Excel path); fall back to header+rows mapping.
  const rows = Array.isArray(objects) && objects.length
    ? objects
    : rowsToObjects(rawRows);

  for (const obj of rows) {
    const out = {};
    for (const [srcKey, value] of Object.entries(obj)) {
      const key = canonical(srcKey);
      if (key) out[key] = value;
    }
    if (!out.employee_name && !out.shift_date) {
      // Not a punch row (section label, totals line, empty row).
      if (Object.values(out).some((v) => v !== undefined && v !== null && String(v).trim() !== "")) rejected.push(out);
      continue;
    }

    const employee = String(out.employee_name || "").trim();
    const date = convertDate(out.shift_date);
    const inTime = String(out.clock_in || "").trim();
    const outTime = String(out.clock_out || "").trim();

    // A punch date must be a real ISO calendar date, exactly like the transaction
    // ledger (line ~896) and the flat-table path (line ~620) already require.
    // convertDate returns the raw string when it recognises no format, so a bare
    // `!date` truthiness check let a malformed date like "2026.01.01" through and
    // persisted it as shift_date; isIsoDate closes that to the same reject path.
    if (!employee || !isIsoDate(date) || !inTime || !outTime) {
      rejected.push({ ...out, _reason: "missing employee, date, or in/out time" });
      continue;
    }

    punches.push({
      employee_name: employee,
      employee_id: String(out.employee_id || "").trim(),
      department: String(out.department || "").trim(),
      shift_date: date,
      clock_in: inTime,
      clock_out: outTime,
      break_minutes: Number(out.break_minutes) > 0 ? Number(out.break_minutes) : undefined,
      overtime_hours: Number(out.overtime_hours) > 0 ? Number(out.overtime_hours) : undefined,
    });
  }

  return {
    type: "timecard",
    sections: [
      { name: "Clock In/Out Shifts", rows: punches.length, preview: punches.slice(0, 20) },
      { name: "Skipped", rows: rejected.length, preview: rejected.slice(0, 20) },
    ],
    totalRows: punches.length + rejected.length,
    rowsToImport: punches,
    skipped: rejected,
    meta,
  };
}

