import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { db } from '@/api/base44Client';
import React, { useState, useMemo, useRef, useCallback, useEffect } from "react";
import { Plus, Trash2, Save, Upload, Download, Undo2, Redo2, Search, Table2, FileSpreadsheet } from "lucide-react";
import Card from "@/components/ui-exec/Card";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useGlobalFilters } from "@/lib/useGlobalFilters";
import { downloadCsv, downloadExcel } from "@/lib/hotel";
import ResponsiveSelect from "@/components/ui/ResponsiveSelect";
import { getCsrfToken, sensitiveActionRateLimiter, validateCsrfToken, rotateCsrfToken } from "@/lib/securityUtils";
const REPORT_CONFIGS = {
    occupancy: {
        label: "Occupancy Summary",
        entity: "OccupancyDay",
        fields: [
            { key: "date", label: "Date", type: "date", width: "120px" },
            { key: "day_of_week", label: "Day", type: "text", width: "80px" },
            { key: "room_revenue", label: "Room Rev", type: "number", width: "100px" },
            { key: "other_room_revenue", label: "Other Rev", type: "number", width: "100px" },
            { key: "total_revenue", label: "Total Rev", type: "number", width: "100px" },
            { key: "total_rooms", label: "Rooms", type: "number", width: "70px" },
            { key: "rooms_sold", label: "Sold", type: "number", width: "70px" },
            { key: "comp_rooms", label: "Comp", type: "number", width: "60px" },
            { key: "down_rooms", label: "Down", type: "number", width: "60px" },
            { key: "vacant_rooms", label: "Vacant", type: "number", width: "70px" },
            { key: "no_shows", label: "NoShow", type: "number", width: "70px" },
            { key: "cancellations", label: "Cancel", type: "number", width: "70px" },
            { key: "total_guests", label: "Guests", type: "number", width: "70px" },
            { key: "adr", label: "ADR", type: "number", width: "80px" },
            { key: "occupancy", label: "Occ%", type: "number", width: "70px" },
            { key: "revpar", label: "RevPAR", type: "number", width: "80px" },
        ],
    },
    gross: {
        label: "Gross Revenue",
        entity: "GrossRevenueDay",
        fields: [
            { key: "date", label: "Date", type: "date", width: "120px" },
            { key: "day_of_week", label: "Day", type: "text", width: "80px" },
            { key: "room_rent", label: "Room Rent", type: "number", width: "100px" },
            { key: "misc_charge", label: "Misc", type: "number", width: "80px" },
            { key: "system_charge", label: "System", type: "number", width: "80px" },
            { key: "food", label: "Food", type: "number", width: "70px" },
            { key: "bar", label: "Bar", type: "number", width: "70px" },
            { key: "beverage", label: "Bev", type: "number", width: "70px" },
            { key: "laundry", label: "Laundry", type: "number", width: "70px" },
            { key: "phone", label: "Phone", type: "number", width: "70px" },
            { key: "other", label: "Other", type: "number", width: "70px" },
            { key: "state_tax", label: "State Tax", type: "number", width: "90px" },
            { key: "city_tax", label: "City Tax", type: "number", width: "90px" },
            { key: "other_tax", label: "Other Tax", type: "number", width: "90px" },
            { key: "advance_deposit", label: "Deposit", type: "number", width: "90px" },
        ],
    },
    source: {
        label: "Source / Channel",
        entity: "SourceDay",
        fields: [
            { key: "date", label: "Date", type: "date", width: "120px" },
            { key: "source", label: "Source", type: "text", width: "140px" },
            { key: "code", label: "Code", type: "text", width: "70px" },
            { key: "net_revenue", label: "Revenue", type: "number", width: "100px" },
            { key: "stays", label: "Stays", type: "number", width: "70px" },
            { key: "adr", label: "ADR", type: "number", width: "80px" },
        ],
    },
    payment: {
        label: "Payment Methods",
        entity: "PaymentDay",
        fields: [
            { key: "date", label: "Date", type: "date", width: "120px" },
            { key: "day_of_week", label: "Day", type: "text", width: "80px" },
            { key: "cash", label: "Cash", type: "number", width: "80px" },
            { key: "visa", label: "Visa", type: "number", width: "80px" },
            { key: "master", label: "MC", type: "number", width: "80px" },
            { key: "amex", label: "Amex", type: "number", width: "80px" },
            { key: "discover", label: "Disc", type: "number", width: "80px" },
            { key: "check", label: "Check", type: "number", width: "80px" },
            { key: "wire_transfer", label: "Wire", type: "number", width: "80px" },
            { key: "direct_bill", label: "Direct", type: "number", width: "80px" },
            { key: "other", label: "Other", type: "number", width: "80px" },
            { key: "total", label: "Total", type: "number", width: "90px" },
        ],
    },
};
function useManualEntries(reportType, propertyId) {
    return useQuery({
        queryKey: ["manual-entries", reportType, propertyId],
        queryFn: async () => {
            const config = REPORT_CONFIGS[reportType];
            if (!config)
                return [];
            const filter = { report_type: "manual_entry" };
            if (propertyId && propertyId !== "all") {
                if (Array.isArray(propertyId))
                    filter.property_id = { $in: propertyId };
                else
                    filter.property_id = propertyId;
            }
            return db.entities[config.entity].filter(filter, "-date", 100000);
        },
    });
}
export default function ManualEntry() {
    const { property, properties, accessibleProperties } = useGlobalFilters();
    const qc = useQueryClient();
    const [reportType, setReportType] = useState("occupancy");
    const [search, setSearch] = useState("");
    const [rows, setRows] = useState([]);
    const [history, setHistory] = useState([]);
    const [historyIndex, setHistoryIndex] = useState(-1);
    const [hasDraft, setHasDraft] = useState(false);
    const [saving, setSaving] = useState(false);
    const [saveMsg, setSaveMsg] = useState("");
    const fileInputRef = useRef(null);
    const [draftKey, setDraftKey] = useState("");
    const [draftToRecover, setDraftToRecover] = useState(null);
    // When property/reportType changes, evaluate draft
    useEffect(() => {
        const propId = Array.isArray(property) ? property[0] : property;
        if (!propId)
            return;
        const key = `manual_draft_${propId}_${reportType}`;
        setDraftKey(key);
        const saved = localStorage.getItem(key);
        if (saved) {
            try {
                const parsed = JSON.parse(saved);
                if (Array.isArray(parsed) && parsed.length > 0) {
                    setDraftToRecover(parsed);
                }
                else {
                    localStorage.removeItem(key);
                    setDraftToRecover(null);
                }
            }
            catch (e) {
                localStorage.removeItem(key);
                setDraftToRecover(null);
            }
        }
        else {
            setDraftToRecover(null);
        }
    }, [property, reportType]);
    // Auto-save logic
    useEffect(() => {
        if (!draftKey)
            return;
        if (hasDraft && rows.length > 0) {
            try {
                localStorage.setItem(draftKey, JSON.stringify(rows));
            }
            catch (e) {
                console.warn("Auto-save failed", e);
            }
        }
    }, [rows, hasDraft, draftKey]);
    const handleDiscardDraft = () => {
        if (draftKey)
            localStorage.removeItem(draftKey);
        setDraftToRecover(null);
    };
    const handleResumeDraft = () => {
        if (draftToRecover) {
            setRows(draftToRecover);
            setHistory([JSON.parse(JSON.stringify(draftToRecover))]);
            setHistoryIndex(0);
            setHasDraft(true);
            setDraftToRecover(null);
        }
    };
    const config = REPORT_CONFIGS[reportType];
    const selectedProperty = properties.find((p) => p.id === (Array.isArray(property) ? property[0] : property));
    const { data: existing = [] } = useManualEntries(reportType, property);
    const propertyOpts = (accessibleProperties.length ? accessibleProperties : properties).map((p) => [p.id, p.name]);
    const pushHistory = useCallback((newRows) => {
        setHistory((prev) => {
            const next = prev.slice(0, historyIndex + 1);
            next.push(JSON.parse(JSON.stringify(newRows)));
            return next.slice(-50);
        });
        setHistoryIndex((prev) => prev + 1);
    }, [historyIndex]);
    const loadFromExisting = useCallback(() => {
        const mapped = existing.map((r) => ({ ...r, _id: r.id }));
        setRows(mapped);
        setHistory([JSON.parse(JSON.stringify(mapped))]);
        setHistoryIndex(0);
        setHasDraft(false);
    }, [existing]);
    const initEmpty = useCallback(() => {
        const today = new Date().toISOString().slice(0, 10);
        const newRow = {};
        config.fields.forEach((f) => {
            if (f.type === "date")
                newRow[f.key] = today;
            else if (f.type === "number")
                newRow[f.key] = 0;
            else
                newRow[f.key] = "";
        });
        newRow._isNew = true;
        const initial = [newRow];
        setRows(initial);
        setHistory([JSON.parse(JSON.stringify(initial))]);
        setHistoryIndex(0);
        setHasDraft(false);
    }, [config]);
    const handleAddRow = () => {
        const today = new Date().toISOString().slice(0, 10);
        const newRow = {};
        config.fields.forEach((f) => {
            if (f.type === "date")
                newRow[f.key] = today;
            else if (f.type === "number")
                newRow[f.key] = 0;
            else
                newRow[f.key] = "";
        });
        newRow._isNew = true;
        const newRows = [...rows, newRow];
        setRows(newRows);
        pushHistory(newRows);
        setHasDraft(true);
    };
    const handleDeleteRow = (idx) => {
        const newRows = rows.filter((_, i) => i !== idx);
        setRows(newRows);
        pushHistory(newRows);
        setHasDraft(true);
    };
    const handleCellChange = (rowIdx, fieldKey, value) => {
        const newRows = [...rows];
        newRows[rowIdx] = { ...newRows[rowIdx], [fieldKey]: value };
        setRows(newRows);
        setHasDraft(true);
    };
    const handleUndo = () => {
        if (historyIndex > 0) {
            setHistoryIndex(historyIndex - 1);
            setRows(JSON.parse(JSON.stringify(history[historyIndex - 1])));
        }
    };
    const handleRedo = () => {
        if (historyIndex < history.length - 1) {
            setHistoryIndex(historyIndex + 1);
            setRows(JSON.parse(JSON.stringify(history[historyIndex + 1])));
        }
    };
    const handlePaste = (e) => {
        e.preventDefault();
        const text = e.clipboardData.getData("text");
        const lines = text.split("\n").filter((l) => l.trim());
        const pastedRows = lines.map((line) => {
            const cells = line.split("\t");
            const row = {};
            config.fields.forEach((f, i) => {
                row[f.key] = cells[i] || (f.type === "number" ? 0 : "");
            });
            row._isNew = true;
            return row;
        });
        const newRows = [...rows, ...pastedRows];
        setRows(newRows);
        pushHistory(newRows);
        setHasDraft(true);
    };
    const handleImportFile = async (e) => {
        const file = e.target.files?.[0];
        if (!file)
            return;
        const text = await file.text();
        const lines = text.split("\n").filter((l) => l.trim());
        if (!lines.length)
            return;
        const headers = lines[0].split(",").map((h) => h.trim().replace(/"/g, ""));
        const importedRows = lines.slice(1).map((line) => {
            const cells = line.split(",").map((c) => c.trim().replace(/"/g, ""));
            const row = {};
            config.fields.forEach((f) => {
                const idx = headers.indexOf(f.key);
                row[f.key] = idx >= 0 ? cells[idx] : (f.type === "number" ? 0 : "");
            });
            row._isNew = true;
            return row;
        });
        const newRows = [...rows, ...importedRows];
        setRows(newRows);
        pushHistory(newRows);
        setHasDraft(true);
    };
    const handleExport = (type = 'csv') => {
        const exportRows = rows.map((r) => {
            const out = {};
            config.fields.forEach((f) => { out[f.key] = r[f.key] || ""; });
            return out;
        });
        if (type === 'excel') {
            downloadExcel(exportRows, `manual_${reportType}_${Date.now()}.xlsx`);
        }
        else {
            downloadCsv(exportRows, `manual_${reportType}_${Date.now()}.csv`);
        }
    };
    const handleSave = async () => {
        // Rate limiting for sensitive actions
        const rateLimit = sensitiveActionRateLimiter.check();
        if (!rateLimit.allowed) {
            setSaveMsg(`Rate limited. Try again in ${Math.ceil(rateLimit.retryAfter / 60)} minutes.`);
            setSaving(false);
            return;
        }
        // CSRF validation
        const csrfToken = getCsrfToken();
        if (!validateCsrfToken(csrfToken)) {
            setSaveMsg("Invalid security token. Please refresh the page and try again.");
            rotateCsrfToken();
            setSaving(false);
            return;
        }
        setSaving(true);
        setSaveMsg("");
        const prop = selectedProperty || properties[0];
        if (!prop) {
            setSaveMsg("Select a property first.");
            setSaving(false);
            return;
        }
        // Enforce property access: a restricted user can only save to their own properties.
        const allowedIds = accessibleProperties.length ? new Set(accessibleProperties.map((p) => String(p.id))) : null;
        if (allowedIds && !allowedIds.has(String(prop.id))) {
            setSaveMsg("You do not have access to the selected property.");
            setSaving(false);
            return;
        }
        const meta = {
            property_id: prop.id,
            property_name: prop.name,
            import_id: `manual_${Date.now()}`,
            source_file: `Manual Entry by ${prop.name}`,
            report_type: "manual_entry",
        };
        const entityName = config.entity;
        // Build the dedupe key the same way report imports do so manual rows never
        // double-count against imported report rows.
        const dedupeKey = (rec) => {
            if (reportType === "source")
                return `${rec.property_id}|${rec.date}|${rec.code || rec.source}`;
            return `${rec.property_id}|${rec.date}`;
        };
        const existingKeys = new Set(existing.map(dedupeKey));
        // Validate rows before writing anything.
        const errors = [];
        const prepared = [];
        for (const row of rows) {
            if (!row.date && !row.shift_date)
                continue;
            const rawDate = String(row.date || row.shift_date || "").trim();
            if (rawDate && !/^\d{4}-\d{2}-\d{2}/.test(rawDate)) {
                errors.push(`"${rawDate}" is not a valid date (use YYYY-MM-DD)`);
                continue;
            }
            const record = {};
            for (const f of config.fields) {
                const val = row[f.key];
                if (val !== undefined && val !== "") {
                    if (f.type === "number") {
                        const n = Number(val);
                        if (Number.isNaN(n)) {
                            errors.push(`${f.label} must be a number`);
                            continue;
                        }
                        // Reject negative currency/count figures so balances can't be
                        // silently inflated (vacancy, rooms, revenue, payments, taxes).
                        if (f.key !== "closed_balance_folio" && f.key !== "loyalty_discount" && n < 0) {
                            errors.push(`${f.label} must be 0 or greater`);
                            continue;
                        }
                        let use = n;
                        if (reportType === "occupancy" && f.key === "occupancy" && use > 1)
                            use = use / 100;
                        record[f.key] = use;
                    }
                    else {
                        record[f.key] = val;
                    }
                }
            }
            Object.assign(record, meta);
            prepared.push({ row, record });
        }
        if (errors.length) {
            setSaveMsg(`Not saved — ${errors[0]}${errors.length > 1 ? ` (+${errors.length - 1} more)` : ""}`);
            setSaving(false);
            rotateCsrfToken();
            return;
        }
        let saved = 0;
        let skipped = 0;
        for (const { row, record } of prepared) {
            if (!row._id && existingKeys.has(dedupeKey(record))) {
                skipped++; // already present via a prior import or manual save
                continue;
            }
            if (row._id) {
                await db.entities[entityName].update(row._id, record);
            }
            else {
                await db.entities[entityName].create(record);
            }
            existingKeys.add(dedupeKey(record));
            saved++;
        }
        qc.invalidateQueries({ queryKey: ["manual-entries"] });
        qc.invalidateQueries({ queryKey: ["occupancy"] });
        qc.invalidateQueries({ queryKey: ["payments"] });
        qc.invalidateQueries({ queryKey: ["gross"] });
        qc.invalidateQueries({ queryKey: ["sources"] });
        const extra = skipped ? ` · ${skipped} duplicate${skipped === 1 ? "" : "s"} skipped` : "";
        setSaveMsg(`${saved} records saved. All dashboards updated.${extra}`);
        setHasDraft(false);
        if (draftKey)
            localStorage.removeItem(draftKey);
        setSaving(false);
        rotateCsrfToken();
    };
    const filteredRows = useMemo(() => {
        if (!search.trim())
            return rows;
        const s = search.toLowerCase();
        return rows.filter((r) => Object.values(r).some((v) => String(v || "").toLowerCase().includes(s)));
    }, [rows, search]);
    return (_jsxs("div", { className: "space-y-4", children: [_jsxs("header", { children: [_jsx("p", { className: "text-[11px] uppercase tracking-[0.3em] text-[#00D4FF]", children: "Module 8" }), _jsx("h1", { className: "mt-2 font-heading text-3xl font-semibold text-white", children: "Manual Data Entry" }), _jsx("p", { className: "mt-1 text-sm text-slate-400", children: "Edit hotel data in a spreadsheet grid. All changes update dashboards, charts, and KPIs automatically." })] }), draftToRecover && (_jsx(Card, { className: "border-amber-500/50 bg-amber-500/10", children: _jsxs("div", { className: "flex items-center justify-between", children: [_jsxs("div", { children: [_jsx("h3", { className: "font-medium text-amber-500", children: "Unsaved Draft Recovered" }), _jsx("p", { className: "text-sm text-slate-300", children: "You have an auto-saved draft for this property and report type." })] }), _jsxs("div", { className: "flex gap-3", children: [_jsx("button", { onClick: handleDiscardDraft, className: "text-sm text-slate-400 hover:text-white", children: "Discard" }), _jsx("button", { onClick: handleResumeDraft, className: "rounded-md bg-amber-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-600", children: "Resume Draft" })] })] }) })), _jsx(Card, { title: "Configuration", subtitle: "Select property, report type, and date", children: _jsxs("div", { className: "grid gap-3 sm:grid-cols-3", children: [_jsxs("div", { children: [_jsx("label", { className: "mb-1.5 block text-xs text-slate-400", children: "Property" }), _jsx(ResponsiveSelect, { value: Array.isArray(property) ? property[0] : property, onValueChange: (v) => { }, options: propertyOpts, placeholder: "Select property\u2026" })] }), _jsxs("div", { children: [_jsx("label", { className: "mb-1.5 block text-xs text-slate-400", children: "Report Type" }), _jsx(ResponsiveSelect, { value: reportType, onValueChange: (v) => { setReportType(v); setRows([]); }, options: Object.entries(REPORT_CONFIGS).map(([k, c]) => [k, c.label]) })] }), _jsxs("div", { className: "flex items-end gap-2", children: [_jsxs("button", { onClick: initEmpty, className: "flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-2 text-xs text-slate-200 hover:border-[#00D4FF]/30", children: [_jsx(Plus, { className: "h-3.5 w-3.5" }), " New Grid"] }), _jsxs("button", { onClick: loadFromExisting, className: "flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-2 text-xs text-slate-200 hover:border-[#00D4FF]/30", children: [_jsx(Table2, { className: "h-3.5 w-3.5" }), " Load Existing"] })] })] }) }), rows.length > 0 && (_jsx(_Fragment, { children: _jsxs(Card, { title: `${config.label} — Spreadsheet Editor`, subtitle: `${rows.length} rows · ${config.fields.length} columns`, right: _jsxs("div", { className: "flex items-center gap-1", children: [_jsx("button", { onClick: handleUndo, disabled: historyIndex <= 0, className: "rounded-lg border border-white/10 p-2 text-slate-300 hover:border-[#00D4FF]/30 disabled:opacity-30", title: "Undo", children: _jsx(Undo2, { className: "h-4 w-4" }) }), _jsx("button", { onClick: handleRedo, disabled: historyIndex >= history.length - 1, className: "rounded-lg border border-white/10 p-2 text-slate-300 hover:border-[#00D4FF]/30 disabled:opacity-30", title: "Redo", children: _jsx(Redo2, { className: "h-4 w-4" }) }), _jsx("button", { onClick: () => fileInputRef.current?.click(), className: "rounded-lg border border-white/10 p-2 text-slate-300 hover:border-[#00D4FF]/30", title: "Import CSV", children: _jsx(Upload, { className: "h-4 w-4" }) }), _jsx("button", { onClick: () => handleExport('csv'), className: "rounded-lg border border-white/10 p-2 text-[#6C63FF] hover:border-[#6C63FF]/30", title: "Export CSV", children: _jsx(Download, { className: "h-4 w-4" }) }), _jsx("button", { onClick: () => handleExport('excel'), className: "rounded-lg border border-white/10 p-2 text-[#107C41] hover:border-[#107C41]/30", title: "Export Excel", children: _jsx(Download, { className: "h-4 w-4" }) }), _jsx("input", { ref: fileInputRef, type: "file", accept: ".csv", className: "hidden", onChange: handleImportFile })] }), children: [_jsxs("div", { className: "mb-3 flex items-center gap-2", children: [_jsx(Search, { className: "h-4 w-4 text-slate-500" }), _jsx("input", { type: "text", value: search, onChange: (e) => setSearch(e.target.value), placeholder: "Search rows\u2026", className: "w-full rounded-lg border border-white/10 bg-[#0A1628] px-3 py-1.5 text-sm text-slate-200 outline-none focus:border-[#00D4FF]" })] }), _jsx("div", { className: "overflow-x-auto rounded-xl border border-white/5", onPaste: handlePaste, children: _jsxs("table", { className: "w-full border-collapse text-sm", children: [_jsx("thead", { children: _jsxs("tr", { className: "bg-[#0A1628] text-left", children: [_jsx("th", { className: "border-r border-white/5 px-2 py-2 text-[10px] uppercase text-slate-500", style: { width: "40px" }, children: "#" }), config.fields.map((f) => (_jsx("th", { className: "border-r border-white/5 px-2 py-2 text-[10px] uppercase text-slate-400", style: { minWidth: f.width }, children: f.label }, f.key))), _jsx("th", { className: "px-2 py-2", style: { width: "40px" } })] }) }), _jsx("tbody", { children: filteredRows.map((row, rowIdx) => (_jsxs("tr", { className: "border-t border-white/5 hover:bg-white/[0.02]", children: [_jsx("td", { className: "border-r border-white/5 px-2 py-1 text-center text-[10px] text-slate-600", children: rowIdx + 1 }), config.fields.map((f) => (_jsx("td", { className: "border-r border-white/5 px-0 py-0", children: _jsx("input", { type: f.type === "number" ? "number" : f.type === "date" ? "date" : "text", value: row[f.key] ?? "", onChange: (e) => handleCellChange(rowIdx, f.key, e.target.value), className: "w-full bg-transparent px-2 py-1.5 text-xs text-slate-200 outline-none focus:bg-[#6C63FF]/10 focus:outline", style: { minWidth: f.width } }) }, f.key))), _jsx("td", { className: "px-2 py-1", children: _jsx("button", { onClick: () => handleDeleteRow(rowIdx), className: "text-slate-500 hover:text-[#FF6B6B]", children: _jsx(Trash2, { className: "h-3.5 w-3.5" }) }) })] }, rowIdx))) })] }) }), _jsxs("div", { className: "mt-3 flex items-center justify-between", children: [_jsxs("button", { onClick: handleAddRow, className: "flex items-center gap-1.5 rounded-lg border border-dashed border-white/10 px-3 py-2 text-xs text-slate-300 hover:border-[#00D4FF]/30", children: [_jsx(Plus, { className: "h-3.5 w-3.5" }), " Add Row"] }), _jsxs("div", { className: "flex items-center gap-3", children: [hasDraft && _jsx("span", { className: "text-xs text-[#FFB547]", children: "\u25CF Unsaved draft" }), saveMsg && _jsx("span", { className: "text-xs text-[#00E096]", children: saveMsg }), _jsxs("button", { onClick: handleSave, disabled: saving || !hasDraft, className: "flex items-center gap-1.5 rounded-lg bg-[#00E096] px-4 py-2 text-sm font-medium text-[#040D1A] hover:bg-[#00c885] disabled:opacity-50", children: [_jsx(Save, { className: "h-4 w-4" }), " ", saving ? "Saving…" : "Save & Update Dashboards"] })] })] })] }) })), rows.length === 0 && (_jsx(Card, { children: _jsxs("div", { className: "flex flex-col items-center justify-center py-12 text-center", children: [_jsx(FileSpreadsheet, { className: "h-12 w-12 text-slate-600" }), _jsx("p", { className: "mt-3 text-sm text-slate-400", children: "No data in the grid yet." }), _jsxs("div", { className: "mt-4 flex gap-2", children: [_jsxs("button", { onClick: initEmpty, className: "flex items-center gap-1.5 rounded-lg bg-[#6C63FF] px-4 py-2 text-sm font-medium text-white hover:bg-[#5b52e8]", children: [_jsx(Plus, { className: "h-4 w-4" }), " Start New Grid"] }), existing.length > 0 && (_jsxs("button", { onClick: loadFromExisting, className: "flex items-center gap-1.5 rounded-lg border border-white/10 px-4 py-2 text-sm text-slate-200 hover:border-[#00D4FF]/30", children: [_jsx(Table2, { className: "h-4 w-4" }), " Load ", existing.length, " Existing Records"] }))] }), _jsx("p", { className: "mt-4 text-xs text-slate-500", children: "Tip: You can paste data directly from Excel (Ctrl+V) into the grid." })] }) })), existing.length > 0 && (_jsx(Card, { title: "Existing Manual Entries", subtitle: `${existing.length} records marked as manual entry`, children: _jsx("div", { className: "max-h-60 overflow-auto space-y-1", children: existing.slice(0, 50).map((r) => (_jsxs("div", { className: "flex items-center justify-between rounded-lg border border-white/5 bg-[#0A1628]/60 px-3 py-2 text-xs", children: [_jsx("span", { className: "text-slate-300", children: String(r.date || r.shift_date || "").slice(0, 10) }), _jsx("span", { className: "text-slate-500", children: r.source_file || "Manual" }), _jsx("span", { className: "text-slate-500", children: String(r.created_date || "").slice(0, 10) })] }, r.id))) }) }))] }));
}
