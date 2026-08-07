import { db } from '@/api/base44Client';

import React, { useState } from "react";
import { UploadCloud, CheckCircle2, FileSpreadsheet, XCircle, Search, Building2, Loader2, Eye, Trash2, ArrowDownToLine } from "lucide-react";
import Card from "@/components/ui-exec/Card";

import { useUploads, useProperties } from "@/lib/useHotelData";
import { num } from "@/lib/hotel";
import { REPORT_TYPES, scanReport, importReport } from "@/lib/reportParsers";
import ResponsiveSelect from "@/components/ui/ResponsiveSelect";

const STATUS_LABEL = {
  pending: "Queued",
  scanning: "Scanning…",
  ready: "Ready to import",
  importing: "Importing…",
  done: "Imported",
  error: "Failed",
};

// Flatten a scan result into plain rows usable by the Chart Builder's custom datasets
function scanRawRows(scan) {
  if (!scan) return [];
  if (Array.isArray(scan.rowsToImport) && scan.rowsToImport.length) return scan.rowsToImport;
  const combined = [];
  for (const arr of [scan.payments, scan.drops, scan.clerkPayments]) {
    if (Array.isArray(arr)) combined.push(...arr);
  }
  return combined.slice(0, 5000);
}

export default function Import() {
  const { data: uploads = [], refetch } = useUploads();
  const { data: properties = [] } = useProperties();
  const [type, setType] = useState("auto");
  const [propertyId, setPropertyId] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentFile, setCurrentFile] = useState("");
  const [totalFiles, setTotalFiles] = useState(0);
  const [processed, setProcessed] = useState(0);
  const [queue, setQueue] = useState([]);
  const [importing, setImporting] = useState(false);
  const [expandedKey, setExpandedKey] = useState(null);
  const [results, setResults] = useState([]);
  const [search, setSearch] = useState("");
  const [driveFiles, setDriveFiles] = useState([]);
  const [driveLoading, setDriveLoading] = useState(false);
  const [driveError, setDriveError] = useState("");
  const [selectedFiles, setSelectedFiles] = useState(new Set());
  const [driveImporting, setDriveImporting] = useState(false);
  const [clearing, setClearing] = useState(false);

  const propertyOpts = properties.map((p) => [p.id, p.name]);
  const selectedProperty = properties.find((p) => p.id === propertyId);

  const importMeta = (sourceFile) => ({
    propertyId,
    propertyName: selectedProperty?.name || "",
    importId: `imp_${Date.now()}`,
    sourceFile: sourceFile || "",
  });

  const handleFiles = async (fileList) => {
    const files = Array.from(fileList).filter((f) => /\.(csv|xlsx|xls)$/i.test(f.name));
    if (!files.length) return;
    const stamp = Date.now();
    const newQueue = files.map((file, i) => ({
      key: `${file.name}-${stamp}-${i}`,
      file,
      name: file.name,
      status: "pending",
      scan: null,
      file_url: "",
      error: "",
      count: 0,
      excluded: 0,
      importId: `imp_${stamp}_${i}`,
    }));
    setQueue(newQueue);
    setResults([]);
    setExpandedKey(null);
    setTotalFiles(newQueue.length);
    setProcessed(0);
    setProgress(0);
    setBusy(true);
    for (let i = 0; i < newQueue.length; i++) {
      const item = newQueue[i];
      setCurrentFile(item.name);
      setQueue((prev) => prev.map((q) => (q.key === item.key ? { ...q, status: "scanning" } : q)));
      try {
        const { file_url } = await db.integrations.Core.UploadFile({ file: item.file });
        const scan = await scanReport(type, file_url, {
          propertyId,
          propertyName: selectedProperty?.name || "",
          importId: item.importId,
          sourceFile: item.name,
        });
        setQueue((prev) => prev.map((q) => (q.key === item.key ? { ...q, status: "ready", scan, file_url } : q)));
      } catch (e) {
        setQueue((prev) => prev.map((q) => (q.key === item.key ? { ...q, status: "error", error: e.message || "Could not read file" } : q)));
      }
      const done = i + 1;
      setProcessed(done);
      setProgress(Math.round((done / newQueue.length) * 100));
    }
    setBusy(false);
    setCurrentFile("");
  };

  const importSingle = async (item) => {
    if (!item.scan || !propertyId || item.status === "done") return null;
    setQueue((prev) => prev.map((q) => (q.key === item.key ? { ...q, status: "importing" } : q)));
    try {
      const result = await importReport(item.scan, {
        propertyId,
        propertyName: selectedProperty?.name || "",
        importId: item.importId,
        sourceFile: item.name,
      });
      await db.entities.UploadedReport.create({
        file_name: item.name,
        report_type: item.scan.type || type,
        rows_imported: result.count,
        file_url: item.file_url,
        property_id: propertyId,
        property_name: selectedProperty?.name || "",
        import_id: item.importId,
        source_file: item.name,
        raw_rows: scanRawRows(item.scan),
      });
      setQueue((prev) => prev.map((q) => (q.key === item.key ? { ...q, status: "done", count: result.count, excluded: result.excluded || 0 } : q)));
      return { name: item.name, ok: true, count: result.count, excluded: result.excluded || 0 };
    } catch (e) {
      setQueue((prev) => prev.map((q) => (q.key === item.key ? { ...q, status: "error", error: e.message || "Import failed" } : q)));
      return { name: item.name, ok: false, error: e.message || "Import failed" };
    }
  };

  const handleImportAll = async () => {
    const pending = queue.filter((q) => q.status === "ready" && q.scan);
    if (!pending.length || importing) return;
    setImporting(true);
    const newResults = [];
    for (const item of pending) {
      const r = await importSingle(item);
      if (r) newResults.push(r);
    }
    setResults(newResults);
    setImporting(false);
    refetch();
  };

  const handleRemoveFromQueue = (key) => {
    if (importing || busy) return;
    setQueue((prev) => prev.filter((q) => q.key !== key));
  };

  const IMPORT_TABLES = ["OccupancyDay", "SourceDay", "GrossRevenueDay", "PaymentDay", "ClerkShiftRecord", "UploadedReport"];

  const handleClearAll = async () => {
    if (clearing) return;
    const ok = window.confirm(
      "Delete ALL imported report data and import history?\n\nThis permanently removes every imported row from this browser (occupancy, sources, gross revenue, payments, clerk records). Properties and settings are kept.\n\nThis cannot be undone."
    );
    if (!ok) return;
    setClearing(true);
    try {
      for (const table of IMPORT_TABLES) {
        await db.entities[table].clear();
      }
      setQueue([]);
      setResults([]);
      refetch();
    } catch (e) {
      console.error("Failed to clear imported data:", e);
      window.alert(`Could not clear data: ${e.message || "unknown error"}`);
    } finally {
      setClearing(false);
    }
  };

  const readyCount = queue.filter((q) => q.status === "ready" && q.scan).length;
  const queuedCount = queue.filter((q) => q.status !== "done" && q.status !== "error").length;
  const doneItems = queue.filter((q) => q.status === "done");
  const errorItems = queue.filter((q) => q.status === "error");
  const batchImported = doneItems.reduce((a, r) => a + (r.count || 0), 0);
  const batchExcluded = doneItems.reduce((a, r) => a + (r.excluded || 0), 0);

  const handleBrowseDrive = async () => {
    setDriveLoading(true);
    setDriveError("");
    try {
      const res = await db.functions.invoke("listDriveFiles", {});
      setDriveFiles(res.data.files || []);
    } catch (e) {
      setDriveError(e.response?.data?.error || e.message || "Could not connect to Google Drive");
    }
    setDriveLoading(false);
  };

  const handleImportDrive = async () => {
    if (!selectedFiles.size || !type) return;
    setDriveImporting(true);
    const meta = importMeta();
    for (const fileId of selectedFiles) {
      const fileInfo = driveFiles.find((f) => f.id === fileId);
      const fileName = fileInfo?.name || fileId;
      setCurrentFile(fileName);
      try {
        const res = await db.functions.invoke("importDriveFile", { fileId, fileName });
        const fileUrl = res.data.file_url;
        const scan = await scanReport(type, fileUrl, { ...meta, sourceFile: fileName });
        const result = await importReport(scan, { ...meta, sourceFile: fileName });
        await db.entities.UploadedReport.create({
          file_name: fileName,
          report_type: scan.type || type,
          rows_imported: result.count,
          file_url: fileUrl,
          property_id: propertyId,
          property_name: selectedProperty?.name || "",
          import_id: meta.importId,
          source_file: fileName,
          drive_file_id: fileId,
          raw_rows: scanRawRows(scan),
        });
        setResults((prev) => [...prev, { name: fileName, ok: true, count: result.count, excluded: result.excluded || 0 }]);
      } catch (e) {
        setResults((prev) => [...prev, { name: fileName, ok: false, error: e.response?.data?.error || e.message || "Import failed" }]);
      }
    }
    setDriveImporting(false);
    setSelectedFiles(new Set());
    refetch();
    setCurrentFile("");
  };

  const totalExcluded = results.reduce((a, r) => a + (r.excluded || 0), 0);
  const totalImported = results.reduce((a, r) => a + (r.count || 0), 0);

  const filtered = uploads.filter((u) => {
    if (!search.trim()) return true;
    const s = search.toLowerCase();
    return (
      u.file_name?.toLowerCase().includes(s) ||
      u.report_type?.toLowerCase().includes(s) ||
      String(u.created_date || "").toLowerCase().includes(s)
    );
  });

  return (
    <div className="space-y-6">
      <header>
        <p className="text-[11px] uppercase tracking-[0.3em] text-[#00D4FF]">Module 1</p>
        <h1 className="mt-2 font-heading text-3xl font-semibold text-white">Import HotelKey Reports</h1>
        <p className="mt-1 text-sm text-slate-400">
          Excel or CSV. Select a property first, then batch-import reports. Zero-revenue duplicates are filtered automatically.
        </p>
      </header>

      <Card title="Target property" subtitle="Select which property these reports belong to">
        <div className="flex items-center gap-3">
          <Building2 className="h-5 w-5 text-[#6C63FF]" />
          {properties.length > 0 ? (
            <div className="min-w-[280px] flex-1">
              <ResponsiveSelect
                value={propertyId}
                onValueChange={setPropertyId}
                options={propertyOpts}
                placeholder="Select a property…"
              />
            </div>
          ) : (
            <p className="text-sm text-slate-400">
              No properties yet. Add properties in{" "}
              <a href="/settings" className="text-[#00D4FF] underline">Settings</a>{" "}
              before importing reports.
            </p>
          )}
          {selectedProperty && (
            <span className="rounded-full bg-[#6C63FF]/15 px-3 py-1 text-xs text-[#6C63FF]">
              {selectedProperty.code} · {selectedProperty.rooms} rooms
            </span>
          )}
        </div>
      </Card>

      <Card title="Report format" subtitle="Choose the report type you are uploading">
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {REPORT_TYPES.map((r) => (
            <button
              key={r.key}
              onClick={() => setType(r.key)}
              disabled={busy}
              className={`rounded-xl border px-3 py-3 text-left text-sm transition-all duration-200 ${
                type === r.key
                  ? "border-[#6C63FF] bg-[#6C63FF]/15 text-white"
                  : "border-white/10 bg-[#0A1628] text-slate-400 hover:border-white/20"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>

        <label
          className={`mt-5 flex cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border border-dashed px-6 py-12 text-center transition-colors ${
            !propertyId ? "cursor-not-allowed border-white/10 opacity-40" : "border-white/15 bg-[#0A1628]/60 hover:border-[#00D4FF]/60"
          }`}
        >
          <UploadCloud className="h-7 w-7 text-[#00D4FF]" />
          <span className="text-sm text-slate-300">
            {!propertyId
              ? "Select a property first to enable uploads"
              : busy
              ? `Scanning ${currentFile}…`
              : "Drop multiple .xlsx / .xls / .csv files here or click to browse"}
          </span>
          <input
            type="file"
            accept=".xlsx,.xls,.csv"
            multiple
            className="hidden"
            disabled={busy || !propertyId}
            onChange={(e) => {
              handleFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </label>

        {busy && (
          <div className="mt-4">
            <div className="h-2 overflow-hidden rounded-full bg-white/5">
              <div
                className="h-full rounded-full bg-gradient-to-r from-[#6C63FF] to-[#00D4FF] transition-all duration-300"
                style={{ width: `${progress}%` }}
              />
            </div>
            <p className="mt-2 text-xs text-slate-400">
              Scanning {processed} of {totalFiles}: {currentFile}
            </p>
          </div>
        )}

        {queue.length > 0 && !busy && (
          <div className="mt-4 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-sm text-slate-300">
                <FileSpreadsheet className="h-4 w-4 text-[#6C63FF]" />
                <span className="text-white">{queue.length}</span> file{queue.length === 1 ? "" : "s"} selected
                {queuedCount > 0 && <span className="text-slate-500">· {queuedCount} awaiting import</span>}
                {errorItems.length > 0 && <span className="text-[#FF6B6B]">· {errorItems.length} failed</span>}
              </div>
              <div className="flex items-center gap-2">
                {readyCount > 0 && (
                  <button
                    onClick={handleImportAll}
                    disabled={importing || !propertyId}
                    className="flex items-center gap-2 rounded-lg bg-[#00E096] px-5 py-2 text-sm font-medium text-[#040D1A] transition-colors hover:bg-[#00c885] disabled:opacity-50"
                  >
                    {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowDownToLine className="h-4 w-4" />}
                    {importing ? "Importing…" : `Import All (${readyCount})`}
                  </button>
                )}
                {errorItems.length > 0 && (
                  <button
                    onClick={() => setQueue((prev) => prev.filter((q) => q.status !== "error"))}
                    disabled={importing}
                    className="flex items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-sm text-slate-400 transition-colors hover:border-[#FF6B6B]/60 hover:text-[#FF6B6B] disabled:opacity-50"
                  >
                    <Trash2 className="h-3.5 w-3.5" /> Clear failed
                  </button>
                )}
              </div>
            </div>

            <div className="space-y-2">
              {queue.map((q) => (
                <div key={q.key} className="rounded-xl border border-white/5 bg-[#0A1628]/60 px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="flex min-w-0 items-center gap-2 text-sm text-slate-300">
                      {q.status === "scanning" || q.status === "importing" ? (
                        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[#00D4FF]" />
                      ) : q.status === "done" ? (
                        <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-[#00E096]" />
                      ) : q.status === "error" ? (
                        <XCircle className="h-3.5 w-3.5 shrink-0 text-[#FF6B6B]" />
                      ) : q.status === "ready" ? (
                        <FileSpreadsheet className="h-3.5 w-3.5 shrink-0 text-[#6C63FF]" />
                      ) : (
                        <FileSpreadsheet className="h-3.5 w-3.5 shrink-0 text-slate-500" />
                      )}
                      <span className="truncate">{q.name}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      <span
                        className={`rounded-full px-2.5 py-0.5 text-xs ${
                          q.status === "done"
                            ? "bg-[#00E096]/15 text-[#00E096]"
                            : q.status === "error"
                            ? "bg-[#FF6B6B]/15 text-[#FF6B6B]"
                            : q.status === "ready"
                            ? "bg-[#6C63FF]/15 text-[#6C63FF]"
                            : "bg-white/5 text-slate-400"
                        }`}
                      >
                        {q.status === "done"
                          ? `${q.count} rows${q.excluded ? ` · ${q.excluded} excluded` : ""}`
                          : STATUS_LABEL[q.status] || q.status}
                      </span>
                      {(q.status === "ready" || q.status === "done") && (
                        <button
                          onClick={() => setExpandedKey(expandedKey === q.key ? null : q.key)}
                          className="rounded-md p-1 text-slate-400 transition-colors hover:bg-white/5 hover:text-[#00D4FF]"
                          title="Show scan preview"
                        >
                          <Eye className="h-3.5 w-3.5" />
                        </button>
                      )}
                      {q.status === "ready" && (
                        <button
                          onClick={() => importSingle(q).then((r) => { if (r) { setResults((prev) => [...prev, r]); refetch(); } })}
                          disabled={importing}
                          className="rounded-lg bg-[#6C63FF]/20 px-3 py-1 text-xs text-[#6C63FF] transition-colors hover:bg-[#6C63FF]/35 disabled:opacity-40"
                        >
                          Import
                        </button>
                      )}
                      {q.status !== "scanning" && q.status !== "importing" && (
                        <button
                          onClick={() => handleRemoveFromQueue(q.key)}
                          className="rounded-md p-1 text-slate-500 transition-colors hover:bg-white/5 hover:text-[#FF6B6B]"
                          title="Remove from queue"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </span>
                  </div>

                  {q.status === "error" && <p className="mt-1 text-xs text-[#FF6B6B]">{q.error}</p>}

                  {expandedKey === q.key && q.scan && (
                    <div className="mt-3 space-y-2 border-t border-white/5 pt-3">
                      <div className="flex items-center gap-4 text-xs text-slate-400">
                        <span>
                          Report type:{" "}
                          <span className="text-white">{REPORT_TYPES.find((r) => r.key === (q.scan?.type || type))?.label || q.scan?.type || type}</span>
                        </span>
                        <span>
                          Total rows: <span className="text-white">{q.scan.totalRows || 0} detected</span>
                        </span>
                      </div>
                      {(q.scan.sections || []).map((s, i) => (
                        <div key={i} className="flex items-center justify-between rounded-lg border border-white/5 bg-[#040D1A]/60 px-3 py-2">
                          <p className="text-xs text-slate-300">{s.name}</p>
                          <span className={`rounded-full px-2.5 py-0.5 text-xs ${s.rows > 0 ? "bg-[#00E096]/15 text-[#00E096]" : "bg-[#FFB547]/15 text-[#FFB547]"}`}>
                            {s.rows > 0 ? `${s.rows} rows` : "0 rows"}
                          </span>
                        </div>
                      ))}
                      {q.scan.sections?.some((s) => s.rows > 0) && (
                        <pre className="max-h-40 overflow-auto rounded-lg border border-white/10 bg-[#040D1A]/60 p-3 text-xs text-slate-300">
                          {JSON.stringify(q.scan.sections.find((s) => s.rows > 0)?.preview?.slice(0, 3) || [], null, 2)}
                        </pre>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {doneItems.length > 0 && (
              <div className="flex items-center gap-4 rounded-xl border border-[#00E096]/20 bg-[#00E096]/[0.06] px-4 py-3">
                <CheckCircle2 className="h-5 w-5 text-[#00E096]" />
                <p className="text-sm text-slate-300">
                  <span className="text-white">{batchImported}</span> rows imported across {doneItems.length} file{doneItems.length === 1 ? "" : "s"}
                  {batchExcluded > 0 && (
                    <span className="text-[#FFB547]"> · {batchExcluded} zero-revenue duplicate rows excluded</span>
                  )}
                </p>
              </div>
            )}
          </div>
        )}
      </Card>

      <Card title="Import from Google Drive" subtitle="Browse HotelKey reports stored in your connected Google Drive">
        <div className="flex items-center gap-3">
          <button
            onClick={handleBrowseDrive}
            disabled={driveLoading || !propertyId}
            className="flex h-11 items-center gap-2 rounded-lg bg-[#6C63FF] px-4 text-sm font-medium text-white transition-colors hover:bg-[#5b52e8] disabled:opacity-50"
          >
            {driveLoading ? "Loading…" : "Browse Google Drive"}
          </button>
          {driveFiles.length > 0 && (
            <span className="text-xs text-slate-400">{driveFiles.length} files found</span>
          )}
        </div>

        {driveError && <p className="mt-3 text-sm text-[#FF6B6B]">{driveError}</p>}

        {driveFiles.length > 0 && (
          <div className="mt-4 space-y-2">
            <div className="max-h-64 space-y-1 overflow-auto rounded-xl border border-white/5 bg-[#0A1628]/60 p-2">
              {driveFiles.map((f) => (
                <label
                  key={f.id}
                  className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 transition-colors hover:bg-white/5"
                >
                  <input
                    type="checkbox"
                    checked={selectedFiles.has(f.id)}
                    onChange={(e) => {
                      const next = new Set(selectedFiles);
                      if (e.target.checked) next.add(f.id);
                      else next.delete(f.id);
                      setSelectedFiles(next);
                    }}
                    className="h-4 w-4 rounded border-white/20"
                  />
                  <span className="flex-1 truncate text-sm text-slate-200">{f.name}</span>
                  <span className="text-xs text-slate-500">{String(f.modifiedTime || "").slice(0, 10)}</span>
                </label>
              ))}
            </div>
            <button
              onClick={handleImportDrive}
              disabled={!selectedFiles.size || driveImporting || !propertyId}
              className="flex h-11 items-center gap-2 rounded-lg bg-[#00D4FF] px-4 text-sm font-medium text-[#040D1A] transition-colors hover:bg-[#00b8e0] disabled:opacity-50"
            >
              {driveImporting ? `Importing ${currentFile}…` : `Import ${selectedFiles.size} selected`}
            </button>

            {results.length > 0 && !driveImporting && (
              <div className="mt-4 space-y-2">
                <div className="flex items-center gap-4 rounded-xl border border-[#00E096]/20 bg-[#00E096]/[0.06] px-4 py-3">
                  <CheckCircle2 className="h-5 w-5 text-[#00E096]" />
                  <p className="text-sm text-slate-300">
                    <span className="text-white">{totalImported}</span> rows imported across {results.length} file{results.length === 1 ? "" : "s"}
                    {totalExcluded > 0 && (
                      <span className="text-[#FFB547]"> · {totalExcluded} zero-revenue duplicate rows excluded</span>
                    )}
                  </p>
                </div>
                {results.map((r, i) => (
                  <div key={i} className="flex items-center justify-between rounded-lg border border-white/5 bg-[#0A1628]/60 px-4 py-2">
                    <span className="flex items-center gap-2 text-sm text-slate-300">
                      {r.ok ? <CheckCircle2 className="h-3.5 w-3.5 text-[#00E096]" /> : <XCircle className="h-3.5 w-3.5 text-[#FF6B6B]" />}
                      {r.name}
                    </span>
                    <span className={`text-xs ${r.ok ? "text-slate-400" : "text-[#FF6B6B]"}`}>
                      {r.ok ? `${r.count} rows${r.excluded ? ` · ${r.excluded} excluded` : ""}` : r.error}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </Card>

      <Card
        title="Import history"
        subtitle={`${uploads.length} total imports · ${filtered.length} matching`}
        right={
          uploads.length > 0 && (
            <button
              onClick={handleClearAll}
              disabled={clearing || busy || importing}
              className="flex shrink-0 items-center gap-2 rounded-lg border border-[#FF6B6B]/30 px-3 py-1.5 text-xs text-[#FF6B6B] transition-colors hover:bg-[#FF6B6B]/10 hover:border-[#FF6B6B]/60 disabled:opacity-50"
            >
              {clearing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              {clearing ? "Clearing…" : "Clear all imported data"}
            </button>
          )
        }
      >
        <div className="relative mb-4">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by file name, report type, or date…"
            className="w-full rounded-lg border border-white/10 bg-[#0A1628] py-2.5 pl-10 pr-4 text-sm text-slate-200 outline-none focus:border-[#00D4FF]"
          />
        </div>
        <div className="space-y-2">
          {filtered.map((u) => (
            <div key={u.id} className="flex items-center justify-between rounded-xl border border-white/5 bg-[#0A1628]/60 px-4 py-3">
              <div className="flex items-center gap-3">
                <FileSpreadsheet className="h-4 w-4 text-[#6C63FF]" />
                <div>
                  <p className="text-sm text-white">{u.file_name}</p>
                  <p className="text-xs text-slate-500">
                    {u.property_name || "—"} · {u.report_type} · {String(u.created_date || "").slice(0, 10)}
                  </p>
                </div>
              </div>
              <p className="flex items-center gap-2 text-xs text-[#00E096]">
                <CheckCircle2 className="h-3.5 w-3.5" /> {num(u.rows_imported)} rows
              </p>
            </div>
          ))}
          {!filtered.length && (
            <p className="text-sm text-slate-500">
              {uploads.length ? "No results match your search." : "No files imported in this session yet."}
            </p>
          )}
        </div>
      </Card>
    </div>
  );
}