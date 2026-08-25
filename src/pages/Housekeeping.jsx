import React, { useMemo, useState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import Card from "@/components/ui-exec/Card";
import { useRooms, useHousekeepingTasks } from "@/lib/useHotelData";
import { useGlobalFilters } from "@/lib/useGlobalFilters";
import { db } from "@/api/base44Client";
import { useRealtimeInvalidation } from "@/lib/realtime";
import { ErrorState } from "@/components/ui/status";
import { formatCents, toCents } from "@/lib/decimal";
import {
  TASK_TYPES, TASK_TYPE_LABELS, TASK_STATUS, canTransition,
  defaultChecklist, checklistComplete, checklistProgress,
  housekeepingRollup, roomHkByRoom, roomHkStatus,
} from "@/lib/housekeepingService";
import { generateHousekeepingSchedule } from "@/lib/laborOptimization";
import { getHousekeepingConfig, saveHousekeepingConfig } from "@/lib/housekeepingConfig";

const STATUS_COLOR = {
  pending: { color: "#9CA3AF", label: "Pending" },
  assigned: { color: "#FFB547", label: "Assigned" },
  in_progress: { color: "#00D4FF", label: "In Progress" },
  completed: { color: "#00E096", label: "Completed" },
  inspected: { color: "#4FE3C1", label: "Inspected" },
  out_of_service: { color: "#FF6B6B", label: "Out of Service" },
  available: { color: "#00D4FF", label: "Clean / Ready" },
};

export default function Housekeeping() {
  const { dateRange, property, properties, latestDate } = useGlobalFilters();
  const queryClient = useQueryClient();
  useRealtimeInvalidation(["rooms", "housekeeping"]);

  const roomsQ = useRooms(property);
  const tasksQ = useHousekeepingTasks(dateRange, property);
  const { data: rooms = [], isLoading: roomsLoading } = roomsQ;
  const { data: tasks = [], isLoading: tasksLoading } = tasksQ;

  const [assignee, setAssignee] = useState("");
  const [taskRoom, setTaskRoom] = useState("");
  const [taskType, setTaskType] = useState("cleaning");
  const [taskDate, setTaskDate] = useState(latestDate || new Date().toISOString().slice(0, 10));
  const [expandedTask, setExpandedTask] = useState(null);
  const [checklist, setChecklist] = useState([]);
  const [notice, setNotice] = useState(null);
  const [showNew, setShowNew] = useState(false);

  useEffect(() => {
    if (latestDate && !taskDate) setTaskDate(latestDate);
  }, [latestDate, taskDate]);

  const isPortfolio = property === "all" || Array.isArray(property);
  const singlePropertyId = !isPortfolio ? property : null;

  // Owner-tunable productivity standards (turnover minutes, wage, target labor %),
  // persisted per property via housekeepingConfig.
  const [hkConfig, setHkConfig] = useState(() => getHousekeepingConfig(singlePropertyId || "default"));
  const [hkEdited, setHkEdited] = useState(hkConfig);
  useEffect(() => {
    const c = getHousekeepingConfig(singlePropertyId || "default");
    setHkConfig(c);
    setHkEdited(c);
  }, [singlePropertyId]);
  const setHk = (field, value) => setHkEdited((p) => ({ ...p, [field]: value }));
  const saveHk = () => {
    const key = singlePropertyId || "default";
    if (!saveHousekeepingConfig(key, hkEdited)) {
      setNotice({
        type: "error",
        text: "Could not save the standards — browser storage is full or blocked. The previous standards are still in effect.",
      });
      return;
    }
    // Read back instead of trusting what was submitted: the store clamps each
    // field, so the inputs and the figures below would otherwise keep showing a
    // value that was never stored.
    const stored = getHousekeepingConfig(key);
    setHkConfig(stored);
    setHkEdited(stored);
    setNotice({ type: "ok", text: "Productivity standards saved." });
  };

  // Both figures below derive from the STORED standards, never from unsaved
  // edits. They are one pair — mixing a typed wage with saved turnover times
  // would report a cost that is true of no configuration at all.
  //
  // OWNER QUESTION, unresolved: both arguments are `rooms.length`, so every room
  // counts as a checkout AND as a stayover (rooms x 45 minutes at the defaults).
  // A room is one or the other. Which field distinguishes them is a data question
  // only the owner can settle, so the arithmetic is left exactly as it was rather
  // than replaced with a guess.
  const laborPlan = useMemo(
    () => generateHousekeepingSchedule(rooms.length, rooms.length, hkConfig),
    [rooms, hkConfig]
  );
  // Integer cents, rate x minutes / 60 — the basis payroll uses. Previously
  // `(requiredMinutes / 60) * Number(hourlyWage)`, float dollars into money().
  const estLaborCostCents = Math.round((toCents(hkConfig.hourlyWage) * laborPlan.requiredMinutes) / 60);

  const rollup = useMemo(() => housekeepingRollup(tasks), [tasks]);
  const overdue = useMemo(() => tasks.filter((t) => !["completed", "inspected"].includes(t.status) &&
      String(t.due_date || "").slice(0, 10) < taskDate), [tasks, taskDate]);
  const hkByRoom = useMemo(() => roomHkByRoom(tasks), [tasks]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["housekeeping"] });
    queryClient.invalidateQueries({ queryKey: ["rooms"] });
  };

  const handleCreateTask = async (e) => {
    e.preventDefault();
    if (!singlePropertyId) {
      setNotice({ type: "error", text: "Select a single property to assign tasks." });
      return;
    }
    if (!taskRoom) {
      setNotice({ type: "error", text: "Choose a room." });
      return;
    }
    const room = rooms.find((r) => String(r.room_number) === String(taskRoom));
    const due = taskDate;
    await db.entities.HousekeepingTask.create({
      property_id: singlePropertyId,
      property_name: properties.find((p) => p.id === singlePropertyId)?.name || "",
      task_date: due,
      due_date: due,
      room_number: String(taskRoom),
      room_type: room?.room_type || "",
      task: taskType,
      task_label: TASK_TYPE_LABELS[taskType] || taskType,
      assignee: assignee || "",
      status: assignee ? "assigned" : "pending",
      checklist: defaultChecklist(taskRoom),
    });
    invalidate();
    setAssignee(""); setTaskRoom(""); setShowNew(false);
    setNotice({ type: "ok", text: `Created ${TASK_TYPE_LABELS[taskType]} task for room ${taskRoom}.` });
  };

  const handleAdvance = async (task, next) => {
    if (!canTransition(task.status, next)) return;
    const patch = { status: next };
    if (task.status === "completed" && next === "inspected") patch.checklist_complete = true;
    // Always embed the current checklist so inspection state survives edits.
    if (task.checklist) patch.checklist = task.checklist;
    await db.entities.HousekeepingTask.update(task.id, patch);
    invalidate();
  };

  const toggleItem = async (task, idx) => {
    const list = (task.checklist || []).map((c, i) => (i === idx ? { ...c, done: !c.done } : c));
    await db.entities.HousekeepingTask.update(task.id, { checklist: list });
    invalidate();
  };

  const openTask = (task) => {
    setExpandedTask(task.id === expandedTask ? null : task.id);
    setChecklist(task.checklist || defaultChecklist(task.room_number));
  };

  if (roomsLoading || tasksLoading) return <p className="text-slate-500">Loading housekeeping board…</p>;

  // A failed read used to render this page as a finished shift: every counter at
  // 0 (Dirty, Assigned, In Progress, Overdue), an empty task queue, and either a
  // room grid with no rooms or the "No rooms to manage" card.
  if (roomsQ.isError || tasksQ.isError) {
    return (
      <div className="space-y-6">
        <header>
          <p className="text-[11px] uppercase tracking-[0.3em] text-[#00E096]">Operations</p>
          <h1 className="mt-2 font-heading text-3xl font-semibold text-white">Housekeeping</h1>
        </header>
        <ErrorState
          title="Could not load the housekeeping board"
          description="This read failed, so zeros and an empty task queue would not mean the work is done. Do not release rooms as clean or send a housekeeper home on the strength of this screen — dirty rooms and overdue tasks may still be outstanding."
          error={roomsQ.error || tasksQ.error}
          onRetry={() => { roomsQ.refetch(); tasksQ.refetch(); }}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header>
        <p className="text-[11px] uppercase tracking-[0.3em] text-[#00E096]">Operations</p>
        <h1 className="mt-2 font-heading text-3xl font-semibold text-white">Housekeeping</h1>
        <p className="mt-1 text-sm text-slate-400">
          Cleaning readiness for {dateRange.from || "—"} → {dateRange.to || "—"} · {rooms.length} rooms
        </p>
      </header>
      <div className="rounded-xl border border-white/5 bg-[#0F1F35]/60 p-3 text-sm text-slate-200">
        <strong>Labor Optimization:</strong> {laborPlan.schedule} · {laborPlan.requiredMinutes} minutes required.
      </div>

      <Card title="Productivity Standards" subtitle="Turnover times, wage, and target labor % — saved per property">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[
            ["minutesPerCheckout", "Checkout (min)"],
            ["minutesPerStayover", "Stayover (min)"],
            ["hourlyWage", "Hourly Wage ($)"],
            ["targetLaborRevenuePercent", "Target Labor %"],
          ].map(([field, label]) => (
            <label key={field} className="flex flex-col gap-1 text-xs text-slate-400">
              {label}
              <input
                type="number"
                value={hkEdited[field]}
                min="0"
                step={field === "hourlyWage" || field === "targetLaborRevenuePercent" ? "0.5" : "1"}
                onChange={(e) => setHk(field, Number(e.target.value))}
                className="rounded-lg border border-white/10 bg-[#0A1628] px-3 py-2 text-sm text-white"
              />
            </label>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-slate-400">
            Est. daily labor cost: <span className="font-medium text-white">{formatCents(estLaborCostCents, 0)}</span> · target {hkConfig.targetLaborRevenuePercent}% of revenue
          </p>
          <button
            onClick={saveHk}
            className="rounded-lg bg-[#00E096] px-4 py-2 text-sm font-medium text-[#04231A] hover:bg-[#00ffa8]"
          >
            Save Standards
          </button>
        </div>
        {isPortfolio && (
          <p className="mt-2 text-[11px] text-slate-500">Editing the portfolio-wide default. Select a single property to set property-specific standards.</p>
        )}
      </Card>

      {notice && (
        <div
          className={`rounded-lg border px-3 py-2 text-xs ${
            notice.type === "ok"
              ? "border-[#00E096]/30 bg-[#00E096]/10 text-[#00E096]"
              : "border-[#FF6B6B]/30 bg-[#FF6B6B]/10 text-[#FF6B6B]"
          }`}
        >
          {notice.text}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-6">
        {[
          ["Dirty Rooms", rollup.pending, "#FF6B6B"],
          ["Assigned", rollup.assigned, "#FFB547"],
          ["In Progress", rollup.in_progress, "#00D4FF"],
          ["Completed", rollup.completed, "#00E096"],
          ["Inspected Ready", rollup.readyToSell, "#4FE3C1"],
          ["Overdue", overdue.length, "#FF6B6B"],
        ].map(([label, value, color]) => (
          <div key={label} className="rounded-2xl border border-white/5 bg-[#0F1F35]/80 p-4">
            <p className="text-[11px] uppercase tracking-widest text-slate-400">{label}</p>
            <p className="mt-2 font-heading text-2xl font-semibold" style={{ color: String(color) }}>{value}</p>
          </div>
        ))}
      </div>

      {rooms.length === 0 ? (
        <Card title="No rooms to manage">
          <p className="text-sm text-slate-400">
            Housekeeping assigns tasks to the same room register the Room Board uses. Create a room register on the Room
            Board first, then return here.
          </p>
        </Card>
      ) : (
        <>
          <Card
            title="Room readiness"
            subtitle="Latest housekeeping state per room"
            right={
              <button
                onClick={() => setShowNew((v) => !v)}
                className="rounded-lg border border-[#00E096]/40 bg-[#00E096]/10 px-3 py-1.5 text-xs font-medium text-[#00E096] hover:bg-[#00E096]/20"
              >
                {showNew ? "Cancel" : "+ New Task"}
              </button>
            }
          >
            {showNew && (
              <form onSubmit={handleCreateTask} className="mb-4 grid gap-3 rounded-xl border border-white/5 bg-[#0A1628]/50 p-3 sm:grid-cols-2 lg:grid-cols-5">
                <label className="flex flex-col gap-1 text-xs text-slate-400">
                  Room
                  <select value={taskRoom} onChange={(e) => setTaskRoom(e.target.value)} className="rounded-lg border border-white/10 bg-[#0A1628] px-2 py-2 text-sm text-white">
                    <option value="">Select room</option>
                    {rooms.map((r) => <option key={r.id} value={r.room_number}>{r.room_number}</option>)}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-xs text-slate-400">
                  Task type
                  <select value={taskType} onChange={(e) => setTaskType(e.target.value)} className="rounded-lg border border-white/10 bg-[#0A1628] px-2 py-2 text-sm text-white">
                    {TASK_TYPES.map((t) => <option key={t} value={t}>{TASK_TYPE_LABELS[t]}</option>)}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-xs text-slate-400">
                  Assign to
                  <input value={assignee} onChange={(e) => setAssignee(e.target.value)} className="rounded-lg border border-white/10 bg-[#0A1628] px-2 py-2 text-sm text-white" />
                </label>
                <label className="flex flex-col gap-1 text-xs text-slate-400">
                  Due date
                  <input type="date" value={taskDate} onChange={(e) => setTaskDate(e.target.value)} className="rounded-lg border border-white/10 bg-[#0A1628] px-2 py-2 text-sm text-white" />
                </label>
                <button type="submit" className="self-end rounded-lg bg-[#00E096] px-4 py-2 text-sm font-medium text-[#04231A] hover:bg-[#00ffa8] disabled:opacity-50">
                  Create
                </button>
              </form>
            )}

            <div className="grid gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
              {rooms.map((room) => {
                const hk = hkByRoom[String(room.room_number).trim()];
                const status = roomHkStatus(room, hk);
                const meta = STATUS_COLOR[status] || STATUS_COLOR.pending;
                return (
                  <div key={room.id} className="rounded-xl border p-2.5" style={{ borderColor: `${meta.color}44`, background: `${meta.color}14` }}>
                    <div className="flex items-center justify-between">
                      <span className="font-heading text-sm font-semibold text-white">{room.room_number}</span>
                      <span className="h-2 w-2 rounded-full" style={{ background: meta.color }} />
                    </div>
                    <p className="mt-1 text-[10px] text-slate-400">{room.room_type}</p>
                    <p className="mt-0.5 text-[10px] font-medium" style={{ color: meta.color }}>{meta.label}</p>
                    {hk && <p className="mt-0.5 truncate text-[10px] text-slate-500">{hk.assignee ? `→ ${hk.assignee}` : ""}</p>}
                  </div>
                );
              })}
            </div>
          </Card>

          <Card title="Task queue" subtitle={`${rollup.total} total · ${overdue.length} overdue`}>
            {tasks.length === 0 ? (
              <p className="text-sm text-slate-400">No tasks yet. Use "+ New Task" to assign cleaning work.</p>
            ) : (
              <div className="space-y-2">
                {tasks.map((t) => {
                  const meta = STATUS_COLOR[t.status] || STATUS_COLOR.pending;
                  const isOpen = expandedTask === t.id;
                  const progress = checklistProgress(t.checklist);
                  const complete = checklistComplete(t.checklist);
                  return (
                    <div key={t.id} className="rounded-xl border border-white/5 bg-[#0A1628]/50 p-3">
                      <div className="flex flex-wrap items-center gap-3">
                        <span className="w-12 font-heading text-sm font-semibold text-white">{t.room_number}</span>
                        <span className="w-32 text-xs text-slate-300">{t.task_label || TASK_TYPE_LABELS[t.task] || t.task}</span>
                        <span className="w-24 truncate text-xs text-slate-400">{t.assignee || "Unassigned"}</span>
                        <span className="rounded-full px-2 py-0.5 text-[10px] font-medium" style={{ background: `${meta.color}22`, color: meta.color }}>
                          {meta.label}
                        </span>
                        <span className="text-xs text-slate-500">due {t.due_date || t.task_date || "—"}</span>
                        <button
                          onClick={() => openTask(t)}
                          className="ml-auto rounded border border-white/10 px-2 py-1 text-xs text-slate-300 hover:bg-white/10"
                        >
                          {isOpen ? "Close" : "Inspect"}
                        </button>
                      </div>

                      {isOpen && (
                        <div className="mt-3 border-t border-white/5 pt-3">
                          {t.checklist && t.checklist.length > 0 ? (
                            <>
                              <div className="mb-2 flex items-center justify-between">
                                <p className="text-xs text-slate-400">Inspection checklist · {progress}%</p>
                                <div className="h-2 w-24 overflow-hidden rounded-full bg-white/10">
                                  <div className="h-full bg-[#00E096]" style={{ width: `${progress}%` }} />
                                </div>
                              </div>
                              <div className="space-y-1">
                                {t.checklist.map((item, idx) => (
                                  <label key={idx} className="flex items-center gap-2 text-xs text-slate-300">
                                    <input type="checkbox" checked={!!item.done} onChange={() => toggleItem(t, idx)} className="h-3.5 w-3.5" />
                                    {item.item}
                                  </label>
                                ))}
                              </div>
                              <p className={`mt-2 text-xs ${complete ? "text-[#00E096]" : "text-slate-500"}`}>
                                {complete ? "Checklist complete — ready for inspection." : "Not all items marked done."}
                              </p>
                            </>
                          ) : (
                            <p className="text-xs text-slate-500">No checklist recorded for this task.</p>
                          )}
                          <div className="mt-3 flex flex-wrap gap-2">
                            {TASK_STATUS.map((st) => (
                              <button
                                key={st}
                                disabled={!canTransition(t.status, st)}
                                onClick={() => handleAdvance(t, st)}
                                className="rounded border border-white/10 px-2 py-1 text-xs text-slate-300 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-30"
                              >
                                → {STATUS_COLOR[st]?.label || st}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}