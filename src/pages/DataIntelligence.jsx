import { useState, useRef, useEffect, useMemo } from 'react';
import {
  FileSpreadsheet, UploadCloud, Search, AlertTriangle,
  BarChart3, Zap, Download, RefreshCw, Eye, Trash2,
  Gauge, Clock, Database, GitMerge,
  XSquare, AlertCircle, Info, Share2, Lightbulb,
  PauseCircle, PlayCircle, Settings,
  FileDown
} from 'lucide-react';
import Card from '@/components/ui-exec/Card';
import KpiCard from '@/components/ui-exec/KpiCard';
import { DataScanner as DataScannerClass } from '@/lib/dataScanner';
import AIInsightsEngine from '@/lib/aiInsights';
import { db } from '@/api/base44Client';
import { useQuery } from '@tanstack/react-query';
import { useGlobalFilters } from '@/lib/useGlobalFilters';
import { formatNumber } from '@/lib/decimal';
import { ErrorState } from '@/components/ui/status';
import { toast } from 'sonner';

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

export default function DataIntelligence() {
  const { property, properties } = useGlobalFilters();
  const filesQ = useFiles();
  const entitiesQ = useAllEntities();
  const { data: files = [], refetch } = filesQ;
  const { data: existingData = {} } = entitiesQ;

  const [activeTab, setActiveTab] = useState('dashboard');
  const [scanning, setScanning] = useState(false);
  const [scanResults, setScanResults] = useState([]);
  const [automationRules, setAutomationRules] = useState([]);
  const [reportHistory, setReportHistory] = useState([]);
  const [searchTerm, setSearchTerm] = useState('');
  const fileInputRef = useRef(null);
  const scanner = useMemo(() => new DataScannerClass(), []);
  const aiEngine = useMemo(() => new AIInsightsEngine(scanner), [scanner]);

  useEffect(() => {
    try {
      const saved = localStorage.getItem('rri_automationRules');
      if (saved) setAutomationRules(JSON.parse(saved));
    } catch { setAutomationRules([]); }
    try {
      const history = localStorage.getItem('rri_reportHistory');
      if (history) setReportHistory(JSON.parse(history));
    } catch { setReportHistory([]); }
  }, []);

  const saveAutomationRules = (rules) => {
    try { localStorage.setItem('rri_automationRules', JSON.stringify(rules)); } catch {}
    setAutomationRules(rules);
  };

  const saveReportHistory = (history) => {
    try { localStorage.setItem('rri_reportHistory', JSON.stringify(history)); } catch {}
    setReportHistory(history);
  };

  const handleUpload = async (fileList) => {
    const validFiles = Array.from(fileList).filter(
      (f) => /\.(csv|xlsx?|xls)$/i.test(f.name)
    );
    if (!validFiles.length) {
      toast.error('No valid CSV or Excel files found');
      return;
    }

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

  const handleExportReport = async (format = 'json') => {
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

  if (activeTab === 'dashboard') {
    return (
      <>
        <header>
          <p className="text-[11px] uppercase tracking-[0.3em] text-[#00D4FF]">Data Intelligence</p>
          <h1 className="mt-2 font-heading text-3xl font-semibold text-white">Data Scanner & Cleaner</h1>
          <p className="mt-1 text-sm text-slate-400">
            Upload CSV/Excel files to scan, detect issues, clean data, and get AI-powered insights.
          </p>
        </header>

        {readErrorBanner}

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
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={scanning}
            className="rounded-lg bg-[#6C63FF] px-5 py-2 text-sm font-medium text-white hover:bg-[#5b52e8] disabled:opacity-50"
          >
            {scanning ? 'Scanning...' : 'Choose Files'}
          </button>
          {scanning && (
            <div className="mt-4">
              <div className="h-2 overflow-hidden rounded-full bg-white/5">
                <div className="h-full rounded-full bg-gradient-to-r from-[#6C63FF] to-[#00D4FF] w-3/4 animate-pulse" />
              </div>
              <p className="mt-2 text-xs text-slate-500">Analyzing files for data quality issues...</p>
            </div>
          )}
        </div>

        {aggregateStats && aggregateStats.totalFiles > 0 ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4 mt-6">
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
          <p className="mt-6 text-center text-slate-500">Upload files to begin scanning</p>
        )}

        {scanResults.length > 0 && (
          <>
            <Card
              title="Health Overview"
              subtitle="Data quality status across all scanned files"
              className="mt-6"
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

            <div className="mt-6">
              <h2 className="font-heading text-xl font-semibold text-white mb-3">AI-Powered Insights</h2>
              <AIInsightsPanel scanResults={scanResults} existingData={existingData} aiEngine={aiEngine} />
            </div>

            <div className="mt-6">
              <h2 className="font-heading text-xl font-semibold text-white mb-3">Automation Rules</h2>
              <AutomationRulesPanel rules={automationRules} onSave={saveAutomationRules} />
            </div>

            {reportHistory.length > 0 && (
              <div className="mt-6">
                <h2 className="font-heading text-xl font-semibold text-white mb-3">Report History</h2>
                <ReportHistoryPanel history={reportHistory} />
              </div>
            )}
          </>
        )}
      </>
    );
  }

  if (activeTab === 'files') {
    return (
      <>
        <header>
          <p className="text-[11px] uppercase tracking-[0.3em] text-[#00D4FF]">Data Intelligence</p>
          <h1 className="mt-2 font-heading text-3xl font-semibold text-white">File Manager</h1>
          <p className="mt-1 text-sm text-slate-400">Manage your data sources and scan history</p>
        </header>

        {readErrorBanner}

        <div className="flex items-center gap-3 mb-4">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search files..."
              className="w-full rounded-lg border border-white/10 bg-[#0A1628] py-2 pl-10 pr-4 text-sm text-slate-200 outline-none focus:border-[#00D4FF]"
            />
          </div>
          <button
            onClick={() => fileInputRef.current?.click()}
            className="flex items-center gap-2 rounded-lg bg-[#6C63FF] px-4 text-sm font-medium text-white hover:bg-[#5b52e8]"
          >
            <UploadCloud className="h-4 w-4" />
            Upload
          </button>
        </div>

        <input
          type="file"
          accept=".csv,.xlsx,.xls"
          multiple
          ref={fileInputRef}
          className="hidden"
          onChange={(e) => {
            handleUpload(e.target.files);
            e.target.value = '';
          }}
        />

        <Card title="Uploaded Files" subtitle={`${files.length} total files`}>
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
              <p className="text-sm text-slate-500 py-4 text-center">No files uploaded yet</p>
            )}
          </div>
        </Card>
      </>
    );
  }

  return null;
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
