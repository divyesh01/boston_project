import { db, listImportSessions, rollbackImportSession } from '@/api/base44Client';

import React, { useState, useEffect, useMemo, useRef } from "react";
import { UploadCloud, CheckCircle2, FileSpreadsheet, XCircle, Search, Building2, Loader2, Eye, Trash2, ArrowDownToLine, RefreshCw, RotateCcw, X, AlertTriangle } from "lucide-react";
import Card from "@/components/ui-exec/Card";
import { EmptyState, ErrorState } from "@/components/ui/status";

import { useUploads, useProperties } from "@/lib/useHotelData";
import { useVirtualizer } from "@tanstack/react-virtual";
import { num } from "@/lib/hotel";
import { REPORT_TYPES, scanReport, importReport } from "@/lib/reportParsers";
import { clearAllImportedData } from "@/lib/importReset";
import { withActionTimeout } from "@/lib/actionTimeout";
import ResponsiveSelect from "@/components/ui/ResponsiveSelect";
import { useAuth } from "@/lib/AuthContext";
import { getCsrfToken, validateCsrfToken, rotateCsrfToken, sha256File } from "@/lib/securityUtils";
import { importRateLimiter, destructiveActionRateLimiter } from "@/lib/rateLimiters";
import {
  getQueueMetrics,
  confirmForceImportToggle,
  confirmBatchForceImport,
  confirmPropertyReassignment,
  groupQueueByOrigin,
  isValidPropertyReassignmentConfirmation,
  validateQueueProperty,
  resolveQueueProperty,
} from "@/lib/importQueueHelpers";
import { rebuildDailyAggregates } from "@/lib/dailyAggregates";
import { queryClientInstance } from "@/lib/query-client";
import { toCents, formatCents } from "@/lib/decimal";
import { inspectUploadFile } from "@/lib/uploadGuard";
import BusinessMigrationCard from "@/components/BusinessMigrationCard";
import {
  evaluateImportAdmission,
  estimateAuthoritativeTransactionWrites,
  FREE_PLAN_SAFE_IMPORT_BUDGET,
} from "@/lib/d1WriteBudget";
import {
  isBulkImportEligible,
  executeBulkImport,
} from "@/lib/bulkImportPipeline";

// Per-import undo. Deletes exactly the rows one import created, via the
// rollback ledger — unlike "Clear all imported data", which wipes every table.
//
// Two-click confirm rather than a modal: this is destructive but precisely
// scoped and reversible by re-importing the file, so a full dialog would be
// heavier than the action warrants.
//
// Imports predating ledger tracking have no recorded ids. Rather than offer a
// button that always fails, those rows show nothing at all.
function UndoImportButton({ upload: u, disabled, onDone }) {
  const [confirming, setConfirming] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");

  if (!u.import_id) return null;
  // A re-upload where every row was already present wrote nothing, so it has no
  // ledger. Offering Undo here would produce a "cannot be undone" error for what
  // was actually a successful import — the dedupe case ImportOutcome shows as
  // "0 new". Undoing it would also be wrong: the rows belong to the earlier
  // import, and that one still has its own Undo.
  if (u.rows_imported != null && Number(u.rows_imported) === 0) return null;

  const run = async () => {
    // Same guards the other destructive paths use (import, clear-all), but
    // reported inline instead of via alert() — the button has somewhere to
    // put the message.
    const rateLimit = destructiveActionRateLimiter.check();
    if (!rateLimit.allowed) {
      setError(`Too many requests. Try again in ${Math.ceil(rateLimit.retryAfter / 60)} minutes.`);
      setConfirming(false);
      return;
    }
    if (!validateCsrfToken(getCsrfToken())) {
      setError("Invalid security token. Refresh the page and try again.");
      setConfirming(false);
      rotateCsrfToken();
      return;
    }
    setWorking(true);
    setError("");
    try {
      const res = await rollbackImportSession(u.import_id);
      if (!res.success) {
        setError(res.error || "Undo failed");
        setConfirming(false);
        return;
      }
      if (u.import_id && u.property_id) {
        fetch('/api/bulk-import/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bundle_id: u.import_id, server_property_id: u.property_id }),
        }).catch(() => {});
      }
      // Drop the history row too, so the list reflects that this import's data
      // is gone. Leaving it would imply the rows are still queryable.
      await db.entities.UploadedReport.delete(u.id);
      rotateCsrfToken();
      // Rebuild the materialized daily aggregate so the removed rows stop
      // contributing to the Dashboard's pre-summed metrics.
      rebuildDailyAggregates({ propertyId: u.property_id })
        .then(() => queryClientInstance.invalidateQueries({ queryKey: ["daily-aggregates"] }))
        .catch((e) => {
          console.warn("Daily aggregate rebuild failed:", e);
          setError("Failed to rebuild daily aggregates");
        });
      onDone?.();
    } catch (e) {
      setError(e.message || "Undo failed");
      setConfirming(false);
    } finally {
      setWorking(false);
    }
  };

  if (error) {
    return (
      <button
        onClick={() => setError("")}
        title={error}
        className="flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-[#FF6B6B]/30 px-2.5 py-1 text-xs text-[#FF6B6B] hover:bg-[#FF6B6B]/10"
      >
        <XCircle className="h-3.5 w-3.5 shrink-0" /> Undo failed
      </button>
    );
  }

  if (confirming) {
    return (
      <span className="flex items-center gap-1.5">
        <button
          onClick={run}
          disabled={working}
          className="flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-[#FF6B6B]/50 bg-[#FF6B6B]/10 px-2.5 py-1 text-xs text-[#FF6B6B] hover:bg-[#FF6B6B]/20 disabled:opacity-50"
        >
          {working ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" /> : <Trash2 className="h-3.5 w-3.5 shrink-0" />}
          {working ? "Undoing…" : "Confirm undo"}
        </button>
        <button
          onClick={() => setConfirming(false)}
          disabled={working}
          className="rounded-lg border border-white/10 px-2 py-1 text-xs text-slate-400 hover:bg-white/5 disabled:opacity-50"
        >
          Cancel
        </button>
      </span>
    );
  }

  return (
    <button
      onClick={() => setConfirming(true)}
      disabled={disabled}
      title="Delete only the rows this file created"
      className="flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-white/10 px-2.5 py-1 text-xs text-slate-400 transition-colors hover:border-[#FF6B6B]/40 hover:text-[#FF6B6B] disabled:opacity-40"
    >
      <RotateCcw className="h-3.5 w-3.5 shrink-0" /> Undo
    </button>
  );
}

// Import history outcome. A file that imported nothing because every row was
// already in the database is a normal, successful re-upload — it must not look
// identical to a file that failed to parse. Older records predate rows_skipped
// and can't tell the two apart, so they stay deliberately vague.
function ImportOutcome({ upload: u }) {
  const imported = Number(u.rows_imported) || 0;
  const skipped = u.rows_skipped == null ? null : Number(u.rows_skipped) || 0;
  const parsed = u.rows_parsed == null ? null : Number(u.rows_parsed) || 0;

  if (imported > 0) {
    return (
      <p className="flex items-center gap-2 whitespace-nowrap text-xs text-[#00E096]">
        <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
        {num(imported)} rows
        {skipped > 0 && (
          <span className="text-slate-500">· {num(skipped)} already imported</span>
        )}
      </p>
    );
  }

  // Nothing new landed. Why not?
  if (skipped > 0) {
    return (
      <p className="flex items-center gap-2 whitespace-nowrap text-xs text-[#FFB547]">
        <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
        0 new
        <span className="text-slate-500">· all {num(skipped)} already imported</span>
      </p>
    );
  }

  if (skipped === 0 && parsed === 0) {
    return (
      <p className="flex items-center gap-2 whitespace-nowrap text-xs text-[#FF6B6B]">
        <XCircle className="h-3.5 w-3.5 shrink-0" /> No rows found
      </p>
    );
  }

  return (
    <p className="flex items-center gap-2 whitespace-nowrap text-xs text-[#FFB547]">
      <XCircle className="h-3.5 w-3.5 shrink-0" />
      0 rows
      {parsed > 0 && <span className="text-slate-500">· {num(parsed)} parsed, none stored</span>}
    </p>
  );
}

