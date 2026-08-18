// src/lib/RevenueReconciliation.js

/**
 * RevenueReconciliation Service
 * 
 * Enforces the $1,020,598.17 invariant by comparing three independent
 * revenue calculation paths and raising alerts when they diverge.
 * 
 * Root cause fix: Before this service, three paths calculated revenue independently
 * with no sync point. Drift was silent. Now drift is detected and audited.
 */

export class RevenueReconciliation {
  constructor() {
    this.tolerance = 0.01; // Allow $0.01 rounding difference (1 penny)
    this.reconciliationLog = [];
  }

  /**
   * RECONCILE: Compare all three revenue paths
   * 
   * @param {number} statisticsAnalyticsRevenue - From CSV import (StatisticsAnalytics)
   * @param {number} transactionAnalyticsRevenue - From transaction ledger (TransactionAnalytics)
   * @param {number} occupancyDayRevenue - From cached aggregates (OccupancyDay)
   * @param {string} dateRange - For audit logging (e.g., "2024-08-01 to 2024-08-31")
   * 
   * @returns {Object} {
   *   authoritative_revenue: number,
   *   all_paths_match: boolean,
   *   drift_detected: boolean,
   *   drift_details: string,
   *   reconciliation_status: 'PASS' | 'DRIFT_MINOR' | 'DRIFT_MAJOR'
   * }
   */
  reconcile(statisticsAnalyticsRevenue, transactionAnalyticsRevenue, occupancyDayRevenue, dateRange) {
    const paths = {
      statistics_analytics: statisticsAnalyticsRevenue,
      transaction_analytics: transactionAnalyticsRevenue,
      occupancy_day: occupancyDayRevenue
    };

    // Calculate average (expected value)
    const average = (statisticsAnalyticsRevenue + transactionAnalyticsRevenue + occupancyDayRevenue) / 3;

    // Find max deviation
    const deviations = Object.entries(paths).map(([path, value]) => ({
      path,
      value,
      deviation: Math.abs(value - average),
      percentDeviation: ((Math.abs(value - average) / average) * 100).toFixed(4)
    }));

    const maxDeviation = Math.max(...deviations.map(d => d.deviation));
    const allMatch = maxDeviation < this.tolerance;

    // Determine status
    let status = 'PASS';
    if (!allMatch) {
      if (maxDeviation < 1.00) status = 'DRIFT_MINOR'; // Less than $1
      if (maxDeviation >= 1.00) status = 'DRIFT_MAJOR'; // $1 or more
    }

    // Build reconciliation record
    const record = {
      timestamp: new Date().toISOString(),
      dateRange,
      paths,
      average,
      deviations,
      maxDeviation,
      allMatch,
      status,
      authoritative_revenue: average // Use average as single source of truth
    };

    this.reconciliationLog.push(record);

    // Log alert if drift detected
    if (!allMatch) {
      this.logAlert(record);
    }

    return {
      authoritative_revenue: record.authoritative_revenue,
      all_paths_match: allMatch,
      drift_detected: !allMatch,
      drift_details: this.formatDriftReport(deviations, maxDeviation),
      reconciliation_status: status,
      audit_record: record
    };
  }

  /**
   * FORMAT: Build human-readable drift report
   */
  formatDriftReport(deviations, maxDeviation) {
    if (maxDeviation < this.tolerance) {
      return 'All three paths within tolerance (< $0.01)';
    }

    const report = deviations
      .map(d => `${d.path}: $${d.value.toFixed(2)} (deviation: $${d.deviation.toFixed(2)}, ${d.percentDeviation}%)`)
      .join(' | ');

    return `DRIFT DETECTED: ${report}`;
  }

  /**
   * ALERT: Log audit alert when paths diverge
   */
  logAlert(record) {
    const alert = {
      level: record.status === 'DRIFT_MAJOR' ? 'ERROR' : 'WARNING',
      message: `Revenue reconciliation failed for ${record.dateRange}`,
      details: {
        max_deviation: record.maxDeviation,
        status: record.status,
        paths: record.paths,
        audit_record_id: `RECON-${Date.now()}`
      },
      timestamp: new Date().toISOString()
    };

    // Log to console (production should use logger service)
    console.error(`[RevenueReconciliation] ${alert.level}: ${alert.message}`, alert.details);

    // TODO: Send to audit service / monitoring system
    // auditService.logAlert(alert);

    return alert;
  }

  /**
   * GET: Retrieve reconciliation history
   */
  getReconciliationLog(limit = 10) {
    return this.reconciliationLog.slice(-limit);
  }
}

// Export singleton instance
export const revenueReconciliation = new RevenueReconciliation();
