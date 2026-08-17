import { CalculationService } from '@/lib/calculationService';
import { getAlertThresholds } from '@/lib/alertThresholds';
import { sumCents, toCents, fromCents } from '@/lib/decimal';
import { refundOf } from '@/lib/paymentNorm';
import { filterCommittedPay } from '@/lib/payrollCalc';
import { money, inRange } from '@/lib/hotel';

export class OwnerIntelligenceService {
  // Detect demand trends - holiday/weekend performance
  static analyzeDemandPatterns(occRows = [], properties = []) {
    const stats = CalculationService.calculatePerPropertyStats(occRows, properties);
    const byProperty = {};
    
    stats.forEach(prop => {
      const propRows = occRows.filter(r => r.property_id === prop.property_id);
      const weekends = propRows.filter(r => {
        const d = new Date(r.date);
        return d.getDay() === 0 || d.getDay() === 6;
      });
      const weekdays = propRows.filter(r => {
        const d = new Date(r.date);
        return d.getDay() >= 1 && d.getDay() <= 5;
      });
      
      const weekendOcc = weekends.length ? weekends.reduce((a, r) => a + Number(r.occupancy || 0), 0) / weekends.length : 0;
      const weekdayOcc = weekdays.length ? weekdays.reduce((a, r) => a + Number(r.occupancy || 0), 0) / weekdays.length : 0;
      const weekendRev = weekends.reduce((a, r) => a + Number(r.room_revenue || 0), 0);
      const weekdayRev = weekdays.reduce((a, r) => a + Number(r.room_revenue || 0), 0);
      
      byProperty[prop.property_id] = {
        property_name: prop.property_name,
        weekendOccupancy: weekendOcc,
        weekdayOccupancy: weekdayOcc,
        weekendRevenue: weekendRev,
        weekdayRevenue: weekdayRev,
        weekendPremium: weekendOcc > weekdayOcc ? ((weekendOcc - weekdayOcc) / weekdayOcc * 100) : 0,
        revenueLift: weekendRev > 0 && weekdayRev > 0 ? ((weekendRev - weekdayRev) / weekdayRev * 100) : 0,
      };
    });
    
    return byProperty;
  }
  
  // Find high/low revenue dates
  static findRevenueOutliers(occRows, properties, topN = 5) {
    const sorted = [...occRows]
      .filter(r => Number(r.room_revenue || 0) > 0)
      .sort((a, b) => Number(b.room_revenue) - Number(a.room_revenue));
    
    return {
      highest: sorted.slice(0, topN).map(r => ({
        date: String(r.date).slice(0, 10),
        property_id: r.property_id,
        property_name: properties.find(p => p.id === r.property_id)?.name || 'Unknown',
        revenue: Number(r.room_revenue),
        occupancy: Number(r.occupancy || 0),
        adr: Number(r.adr || 0),
      })),
      lowest: sorted.slice(-topN).reverse().map(r => ({
        date: String(r.date).slice(0, 10),
        property_id: r.property_id,
        property_name: properties.find(p => p.id === r.property_id)?.name || 'Unknown',
        revenue: Number(r.room_revenue),
        occupancy: Number(r.occupancy || 0),
        adr: Number(r.adr || 0),
      })),
    };
  }
  
  // Detect unusual refund activity
  static detectRefundAnomalies(payRows, threshold = 3) {
    const refundsByDate = {};
    payRows.forEach(r => {
      const date = String(r.date).slice(0, 10);
      const refund = Math.abs(refundOf(r));
      if (refund > 0) {
        refundsByDate[date] = (refundsByDate[date] || 0) + refund;
      }
    });
    
    const dailyRefunds = Object.entries(refundsByDate).map(([date, amount]) => ({ date, amount }));
    const avgRefund = dailyRefunds.length ? dailyRefunds.reduce((a, r) => a + r.amount, 0) / dailyRefunds.length : 0;
    const stdDev = Math.sqrt(
      dailyRefunds.reduce((a, r) => a + Math.pow(r.amount - avgRefund, 2), 0) / (dailyRefunds.length || 1)
    );
    
    return dailyRefunds
      .filter(r => r.amount > avgRefund + threshold * stdDev)
      .sort((a, b) => b.amount - a.amount);
  }
  
  // Detect expense spikes
  static detectExpenseSpikes(expenses, properties, windowDays = 30) {
    const now = new Date();
    const cutoff = new Date(now.getTime() - windowDays * 86400000);
    
    const recentExpenses = expenses.filter(e => {
      const d = new Date(e.expense_date);
      return d >= cutoff;
    });
    
    const byProperty = {};
    recentExpenses.forEach(e => {
      const pid = e.property_id || '_default';
      if (!byProperty[pid]) byProperty[pid] = [];
      byProperty[pid].push(e);
    });
    
    const spikes = [];
    Object.entries(byProperty).forEach(([pid, exps]) => {
      const byCategory = {};
      exps.forEach(e => {
        if (!byCategory[e.category]) byCategory[e.category] = [];
        byCategory[e.category].push(e.amount || 0);
      });
      
      Object.entries(byCategory).forEach(([cat, amounts]) => {
        const avg = amounts.reduce((a, v) => a + v, 0) / amounts.length;
        const max = Math.max(...amounts);
        if (max > avg * 2.5 && amounts.length >= 3) {
          spikes.push({
            property_id: pid,
            property_name: properties.find(p => p.id === pid)?.name || 'Unknown',
            category: cat,
            averageAmount: avg,
            maxAmount: max,
            spikeRatio: max / avg,
            count: amounts.length,
          });
        }
      });
    });
    
    return spikes.sort((a, b) => b.spikeRatio - a.spikeRatio);
  }
  
