// Enhanced Room Board — pure logic for the per-room operational board.
//
// The imported daily reports only carry aggregates (rooms_sold, down_rooms,
// revenue), so a live per-room board cannot be derived from them. This module
// reads three per-room sources instead:
//   Room            — the room master register (number, type, floor, capacity,
//                     persistent status like maintenance/out-of-service)
//   RoomStay        — the per-room nightly ledger (guest, check-in/out, rate in
//                     integer cents, room type) keyed by business date
//   HousekeepingTask — the operational cleaning state per room
//
// All financial math uses integer cents (per BUSINESS.md): rates are stored as
// rate_cents and summed with integer arithmetic before being divided to produce
// ADR. No float dollars are ever added together here.
//
// The module is React-free so scripts/probe-roomboard.mjs can exercise the real
// implementation in Node against fake-indexeddb.

export const ROOM_TYPES = ["Standard", "Queen", "King", "Suite", "Double", "Accessible"];

export const ROOM_STATUS = [
  "available",      // clean, ready to sell
  "occupied",       // guest checked in
  "dirty",          // guest out, needs cleaning
  "inspected",      // cleaned and inspected, ready to sell
  "out_of_service", // maintenance / cannot sell
];

// ─── Normalization helpers ───

export function normalizeRoomNumber(v) {
  return String(v ?? "").trim();
}

// Strictly validates and canonicalizes primary key IDs (numbers > 0 or non-empty strings)
export function normalizeRoomId(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  if (typeof value === "string") {
    const t = value.trim();
    if (!t || t === "null" || t === "undefined" || t === "NaN" || t === "0") return null;
    const num = Number(t);
    if (Number.isFinite(num) && num > 0) return num;
    return /^[A-Za-z0-9_-]+$/.test(t) ? t : null;
  }
  return null;
}

// Deterministic integer-cents rounding for a dollar rate (avoid float drift).
export function toRateCents(dollars) {
  return Math.round((Number(dollars) || 0) * 100);
}

// Sum rates across stays in integer cents.
export function sumRateCents(stays) {
  return (stays || []).reduce((acc, s) => acc + (Number(s.rate_cents) || 0), 0);
}

// ─── Selections ───

// Stays that fall on the given business date (YYYY-MM-DD), including multi-night stays.
export function staysForDate(stays, date) {
  if (!date) return [];
  const targetDate = String(date).slice(0, 10);
  return (stays || []).filter((s) => {
    const sDate = String(s.date || "").slice(0, 10);
    if (sDate === targetDate) return true;
    const checkIn = String(s.check_in || s.date || "").slice(0, 10);
    const checkOut = String(s.check_out || s.date || "").slice(0, 10);
    if (checkIn && checkOut && targetDate >= checkIn && targetDate < checkOut) return true;
    return false;
  });
}

// Map room_number / [property_id:room_number] -> stay for a single date.
export function staysByRoom(stays, date) {
  const map = {};
  for (const s of staysForDate(stays, date)) {
    const roomKey = normalizeRoomNumber(s.room_number);
    if (!roomKey) continue;
    const propKey = s.property_id ? String(s.property_id) : "";
    const compositeKey = propKey ? `${propKey}:${roomKey}` : roomKey;
    if (!map[compositeKey]) map[compositeKey] = s;
    if (!map[roomKey]) map[roomKey] = s;
  }
  return map;
}

// Most recent housekeeping state per room (across all tasks), supporting composite keys.
export function housekeepingByRoom(tasks) {
  const map = {};
  for (const t of tasks || []) {
    const roomKey = normalizeRoomNumber(t.room_number);
    if (!roomKey) continue;
    const propKey = t.property_id ? String(t.property_id) : "";
    const compositeKey = propKey ? `${propKey}:${roomKey}` : roomKey;
    const existingComp = map[compositeKey];
    if (!existingComp || String(t.task_date || "") >= String(existingComp.task_date || "")) {
      map[compositeKey] = t;
    }
    const existing = map[roomKey];
    if (!existing || String(t.task_date || "") >= String(existing.task_date || "")) {
      map[roomKey] = t;
    }
  }
  return map;
}

// ─── Board statistics (integer-cents math) ───

