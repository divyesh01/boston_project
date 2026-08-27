import { db } from '@/api/base44Client';

import React, { useState, useMemo, useRef, useCallback, useEffect } from "react";
import { Plus, Trash2, Save, Upload, Download, Undo2, Redo2, Search, Table2, FileSpreadsheet } from "lucide-react";
import Card from "@/components/ui-exec/Card";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useGlobalFilters } from "@/lib/useGlobalFilters";
import { downloadCsv, downloadExcel, stampFilename } from "@/lib/exportData";
import ResponsiveSelect from "@/components/ui/ResponsiveSelect";
import { ErrorState } from "@/components/ui/status";
import { getCsrfToken, sensitiveActionRateLimiter, validateCsrfToken, rotateCsrfToken } from "@/lib/securityUtils";
import { parseManualEntryCsv, parseManualEntryPaste } from "@/lib/manualEntryImport";
import { saveManualRows } from "@/lib/manualEntrySave";
import { draftKeyFor, readDraft, writeDraft, clearDraft } from "@/lib/manualDraft";
import { MAX_IMPORT_BYTES } from "@/lib/csvParser";

// An uploaded file is hostile input. MAX_IMPORT_BYTES is imported from csvParser —
// the single source of truth the report-import path (fetchCsvRows, uploadGuard,
// getRowsArray) also enforces — so every importer refuses the same oversized file
// and the cap can never drift to two different limits on the same upload.

