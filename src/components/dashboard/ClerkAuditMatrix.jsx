import React, { useMemo, useState, useEffect } from "react";
import { money2 } from "@/lib/hotel";
import { AlertTriangle, DollarSign, UserX, FileWarning, X, ChevronUp, ChevronDown, CheckCircle2, TrendingUp, Sparkles, Clock, LogOut } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

export default function ClerkAuditMatrix({ 
  flaggedAnomalies = [], 
  clerkRiskScores = [], 
  adjustments = [], 
  refunds = [] 
}) {
  const [selectedClerk, setSelectedClerk] = useState(null);
  const [sortConfig, setSortConfig] = useState({ key: 'severityScore', direction: 'desc' });
  
  // Rolling Number Effect
  const useRollingNumber = (value) => {
    const [display, setDisplay] = useState(0);
    useEffect(() => {
      let start = display;
      const end = value;
      if (start === end) return;
      const duration = 1000;
      const startTime = performance.now();
      
      const update = (now) => {
        const progress = Math.min((now - startTime) / duration, 1);
        const easeOut = 1 - Math.pow(1 - progress, 3);
        setDisplay(start + (end - start) * easeOut);
        if (progress < 1) requestAnimationFrame(update);
      };
      requestAnimationFrame(update);
    }, [value]);
    return display;
  };

  // KPIs
  const totalAnomalies = flaggedAnomalies.length;
  const displayAnomalies = useRollingNumber(totalAnomalies);
  
  const totalCashRefunds = refunds.reduce((acc, r) => String(r.paymentTypeRefunded || '').toUpperCase() === 'CASH' ? acc + Math.abs(Number(r.amount) || 0) : acc, 0);
  const displayCashRefunds = useRollingNumber(totalCashRefunds);
  
  const highRiskClerks = clerkRiskScores.filter(c => c.riskLevel === 'HIGH').length;
  const displayHighRisk = useRollingNumber(highRiskClerks);
  
  const totalAdjusted = adjustments.reduce((acc, a) => acc + Math.abs(Number(a.adjustedAmount ?? a.amount) || 0), 0);
  const displayAdjusted = useRollingNumber(totalAdjusted);

  // Sorting
  const riskLevels = { 'HIGH': 3, 'MEDIUM': 2, 'LOW': 1 };
  const sortedClerkScores = useMemo(() => {
    return [...clerkRiskScores].sort((a, b) => {
      if (riskLevels[a.riskLevel] !== riskLevels[b.riskLevel]) {
        return riskLevels[b.riskLevel] - riskLevels[a.riskLevel];
      }
      return b.totalFlags - a.totalFlags;
    });
  }, [clerkRiskScores]);

  const severityScores = { 'CRITICAL': 3, 'HIGH': 2, 'MEDIUM': 1, 'LOW': 0 };
  const sortedAnomalies = useMemo(() => {
    let sortableItems = [...flaggedAnomalies].map(a => ({
      ...a,
      severityScore: severityScores[a.severity] || 0
    }));

    if (sortConfig.key !== null) {
      sortableItems.sort((a, b) => {
        let aValue = a[sortConfig.key];
        let bValue = b[sortConfig.key];
        if (sortConfig.key === 'amount') {
          aValue = Number(aValue);
          bValue = Number(bValue);
        }
        if (aValue < bValue) return sortConfig.direction === 'asc' ? -1 : 1;
        if (aValue > bValue) return sortConfig.direction === 'asc' ? 1 : -1;
        return 0;
      });
    }
    return sortableItems;
  }, [flaggedAnomalies, sortConfig]);

  const requestSort = (key) => {
    let direction = 'asc';
    if (sortConfig.key === key && sortConfig.direction === 'asc') direction = 'desc';
    setSortConfig({ key, direction });
  };

  const SortIcon = ({ columnKey }) => {
    if (sortConfig.key !== columnKey) return null;
    return sortConfig.direction === 'asc' ? <ChevronUp className="inline w-3 h-3 ml-1 text-slate-400" /> : <ChevronDown className="inline w-3 h-3 ml-1 text-slate-400" />;
  };

  const getBadgeStyle = (level) => {
    if (level === 'CRITICAL') return { background: 'rgba(255, 107, 107, 0.1)', color: '#FF6B6B', border: '1px solid rgba(255, 107, 107, 0.3)', boxShadow: '0 0 12px rgba(255,107,107,0.4)' };
    if (level === 'HIGH') return { background: 'rgba(255, 159, 122, 0.1)', color: '#FF9F7A', border: '1px solid rgba(255, 159, 122, 0.3)' };
    if (level === 'MEDIUM') return { background: 'rgba(255, 181, 71, 0.1)', color: '#FFB547', border: '1px solid rgba(255, 181, 71, 0.3)' };
    if (level === 'LOW') return { background: 'rgba(0, 224, 150, 0.1)', color: '#00E096', border: '1px solid rgba(0, 224, 150, 0.3)' };
    return { background: 'rgba(51, 65, 85, 0.2)', color: '#94a3b8', border: '1px solid rgba(51, 65, 85, 0.4)' };
  };

  const truncate = (str, n) => {
    if (!str) return '';
    return str.length > n ? str.substring(0, n - 1) + '...' : str;
  };

  const getRuleIcon = (ruleId) => {
    if (!ruleId) return <AlertTriangle className="w-3.5 h-3.5" />;
    if (ruleId.includes('time') || ruleId.includes('graveyard') || ruleId.includes('off_hours')) return <Clock className="w-3.5 h-3.5" />;
    if (ruleId.includes('skimming') || ruleId.includes('refund')) return <DollarSign className="w-3.5 h-3.5" />;
    if (ruleId.includes('remarks') || ruleId.includes('writeoff')) return <FileWarning className="w-3.5 h-3.5" />;
    if (ruleId.includes('loop')) return <TrendingUp className="w-3.5 h-3.5" />;
    return <AlertTriangle className="w-3.5 h-3.5" />;
  };

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }} className="space-y-6 pb-20">
      
      {/* 1. Immersive KPI Bar */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: "Anomalies Flagged", val: Math.round(displayAnomalies), raw: totalAnomalies, icon: AlertTriangle, color: "#FF6B6B" },
          { label: "Cash Refunds (Risk)", val: money2(displayCashRefunds), raw: totalCashRefunds, icon: DollarSign, color: "#FFB547" },
          { label: "High-Risk Clerks", val: Math.round(displayHighRisk), raw: highRiskClerks, icon: UserX, color: "#FF6B6B" },
          { label: "Total Adjusted", val: money2(displayAdjusted), raw: totalAdjusted, icon: LogOut, color: "#6C63FF" },
        ].map((kpi, i) => (
          <div key={i} className="relative overflow-hidden rounded-2xl border border-white/5 bg-gradient-to-b from-[#0F1F35]/90 to-[#0A1628]/90 p-5 shadow-[0_8px_32px_rgba(0,0,0,0.3)] backdrop-blur-xl group hover:border-white/10 transition-all duration-300">
            <div className="absolute inset-x-0 top-0 h-[2px] opacity-70 group-hover:opacity-100 transition-opacity" style={{ background: `linear-gradient(90deg, transparent, ${kpi.color}, transparent)` }} />
            <div className="absolute -right-4 -bottom-4 opacity-5 blur-xl group-hover:opacity-10 transition-opacity duration-500">
              <kpi.icon className="w-32 h-32" style={{ color: kpi.color }} />
            </div>
            <div className="relative z-10 flex items-center justify-between mb-4">
              <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-slate-400">{kpi.label}</p>
              <div className="p-2 rounded-lg bg-white/[0.03] border border-white/5">
                <kpi.icon className="w-4 h-4" style={{ color: kpi.color }} />
              </div>
            </div>
            <p className="relative z-10 font-heading text-3xl font-semibold tabular-nums text-white">
              {kpi.val}
            </p>
          </div>
        ))}
      </div>

      {/* 2. Clerk Risk Scorecard (AI Enhanced) */}
      <div className="rounded-2xl border border-white/5 bg-[#040D1A]/80 backdrop-blur-2xl shadow-[0_8px_32px_rgba(0,0,0,0.4)] overflow-hidden">
        <div className="px-6 py-5 border-b border-white/5 bg-gradient-to-r from-cyan-900/10 to-transparent flex items-center gap-3">
          <Sparkles className="w-5 h-5 text-cyan-400" />
          <div>
            <h2 className="text-lg font-semibold bg-gradient-to-r from-white to-slate-400 bg-clip-text text-transparent">Clerk Risk Matrix</h2>
            <p className="text-xs text-slate-500 mt-1">AI-powered behavioral analysis and aggregated risk scoring</p>
          </div>
        </div>
        
        {clerkRiskScores.length === 0 ? (
          <div className="p-8 text-center text-slate-500">No clerk data available</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="text-slate-400 text-[11px] uppercase tracking-wider border-b border-white/5 bg-white/[0.01]">
                <tr>
                  <th className="px-6 py-4 font-medium">Clerk Name</th>
                  <th className="px-6 py-4 font-medium text-right">Adjustments</th>
                  <th className="px-6 py-4 font-medium text-right">Cash Refunds</th>
                  <th className="px-6 py-4 font-medium text-right">Flags</th>
                  <th className="px-6 py-4 font-medium">AI Behavior Analysis</th>
                  <th className="px-6 py-4 font-medium text-center">Risk Level</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {sortedClerkScores.map((clerk, idx) => (
                  <tr 
                    key={idx} 
                    className="hover:bg-white/[0.04] cursor-pointer transition-all duration-200 group relative"
                    onClick={() => setSelectedClerk(clerk)}
                  >
                    <td className="px-6 py-4 font-medium text-slate-200 group-hover:text-cyan-400 transition-colors flex items-center gap-2">
                      {clerk.username}
                      <ChevronRightIcon className="w-4 h-4 opacity-0 group-hover:opacity-100 -translate-x-2 group-hover:translate-x-0 transition-all text-cyan-500" />
                    </td>
                    <td className="px-6 py-4 text-right text-slate-300 font-mono">{money2(clerk.totalAdjustedAmount)}</td>
                    <td className="px-6 py-4 text-right text-slate-300 font-mono">{money2(clerk.totalRefundedAmount)}</td>
                    <td className="px-6 py-4 text-right font-mono">
                      <span className={`px-2.5 py-1 rounded-md bg-white/5 border border-white/10 ${clerk.totalFlags > 0 ? 'text-[#FF6B6B]' : 'text-slate-400'}`}>
                        {clerk.totalFlags}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-xs">
                      {clerk.behaviorAnalysis ? (
                        <span className={clerk.behaviorAnalysis.includes('Normal') ? 'text-slate-400' : 'text-amber-400/90'}>
                          {clerk.behaviorAnalysis}
                        </span>
                      ) : (
                        <span className="text-slate-500">-</span>
                      )}
                    </td>
                    <td className="px-6 py-4 text-center">
                      <span 
                        className="rounded-full px-3 py-1 text-[10px] uppercase font-bold tracking-widest transition-all"
                        style={getBadgeStyle(clerk.riskLevel)}
                      >
                        {clerk.riskLevel}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 3. Flagged Transactions Master List */}
      <div className="rounded-2xl border border-white/5 bg-[#040D1A]/80 backdrop-blur-2xl shadow-[0_8px_32px_rgba(0,0,0,0.4)] overflow-hidden">
        <div className="px-6 py-5 border-b border-white/5 bg-gradient-to-r from-[#FF6B6B]/10 to-transparent flex items-center gap-3">
          <AlertTriangle className="w-5 h-5 text-[#FF6B6B]" />
          <div>
            <h2 className="text-lg font-semibold bg-gradient-to-r from-coral-400 to-purple-500 bg-clip-text text-transparent">Anomaly Ledger</h2>
            <p className="text-xs text-slate-500 mt-1">Individual transactions flagged by detection rules</p>
          </div>
        </div>

        {flaggedAnomalies.length === 0 ? (
          <div className="p-16 flex flex-col items-center justify-center text-slate-400 bg-gradient-to-b from-transparent to-black/20">
            <motion.div initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ delay: 0.2 }}>
              <div className="relative">
                <div className="absolute inset-0 bg-[#00E096] blur-xl opacity-20 rounded-full" />
                <CheckCircle2 className="w-20 h-20 text-[#00E096] mb-6 drop-shadow-2xl relative z-10" />
              </div>
            </motion.div>
            <p className="text-xl font-semibold text-white mb-2">System Secure</p>
            <p className="text-sm">No anomalous transactions detected in this batch.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="text-slate-400 text-[11px] uppercase tracking-widest border-b border-white/5 bg-white/[0.02]">
                <tr>
                  <th className="px-6 py-4 font-medium cursor-pointer hover:text-white transition-colors group" onClick={() => requestSort('date')}>
                    Date/Time <SortIcon columnKey="date" />
                  </th>
                  <th className="px-6 py-4 font-medium cursor-pointer hover:text-white transition-colors group" onClick={() => requestSort('username')}>
                    Clerk <SortIcon columnKey="username" />
                  </th>
                  <th className="px-6 py-4 font-medium cursor-pointer hover:text-white transition-colors group" onClick={() => requestSort('roomNumber')}>
                    Room <SortIcon columnKey="roomNumber" />
                  </th>
                  <th className="px-6 py-4 font-medium cursor-pointer hover:text-white transition-colors group" onClick={() => requestSort('riskType')}>
                    Detection Rule <SortIcon columnKey="riskType" />
                  </th>
                  <th className="px-6 py-4 font-medium cursor-pointer hover:text-white transition-colors text-right group" onClick={() => requestSort('amount')}>
                    Amount <SortIcon columnKey="amount" />
                  </th>
                  <th className="px-6 py-4 font-medium cursor-pointer hover:text-white transition-colors text-center group" onClick={() => requestSort('severityScore')}>
                    Severity <SortIcon columnKey="severityScore" />
                  </th>
                  <th className="px-6 py-4 font-medium">Remarks</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {sortedAnomalies.map((anomaly, idx) => (
                  <tr key={idx} className="hover:bg-white/[0.04] transition-colors group">
                    <td className="px-6 py-3.5 text-slate-300 whitespace-nowrap font-mono text-[13px]">{anomaly.date} <span className="text-slate-500 ml-1">{anomaly.time}</span></td>
                    <td className="px-6 py-3.5 text-slate-200 font-medium">{anomaly.username}</td>
                    <td className="px-6 py-3.5 text-slate-300 font-mono">{anomaly.roomNumber}</td>
                    <td className="px-6 py-3.5">
                      <div className="flex items-center gap-2">
                        <span className="text-slate-400">{getRuleIcon(anomaly.ruleId)}</span>
                        <span className="text-slate-300">{anomaly.riskType}</span>
                      </div>
                    </td>
                    <td className={`px-6 py-3.5 text-right font-mono whitespace-nowrap ${Math.abs(Number(anomaly.amount)) >= 50 ? 'text-[#FF6B6B] font-bold' : 'text-slate-300'}`}>
                      {money2(anomaly.amount)}
                    </td>
                    <td className="px-6 py-3.5 text-center">
                       <span 
                        className="rounded-full px-3 py-1 text-[9px] uppercase tracking-[0.15em] font-bold" 
                        style={getBadgeStyle(anomaly.severity)}
                      >
                        {anomaly.severity}
                      </span>
                    </td>
                    <td className="px-6 py-3.5 text-slate-400 text-xs" title={anomaly.remarks}>
                      {truncate(anomaly.remarks, 35)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 4. Sliding Side-Panel (Drill Down) */}
      <AnimatePresence>
        {selectedClerk && (
          <>
            <motion.div 
              initial={{ opacity: 0 }} 
              animate={{ opacity: 1 }} 
              exit={{ opacity: 0 }} 
              className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm"
              onClick={() => setSelectedClerk(null)}
            />
            <motion.div 
              initial={{ x: '100%', opacity: 0.5 }} 
              animate={{ x: 0, opacity: 1 }} 
              exit={{ x: '100%', opacity: 0.5 }}
              transition={{ type: "spring", bounce: 0, duration: 0.4 }}
              className="fixed inset-y-0 right-0 z-50 w-full max-w-3xl bg-[#0F1F35] border-l border-white/10 shadow-[-20px_0_50px_rgba(0,0,0,0.5)] flex flex-col"
            >
              {/* Header */}
              <div className="flex items-center justify-between px-8 py-6 border-b border-white/10 bg-[#0A1628]">
                <div>
                  <h3 className="text-2xl font-semibold text-white flex items-center gap-3">
                    <UserX className="text-cyan-400 w-6 h-6" />
                    Audit Trail: <span className="text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 to-blue-500">{selectedClerk.username}</span>
                  </h3>
                  <p className="text-sm text-slate-400 mt-1 flex items-center gap-2">
                    <span style={getBadgeStyle(selectedClerk.riskLevel)} className="px-2 py-0.5 rounded text-[10px] font-bold tracking-wider">{selectedClerk.riskLevel} RISK</span>
                    • {selectedClerk.totalFlags} flagged items across adjustments and refunds
                  </p>
                </div>
                <button 
                  onClick={() => setSelectedClerk(null)}
                  className="p-2 rounded-full bg-white/5 text-slate-400 hover:text-white hover:bg-white/10 hover:rotate-90 transition-all duration-300"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Body */}
              <div className="flex-1 overflow-y-auto p-8 space-y-10 custom-scrollbar">
                
                {/* Adjustments Section */}
                <section>
                  <div className="flex items-center gap-3 mb-5">
                    <div className="p-2 rounded-xl bg-gradient-to-br from-purple-500/20 to-purple-600/5 border border-purple-500/20">
                      <FileWarning className="w-5 h-5 text-purple-400" />
                    </div>
                    <h4 className="text-xl font-semibold text-white tracking-tight">Adjustments Ledger</h4>
                  </div>
                  <div className="bg-[#040D1A]/80 border border-white/10 rounded-2xl overflow-hidden shadow-inner">
                    <table className="w-full text-sm text-left">
                      <thead className="text-slate-400 text-[11px] uppercase tracking-widest border-b border-white/10 bg-white/[0.02]">
                        <tr>
                          <th className="px-5 py-3.5 font-medium">Time</th>
                          <th className="px-5 py-3.5 font-medium">Room</th>
                          <th className="px-5 py-3.5 font-medium">Reason</th>
                          <th className="px-5 py-3.5 font-medium text-right">Amount</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/5">
                        {adjustments
                          .filter(a => a.username === selectedClerk.username)
                          .map((adj, i) => {
                            const isFlagged = flaggedAnomalies.some(f => f.transaction === adj || (f.username === adj.username && f.date === adj.date && f.time === adj.time && f.amount === (adj.adjustedAmount ?? adj.amount)));
                            return (
                              <tr key={i} className={`hover:bg-white/[0.04] transition-colors ${isFlagged ? 'bg-[#FF6B6B]/[0.05] border-l-[3px] border-l-[#FF6B6B]' : 'border-l-[3px] border-l-transparent'}`}>
                                <td className="px-5 py-3 text-slate-300 whitespace-nowrap font-mono text-xs flex flex-col">
                                  <span>{adj.date}</span>
                                  <span className="text-slate-500">{adj.time}</span>
                                </td>
                                <td className="px-5 py-3 text-slate-200 font-mono">{adj.roomNumber}</td>
                                <td className="px-5 py-3">
                                  <div className="text-slate-300 font-medium mb-1">{adj.reasonCode}</div>
                                  <div className="text-slate-500 text-[11px] leading-tight max-w-[200px] truncate" title={adj.remarks}>{adj.remarks || 'No remarks'}</div>
                                </td>
                                <td className="px-5 py-3 text-right font-mono text-slate-200 whitespace-nowrap">
                                  {money2(adj.adjustedAmount ?? adj.amount)}
                                  {isFlagged && <AlertTriangle className="inline w-3 h-3 ml-2 text-[#FF6B6B]" />}
                                </td>
                              </tr>
                            );
                        })}
                        {adjustments.filter(a => a.username === selectedClerk.username).length === 0 && (
                          <tr><td colSpan="4" className="px-5 py-8 text-center text-slate-500">No adjustments posted.</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </section>

                {/* Refunds Section */}
                <section>
                  <div className="flex items-center gap-3 mb-5">
                    <div className="p-2 rounded-xl bg-gradient-to-br from-amber-500/20 to-amber-600/5 border border-amber-500/20">
                      <DollarSign className="w-5 h-5 text-amber-400" />
                    </div>
                    <h4 className="text-xl font-semibold text-white tracking-tight">Refunds Ledger</h4>
                  </div>
                  <div className="bg-[#040D1A]/80 border border-white/10 rounded-2xl overflow-hidden shadow-inner">
                    <table className="w-full text-sm text-left">
                      <thead className="text-slate-400 text-[11px] uppercase tracking-widest border-b border-white/10 bg-white/[0.02]">
                        <tr>
                          <th className="px-5 py-3.5 font-medium">Time</th>
                          <th className="px-5 py-3.5 font-medium">Room</th>
                          <th className="px-5 py-3.5 font-medium">Type & Code</th>
                          <th className="px-5 py-3.5 font-medium text-right">Amount</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/5">
                        {refunds
                          .filter(r => r.username === selectedClerk.username)
                          .map((ref, i) => {
                            const isFlagged = flaggedAnomalies.some(f => f.transaction === ref || (f.username === ref.username && f.date === ref.date && f.time === ref.time && f.amount === ref.amount));
                            const isCash = String(ref.paymentTypeRefunded || '').toUpperCase() === 'CASH';
                            return (
                              <tr key={i} className={`hover:bg-white/[0.04] transition-colors ${isFlagged ? 'bg-[#FF6B6B]/[0.05] border-l-[3px] border-l-[#FF6B6B]' : 'border-l-[3px] border-l-transparent'}`}>
                                <td className="px-5 py-3 text-slate-300 whitespace-nowrap font-mono text-xs flex flex-col">
                                  <span>{ref.date}</span>
                                  <span className="text-slate-500">{ref.time}</span>
                                </td>
                                <td className="px-5 py-3 text-slate-200 font-mono">{ref.roomNumber}</td>
                                <td className="px-5 py-3">
                                  <div className={`font-bold mb-1 text-[11px] uppercase tracking-wider ${isCash ? 'text-amber-400' : 'text-slate-400'}`}>{ref.paymentTypeRefunded}</div>
                                  <div className="text-slate-300 text-xs mb-1">{ref.refundCode}</div>
                                  <div className="text-slate-500 text-[11px] leading-tight max-w-[200px] truncate" title={ref.remarks}>{ref.remarks || 'No remarks'}</div>
                                </td>
                                <td className="px-5 py-3 text-right font-mono text-slate-200 whitespace-nowrap">
                                  {money2(ref.amount)}
                                  {isFlagged && <AlertTriangle className="inline w-3 h-3 ml-2 text-[#FF6B6B]" />}
                                </td>
                              </tr>
                            );
                        })}
                        {refunds.filter(r => r.username === selectedClerk.username).length === 0 && (
                          <tr><td colSpan="4" className="px-5 py-8 text-center text-slate-500">No refunds posted.</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </section>

              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// Minimal inline icon component to avoid needing heroicons if not installed
function ChevronRightIcon(props) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" {...props}>
      <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
    </svg>
  );
}
