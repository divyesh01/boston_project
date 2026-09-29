import { useState, useRef, useEffect, useMemo } from 'react';
import {
  FileSpreadsheet, UploadCloud, Search, AlertTriangle,
  BarChart3, Zap, Download, RefreshCw, Eye, Trash2,
  Gauge, Clock, Database, GitMerge,
  XSquare, AlertCircle, Info, Share2, Lightbulb,
  PauseCircle, PlayCircle, Settings,
  FileDown, CheckCircle2, DollarSign, Layers,
  ShieldCheck, ArrowUpRight, FileText, Check, ChevronRight, X
} from 'lucide-react';
import Card from '@/components/ui-exec/Card';
import KpiCard from '@/components/ui-exec/KpiCard';
import SegmentedControl from '@/components/ui-exec/SegmentedControl';
import { DataScanner as DataScannerClass } from '@/lib/dataScanner';
import AIInsightsEngine from '@/lib/aiInsights';
import { db } from '@/api/base44Client';
import { useQuery } from '@tanstack/react-query';
import { useGlobalFilters } from '@/lib/useGlobalFilters';
import { formatNumber, toCents, fromCents, sumCents, formatCents } from '@/lib/decimal';
import { ErrorState } from '@/components/ui/status';
import { toast } from 'sonner';
import { inspectUploadFile } from '@/lib/uploadGuard';
import { readJsonSetting, writeJsonSetting, reportDiscardedSetting } from '@/lib/settingsStore';
import { evaluatePortfolioDataHealth, reconcileFinancialTotals } from '@/lib/dataHealth';
import { downloadOwnerPerformancePacket } from '@/lib/ownerPacketExport';
import { CalculationService } from '@/lib/calculationService';

const SEVERITY_COLORS = {
  critical: 'border-[#FF6B6B]/30 bg-[#FF6B6B]/[0.08] text-[#FF6B6B]',
  high: 'border-[#FF6B6B]/20 bg-[#FF6B6B]/[0.06] text-[#FF6B6B]',
  medium: 'border-[#FFB547]/20 bg-[#FFB547]/[0.06] text-[#FFB547]',
  low: 'border-slate-500/20 bg-slate-500/[0.06] text-slate-400',
  info: 'border-[#00D4FF]/20 bg-[#00D4FF]/[0.06] text-[#00D4FF]',
};

const SEVERITY_BG = {
  critical: 'bg-[#FF6B6B]/15',
  high: 'bg-[#FF6B6B]/10',
  medium: 'bg-[#FFB547]/10',
  low: 'bg-slate-500/10',
  info: 'bg-[#00D4FF]/10',
};

function useFiles() {
  return useQuery({
    queryKey: ['data-files'],
    queryFn: async () => {
      // Through db.entities, not localDb: `localDb.UploadedReport.toArray()` is a
      // raw table read with no property scope, so the file browser and the preview
      // pane listed uploads belonging to properties this user cannot access.
      // db.entities.UploadedReport.list() applies applyScope() — and it is what
      // every other reader of this table already uses (useHotelData, dataScanner,
      // uploadRetention, Import).
      const files = await db.entities.UploadedReport.list();
      return files.map((f) => ({
        id: f.id,
        name: f.file_name,
        type: f.report_type,
        rows: f.raw_rows || [],
        rowCount: f.rows_imported,
        date: f.created_date,
        propertyId: f.property_id,
        propertyName: f.property_name,
        fileUrl: f.file_url,
      }));
    },
  });
}

function useAllEntities() {
  return useQuery({
    queryKey: ['all-entities'],
    queryFn: async () => {
      const result = {};
      const tables = ['OccupancyDay', 'SourceDay', 'GrossRevenueDay', 'PaymentDay', 'ClerkShiftRecord'];
      for (const table of tables) {
        try {
          result[table] = await db.entities[table].filter({}, '-created_date', 5000);
        } catch {
          result[table] = [];
        }
      }
      return result;
    },
  });
}

/**
 * Reads a stored list, refusing a value of the wrong shape.
 *
 * Both keys feed panels that call `.map` on the result, so a slot holding an
 * object or a string — an older format, a hand-edited value, a collision with
 * another tool — would throw during render and blank the page. settingsStore has
 * `readObjectSetting` for the opposite requirement but no list equivalent, so the
 * check lives here with the two callers that need it.
 *
 * @param {string} key
 * @returns {Array} the stored list, or [] with the reason reported
 */
function readStoredList(key) {
  const value = readJsonSetting(key, []);
  if (Array.isArray(value)) return value;
  reportDiscardedSetting(key, `expected a list, stored value is ${value === null ? 'null' : typeof value}`);
  return [];
}

