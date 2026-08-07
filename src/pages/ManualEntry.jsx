import { db } from '@/api/base44Client';

import React, { useState, useMemo, useRef, useCallback } from "react";
import { Plus, Trash2, Save, Upload, Download, Undo2, Redo2, Search, Table2, FileSpreadsheet } from "lucide-react";
import Card from "@/components/ui-exec/Card";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useGlobalFilters } from "@/lib/useGlobalFilters";
import { downloadCsv } from "@/lib/hotel";
import ResponsiveSelect from "@/components/ui/ResponsiveSelect";

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
      return db.entities[config.entity].filter(filter, "-date", 500);
    },
  });
}

export default function ManualEntry() {
  const { property, properties } = useGlobalFilters();
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

  const config = REPORT_CONFIGS[reportType];
  const selectedProperty = properties.find((p) => p.id === (Array.isArray(property) ? property[0] : property));
  const { data: existing = [] } = useManualEntries(reportType, property);

  const propertyOpts = properties.map((p) => [p.id, p.name]);

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
    if (!file) return;
    const text = await file.text();
    const lines = text.split("\n").filter((l) => l.trim());
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

  const handleExport = () => {
    const exportRows = rows.map((r) => {
      const out = {};
      config.fields.forEach((f) => { out[f.key] = r[f.key] || ""; });
      return out;
    });
    downloadCsv(exportRows, `manual_${reportType}_${Date.now()}.csv`);
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveMsg("");
    const prop = selectedProperty || properties[0];
    if (!prop) {
      setSaveMsg("Select a property first.");
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
    let saved = 0;
    for (const row of rows) {
      if (!row.date && !row.shift_date) continue;
      const record = {};
      config.fields.forEach((f) => {
        const val = row[f.key];
        if (val !== undefined && val !== "") {
          if (f.type === "number") {
            let n = Number(val) || 0;
            // Match importer convention: occupancy stored as a 0-1 ratio
            if (reportType === "occupancy" && f.key === "occupancy" && n > 1) n = n / 100;
            record[f.key] = n;
          } else {
            record[f.key] = val;
          }
        }
      });
      Object.assign(record, meta);
      if (row._id) {
        await db.entities[entityName].update(row._id, record);
      } else {
        await db.entities[entityName].create(record);
      }
      saved++;
    }
    qc.invalidateQueries({ queryKey: ["manual-entries"] });
    qc.invalidateQueries({ queryKey: ["occupancy"] });
    qc.invalidateQueries({ queryKey: ["payments"] });
    qc.invalidateQueries({ queryKey: ["gross"] });
    qc.invalidateQueries({ queryKey: ["sources"] });
    setSaveMsg(`${saved} records saved. All dashboards updated.`);
    setHasDraft(false);
    setSaving(false);
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

      <Card title="Configuration" subtitle="Select property, report type, and date">
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label className="mb-1.5 block text-xs text-slate-400">Property</label>
            <ResponsiveSelect
              value={Array.isArray(property) ? property[0] : property}
              onValueChange={(v) => { /* handled by global filters */ }}
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
      </Card>

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
                <button onClick={handleExport} className="rounded-lg border border-white/10 p-2 text-slate-300 hover:border-[#00D4FF]/30" title="Export CSV">
                  <Download className="h-4 w-4" />
                </button>
                <input ref={fileInputRef} type="file" accept=".csv" className="hidden" onChange={handleImportFile} />
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
                {saveMsg && <span className="text-xs text-[#00E096]">{saveMsg}</span>}
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