import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
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
    const { data: occ = [], isLoading } = useOccupancy(dateRange, property, months);
    const { data: rooms = [], isLoading: roomsLoading } = useRooms(property);
    const { data: stays = [], isLoading: staysLoading } = useRoomStays(dateRange, property, months);
    const { data: tasks = [], isLoading: tasksLoading } = useHousekeepingTasks(dateRange, property);
    const { data: reservations = [], isLoading: reservationsLoading } = useReservations(dateRange, property);
    const { data: weatherSnapshots = [] } = useWeatherSnapshots(property);
    const [boardDate, setBoardDate] = useState(latestDate || new Date().toISOString().slice(0, 10));
    useEffect(() => {
        if (latestDate && !boardDate)
            setBoardDate(latestDate);
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
        if (!pricingEnabled || !newRoom || !boardDate)
            return null;
        const room = rooms.find((r) => String(r.room_number) === String(newRoom));
        if (!room)
            return null;
        const weatherByDate = {};
        for (const s of weatherSnapshots || []) {
            const d = String(s.date || "").slice(0, 10);
            if (!weatherByDate[d])
                weatherByDate[d] = s.condition;
        }
        const occ = forecastOccupancy({ reservations, rooms, date: boardDate, defaultOccupancy: pricingConfig.forecastDefaultOccupancy });
        return suggestedRateForDate({
            roomType: room.room_type, date: boardDate, occupancy: occ, reservations, rooms, weatherByDate, config: pricingConfig,
        });
    }, [pricingEnabled, newRoom, boardDate, rooms, reservations, weatherSnapshots, pricingConfig]);
    // Recommended rate per room type for the selected board date — shown as a
    // "Suggested" badge on vacant tiles.
    const recommendedByType = useMemo(() => {
        if (!pricingEnabled || !boardDate)
            return {};
        const weatherByDate = {};
        for (const s of weatherSnapshots || []) {
            const d = String(s.date || "").slice(0, 10);
            if (!weatherByDate[d])
                weatherByDate[d] = s.condition;
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
        await db.entities.Room.bulkCreate(rows);
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
        await db.entities.Room.update(room.id, { status: "occupied" }).catch(() => { });
        invalidateBoard();
        setNewGuest("");
        setNewRate("");
        setNewFolio("");
        setNewOut("");
        setNotice({ type: "ok", text: `Checked in ${newGuest} to room ${newRoom}.` });
    };
    const handleRoomState = async (roomId, status) => {
        await db.entities.Room.update(roomId, { status });
        invalidateBoard();
    };
    if (isLoading || roomsLoading)
        return _jsx("p", { className: "text-slate-500", children: "Loading property board\u2026" });
    const mix = [
        ["Occupied", stats.avgOccupied, C.purple],
        ["Vacant", stats.avgVacant, C.green],
        ["Out of service", stats.avgOoo, C.coral],
    ].filter(([, v]) => Number(v) > 0);
    const mixTotal = mix.reduce((a, [, v]) => a + Number(v), 0) || 1;
    return (_jsxs(motion.div, { initial: { opacity: 0, y: 10 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.4 }, className: "space-y-6", children: [_jsxs("header", { children: [_jsx("p", { className: "text-[11px] uppercase tracking-[0.3em] text-[#00D4FF]", children: "Module 4" }), _jsx("h1", { className: "mt-2 font-heading text-3xl font-semibold text-white", children: "Room Board" }), _jsxs("p", { className: "mt-1 text-sm text-slate-400", children: [propName, " \u00B7 ", inventory, " rooms \u00B7 ", dateRange.from || "—", " \u2192 ", dateRange.to || "—", " \u00B7 ", stats.days, " day average"] })] }), _jsxs(Card, { title: `Live room status · ${boardDate || "select a date"}`, subtitle: "Per-room guest, rate, housekeeping and maintenance state for the selected night", right: _jsxs("label", { className: "flex items-center gap-2 text-xs text-slate-400", children: ["Date", _jsx("input", { type: "date", value: boardDate, onChange: (e) => setBoardDate(e.target.value), className: "rounded-lg border border-white/10 bg-[#0A1628] px-2 py-1 text-xs text-white" })] }), children: [notice && (_jsx("div", { className: `mb-4 rounded-lg border px-3 py-2 text-xs ${notice.type === "ok"
                            ? "border-[#00E096]/30 bg-[#00E096]/10 text-[#00E096]"
                            : "border-[#FF6B6B]/30 bg-[#FF6B6B]/10 text-[#FF6B6B]"}`, children: notice.text })), _jsx("div", { className: "mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4", children: [
                            ["Occupied", num(dayStats.occupied), C.purple],
                            ["Clean Ready", num(dayStats.vacant), "#00D4FF"],
                            ["Dirty", num(dayStats.dirty), "#FFB547"],
                            ["Out of Service", num(dayStats.oos), C.coral],
                        ].map(([label, value, color]) => (_jsxs("div", { className: "rounded-xl border border-white/5 bg-[#0A1628]/60 p-3", children: [_jsx("p", { className: "text-[10px] uppercase tracking-widest text-slate-500", children: label }), _jsx("p", { className: "mt-1 font-heading text-xl font-semibold", style: { color: String(color) }, children: value })] }, label))) }), rooms.length === 0 ? (_jsxs("div", { className: "rounded-xl border border-white/5 bg-[#0A1628]/40 p-6 text-center", children: [_jsx("p", { className: "text-sm text-slate-300", children: "No room register yet." }), _jsx("p", { className: "mt-1 text-xs text-slate-500", children: "The imported reports only carry daily totals, so the per-room board needs a room register to render. Create one from this property's inventory to begin." }), _jsx("button", { onClick: handleBootstrap, className: "mt-4 rounded-lg bg-[#6C63FF] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#5b52e8]", children: isPortfolio ? "Select a single property first" : `Create ${num(inventory)}-room register` })] })) : (_jsx("div", { className: "grid gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6", children: tiles.map((t, index) => {
                            const s = KIND_STYLE[t.kind] || KIND_STYLE.available;
                            return (_jsxs(motion.div, { initial: { opacity: 0, scale: 0.95 }, animate: { opacity: 1, scale: 1 }, transition: { delay: index * 0.015, duration: 0.2 }, whileHover: { scale: 1.03 }, className: "group relative rounded-xl border p-2.5 transition-all", style: { borderColor: `${s.color}44`, background: `${s.color}14` }, title: `${t.room_number} · ${s.label}${t.guest_name ? " · " + t.guest_name : ""}`, children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsx("span", { className: "font-heading text-sm font-semibold text-white", children: t.room_number }), _jsx("span", { className: "h-2 w-2 rounded-full", style: { background: s.color } })] }), _jsx("p", { className: "mt-1 truncate text-xs text-slate-300", children: t.guest_name || s.label }), _jsxs("p", { className: "truncate text-[10px] text-slate-500", children: [t.room_type, t.floor ? ` · Fl ${t.floor}` : ""] }), t.kind === "occupied" && (_jsxs("p", { className: "mt-0.5 truncate text-[10px] text-[#00E096]", children: [money(t.rate_cents), t.check_out ? ` → ${t.check_out}` : ""] })), !isPortfolio && pricingEnabled && !t.guest_name && (_jsxs("p", { className: "mt-0.5 truncate text-[10px] text-[#6C63FF]", children: ["Suggested ", money2(recommendedByType[t.room_type]?.recommendedCents || 0)] })), !isPortfolio && pricingEnabled && t.guest_name && recommendedByType[t.room_type] && (_jsxs("p", { className: "mt-0.5 truncate text-[10px] text-slate-500", children: ["vs rec ", money2(recommendedByType[t.room_type].recommendedCents)] })), !isPortfolio && (_jsx("div", { className: "mt-1.5 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100", children: ["available", "dirty", "out_of_service"].map((st) => (_jsx("button", { onClick: () => handleRoomState(t.roomId || t.id, st), className: "flex-1 rounded bg-white/10 px-1 py-0.5 text-[9px] text-slate-300 hover:bg-white/20", children: st === "out_of_service" ? "OOS" : st[0].toUpperCase() }, st))) }))] }, t.room_number));
                        }) })), rooms.length > 0 && dayStats.soldCount > 0 && (_jsxs("div", { className: "mt-4 border-t border-white/5 pt-3 text-xs text-slate-400", children: [_jsx("span", { className: "font-semibold text-white", children: money(dayStats.revenueCents) }), " night revenue \u00B7", " ", _jsx("span", { className: "font-semibold text-white", children: money2(dayStats.adrCents) }), " ADR on ", num(dayStats.soldCount), " room", dayStats.soldCount === 1 ? "" : "s", " \u00B7 ", pct(dayStats.occupancy), " occupancy on ", boardDate] }))] }), _jsx(Card, { title: "Upcoming Channel Reservations", subtitle: "Reservations synced from OTAs (Booking.com, Expedia, etc.)", children: reservationsLoading ? (_jsx("p", { className: "text-sm text-slate-500", children: "Loading reservations..." })) : reservations.length === 0 ? (_jsxs("div", { className: "rounded-xl border border-white/5 bg-[#0A1628]/40 p-6 text-center", children: [_jsx("p", { className: "text-sm text-slate-300", children: "No upcoming reservations found." }), _jsx("p", { className: "mt-1 text-xs text-slate-500", children: "Go to the Channel Manager module to sync reservations from your connected OTAs." })] })) : (_jsx("div", { className: "overflow-x-auto", children: _jsxs("table", { className: "w-full text-left text-sm text-slate-300", children: [_jsx("thead", { className: "border-b border-white/10 text-xs uppercase text-slate-500", children: _jsxs("tr", { children: [_jsx("th", { className: "px-4 py-3 font-medium", children: "Channel" }), _jsx("th", { className: "px-4 py-3 font-medium", children: "Conf #" }), _jsx("th", { className: "px-4 py-3 font-medium", children: "Check-In" }), _jsx("th", { className: "px-4 py-3 font-medium", children: "Check-Out" }), _jsx("th", { className: "px-4 py-3 font-medium", children: "Room Type" }), _jsx("th", { className: "px-4 py-3 font-medium text-right", children: "Status" })] }) }), _jsx("tbody", { className: "divide-y divide-white/5", children: _jsx(AnimatePresence, { children: reservations.map((res, index) => (_jsxs(motion.tr, { initial: { opacity: 0, x: -10 }, animate: { opacity: 1, x: 0 }, transition: { delay: index * 0.05 }, className: "transition-colors hover:bg-white/[0.02]", children: [_jsx("td", { className: "px-4 py-3", children: _jsx("span", { className: "inline-flex items-center gap-1.5 rounded-full bg-white/5 px-2.5 py-1 text-xs font-medium text-white", children: res.channel === "Booking.com" ? "B.com" : res.channel }) }), _jsx("td", { className: "px-4 py-3 font-mono text-xs", children: res.confirmation_num }), _jsx("td", { className: "px-4 py-3", children: res.check_in }), _jsx("td", { className: "px-4 py-3", children: res.check_out }), _jsx("td", { className: "px-4 py-3", children: res.room_type_id }), _jsx("td", { className: "px-4 py-3 text-right", children: _jsx("span", { className: `inline-flex rounded-md px-2 py-1 text-[10px] font-semibold uppercase tracking-wider ${res.status === 'Confirmed' ? 'bg-green-500/10 text-green-400' : 'bg-slate-500/10 text-slate-400'}`, children: res.status }) })] }, res.id))) }) })] }) })) }), _jsx(Card, { title: "Check in a guest", subtitle: "Add a per-room stay for the selected night (rate stored in integer cents)", children: _jsxs("form", { onSubmit: handleAddStay, className: "grid gap-3 sm:grid-cols-2 lg:grid-cols-6", children: [_jsxs("label", { className: "flex flex-col gap-1 text-xs text-slate-400", children: ["Room", _jsxs("select", { value: newRoom, onChange: (e) => setNewRoom(e.target.value), className: "rounded-lg border border-white/10 bg-[#0A1628] px-2 py-2 text-sm text-white", children: [_jsx("option", { value: "", children: "Select room" }), rooms.map((r) => (_jsx("option", { value: r.room_number, children: r.room_number }, r.id)))] })] }), _jsxs("label", { className: "flex flex-col gap-1 text-xs text-slate-400", children: ["Guest name", _jsx("input", { value: newGuest, onChange: (e) => setNewGuest(e.target.value), className: "rounded-lg border border-white/10 bg-[#0A1628] px-2 py-2 text-sm text-white" })] }), _jsxs("label", { className: "flex flex-col gap-1 text-xs text-slate-400", children: ["Check-in", _jsx("input", { type: "date", value: newIn, onChange: (e) => setNewIn(e.target.value), className: "rounded-lg border border-white/10 bg-[#0A1628] px-2 py-2 text-sm text-white" })] }), _jsxs("label", { className: "flex flex-col gap-1 text-xs text-slate-400", children: ["Check-out", _jsx("input", { type: "date", value: newOut, onChange: (e) => setNewOut(e.target.value), className: "rounded-lg border border-white/10 bg-[#0A1628] px-2 py-2 text-sm text-white" })] }), _jsxs("label", { className: "flex flex-col gap-1 text-xs text-slate-400", children: ["Rate ($)", _jsx("input", { type: "number", min: "0", step: "0.01", value: newRate, onChange: (e) => setNewRate(e.target.value), className: "rounded-lg border border-white/10 bg-[#0A1628] px-2 py-2 text-sm text-white" }), suggestedForRoom && (_jsxs("div", { className: "mt-1 rounded-md border border-[#6C63FF]/20 bg-[#6C63FF]/5 px-2 py-1.5 text-xs", children: [_jsx("span", { className: "text-slate-400", children: "Suggested: " }), _jsx("span", { className: "font-medium text-[#6C63FF]", children: money2(suggestedForRoom.recommendedCents) }), _jsxs("span", { className: "text-slate-500", children: [" \u00B7 occ ", Math.round(suggestedForRoom.occupancy * 100), "% \u2192 ", Math.round((suggestedForRoom.multiplierBps / 10000) * 100), "\u00D7 base"] })] }))] }), _jsx("button", { type: "submit", className: "self-end rounded-lg bg-[#6C63FF] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#5b52e8] disabled:opacity-50", disabled: !singlePropertyId, children: "Check In" })] }) }), !occ.length ? (_jsx(Card, { title: "No occupancy data", children: _jsxs("p", { className: "text-sm text-slate-400", children: ["Import an Occupancy report for ", dateRange.from || "this range", " \u2192 ", dateRange.to || "", " to populate the aggregate summary below."] }) })) : (_jsxs(_Fragment, { children: [_jsx("div", { className: "grid gap-4 sm:grid-cols-3 lg:grid-cols-5", children: [
                            ["Avg Occupied", num(stats.avgOccupied), C.purple],
                            ["Avg Vacant", num(stats.avgVacant), C.green],
                            ["Avg Out of Service", num(stats.avgOoo), C.coral],
                            ["Occupancy", pct(stats.occupancy), C.cyan],
                            ["ADR", money2(stats.adr), C.amber],
                        ].map(([label, value, color]) => (_jsxs("div", { className: "rounded-2xl border border-white/5 bg-[#0F1F35]/80 p-4", children: [_jsx("p", { className: "text-[11px] uppercase tracking-widest text-slate-400", children: label }), _jsx("p", { className: "mt-2 font-heading text-2xl font-semibold", style: { color: String(color) }, children: value })] }, label))) }), stats.downNights > 0 && (_jsxs(Card, { title: "Revenue lost to out-of-service rooms", children: [_jsxs("p", { className: "text-sm text-slate-300", children: [_jsx("span", { className: "font-heading text-2xl font-semibold", style: { color: C.coral }, children: money(stats.oooLoss) }), " ", "of room revenue was unavailable to sell across this period."] }), _jsxs("p", { className: "mt-2 text-sm text-slate-400", children: [num(stats.downNights), " out-of-service room-night", stats.downNights === 1 ? "" : "s", " at the", " ", money2(stats.adr), " ADR actually achieved \u2014 the revenue those rooms would have earned at your own average rate."] })] })), _jsxs(Card, { title: `Average room mix · ${stats.days}-day average`, subtitle: "Share of physical inventory by state, averaged across the selected period", children: [_jsx("div", { className: "flex h-8 w-full overflow-hidden rounded-lg", children: mix.map(([label, value, color]) => (_jsx("div", { title: `${label}: ${value} rooms`, className: "flex items-center justify-center text-[10px] font-medium text-white/90", style: { width: `${(Number(value) / mixTotal) * 100}%`, background: `${color}66`, borderRight: "1px solid #0F1F35" }, children: (Number(value) / mixTotal) > 0.08 ? value : "" }, label))) }), _jsx("div", { className: "mt-3 flex flex-wrap gap-4", children: mix.map(([label, value, color]) => (_jsxs("span", { className: "flex items-center gap-2 text-xs text-slate-400", children: [_jsx("span", { className: "h-2.5 w-2.5 rounded-sm", style: { background: String(color) } }), label, " \u00B7 ", num(value), " (", pct(Number(value) / mixTotal), ")"] }, label))) })] })] }))] }));
}