const STATUS_LABEL = {
  pending: "Queued",
  scanning: "Scanning…",
  ready: "Ready to import",
  importing: "Importing…",
  done: "Imported",
  error: "Failed",
  duplicate: "Duplicate",
};

// Where a Hotel Statistics snapshot's date came from. The file itself has none,
// so the operator is told plainly whether the date was inferred or confirmed.
const DATE_SOURCE_LABEL = {
  explicit: "confirmed",
  filename: "read from the filename",
  file_modified: "guessed from the file date — check it",
  import_date: "defaulted to today — check it",
};

// Flatten a scan result into plain rows usable by the Chart Builder's custom datasets.
// HARD CAP: only the first 100 rows are retained as a preview. Storing every raw
// row for every import would balloon IndexedDB for no analytical benefit — the
// canonical data lives in the typed tables. A TTL sweep (see purgeExpiredUploadedReportRawRows)
// later nulls these previews out entirely once they age past RAW_ROWS_TTL_DAYS.
const RAW_ROWS_PREVIEW_LIMIT = 100;
const RAW_ROWS_TTL_DAYS = 90;

function scanRawRows(scan) {
  if (!scan) return [];
  let combined = [];
  if (Array.isArray(scan.rowsToImport) && scan.rowsToImport.length) combined = scan.rowsToImport;
  else {
    for (const arr of [scan.payments, scan.drops, scan.clerkPayments]) {
      if (Array.isArray(arr)) combined.push(...arr);
    }
  }
  return combined.slice(0, RAW_ROWS_PREVIEW_LIMIT);
}

function rawRowsTtlExpiry() {
  const d = new Date();
  d.setDate(d.getDate() + RAW_ROWS_TTL_DAYS);
  return d.toISOString();
}

