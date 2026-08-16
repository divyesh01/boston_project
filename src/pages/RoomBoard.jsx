import React, { useMemo, useState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import Card from "@/components/ui-exec/Card";
import { useOccupancy, useRooms, useRoomStays, useHousekeepingTasks, useReservations, useWeatherSnapshots } from "@/lib/useHotelData";
import { C, num, pct, money, money2, avg, inventoryInScope, occupancyStats } from "@/lib/hotel";
import { useGlobalFilters } from "@/lib/useGlobalFilters";
import { db } from "@/api/base44Client";
import { buildRoomBoard, roomBoardStats, generateRoomRegister, toRateCents } from "@/lib/roomBoard";
import { suggestedRateForDate, forecastOccupancy } from "@/lib/pricingEngine";
import { isPricingEnabled, getPricingConfig, ROOM_TYPES } from "@/lib/pricingSettings";
import { useRealtimeInvalidation } from "@/lib/realtime";
import { ErrorState } from "@/components/ui/status";
import { motion, AnimatePresence } from "framer-motion";
const KIND_STYLE = {
  occupied: { color: C.purple, label: "Occupied" },
  dirty: { color: "#FFB547", label: "Dirty" },
  inspected: { color: C.green, label: "Inspected" },
  available: { color: "#00D4FF", label: "Clean" },
  out_of_service: { color: C.coral, label: "Out of Service" },
};

export default function RoomBoard() {
  const { dateRange, property, properties, months, latestDate } = useGlobalFilters();
  const queryClient = useQueryClient();
  useRealtimeInvalidation(["rooms", "room-stays", "housekeeping"]);

  const occQ = useOccupancy(dateRange, property, months);
  const roomsQ = useRooms(property);
  const staysQ = useRoomStays(dateRange, property, months);
  const tasksQ = useHousekeepingTasks(dateRange, property);
  const { data: occ = [], isLoading } = occQ;
  const { data: rooms = [], isLoading: roomsLoading } = roomsQ;
  const { data: stays = [], isLoading: staysLoading } = staysQ;
  const { data: tasks = [], isLoading: tasksLoading } = tasksQ;
  const { data: reservations = [], isLoading: reservationsLoading } = useReservations(dateRange, property);
  const { data: weatherSnapshots = [] } = useWeatherSnapshots(property);

  const [boardDate, setBoardDate] = useState(latestDate || new Date().toISOString().slice(0, 10));
  useEffect(() => {
    if (latestDate && !boardDate) setBoardDate(latestDate);
  }, [latestDate, boardDate]);

  const [newGuest, setNewGuest] = useState("");
  const [newRoom, setNewRoom] = useState("");
  const [newRate, setNewRate] = useState("");
  const [newIn, setNewIn] = useState(boardDate);
  const [newOut, setNewOut] = useState("");
  const [newFolio, setNewFolio] = useState("");
  const [notice, setNotice] = useState(null);

  // Owner-facing pricing: compute the engine's suggested rate for the room
  // type being checked in on the selected board date. Feeds the check-in form
  // "suggested rate" badge so the operator never guesses what to charge.
  const pricingEnabled = isPricingEnabled();
  const pricingConfig = getPricingConfig();
  const suggestedForRoom = useMemo(() => {
    if (!pricingEnabled || !newRoom || !boardDate) return null;
    const room = rooms.find((r) => String(r.room_number) === String(newRoom));
    if (!room) return null;
    const weatherByDate = {};
    for (const s of weatherSnapshots || []) {
      const d = String(s.date || "").slice(0, 10);
      if (!weatherByDate[d]) weatherByDate[d] = s.condition;
    }
    const occ = forecastOccupancy({ reservations, rooms, date: boardDate, defaultOccupancy: pricingConfig.forecastDefaultOccupancy });
    return suggestedRateForDate({
      roomType: room.room_type, date: boardDate, occupancy: occ, reservations, rooms, weatherByDate, config: pricingConfig,
    });
  }, [pricingEnabled, newRoom, boardDate, rooms, reservations, weatherSnapshots, pricingConfig]);

  // Recommended rate per room type for the selected board date — shown as a
  // "Suggested" badge on vacant tiles.
  const recommendedByType = useMemo(() => {
    if (!pricingEnabled || !boardDate) return {};
    const weatherByDate = {};
    for (const s of weatherSnapshots || []) {
      const d = String(s.date || "").slice(0, 10);
      if (!weatherByDate[d]) weatherByDate[d] = s.condition;
    }
    const occ = forecastOccupancy({ reservations, rooms, date: boardDate, defaultOccupancy: pricingConfig.forecastDefaultOccupancy });
    const out = {};
    for (const type of ROOM_TYPES) {
      out[type] = suggestedRateForDate({ roomType: type, date: boardDate, occupancy: occ, reservations, rooms, weatherByDate, config: pricingConfig });
    }
    return out;
  }, [pricingEnabled, boardDate, rooms, reservations, weatherSnapshots, pricingConfig]);

  const isPortfolio = property === "all" || Array.isArray(property);
  const inventory = inventoryInScope(property, properties);
  const propName = isPortfolio
    ? (Array.isArray(property) ? `${property.length} Properties` : "Portfolio")
    : (properties.find((p) => p.id === property)?.name || "Property");

  const stats = useMemo(() => {
    if (!occ.length) {
      return { avgOccupied: 0, avgOoo: 0, avgVacant: 0, occupancy: 0, adr: 0, days: 0, downNights: 0, oooLoss: 0 };
    }
    const s = occupancyStats(occ, properties);
    const avgOccupied = Math.round(avg(occ, "rooms_sold"));
    const avgOoo = Math.round(avg(occ, "down_rooms"));
    const downNights = occ.reduce((a, r) => a + (Number(r.down_rooms) || 0), 0);
    return {
      avgOccupied,
      avgOoo,
      avgVacant: Math.max(0, inventory - avgOccupied - avgOoo),
      occupancy: s.occupancy,
      adr: s.adr,
      days: s.days,
      downNights,
      oooLoss: downNights * s.adr,
    };
  }, [occ, properties, inventory]);

  // Per-room board for the selected business date.
  const tiles = useMemo(() => buildRoomBoard(rooms, stays, tasks, boardDate), [rooms, stays, tasks, boardDate]);
  const dayStats = useMemo(() => roomBoardStats(rooms, stays, boardDate), [rooms, stays, boardDate]);

  const invalidateBoard = () => {
    queryClient.invalidateQueries({ queryKey: ["rooms"] });
    queryClient.invalidateQueries({ queryKey: ["room-stays"] });
    queryClient.invalidateQueries({ queryKey: ["housekeeping"] });
  };

  const singlePropertyId = !isPortfolio ? property : null;

  const handleBootstrap = async () => {
    if (!singlePropertyId) {
      setNotice({ type: "error", text: "Select a single property to create its room register." });
      return;
    }
    const prop = properties.find((p) => p.id === singlePropertyId);
    const count = Number(prop?.rooms) || inventory;
    const rows = generateRoomRegister(singlePropertyId, count);
    // bulkCreate is not wrapped in a transaction, so a rejection can still
    // leave rows behind. Saying so is the difference between the operator
    // checking the board and blindly pressing the button again, which would
    // duplicate every room that did get written.
    try {
      await db.entities.Room.bulkCreate(rows);
    } catch (err) {
      invalidateBoard();
      setNotice({
        type: "error",
        text: `Could not create the room register: ${err?.message || err}. Some rooms may already have been written — check the board below before pressing this again, or you will create duplicates.`,
      });
      return;
    }
    invalidateBoard();
    setNotice({ type: "ok", text: `Created a ${count}-room register for ${prop?.name || "this property"}.` });
  };

  const handleAddStay = async (e) => {
    e.preventDefault();
    if (!singlePropertyId) {
      setNotice({ type: "error", text: "Select a single property to add a stay." });
      return;
    }
    if (!newRoom || !newGuest) {
      setNotice({ type: "error", text: "Room and guest name are required." });
      return;
    }
    const prop = properties.find((p) => p.id === singlePropertyId);
    const room = rooms.find((r) => String(r.room_number) === String(newRoom));

    // A check-in is two writes with two independent failure modes, and the
    // operator has to be told which one happened. Before, the stay write could
    // reject unhandled (the form just sat there), and the room-status write
    // swallowed its error into console.warn before falling through
    // unconditionally to "Checked in …". A front desk told "Checked in" while
    // the board still paints the room available will sell that room twice.
    try {
      await db.entities.RoomStay.create({
        property_id: singlePropertyId,
        property_name: prop?.name || "",
        date: newIn || boardDate,
        room_number: String(newRoom),
        guest_name: newGuest,
        room_type: room?.room_type || "Standard",
        check_in: newIn || boardDate,
        check_out: newOut || boardDate,
        rate_cents: toRateCents(newRate),
        folio_number: newFolio || "",
        status: "occupied",
      });
    } catch (err) {
      invalidateBoard();
      // The form is deliberately left filled so the check-in can be retried.
      setNotice({
        type: "error",
        text: `Could not check in ${newGuest} to room ${newRoom}: ${err?.message || err}. Nothing was saved — the guest is not on the board.`,
      });
      return;
    }

    // `rooms` is the Room table for this property and it is what the board
    // paints from, so a hand-typed room number may match no row at all — in
    // which case `room.id` used to throw a TypeError after the stay was
    // already written.
    let statusWarning = null;
    if (!room?.id) {
      statusWarning = `room ${newRoom} has no entry in the room list, so its status could not be set to occupied`;
    } else {
      try {
        await db.entities.Room.update(room.id, { status: "occupied" });
      } catch (err) {
        statusWarning = `room ${newRoom} could not be marked occupied (${err?.message || err})`;
      }
    }

    invalidateBoard();
    setNewGuest(""); setNewRate(""); setNewFolio(""); setNewOut("");
    setNotice(
      statusWarning
        ? {
            type: "warn",
            text: `Stay saved for ${newGuest}, but ${statusWarning}. The board may still show the room as available — set its status manually before selling it again.`,
          }
        : { type: "ok", text: `Checked in ${newGuest} to room ${newRoom}.` }
    );
  };

  const handleRoomState = async (roomId, status) => {
    // Housekeeping and maintenance taps write straight to the Room row. An
    // unreported rejection here left the row unchanged with no message at all,
    // which a user reads as "already saved".
    try {
      await db.entities.Room.update(roomId, { status });
      setNotice(null);
    } catch (err) {
      setNotice({
        type: "error",
        text: `Could not set that room to "${status}": ${err?.message || err}. The room status is unchanged.`,
      });
    }
    invalidateBoard();
  };

  if (isLoading || roomsLoading) return <p className="text-slate-500">Loading property board…</p>;

  // On a failed read of the room register, stays, housekeeping tasks or
  // occupancy, this page used to draw the whole board anyway: every tile in the
  // "Clean" colour, 0 Occupied / 0 Dirty in the counters, and the aggregate
  // summary replaced by the "No occupancy data" import prompt.
  if (roomsQ.isError || staysQ.isError || tasksQ.isError || occQ.isError) {
    return (
      <div className="space-y-6">
        <header>
          <p className="text-[11px] uppercase tracking-[0.3em] text-[#00D4FF]">Module 4</p>
          <h1 className="mt-2 font-heading text-3xl font-semibold text-white">Room Board</h1>
        </header>
        <ErrorState
          title="Could not load the room board"
          description="Do not sell rooms off this screen. The read failed, and the board it used to draw showed every room clean and empty with nobody checked in — a front desk reading that would sell rooms that already have a guest in them."
          error={roomsQ.error || staysQ.error || tasksQ.error || occQ.error}
          onRetry={() => { roomsQ.refetch(); staysQ.refetch(); tasksQ.refetch(); occQ.refetch(); }}
        />
      </div>
    );
  }

  const mix = [
    ["Occupied", stats.avgOccupied, C.purple],
    ["Vacant", stats.avgVacant, C.green],
    ["Out of service", stats.avgOoo, C.coral],
  ].filter(([, v]) => Number(v) > 0);
  const mixTotal = mix.reduce((a, [, v]) => a + Number(v), 0) || 1;

  return (
    <motion.div 
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className="space-y-6"
    >
      <header>
        <p className="text-[11px] uppercase tracking-[0.3em] text-[#00D4FF]">Module 4</p>
        <h1 className="mt-2 font-heading text-3xl font-semibold text-white">Room Board</h1>
        <p className="mt-1 text-sm text-slate-400">
          {propName} · {inventory} rooms · {dateRange.from || "—"} → {dateRange.to || "—"} · {stats.days} day average
        </p>
      </header>

      {/* Per-room live board */}
      <Card
        title={`Live room status · ${boardDate || "select a date"}`}
        subtitle="Per-room guest, rate, housekeeping and maintenance state for the selected night"
        right={
          <label className="flex items-center gap-2 text-xs text-slate-400">
            Date
            <input
              type="date"
              value={boardDate}
              onChange={(e) => setBoardDate(e.target.value)}
              className="rounded-lg border border-white/10 bg-[#0A1628] px-2 py-1 text-xs text-white"
            />
          </label>
        }
      >
        {notice && (
          <div
            className={`mb-4 rounded-lg border px-3 py-2 text-xs ${
              notice.type === "ok"
                ? "border-[#00E096]/30 bg-[#00E096]/10 text-[#00E096]"
                : notice.type === "warn"
                  ? "border-[#FFB547]/30 bg-[#FFB547]/10 text-[#FFB547]"
                  : "border-[#FF6B6B]/30 bg-[#FF6B6B]/10 text-[#FF6B6B]"
            }`}
          >
            {notice.text}
          </div>
        )}

        <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[
            ["Occupied", num(dayStats.occupied), C.purple],
            ["Clean Ready", num(dayStats.vacant), "#00D4FF"],
            ["Dirty", num(dayStats.dirty), "#FFB547"],
            ["Out of Service", num(dayStats.oos), C.coral],
          ].map(([label, value, color]) => (
            <div key={label} className="rounded-xl border border-white/5 bg-[#0A1628]/60 p-3">
              <p className="text-[10px] uppercase tracking-widest text-slate-500">{label}</p>
              <p className="mt-1 font-heading text-xl font-semibold" style={{ color: String(color) }}>{value}</p>
            </div>
          ))}
        </div>

        {rooms.length === 0 ? (
          <div className="rounded-xl border border-white/5 bg-[#0A1628]/40 p-6 text-center">
            <p className="text-sm text-slate-300">No room register yet.</p>
            <p className="mt-1 text-xs text-slate-500">
              The imported reports only carry daily totals, so the per-room board needs a room register to render. Create one
              from this property's inventory to begin.
            </p>
            <button
              onClick={handleBootstrap}
              className="mt-4 rounded-lg bg-[#6C63FF] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#5b52e8]"
            >
              {isPortfolio ? "Select a single property first" : `Create ${num(inventory)}-room register`}
            </button>
          </div>
        ) : (
          <div className="grid gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
            {tiles.map((t, index) => {
              const s = KIND_STYLE[t.kind] || KIND_STYLE.available;
              return (
                <motion.div
                  key={t.room_number}
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ delay: index * 0.015, duration: 0.2 }}
                  whileHover={{ scale: 1.03 }}
                  className="group relative rounded-xl border p-2.5 transition-all"
                  style={{ borderColor: `${s.color}44`, background: `${s.color}14` }}
                  title={`${t.room_number} · ${s.label}${t.guest_name ? " · " + t.guest_name : ""}`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-heading text-sm font-semibold text-white">{t.room_number}</span>
                    <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
                  </div>
                  <p className="mt-1 truncate text-xs text-slate-300">{t.guest_name || s.label}</p>
                  <p className="truncate text-[10px] text-slate-500">{t.room_type}{t.floor ? ` · Fl ${t.floor}` : ""}</p>
                  {t.kind === "occupied" && (
                    <p className="mt-0.5 truncate text-[10px] text-[#00E096]">
                      {money(t.rate_cents)}{t.check_out ? ` → ${t.check_out}` : ""}
                    </p>
                  )}
                  {!isPortfolio && pricingEnabled && !t.guest_name && (
                    <p className="mt-0.5 truncate text-[10px] text-[#6C63FF]">
                      Suggested {money2(recommendedByType[t.room_type]?.recommendedCents || 0)}
                    </p>
                  )}
                  {!isPortfolio && pricingEnabled && t.guest_name && recommendedByType[t.room_type] && (
                    <p className="mt-0.5 truncate text-[10px] text-slate-500">
                      vs rec {money2(recommendedByType[t.room_type].recommendedCents)}
                    </p>
                  )}
                  {!isPortfolio && (
                    <div className="mt-1.5 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                      {["available", "dirty", "out_of_service"].map((st) => (
                        <button
                          key={st}
                          onClick={() => handleRoomState(t.roomId || t.id, st)}
                          className="flex-1 rounded bg-white/10 px-1 py-0.5 text-[9px] text-slate-300 hover:bg-white/20"
                        >
                          {st === "out_of_service" ? "OOS" : st[0].toUpperCase()}
                        </button>
                      ))}
                    </div>
                  )}
                </motion.div>
              );
            })}
          </div>
        )}

        {rooms.length > 0 && dayStats.soldCount > 0 && (
          <div className="mt-4 border-t border-white/5 pt-3 text-xs text-slate-400">
            <span className="font-semibold text-white">{money(dayStats.revenueCents)}</span> night revenue ·{" "}
            <span className="font-semibold text-white">{money2(dayStats.adrCents)}</span> ADR on {num(dayStats.soldCount)} room
            {dayStats.soldCount === 1 ? "" : "s"} · {pct(dayStats.occupancy)} occupancy on {boardDate}
          </div>
        )}
      </Card>

      {/* Upcoming Channel Reservations */}
      <Card title="Upcoming Channel Reservations" subtitle="Reservations synced from OTAs (Booking.com, Expedia, etc.)">
        {reservationsLoading ? (
          <p className="text-sm text-slate-500">Loading reservations...</p>
        ) : reservations.length === 0 ? (
          <div className="rounded-xl border border-white/5 bg-[#0A1628]/40 p-6 text-center">
            <p className="text-sm text-slate-300">No upcoming reservations found.</p>
            <p className="mt-1 text-xs text-slate-500">
              Go to the Channel Manager module to sync reservations from your connected OTAs.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm text-slate-300">
              <thead className="border-b border-white/10 text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-4 py-3 font-medium">Channel</th>
                  <th className="px-4 py-3 font-medium">Conf #</th>
                  <th className="px-4 py-3 font-medium">Check-In</th>
                  <th className="px-4 py-3 font-medium">Check-Out</th>
                  <th className="px-4 py-3 font-medium">Room Type</th>
                  <th className="px-4 py-3 font-medium text-right">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                <AnimatePresence>
                  {reservations.map((res, index) => (
                    <motion.tr 
                      key={res.id} 
                      initial={{ opacity: 0, x: -10 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: index * 0.05 }}
                      className="transition-colors hover:bg-white/[0.02]"
                    >
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-white/5 px-2.5 py-1 text-xs font-medium text-white">
                          {res.channel === "Booking.com" ? "B.com" : res.channel}
                        </span>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs">{res.confirmation_num}</td>
                      <td className="px-4 py-3">{res.check_in}</td>
                      <td className="px-4 py-3">{res.check_out}</td>
                      <td className="px-4 py-3">{res.room_type_id}</td>
                      <td className="px-4 py-3 text-right">
                        <span className={`inline-flex rounded-md px-2 py-1 text-[10px] font-semibold uppercase tracking-wider ${
                          res.status === 'Confirmed' ? 'bg-green-500/10 text-green-400' : 'bg-slate-500/10 text-slate-400'
                        }`}>
                          {res.status}
                        </span>
                      </td>
                    </motion.tr>
                  ))}
                </AnimatePresence>
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Front-desk entry */}
      <Card title="Check in a guest" subtitle="Add a per-room stay for the selected night (rate stored in integer cents)">
        <form onSubmit={handleAddStay} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
          <label className="flex flex-col gap-1 text-xs text-slate-400">
            Room
            <select
              value={newRoom}
              onChange={(e) => setNewRoom(e.target.value)}
              className="rounded-lg border border-white/10 bg-[#0A1628] px-2 py-2 text-sm text-white"
            >
              <option value="">Select room</option>
              {rooms.map((r) => (
                <option key={r.id} value={r.room_number}>{r.room_number}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-slate-400">
            Guest name
            <input value={newGuest} onChange={(e) => setNewGuest(e.target.value)} className="rounded-lg border border-white/10 bg-[#0A1628] px-2 py-2 text-sm text-white" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-slate-400">
            Check-in
            <input type="date" value={newIn} onChange={(e) => setNewIn(e.target.value)} className="rounded-lg border border-white/10 bg-[#0A1628] px-2 py-2 text-sm text-white" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-slate-400">
            Check-out
            <input type="date" value={newOut} onChange={(e) => setNewOut(e.target.value)} className="rounded-lg border border-white/10 bg-[#0A1628] px-2 py-2 text-sm text-white" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-slate-400">
            Rate ($)
            <input type="number" min="0" step="0.01" value={newRate} onChange={(e) => setNewRate(e.target.value)} className="rounded-lg border border-white/10 bg-[#0A1628] px-2 py-2 text-sm text-white" />
            {suggestedForRoom && (
              <div className="mt-1 rounded-md border border-[#6C63FF]/20 bg-[#6C63FF]/5 px-2 py-1.5 text-xs">
                <span className="text-slate-400">Suggested: </span>
                <span className="font-medium text-[#6C63FF]">{money2(suggestedForRoom.recommendedCents)}</span>
                <span className="text-slate-500"> · occ {Math.round(suggestedForRoom.occupancy * 100)}% → {Math.round((suggestedForRoom.multiplierBps / 10000) * 100)}× base</span>
              </div>
            )}
          </label>
          <button
            type="submit"
            className="self-end rounded-lg bg-[#6C63FF] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#5b52e8] disabled:opacity-50"
            disabled={!singlePropertyId}
          >
            Check In
          </button>
        </form>
      </Card>

      {/* Aggregate summary (unchanged behaviour) */}
      {!occ.length ? (
        <Card title="No occupancy data">
          <p className="text-sm text-slate-400">
            Import an Occupancy report for {dateRange.from || "this range"} → {dateRange.to || ""} to populate the aggregate
            summary below.
          </p>
        </Card>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
            {[
              ["Avg Occupied", num(stats.avgOccupied), C.purple],
              ["Avg Vacant", num(stats.avgVacant), C.green],
              ["Avg Out of Service", num(stats.avgOoo), C.coral],
              ["Occupancy", pct(stats.occupancy), C.cyan],
              ["ADR", money2(stats.adr), C.amber],
            ].map(([label, value, color]) => (
              <div key={label} className="rounded-2xl border border-white/5 bg-[#0F1F35]/80 p-4">
                <p className="text-[11px] uppercase tracking-widest text-slate-400">{label}</p>
                <p className="mt-2 font-heading text-2xl font-semibold" style={{ color: String(color) }}>{value}</p>
              </div>
            ))}
          </div>

          {stats.downNights > 0 && (
            <Card title="Revenue lost to out-of-service rooms">
              <p className="text-sm text-slate-300">
                <span className="font-heading text-2xl font-semibold" style={{ color: C.coral }}>
                  {money(stats.oooLoss)}
                </span>{" "}
                of room revenue was unavailable to sell across this period.
              </p>
              <p className="mt-2 text-sm text-slate-400">
                {num(stats.downNights)} out-of-service room-night{stats.downNights === 1 ? "" : "s"} at the{" "}
                {money2(stats.adr)} ADR actually achieved — the revenue those rooms would have earned at your own average rate.
              </p>
            </Card>
          )}

          <Card
            title={`Average room mix · ${stats.days}-day average`}
            subtitle="Share of physical inventory by state, averaged across the selected period"
          >
            <div className="flex h-8 w-full overflow-hidden rounded-lg">
              {mix.map(([label, value, color]) => (
                <div
                  key={label}
                  title={`${label}: ${value} rooms`}
                  className="flex items-center justify-center text-[10px] font-medium text-white/90"
                  style={{ width: `${(Number(value) / mixTotal) * 100}%`, background: `${color}66`, borderRight: "1px solid #0F1F35" }}
                >
                  {(Number(value) / mixTotal) > 0.08 ? value : ""}
                </div>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap gap-4">
              {mix.map(([label, value, color]) => (
                <span key={label} className="flex items-center gap-2 text-xs text-slate-400">
                  <span className="h-2.5 w-2.5 rounded-sm" style={{ background: String(color) }} />
                  {label} · {num(value)} ({pct(Number(value) / mixTotal)})
                </span>
              ))}
            </div>
          </Card>
        </>
      )}
    </motion.div>
  );
}
