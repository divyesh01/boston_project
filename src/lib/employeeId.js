// Employee ID generation for the staff directory.
//
// The original scheme was `name.slice(0,3).toUpperCase() + (staff.length + 1)`,
// which collides in ordinary use because list length is not a monotonic counter:
//
//   - Delete any staff member, then add someone whose name shares a 3-letter
//     prefix with a *later* record, and the length rewinds onto an id already
//     in use.
//   - Two rapid adds (double-click, two tabs) both read the same length.
//   - `slice(0,3)` of a raw name can capture spaces or digits ("Jo Smith" ->
//     "JO "), producing ids with embedded whitespace.
//
// Deriving the suffix from the highest suffix in the *current* staff array fixed
// the length problem but not the rewind, and the comment that used to sit here
// justified the remaining hole with a claim that was simply false:
//
//     "employee_id is a display label — it is generated only here and is not
//      referenced as a key anywhere else — so reissuing a freed label cannot
//      affect payroll records."
//
// It is referenced as a key in at least three places:
//
//   * src/pages/Payroll.jsx de-duplicates historical payroll runs on
//     `(employee_id, pay_period_end)`. A reissued id makes a new hire's runs
//     look already-posted, so they are skipped and never written.
//   * src/lib/timecardCalc.js `keyOf()` groups punches by employee_id, merging a
//     new hire's hours into the departed employee's payroll row.
//   * src/api/localDb.js indexes TimecardPunch on employee_id.
//
// So ids must never be reused. `reserveEmployeeId` is the function callers want:
// it advances a persisted, monotonic per-prefix counter (`IdSequence`, localDb
// v23) inside one rw transaction, so an id is never reissued after a delete and
// two simultaneous adds cannot land on the same number.
//
// The counter is additionally floored by the highest suffix visible in the live
// staff list. That is what makes the "a persisted counter can desync across
// devices" objection moot: a device with no counter row (fresh install, restored
// backup, cleared storage) still cannot issue below an id that demonstrably
// exists, so the worst case is a gap in the sequence, never a collision.
//
// `nextEmployeeId` remains exported as the pure, synchronous core for tests and
// for callers that can supply the full historical id set themselves.

import localDb from "@/api/localDb";

const PAD = 3;

// First 3 letters of the name, uppercased; "EMP" when the name has none.
export function employeeIdPrefix(name) {
  const letters = String(name || "").replace(/[^A-Za-z]/g, "").toUpperCase();
  return letters ? letters.slice(0, PAD) : "EMP";
}

function formatId(prefix, n) {
  return prefix + String(n).padStart(PAD, "0");
}

// Normalised set of ids already spoken for. Accepts staff rows or bare strings.
function toIdSet(existingStaff) {
  return new Set(
    (existingStaff || [])
      .map((s) => (typeof s === "string" ? s : s?.employee_id))
      .filter(Boolean)
      .map((id) => String(id).trim().toUpperCase())
  );
}

// Highest suffix present under this prefix (0 when none). Tolerates any digit
// width so ids that pre-date PAD=3 ("EMP0100") still raise the floor.
function highestSuffix(taken, prefix) {
  const pattern = new RegExp(`^${prefix}(\\d+)$`);
  let max = 0;
  for (const id of taken) {
    const m = id.match(pattern);
    if (m) max = Math.max(max, Number(m[1]) || 0);
  }
  return max;
}

/**
 * Next employee id that collides with nothing in `existingStaff`.
 *
 * PURE and synchronous, so it cannot know about ids that were issued and later
 * deleted unless you pass them in. Prefer `reserveEmployeeId` in the app; use
 * this when you hold the complete historical id set (tests, migrations, imports).
 *
 * @param {string} name           employee_name for the new record
 * @param {Array}  existingStaff  current staff rows (or bare id strings)
 * @param {{floor?: number}} [options] minimum suffix to issue above
 */
export function nextEmployeeId(name, existingStaff = [], options = {}) {
  const prefix = employeeIdPrefix(name);
  const taken = toIdSet(existingStaff);
  const floor = Number.isFinite(options.floor) ? Math.max(0, Math.trunc(options.floor)) : 0;

  let n = Math.max(highestSuffix(taken, prefix), floor);
  let candidate;
  do {
    n += 1;
    candidate = formatId(prefix, n);
  } while (taken.has(candidate));
  return candidate;
}

/**
 * Highest suffix ever issued under `prefix` on this device (0 when unknown).
 * Read-only; exists so tests and diagnostics can assert on the stored value
 * without reserving an id.
 * @param {string} prefix
 * @returns {Promise<number>}
 */
export async function peekIdSequence(prefix) {
  const row = await localDb.IdSequence.get(String(prefix).toUpperCase());
  return Number(row?.last_seq) || 0;
}

/**
 * Reserve the next employee id for `name`, persisting the reservation.
 *
 * The read-compute-write runs inside a single Dexie rw transaction on
 * `IdSequence`. Dexie serialises transactions over the same table, so N
 * simultaneous callers are handed N distinct numbers — the double-click and
 * two-tab races both close here rather than in the UI.
 *
 * @param {string} name           employee_name for the new record
 * @param {Array}  existingStaff  current staff rows (or bare id strings)
 * @returns {Promise<string>} e.g. "JOH004"
 */
export async function reserveEmployeeId(name, existingStaff = []) {
  const prefix = employeeIdPrefix(name);
  const taken = toIdSet(existingStaff);
  const liveFloor = highestSuffix(taken, prefix);

  const seq = await localDb.transaction("rw", localDb.IdSequence, async () => {
    const row = await localDb.IdSequence.get(prefix);
    const stored = Number(row?.last_seq) || 0;

    // Never below what is already issued *or* already visible.
    let n = Math.max(stored, liveFloor);
    do {
      n += 1;
    } while (taken.has(formatId(prefix, n)));

    await localDb.IdSequence.put({
      prefix,
      last_seq: n,
      updated_date: new Date().toISOString(),
    });
    return n;
  });

  return formatId(prefix, seq);
}