// Aggregate stats for a set of rooms and the stays on one date.
export function roomBoardStats(rooms, stays, date) {
  const roomList = rooms || [];
  const dayStays = staysForDate(stays, date);
  const byRoom = staysByRoom(stays, date);

  let occupied = 0;
  let oos = 0;
  let dirty = 0;
  const occupiedStays = [];

  for (const room of roomList) {
    if (String(room.status) === "out_of_service" || String(room.maintenance) === "out_of_service") {
      oos += 1;
      continue;
    }
    const roomNum = normalizeRoomNumber(room.room_number);
    const propId = room.property_id ? String(room.property_id) : "";
    const stay = propId
      ? byRoom[`${propId}:${roomNum}`] || (byRoom[roomNum] && !byRoom[roomNum].property_id ? byRoom[roomNum] : undefined)
      : byRoom[roomNum];
    if (stay) {
      occupied += 1;
      occupiedStays.push(stay);
    } else if (String(room.status) === "dirty") {
      dirty += 1;
    }
  }

  // A stay might exist for a room not yet in the register — count it so the
  // board never under-reports occupancy.
  for (const stay of dayStays) {
    const key = normalizeRoomNumber(stay.room_number);
    const inRegister = roomList.some((r) => normalizeRoomNumber(r.room_number) === key);
    if (!inRegister) {
      occupied += 1;
      occupiedStays.push(stay);
    }
  }

  const revenueCents = sumRateCents(occupiedStays);
  const inventory = roomList.length || 1;
  const adrCents = occupiedStays.length ? Math.round(revenueCents / occupiedStays.length) : 0;
  const occupancy = inventory ? occupied / inventory : 0;

  return {
    inventory: roomList.length,
    occupied,
    vacant: Math.max(0, inventory - occupied - oos - dirty),
    dirty,
    oos,
    occupancy,
    adrCents,
    revenueCents,
    soldCount: occupiedStays.length,
  };
}

// ─── Tile composition ───

// Map task statuses to standard display states
function mapHousekeepingStatus(status) {
  if (!status) return null;
  const s = String(status).toLowerCase();
  if (s === "inspected") return "inspected";
  if (["pending", "assigned", "in_progress", "completed", "dirty"].includes(s)) return "dirty";
  if (s === "available" || s === "clean") return "available";
  if (s === "out_of_service") return "out_of_service";
  return null;
}

// Derive the single display status for one room tile given its stay + housekeeping.
export function roomTile(room, stay, housekeeping) {
  if (!room) return null;
  const rawId = room.id ?? room.roomId;
  const validId = normalizeRoomId(rawId);
  const base = {
    id: validId ?? rawId ?? undefined,
    roomId: validId ?? rawId ?? undefined,
    property_id: room.property_id || "",
    room_number: normalizeRoomNumber(room.room_number),
    room_type: room.room_type || "Standard",
    floor: room.floor || "",
    maintenance: room.maintenance || (room.status === "out_of_service" ? "out_of_service" : "available"),
  };

  if (stay) {
    return {
      ...base,
      kind: "occupied",
      guest_name: stay.guest_name || "Guest",
      check_in: stay.check_in || "",
      check_out: stay.check_out || "",
      rate_cents: Number(stay.rate_cents) || 0,
      folio_number: stay.folio_number || "",
      housekeeping: housekeeping?.status || "occupied",
    };
  }

  // Vacant — reflect the persistent room status and the latest housekeeping state.
  if (String(room.status) === "out_of_service" || String(room.maintenance) === "out_of_service") {
    return { ...base, kind: "out_of_service", housekeeping: "out_of_service", guest_name: "", rate_cents: 0 };
  }
  const hkStatus = mapHousekeepingStatus(housekeeping?.status);
  const hk = hkStatus || room.status || "available";
  return { ...base, kind: hk, guest_name: "", rate_cents: 0, housekeeping: hk };
}

// Build the full ordered tile list for one date.
export function buildRoomBoard(rooms, stays, tasks, date) {
  const byRoom = staysByRoom(stays, date);
  const hkByRoom = housekeepingByRoom(tasks);
  return (rooms || [])
    .map((room) => {
      const roomNum = normalizeRoomNumber(room.room_number);
      const propId = room.property_id ? String(room.property_id) : "";
      const stay = propId
        ? byRoom[`${propId}:${roomNum}`] || (byRoom[roomNum] && !byRoom[roomNum].property_id ? byRoom[roomNum] : undefined)
        : byRoom[roomNum];
      const hk = propId
        ? hkByRoom[`${propId}:${roomNum}`] || (hkByRoom[roomNum] && !hkByRoom[roomNum].property_id ? hkByRoom[roomNum] : undefined)
        : hkByRoom[roomNum];
      return roomTile(room, stay, hk);
    })
    .filter(Boolean);
}

// ─── Room register bootstrap ───

// Build a deterministic room register for a property that has none, so the board
// is usable immediately after import. Pure — callers persist rows themselves.
export function generateRoomRegister(propertyId, count) {
  const out = [];
  const start = 100;
  const types = ["Standard", "Queen", "King", "Suite", "Double"];
  for (let i = 0; i < count; i += 1) {
    const number = String(start + i);
    const floor = Math.floor(i / 8) + 1;
    out.push({
      property_id: propertyId,
      room_number: number,
      room_type: types[i % types.length],
      floor,
      capacity: types[i % types.length] === "Suite" ? 4 : 2,
      status: "available",
      maintenance: "available",
    });
  }
  return out;
}