  // OTA profitability analysis
  static analyzeOtaProfitability(srcRows = [], occRows = [], properties = []) {
    const channelMetrics = CalculationService.calculateChannelMetrics(srcRows);
    const occMetrics = CalculationService.calculateOccupancyMetrics(occRows, {});
    
    return channelMetrics.map(ch => ({
      ...ch,
      grossMargin: ch.gross > 0 ? (ch.net / ch.gross) * 100 : 0,
      revenueShare: occMetrics.revenue > 0 ? (ch.gross / occMetrics.revenue) * 100 : 0,
      profitabilityScore: ch.margin * 100,
      recommendation: ch.margin < 0.8 
        ? 'Consider negotiating lower commission or shifting to direct bookings'
        : ch.margin > 0.95 
          ? 'Excellent - maximize this channel'
          : 'Good - maintain current strategy',
    })).sort((a, b) => b.profitabilityScore - a.profitabilityScore);
  }
  
  // Upcoming high-demand dates
  static findUpcomingHighDemand(occRows = [], properties = [], daysAhead = 30) {
    // This would need future booking data; for now, use historical patterns
    const now = new Date();
    const upcoming = [];
    
    for (let i = 1; i <= daysAhead; i++) {
      const date = new Date(now.getTime() + i * 86400000);
      const dateStr = date.toISOString().slice(0, 10);
      const dayOfWeek = date.getDay();
      
      // Check historical same day-of-week
      const historicalSameDow = occRows.filter(r => {
        const d = new Date(r.date);
        return d.getDay() === dayOfWeek;
      });
      
      const avgOcc = historicalSameDow.length 
        ? historicalSameDow.reduce((a, r) => a + Number(r.occupancy || 0), 0) / historicalSameDow.length
        : 0;
      
      if (avgOcc > 0.8) {
        upcoming.push({
          date: dateStr,
          dayOfWeek: ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dayOfWeek],
          predictedOccupancy: avgOcc,
          historicalSamples: historicalSameDow.length,
        });
      }
    }
    
