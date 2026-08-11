// Housekeeping management — pure logic for the room-cleaning queue.
//
// A housekeeping system tracks a room's readiness (dirty → assigned →
// in-progress → completed → inspected) and assigns cleaning work to staff. This
// module holds the status model, inspection checklist, task rollups and the
// overdue calculation. It is React-free so scripts/probe-housekeeping.mjs runs
// it directly in Node.

export const TASK_TYPES = [
  "cleaning",
  "inspection",
  "deep_clean",
  "linen_change",
  "maintenance",
];

export const TASK_TYPE_LABELS = {
  cleaning: "Standard cleaning",
  inspection: "Inspection",
  deep_clean: "Deep clean",
  linen_change: "Linen change",
  maintenance: "Maintenance",
};

// Valid workflow states for a HousekeepingTask record.
export const TASK_STATUS = [
  "pending",     // created, not yet assigned
  "assigned",    // a staff member has been assigned
  "in_progress", // work started
  "completed",   // cleaning done
  "inspected",   // supervisor verified, room ready to sell
];

// Valid transitions per status. `null` next-state means "terminal".
export const STATUS_TRANSITIONS = {
  pending: ["assigned"],
  assigned: ["in_progress", "pending"],
  in_progress: ["completed", "assigned"],
  completed: ["inspected", "in_progress"],
  inspected: null,
};

export function canTransition(current, next) {
  if (next === current) return false;
  const allowed = STATUS_TRANSITIONS[current];
  return !!allowed && allowed.includes(next);
}

// Default inspection checklist items. room_number is templated into each item.
export function defaultChecklist(roomNumber) {
  const r = String(roomNumber || "");
  return [
    { room_number: r, item: "Beds made, fresh linens", done: false },
    { room_number: r, item: "Bathroom sanitised, towels stocked", done: false },
    { room_number: r, item: "Floors vacuumed / wiped", done: false },
    { room_number: r, item: "Amenities and toiletries restocked", done: false },
    { room_number: r, item: "HVAC set and working", done: false },
    { room_number: r, item: "Electronics and lights functional", done: false },
    { room_number: r, item: "Mini-bar stocked and billed", done: false },
  ];
}

export function checklistComplete(checklist) {
  const list = checklist || [];
  return list.length > 0 && list.every((c) => !!c.done);
}

export function checklistProgress(checklist) {
  const list = checklist || [];
  if (!list.length) return 0;
  return Math.round((list.filter((c) => !!c.done).length / list.length) * 100);
}

// Roll a set of housekeeping tasks up into counts the board can show.
export function housekeepingRollup(tasks) {
  const counts = { pending: 0, assigned: 0, in_progress: 0, completed: 0, inspected: 0 };
  for (const t of tasks || []) {
    const st = TASK_STATUS.includes(t.status) ? t.status : "pending";
    counts[st] += 1;
  }
  return {
    ...counts,
    open: counts.pending + counts.assigned + counts.in_progress,
    readyToSell: counts.inspected,
    total: (tasks || []).length,
  };
}

// Tasks whose due date is before `today` and that are not finished. A task is
// only "overdue" once it is past its due date and still open.
export function overdueTasks(tasks, today) {
  const cutoff = String(today || "").slice(0, 10);
  return (tasks || []).filter(
    (t) => !["completed", "inspected"].includes(t.status) && String(t.due_date || "").slice(0, 10) < cutoff
  );
}

// Latest per-room status task, mirroring the room board's needs.
export function roomHkByRoom(tasks) {
  const map = {};
  for (const t of tasks || []) {
    const key = String(t.room_number || "").trim();
    if (!key) continue;
    if (!map[key] || String(t.task_date || "") >= String(map[key].task_date || "")) map[key] = t;
  }
  return map;
}

// Describe a room's display housekeeping status based on its tasks + fallback.
export function roomHkStatus(room, hkTask) {
  if (String(room?.status) === "out_of_service") return "out_of_service";
  if (hkTask && hkTask.status) return hkTask.status;
  return room?.status && room.status !== "available" ? room.status : "available";
}