export default function DataIntelligence() {
  const { property, properties, dateRange } = useGlobalFilters();
  const filesQ = useFiles();
  const entitiesQ = useAllEntities();
  const { data: files = [], refetch } = filesQ;
  const { data: existingData = {} } = entitiesQ;

  const [activeTab, setActiveTab] = useState('health');
  const [inspectPropertyId, setInspectPropertyId] = useState(null);
  const [propertySearchTerm, setPropertySearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [scanning, setScanning] = useState(false);
  const [scanResults, setScanResults] = useState([]);
  const [automationRules, setAutomationRules] = useState([]);
  const [reportHistory, setReportHistory] = useState([]);
  const [searchTerm, setSearchTerm] = useState('');
  const fileInputRef = useRef(null);
  const scanner = useMemo(() => new DataScannerClass(), []);
  const aiEngine = useMemo(() => new AIInsightsEngine(scanner), [scanner]);

  // This page's own two storage keys used to fail in silence. The writes were
  // `try { localStorage.setItem(...) } catch {}` followed UNCONDITIONALLY by
  // setState, so a blocked or full store discarded the write while the panel went
  // on showing the rule as saved — the owner only discovers it on the next visit,
  // when the rule is gone. The reads swallowed too, substituting [] for whatever
  // was stored. Both now go through settingsStore.js, which names the key in the
  // report and returns false so the toast can tell the truth. Identical defect and
  // identical fix to the money settings; see that module's header for why the
  // shared helper exists rather than nine hand-corrected copies.
  useEffect(() => {
    setAutomationRules(readStoredList('rri_automationRules'));
    setReportHistory(readStoredList('rri_reportHistory'));
  }, []);

  const saveAutomationRules = (rules) => {
    if (!writeJsonSetting('rri_automationRules', rules)) {
      toast.error('Automation rules could not be saved — they apply until you close this tab, then revert.');
    }
    // State updates either way: the rules ARE live in this session, and throwing
    // away work the owner just did would be a worse answer than warning them it
    // is not durable.
    setAutomationRules(rules);
  };

  const saveReportHistory = (history) => {
    if (!writeJsonSetting('rri_reportHistory', history)) {
      toast.error('Report history could not be saved — this run will be missing from the list next time.');
    }
    setReportHistory(history);
  };

  const handleUpload = async (fileList) => {
    // This page used to accept anything whose NAME ended in .csv/.xlsx/.xls — no
    // size cap, no magic-byte check — while Import.jsx enforced all three on the
    // same pipeline. One shared gate now guards both doors; see
    // src/lib/uploadGuard.js. Rejections are surfaced per file rather than as a
    // single "no valid files" message, so the user learns WHICH file was refused
    // and why.
    const picked = Array.from(fileList);
    const validFiles = [];
    for (const f of picked) {
      const verdict = await inspectUploadFile(f);
      if (verdict.ok) {
        validFiles.push(f);
      } else {
        toast.error(verdict.reason);
      }
    }
    // An empty drop (a folder, a URL, a text selection) is a different event from
    // "every file you gave me was refused", which has already produced one toast
    // per file above. The old code printed the same message for both; saying
    // nothing at all for the empty case would be the same conflation in reverse.
    if (!picked.length) {
      toast.error('No files found. Drop a .csv, .xlsx or .xls file.');
      return;
    }
    if (!validFiles.length) return;

    setScanning(true);
    const newResults = [];

    for (let i = 0; i < validFiles.length; i++) {
      const file = validFiles[i];
      try {
        const { file_url } = await db.integrations.Core.UploadFile({ file });
        let text = '';

        const fileExt = file.name.split('.').pop().toLowerCase();
        if (fileExt === 'csv' || fileExt === 'txt') {
          const res = await fetch(file_url);
          text = await res.text();
        } else {
          const res = await db.integrations.Core.ExtractDataFromUploadedFile({
            file_url: file_url,
            json_schema: {
              type: 'array',
              items: { type: 'object' },
            },
          });
          text = JSON.stringify(res.output || []);
        }

        const parsed = scanner.parseFileContent(text, file.name);
        const existingKeys = files
          .filter((f) => f.propertyId === file.name)
          .map((f) => ({
            fileName: f.name,
            headers: [],
            rows: f.rows || [],
            propertyId: f.propertyId,
          }));

        const scanResult = scanner.fullScan(
          parsed.rows,
          parsed.headers,
          file.name,
          existingKeys
        );

        scanResult.fileId = file.name;
        scanResult.fileUrl = file_url;
        scanResult.originalFile = file;
        newResults.push(scanResult);
      } catch (e) {
        console.error('Scan error:', e);
        toast.error(`Failed to scan ${file.name}: ${e.message || 'Unknown error'}`);
      }
    }

    setScanResults((prev) => [...newResults, ...prev]);
    setScanning(false);
    refetch();
  };

  const handleAutoFix = async (fileId, action) => {
    const scanResult = scanResults.find((s) => s.fileId === fileId);
    if (!scanResult) return;

    const issues = scanResult.issues.filter((i) => i.applyAutoFix);
    if (!issues.length) {
      toast('No auto-fixable issues found');
      return;
    }

    toast.loading(`Applying fixes to ${scanResult.fileName}...`, { id: `fix-${fileId}` });

    const fixResult = scanner.autoFix(scanResult.rows, scanResult.headers, issues, [action]);

    const newScan = scanner.fullScan(
      fixResult.cleanedRows,
      scanResult.headers,
      scanResult.fileName,
      scanResults
        .filter((s) => s.fileId !== fileId)
        .map((s) => ({ fileName: s.fileName, headers: s.headers, rows: s.rows }))
    );
    newScan.fileId = fileId;
    newScan.fileUrl = scanResult.fileUrl;
    newScan.originalFile = scanResult.originalFile;
    newScan.fixHistory = [{ action, timestamp: new Date().toISOString(), result: fixResult }];

    setScanResults((prev) =>
      prev.map((s) => (s.fileId === fileId ? { ...newScan, appliedFixes: [...(s.appliedFixes || []), action] } : s))
    );

    toast.success(
      `Applied ${action} to ${scanResult.fileName}: ${fixResult.cleanedCount} rows remaining (was ${fixResult.originalCount})`,
      { id: `fix-${fileId}` }
    );
  };

  const generateReport = async () => {
    const report = scanner.generateReport(scanResults);
    const aiReport = await aiEngine.generateComprehensiveInsights(scanResults, existingData, {
      propertyId: property,
      propertyName: properties.find((p) => p.id === property)?.name,
    });

    const fullReport = {
      ...report,
      aiInsights: aiReport,
      scanResults: scanResults.map((s) => ({
        fileName: s.fileName,
        rowCount: s.rowCount,
        healthScore: s.healthScore,
        issueCount: s.issues?.length || 0,
        keyIssues: (s.issues || []).slice(0, 10),
      })),
    };

    const history = [...reportHistory, { ...fullReport, generatedAt: new Date().toISOString() }];
    if (history.length > 20) history.shift();
    saveReportHistory(history);

    return fullReport;
  };

  const handleExportReport = async (_format = 'json') => {
    const report = await generateReport();
    toast.success(`Generated analysis report for ${scanResults.length} file(s)`);
    return report;
  };

  const aggregateStats = useMemo(() => {
    if (!scanResults.length) return null;

    const totalRows = scanResults.reduce((a, s) => a + (s.rowCount || 0), 0);
    const totalIssues = scanResults.reduce((a, s) => a + (s.issues?.length || 0), 0);
    const avgHealth = scanResults.reduce((a, s) => a + (s.healthScore?.score || 0), 0) / scanResults.length;

    const issuesBySeverity = scanResults
      .flatMap((s) => s.issues || [])
      .reduce(
        (acc, i) => {
          acc[i.severity] = (acc[i.severity] || 0) + 1;
          return acc;
        },
        { critical: 0, high: 0, medium: 0, low: 0, info: 0 }
      );

    const issuesByType = scanResults
      .flatMap((s) => s.issues || [])
      .reduce((acc, i) => {
        acc[i.type] = (acc[i.type] || 0) + 1;
        return acc;
      }, {});

    return {
      totalFiles: scanResults.length,
      totalRows,
      totalIssues,
      avgHealth: Math.round(avgHealth),
      issuesBySeverity,
      issuesByType,
      grades: scanResults.map((s) => ({ name: s.fileName, score: s.healthScore?.score || 0, grade: s.healthScore?.grade || 'F' })),
    };
  }, [scanResults]);

  // Both reads used to fail into a blank that reads as "nothing here yet": the
  // file list printed "No files uploaded yet" (so the operator re-uploads a
  // report already imported), and the existing-data read fed the overlap and
  // duplicate checks, so a file compared against nothing scored as clean.
  const readErrorBanner = (filesQ.isError || entitiesQ.isError) ? (
    <ErrorState
      className="mt-6"
      title="Could not read your existing data"
      description="The uploaded-file list and the already-imported rows could not be read, so this page cannot tell you what is already in the system. A file scanned now would be compared against nothing and come back clean, and an empty file list is not proof a report has not been imported — re-uploading it would duplicate the rows."
      error={filesQ.error || entitiesQ.error}
      onRetry={() => { filesQ.refetch(); entitiesQ.refetch(); }}
    />
  ) : null;

  const dataByProperty = useMemo(() => {
    const map = {};
    for (const p of properties) {
      map[p.id] = {
        occRows: [],
        srcRows: [],
        grossRows: [],
        payRows: [],
        uploadedReports: [],
      };
    }
    (existingData.OccupancyDay || []).forEach((r) => {
      if (map[r.property_id]) map[r.property_id].occRows.push(r);
    });
    (existingData.SourceDay || []).forEach((r) => {
      if (map[r.property_id]) map[r.property_id].srcRows.push(r);
    });
    (existingData.GrossRevenueDay || []).forEach((r) => {
      if (map[r.property_id]) map[r.property_id].grossRows.push(r);
    });
    (existingData.PaymentDay || []).forEach((r) => {
      if (map[r.property_id]) map[r.property_id].payRows.push(r);
    });
    (files || []).forEach((f) => {
      if (map[f.propertyId]) map[f.propertyId].uploadedReports.push(f);
    });
    return map;
  }, [properties, existingData, files]);

  const portfolioHealth = useMemo(() => {
    return evaluatePortfolioDataHealth(properties, dataByProperty, dateRange);
  }, [properties, dataByProperty, dateRange]);

  const financialReconciliation = useMemo(() => {
    const isFiltered = property && property !== 'all';
    const filterFn = (r) => (!isFiltered ? true : r.property_id === property);

    const occRows = (existingData.OccupancyDay || []).filter(filterFn);
    const grossRows = (existingData.GrossRevenueDay || []).filter(filterFn);
    const srcRows = (existingData.SourceDay || []).filter(filterFn);
    const payRows = (existingData.PaymentDay || []).filter(filterFn);

    const grossFromGrossLedger = sumCents(grossRows.map((r) => r.room_rent || r.gross_revenue || 0));
    const grossFromOcc = sumCents(occRows.map((r) => r.room_revenue || 0));
    const reportedCents = grossFromGrossLedger > 0 ? grossFromGrossLedger : grossFromOcc;
    const calculatedCents = sumCents(srcRows.map((r) => r.net_revenue || r.revenue || 0));
    const paymentsCents = sumCents(payRows.map((r) => r.total || 0));

    const recon = reconcileFinancialTotals(fromCents(reportedCents), fromCents(calculatedCents));

    const byProperty = properties.map((prop) => {
      const pGross = sumCents((dataByProperty[prop.id]?.grossRows || []).map((r) => r.room_rent || r.gross_revenue || 0)) ||
                     sumCents((dataByProperty[prop.id]?.occRows || []).map((r) => r.room_revenue || 0));
      const pCalc = sumCents((dataByProperty[prop.id]?.srcRows || []).map((r) => r.net_revenue || r.revenue || 0));
      const pPay = sumCents((dataByProperty[prop.id]?.payRows || []).map((r) => r.total || 0));
      const pRecon = reconcileFinancialTotals(fromCents(pGross), fromCents(pCalc));
      return {
        propertyId: prop.id,
        propertyName: prop.name,
        reported: pRecon.reported,
        calculated: pRecon.calculated,
        payments: fromCents(pPay),
        difference: pRecon.difference,
        isBalanced: pRecon.isBalanced,
      };
    });

    return {
      reported: recon.reported,
      calculated: recon.calculated,
      payments: fromCents(paymentsCents),
      difference: recon.difference,
      isBalanced: recon.isBalanced,
      byProperty,
    };
  }, [property, properties, existingData, dataByProperty]);

  const handleExportOwnerPacket = () => {
    try {
      const kpis = CalculationService.calculateOccupancyMetrics(existingData.OccupancyDay || [], {});
      const channelMetrics = CalculationService.calculateChannelMetrics(existingData.SourceDay || []);
      const propertyStats = CalculationService.calculatePerPropertyStats(existingData.OccupancyDay || [], properties);

      const dateLabel = dateRange?.from && dateRange?.to
        ? `${dateRange.from} to ${dateRange.to}`
        : 'Current Portfolio Period';

      downloadOwnerPerformancePacket({
        dateRangeLabel: dateLabel,
        properties,
        kpis,
        propertyStats,
        prevPropertyStats: [],
        channelMetrics,
        portfolioHealth,
        reconciliation: financialReconciliation,
      });

      toast.success('Downloaded Monthly Owner Performance Packet (.xlsx)');
    } catch (err) {
      console.error('Owner packet export failed:', err);
      toast.error(`Export failed: ${err.message || 'Unknown error'}`);
    }
  };

  const filteredHealthProperties = useMemo(() => {
    let list = portfolioHealth.properties || [];
    if (statusFilter !== 'all') {
      list = list.filter((p) => p.status === statusFilter);
    }
    if (propertySearchTerm.trim()) {
      const q = propertySearchTerm.toLowerCase();
      list = list.filter((p) =>
        p.propertyName.toLowerCase().includes(q) || p.propertyId.toLowerCase().includes(q)
      );
    }
    return list;
  }, [portfolioHealth.properties, statusFilter, propertySearchTerm]);

  const inspectedProperty = useMemo(() => {
    if (!inspectPropertyId) return null;
    return portfolioHealth.properties.find((p) => p.propertyId === inspectPropertyId) || null;
  }, [portfolioHealth.properties, inspectPropertyId]);

  const TAB_OPTIONS = [
    { value: 'health', label: `Portfolio Completeness (${portfolioHealth.properties.length})` },
    { value: 'reconciliation', label: 'Financial Reconciliation ($0.00 Check)' },
    { value: 'scanner', label: 'Data Scanner & Cleaner' },
    { value: 'files', label: `Uploaded Reports (${files.length})` },
  ];

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-[11px] uppercase tracking-[0.3em] text-[#00D4FF]">Owner Intelligence Center</p>
          <h1 className="mt-1 font-heading text-3xl font-semibold text-white">Data Health & Financial Reconciliation</h1>
          <p className="mt-1 text-sm text-slate-400">
            Portfolio completeness, missing night audit detection, and cent-exact ledger agreement across 25+ hotels.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={handleExportOwnerPacket}
            className="flex items-center gap-2 rounded-lg bg-gradient-to-r from-[#6C63FF] to-[#00D4FF] px-4 py-2 text-sm font-semibold text-[#040D1A] shadow-md hover:brightness-110 active:scale-[0.98] transition-all"
            title="Download comprehensive 4-sheet executive Excel packet"
          >
            <FileDown className="h-4 w-4" />
            <span>Export Owner Packet (.xlsx)</span>
          </button>
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={scanning}
            className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-[#0A1628] px-3.5 py-2 text-sm font-medium text-slate-300 hover:border-[#00D4FF]/60 hover:text-white transition-colors"
          >
            <UploadCloud className="h-4 w-4 text-[#00D4FF]" />
            <span>Upload Reports</span>
          </button>
        </div>
      </header>

      {/* Hidden file input for header & dropzone uploads */}
      <input
        type="file"
        ref={fileInputRef}
        accept=".csv,.xlsx,.xls"
        multiple
        className="hidden"
        disabled={scanning}
        onChange={(e) => {
          handleUpload(e.target.files);
          e.target.value = '';
        }}
      />

      <div className="border-b border-white/5 pb-2">
        <SegmentedControl
          options={TAB_OPTIONS}
          value={activeTab}
          onChange={setActiveTab}
          size="md"
        />
      </div>

      {readErrorBanner}

      {/* ─────────────────────────────────────────────────────────────────────────────
          TAB 1: PORTFOLIO DATA HEALTH & COMPLETENESS GRID
          ───────────────────────────────────────────────────────────────────────────── */}
      {activeTab === 'health' && (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard
              label="Portfolio Health Score"
              value={`${portfolioHealth.portfolioScore}/100`}
              accent="#00E096"
              icon={Gauge}
              sub="Weighted average across all properties"
            />
            <KpiCard
              label="All Reports Current"
              value={`${portfolioHealth.healthyCount} Hotels`}
              accent="#00D4FF"
              icon={CheckCircle2}
              sub="100% daily night audit continuity"
            />
            <KpiCard
              label="Partial Gaps Detected"
              value={`${portfolioHealth.warningCount} Hotels`}
              accent="#FFB547"
              icon={AlertTriangle}
              sub="1 to 5 missing daily report files"
            />
            <KpiCard
              label="Missing Critical Data"
              value={`${portfolioHealth.criticalCount} Hotels`}
              accent="#FF6B6B"
              icon={AlertCircle}
              sub="Score below 70% or >5 days missing"
            />
          </div>

          <Card
            title="Portfolio Data Continuity Grid"
            subtitle="Real-time ingestion status across Occupancy, Revenue, Source, and Payment daily ledgers"
            right={
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
                  <input
                    type="text"
                    placeholder="Filter properties..."
                    value={propertySearchTerm}
                    onChange={(e) => setPropertySearchTerm(e.target.value)}
                    className="w-44 rounded-lg border border-white/10 bg-[#040D1A] py-1 pl-8 pr-3 text-xs text-slate-200 outline-none focus:border-[#00D4FF]"
                  />
                </div>
                <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-[#040D1A] p-0.5 text-xs">
                  {['all', 'critical', 'warning', 'healthy'].map((st) => (
                    <button
                      key={st}
                      onClick={() => setStatusFilter(st)}
                      className={'rounded px-2 py-0.5 font-medium transition-colors ' + (
                        statusFilter === st
                          ? 'bg-white/10 text-white'
                          : 'text-slate-400 hover:text-slate-200'
                      )}
                    >
                      {st.charAt(0).toUpperCase() + st.slice(1)}
                    </button>
                  ))}
                </div>
              </div>
            }
          >
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm text-slate-300">
                <thead className="border-b border-white/5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  <tr>
                    <th className="pb-3 pr-4">Hotel Property</th>
                    <th className="pb-3 px-3">Data Score</th>
                    <th className="pb-3 px-3">Occupancy</th>
                    <th className="pb-3 px-3">Revenue Ledger</th>
                    <th className="pb-3 px-3">Channel Mix</th>
                    <th className="pb-3 px-3">Payments</th>
                    <th className="pb-3 px-3 text-center">Missing Dates</th>
                    <th className="pb-3 px-3">Latest Report</th>
                    <th className="pb-3 pl-3 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {filteredHealthProperties.map((p) => {
                    const totalMissing =
                      (p.missingDates?.occupancy?.length || 0) +
                      (p.missingDates?.revenue?.length || 0) +
                      (p.missingDates?.source?.length || 0) +
                      (p.missingDates?.payment?.length || 0);

                    return (
                      <tr key={p.propertyId} className="hover:bg-white/[0.02] transition-colors">
                        <td className="py-3 pr-4">
                          <p className="font-medium text-white">{p.propertyName}</p>
                          <p className="text-[11px] text-slate-500 font-mono">{p.propertyId}</p>
                        </td>
                        <td className="py-3 px-3">
                          <div className="flex items-center gap-2">
                            <span
                              className="inline-block h-2 w-2 rounded-full"
                              style={{ backgroundColor: p.badgeColor }}
                            />
                            <span className="font-semibold text-white">{p.overallScore}%</span>
                            <span
                              className="rounded px-1.5 py-0.5 text-[10px] font-medium"
                              style={{
                                color: p.badgeColor,
                                backgroundColor: `${p.badgeColor}15`,
                                border: `1px solid ${p.badgeColor}30`,
                              }}
                            >
                              {p.statusLabel}
                            </span>
                          </div>
                        </td>
                        <td className="py-3 px-3">
                          <CompletenessBar percent={p.completeness?.occupancy ?? 100} />
                        </td>
                        <td className="py-3 px-3">
                          <CompletenessBar percent={p.completeness?.revenue ?? 100} />
                        </td>
                        <td className="py-3 px-3">
                          <CompletenessBar percent={p.completeness?.source ?? 100} />
                        </td>
                        <td className="py-3 px-3">
                          <CompletenessBar percent={p.completeness?.payment ?? 100} />
                        </td>
                        <td className="py-3 px-3 text-center">
                          {totalMissing === 0 ? (
                            <span className="inline-flex items-center gap-1 text-xs text-[#00E096]">
                              <Check className="h-3.5 w-3.5" /> None
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 rounded-full bg-[#FF6B6B]/15 px-2 py-0.5 text-xs font-semibold text-[#FF6B6B] border border-[#FF6B6B]/30">
                              {totalMissing} missing
                            </span>
                          )}
                        </td>
                        <td className="py-3 px-3 text-xs text-slate-400 font-mono">
                          {p.latestDates?.occupancy || p.latestDates?.revenue || 'No data'}
                        </td>
                        <td className="py-3 pl-3 text-right">
                          <button
                            onClick={() => setInspectPropertyId(p.propertyId)}
                            className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-slate-300 hover:border-[#00D4FF]/60 hover:text-[#00D4FF] transition-colors"
                          >
                            <span>Inspect Gaps</span>
                            <ChevronRight className="h-3 w-3" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                  {!filteredHealthProperties.length && (
                    <tr>
                      <td colSpan={9} className="py-8 text-center text-sm text-slate-500">
                        No properties found matching current filter.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}

      {/* ─────────────────────────────────────────────────────────────────────────────
          TAB 2: FINANCIAL RECONCILIATION ($0.00 DIFFERENCE TARGET)
          ───────────────────────────────────────────────────────────────────────────── */}
      {activeTab === 'reconciliation' && (
        <div className="space-y-6">
          {/* Cent-Exact Balance Hero Banner */}
          <div
            className={'rounded-2xl border p-5 transition-all ' + (
              financialReconciliation.isBalanced
                ? 'border-[#00E096]/30 bg-gradient-to-r from-[#00E096]/10 via-[#00D4FF]/5 to-transparent'
                : 'border-[#FFB547]/30 bg-gradient-to-r from-[#FFB547]/10 via-[#FF6B6B]/5 to-transparent'
            )}
          >
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-3.5">
                <div
                  className={'rounded-xl p-2.5 ' + (
                    financialReconciliation.isBalanced ? 'bg-[#00E096]/20 text-[#00E096]' : 'bg-[#FFB547]/20 text-[#FFB547]'
                  )}
                >
                  {financialReconciliation.isBalanced ? (
                    <ShieldCheck className="h-6 w-6" />
                  ) : (
                    <AlertTriangle className="h-6 w-6" />
                  )}
                </div>
                <div>
                  <h3 className="font-heading text-lg font-semibold text-white">
                    {financialReconciliation.isBalanced
                      ? 'Cent-Exact Financial Reconciliation Confirmed ($0.00 Variance)'
                      : `Unreconciled Variance: $${financialReconciliation.difference.toFixed(2)}`}
                  </h3>
                  <p className="mt-0.5 text-xs text-slate-300 max-w-2xl">
                    {financialReconciliation.isBalanced
                      ? 'Reported PMS room revenue matches channel distribution ledger and settled merchant transactions with exact mathematical identity. No orphan charges or unmapped revenue streams detected.'
                      : 'There is a variance between reported PMS revenue and channel distribution ledger lines. Review unmapped OTA rate codes, pending night audit adjustments, or fee withholdings.'}
                  </p>
                </div>
              </div>
              <div className="text-right sm:border-l sm:border-white/10 sm:pl-6">
                <p className="text-[11px] uppercase tracking-wider text-slate-400">Reconciliation Status</p>
                <p
                  className={'text-xl font-bold font-mono ' + (
                    financialReconciliation.isBalanced ? 'text-[#00E096]' : 'text-[#FFB547]'
                  )}
                >
                  {financialReconciliation.isBalanced ? '✅ $0.00 BALANCED' : `⚠ $${financialReconciliation.difference.toFixed(2)} DRIFT`}
                </p>
              </div>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard
              label="Reported PMS Revenue"
              value={`$${financialReconciliation.reported.toLocaleString('en-US', { minimumFractionDigits: 2 })}`}
              accent="#6C63FF"
              icon={DollarSign}
              sub="Source: HotelKey Gross Revenue & Manager Flash"
            />
            <KpiCard
              label="Channel Ledger Revenue"
              value={`$${financialReconciliation.calculated.toLocaleString('en-US', { minimumFractionDigits: 2 })}`}
              accent="#00D4FF"
              icon={Layers}
              sub="Source: Channel & Source Day Records"
            />
            <KpiCard
              label="Total Settled Payments"
              value={`$${financialReconciliation.payments.toLocaleString('en-US', { minimumFractionDigits: 2 })}`}
              accent="#00E096"
              icon={CheckCircle2}
              sub="Source: PaymentDay Settlement Records"
            />
            <KpiCard
              label="Unreconciled Difference"
              value={`$${financialReconciliation.difference.toFixed(2)}`}
              accent={financialReconciliation.isBalanced ? '#00E096' : '#FF6B6B'}
              icon={financialReconciliation.isBalanced ? ShieldCheck : AlertTriangle}
              sub={financialReconciliation.isBalanced ? '100% exact ledger match' : 'Requires audit investigation'}
            />
          </div>

          <Card
            title="Multi-Property Financial Reconciliation Breakdown"
            subtitle="Comparing PMS reported revenue against channel ledger lines for each hotel property"
          >
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm text-slate-300">
                <thead className="border-b border-white/5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  <tr>
                    <th className="pb-3 pr-4">Property</th>
                    <th className="pb-3 px-3">Reported PMS Revenue</th>
                    <th className="pb-3 px-3">Channel Ledger</th>
                    <th className="pb-3 px-3">Payment Total</th>
                    <th className="pb-3 px-3">Difference</th>
                    <th className="pb-3 pl-3 text-right">Balance Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {financialReconciliation.byProperty.map((p) => (
                    <tr key={p.propertyId} className="hover:bg-white/[0.02] transition-colors">
                      <td className="py-3 pr-4">
                        <p className="font-medium text-white">{p.propertyName}</p>
                        <p className="text-[11px] text-slate-500 font-mono">{p.propertyId}</p>
                      </td>
                      <td className="py-3 px-3 font-mono text-slate-200">
                        ${p.reported.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                      </td>
                      <td className="py-3 px-3 font-mono text-slate-200">
                        ${p.calculated.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                      </td>
                      <td className="py-3 px-3 font-mono text-slate-200">
                        ${p.payments.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                      </td>
                      <td className="py-3 px-3 font-mono">
                        <span className={p.isBalanced ? 'text-[#00E096]' : 'text-[#FFB547]'}>
                          ${p.difference.toFixed(2)}
                        </span>
                      </td>
                      <td className="py-3 pl-3 text-right">
                        {p.isBalanced ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-[#00E096]/15 px-2.5 py-0.5 text-xs font-medium text-[#00E096] border border-[#00E096]/30">
                            <ShieldCheck className="h-3 w-3" /> Balanced ($0.00)
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 rounded-full bg-[#FFB547]/15 px-2.5 py-0.5 text-xs font-medium text-[#FFB547] border border-[#FFB547]/30">
                            <AlertTriangle className="h-3 w-3" /> Discrepancy
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}

      {/* ─────────────────────────────────────────────────────────────────────────────
          TAB 3: DATA SCANNER & CLEANER
          ───────────────────────────────────────────────────────────────────────────── */}
      {activeTab === 'scanner' && (
        <div className="space-y-6">
          <div
            className={'rounded-2xl border border-dashed px-6 py-12 text-center transition-colors ' + (
              scanning
                ? 'border-[#00D4FF] bg-[#0A1628]/60'
                : 'border-white/10 bg-[#0A1628]/60 hover:border-[#00D4FF]/60'
            )}
          >
            <UploadCloud className={'mx-auto h-12 w-12 ' + (scanning ? 'text-[#00D4FF]' : 'text-slate-500') + ' mb-4'} />
            <p className="text-sm text-slate-300 mb-3">
              {scanning ? 'Scanning files...' : 'Drop CSV/Excel files here or click to browse'}
            </p>
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={scanning}
              className="rounded-lg bg-[#6C63FF] px-5 py-2 text-sm font-medium text-white hover:bg-[#5b52e8] disabled:opacity-50"
            >
              {scanning ? 'Scanning...' : 'Choose Files'}
            </button>
            {scanning && (
              <div className="mt-4 max-w-sm mx-auto">
                <div className="h-2 overflow-hidden rounded-full bg-white/5">
                  <div className="h-full rounded-full bg-gradient-to-r from-[#6C63FF] to-[#00D4FF] w-3/4 animate-pulse" />
                </div>
                <p className="mt-2 text-xs text-slate-500">Analyzing files for data quality issues...</p>
              </div>
            )}
          </div>

          {aggregateStats && aggregateStats.totalFiles > 0 ? (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <KpiCard
                label="Files Scanned"
                value={aggregateStats.totalFiles}
                accent="#6C63FF"
                icon={FileSpreadsheet}
              />
              <KpiCard
                label="Total Rows"
                value={formatNumber(aggregateStats.totalRows)}
                accent="#00D4FF"
                icon={Database}
              />
              <KpiCard
                label="Avg Health Score"
                value={`${aggregateStats.avgHealth}/100`}
                accent="#00E096"
                icon={Gauge}
              />
              <KpiCard
                label="Total Issues"
                value={aggregateStats.totalIssues}
                accent="#FFB547"
                icon={AlertTriangle}
              />
            </div>
          ) : (
            <p className="text-center text-slate-500 py-4">Upload or drag reports to inspect data health</p>
          )}

          {scanResults.length > 0 && (
            <>
              <Card
                title="Health Overview"
                subtitle="Data quality status across all scanned files"
                right={
                  <button
                    onClick={() => handleExportReport('json')}
                    className="flex items-center gap-1 rounded-lg border border-white/10 px-3 py-1 text-xs text-slate-400 hover:border-[#00D4FF]/60 hover:text-[#00D4FF]"
                  >
                    <FileDown className="h-3.5 w-3.5" />
                    Export Report
                  </button>
                }
              >
                <div className="space-y-4">
                  <div className="grid grid-cols-5 gap-2">
                    {['critical', 'high', 'medium', 'low', 'info'].map((sev) => (
                      <div key={sev} className="text-center">
                        <p className="text-2xl font-bold" style={{ color: severityColor(sev) }}>
                          {aggregateStats?.issuesBySeverity[sev] || 0}
                        </p>
                        <p className="text-xs text-slate-500">{sev.toUpperCase()}</p>
                      </div>
                    ))}
                  </div>

                  <div className="space-y-2">
                    {scanResults.map((result) => (
                      <ScanResultCard
                        key={result.fileId}
                        result={result}
                        onAutoFix={handleAutoFix}
                        onExport={handleExportReport}
                      />
                    ))}
                  </div>
                </div>
              </Card>

              <div>
                <h2 className="font-heading text-xl font-semibold text-white mb-3">AI-Powered Insights</h2>
                <AIInsightsPanel scanResults={scanResults} existingData={existingData} aiEngine={aiEngine} />
              </div>

              <div>
                <h2 className="font-heading text-xl font-semibold text-white mb-3">Automation Rules</h2>
                <AutomationRulesPanel rules={automationRules} onSave={saveAutomationRules} />
              </div>

              {reportHistory.length > 0 && (
                <div>
                  <h2 className="font-heading text-xl font-semibold text-white mb-3">Report History</h2>
                  <ReportHistoryPanel history={reportHistory} />
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ─────────────────────────────────────────────────────────────────────────────
          TAB 4: UPLOADED FILES & AUDIT TRAIL
          ───────────────────────────────────────────────────────────────────────────── */}
      {activeTab === 'files' && (
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
              <input
                type="text"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Search uploaded files..."
                className="w-full rounded-lg border border-white/10 bg-[#0A1628] py-2 pl-10 pr-4 text-sm text-slate-200 outline-none focus:border-[#00D4FF]"
              />
            </div>
            <button
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-2 rounded-lg bg-[#6C63FF] px-4 py-2 text-sm font-medium text-white hover:bg-[#5b52e8]"
            >
              <UploadCloud className="h-4 w-4" />
              Upload
            </button>
          </div>

          <Card title="Uploaded Reports" subtitle={`${files.length} total reports imported`}>
            <div className="space-y-2">
              {files
                .filter((f) => {
                  const term = searchTerm.toLowerCase();
                  return !term || f.name.toLowerCase().includes(term);
                })
                .map((f) => (
                  <FileRow key={f.id} file={f} onScan={handleUpload} />
                ))}
              {!files.length && (
                <p className="text-sm text-slate-500 py-4 text-center">No reports uploaded yet</p>
              )}
            </div>
          </Card>
        </div>
      )}

      {/* ─────────────────────────────────────────────────────────────────────────────
          INSPECT MISSING DATES DRAWER / MODAL
          ───────────────────────────────────────────────────────────────────────────── */}
      {inspectedProperty && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="w-full max-w-2xl rounded-2xl border border-white/10 bg-[#0A1628] p-6 shadow-2xl space-y-5">
            <div className="flex items-start justify-between border-b border-white/5 pb-4">
              <div>
                <span
                  className="rounded px-2 py-0.5 text-xs font-semibold"
                  style={{
                    color: inspectedProperty.badgeColor,
                    backgroundColor: `${inspectedProperty.badgeColor}15`,
                  }}
                >
                  {inspectedProperty.statusLabel}
                </span>
                <h3 className="mt-1 font-heading text-xl font-bold text-white">
                  {inspectedProperty.propertyName} ({inspectedProperty.propertyId})
                </h3>
                <p className="text-xs text-slate-400">
                  Data Completeness Audit: {inspectedProperty.overallScore}% · {inspectedProperty.totalPossibleDays} Days Evaluated
                </p>
              </div>
              <button
                onClick={() => setInspectPropertyId(null)}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-white/5 hover:text-white"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="space-y-4 max-h-[60vh] overflow-y-auto pr-1">
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-300">
                  Missing Occupancy Days ({inspectedProperty.missingDates?.occupancy?.length || 0})
                </h4>
                {inspectedProperty.missingDates?.occupancy?.length ? (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {inspectedProperty.missingDates.occupancy.map((d) => (
                      <span key={d} className="rounded bg-[#FF6B6B]/15 px-2 py-1 text-xs font-mono text-[#FF6B6B] border border-[#FF6B6B]/25">
                        {d}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="mt-1 text-xs text-[#00E096]">✅ 100% complete — No missing dates</p>
                )}
              </div>

              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-300">
                  Missing Gross Revenue Days ({inspectedProperty.missingDates?.revenue?.length || 0})
                </h4>
                {inspectedProperty.missingDates?.revenue?.length ? (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {inspectedProperty.missingDates.revenue.map((d) => (
                      <span key={d} className="rounded bg-[#FFB547]/15 px-2 py-1 text-xs font-mono text-[#FFB547] border border-[#FFB547]/25">
                        {d}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="mt-1 text-xs text-[#00E096]">✅ 100% complete — No missing dates</p>
                )}
              </div>

              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-300">
                  Missing Channel Source Days ({inspectedProperty.missingDates?.source?.length || 0})
                </h4>
                {inspectedProperty.missingDates?.source?.length ? (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {inspectedProperty.missingDates.source.map((d) => (
                      <span key={d} className="rounded bg-[#00D4FF]/15 px-2 py-1 text-xs font-mono text-[#00D4FF] border border-[#00D4FF]/25">
                        {d}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="mt-1 text-xs text-[#00E096]">✅ 100% complete — No missing dates</p>
                )}
              </div>

              <div className="rounded-xl border border-white/5 bg-[#040D1A] p-4 text-xs text-slate-300 space-y-1.5">
                <p className="font-semibold text-white">Recommended Action:</p>
                <p>
                  To reconcile missing periods, export the <strong>Manager Flash Report</strong> or <strong>Night Audit Daily Summary</strong> from HotelKey PMS for the flagged calendar dates above and upload them into the system.
                </p>
              </div>
            </div>

            <div className="flex justify-end pt-2 border-t border-white/5">
              <button
                onClick={() => setInspectPropertyId(null)}
                className="rounded-lg bg-white/10 px-4 py-1.5 text-xs font-medium text-white hover:bg-white/20 transition-colors"
              >
                Close Audit
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function CompletenessBar({ percent = 100 }) {
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  const color = p >= 95 ? '#00E096' : p >= 70 ? '#FFB547' : '#FF6B6B';

  return (
    <div className="space-y-1 w-28">
      <div className="flex items-center justify-between text-[10px]">
        <span className="font-mono text-slate-300">{p}%</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/5">
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${p}%`, backgroundColor: color }}
        />
      </div>
    </div>
  );
}

function severityColor(sev) {
  return {
    critical: '#FF6B6B',
    high: '#FF6B6B',
    medium: '#FFB547',
    low: '#94A3B8',
    info: '#00D4FF',
  }[sev] || '#94A3B8';
}

function ScanResultCard({ result, onAutoFix, onExport }) {
  const [expanded, setExpanded] = useState(false);
  const [fixing, setFixing] = useState(false);
  const health = result.healthScore || { score: 100, grade: 'A' };
  const issues = result.issues || [];
  const highPriorityIssues = issues.filter((i) => ['critical', 'high'].includes(i.severity));
  const fixableCount = issues.filter((i) => i.applyAutoFix).length;

  return (
    <div className="rounded-xl border border-white/5 bg-[#0A1628]/60">
      <div className="flex items-center justify-between p-4">
        <div className="flex items-center gap-3">
          <div className={'rounded-lg p-2 ' + SEVERITY_BG[health.grade === 'A' ? 'info' : health.score < 50 ? 'critical' : health.score < 70 ? 'high' : 'medium']}>
            <FileSpreadsheet className="h-5 w-5" />
          </div>
          <div>
            <p className="text-sm font-medium text-white">{result.fileName}</p>
            <p className="text-xs text-slate-500">
              {result.rowCount} rows · {issues.length} issues · Score: {health.score}/100 ({health.grade})
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {fixableCount > 0 && (
            <button
              onClick={async () => {
                if (fixing) return;
                setFixing(true);
                const fixActions = [...new Set(issues.filter((i) => i.applyAutoFix).map((i) => i.fixAction))];
                for (const action of fixActions) {
                  await onAutoFix(result.fileId, action);
                }
                setFixing(false);
              }}
              disabled={fixing}
              className="flex items-center gap-1 rounded-lg border border-[#00E096]/30 bg-[#00E096]/10 px-3 py-1 text-xs text-[#00E096] hover:bg-[#00E096]/20 disabled:opacity-50"
              title={'Auto fix ' + fixableCount + ' issues'}
            >
              {fixing ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
              <span>Auto-fix ({fixableCount})</span>
            </button>
          )}
          <button
            onClick={() => onExport('json')}
            className="rounded-lg border border-white/10 p-1.5 text-slate-400 hover:border-[#00D4FF]/60 hover:text-[#00D4FF]"
            title="Export cleaned data"
          >
            <Download className="h-4 w-4" />
          </button>
          <button
            onClick={() => setExpanded(!expanded)}
            className="rounded-lg border border-white/10 p-1.5 text-slate-400 hover:border-[#00D4FF]/60 hover:text-[#00D4FF]"
            title={expanded ? 'Collapse' : 'Expand'}
          >
            {expanded ? <XSquare className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
      </div>

      {highPriorityIssues.length > 0 && (
        <div className="px-4 pb-2">
          <div className="flex flex-wrap gap-1">
            {highPriorityIssues.slice(0, 5).map((issue, i) => (
              <span
                key={i}
                className={'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ' + (SEVERITY_COLORS[issue.severity] || '')}
              >
                {issue.type.replace(/_/g, ' ')}
              </span>
            ))}
            {highPriorityIssues.length > 5 && (
              <span className="text-xs text-slate-500">+{highPriorityIssues.length - 5} more</span>
            )}
          </div>
        </div>
      )}

      {expanded && (
        <div className="border-t border-white/5 p-4 space-y-3">
          <div className="flex items-center gap-4 text-xs text-slate-400">
            <span>Health: <span className="text-white">{health.score}/100 — {health.grade}</span></span>
            <span>Rows: <span className="text-white">{result.rowCount}</span></span>
            <span>Issues: <span className="text-white">{issues.length}</span></span>
          </div>

          <div className="space-y-2">
            <div className="text-xs font-medium text-slate-300">Issue Breakdown</div>
            {['critical', 'high', 'medium', 'low'].map((sev) => {
              const sevIssues = issues.filter((i) => i.severity === sev);
              if (!sevIssues.length) return null;
              return (
                <div key={sev} className="space-y-1">
                   <div className="flex items-center gap-2">
                     <span className={'w-2 h-2 rounded-full ' + (sev === 'critical' ? 'bg-[#FF6B6B]' : sev === 'high' ? 'bg-[#FF6B6B]/70' : sev === 'medium' ? 'bg-[#FFB547]' : 'bg-slate-500')} />
                     <span className={'text-xs font-medium ' + (sev === 'critical' || sev === 'high' ? 'text-[#FF6B6B]' : sev === 'medium' ? 'text-[#FFB547]' : 'text-slate-400')}>
                       {sev.toUpperCase()} ({sevIssues.length})
                     </span>
                  </div>
                  {sevIssues.slice(0, 3).map((issue, i) => (
                    <div key={i} className="ml-4 text-xs text-slate-400">
                      • {issue.description}
                      {issue.suggestion && <span className="text-slate-600"> — {issue.suggestion}</span>}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>

          {result.insights && result.insights.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs font-medium text-slate-300">Key Insights</div>
              {result.insights.slice(0, 3).map((insight, i) => (
                <div key={i} className="flex items-start gap-2 text-xs">
                  <Lightbulb className="h-3 w-3 shrink-0 mt-0.5 text-[#00D4FF]" />
                  <div>
                    <span className="text-slate-300">{insight.title}</span>
                    <p className="text-slate-500 mt-0.5">{insight.detail}</p>
                  </div>
                </div>
              ))}
            </div>
          )}

          {fixableCount > 0 && (
            <div className="pt-2 border-t border-white/5">
              <button
                onClick={() => onAutoFix(result.fileId, 'remove_duplicates')}
                className="text-xs text-[#00E096] hover:text-[#00c885]"
              >
                Apply smart fixes to this file
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function AIInsightsPanel({ scanResults, existingData, aiEngine }) {
  const [loading, setLoading] = useState(false);
  const [insights, setInsights] = useState(null);
  const [insightsError, setInsightsError] = useState(null);

  const generateInsights = async () => {
    setLoading(true);
    setInsightsError(null);
    try {
      const result = await aiEngine.generateComprehensiveInsights(scanResults, existingData, null);
      setInsights(result);
    } catch (e) {
      setInsightsError(e);
    }
    setLoading(false);
  };

  return (
    <Card title="AI-Powered Insights" subtitle="Automated analysis and recommendations">
      <div className="space-y-3">
        {!insights && (
          <button
            onClick={generateInsights}
            disabled={loading || !scanResults.length}
            className="w-full rounded-lg border border-[#00D4FF]/30 bg-[#00D4FF]/10 px-4 py-3 text-sm text-[#00D4FF] hover:bg-[#00D4FF]/20 disabled:opacity-50"
          >
            {loading ? 'Analyzing...' : scanResults.length ? 'Generate AI Insights' : 'Upload files to generate insights'}
          </button>
        )}

        {/* This failure used to be swallowed into console.error: the button
            simply reset to "Generate AI Insights" and the panel stayed empty, as
            if the analysis had found nothing worth reporting. */}
        {insightsError && (
          <ErrorState
            title="Could not generate insights"
            description="The analysis compares these files against the data already in the system and it failed part way through. No insights, recommendations or alerts are listed — that silence is the failure, not a clean bill of health for the files you just scanned."
            error={insightsError}
            onRetry={generateInsights}
          />
        )}

        {insights && (
          <>
            <div className="grid grid-cols-3 gap-4 text-center">
              <div>
                <p className="text-2xl font-bold text-white">{insights.insights.length}</p>
                <p className="text-xs text-slate-500">Insights</p>
              </div>
              <div>
                <p className="text-2xl font-bold text-white">{insights.recommendations.length}</p>
                <p className="text-xs text-slate-500">Recommendations</p>
              </div>
              <div>
                <p className="text-2xl font-bold text-white">{insights.alerts.length}</p>
                <p className="text-xs text-slate-500">Alerts</p>
              </div>
            </div>

            <div className="space-y-2 mt-3">
              {insights.insights.slice(0, 8).map((insight, i) => (
                <InsightItem key={i} insight={insight} />
              ))}
            </div>

            {insights.recommendations.length > 0 && (
              <div className="pt-3 border-t border-white/5">
                <p className="text-xs font-medium text-slate-300 mb-2">Top Recommendations</p>
                {insights.recommendations.slice(0, 3).map((rec, i) => (
                  <RecommendationItem key={i} rec={rec} onApply={() => {}} />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </Card>
  );
}

function InsightItem({ insight }) {
  const iconMap = {
    health: <Gauge className="h-4 w-4" />,
    duplicate: <Database className="h-4 w-4" />,
    missing: <AlertCircle className="h-4 w-4" />,
    outlier: <BarChart3 className="h-4 w-4" />,
    consistency: <Share2 className="h-4 w-4" />,
    structure: <Database className="h-4 w-4" />,
    type_mismatch: <AlertCircle className="h-4 w-4" />,
    date_format: <Clock className="h-4 w-4" />,
    conflict: <GitMerge className="h-4 w-4" />,
    relationship: <Share2 className="h-4 w-4" />,
    overlap_warning: <AlertTriangle className="h-4 w-4" />,
  };

  return (
    <div
      className={'rounded-xl border p-3 ' + (SEVERITY_COLORS[insight.severity || insight.severity || 'info'] || '')}
    >
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 mt-0.5">
          {iconMap[insight.type] || <Info className="h-4 w-4" />}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-white">{insight.title}</p>
          <p className="text-xs text-slate-400 mt-0.5">{insight.detail}</p>
          {insight.fixable && (
            <span className="inline-block mt-1 text-xs text-[#00E096]">Auto-fix available</span>
          )}
        </div>
        <span
          className={'text-[10px] uppercase tracking-wider ' + (
            insight.severity === 'critical' || insight.severity === 'high' ? 'text-[#FF6B6B]' :
            insight.severity === 'medium' ? 'text-[#FFB547]' : 'text-slate-500'
          )}
        >
          {insight.severity || 'info'}
        </span>
      </div>
    </div>
  );
}

function RecommendationItem({ rec, onApply }) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-white/5 bg-[#0A1628]/60 p-3">
      <div className="flex items-start gap-3">
        <Zap className="h-4 w-4 shrink-0 text-[#00E096] mt-0.5" />
        <div>
          <p className="text-sm font-medium text-white">{rec.name}</p>
          <p className="text-xs text-slate-400 mt-0.5">{rec.description}</p>
        </div>
      </div>
      <button
        onClick={onApply}
        className="rounded-lg border border-[#00E096]/30 bg-[#00E096]/10 px-2 py-1 text-xs text-[#00E096] hover:bg-[#00E096]/20"
      >
        Apply
      </button>
    </div>
  );
}

function FileRow({ file, onScan }) {
  const [scanning, setScanning] = useState(false);

  return (
    <div className="flex items-center justify-between rounded-lg border border-white/5 bg-[#0A1628]/60 p-3">
      <div className="flex items-center gap-3">
        <FileSpreadsheet className="h-5 w-5 text-[#6C63FF]" />
        <div>
          <p className="text-sm text-white">{file.name}</p>
          <p className="text-xs text-slate-500">
            {file.rowCount} rows · {file.type || 'Unknown type'} · {new Date(file.date).toLocaleDateString()}
          </p>
        </div>
      </div>
      <button
        onClick={async () => {
          setScanning(true);
          onScan(file);
          setScanning(false);
        }}
        disabled={scanning}
        className="rounded-lg border border-white/10 p-1.5 text-slate-400 hover:border-[#00D4FF]/60 hover:text-[#00D4FF]"
      >
        {scanning ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
      </button>
    </div>
  );
}

function AutomationRulesPanel({ rules, onSave }) {
  const [showNew, setShowNew] = useState(false);
  const [newRule, setNewRule] = useState({
    name: '',
    trigger: 'file_upload',
    conditions: [{ type: 'health_below', threshold: 70 }],
    action: 'auto_fix',
  });

  const handleAddRule = () => {
    if (!newRule.name) {
      toast.error('Please name the rule');
      return;
    }
    const rule = {
      id: `rule_${Date.now()}`,
      ...newRule,
      enabled: true,
      createdAt: new Date().toISOString(),
      runCount: 0,
      lastRun: null,
    };
    onSave([...rules, rule]);
    setShowNew(false);
    setNewRule({ name: '', trigger: 'file_upload', conditions: [{ type: 'health_below', threshold: 70 }], action: 'auto_fix' });
    toast.success('Automation rule created');
  };

  const toggleRule = (ruleId) => {
    onSave(rules.map((r) => (r.id === ruleId ? { ...r, enabled: !r.enabled } : r)));
  };

  const deleteRule = (ruleId) => {
    onSave(rules.filter((r) => r.id !== ruleId));
    toast.success('Rule deleted');
  };

  return (
    <Card title="Automation Rules" subtitle="Auto-detect and fix data issues">
      <div className="space-y-3">
        <button
          onClick={() => setShowNew(true)}
          className="flex items-center gap-2 rounded-lg border border-[#6C63FF]/30 bg-[#6C63FF]/10 px-3 py-1.5 text-xs text-[#6C63FF] hover:bg-[#6C63FF]/20"
        >
          <Settings className="h-3.5 w-3.5" />
          New Rule
        </button>

        {showNew && (
          <div className="rounded-lg border border-white/10 bg-[#0A1628]/60 p-3 space-y-3">
            <input
              type="text"
              placeholder="Rule name..."
              value={newRule.name}
              onChange={(e) => setNewRule({ ...newRule, name: e.target.value })}
              className="w-full rounded-lg border border-white/10 bg-[#040D1A] px-3 py-1.5 text-sm text-slate-200 outline-none focus:border-[#6C63FF]"
            />
            <select
              value={newRule.trigger}
              onChange={(e) => setNewRule({ ...newRule, trigger: e.target.value })}
              className="w-full rounded-lg border border-white/10 bg-[#040D1A] px-3 py-1.5 text-sm text-slate-200 outline-none focus:border-[#6C63FF]"
            >
              <option value="file_upload">On file upload</option>
              <option value="schedule">Daily schedule</option>
              <option value="data_change">When data changes</option>
            </select>
            <select
              value={newRule.action}
              onChange={(e) => setNewRule({ ...newRule, action: e.target.value })}
              className="w-full rounded-lg border border-white/10 bg-[#040D1A] px-3 py-1.5 text-sm text-slate-200 outline-none focus:border-[#6C63FF]"
            >
              <option value="auto_fix">Auto-fix issues</option>
              <option value="alert">Send alert</option>
              <option value="flag">Flag for review</option>
            </select>
            <div className="flex gap-2">
              <button
                onClick={handleAddRule}
                className="rounded-lg bg-[#00E096] px-3 py-1 text-xs font-medium text-[#040D1A] hover:bg-[#00c885]"
              >
                Save Rule
              </button>
              <button
                onClick={() => setShowNew(false)}
                className="rounded-lg border border-white/10 px-3 py-1 text-xs text-slate-400 hover:bg-white/5"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {rules.map((rule) => (
          <div key={rule.id} className="rounded-lg border border-white/5 bg-[#0A1628]/60 p-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {rule.enabled ? <PlayCircle className="h-4 w-4 text-[#00E096]" /> : <PauseCircle className="h-4 w-4 text-slate-500" />}
                <span className="text-sm font-medium text-white">{rule.name}</span>
                <span className={'rounded-full px-2 py-0.5 text-xs ' + (rule.enabled ? 'bg-[#00E096]/15 text-[#00E096]' : 'bg-slate-500/15 text-slate-500')}>
                  {rule.enabled ? 'Active' : 'Paused'}
                </span>
              </div>
              <div className="flex items-center gap-1">
                <span className="text-xs text-slate-500">Ran: {rule.runCount || 0}x</span>
                <button
                  onClick={() => toggleRule(rule.id)}
                  className="rounded-md p-1 text-slate-400 hover:bg-white/5 hover:text-white"
                >
                  <Settings className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => deleteRule(rule.id)}
                  className="rounded-md p-1 text-slate-400 hover:bg-white/5 hover:text-[#FF6B6B]"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
            <div className="mt-1 text-xs text-slate-500">
              Trigger: {rule.trigger} · Action: {rule.action}
            </div>
          </div>
        ))}

        {!rules.length && !showNew && (
          <p className="text-xs text-slate-500">No automation rules configured. Create one to get started.</p>
        )}
      </div>
    </Card>
  );
}

function ReportHistoryPanel({ history }) {
  return (
    <Card title="Report History" subtitle="Previous scan reports and insights">
      <div className="space-y-2">
        {history.slice(0, 10).map((report, i) => (
          <div key={i} className="rounded-lg border border-white/5 bg-[#0A1628]/60 p-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-white">
                  Report #{history.length - i} — {new Date(report.generatedAt).toLocaleString()}
                </p>
                <p className="text-xs text-slate-500">
                  {report.filesScanned} files · {report.totalRows} rows · {report.totalIssues} issues
                </p>
              </div>
              <button
                onClick={() => {
                  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
                  const url = URL.createObjectURL(blob);
                  const link = document.createElement('a');
                  link.href = url;
                  link.download = `data-report-${Date.now()}.json`;
                  link.click();
                  URL.revokeObjectURL(url);
                }}
                className="rounded-lg border border-white/10 p-1.5 text-slate-400 hover:border-[#00D4FF]/60 hover:text-[#00D4FF]"
                title="Download report"
              >
                <Download className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