    return upcoming.sort((a, b) => b.predictedOccupancy - a.predictedOccupancy);
  }
  
  // Profit leakage detection
  //
  // `dateRange` scopes the cost side of the ratio below. Without it, payroll and
  // expenses were summed over ALL TIME while grossRevenue came from the
  // period-scoped occRows — and Dashboard.jsx fetches PayrollRun with no date
  // filter and a limit of 100000, so a narrow filter over a year of payroll on
  // file reported a ratio and a dollar figure that described no real period.
  // When no range is supplied the arrays are taken as already scoped by the
  // caller, since there is nothing to scope them by.
  static detectProfitLeakage(occRows = [], payRows = [], expenses = [], payroll = [], srcRows = [], properties = [], dateRange = { from: '', to: '' }) {
    const leaks = [];
    
    // 1. High OTA commission leakage
    const otaLeakage = CalculationService.calculateChannelMetrics(srcRows)
      .filter(c => c.margin < 0.8)
      .reduce((sum, c) => sum + c.commission, 0);
    if (otaLeakage > 0) {
      leaks.push({
        type: 'OTA Commission',
        amount: otaLeakage,
        severity: 'high',
        description: 'High commission rates on OTA bookings',
        recommendation: 'Negotiate rates or push direct bookings',
      });
    }
    
    // 2. Payment variance (collected vs expected)
    const paymentMetrics = CalculationService.calculatePaymentMetrics(payRows);
    const expectedRevenue = occRows.reduce((a, r) => a + Number(r.room_revenue || 0), 0);
    const variance = paymentMetrics.totalCollected - expectedRevenue;
    if (Math.abs(variance) > expectedRevenue * 0.05) {
      leaks.push({
        type: 'Payment Variance',
        amount: Math.abs(variance),
        severity: variance < 0 ? 'high' : 'medium',
        description: variance < 0 ? 'Under-collection detected' : 'Over-collection detected',
        recommendation: variance < 0 
          ? 'Investigate missing payments or refunds not captured'
          : 'Verify advance deposits and adjustments',
      });
    }
    
    // 3. Expense ratio too high
    const scoped = Boolean(dateRange?.from && dateRange?.to);
    const expensesInPeriod = scoped
      ? expenses.filter((e) => inRange(e.expense_date, dateRange.from, dateRange.to))
      : expenses;
    // Approved/paid only. payrollCalc.js states the contract: every consumer that
    // deducts payroll from revenue MUST filter through filterCommittedPay, or a
    // half-typed draft run silently moves this owner-facing profit figure. This is
    // the same rule Money Kept, Expenses, Forecasting and the Action Center apply,
    // so all five now describe the same month the same way.
    const committedPay = filterCommittedPay(payroll);
    const payrollInPeriod = scoped
      ? committedPay.filter((p) => inRange(p.pay_period_start, dateRange.from, dateRange.to))
      : committedPay;

    // Integer cents: `amount` is rendered to the owner as money (Dashboard.jsx
    // "Profit Leakage"), so the addition must not drift.
    const totalCostCents = sumCents(expensesInPeriod.map((e) => e.amount))
      + sumCents(payrollInPeriod.map((p) => p.total_pay));
    const grossCents = sumCents(occRows.map((r) => r.room_revenue));
    const expenseRatio = grossCents > 0 ? totalCostCents / grossCents : 0;

    if (expenseRatio > 0.65) {
      const targetCents = Math.round(grossCents * 0.65);
      leaks.push({
        type: 'High Expense Ratio',
        amount: fromCents(totalCostCents - targetCents),
        severity: 'medium',
        description: `Total costs are ${(expenseRatio * 100).toFixed(1)}% of revenue (target: <65%)`,
        recommendation: 'Review operating expenses and payroll efficiency',
      });
    }
    
    return leaks;
  }
  
  // Comprehensive executive summary
  static generateExecutiveInsights(occRows = [], payRows = [], expenses = [], payroll = [], srcRows = [], grossRows = [], properties = [], dateRange = { from: '', to: '' }) {
    const insights = [];
    
    // Revenue trend
    const dailyRevenue = occRows.reduce((a, r) => a + Number(r.room_revenue || 0), 0);
    const dailyRooms = occRows.reduce((a, r) => a + Number(r.rooms_sold || 0), 0);
    const avgOcc = occRows.length ? occRows.reduce((a, r) => a + Number(r.occupancy || 0), 0) / occRows.length : 0;
    
    insights.push({
      category: 'Revenue',
      title: 'Period Performance',
      metric: money(dailyRevenue),
      detail: `${occRows.length} days | ${dailyRooms} rooms sold | ${(avgOcc * 100).toFixed(1)}% avg occupancy`,
    });
    
    // Top performing property
    const propStats = CalculationService.calculatePerPropertyStats(occRows, properties);
    if (propStats.length > 1) {
      const best = propStats[0];
      const worst = propStats[propStats.length - 1];
      insights.push({
        category: 'Portfolio',
        title: 'Best / Needs Attention',
        metric: best.property_name,
        detail: `Top: ${money(best.revenue)} (${(best.occupancy * 100).toFixed(1)}%) | Bottom: ${worst.property_name} - ${money(worst.revenue)} (${(worst.occupancy * 100).toFixed(1)}%)`,
      });
    }
    
    // OTA insight
    const otaAnalysis = this.analyzeOtaProfitability(srcRows, occRows, properties);
    if (otaAnalysis.length) {
      const worstOta = otaAnalysis[otaAnalysis.length - 1];
      insights.push({
        category: 'Channels',
        title: 'OTA Margin Opportunity',
        metric: worstOta.source,
        detail: `${(worstOta.margin * 100).toFixed(1)}% margin | ${money(worstOta.commission)} commission | ${worstOta.recommendation}`,
      });
    }
    
    // Expense spikes
    const spikes = this.detectExpenseSpikes(expenses, properties);
    if (spikes.length) {
      const top = spikes[0];
      insights.push({
        category: 'Expenses',
        title: 'Expense Spike Detected',
        metric: `${top.category} at ${top.property_name}`,
        detail: `${(top.spikeRatio * 100).toFixed(0)}% above average (${money(top.maxAmount)} vs ${money(top.averageAmount)})`,
      });
    }
    
    // Refund anomalies
    const refunds = this.detectRefundAnomalies(payRows);
    if (refunds.length) {
      insights.push({
        category: 'Risk',
        title: 'Unusual Refund Activity',
        metric: `${refunds.length} anomalous day(s)`,
        detail: `Highest: ${money(refunds[0].amount)} on ${refunds[0].date}`,
      });
    }
    
    // Profit leakage
    const leaks = this.detectProfitLeakage(occRows, payRows, expenses, payroll, srcRows, properties, dateRange);
    if (leaks.length) {
      const totalLeakage = leaks.reduce((a, l) => a + l.amount, 0);
      insights.push({
        category: 'Profit',
        title: 'Profit Leakage',
        metric: money(totalLeakage),
        detail: `${leaks.length} leak(s) detected | Top: ${leaks[0].type}`,
      });
    }
    
    return insights;
  }
}

export const ownerIntelligence = new OwnerIntelligenceService();
export default OwnerIntelligenceService;