export default function Import() {
  // Query OBJECTS, not just data. `uploadsQ.isError`/`propertiesQ.isError` drive
  // the ErrorState below: a failed read used to be indistinguishable from "no
  // uploads yet", which on this page reads as a clean slate right before someone
  // re-imports a month that is already in the database.
  const uploadsQ = useUploads();
  const propertiesQ = useProperties();
  const uploads = uploadsQ.data ?? [];
  const properties = propertiesQ.data ?? [];
  const refetch = uploadsQ.refetch;
  const readFailed = uploadsQ.isError ? uploadsQ : propertiesQ.isError ? propertiesQ : null;
  const { canAccessProperty } = useAuth();
  const [type, setType] = useState("auto");
  const [propertyId, setPropertyId] = useState("");
  const [forceImport, setForceImport] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentFile, setCurrentFile] = useState("");
  const [totalFiles, setTotalFiles] = useState(0);
  const [processed, setProcessed] = useState(0);
  const [queue, setQueue] = useState([]);
  const [importing, setImporting] = useState(false);
  const importingRef = useRef(false);
  const [expandedKey, setExpandedKey] = useState(null);
  const [results, setResults] = useState([]);
  const [search, setSearch] = useState("");
  const [driveFiles, setDriveFiles] = useState([]);
  const [driveLoading, setDriveLoading] = useState(false);
  const [driveError, setDriveError] = useState("");
  const [selectedFiles, setSelectedFiles] = useState(new Set());
  const [driveImporting, setDriveImporting] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [incompleteImports, setIncompleteImports] = useState([]);
  const [checkingImports, setCheckingImports] = useState(false);

  const accessibleProperties = useMemo(
    () => properties.filter((p) => canAccessProperty(p.id)),
    [properties, canAccessProperty]
  );
  const propertyOpts = accessibleProperties.map((p) => [p.id, p.name]);
  const selectedProperty = properties.find((p) => p.id === propertyId);

  // Resolve the property a queue item should import into. Queue items snapshot
  // the selection at scan time (item.propertyId), but older queues were built
  // before any property was chosen — or the selection changed after scanning.
  // Chain: item snapshot -> current selection -> single accessible property ->
  // single property in the roster. The last two steps are what un-breaks the
  // "10 files selected · 10 failed … propertyId is required" state: a
  // single-hotel operator who scans first and picks the property second can
  // still retry without re-uploading every file.
  // Resolve the property a queue item should import into following the strict canonical identity ladder:
  // CASE A: Snapshot ID authorized -> use snapshot directly (no reassignment).
  // CASE B: Authoritative alias -> canonicalize to matching property automatically.
  // CASE C: EMPTY snapshot + single property -> safe fallback.
  // CASE D: Nonempty revoked/unknown snapshot -> NEVER silently re-home, require operator reassignment.
  // CASE E: Multiple accessible properties -> require selection.
  // CASE F: Zero accessible properties -> fail closed.
  const resolveEffectiveProperty = (itemPid = "", itemPname = "", item = null) => {
    return resolveQueueProperty({
      item: item || (itemPid ? { propertyId: String(itemPid).trim(), propertyName: itemPname } : null),
      propertyId: String(propertyId || "").trim(),
      accessibleProperties,
    });
  };

  const friendlyImportError = (e) => {
    const msg = e?.message || "Import failed";
    // The persist boundary throws a fail-closed technical error when no
    // property is attached. Operators need an action, not an isolation lecture.
    if (e?.code === "IMPORT_PROPERTY_REQUIRED" || /non-empty propertyId is required/i.test(msg)) {
      return "Select a property above, then retry this file — it was scanned with no property attached so there was nowhere to store its rows.";
    }
    return msg;
  };

  useEffect(() => {
    if (accessibleProperties.length === 1 && !propertyId) {
      setPropertyId(accessibleProperties[0].id);
    }
  }, [accessibleProperties, propertyId]);

  // If the active property is deleted or access is revoked, reset the
  // selection. The queue is intentionally preserved: every item carries its
  // own property snapshot (094e135), and importSingle revalidates that
  // snapshot against current access before writing, so a revoked property
  // fails closed per item instead of wiping scannable work.
  useEffect(() => {
    if (propertyId && !accessibleProperties.some((p) => p.id === propertyId)) {
      setPropertyId("");
      setForceImport(false);
    }
  }, [accessibleProperties, propertyId]);

  const importMeta = (sourceFile) => {
    const eff = resolveEffectiveProperty("", "");
    return {
      propertyId: eff.id || propertyId,
      propertyName: eff.name || selectedProperty?.name || "",
      importId: crypto.randomUUID(),
      sourceFile: sourceFile || "",
    };
  };

  // Check for incomplete import sessions that can be resumed or rolled back
  const checkIncompleteImports = async () => {
    try {
      const sessions = await listImportSessions();
      const incomplete = sessions.filter(s => 
        s.status === 'in_progress' && 
        s.propertyId === propertyId &&
        Date.now() - new Date(s.startedAt).getTime() > 5 * 60 * 1000 // Older than 5 minutes
      );
      return incomplete;
    } catch {
      return [];
    }
  };

  // Automatically check for interrupted sessions when property selection changes
  useEffect(() => {
    if (!propertyId) {
      setIncompleteImports([]);
      return;
    }
    checkIncompleteImports().then((incomplete) => {
      if (incomplete?.length) setIncompleteImports(incomplete);
    });
  }, [propertyId]);

  const handlePropertyChange = (newPid) => {
    if (newPid === propertyId) return;
    // Queue is preserved across property switches: every item carries its own
    // property snapshot, and importSingle resolves per item (snapshot first),
    // so switching the dropdown never retargets an already-scanned file and
    // never forces a re-upload. Only the Force Import bypass is reset.
    setPropertyId(newPid);
    setForceImport(false);
  };

  const handleForceImportToggle = (enable) => {
    if (enable) {
      const ok = confirmForceImportToggle({
        propertyName: selectedProperty?.name,
        enabling: true,
      });
      if (!ok) return;
    }
    setForceImport(enable);
  };

  const handleFiles = async (fileList) => {
    const effUpload = resolveQueueProperty({
      propertyId: String(propertyId || "").trim(),
      accessibleProperties,
    });
    if (!effUpload.ok) {
      alert(effUpload.error || "Select a property before importing reports.");
      return;
    }

    const files = [];

    for (const f of Array.from(fileList)) {
      // Extension allowlist, executable denylist, 10MB cap and magic-byte
      // inspection all moved to src/lib/uploadGuard.js unchanged, so that
      // DataIntelligence.jsx — the other upload door into this same pipeline —
      // enforces exactly the same rules instead of only checking the extension.
      // Only the reporting stays here: this page alerts, that page toasts.
      const verdict = await inspectUploadFile(f);
      if (!verdict.ok) {
        alert(verdict.reason);
        continue;
      }
      files.push(f);
    }

    if (!files.length) return;
    const stamp = Date.now();
    // Snapshot the target property onto every queue item. importSingle resolves
    // through resolveEffectiveProperty(), so even if the dropdown changes (or
    // was empty at scan time and chosen later) each file still knows where its
    // rows belong and can be retried without re-uploading.
    const scanPid = String(effUpload.id).trim();
    const scanPname = effUpload.name || "";
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
      importId: crypto.randomUUID(),
      propertyId: scanPid,
      propertyName: scanPname,
      originalPropertyId: scanPid,
      originalPropertyName: scanPname,
      // Operator-supplied statement date, set from the queue row and only used by
      // Hotel Statistics (which ships no date column). Declared here rather than
      // appearing on first edit so the queue item has one stable shape.
      businessDate: "",
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
        // Read CSV files directly into memory to avoid blob URL fetch issues
        let csvText = null;
        if (/\.csv$/i.test(item.name)) {
          csvText = await item.file.text();
        }
        const { file_url } = await db.integrations.Core.UploadFile({ file: item.file });
        const scan = await scanReport(type, file_url, {
          propertyId: scanPid,
          propertyName: scanPname,
          importId: item.importId,
          sourceFile: item.name,
          // Hotel Statistics files carry no date of their own. The parser derives
          // one and says where it came from; the mtime is the best automatic
          // signal available in the browser, and the operator can correct it on
          // the queue row before importing.
          fileModified: item.file?.lastModified || null,
          businessDate: item.businessDate || "",
          csvText,
        });
        // Content hash (SHA-256) for duplicate detection before the import runs.
        const contentHash = await sha256File(item.file);
        const opCount = scan.totalRows || scan.rowsToImport?.length || 0;
        const isBulk = isBulkImportEligible(scan.type || type);
        const admission = evaluateImportAdmission(opCount, 0, 0, "free", { isBulkImport: isBulk });
        setQueue((prev) => prev.map((q) => (q.key === item.key ? {
          ...q,
          status: "ready",
          scan,
          file_url,
          contentHash,
          propertyId: scanPid,
          propertyName: scanPname,
          originalPropertyId: scanPid,
          originalPropertyName: scanPname,
          projectedWrites: admission.projectedWrites,
          isBudgetBlocked: !admission.admitted,
          budgetReason: admission.rejectionReason,
        } : q)));
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

  // Re-scan one queued file against an operator-supplied statement date.
  //
  // Only Hotel Statistics needs this: the export has no date column, so the
  // parser infers one and labels the source. Re-running the scan (rather than
  // patching the parsed rows) keeps the date on exactly one code path, so what
  // the preview shows is what gets stored.
  const rescanWithDate = async (item, businessDate) => {
    setQueue((prev) => prev.map((q) => (q.key === item.key ? { ...q, businessDate, status: "scanning" } : q)));
    try {
      const csvText = /\.csv$/i.test(item.name) ? await item.file.text() : null;
      const effRe = resolveEffectiveProperty(item.propertyId, item.propertyName, item);
      if (!effRe.ok || !effRe.id) {
        throw new Error(effRe.error || "Property resolution failed");
      }
      const scan = await scanReport(type, item.file_url, {
        propertyId: effRe.id,
        propertyName: effRe.name || "",
        importId: item.importId,
        sourceFile: item.name,
        fileModified: item.file?.lastModified || null,
        businessDate,
        csvText,
      });
      const opCount = scan.totalRows || scan.rowsToImport?.length || 0;
      const isBulk = isBulkImportEligible(scan.type || type);
      const admission = evaluateImportAdmission(opCount, 0, 0, "free", { isBulkImport: isBulk });
      setQueue((prev) => prev.map((q) => (q.key === item.key ? {
        ...q,
        status: "ready",
        scan,
        propertyId: effRe.id,
        propertyName: effRe.name || "",
        originalPropertyId: q.originalPropertyId || q.propertyId,
        originalPropertyName: q.originalPropertyName || q.propertyName,
        projectedWrites: admission.projectedWrites,
        isBudgetBlocked: !admission.admitted,
        budgetReason: admission.rejectionReason,
      } : q)));
    } catch (e) {
      setQueue((prev) => prev.map((q) => (q.key === item.key ? { ...q, status: "error", error: e.message || "Could not re-scan file" } : q)));
    }
  };

  const importSingle = async (item, { isBatch = false } = {}) => {
    if (!item.scan || item.status === "done") return null;
    if (item.isBudgetBlocked) {
      const msg = item.budgetReason || "File exceeds safe database write allowance for Free plan (~80k writes/day).";
      setQueue((prev) => prev.map((q) => (q.key === item.key ? { ...q, status: "error", error: msg } : q)));
      return { name: item.name, ok: false, error: msg };
    }
    // Resolve through the snapshot chain so a file scanned before the property
    // was chosen can still import once it is chosen — no re-upload required.
    // This is what repairs the stuck "10 failed … propertyId is required" queue:
    // the old code passed the then-empty dropdown value straight through.
    let targetItem = item;
    let eff = resolveEffectiveProperty(item.propertyId, item.propertyName, item);

    if (!eff.ok && eff.requiresReassignment) {
      const targetProp = accessibleProperties.find((p) => p.id === propertyId) || (accessibleProperties.length === 1 ? accessibleProperties[0] : null);
      if (!targetProp) {
        const msg = eff.error || "Multiple accessible properties available. Please select the target property above to reassign this file.";
        setQueue((prev) => prev.map((q) => (q.key === item.key ? { ...q, status: "error", error: msg } : q)));
        return { name: item.name, ok: false, error: msg };
      }
      const originId = String(item.originalPropertyId || item.propertyId || item.scan?.meta?.propertyId || item.scan?.propertyId || '').trim();
      const originName = item.originalPropertyName || item.propertyName || originId || "Previous Property";
      const oldTarget = originName ? `${originName} (${originId})` : originId;
      const newTarget = `${targetProp.name || targetProp.id} (${targetProp.id})`;
      const ok = confirmPropertyReassignment({
        oldTarget,
        newTarget,
        count: 1,
      });
      if (!ok) {
        const msg = "Reassignment cancelled by operator.";
        setQueue((prev) => prev.map((q) => (q.key === item.key ? { ...q, status: "error", error: msg } : q)));
        return { name: item.name, ok: false, error: msg };
      }
      targetItem = {
        ...item,
        originalPropertyId: originId,
        originalPropertyName: originName,
        confirmedFromPropertyId: originId,
        confirmedTargetPropertyId: String(targetProp.id),
        propertyId: targetProp.id,
        propertyName: targetProp.name || "",
        reassignedFromPropertyId: item.propertyId,
        reassignmentConfirmed: true,
        scan: item.scan ? {
          ...item.scan,
          propertyId: targetProp.id,
          meta: item.scan.meta ? {
            ...item.scan.meta,
            propertyId: targetProp.id,
            propertyName: targetProp.name || "",
          } : item.scan.meta,
        } : item.scan,
      };
      eff = resolveEffectiveProperty(targetItem.propertyId, targetItem.propertyName, targetItem);
    }

    if (!eff.ok || !eff.id) {
      const msg = eff.error || friendlyImportError({ message: "Select a property above, then retry this file — it was scanned with no property attached so there was nowhere to store its rows." });
      setQueue((prev) => prev.map((q) => (q.key === targetItem.key ? { ...q, status: "error", error: msg } : q)));
      return { name: targetItem.name, ok: false, error: msg };
    }
    // If the item was safely reassigned to the canonical/selected target,
    // update the item's target property and scan metadata so validateQueueProperty evaluates the target.
    const itemToValidate = eff.reassigned && eff.id !== targetItem.propertyId
      ? {
          ...targetItem,
          propertyId: eff.id,
          propertyName: eff.name,
          originalPropertyId: targetItem.originalPropertyId || targetItem.propertyId,
          originalPropertyName: targetItem.originalPropertyName || targetItem.propertyName,
          confirmedFromPropertyId: targetItem.confirmedFromPropertyId || eff.confirmedFromPropertyId,
          confirmedTargetPropertyId: targetItem.confirmedTargetPropertyId || eff.confirmedTargetPropertyId,
          reassignmentConfirmed: targetItem.reassignmentConfirmed || eff.reassigned,
          scan: targetItem.scan ? {
            ...targetItem.scan,
            propertyId: eff.id,
            meta: targetItem.scan.meta ? { ...targetItem.scan.meta, propertyId: eff.id, propertyName: eff.name } : targetItem.scan.meta,
          } : targetItem.scan,
        }
      : targetItem;

    // Hardening consistency check, evaluated against the RESOLVED property (not
    // just the live dropdown): revoked access fails closed, and a scan that
    // actually carries a different property id requires valid target-bound confirmation.
    // Empty scan properties (pre-snapshot queues) pass through to the fallback.
    const propCheck = validateQueueProperty({
      item: itemToValidate,
      propertyId: eff.id,
      accessibleProperties,
    });
    if (!propCheck.ok) {
      const friendly = friendlyImportError({ message: propCheck.error });
      setQueue((prev) => prev.map((q) => (q.key === item.key ? { ...q, status: "error", error: friendly } : q)));
      return { name: item.name, ok: false, error: friendly };
    }
    // Persist the resolution so a later retry (or a re-render) keeps it, preserving immutable provenance.
    if (eff.id !== item.propertyId || eff.name !== item.propertyName || eff.reassigned) {
      setQueue((prev) => prev.map((q) => (q.key === item.key ? {
        ...q,
        propertyId: eff.id,
        propertyName: eff.name,
        originalPropertyId: q.originalPropertyId || q.propertyId,
        originalPropertyName: q.originalPropertyName || q.propertyName,
        confirmedFromPropertyId: q.confirmedFromPropertyId || eff.confirmedFromPropertyId,
        confirmedTargetPropertyId: q.confirmedTargetPropertyId || eff.confirmedTargetPropertyId,
        reassignmentConfirmed: q.reassignmentConfirmed || eff.reassigned,
        scan: q.scan ? {
          ...q.scan,
          propertyId: eff.id,
          meta: q.scan.meta ? { ...q.scan.meta, propertyId: eff.id, propertyName: eff.name } : q.scan.meta,
        } : q.scan,
      } : q)));
    }
    const effPropertyId = eff.id;
    const effPropertyName = eff.name;
    // Rate limiting for imports (single import checks; batch import checks once
    // at batch level). Uses the IMPORT domain limiter — never the shared
    // security limiter, which caused false 58-minute lockouts on routine work.
    if (!isBatch) {
      const rateLimit = importRateLimiter.check();
      if (!rateLimit.allowed) {
        setQueue((prev) => prev.map((q) => (q.key === item.key ? { ...q, status: "error", error: `Rate limited. Try again in ${Math.ceil(rateLimit.retryAfter / 60)} minutes.` } : q)));
        return null;
      }
    }
    // CSRF validation
    const csrfToken = getCsrfToken();
    if (!validateCsrfToken(csrfToken)) {
      setQueue((prev) => prev.map((q) => (q.key === item.key ? { ...q, status: "error", error: "Invalid security token. Please refresh and try again." } : q)));
      rotateCsrfToken();
      return null;
    }
    setQueue((prev) => prev.map((q) => (q.key === item.key ? { ...q, status: "importing" } : q)));
    try {
      // ── Duplicate guard: a re-uploaded file hashes identically, so cancel the
      // import before it touches any financial calculation. Only skipped when the
      // operator explicitly forces the re-import.
      if (item.contentHash && !forceImport) {
        const existing = await withActionTimeout(
          db.entities.UploadedReport.filter({
            content_hash: item.contentHash,
            property_id: effPropertyId,
          }),
          15000,
          "Duplicate check timed out."
        );
        if (existing && existing.length > 0) {
          setQueue((prev) => prev.map((q) => (q.key === item.key ? {
            ...q,
            status: "duplicate",
            error: "Duplicate file — already imported. Use Force Import to re-import.",
          } : q)));
          return { name: item.name, ok: false, duplicate: true, error: "Duplicate file" };
        }
      }
      let result;
      try {
        // importReport is awaited DIRECTLY. A timeout here must never reject the
        // promise, unlock the queue, or trigger a rollback: the underlying
        // runTransaction keeps running, and rejecting it would let the batch
        // start File B while File A's transaction is still pending. The 35s
        // timer is informational only — it sets a truthful still-importing
        // notice and is cleared when the real import settles.
        let stillImportingNotified = false;
        const stillImportingTimer = setTimeout(() => {
          stillImportingNotified = true;
          setQueue((prev) => prev.map((q) => q.key === item.key
            ? { ...q, error: "Still importing… this file is taking longer than 35s. Do not start another import." }
            : q));
        }, 35000);
        try {
          if (isBulkImportEligible(item.scan?.type || type)) {
            let rawBytes = null;
            if (item.file) {
              try {
                rawBytes = new Uint8Array(await item.file.arrayBuffer());
              } catch {}
            }
            result = await executeBulkImport(item.scan, {
              propertyId: effPropertyId,
              propertyName: effPropertyName,
              importId: item.importId,
              sourceFile: item.name,
              forceImport,
              rawBytes,
            });
            if (result.duplicate) {
              setQueue((prev) => prev.map((q) => (q.key === item.key ? {
                ...q,
                status: "duplicate",
                error: result.reason || "Duplicate file — already imported. Use Force Import to re-import.",
              } : q)));
              return { name: item.name, ok: false, duplicate: true, error: "Duplicate file" };
            }
          } else {
            result = await importReport(item.scan, {
              propertyId: effPropertyId,
              propertyName: effPropertyName,
              importId: item.importId,
              sourceFile: item.name,
              forceImport,
            });
          }
        } finally {
          clearTimeout(stillImportingTimer);
          if (stillImportingNotified) {
            setQueue((prev) => prev.map((q) => q.key === item.key ? { ...q, error: "" } : q));
          }
        }
        // History is also an authoritative write. Await its real settlement;
        // a presentation timeout cannot prove that a late create did not land.
        // If it fails, the catch below rolls back the committed import session
        // before any later file may start.
        await db.entities.UploadedReport.create({
            file_name: item.name,
            report_type: item.scan.type || type,
            rows_imported: result.count,
            rows_skipped: result.excluded || 0,
            rows_parsed: item.scan.totalRows ?? null,
            file_url: item.file_url,
            property_id: effPropertyId,
            property_name: effPropertyName,
            import_id: result.importId || item.importId,
            source_file: item.name,
            content_hash: item.contentHash || null,
            raw_rows: scanRawRows(item.scan),
            raw_rows_ttl: rawRowsTtlExpiry(),
          });
      } catch (err) {
        // Roll back with the SESSION id, never our queue-local item.importId:
        // the ledger is keyed by the id createImportSession minted, so rolling
        // back with ours always found no ledger and silently did nothing.
        // Two sources, because rows can be committed by either failure:
        //   err.importId  - importReport itself threw (it attaches its id)
        //   result.importId - the import succeeded but writing the UploadedReport
        //                     history row failed, which would otherwise leave
        //                     committed rows with no history entry and so no
        //                     Undo button — invisible, unremovable data.
        // Neither present means the import was rejected before a session existed
        // (e.g. blocked validation), so there is nothing to undo.
        const sessionId = err?.importId || result?.importId;
        if (sessionId) {
          const res = await rollbackImportSession(sessionId).catch((e) => ({
            success: false,
            error: e?.message || "Rollback threw",
          }));
          // Never discard the result: a failed rollback means rows may still be
          // in the database, and the operator has to know that.
          if (!res?.success) {
            // The rollback itself failed, so we no longer know whether the
            // committed rows were removed. Mark the outcome as unverifiable so
            // the batch loop stops and every later file stays ready instead of
            // piling more writes on top of an unknown database state.
            err.authoritativeOutcomeUnknown = true;
            err.message = `${err.message || "Import failed"} — automatic cleanup ALSO failed: ${res?.error || "unknown error"}. Rows may remain in the database; do not re-import until this is resolved.`;
          } else {
            err.message = `${err.message || "Import failed"} — rolled back cleanly (0 rows stored).`;
          }
        }
        throw err;
      }
      setQueue((prev) => prev.map((q) => (q.key === item.key ? { ...q, status: "done", count: result.count, excluded: result.excluded || 0 } : q)));
      if (!isBatch) {
        rotateCsrfToken();
      }
      // Pre-compute the daily financial aggregates so the Dashboard reads a few
      // hundred pre-summed rows instead of the raw ledgers. Fire-and-forget: a
      // failure here must never fail the import that already succeeded.
      refreshAggregates(effPropertyId);
      return { name: item.name, ok: true, count: result.count, excluded: result.excluded || 0 };
    } catch (e) {
      const friendly = friendlyImportError(e);
      setQueue((prev) => prev.map((q) => (q.key === item.key ? { ...q, status: "error", error: friendly } : q)));
      return { name: item.name, ok: false, error: friendly, stopBatch: e?.authoritativeOutcomeUnknown === true };
    }
  };

  // Rebuild the materialized daily aggregate for a property and drop the stale
  // cache so the Dashboard recomputes from the fresh pre-summed rows.
  const refreshAggregates = (pid) => {
    rebuildDailyAggregates({ propertyId: pid })
      .then(() => queryClientInstance.invalidateQueries({ queryKey: ["daily-aggregates"] }))
      .catch((e) => console.warn("[import] daily aggregate rebuild skipped:", e?.message));
  };

  const handleImportAll = async () => {
    // Include retryable failures: files that scanned fine but failed to import
    // (e.g. the old "propertyId is required" queue) carry scan data and can be
    // retried now that a property resolves — without forcing a re-upload.
    const blocked = queue.filter((q) => (q.status === "ready" || q.status === "error") && q.scan && q.isBudgetBlocked);
    if (blocked.length > 0 && !importingRef.current && !importing) {
      alert(`Cannot import: ${blocked.length} file(s) exceed the safe Free plan database write allowance (~80,000 writes/day).`);
    }
    const pending = queue.filter((q) => (q.status === "ready" || q.status === "error") && q.scan && !q.isBudgetBlocked);
    if (!pending.length || importingRef.current || importing) return;

    // Check if any pending items require explicit reassignment
    const itemsNeedingReassignment = pending.filter((item) => {
      const eff = resolveEffectiveProperty(item.propertyId, item.propertyName, item);
      return !eff.ok && eff.requiresReassignment;
    });

    let queueItemsToProcess = pending;
    if (itemsNeedingReassignment.length > 0) {
      const targetProp = accessibleProperties.find((p) => p.id === propertyId) || (accessibleProperties.length === 1 ? accessibleProperties[0] : null);
      if (!targetProp) {
        alert("Some queued files were scanned for properties that are no longer accessible. Please select a target property above to reassign them.");
        return;
      }

      // Group files strictly by immutable origin ID (not display name alone)
      const groupsByOrigin = groupQueueByOrigin(itemsNeedingReassignment);

      // Prompt separately for EACH distinct origin group
      // BATCH ATOMICITY PREFERENCE:
      // If ANY required group is cancelled/refused, abort Import All before any writes!
      let allApproved = true;
      const targetUpdates = new Map();

      for (const [originId, group] of groupsByOrigin.entries()) {
        const oldTarget = group.originName ? `${group.originName} (${originId})` : originId;
        const newTarget = `${targetProp.name || targetProp.id} (${targetProp.id})`;
        const ok = confirmPropertyReassignment({
          oldTarget,
          newTarget,
          count: group.items.length,
        });
        if (!ok) {
          allApproved = false;
          break;
        }
        for (const item of group.items) {
          targetUpdates.set(item.key, {
            ...item,
            originalPropertyId: originId,
            originalPropertyName: group.originName,
            confirmedFromPropertyId: originId,
            confirmedTargetPropertyId: String(targetProp.id),
            propertyId: targetProp.id,
            propertyName: targetProp.name || "",
            reassignedFromPropertyId: item.propertyId,
            reassignmentConfirmed: true,
            scan: item.scan ? {
              ...item.scan,
              propertyId: targetProp.id,
              meta: item.scan.meta ? {
                ...item.scan.meta,
                propertyId: targetProp.id,
                propertyName: targetProp.name || "",
              } : item.scan.meta,
            } : item.scan,
          });
        }
      }

      if (!allApproved) {
        alert("Batch import cancelled. All files requiring reassignment must be confirmed before batch import begins.");
        return;
      }

      queueItemsToProcess = pending.map((item) => targetUpdates.get(item.key) || item);
      setQueue((prev) => prev.map((q) => targetUpdates.get(q.key) || q));
    }

    const effAll = resolveEffectiveProperty("", "");
    const canResolveAny = queueItemsToProcess.some((item) => {
      const eff = resolveEffectiveProperty(item.propertyId, item.propertyName, item);
      return Boolean(eff.id);
    });

    if (!effAll.id && !canResolveAny) {
      alert("Select a property before importing reports.");
      return;
    }

    // If Force Import is active, confirm batch operation explicitly
    if (forceImport && !confirmBatchForceImport({ propertyName: selectedProperty?.name, count: pending.length })) {
      return;
    }

    // Rate limiting - UI batch action level
    const rateLimit = importRateLimiter.check();
    if (!rateLimit.allowed) {
      alert(`Too many requests. Try again in ${Math.ceil(rateLimit.retryAfter / 60)} minutes.`);
      return;
    }
    // CSRF validation
    const csrfToken = getCsrfToken();
    if (!validateCsrfToken(csrfToken)) {
      alert("Invalid security token. Please refresh the page and try again.");
      rotateCsrfToken();
      return;
    }
    importingRef.current = true;
    setImporting(true);
    const newResults = [];
    try {
      for (const item of queueItemsToProcess) {
        try {
          const r = await importSingle(item, { isBatch: true });
          if (r) newResults.push(r);
          // A failed rollback leaves the database outcome unverifiable. Stop the
          // batch so later files stay ready instead of writing on top of an
          // unknown state.
          if (r?.stopBatch) break;
        } catch (itemErr) {
          console.error(`[import] Error importing ${item.name}:`, itemErr);
          const friendly = friendlyImportError(itemErr);
          setQueue((prev) => prev.map((q) => (q.key === item.key ? { ...q, status: "error", error: friendly } : q)));
          newResults.push({ name: item.name, ok: false, error: friendly });
        }
      }
      setResults(newResults);
    } catch (e) {
      setImporting(false);
      alert(`Import failed: ${e.message || "unknown error"}.`);
      return;
    } finally {
      importingRef.current = false;
      setImporting(false);
      rotateCsrfToken();
    }
    refetch();
  };

  const handleRemoveFromQueue = (key) => {
    if (importingRef.current || importing || busy) return;
    setQueue((prev) => prev.filter((q) => q.key !== key));
  };

  const handleClearAll = async () => {
    if (clearing || importingRef.current || importing || busy) return;
    // Rate limiting for destructive actions
    const rateLimit = destructiveActionRateLimiter.check();
    if (!rateLimit.allowed) {
      alert(`Too many requests. Try again in ${Math.ceil(rateLimit.retryAfter / 60)} minutes.`);
      return;
    }
    // CSRF validation
    const csrfToken = getCsrfToken();
    if (!validateCsrfToken(csrfToken)) {
      alert("Invalid security token. Please refresh the page and try again.");
      rotateCsrfToken();
      return;
    }
    const ok = window.confirm(
      "Delete ALL imported report data and import history?\n\nThis permanently removes every imported row from this browser (occupancy, sources, gross revenue, payments, clerk records, hotel statistics, transactions), along with the import history and the undo information for those imports. Properties, staff, payroll and settings are kept.\n\nThis cannot be undone."
    );
    if (!ok) return;
    setClearing(true);
    try {
      // Delegated to src/lib/importReset.js, which owns the set of stores an import
      // writes to and derives the per-report-type ones from reportParsers' own map.
      // This handler used to keep its own literal array of table names, and that copy
      // named only the data tables — so a clear-all left the rollback ledger and the
      // import history behind, and the page went on offering "Undo" for imports whose
      // rows were gone (scripts/probe-clear-all-rollback.mjs).
      const removed = await clearAllImportedData({ propertyId: "all" });
      queryClientInstance.invalidateQueries({ queryKey: ["daily-aggregates"] });
      setQueue([]);
      setResults([]);
      refetch();
      rotateCsrfToken();
      // Reported rather than assumed: the counts come back from the clear itself.
      window.alert(
        `Removed ${removed.deletedRows.toLocaleString()} imported row${removed.deletedRows === 1 ? "" : "s"}, ` +
        `${removed.sessions} import${removed.sessions === 1 ? "" : "s"} from the history, ` +
        `and ${removed.ledgerRows} undo record${removed.ledgerRows === 1 ? "" : "s"}.`
      );
    } catch (e) {
      console.error("Failed to clear imported data:", e);
      window.alert(`Could not clear data: ${e.message || "unknown error"}`);
    } finally {
      setClearing(false);
    }
  };

  // Backfill the materialized daily aggregate for existing (already-imported) data
  // without re-importing files. Runs over the selected property, or every
  // property when "All" is selected. The Dashboard falls back to live ledgers
  // until this completes, then reads the pre-summed cache.
  const handleRebuildAggregates = async () => {
    if (rebuilding) return;
    setRebuilding(true);
    try {
      const target = propertyId && propertyId !== "all" ? propertyId : "all";
      await rebuildDailyAggregates({ propertyId: target });
      queryClientInstance.invalidateQueries({ queryKey: ["daily-aggregates"] });
    } catch (e) {
      console.error("Failed to rebuild aggregates:", e);
      window.alert(`Could not rebuild aggregates: ${e?.message || "unknown error"}`);
    } finally {
      setRebuilding(false);
    }
  };

  // Base queue metrics come from the hardening helper so every counter has one
  // owner. retryableCount is the property-fix extension: error items that
  // still carry scan data can be retried without re-uploading.
  const {
    readyCount: baseReadyCount,
    queuedCount,
    doneItems,
    errorItems,
    duplicateItems,
    batchImported,
    batchExcluded,
  } = getQueueMetrics(queue);
  const retryableCount = queue.filter((q) => q.status === "error" && q.scan && !q.isBudgetBlocked).length;
  const readyCount = queue.filter((q) => q.status === "ready" && q.scan && !q.isBudgetBlocked).length + retryableCount;
  const budgetBlockedCount = queue.filter((q) => q.isBudgetBlocked).length;

  const handleRetrySingle = async (item) => {
    let targetItem = item;
    const eff = resolveEffectiveProperty(item.propertyId, item.propertyName, item);
    if (!eff.ok && eff.requiresReassignment) {
      const targetProp = accessibleProperties.find((p) => p.id === propertyId) || (accessibleProperties.length === 1 ? accessibleProperties[0] : null);
      if (!targetProp) {
        setQueue((prev) => prev.map((q) => (q.key === item.key ? {
          ...q,
          status: "error",
          error: eff.error || "Multiple accessible properties available. Please select the target property above to reassign this file.",
        } : q)));
        alert(eff.error || "Multiple accessible properties available. Please select the target property above to reassign this file.");
        return;
      }
      const originId = String(item.originalPropertyId || item.propertyId || item.scan?.meta?.propertyId || item.scan?.propertyId || '').trim();
      const originName = item.originalPropertyName || item.propertyName || originId || "Previous Property";
      const oldTarget = originName ? `${originName} (${originId})` : originId;
      const newTarget = `${targetProp.name || targetProp.id} (${targetProp.id})`;
      const ok = confirmPropertyReassignment({
        oldTarget,
        newTarget,
        count: 1,
      });
      if (!ok) {
        setQueue((prev) => prev.map((q) => (q.key === item.key ? {
          ...q,
          status: "error",
          error: "Reassignment cancelled by operator.",
        } : q)));
        return;
      }
      targetItem = {
        ...item,
        originalPropertyId: originId,
        originalPropertyName: originName,
        confirmedFromPropertyId: originId,
        confirmedTargetPropertyId: String(targetProp.id),
        propertyId: targetProp.id,
        propertyName: targetProp.name || "",
        reassignedFromPropertyId: item.propertyId,
        reassignmentConfirmed: true,
        scan: item.scan ? {
          ...item.scan,
          propertyId: targetProp.id,
          meta: item.scan.meta ? {
            ...item.scan.meta,
            propertyId: targetProp.id,
            propertyName: targetProp.name || "",
          } : item.scan.meta,
        } : item.scan,
      };
      setQueue((prev) => prev.map((q) => (q.key === item.key ? targetItem : q)));
    }

    setQueue((prev) => prev.map((q) => (q.key === item.key ? { ...targetItem, status: "ready", error: "" } : q)));
    const res = await importSingle({ ...targetItem, status: "ready", error: "" });
    if (res) {
      setResults((prev) => [...prev, res]);
      refetch();
    }
    return res;
  };

  // Single writer for the per-row Import and Retry buttons. It owns the global
  // `importing` flag so two row actions can never overlap: the second click is
  // refused while the first import (and its transaction) is still in flight.
  //
  // The guard is a ref, not the `importing` state: React state is captured by
  // the render closure, so two clicks in the same tick would both observe
  // `importing === false` and both start a transaction. A ref updates
  // synchronously, so the second click is refused before it reaches importSingle.
  const runSingleItem = async (item, options = {}) => {
    if (importingRef.current || importing || busy) return null;
    importingRef.current = true;
    setImporting(true);
    try {
      if (options.retry) {
        return await handleRetrySingle(item);
      }
      return await importSingle(item, options);
    } finally {
      importingRef.current = false;
      setImporting(false);
    }
  };

  const handleRetryAllFailed = async () => {
    if (importingRef.current || importing || busy) return;
    setQueue((prev) =>
      prev.map((q) => (q.status === "error" || q.status === "duplicate" ? { ...q, status: "ready", error: "" } : q))
    );
  };

  const handleRollbackInterrupted = async (session) => {
    if (!session?.importId) return;
    try {
      await rollbackImportSession(session.importId);
      setIncompleteImports((prev) => prev.filter((s) => s.importId !== session.importId));
      refetch();
    } catch (e) {
      alert(`Could not roll back interrupted session: ${e?.message || e}`);
    }
  };

  const handleBrowseDrive = async () => {
    if (!propertyId) {
      alert("Select a property before importing reports.");
      return;
    }
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
    const effDrive = resolveEffectiveProperty("", "");
    if (!effDrive.id) {
      alert("Select a property before importing reports.");
      return;
    }
    if (!selectedFiles.size || !type) return;
    setDriveImporting(true);
    const meta = { propertyId: effDrive.id, propertyName: effDrive.name, importId: crypto.randomUUID(), sourceFile: "", forceImport };
    for (const fileId of selectedFiles) {
      const fileInfo = driveFiles.find((f) => f.id === fileId);
      const fileName = fileInfo?.name || fileId;
      setCurrentFile(fileName);
      let result;
      try {
        const res = await db.functions.invoke("importDriveFile", { fileId, fileName });
        const fileUrl = res.data.file_url;
        const scan = await scanReport(type, fileUrl, { ...meta, sourceFile: fileName });
        if (isBulkImportEligible(scan.type || type)) {
          result = await executeBulkImport(scan, { ...meta, sourceFile: fileName });
        } else {
          result = await importReport(scan, { ...meta, sourceFile: fileName });
        }
        await db.entities.UploadedReport.create({
          file_name: fileName,
          report_type: scan.type || type,
          rows_imported: result.count,
          rows_skipped: result.excluded || 0,
          rows_parsed: scan.totalRows ?? null,
          file_url: fileUrl,
          property_id: effDrive.id,
          property_name: effDrive.name,
          import_id: result.importId || meta.importId,
          source_file: fileName,
          drive_file_id: fileId,
          raw_rows: scanRawRows(scan),
          raw_rows_ttl: rawRowsTtlExpiry(),
        });
        refreshAggregates(effDrive.id);
        setResults((prev) => [...prev, { name: fileName, ok: true, count: result.count, excluded: result.excluded || 0 }]);
      } catch (e) {
        // Same cleanup contract as the file-upload path above: this branch used
        // to have no rollback at all, so a Drive import that committed rows and
        // then failed left them in the ledger with no history row and no Undo.
        let message = friendlyImportError(e?.response?.data ? { ...e, message: e.response.data.error } : e);
        const sessionId = e?.importId || result?.importId;
        if (sessionId) {
          const rb = await rollbackImportSession(sessionId).catch((err) => ({
            success: false,
            error: err?.message || "Rollback threw",
          }));
          if (!rb?.success) {
            message = `${message} — automatic cleanup ALSO failed: ${rb?.error || "unknown error"}. Rows may remain in the database; do not re-import until this is resolved.`;
          }
        }
        setResults((prev) => [...prev, { name: fileName, ok: false, error: message }]);
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

  const historyParentRef = useRef();
  
  const rowVirtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => historyParentRef.current,
    estimateSize: () => 74,
    overscan: 10,
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

      <BusinessMigrationCard />

      {readFailed && (
        <ErrorState
          title={readFailed === propertiesQ ? "Properties could not be loaded" : "Upload history could not be loaded"}
          description={
            readFailed === propertiesQ
              ? "The property list is needed before any report can be imported. Importing into the wrong property would misattribute revenue, so imports stay disabled until this loads."
              : "Past uploads may exist that are not shown. Re-importing the same file while this fails could create rows the duplicate filter cannot see. Retry before importing."
          }
          error={readFailed.error}
          onRetry={() => { refetch(); propertiesQ.refetch(); }}
        />
      )}

      <Card title="Target property" subtitle="Select which property these reports belong to">
        <div className="flex items-center gap-3">
          <Building2 className="h-5 w-5 text-[#6C63FF]" />
          {accessibleProperties.length > 0 ? (
            <div className="min-w-[280px] flex-1">
              <ResponsiveSelect
                value={propertyId}
                onValueChange={handlePropertyChange}
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

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
            <input
              type="checkbox"
              checked={forceImport}
              onChange={(e) => handleForceImportToggle(e.target.checked)}
              className="h-4 w-4 rounded border-white/20"
            />
            Force import (bypass duplicate check — re-import already loaded data)
          </label>
          {forceImport && (
            <span className="rounded-md border border-[#FF6B6B]/40 bg-[#FF6B6B]/10 px-2.5 py-1 text-xs text-[#FF6B6B]">
              ⚠ FORCE IMPORT ACTIVE for {selectedProperty?.name || "selected property"} — duplicate checks bypassed
            </span>
          )}
        </div>

        <label
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            if (!propertyId) {
              alert("Select a property before importing reports.");
              return;
            }
            if (busy) return;
            handleFiles(e.dataTransfer.files);
          }}
          className={`mt-5 flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed px-6 py-12 text-center transition-colors ${
            !propertyId
              ? "cursor-not-allowed border-white/10 opacity-40"
              : "cursor-pointer border-white/15 bg-[#0A1628]/60 hover:border-[#00D4FF]/60"
          }`}
        >
          <UploadCloud className="h-7 w-7 text-[#00D4FF]" />
          <span className="text-sm text-slate-300">
            {!propertyId
              ? "Select a property before importing reports."
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
              if (!propertyId) {
                alert("Select a property before importing reports.");
                return;
              }
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
                    disabled={importing}
                    className="flex items-center gap-2 rounded-lg bg-[#00E096] px-5 py-2 text-sm font-medium text-[#040D1A] transition-colors hover:bg-[#00c885] disabled:opacity-50"
                  >
                    {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowDownToLine className="h-4 w-4" />}
                    {importing ? "Importing…" : retryableCount > 0 ? `Retry Failed (${readyCount})` : `Import All (${readyCount})`}
                  </button>
                )}
                {!importing && !busy && (
                  <button
                    onClick={async () => {
                      setCheckingImports(true);
                      const incomplete = await checkIncompleteImports();
                      setIncompleteImports(incomplete);
                      setCheckingImports(false);
                    }}
                    disabled={checkingImports}
                    className="flex items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-sm text-slate-400 transition-colors hover:border-[#FFB547]/60 hover:text-[#FFB547] disabled:opacity-50"
                  >
                    {checkingImports ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                    {checkingImports ? "Checking…" : "Check Interrupted"}
                  </button>
                )}
                {errorItems.length > 0 && (
                  <>
                    <button
                      onClick={handleRetryAllFailed}
                      disabled={importing}
                      className="flex items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-sm text-[#00D4FF] transition-colors hover:border-[#00D4FF]/60 hover:bg-[#00D4FF]/10 disabled:opacity-50"
                    >
                      <RefreshCw className="h-3.5 w-3.5" /> Retry failed ({errorItems.length})
                    </button>
                    <button
                      onClick={() => setQueue((prev) => prev.filter((q) => q.status !== "error" && q.status !== "duplicate"))}
                      disabled={importing}
                      className="flex items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-sm text-slate-400 transition-colors hover:border-[#FF6B6B]/60 hover:text-[#FF6B6B] disabled:opacity-50"
                    >
                      <Trash2 className="h-3.5 w-3.5" /> Clear failed
                    </button>
                  </>
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
                      ) : q.status === "duplicate" ? (
                        <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-[#FFB547]" />
                      ) : q.status === "ready" ? (
                        <FileSpreadsheet className="h-3.5 w-3.5 shrink-0 text-[#6C63FF]" />
                      ) : (
                        <FileSpreadsheet className="h-3.5 w-3.5 shrink-0 text-slate-500" />
                      )}
                      <span className="truncate">{q.name}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      {q.isBudgetBlocked && (
                        <span
                          className="rounded-full bg-[#FF6B6B]/15 px-2.5 py-0.5 text-xs text-[#FF6B6B]"
                          title={q.budgetReason}
                        >
                          ⚠ Exceeds write budget (~{q.projectedWrites?.toLocaleString()} writes)
                        </span>
                      )}
                      <span
                        className={`rounded-full px-2.5 py-0.5 text-xs ${
                          q.status === "done"
                            ? "bg-[#00E096]/15 text-[#00E096]"
                            : q.status === "error"
                            ? "bg-[#FF6B6B]/15 text-[#FF6B6B]"
                            : q.status === "duplicate"
                            ? "bg-[#FFB547]/15 text-[#FFB547]"
                            : q.status === "ready"
                            ? "bg-[#6C63FF]/15 text-[#6C63FF]"
                            : "bg-white/5 text-slate-400"
                        }`}
                      >
                        {q.status === "done"
                          ? `${q.count} rows${q.excluded ? ` · ${q.excluded} excluded` : ""}`
                          : STATUS_LABEL[q.status] || q.status}
                      </span>
                      {(q.status === "ready" || q.status === "done" || (q.status === "error" && q.scan)) && (
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
                          onClick={async () => {
                            const r = await runSingleItem(q);
                            if (r) { setResults((prev) => [...prev, r]); refetch(); }
                          }}
                          disabled={importing || q.isBudgetBlocked}
                          title={q.isBudgetBlocked ? q.budgetReason : "Import"}
                          className={`rounded-lg px-3 py-1 text-xs transition-colors disabled:opacity-40 ${
                            q.isBudgetBlocked
                              ? "bg-slate-700 text-slate-400 cursor-not-allowed"
                              : "bg-[#6C63FF]/20 text-[#6C63FF] hover:bg-[#6C63FF]/35"
                          }`}
                        >
                          Import
                        </button>
                      )}
                      {(q.status === "error" || q.status === "duplicate") && (
                        <button
                          onClick={() => runSingleItem(q, { retry: true })}
                          disabled={importing}
                          className="rounded-lg bg-[#00D4FF]/20 px-3 py-1 text-xs text-[#00D4FF] transition-colors hover:bg-[#00D4FF]/35 disabled:opacity-40"
                          title="Retry import"
                        >
                          Retry
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

                  {q.scan?.type === "hotel_statistics" && q.status !== "done" && (
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                      <label className="flex items-center gap-2 text-slate-400">
                        Statement date
                        <input
                          type="date"
                          value={q.scan.businessDate || ""}
                          onChange={(e) => e.target.value && rescanWithDate(q, e.target.value)}
                          className="rounded-md border border-white/10 bg-[#0A1628] px-2 py-1 text-slate-200 outline-none focus:border-[#6C63FF]"
                        />
                      </label>
                      <span className={q.scan.businessDateSource === "explicit" ? "text-[#00E096]" : "text-[#FFB547]"}>
                        {DATE_SOURCE_LABEL[q.scan.businessDateSource] || q.scan.businessDateSource}
                      </span>
                    </div>
                  )}

                  {(q.status === "error" || q.status === "duplicate" || (q.status === "importing" && q.error)) && q.error && (
                    <p className={`mt-1 text-xs ${q.status === "duplicate" || q.status === "importing" ? "text-[#FFB547]" : "text-[#FF6B6B]"}`}>
                      {q.error}
                    </p>
                  )}

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
      {q.scan.debug && (
        <>
          <span className="text-[#FFB547]">Raw: {q.scan.debug.rawRowCount}</span>
          <span className="text-[#FFB547]">Objects: {q.scan.debug.objectCount}</span>
          {q.scan.debug.dateParseErrors && (
            <span className="text-[#FF6B6B]">Date parse errors: {q.scan.debug.dateParseErrors}</span>
          )}
          {q.scan.debug.sampleHeaders.length > 0 && (
            <span className="text-slate-500">Headers: {q.scan.debug.sampleHeaders.slice(0, 8).join(", ")}</span>
          )}
        </>
      )}
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
    {q.scan.checksum && (
      // The ledger's agreement with its own declared total is the one number an
      // operator should see before importing money. It was computed on every
      // scan and never shown.
      <div className={`flex items-center justify-between rounded-lg border px-3 py-2 text-xs ${
        q.scan.checksum.matches === false
          ? "border-[#FF6B6B]/30 bg-[#FF6B6B]/[0.06] text-[#FF6B6B]"
          : q.scan.checksum.matches === null
            ? "border-[#FFB547]/30 bg-[#FFB547]/[0.06] text-[#FFB547]"
            : "border-[#00E096]/30 bg-[#00E096]/[0.06] text-[#00E096]"
      }`}>
        <span>
          {q.scan.checksum.matches === false
            ? "Amounts do not match the file's own total"
            : q.scan.checksum.matches === null
              ? "This file declares no total to check against"
              : "Amounts match the file's own total"}
        </span>
        <span className="font-mono">
          {formatCents(toCents(q.scan.checksum.parsed))}
          {q.scan.checksum.declared !== null && q.scan.checksum.matches === false && (
            <span className="text-slate-400"> vs {formatCents(toCents(q.scan.checksum.declared))}</span>
          )}
        </span>
      </div>
    )}
    {!q.scan.validation && q.scan.errors?.length > 0 && (
      // Fallback for a scan that reported problems without a validation object.
      // Nothing read `scan.errors` before, so a parser's own error list was
      // discarded in silence; this guarantees it reaches the operator.
      <ul className="space-y-1 rounded-lg border border-[#FF6B6B]/30 bg-[#FF6B6B]/[0.06] p-3">
        {q.scan.errors.map((e, i) => (
          <li key={i} className="text-xs text-[#FF6B6B]">{String(e)}</li>
        ))}
      </ul>
    )}
    {q.scan.validation && (q.scan.validation.errors?.length > 0 || q.scan.validation.warnings?.length > 0) && (
      <div className="rounded-lg border border-white/10 bg-[#040D1A]/60 p-3">
        <p className={`mb-2 text-xs ${q.scan.validation.ok ? "text-[#FFB547]" : "text-[#FF6B6B]"}`}>
          {q.scan.validation.ok
            ? `${q.scan.validation.warnings.length} thing(s) worth checking`
            : `${q.scan.validation.errors.length} problem(s) that will block this import`}
        </p>
        <ul className="space-y-1">
          {[...q.scan.validation.errors, ...q.scan.validation.warnings].map((f, i) => (
            <li key={i} className="flex items-start gap-2 text-xs">
              <span className={`mt-0.5 shrink-0 rounded px-1 text-[10px] ${f.severity === "error" ? "bg-[#FF6B6B]/15 text-[#FF6B6B]" : "bg-[#FFB547]/15 text-[#FFB547]"}`}>
                {f.severity === "error" ? "BLOCKS" : "WARN"}
              </span>
              <span className="text-slate-300">
                <span className="font-medium text-white">[{f.code}]</span> {f.message}
              </span>
            </li>
          ))}
        </ul>
        {!forceImport && !q.scan.validation.ok && (
          <p className="mt-2 text-[11px] text-[#FF6B6B]">This import will be rejected. Tick "Force import" on the batch to proceed anyway.</p>
        )}
      </div>
    )}
    {q.scan.debug && q.scan.debug.sampleObject && (
      <details className="mt-2">
        <summary className="text-xs text-slate-500 cursor-pointer">Show raw first row</summary>
        <pre className="mt-1 max-h-32 overflow-auto rounded-lg border border-white/10 bg-[#040D1A]/60 p-2 text-[10px] text-slate-300">
          {JSON.stringify(q.scan.debug.sampleObject, null, 2)}
        </pre>
      </details>
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

        {incompleteImports.length > 0 && (
          <div className="mt-4 rounded-xl border border-[#FFB547]/20 bg-[#FFB547]/[0.06] px-4 py-3">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 h-5 w-5 shrink-0 text-[#FFB547]">⚠</span>
              <div className="flex-1">
                <p className="text-sm font-medium text-slate-200">
                  Found {incompleteImports.length} interrupted import session{incompleteImports.length === 1 ? "" : "s"}.
                </p>
                <p className="text-xs text-slate-400">
                  These imports were started but never completed. They may have been interrupted by browser refresh, power loss, or network issues. You can roll them back cleanly to prevent orphaned data.
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {incompleteImports.map((imp) => (
                    <button
                      key={imp.importId || imp.id}
                      onClick={() => handleRollbackInterrupted(imp)}
                      className="flex items-center gap-1.5 rounded-lg border border-[#FFB547]/30 bg-[#FFB547]/10 px-2.5 py-1 text-xs text-[#FFB547] transition-colors hover:bg-[#FFB547]/20"
                    >
                      <RefreshCw className="h-3 w-3" /> Roll back interrupted ({imp.reportType || imp.report_type || "session"})
                    </button>
                  ))}
                </div>
              </div>
              <button
                onClick={() => setIncompleteImports([])}
                className="text-slate-500 hover:text-white"
                title="Dismiss"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
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
            <div className="flex shrink-0 items-center gap-2">
              <button
                onClick={handleRebuildAggregates}
                disabled={rebuilding || clearing || busy || importing}
                title="Pre-compute the daily financial aggregate for fast Dashboard loads"
                className="flex items-center gap-2 rounded-lg border border-[#00E096]/30 px-3 py-1.5 text-xs text-[#00E096] transition-colors hover:bg-[#00E096]/10 hover:border-[#00E096]/60 disabled:opacity-50"
              >
                {rebuilding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                {rebuilding ? "Rebuilding…" : "Rebuild cached aggregates"}
              </button>
              <button
                onClick={handleClearAll}
                disabled={clearing || busy || importing}
                className="flex shrink-0 items-center gap-2 rounded-lg border border-[#FF6B6B]/30 px-3 py-1.5 text-xs text-[#FF6B6B] transition-colors hover:bg-[#FF6B6B]/10 hover:border-[#FF6B6B]/60 disabled:opacity-50"
              >
                {clearing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                {clearing ? "Clearing…" : "Clear all imported data"}
              </button>
            </div>
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
        <div className="space-y-2 max-h-[600px] overflow-auto" ref={historyParentRef}>
          <div style={{ height: `${rowVirtualizer.getTotalSize()}px`, width: '100%', position: 'relative' }}>
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const u = filtered[virtualRow.index];
              return (
                <div 
                  key={u.id} 
                  style={{ 
                    position: 'absolute', 
                    top: 0, 
                    left: 0, 
                    width: '100%', 
                    height: `${virtualRow.size - 8}px`, // -8 for gap
                    transform: `translateY(${virtualRow.start}px)`
                  }}
                  className="flex items-center justify-between gap-3 rounded-xl border border-white/5 bg-[#0A1628]/60 px-4 py-3"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <FileSpreadsheet className="h-4 w-4 shrink-0 text-[#6C63FF]" />
                    <div className="min-w-0">
                      <p className="truncate text-sm text-white">{u.file_name}</p>
                      <p className="text-xs text-slate-500">
                        {u.property_name || "—"} · {u.report_type} · {String(u.created_date || "").slice(0, 10)}
                      </p>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <ImportOutcome upload={u} />
                    <UndoImportButton
                      upload={u}
                      disabled={busy || importing || clearing}
                      onDone={refetch}
                    />
                  </div>
                </div>
              );
            })}
          </div>
          {!filtered.length && (
            <EmptyState
              icon={UploadCloud}
              title={uploads.length ? "No matching files" : "No imports yet"}
              description={uploads.length ? "No results match your search." : "Upload your first report to start tracking performance."}
            />
          )}
        </div>
      </Card>
    </div>
  );
}
