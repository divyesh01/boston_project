import React, { useMemo, useState } from "react";
import Card from "@/components/ui-exec/Card";
import KpiCard from "@/components/ui-exec/KpiCard";
import { money2, C } from "@/lib/hotel";
import { AlertTriangle, DollarSign, UserX, FileWarning, X, ChevronUp, ChevronDown, CheckCircle2 } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

export default function ClerkAuditMatrix({ 
  flaggedAnomalies = [], 
  clerkRiskScores = [], 
  adjustments = [], 
  refunds = [] 
}) {
  const [selectedClerk, setSelectedClerk] = useState(null);
  const [sortConfig, setSortConfig] = useState({ key: 'severityScore', direction: 'desc' });

  // KPIs
  const totalAnomalies = flaggedAnomalies.length;
  const totalCashRefunds = refunds.reduce((acc, r) => r.paymentTypeRefunded === 'CASH' ? acc + (Number(r.amount) || 0) : acc, 0);
  const highRiskClerks = clerkRiskScores.filter(c => c.riskLevel === 'HIGH').length;
  const totalAdjusted = adjustments.reduce((acc, a) => acc + Math.abs(Number(a.adjustedAmount) || 0), 0);

  // Sorting for clerk scores
  const riskLevels = { 'HIGH': 3, 'MEDIUM': 2, 'LOW': 1 };
  const sortedClerkScores = useMemo(() => {
    return [...clerkRiskScores].sort((a, b) => {
      if (riskLevels[a.riskLevel] !== riskLevels[b.riskLevel]) {
        return riskLevels[b.riskLevel] - riskLevels[a.riskLevel];
      }
      return b.totalFlags - a.totalFlags;
    });
  }, [clerkRiskScores]);

  // Sorting for flagged transactions
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
    if (sortConfig.key === key && sortConfig.direction === 'asc') {
      direction = 'desc';
    }
    setSortConfig({ key, direction });
  };

  const SortIcon = ({ columnKey }) => {
    if (sortConfig.key !== columnKey) return null;
    return sortConfig.direction === 'asc' ? <ChevronUp className="inline w-3 h-3 ml-1 text-slate-300" /> : <ChevronDown className="inline w-3 h-3 ml-1 text-slate-300" />;
  };

  const getBadgeStyle = (level) => {
    if (level === 'CRITICAL') return { background: '#FF6B6B20', color: '#FF6B6B', border: '1px solid #FF6B6B50', boxShadow: '0 0 10px rgba(255,107,107,0.3)' };
    if (level === 'HIGH') return { background: '#FF9F7A20', color: '#FF9F7A', border: '1px solid #FF9F7A50' };
    if (level === 'MEDIUM') return { background: '#FFB54720', color: '#FFB547', border: '1px solid #FFB54750' };
    if (level === 'LOW') return { background: '#00E09620', color: '#00E096', border: '1px solid #00E09650' };
    return { background: '#33415520', color: '#94a3b8', border: '1px solid #33415540' };
  };

  // Truncate helper
  const truncate = (str, n) => {
    if (!str) return '';
    return str.length > n ? str.substring(0, n - 1) + '...' : str;
  };

  const containerVariants = {
    hidden: { opacity: 0 },
    show: {
      opacity: 1,
      transition: { staggerChildren: 0.05 }
    }
  };

  const itemVariants = {
    hidden: { opacity: 0, y: 10 },
    show: { opacity: 1, y: 0 }
  };

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }} className="space-y-6">
      
      {/* 1. KPIs */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard label="Total Anomalies Flagged" value={totalAnomalies} icon={AlertTriangle} color="#FF6B6B" />
        <KpiCard label="Total Cash Refunds" value={money2(totalCashRefunds)} icon={DollarSign} color="#FFB547" />
        <KpiCard label="High-Risk Clerks" value={highRiskClerks} icon={UserX} color="#FF6B6B" />
        <KpiCard label="Total Adjusted" value={money2(totalAdjusted)} icon={FileWarning} color="#6C63FF" />
      </div>

      {/* 2. Clerk Risk Scorecard Table */}
      <div className="rounded-2xl border border-white/10 bg-white/[0.02] backdrop-blur-xl shadow-2xl overflow-hidden">
        <div className="px-6 py-5 border-b border-white/5 bg-gradient-to-r from-[#0A1628]/80 to-transparent">
          <h2 className="text-lg font-semibold bg-gradient-to-r from-white to-slate-400 bg-clip-text text-transparent">Clerk Risk Scorecard</h2>
          <p className="text-sm text-slate-500 mt-1">Aggregated anomaly risk per employee</p>
        </div>
        
        {clerkRiskScores.length === 0 ? (
          <div className="p-8 text-center text-slate-500">No clerk data available</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="text-slate-400 text-xs uppercase tracking-wider border-b border-white/5 bg-[#040D1A]/50">
                <tr>
                  <th className="px-6 py-4 font-medium">Clerk Name</th>
                  <th className="px-6 py-4 font-medium text-right">Total Adjustments</th>
                  <th className="px-6 py-4 font-medium text-right">Cash Refunds</th>
                  <th className="px-6 py-4 font-medium text-right">Flags</th>
                  <th className="px-6 py-4 font-medium text-center">Risk Level</th>
                </tr>
              </thead>
              <motion.tbody variants={containerVariants} initial="hidden" animate="show" className="divide-y divide-white/5">
                {sortedClerkScores.map((clerk, idx) => (
                  <motion.tr 
                    variants={itemVariants}
                    key={idx} 
                    className="hover:bg-white/[0.04] cursor-pointer transition-all duration-200 group"
                    onClick={() => setSelectedClerk(clerk)}
                  >
                    <td className="px-6 py-4 font-medium text-slate-200 group-hover:text-white transition-colors">{clerk.username}</td>
                    <td className="px-6 py-4 text-right text-slate-300 font-mono">{money2(clerk.totalAdjustedAmount)}</td>
                    <td className="px-6 py-4 text-right text-slate-300 font-mono">{money2(clerk.totalRefundedAmount)}</td>
                    <td className="px-6 py-4 text-right text-slate-300 font-mono">{clerk.totalFlags}</td>
                    <td className="px-6 py-4 text-center">
                      <span 
                        className="rounded-full px-3 py-1 text-xs font-semibold tracking-wide transition-all"
                        style={getBadgeStyle(clerk.riskLevel)}
                      >
                        {clerk.riskLevel}
                      </span>
                    </td>
                  </motion.tr>
                ))}
              </motion.tbody>
            </table>
          </div>
        )}
      </div>

      {/* 3. Flagged Transactions Table */}
      <div className="rounded-2xl border border-white/10 bg-white/[0.02] backdrop-blur-xl shadow-2xl overflow-hidden">
        <div className="px-6 py-5 border-b border-white/5 bg-gradient-to-r from-[#0A1628]/80 to-transparent">
          <h2 className="text-lg font-semibold bg-gradient-to-r from-coral-400 to-purple-500 bg-clip-text text-transparent">Flagged Transactions</h2>
          <p className="text-sm text-slate-500 mt-1">Transactions flagged by anomaly detection rules</p>
        </div>

        {flaggedAnomalies.length === 0 ? (
          <div className="p-12 flex flex-col items-center justify-center text-slate-400">
            <motion.div initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ delay: 0.2 }}>
              <CheckCircle2 className="w-16 h-16 text-[#00E096] mb-4 opacity-80 drop-shadow-[0_0_15px_rgba(0,224,150,0.4)]" />
            </motion.div>
            <p className="text-lg font-medium">No anomalies detected</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="text-slate-400 text-[11px] uppercase tracking-widest border-b border-white/5 bg-[#040D1A]/50">
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
                  <th className="px-6 py-4 font-medium cursor-pointer hover:text-white transition-colors group" onClick={() => requestSort('reasonCode')}>
                    Reason/Code <SortIcon columnKey="reasonCode" />
                  </th>
                  <th className="px-6 py-4 font-medium cursor-pointer hover:text-white transition-colors text-right group" onClick={() => requestSort('amount')}>
                    Amount <SortIcon columnKey="amount" />
                  </th>
                  <th className="px-6 py-4 font-medium cursor-pointer hover:text-white transition-colors group" onClick={() => requestSort('riskType')}>
                    Risk Type <SortIcon columnKey="riskType" />
                  </th>
                  <th className="px-6 py-4 font-medium cursor-pointer hover:text-white transition-colors text-center group" onClick={() => requestSort('severityScore')}>
                    Severity <SortIcon columnKey="severityScore" />
                  </th>
                  <th className="px-6 py-4 font-medium">Remarks</th>
                </tr>
              </thead>
              <motion.tbody variants={containerVariants} initial="hidden" animate="show" className="divide-y divide-white/5">
                {sortedAnomalies.map((anomaly, idx) => (
                  <motion.tr variants={itemVariants} key={idx} className="hover:bg-white/[0.04] transition-colors group">
                    <td className="px-6 py-3 text-slate-300 whitespace-nowrap">{anomaly.date} <span className="text-slate-500 ml-1">{anomaly.time}</span></td>
                    <td className="px-6 py-3 text-slate-200 font-medium">{anomaly.username}</td>
                    <td className="px-6 py-3 text-slate-300 font-mono">{anomaly.roomNumber}</td>
                    <td className="px-6 py-3 text-slate-300">{anomaly.reasonCode || anomaly.refundCode || '-'}</td>
                    <td className={`px-6 py-3 text-right font-mono whitespace-nowrap ${Number(anomaly.amount) < 0 ? 'text-[#FF6B6B]' : 'text-slate-300'}`}>
                      {money2(anomaly.amount)}
                    </td>
                    <td className="px-6 py-3 text-slate-300">{anomaly.riskType}</td>
                    <td className="px-6 py-3 text-center">
                       <span 
                        className="rounded-full px-3 py-1 text-[10px] uppercase tracking-widest font-bold" 
                        style={getBadgeStyle(anomaly.severity)}
                      >
                        {anomaly.severity}
                      </span>
                    </td>
                    <td className="px-6 py-3 text-slate-400 text-xs" title={anomaly.remarks}>
                      {truncate(anomaly.remarks, 30)}
                    </td>
                  </motion.tr>
                ))}
              </motion.tbody>
            </table>
          </div>
        )}
      </div>

      {/* 4. Drill-Down Modal */}
      <AnimatePresence>
        {selectedClerk && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
            <motion.div 
              initial={{ opacity: 0 }} 
              animate={{ opacity: 1 }} 
              exit={{ opacity: 0 }} 
              className="absolute inset-0 bg-black/60 backdrop-blur-md"
              onClick={() => setSelectedClerk(null)}
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.95, y: 20 }} 
              animate={{ opacity: 1, scale: 1, y: 0 }} 
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              transition={{ type: "spring", bounce: 0.15, duration: 0.5 }}
              className="relative bg-[#0F1F35]/95 backdrop-blur-xl border border-white/10 rounded-2xl max-w-5xl w-full max-h-[85vh] flex flex-col shadow-2xl ring-1 ring-white/5"
            >
              {/* Modal Header */}
              <div className="flex items-center justify-between px-8 py-6 border-b border-white/10 bg-gradient-to-r from-[#0A1628] to-transparent rounded-t-2xl">
                <div>
                  <h3 className="text-2xl font-semibold text-white">
                    Audit Trail: <span className="text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 to-blue-500">{selectedClerk.username}</span>
                  </h3>
                  <p className="text-sm text-slate-400 mt-1">Reviewing {selectedClerk.totalFlags} flagged items across adjustments and refunds.</p>
                </div>
                <button 
                  onClick={() => setSelectedClerk(null)}
                  className="p-2 rounded-full bg-white/5 text-slate-400 hover:text-white hover:bg-white/10 transition-all"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Modal Body */}
              <div className="p-8 overflow-y-auto space-y-10 custom-scrollbar">
                
                {/* Adjustments Section */}
                <section>
                  <div className="flex items-center gap-3 mb-4">
                    <div className="p-2 rounded-lg bg-purple-500/10 border border-purple-500/20">
                      <FileWarning className="w-5 h-5 text-purple-400" />
                    </div>
                    <h4 className="text-lg font-semibold text-white">
                      Adjustments
                    </h4>
                  </div>
                  <div className="bg-[#040D1A]/60 border border-white/10 rounded-xl overflow-x-auto shadow-inner">
                    <table className="w-full text-sm text-left">
                      <thead className="text-slate-400 text-[11px] uppercase tracking-widest border-b border-white/10 bg-white/[0.02]">
                        <tr>
                          <th className="px-5 py-3 font-medium">Date/Time</th>
                          <th className="px-5 py-3 font-medium">Room</th>
                          <th className="px-5 py-3 font-medium">Type</th>
                          <th className="px-5 py-3 font-medium">Reason</th>
                          <th className="px-5 py-3 font-medium text-right">Amount</th>
                          <th className="px-5 py-3 font-medium">Remarks</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/5">
                        {adjustments
                          .filter(a => a.username === selectedClerk.username)
                          .map((adj, i) => {
                            const isFlagged = flaggedAnomalies.some(f => f.transaction === adj || (f.username === adj.username && f.date === adj.date && f.time === adj.time && f.amount === adj.adjustedAmount));
                            return (
                              <tr key={i} className={`hover:bg-white/[0.03] transition-colors ${isFlagged ? 'bg-[#FF6B6B]/[0.02] border-l-[3px] border-l-[#FF6B6B]' : 'border-l-[3px] border-l-transparent'}`}>
                                <td className="px-5 py-3 text-slate-300 whitespace-nowrap font-mono text-xs">{adj.date} <span className="text-slate-500 ml-1">{adj.time}</span></td>
                                <td className="px-5 py-3 text-slate-200 font-mono">{adj.roomNumber}</td>
                                <td className="px-5 py-3 text-slate-400">{adj.transactionType}</td>
                                <td className="px-5 py-3 text-slate-300">{adj.reasonCode}</td>
                                <td className="px-5 py-3 text-right font-mono text-slate-200 whitespace-nowrap">{money2(adj.adjustedAmount)}</td>
                                <td className="px-5 py-3 text-slate-400 text-xs truncate max-w-xs">{adj.remarks}</td>
                              </tr>
                            );
                        })}
                        {adjustments.filter(a => a.username === selectedClerk.username).length === 0 && (
                          <tr>
                            <td colSpan="6" className="px-5 py-8 text-center text-slate-500 bg-white/[0.01]">No adjustments found for this clerk</td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </section>

                {/* Refunds Section */}
                <section>
                  <div className="flex items-center gap-3 mb-4">
                    <div className="p-2 rounded-lg bg-amber-500/10 border border-amber-500/20">
                      <DollarSign className="w-5 h-5 text-amber-400" />
                    </div>
                    <h4 className="text-lg font-semibold text-white">
                      Refunds
                    </h4>
                  </div>
                  <div className="bg-[#040D1A]/60 border border-white/10 rounded-xl overflow-x-auto shadow-inner">
                    <table className="w-full text-sm text-left">
                      <thead className="text-slate-400 text-[11px] uppercase tracking-widest border-b border-white/10 bg-white/[0.02]">
                        <tr>
                          <th className="px-5 py-3 font-medium">Date/Time</th>
                          <th className="px-5 py-3 font-medium">Room</th>
                          <th className="px-5 py-3 font-medium">Payment Type</th>
                          <th className="px-5 py-3 font-medium">Refund Code</th>
                          <th className="px-5 py-3 font-medium text-right">Amount</th>
                          <th className="px-5 py-3 font-medium">Remarks</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/5">
                        {refunds
                          .filter(r => r.username === selectedClerk.username)
                          .map((ref, i) => {
                            const isFlagged = flaggedAnomalies.some(f => f.transaction === ref || (f.username === ref.username && f.date === ref.date && f.time === ref.time && f.amount === ref.amount));
                            return (
                              <tr key={i} className={`hover:bg-white/[0.03] transition-colors ${isFlagged ? 'bg-[#FF6B6B]/[0.02] border-l-[3px] border-l-[#FF6B6B]' : 'border-l-[3px] border-l-transparent'}`}>
                                <td className="px-5 py-3 text-slate-300 whitespace-nowrap font-mono text-xs">{ref.date} <span className="text-slate-500 ml-1">{ref.time}</span></td>
                                <td className="px-5 py-3 text-slate-200 font-mono">{ref.roomNumber}</td>
                                <td className="px-5 py-3 text-slate-400">{ref.paymentTypeRefunded}</td>
                                <td className="px-5 py-3 text-slate-300">{ref.refundCode}</td>
                                <td className="px-5 py-3 text-right font-mono text-slate-200 whitespace-nowrap">{money2(ref.amount)}</td>
                                <td className="px-5 py-3 text-slate-400 text-xs truncate max-w-xs">{ref.remarks}</td>
                              </tr>
                            );
                        })}
                        {refunds.filter(r => r.username === selectedClerk.username).length === 0 && (
                          <tr>
                            <td colSpan="6" className="px-5 py-8 text-center text-slate-500 bg-white/[0.01]">No refunds found for this clerk</td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </section>

              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
