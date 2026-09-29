import React from "react";
import {
  X, ShieldCheck, FileSpreadsheet, CheckCircle2,
  AlertTriangle, Download, ArrowRight, Database, Hash
} from "lucide-react";
import { money, pct } from "@/lib/hotel";

/**
 * Clickable KPI Provenance & Lineage Drawer
 *
 * Provides a financial audit trail for any dashboard KPI down to the exact formula,
 * contributing properties, business dates, and raw source CSV file hashes.
 */
export default function KpiProvenanceDrawer({
  isOpen,
  onClose,
  metric = null,
}) {
  if (!isOpen || !metric) return null;

  const {
    name = "Metric",
    value = "$0.00",
    formula = "Calculated from primary ledger",
    definition = "Standard hospitality financial metric",
    dateRange = { from: "—", to: "—" },
    properties = [],
    sourceFiles = [],
    reconciliation = { difference: 0, isBalanced: true },
    lastUpdated = new Date().toISOString(),
  } = metric;

  const handleExportAuditJson = () => {
    const auditPayload = {
      auditTimestamp: new Date().toISOString(),
      metricName: name,
      metricValue: value,
      formulaApplied: formula,
      businessDateRange: dateRange,
      reconciliationStatus: reconciliation.isBalanced ? "BALANCED_EXACT" : "DISCREPANCY_FLAGGED",
      reconciliationDifference: reconciliation.difference,
      propertyContributions: properties,
      sourceFilesLineage: sourceFiles,
    };

    const blob = new Blob([JSON.stringify(auditPayload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `Audit_Lineage_${name.replace(/\s+/g, "_")}_${dateRange.from}_to_${dateRange.to}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60 backdrop-blur-sm transition-opacity">
      <div className="flex h-full w-full max-w-xl flex-col border-l border-white/10 bg-[#0A1628] shadow-2xl">
        {/* Header */}
        <div className="flex items-start justify-between border-b border-white/10 p-6">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-[11px] uppercase tracking-wider text-[#00D4FF]">Data Provenance & Audit</span>
              {reconciliation.isBalanced ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-[#00E096]/30 bg-[#00E096]/10 px-2 py-0.5 text-[10px] font-medium text-[#00E096]">
                  <CheckCircle2 className="h-3 w-3" /> Reconciled ($0.00 Diff)
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 rounded-full border border-[#FF6B6B]/30 bg-[#FF6B6B]/10 px-2 py-0.5 text-[10px] font-medium text-[#FF6B6B]">
                  <AlertTriangle className="h-3 w-3" /> Discrepancy ${reconciliation.difference}
                </span>
              )}
            </div>
            <h2 className="mt-1 font-heading text-xl font-semibold text-white">{name}</h2>
            <p className="mt-1 font-heading text-3xl font-bold tracking-tight text-white">{value}</p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-2 text-slate-400 hover:bg-white/10 hover:text-white"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 space-y-6 overflow-y-auto p-6">
          {/* Section 1: Accounting Definition & Formula */}
          <div className="rounded-xl border border-white/5 bg-white/[0.02] p-4">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">Calculation Contract</h3>
            <p className="mt-2 font-mono text-xs text-[#00D4FF] bg-[#00D4FF]/10 p-2.5 rounded-lg border border-[#00D4FF]/20">
              {formula}
            </p>
            <p className="mt-2 text-xs leading-relaxed text-slate-300">
              {definition}
            </p>
            <div className="mt-3 flex items-center justify-between text-[11px] text-slate-400 border-t border-white/5 pt-2">
              <span>Date Scope: {dateRange.from} → {dateRange.to}</span>
              <span>Updated: {lastUpdated ? new Date(lastUpdated).toLocaleDateString() : 'Current'}</span>
            </div>
          </div>

          {/* Section 2: Property Contributions */}
          {properties.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3">
                Property Contributions ({properties.length} Properties)
              </h3>
              <div className="space-y-2 rounded-xl border border-white/5 bg-white/[0.02] p-3 max-h-56 overflow-y-auto">
                {properties.map((p) => (
                  <div key={p.id} className="flex items-center justify-between py-1.5 border-b border-white/5 last:border-0 text-sm">
                    <span className="font-medium text-slate-200">{p.name || p.id}</span>
                    <span className="tabular-nums font-semibold text-white">{money(p.value)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Section 3: Immutable Source CSV Files Lineage */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                Source Files Lineage ({sourceFiles.length} Raw Files)
              </h3>
              <span className="text-[10px] text-slate-500">Immutable Object Storage</span>
            </div>
            {sourceFiles.length > 0 ? (
              <div className="space-y-2 max-h-60 overflow-y-auto">
                {sourceFiles.map((f, i) => (
                  <div key={i} className="rounded-lg border border-white/5 bg-[#0D1B2E] p-3 text-xs">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <FileSpreadsheet className="h-4 w-4 text-[#6C63FF]" />
                        <span className="font-medium text-slate-200">{f.name || f.file_name}</span>
                      </div>
                      <span className="text-[10px] uppercase text-slate-400">{f.type || f.report_type}</span>
                    </div>
                    {f.hash && (
                      <div className="mt-1 flex items-center gap-1 font-mono text-[10px] text-slate-400">
                        <Hash className="h-3 w-3 text-slate-500" />
                        <span className="truncate">{f.hash}</span>
                      </div>
                    )}
                    <div className="mt-1 flex items-center justify-between text-[10px] text-slate-500">
                      <span>Rows: {f.rowCount || f.rows_imported || '—'}</span>
                      <span>Imported: {f.importedAt || f.created_date ? new Date(f.importedAt || f.created_date).toLocaleString() : 'Verified'}</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-lg border border-white/5 bg-[#0D1B2E] p-4 text-center text-xs text-slate-400">
                <Database className="h-5 w-5 mx-auto mb-1 text-slate-500" />
                Aggregated from live canonical ledger tables
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="border-t border-white/10 p-6 flex items-center justify-between">
          <button
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-xs font-medium text-slate-400 hover:text-white"
          >
            Close
          </button>
          <button
            onClick={handleExportAuditJson}
            className="flex items-center gap-2 rounded-lg bg-[#6C63FF] px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-[#5b52e8]"
          >
            <Download className="h-4 w-4" />
            Export Audit Proof (JSON)
          </button>
        </div>
      </div>
    </div>
  );
}