// Colour by severity. Written as a lookup rather than a ternary chain so a new tone
// cannot silently fall through to green, which is how the original single-colour
// message came to render save failures as successes.
const MSG_TONE_CLASS = {
  success: "text-[#00E096]",
  warn: "text-[#FFB547]",
  error: "text-[#FF5C5C]",
};

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
      if (!config) return [];
      const filter = { report_type: "manual_entry" };
      if (propertyId && propertyId !== "all") {
        if (Array.isArray(propertyId)) filter.property_id = { $in: propertyId };
        else filter.property_id = propertyId;
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
  // Severity for the message beside the Save button. It used to render
  // unconditionally in success green (#00E096), so "Not saved — ..." and
  // "You do not have access to the selected property" looked like confirmations.
  const [msgTone, setMsgTone] = useState("success");
  // Per-column and per-cell problems from the last import. Shown in full rather
  // than summarised: a silently blank column is the failure mode being fixed here.
  const [importWarnings, setImportWarnings] = useState([]);
  const fileInputRef = useRef(null);
  
  const [draftKey, setDraftKey] = useState("");
  const [draftToRecover, setDraftToRecover] = useState(null);
  // Which draft key the auto-save failure has already been stated for, so a
  // refused write is reported once instead of on every keystroke.
  const draftWarnedFor = useRef("");

  // When property/reportType changes, evaluate draft
  useEffect(() => {
    const propId = Array.isArray(property) ? property[0] : property;
    if (!propId) return;
    const key = draftKeyFor(propId, reportType);
    setDraftKey(key);
    
    // Every failure here reaches the screen as well as the console. A draft of
    // hand-typed money rows that turned out to be unreadable used to be deleted in
    // silence, and the grid simply came up empty. See src/lib/manualDraft.js.
    const { rows: recoverable, discard, problem } = readDraft(key);
    // The result is deliberately ignored: a draft that cannot be loaded is being
    // removed as cleanup, and if the removal fails the next read reports it again.
    if (discard) clearDraft(key);
    setDraftToRecover(recoverable);
    if (problem) {
      setSaveMsg(problem);
      setMsgTone("error");
      setImportWarnings([problem]);
    }
  }, [property, reportType]);

  // Auto-save. A refused write used to be a console.warn while the page went on
  // rendering its amber "● Unsaved draft" dot, so the operator was told the typed
  // rows were being kept at the exact moment they were not. Reported once per key
  // rather than once per keystroke — this effect runs on every cell edit.
  useEffect(() => {
    if (!draftKey) return;
    if (!hasDraft || rows.length === 0) return;
    const { ok, problem } = writeDraft(draftKey, rows);
    if (ok) {
      draftWarnedFor.current = "";
      return;
    }
    if (draftWarnedFor.current === draftKey) return;
    draftWarnedFor.current = draftKey;
    setSaveMsg(problem);
    setMsgTone("error");
  }, [rows, hasDraft, draftKey]);

  const handleDiscardDraft = () => {
    if (!draftKey) {
      setDraftToRecover(null);
      return;
    }
    const { ok, problem } = clearDraft(draftKey);
    if (!ok) {
      // The draft is still stored, so the recovery banner stays put: Resume still
      // works, and the draft would reappear on the next visit regardless. Closing
      // the banner here would state that it had been discarded when it had not.
      setSaveMsg(problem);
      setMsgTone("error");
      setImportWarnings([problem]);
      return;
    }
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
  // The query OBJECT is kept, not just its data. `existingQ.isError` is what lets
  // handleSave refuse to write when the dedupe list could not load — see the guard
  // there. Defaulting via `?? []` (rather than destructuring `= []`) keeps the
  // failure visible instead of laundering it into an ordinary empty list.
  const existingQ = useManualEntries(reportType, property);
  const existing = existingQ.data ?? [];

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
      if (f.type === "date") newRow[f.key] = today;
      else if (f.type === "number") newRow[f.key] = 0;
      else newRow[f.key] = "";
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
      if (f.type === "date") newRow[f.key] = today;
      else if (f.type === "number") newRow[f.key] = 0;
      else newRow[f.key] = "";
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

  // Both import paths funnel through src/lib/manualEntryImport.js, which is covered
  // by scripts/probe-manual-entry-import.mjs. Nothing is defaulted silently: a column
  // that could not be matched or a cell that could not be read arrives as a warning
  // and is left blank, so a missing figure is visible instead of reading as a real 0.
  const applyParsed = ({ rows: parsedRows, warnings, error }, whatFailed) => {
    if (error) {
      setSaveMsg(`${whatFailed} — ${error}`);
      setMsgTone("error");
      setImportWarnings(warnings);
      return;
    }
    const newRows = [...rows, ...parsedRows];
    setRows(newRows);
    pushHistory(newRows);
    setHasDraft(true);
    setImportWarnings(warnings);
    const added = `${parsedRows.length} row${parsedRows.length === 1 ? "" : "s"} added`;
    if (warnings.length) {
      setSaveMsg(`${added}, but ${warnings.length} issue${warnings.length === 1 ? "" : "s"} need checking before you save.`);
      setMsgTone("warn");
    } else {
      setSaveMsg(`${added}. Review, then Save.`);
      setMsgTone("success");
    }
  };

  const handlePaste = (e) => {
    e.preventDefault();
    const text = e.clipboardData.getData("text");
    applyParsed(parseManualEntryPaste(text, config.fields), "Nothing pasted");
  };

  const handleImportFile = async (e) => {
    const file = e.target.files?.[0];
    // Clearing the input means picking the same file twice still fires onChange,
    // so a retry after a failed import is not silently ignored.
    e.target.value = "";
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) {
      setSaveMsg(`Not imported — that file is ${(file.size / 1024 / 1024).toFixed(1)}MB, over the ${MAX_IMPORT_BYTES / 1024 / 1024}MB limit.`);
      setMsgTone("error");
      setImportWarnings([]);
      return;
    }
    let text;
    try {
      text = await file.text();
    } catch (err) {
      setSaveMsg(`Not imported — that file could not be read (${err?.message || "unknown error"}).`);
      setMsgTone("error");
      setImportWarnings([]);
      return;
    }
    // accept=".csv" is a filename filter the user can defeat in the file dialog.
    // A NUL byte means binary (xlsx, pdf), which would otherwise land in the grid
    // as mojibake rows and then be offered for saving.
    if (text.includes("\0")) {
      setSaveMsg("Not imported — that looks like a binary file, not CSV. Export as CSV first.");
      setMsgTone("error");
      setImportWarnings([]);
      return;
    }
    applyParsed(parseManualEntryCsv(text, config.fields), "Nothing imported");
  };

  // Export column spec derived from this report's own field config, so the file the
  // owner opens carries the same headers, in the same order, as the grid they were
  // just looking at. Nothing to keep in sync: add a field above and it exports.
  //
  // THREE DEFECTS THIS REPLACES (fixed 2026-08-20, do not revert):
  //  1. `out[f.key] = r[f.key] || ""` turned a real 0 into an empty cell. On the
  //     occupancy report a genuine zero-revenue day exported as blank, which reads
  //     as "not recorded" rather than "recorded as nothing" — and blanks break SUM
  //     ranges differently than zeros do in both Excel and Sheets.
  //  2. Headers were raw column keys (`other_room_revenue`), not the labels the UI
  //     shows ("Other Rev").
  //  3. `Date.now()` stamped filenames with an epoch integer. stampFilename writes a
  //     sortable local timestamp, so a folder of exports sorts chronologically.
  //
  // BEST OUTCOME NOTE: routing through @/lib/exportData rather than hotel.js's old
  // helpers is what makes this page inherit the CSV formula-injection guard and the
  // numeric-passthrough rule for negative amounts. A second export implementation
  // would drift from the first; there is now exactly one.
  const exportColumns = useMemo(
    () => config.fields.map((f) => ({ key: f.key, label: f.label || f.key })),
    [config],
  );

  const handleExport = (type = 'csv') => {
    try {
      const isExcel = type === 'excel';
      const n = (isExcel ? downloadExcel : downloadCsv)(rows, {
        filename: stampFilename(`manual_${reportType}`, isExcel ? 'xlsx' : 'csv'),
        columns: exportColumns,
        sheetName: config.label || reportType,
      });
      setSaveMsg(`Exported ${n.toLocaleString()} row${n === 1 ? '' : 's'} to ${isExcel ? 'Excel' : 'CSV'}.`);
      setMsgTone("success");
    } catch (e) {
      // A failed export used to be silent: downloadCsv on an empty grid produced a
      // header-only file and no message at all.
      setSaveMsg(`Nothing exported — ${e?.message || String(e)}`);
      setMsgTone("error");
    }
  };

  const handleSave = async () => {
    // Rate limiting for sensitive actions
    const rateLimit = sensitiveActionRateLimiter.check();
    if (!rateLimit.allowed) {
      setSaveMsg(`Rate limited. Try again in ${Math.ceil(rateLimit.retryAfter / 60)} minutes.`);
      setMsgTone("error");
      setSaving(false);
      return;
    }
    // CSRF validation
    const csrfToken = getCsrfToken();
    if (!validateCsrfToken(csrfToken)) {
      setSaveMsg("Invalid security token. Please refresh the page and try again.");
      setMsgTone("error");
      rotateCsrfToken();
      setSaving(false);
      return;
    }

    setSaving(true);
    setSaveMsg("");
    setImportWarnings([]);
    const prop = selectedProperty || properties[0];
    if (!prop) {
      setSaveMsg("Select a property first.");
      setMsgTone("error");
      setSaving(false);
      return;
    }
    // Enforce property access: a restricted user can only save to their own properties.
    const allowedIds = accessibleProperties.length ? new Set(accessibleProperties.map((p) => String(p.id))) : null;
    if (allowedIds && !allowedIds.has(String(prop.id))) {
      setSaveMsg("You do not have access to the selected property.");
      setMsgTone("error");
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

    // A FAILED READ BLOCKS THE SAVE — this is not a cosmetic guard.
    //
    // The dedupe set below is built from `existing`. If that query failed and we
    // carried on, `existing` would be its empty default, every key would look new,
    // and a save would write rows that ALREADY EXIST as second copies — double-
    // counted revenue with no error anywhere. An empty grid is a nuisance; an
    // empty dedupe set is silent data corruption. So the save refuses until the
    // read succeeds, and says exactly why.
    if (existingQ.isError) {
      setSaveMsg("Not saved - the saved-entries list could not be loaded, so duplicate rows cannot be detected. Retry, and do not re-enter rows until it loads.");
      setMsgTone("error");
      setSaving(false);
      return;
    }

    // Build the dedupe key the same way report imports do so manual rows never
    // double-count against imported report rows.
    const dedupeKey = (rec) => {
      if (reportType === "source") return `${rec.property_id}|${rec.date}|${rec.code || rec.source}`;
      return `${rec.property_id}|${rec.date}`;
    };
    const existingKeys = new Set(existing.map(dedupeKey));

    // Validate rows before writing anything.
    const errors = [];
    const prepared = [];
    // A row with no date cannot be keyed or deduped, so it cannot be saved. It used
    // to be skipped silently and left out of the "N records saved" count, which read
    // as a successful save of data that was never written.
    let undated = 0;
    for (const row of rows) {
      if (!row.date && !row.shift_date) {
        // An entirely blank row is just an unused grid line, not lost data.
        const hasAnyValue = config.fields.some((f) => {
          const v = row[f.key];
          return v !== undefined && v !== null && String(v).trim() !== "";
        });
        if (hasAnyValue) undated++;
        continue;
      }
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
            if (reportType === "occupancy" && f.key === "occupancy" && use > 1) use = use / 100;
            record[f.key] = use;
          } else {
            record[f.key] = val;
          }
        }
      }
      Object.assign(record, meta);
      prepared.push({ row, record });
    }
    if (undated) {
      errors.push(`${undated} row${undated === 1 ? " has" : "s have"} data but no date — every row needs a date to be saved.`);
    }
    if (errors.length) {
      setSaveMsg(`Not saved — ${errors[0]}${errors.length > 1 ? ` (+${errors.length - 1} more)` : ""}`);
      setMsgTone("error");
      // Every failure, not just the first: the summary above names one, and the user
      // has to fix all of them before the save will go through.
      setImportWarnings(errors);
      setSaving(false);
      rotateCsrfToken();
      return;
    }

    let saved = 0;
    let skipped = 0;
    try {
      // All rows or none. The old bare loop committed row by row, so a failure
      // part-way through left a half-entered day in a financial ledger and — with
      // no catch anywhere in this handler — threw out of an async onClick, leaving
      // the Save button spinning and the operator unaware anything had been
      // written. See src/lib/manualEntrySave.js.
      ({ saved, skipped } = await saveManualRows({
        entityName,
        prepared,
        existingKeys,
        dedupeKey,
      }));
    } catch (e) {
      setSaveMsg(`Not saved — ${e?.message || String(e)}. No records were written; fix the problem and save again.`);
      setMsgTone("error");
      setImportWarnings([e?.message || String(e)]);
      // The draft stays on disk deliberately: it is the only copy of the typed
      // rows now that the write was rolled back.
      setSaving(false);
      rotateCsrfToken();
      return;
    }
    qc.invalidateQueries({ queryKey: ["manual-entries"] });
    qc.invalidateQueries({ queryKey: ["occupancy"] });
    qc.invalidateQueries({ queryKey: ["payments"] });
    qc.invalidateQueries({ queryKey: ["gross"] });
    qc.invalidateQueries({ queryKey: ["sources"] });
    const extra = skipped ? ` · ${skipped} duplicate${skipped === 1 ? "" : "s"} skipped` : "";
    setSaveMsg(`${saved} records saved. All dashboards updated.${extra}`);
    setMsgTone("success");
    setImportWarnings([]);
    setHasDraft(false);
    if (draftKey) {
      // The records ARE written by this point, so a refused removal is not an error
      // and must not overwrite the success message — but it must also not throw,
      // because setSaving(false) and rotateCsrfToken() are below it. An unguarded
      // removeItem here left a completed save with the Save button spinning and a
      // stale CSRF token.
      const { ok, problem } = clearDraft(draftKey);
      if (!ok) {
        setSaveMsg(`${saved} records saved. All dashboards updated.${extra} ${problem}`);
        setMsgTone("warn");
      }
    }
    setSaving(false);
    rotateCsrfToken();
  };

  const filteredRows = useMemo(() => {
    if (!search.trim()) return rows;
    const s = search.toLowerCase();
    return rows.filter((r) => Object.values(r).some((v) => String(v || "").toLowerCase().includes(s)));
  }, [rows, search]);

  return (
    <div className="space-y-4">
      <header>
        <p className="text-[11px] uppercase tracking-[0.3em] text-[#00D4FF]">Module 8</p>
        <h1 className="mt-2 font-heading text-3xl font-semibold text-white">Manual Data Entry</h1>
        <p className="mt-1 text-sm text-slate-400">
          Edit hotel data in a spreadsheet grid. All changes update dashboards, charts, and KPIs automatically.
        </p>
      </header>

      {draftToRecover && (
        <Card className="border-amber-500/50 bg-amber-500/10">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-medium text-amber-500">Unsaved Draft Recovered</h3>
              <p className="text-sm text-slate-300">You have an auto-saved draft for this property and report type.</p>
            </div>
            <div className="flex gap-3">
              <button onClick={handleDiscardDraft} className="text-sm text-slate-400 hover:text-white">Discard</button>
              <button onClick={handleResumeDraft} className="rounded-md bg-amber-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-600">Resume Draft</button>
            </div>
          </div>
        </Card>
      )}

      <Card title="Configuration" subtitle="Select property, report type, and date">
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label className="mb-1.5 block text-xs text-slate-400">Property</label>
            <ResponsiveSelect
              value={Array.isArray(property) ? property[0] : property}
              onValueChange={() => { /* handled by global filters */ }}
              options={propertyOpts}
              placeholder="Select property…"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs text-slate-400">Report Type</label>
            <ResponsiveSelect
              value={reportType}
              onValueChange={(v) => { setReportType(v); setRows([]); }}
              options={Object.entries(REPORT_CONFIGS).map(([k, c]) => [k, c.label])}
            />
          </div>
          <div className="flex items-end gap-2">
            <button onClick={initEmpty} className="flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-2 text-xs text-slate-200 hover:border-[#00D4FF]/30">
              <Plus className="h-3.5 w-3.5" /> New Grid
            </button>
            <button onClick={loadFromExisting} className="flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-2 text-xs text-slate-200 hover:border-[#00D4FF]/30">
              <Table2 className="h-3.5 w-3.5" /> Load Existing
            </button>
          </div>
        </div>
        {existingQ.isError && (
          <ErrorState
            title="Saved entries could not be loaded"
            description="Saving is disabled while this fails: duplicates can only be detected against the saved list. Nothing you already typed is lost."
            error={existingQ.error}
            onRetry={existingQ.refetch}
          />
        )}
      </Card>

      {/* One file input for the whole page. It used to live inside the grid card's
          toolbar, which is only rendered when rows.length > 0 — so the Import button
          in the empty state below had nothing to click. */}
      <input ref={fileInputRef} type="file" accept=".csv,text/csv" className="hidden" onChange={handleImportFile} />

      {/* Import and validation problems. Outside the `rows.length > 0` block on
          purpose: a refused import leaves the grid empty, and that is exactly when
          the user most needs to be told why nothing appeared. The message itself is
          repeated here only when the grid is empty, because the copy beside the Save
          button below is not rendered in that state — without this, refusing a file
          that produces an error but no per-cell warnings said nothing at all. */}
      {(importWarnings.length > 0 || (saveMsg && rows.length === 0)) && (
        <Card>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p
                role={msgTone === "error" ? "alert" : "status"}
                className={`text-xs font-medium ${MSG_TONE_CLASS[msgTone] || MSG_TONE_CLASS.warn}`}
              >
                {rows.length === 0 && saveMsg
                  ? saveMsg
                  : `${importWarnings.length} issue${importWarnings.length === 1 ? "" : "s"} to check`}
              </p>
              <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto pr-2">
                {importWarnings.slice(0, 100).map((w, i) => (
                  <li key={i} className="text-xs text-slate-300">• {w}</li>
                ))}
              </ul>
              {importWarnings.length > 100 && (
                <p className="mt-1 text-xs text-slate-500">…and {importWarnings.length - 100} more.</p>
              )}
            </div>
            <button
              onClick={() => { setImportWarnings([]); setSaveMsg(""); }}
              className="shrink-0 rounded-lg border border-white/10 px-2 py-1 text-xs text-slate-400 hover:border-[#00D4FF]/30"
            >
              Dismiss
            </button>
          </div>
        </Card>
      )}

      {rows.length > 0 && (
        <>
          <Card
            title={`${config.label} — Spreadsheet Editor`}
            subtitle={`${rows.length} rows · ${config.fields.length} columns`}
            right={
              <div className="flex items-center gap-1">
                <button onClick={handleUndo} disabled={historyIndex <= 0} className="rounded-lg border border-white/10 p-2 text-slate-300 hover:border-[#00D4FF]/30 disabled:opacity-30" title="Undo">
                  <Undo2 className="h-4 w-4" />
                </button>
                <button onClick={handleRedo} disabled={historyIndex >= history.length - 1} className="rounded-lg border border-white/10 p-2 text-slate-300 hover:border-[#00D4FF]/30 disabled:opacity-30" title="Redo">
                  <Redo2 className="h-4 w-4" />
                </button>
                <button onClick={() => fileInputRef.current?.click()} className="rounded-lg border border-white/10 p-2 text-slate-300 hover:border-[#00D4FF]/30" title="Import CSV">
                  <Upload className="h-4 w-4" />
                </button>
                <button onClick={() => handleExport('csv')} className="rounded-lg border border-white/10 p-2 text-[#6C63FF] hover:border-[#6C63FF]/30" title="Export CSV">
                  <Download className="h-4 w-4" />
                </button>
                <button onClick={() => handleExport('excel')} className="rounded-lg border border-white/10 p-2 text-[#107C41] hover:border-[#107C41]/30" title="Export Excel">
                  <Download className="h-4 w-4" />
                </button>
              </div>
            }
          >
            <div className="mb-3 flex items-center gap-2">
              <Search className="h-4 w-4 text-slate-500" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search rows…"
                className="w-full rounded-lg border border-white/10 bg-[#0A1628] px-3 py-1.5 text-sm text-slate-200 outline-none focus:border-[#00D4FF]"
              />
            </div>

            <div className="overflow-x-auto rounded-xl border border-white/5" onPaste={handlePaste}>
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="bg-[#0A1628] text-left">
                    <th className="border-r border-white/5 px-2 py-2 text-[10px] uppercase text-slate-500" style={{ width: "40px" }}>#</th>
                    {config.fields.map((f) => (
                      <th key={f.key} className="border-r border-white/5 px-2 py-2 text-[10px] uppercase text-slate-400" style={{ minWidth: f.width }}>
                        {f.label}
                      </th>
                    ))}
                    <th className="px-2 py-2" style={{ width: "40px" }}></th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.map((row, rowIdx) => (
                    <tr key={rowIdx} className="border-t border-white/5 hover:bg-white/[0.02]">
                      <td className="border-r border-white/5 px-2 py-1 text-center text-[10px] text-slate-600">{rowIdx + 1}</td>
                      {config.fields.map((f) => (
                        <td key={f.key} className="border-r border-white/5 px-0 py-0">
                          <input
                            type={f.type === "number" ? "number" : f.type === "date" ? "date" : "text"}
                            value={row[f.key] ?? ""}
                            onChange={(e) => handleCellChange(rowIdx, f.key, e.target.value)}
                            className="w-full bg-transparent px-2 py-1.5 text-xs text-slate-200 outline-none focus:bg-[#6C63FF]/10 focus:outline"
                            style={{ minWidth: f.width }}
                          />
                        </td>
                      ))}
                      <td className="px-2 py-1">
                        <button onClick={() => handleDeleteRow(rowIdx)} className="text-slate-500 hover:text-[#FF6B6B]">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-3 flex items-center justify-between">
              <button onClick={handleAddRow} className="flex items-center gap-1.5 rounded-lg border border-dashed border-white/10 px-3 py-2 text-xs text-slate-300 hover:border-[#00D4FF]/30">
                <Plus className="h-3.5 w-3.5" /> Add Row
              </button>
              <div className="flex items-center gap-3">
                {hasDraft && <span className="text-xs text-[#FFB547]">● Unsaved draft</span>}
                {saveMsg && (
                  <span
                    role={msgTone === "error" ? "alert" : "status"}
                    className={`text-xs ${MSG_TONE_CLASS[msgTone] || MSG_TONE_CLASS.success}`}
                  >
                    {saveMsg}
                  </span>
                )}
                <button
                  onClick={handleSave}
                  disabled={saving || !hasDraft}
                  className="flex items-center gap-1.5 rounded-lg bg-[#00E096] px-4 py-2 text-sm font-medium text-[#040D1A] hover:bg-[#00c885] disabled:opacity-50"
                >
                  <Save className="h-4 w-4" /> {saving ? "Saving…" : "Save & Update Dashboards"}
                </button>
              </div>
            </div>
          </Card>
        </>
      )}

      {rows.length === 0 && (
        <Card>
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <FileSpreadsheet className="h-12 w-12 text-slate-600" />
            <p className="mt-3 text-sm text-slate-400">No data in the grid yet.</p>
            <div className="mt-4 flex gap-2">
              <button onClick={initEmpty} className="flex items-center gap-1.5 rounded-lg bg-[#6C63FF] px-4 py-2 text-sm font-medium text-white hover:bg-[#5b52e8]">
                <Plus className="h-4 w-4" /> Start New Grid
              </button>
              {existing.length > 0 && (
                <button onClick={loadFromExisting} className="flex items-center gap-1.5 rounded-lg border border-white/10 px-4 py-2 text-sm text-slate-200 hover:border-[#00D4FF]/30">
                  <Table2 className="h-4 w-4" /> Load {existing.length} Existing Records
                </button>
              )}
              <button onClick={() => fileInputRef.current?.click()} className="flex items-center gap-1.5 rounded-lg border border-white/10 px-4 py-2 text-sm text-slate-200 hover:border-[#00D4FF]/30">
                <Upload className="h-4 w-4" /> Import CSV
              </button>
            </div>
            <p className="mt-4 text-xs text-slate-500">Tip: You can paste data directly from Excel (Ctrl+V) into the grid.</p>
          </div>
        </Card>
      )}

      {existing.length > 0 && (
        <Card title="Existing Manual Entries" subtitle={`${existing.length} records marked as manual entry`}>
          <div className="max-h-60 overflow-auto space-y-1">
            {existing.slice(0, 50).map((r) => (
              <div key={r.id} className="flex items-center justify-between rounded-lg border border-white/5 bg-[#0A1628]/60 px-3 py-2 text-xs">
                <span className="text-slate-300">{String(r.date || r.shift_date || "").slice(0, 10)}</span>
                <span className="text-slate-500">{r.source_file || "Manual"}</span>
                <span className="text-slate-500">{String(r.created_date || "").slice(0, 10)}</span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}