// Employee ID generation for the staff directory.
//
// The previous scheme was `name.slice(0,3).toUpperCase() + (staff.length + 1)`,
// which collides in ordinary use because list length is not a monotonic counter:
//
//   - Delete any staff member, then add someone whose name shares a 3-letter
//     prefix with a *later* record, and the length rewinds onto an id already
//     in use.
//   - Two rapid adds (double-click, two tabs) both read the same length.
//   - `slice(0,3)` of a raw name can capture spaces or digits ("Jo Smith" ->
//     "JO "), producing ids with embedded whitespace.
//
// This derives the suffix from the highest suffix already issued for that
// prefix, then confirms the result is unused, so it is stable and readable
// (still "SMI001") without depending on list length.
//
// Contract: no two staff in `existingStaff` are ever issued the same id. An id
// freed by a hard delete may be reissued later; that is deliberate. Guaranteeing
// ids are never reused would require a persisted high-water counter that can
// desync across devices, and `employee_id` is a display label — it is generated
// only here and is not referenced as a key anywhere else — so reissuing a freed
// label cannot affect payroll records. If it ever becomes a real foreign key,
// pass the historical ids in via `existingStaff` and this stays correct.

const PAD = 3;

// First 3 letters of the name, uppercased; "EMP" when the name has none.
export function employeeIdPrefix(name) {
  const letters = String(name || "").replace(/[^A-Za-z]/g, "").toUpperCase();
  return letters ? letters.slice(0, PAD) : "EMP";
}

/**
 * Next collision-free employee id.
 * @param {string} name           employee_name for the new record
 * @param {Array}  existingStaff  current staff rows (or bare id strings)
 */
export function nextEmployeeId(name, existingStaff = []) {
  const prefix = employeeIdPrefix(name);

  const taken = new Set(
    (existingStaff || [])
      .map((s) => (typeof s === "string" ? s : s?.employee_id))
      .filter(Boolean)
      .map((id) => String(id).trim().toUpperCase())
  );

  // Highest suffix already issued under this prefix (0 when none).
  const pattern = new RegExp(`^${prefix}(\\d+)$`);
  let maxSuffix = 0;
  for (const id of taken) {
    const m = id.match(pattern);
    if (m) maxSuffix = Math.max(maxSuffix, Number(m[1]) || 0);
  }

  // Confirm the slot is free — ids may pre-date this scheme or come from import.
  let n = maxSuffix + 1;
  let candidate = prefix + String(n).padStart(PAD, "0");
  while (taken.has(candidate)) {
    n += 1;
    candidate = prefix + String(n).padStart(PAD, "0");
  }
  return candidate;
}
