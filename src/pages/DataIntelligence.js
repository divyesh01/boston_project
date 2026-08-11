import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState, useRef, useEffect, useMemo } from 'react';
import { FileSpreadsheet, UploadCloud, Search, AlertTriangle, BarChart3, Zap, Download, RefreshCw, Eye, Trash2, Gauge, Clock, Database, GitMerge, XSquare, AlertCircle, Info, Share2, Lightbulb, PauseCircle, PlayCircle, Settings, FileDown } from 'lucide-react';
import Card from '@/components/ui-exec/Card';
import KpiCard from '@/components/ui-exec/KpiCard';
import { DataScanner as DataScannerClass } from '@/lib/dataScanner';
import AIInsightsEngine from '@/lib/aiInsights';
import { db } from '@/api/base44Client';
import localDb from '@/api/localDb';
import { useQuery } from '@tanstack/react-query';
import { useGlobalFilters } from '@/lib/useGlobalFilters';
import { formatNumber } from '@/lib/decimal';
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
            const files = await localDb.UploadedReport.toArray();
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
                }
                catch {
                    result[table] = [];
                }
            }
            return result;
        },
    });
}
export default function DataIntelligence() {
    const { property, properties } = useGlobalFilters();
    const { data: files = [], refetch } = useFiles();
    const { data: existingData = {} } = useAllEntities();
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
            if (saved)
                setAutomationRules(JSON.parse(saved));
        }
        catch {
            setAutomationRules([]);
        }
        try {
            const history = localStorage.getItem('rri_reportHistory');
            if (history)
                setReportHistory(JSON.parse(history));
        }
        catch {
            setReportHistory([]);
        }
    }, []);
    const saveAutomationRules = (rules) => {
        try {
            localStorage.setItem('rri_automationRules', JSON.stringify(rules));
        }
        catch { }
        setAutomationRules(rules);
    };
    const saveReportHistory = (history) => {
        try {
            localStorage.setItem('rri_reportHistory', JSON.stringify(history));
        }
        catch { }
        setReportHistory(history);
    };
    const handleUpload = async (fileList) => {
        const validFiles = Array.from(fileList).filter((f) => /\.(csv|xlsx?|xls)$/i.test(f.name));
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
                }
                else {
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
                const scanResult = scanner.fullScan(parsed.rows, parsed.headers, file.name, existingKeys);
                scanResult.fileId = file.name;
                scanResult.fileUrl = file_url;
                scanResult.originalFile = file;
                newResults.push(scanResult);
            }
            catch (e) {
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
        if (!scanResult)
            return;
        const issues = scanResult.issues.filter((i) => i.applyAutoFix);
        if (!issues.length) {
            toast('No auto-fixable issues found');
            return;
        }
        toast.loading(`Applying fixes to ${scanResult.fileName}...`, { id: `fix-${fileId}` });
        const fixResult = scanner.autoFix(scanResult.rows, scanResult.headers, issues, [action]);
        const newScan = scanner.fullScan(fixResult.cleanedRows, scanResult.headers, scanResult.fileName, scanResults
            .filter((s) => s.fileId !== fileId)
            .map((s) => ({ fileName: s.fileName, headers: s.headers, rows: s.rows })));
        newScan.fileId = fileId;
        newScan.fileUrl = scanResult.fileUrl;
        newScan.originalFile = scanResult.originalFile;
        newScan.fixHistory = [{ action, timestamp: new Date().toISOString(), result: fixResult }];
        setScanResults((prev) => prev.map((s) => (s.fileId === fileId ? { ...newScan, appliedFixes: [...(s.appliedFixes || []), action] } : s)));
        toast.success(`Applied ${action} to ${scanResult.fileName}: ${fixResult.cleanedCount} rows remaining (was ${fixResult.originalCount})`, { id: `fix-${fileId}` });
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
        if (history.length > 20)
            history.shift();
        saveReportHistory(history);
        return fullReport;
    };
    const handleExportReport = async (format = 'json') => {
        const report = await generateReport();
        toast.success(`Generated analysis report for ${scanResults.length} file(s)`);
        return report;
    };
    const aggregateStats = useMemo(() => {
        if (!scanResults.length)
            return null;
        const totalRows = scanResults.reduce((a, s) => a + (s.rowCount || 0), 0);
        const totalIssues = scanResults.reduce((a, s) => a + (s.issues?.length || 0), 0);
        const avgHealth = scanResults.reduce((a, s) => a + (s.healthScore?.score || 0), 0) / scanResults.length;
        const issuesBySeverity = scanResults
            .flatMap((s) => s.issues || [])
            .reduce((acc, i) => {
            acc[i.severity] = (acc[i.severity] || 0) + 1;
            return acc;
        }, { critical: 0, high: 0, medium: 0, low: 0, info: 0 });
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
    if (activeTab === 'dashboard') {
        return (_jsxs(_Fragment, { children: [_jsxs("header", { children: [_jsx("p", { className: "text-[11px] uppercase tracking-[0.3em] text-[#00D4FF]", children: "Data Intelligence" }), _jsx("h1", { className: "mt-2 font-heading text-3xl font-semibold text-white", children: "Data Scanner & Cleaner" }), _jsx("p", { className: "mt-1 text-sm text-slate-400", children: "Upload CSV/Excel files to scan, detect issues, clean data, and get AI-powered insights." })] }), _jsxs("div", { className: 'rounded-2xl border border-dashed px-6 py-12 text-center transition-colors ' + (scanning
                        ? 'border-[#00D4FF] bg-[#0A1628]/60'
                        : 'border-white/10 bg-[#0A1628]/60 hover:border-[#00D4FF]/60'), children: [_jsx(UploadCloud, { className: 'mx-auto h-12 w-12 ' + (scanning ? 'text-[#00D4FF]' : 'text-slate-500') + ' mb-4' }), _jsx("p", { className: "text-sm text-slate-300 mb-3", children: scanning ? 'Scanning files...' : 'Drop CSV/Excel files here or click to browse' }), _jsx("input", { type: "file", ref: fileInputRef, accept: ".csv,.xlsx,.xls", multiple: true, className: "hidden", disabled: scanning, onChange: (e) => {
                                handleUpload(e.target.files);
                                e.target.value = '';
                            } }), _jsx("button", { onClick: () => fileInputRef.current?.click(), disabled: scanning, className: "rounded-lg bg-[#6C63FF] px-5 py-2 text-sm font-medium text-white hover:bg-[#5b52e8] disabled:opacity-50", children: scanning ? 'Scanning...' : 'Choose Files' }), scanning && (_jsxs("div", { className: "mt-4", children: [_jsx("div", { className: "h-2 overflow-hidden rounded-full bg-white/5", children: _jsx("div", { className: "h-full rounded-full bg-gradient-to-r from-[#6C63FF] to-[#00D4FF] w-3/4 animate-pulse" }) }), _jsx("p", { className: "mt-2 text-xs text-slate-500", children: "Analyzing files for data quality issues..." })] }))] }), aggregateStats && aggregateStats.totalFiles > 0 ? (_jsxs("div", { className: "grid gap-4 sm:grid-cols-2 xl:grid-cols-4 mt-6", children: [_jsx(KpiCard, { label: "Files Scanned", value: aggregateStats.totalFiles, accent: "#6C63FF", icon: FileSpreadsheet }), _jsx(KpiCard, { label: "Total Rows", value: formatNumber(aggregateStats.totalRows), accent: "#00D4FF", icon: Database }), _jsx(KpiCard, { label: "Avg Health Score", value: `${aggregateStats.avgHealth}/100`, accent: "#00E096", icon: Gauge }), _jsx(KpiCard, { label: "Total Issues", value: aggregateStats.totalIssues, accent: "#FFB547", icon: AlertTriangle })] })) : (_jsx("p", { className: "mt-6 text-center text-slate-500", children: "Upload files to begin scanning" })), scanResults.length > 0 && (_jsxs(_Fragment, { children: [_jsx(Card, { title: "Health Overview", subtitle: "Data quality status across all scanned files", className: "mt-6", right: _jsxs("button", { onClick: () => handleExportReport('json'), className: "flex items-center gap-1 rounded-lg border border-white/10 px-3 py-1 text-xs text-slate-400 hover:border-[#00D4FF]/60 hover:text-[#00D4FF]", children: [_jsx(FileDown, { className: "h-3.5 w-3.5" }), "Export Report"] }), children: _jsxs("div", { className: "space-y-4", children: [_jsx("div", { className: "grid grid-cols-5 gap-2", children: ['critical', 'high', 'medium', 'low', 'info'].map((sev) => (_jsxs("div", { className: "text-center", children: [_jsx("p", { className: "text-2xl font-bold", style: { color: severityColor(sev) }, children: aggregateStats?.issuesBySeverity[sev] || 0 }), _jsx("p", { className: "text-xs text-slate-500", children: sev.toUpperCase() })] }, sev))) }), _jsx("div", { className: "space-y-2", children: scanResults.map((result) => (_jsx(ScanResultCard, { result: result, onAutoFix: handleAutoFix, onExport: handleExportReport }, result.fileId))) })] }) }), _jsxs("div", { className: "mt-6", children: [_jsx("h2", { className: "font-heading text-xl font-semibold text-white mb-3", children: "AI-Powered Insights" }), _jsx(AIInsightsPanel, { scanResults: scanResults, existingData: existingData, aiEngine: aiEngine })] }), _jsxs("div", { className: "mt-6", children: [_jsx("h2", { className: "font-heading text-xl font-semibold text-white mb-3", children: "Automation Rules" }), _jsx(AutomationRulesPanel, { rules: automationRules, onSave: saveAutomationRules })] }), reportHistory.length > 0 && (_jsxs("div", { className: "mt-6", children: [_jsx("h2", { className: "font-heading text-xl font-semibold text-white mb-3", children: "Report History" }), _jsx(ReportHistoryPanel, { history: reportHistory })] }))] }))] }));
    }
    if (activeTab === 'files') {
        return (_jsxs(_Fragment, { children: [_jsxs("header", { children: [_jsx("p", { className: "text-[11px] uppercase tracking-[0.3em] text-[#00D4FF]", children: "Data Intelligence" }), _jsx("h1", { className: "mt-2 font-heading text-3xl font-semibold text-white", children: "File Manager" }), _jsx("p", { className: "mt-1 text-sm text-slate-400", children: "Manage your data sources and scan history" })] }), _jsxs("div", { className: "flex items-center gap-3 mb-4", children: [_jsxs("div", { className: "relative flex-1", children: [_jsx(Search, { className: "absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" }), _jsx("input", { type: "text", value: searchTerm, onChange: (e) => setSearchTerm(e.target.value), placeholder: "Search files...", className: "w-full rounded-lg border border-white/10 bg-[#0A1628] py-2 pl-10 pr-4 text-sm text-slate-200 outline-none focus:border-[#00D4FF]" })] }), _jsxs("button", { onClick: () => fileInputRef.current?.click(), className: "flex items-center gap-2 rounded-lg bg-[#6C63FF] px-4 text-sm font-medium text-white hover:bg-[#5b52e8]", children: [_jsx(UploadCloud, { className: "h-4 w-4" }), "Upload"] })] }), _jsx("input", { type: "file", accept: ".csv,.xlsx,.xls", multiple: true, ref: fileInputRef, className: "hidden", onChange: (e) => {
                        handleUpload(e.target.files);
                        e.target.value = '';
                    } }), _jsx(Card, { title: "Uploaded Files", subtitle: `${files.length} total files`, children: _jsxs("div", { className: "space-y-2", children: [files
                                .filter((f) => {
                                const term = searchTerm.toLowerCase();
                                return !term || f.name.toLowerCase().includes(term);
                            })
                                .map((f) => (_jsx(FileRow, { file: f, onScan: handleUpload }, f.id))), !files.length && (_jsx("p", { className: "text-sm text-slate-500 py-4 text-center", children: "No files uploaded yet" }))] }) })] }));
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
    return (_jsxs("div", { className: "rounded-xl border border-white/5 bg-[#0A1628]/60", children: [_jsxs("div", { className: "flex items-center justify-between p-4", children: [_jsxs("div", { className: "flex items-center gap-3", children: [_jsx("div", { className: 'rounded-lg p-2 ' + SEVERITY_BG[health.grade === 'A' ? 'info' : health.score < 50 ? 'critical' : health.score < 70 ? 'high' : 'medium'], children: _jsx(FileSpreadsheet, { className: "h-5 w-5" }) }), _jsxs("div", { children: [_jsx("p", { className: "text-sm font-medium text-white", children: result.fileName }), _jsxs("p", { className: "text-xs text-slate-500", children: [result.rowCount, " rows \u00B7 ", issues.length, " issues \u00B7 Score: ", health.score, "/100 (", health.grade, ")"] })] })] }), _jsxs("div", { className: "flex items-center gap-2", children: [fixableCount > 0 && (_jsxs("button", { onClick: async () => {
                                    if (fixing)
                                        return;
                                    setFixing(true);
                                    const fixActions = [...new Set(issues.filter((i) => i.applyAutoFix).map((i) => i.fixAction))];
                                    for (const action of fixActions) {
                                        await onAutoFix(result.fileId, action);
                                    }
                                    setFixing(false);
                                }, disabled: fixing, className: "flex items-center gap-1 rounded-lg border border-[#00E096]/30 bg-[#00E096]/10 px-3 py-1 text-xs text-[#00E096] hover:bg-[#00E096]/20 disabled:opacity-50", title: 'Auto fix ' + fixableCount + ' issues', children: [fixing ? _jsx(RefreshCw, { className: "h-3 w-3 animate-spin" }) : _jsx(Zap, { className: "h-3.5 w-3.5" }), _jsxs("span", { children: ["Auto-fix (", fixableCount, ")"] })] })), _jsx("button", { onClick: () => onExport('json'), className: "rounded-lg border border-white/10 p-1.5 text-slate-400 hover:border-[#00D4FF]/60 hover:text-[#00D4FF]", title: "Export cleaned data", children: _jsx(Download, { className: "h-4 w-4" }) }), _jsx("button", { onClick: () => setExpanded(!expanded), className: "rounded-lg border border-white/10 p-1.5 text-slate-400 hover:border-[#00D4FF]/60 hover:text-[#00D4FF]", title: expanded ? 'Collapse' : 'Expand', children: expanded ? _jsx(XSquare, { className: "h-4 w-4" }) : _jsx(Eye, { className: "h-4 w-4" }) })] })] }), highPriorityIssues.length > 0 && (_jsx("div", { className: "px-4 pb-2", children: _jsxs("div", { className: "flex flex-wrap gap-1", children: [highPriorityIssues.slice(0, 5).map((issue, i) => (_jsx("span", { className: 'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ' + (SEVERITY_COLORS[issue.severity] || ''), children: issue.type.replace(/_/g, ' ') }, i))), highPriorityIssues.length > 5 && (_jsxs("span", { className: "text-xs text-slate-500", children: ["+", highPriorityIssues.length - 5, " more"] }))] }) })), expanded && (_jsxs("div", { className: "border-t border-white/5 p-4 space-y-3", children: [_jsxs("div", { className: "flex items-center gap-4 text-xs text-slate-400", children: [_jsxs("span", { children: ["Health: ", _jsxs("span", { className: "text-white", children: [health.score, "/100 \u2014 ", health.grade] })] }), _jsxs("span", { children: ["Rows: ", _jsx("span", { className: "text-white", children: result.rowCount })] }), _jsxs("span", { children: ["Issues: ", _jsx("span", { className: "text-white", children: issues.length })] })] }), _jsxs("div", { className: "space-y-2", children: [_jsx("div", { className: "text-xs font-medium text-slate-300", children: "Issue Breakdown" }), ['critical', 'high', 'medium', 'low'].map((sev) => {
                                const sevIssues = issues.filter((i) => i.severity === sev);
                                if (!sevIssues.length)
                                    return null;
                                return (_jsxs("div", { className: "space-y-1", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx("span", { className: 'w-2 h-2 rounded-full ' + (sev === 'critical' ? 'bg-[#FF6B6B]' : sev === 'high' ? 'bg-[#FF6B6B]/70' : sev === 'medium' ? 'bg-[#FFB547]' : 'bg-slate-500') }), _jsxs("span", { className: 'text-xs font-medium ' + (sev === 'critical' || sev === 'high' ? 'text-[#FF6B6B]' : sev === 'medium' ? 'text-[#FFB547]' : 'text-slate-400'), children: [sev.toUpperCase(), " (", sevIssues.length, ")"] })] }), sevIssues.slice(0, 3).map((issue, i) => (_jsxs("div", { className: "ml-4 text-xs text-slate-400", children: ["\u2022 ", issue.description, issue.suggestion && _jsxs("span", { className: "text-slate-600", children: [" \u2014 ", issue.suggestion] })] }, i)))] }, sev));
                            })] }), result.insights && result.insights.length > 0 && (_jsxs("div", { className: "space-y-2", children: [_jsx("div", { className: "text-xs font-medium text-slate-300", children: "Key Insights" }), result.insights.slice(0, 3).map((insight, i) => (_jsxs("div", { className: "flex items-start gap-2 text-xs", children: [_jsx(Lightbulb, { className: "h-3 w-3 shrink-0 mt-0.5 text-[#00D4FF]" }), _jsxs("div", { children: [_jsx("span", { className: "text-slate-300", children: insight.title }), _jsx("p", { className: "text-slate-500 mt-0.5", children: insight.detail })] })] }, i)))] })), fixableCount > 0 && (_jsx("div", { className: "pt-2 border-t border-white/5", children: _jsx("button", { onClick: () => onAutoFix(result.fileId, 'remove_duplicates'), className: "text-xs text-[#00E096] hover:text-[#00c885]", children: "Apply smart fixes to this file" }) }))] }))] }));
}
function AIInsightsPanel({ scanResults, existingData, aiEngine }) {
    const [loading, setLoading] = useState(false);
    const [insights, setInsights] = useState(null);
    const generateInsights = async () => {
        setLoading(true);
        try {
            const result = await aiEngine.generateComprehensiveInsights(scanResults, existingData, null);
            setInsights(result);
        }
        catch (e) {
            console.error(e);
        }
        setLoading(false);
    };
    return (_jsx(Card, { title: "AI-Powered Insights", subtitle: "Automated analysis and recommendations", children: _jsxs("div", { className: "space-y-3", children: [!insights && (_jsx("button", { onClick: generateInsights, disabled: loading || !scanResults.length, className: "w-full rounded-lg border border-[#00D4FF]/30 bg-[#00D4FF]/10 px-4 py-3 text-sm text-[#00D4FF] hover:bg-[#00D4FF]/20 disabled:opacity-50", children: loading ? 'Analyzing...' : scanResults.length ? 'Generate AI Insights' : 'Upload files to generate insights' })), insights && (_jsxs(_Fragment, { children: [_jsxs("div", { className: "grid grid-cols-3 gap-4 text-center", children: [_jsxs("div", { children: [_jsx("p", { className: "text-2xl font-bold text-white", children: insights.insights.length }), _jsx("p", { className: "text-xs text-slate-500", children: "Insights" })] }), _jsxs("div", { children: [_jsx("p", { className: "text-2xl font-bold text-white", children: insights.recommendations.length }), _jsx("p", { className: "text-xs text-slate-500", children: "Recommendations" })] }), _jsxs("div", { children: [_jsx("p", { className: "text-2xl font-bold text-white", children: insights.alerts.length }), _jsx("p", { className: "text-xs text-slate-500", children: "Alerts" })] })] }), _jsx("div", { className: "space-y-2 mt-3", children: insights.insights.slice(0, 8).map((insight, i) => (_jsx(InsightItem, { insight: insight }, i))) }), insights.recommendations.length > 0 && (_jsxs("div", { className: "pt-3 border-t border-white/5", children: [_jsx("p", { className: "text-xs font-medium text-slate-300 mb-2", children: "Top Recommendations" }), insights.recommendations.slice(0, 3).map((rec, i) => (_jsx(RecommendationItem, { rec: rec, onApply: () => { } }, i)))] }))] }))] }) }));
}
function InsightItem({ insight }) {
    const iconMap = {
        health: _jsx(Gauge, { className: "h-4 w-4" }),
        duplicate: _jsx(Database, { className: "h-4 w-4" }),
        missing: _jsx(AlertCircle, { className: "h-4 w-4" }),
        outlier: _jsx(BarChart3, { className: "h-4 w-4" }),
        consistency: _jsx(Share2, { className: "h-4 w-4" }),
        structure: _jsx(Database, { className: "h-4 w-4" }),
        type_mismatch: _jsx(AlertCircle, { className: "h-4 w-4" }),
        date_format: _jsx(Clock, { className: "h-4 w-4" }),
        conflict: _jsx(GitMerge, { className: "h-4 w-4" }),
        relationship: _jsx(Share2, { className: "h-4 w-4" }),
        overlap_warning: _jsx(AlertTriangle, { className: "h-4 w-4" }),
    };
    return (_jsx("div", { className: 'rounded-xl border p-3 ' + (SEVERITY_COLORS[insight.severity || insight.severity || 'info'] || ''), children: _jsxs("div", { className: "flex items-start gap-3", children: [_jsx("div", { className: "flex-shrink-0 mt-0.5", children: iconMap[insight.type] || _jsx(Info, { className: "h-4 w-4" }) }), _jsxs("div", { className: "flex-1 min-w-0", children: [_jsx("p", { className: "text-sm font-medium text-white", children: insight.title }), _jsx("p", { className: "text-xs text-slate-400 mt-0.5", children: insight.detail }), insight.fixable && (_jsx("span", { className: "inline-block mt-1 text-xs text-[#00E096]", children: "Auto-fix available" }))] }), _jsx("span", { className: 'text-[10px] uppercase tracking-wider ' + (insight.severity === 'critical' || insight.severity === 'high' ? 'text-[#FF6B6B]' :
                        insight.severity === 'medium' ? 'text-[#FFB547]' : 'text-slate-500'), children: insight.severity || 'info' })] }) }));
}
function RecommendationItem({ rec, onApply }) {
    return (_jsxs("div", { className: "flex items-center justify-between rounded-lg border border-white/5 bg-[#0A1628]/60 p-3", children: [_jsxs("div", { className: "flex items-start gap-3", children: [_jsx(Zap, { className: "h-4 w-4 shrink-0 text-[#00E096] mt-0.5" }), _jsxs("div", { children: [_jsx("p", { className: "text-sm font-medium text-white", children: rec.name }), _jsx("p", { className: "text-xs text-slate-400 mt-0.5", children: rec.description })] })] }), _jsx("button", { onClick: onApply, className: "rounded-lg border border-[#00E096]/30 bg-[#00E096]/10 px-2 py-1 text-xs text-[#00E096] hover:bg-[#00E096]/20", children: "Apply" })] }));
}
function FileRow({ file, onScan }) {
    const [scanning, setScanning] = useState(false);
    return (_jsxs("div", { className: "flex items-center justify-between rounded-lg border border-white/5 bg-[#0A1628]/60 p-3", children: [_jsxs("div", { className: "flex items-center gap-3", children: [_jsx(FileSpreadsheet, { className: "h-5 w-5 text-[#6C63FF]" }), _jsxs("div", { children: [_jsx("p", { className: "text-sm text-white", children: file.name }), _jsxs("p", { className: "text-xs text-slate-500", children: [file.rowCount, " rows \u00B7 ", file.type || 'Unknown type', " \u00B7 ", new Date(file.date).toLocaleDateString()] })] })] }), _jsx("button", { onClick: async () => {
                    setScanning(true);
                    onScan(file);
                    setScanning(false);
                }, disabled: scanning, className: "rounded-lg border border-white/10 p-1.5 text-slate-400 hover:border-[#00D4FF]/60 hover:text-[#00D4FF]", children: scanning ? _jsx(RefreshCw, { className: "h-4 w-4 animate-spin" }) : _jsx(Search, { className: "h-4 w-4" }) })] }));
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
    return (_jsx(Card, { title: "Automation Rules", subtitle: "Auto-detect and fix data issues", children: _jsxs("div", { className: "space-y-3", children: [_jsxs("button", { onClick: () => setShowNew(true), className: "flex items-center gap-2 rounded-lg border border-[#6C63FF]/30 bg-[#6C63FF]/10 px-3 py-1.5 text-xs text-[#6C63FF] hover:bg-[#6C63FF]/20", children: [_jsx(Settings, { className: "h-3.5 w-3.5" }), "New Rule"] }), showNew && (_jsxs("div", { className: "rounded-lg border border-white/10 bg-[#0A1628]/60 p-3 space-y-3", children: [_jsx("input", { type: "text", placeholder: "Rule name...", value: newRule.name, onChange: (e) => setNewRule({ ...newRule, name: e.target.value }), className: "w-full rounded-lg border border-white/10 bg-[#040D1A] px-3 py-1.5 text-sm text-slate-200 outline-none focus:border-[#6C63FF]" }), _jsxs("select", { value: newRule.trigger, onChange: (e) => setNewRule({ ...newRule, trigger: e.target.value }), className: "w-full rounded-lg border border-white/10 bg-[#040D1A] px-3 py-1.5 text-sm text-slate-200 outline-none focus:border-[#6C63FF]", children: [_jsx("option", { value: "file_upload", children: "On file upload" }), _jsx("option", { value: "schedule", children: "Daily schedule" }), _jsx("option", { value: "data_change", children: "When data changes" })] }), _jsxs("select", { value: newRule.action, onChange: (e) => setNewRule({ ...newRule, action: e.target.value }), className: "w-full rounded-lg border border-white/10 bg-[#040D1A] px-3 py-1.5 text-sm text-slate-200 outline-none focus:border-[#6C63FF]", children: [_jsx("option", { value: "auto_fix", children: "Auto-fix issues" }), _jsx("option", { value: "alert", children: "Send alert" }), _jsx("option", { value: "flag", children: "Flag for review" })] }), _jsxs("div", { className: "flex gap-2", children: [_jsx("button", { onClick: handleAddRule, className: "rounded-lg bg-[#00E096] px-3 py-1 text-xs font-medium text-[#040D1A] hover:bg-[#00c885]", children: "Save Rule" }), _jsx("button", { onClick: () => setShowNew(false), className: "rounded-lg border border-white/10 px-3 py-1 text-xs text-slate-400 hover:bg-white/5", children: "Cancel" })] })] })), rules.map((rule) => (_jsxs("div", { className: "rounded-lg border border-white/5 bg-[#0A1628]/60 p-3", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsxs("div", { className: "flex items-center gap-2", children: [rule.enabled ? _jsx(PlayCircle, { className: "h-4 w-4 text-[#00E096]" }) : _jsx(PauseCircle, { className: "h-4 w-4 text-slate-500" }), _jsx("span", { className: "text-sm font-medium text-white", children: rule.name }), _jsx("span", { className: 'rounded-full px-2 py-0.5 text-xs ' + (rule.enabled ? 'bg-[#00E096]/15 text-[#00E096]' : 'bg-slate-500/15 text-slate-500'), children: rule.enabled ? 'Active' : 'Paused' })] }), _jsxs("div", { className: "flex items-center gap-1", children: [_jsxs("span", { className: "text-xs text-slate-500", children: ["Ran: ", rule.runCount || 0, "x"] }), _jsx("button", { onClick: () => toggleRule(rule.id), className: "rounded-md p-1 text-slate-400 hover:bg-white/5 hover:text-white", children: _jsx(Settings, { className: "h-3.5 w-3.5" }) }), _jsx("button", { onClick: () => deleteRule(rule.id), className: "rounded-md p-1 text-slate-400 hover:bg-white/5 hover:text-[#FF6B6B]", children: _jsx(Trash2, { className: "h-3.5 w-3.5" }) })] })] }), _jsxs("div", { className: "mt-1 text-xs text-slate-500", children: ["Trigger: ", rule.trigger, " \u00B7 Action: ", rule.action] })] }, rule.id))), !rules.length && !showNew && (_jsx("p", { className: "text-xs text-slate-500", children: "No automation rules configured. Create one to get started." }))] }) }));
}
function ReportHistoryPanel({ history }) {
    return (_jsx(Card, { title: "Report History", subtitle: "Previous scan reports and insights", children: _jsx("div", { className: "space-y-2", children: history.slice(0, 10).map((report, i) => (_jsx("div", { className: "rounded-lg border border-white/5 bg-[#0A1628]/60 p-3", children: _jsxs("div", { className: "flex items-center justify-between", children: [_jsxs("div", { children: [_jsxs("p", { className: "text-sm text-white", children: ["Report #", history.length - i, " \u2014 ", new Date(report.generatedAt).toLocaleString()] }), _jsxs("p", { className: "text-xs text-slate-500", children: [report.filesScanned, " files \u00B7 ", report.totalRows, " rows \u00B7 ", report.totalIssues, " issues"] })] }), _jsx("button", { onClick: () => {
                                const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
                                const url = URL.createObjectURL(blob);
                                const link = document.createElement('a');
                                link.href = url;
                                link.download = `data-report-${Date.now()}.json`;
                                link.click();
                                URL.revokeObjectURL(url);
                            }, className: "rounded-lg border border-white/10 p-1.5 text-slate-400 hover:border-[#00D4FF]/60 hover:text-[#00D4FF]", title: "Download report", children: _jsx(Download, { className: "h-3.5 w-3.5" }) })] }) }, i))) }) }));
}
