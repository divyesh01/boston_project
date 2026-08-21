// src/lib/RevenueReconciliation.js

/**
 * RevenueReconciliation Service
 *
 * Compares the app's independent revenue derivations and reports whether they
 * agree, so that drift between them is visible instead of silent.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * REWRITTEN 2026-08-19. Read this before changing anything below.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The original version of this file did two things that produced confidently
 * wrong numbers. Both are fixed here, and both fixes are load-bearing:
 *
 * 1. IT AVERAGED THE THREE PATHS AND CALLED THE MEAN "AUTHORITATIVE".
 *
 *      authoritative_revenue: (statistics + transactions + occupancy) / 3
 *
 *    That is not reconciliation, it is blending. Three revenue ledgers are not
 *    three noisy measurements of one quantity — they are three documents, each
 *    of which either agrees or does not. The mean of them:
 *
 *      - matches no auditable document, so an owner cannot tie the figure to
 *        anything. Asked "where does this number come from?", the only honest
 *        answer was "nowhere".
 *      - DEGRADES GRACEFULLY IN THE WRONG DIRECTION. One broken path returning
 *        $0 does not raise an error; it drags the headline down by a third and
 *        keeps going. That is exactly what happened: financialReconciliation.js
 *        passed a lowercase 'revenue' section name, the statistics leg silently
 *        evaluated to $0.00, and the mean of (0, 1020598.17, 1011258.67) is
 *        $677,285.61 — a 34% understatement of revenue, reported as fact.
 *
 *    Replaced by explicit PRECEDENCE (see PATH_PRECEDENCE). The authoritative
 *    figure is always one real path's figure, and the result names which path
 *    it came from, so the number is traceable to a document. Missing paths are
 *    reported as missing rather than averaged in as zero.
 *
 * 2. IT COMPARED ROOM REVENUE AGAINST TOTAL REVENUE.
 *
 *    The occupancy path sums OccupancyDay.room_revenue, which is ROOM ONLY. The
 *    statistics and transaction paths carry room revenue PLUS ancillary lines
 *    (pet fee, laundry, restaurant, property damage, smoking, early check-in...).
 *    Comparing them directly reports the ancillary total as "drift" forever.
 *
 *    Measured on the real Middleborough export:
 *
 *      Taxable Room Revenue      $637,805.60
 *      Exempt Room Revenue       $373,453.07
 *      ── room subtotal          $1,011,258.67  === sum(OccupancyDay.room_revenue)
 *      + 10 ancillary lines      $    9,339.50
 *      ── section total          $1,020,598.17  === transaction ledger
 *
 *    The room subtotal ties to the occupancy path TO THE CENT, and the section
 *    total ties to the transaction ledger TO THE CENT. Nothing was ever broken
 *    about the data. The old "all three paths must equal $1,020,598.17"
 *    invariant was MIS-SPECIFIED: it demanded that a room-only figure equal a
 *    total-revenue figure, which is arithmetically impossible whenever the hotel
 *    sells so much as one pet fee.
 *
 *    So `reconcile` now takes the statistics ROOM subtotal via
 *    `options.statisticsRoomRevenue` and compares the occupancy path against
 *    THAT — like with like. Callers that omit it get the legacy three-way
 *    total comparison, and the result says `occupancy_scope: 'total'` so the
 *    ambiguity is visible in the record rather than assumed.
 *
 * All arithmetic is integer cents (src/lib/decimal.js). A reconciler whose own
 * comparisons drift by fractions of a cent cannot detect drift of a cent.
 */

import { toCents, fromCents, formatCents } from './decimal';

/**
 * Which derivation wins when they disagree, most authoritative first.
 *
 * `statistics_analytics` leads because it is the PMS night-audit export itself —
 * the document an owner would hand an accountant. `transaction_analytics` is the
 * same underlying money but re-summed by us from the transaction ledger, so it
 * inherits our own parsing assumptions. `occupancy_day` is last and is ROOM-ONLY,
 * so it can never be authoritative for total revenue; it is a cross-check.
 */
export const PATH_PRECEDENCE = Object.freeze([
  'statistics_analytics',
  'transaction_analytics',
  'occupancy_day',
]);

/** Paths that measure room revenue only, and so cannot stand in for a total. */
export const ROOM_SCOPE_PATHS = Object.freeze(['occupancy_day']);

export const RECON_STATUS = Object.freeze({
  PASS: 'PASS',
  DRIFT_MINOR: 'DRIFT_MINOR',
  DRIFT_MAJOR: 'DRIFT_MAJOR',
  NO_DATA: 'NO_DATA',
});

// A path is PRESENT only if it is a finite number. null/undefined/NaN mean "this
// derivation could not be computed", which is a different statement from "$0.00"
// and must never be silently folded into the comparison as a zero.
const isPresent = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));

export class RevenueReconciliation {
  constructor() {
    this.tolerance = 0.01; // $0.01 — one penny of rounding
    this.reconciliationLog = [];
  }

  /**
   * RECONCILE: compare the revenue derivations and pick a traceable figure.
   *
   * @param {number|null} statisticsAnalyticsRevenue - Statistics export, Revenue section TOTAL
   * @param {number|null} transactionAnalyticsRevenue - Transaction ledger (CHARGE rows)
   * @param {number|null} occupancyDayRevenue - sum(OccupancyDay.room_revenue) — ROOM ONLY
   * @param {string} dateRange - for the audit record, e.g. "2026-01-01 to 2026-08-19"
   * @param {Object} [options]
   * @param {number|null} [options.statisticsRoomRevenue] - Revenue section ROOM subtotal.
   *        Supply this (from statisticsAnalytics.revenueSplit().room) and the occupancy
   *        path is compared against it instead of against the totals. Strongly preferred:
   *        without it the ancillary total is reported as drift.
   *
   * @returns {{
   *   authoritative_revenue: number,
   *   authoritative_path: string|null,
   *   all_paths_match: boolean,
   *   drift_detected: boolean,
   *   drift_details: string,
   *   reconciliation_status: string,
   *   missing_paths: string[],
   *   suspect_zero_paths: string[],
   *   occupancy_scope: 'room'|'total',
   *   audit_record: Object
   * }}
   */
  reconcile(
    statisticsAnalyticsRevenue,
    transactionAnalyticsRevenue,
    occupancyDayRevenue,
    dateRange,
    options = {}
  ) {
    const { statisticsRoomRevenue = null } = options;
    const roomBaselineGiven = isPresent(statisticsRoomRevenue);

    const paths = {
      statistics_analytics: statisticsAnalyticsRevenue,
      transaction_analytics: transactionAnalyticsRevenue,
      occupancy_day: occupancyDayRevenue,
    };

    const missingPaths = Object.keys(paths).filter((k) => !isPresent(paths[k]));
    const presentPaths = PATH_PRECEDENCE.filter((k) => isPresent(paths[k]));

    // ── Authoritative figure: the highest-precedence path that actually exists.
    //
    // Never a blend. If the statistics export is loaded, its total IS revenue;
    // if it is absent, we say so and fall through to the transaction ledger,
    // recording which document the number came from either way. A room-scope
    // path is skipped when a total is what was asked for, because room revenue
    // is a smaller quantity and substituting it would understate revenue
    // silently — the precise failure this rewrite exists to remove.
    const totalScopePaths = presentPaths.filter((p) => !ROOM_SCOPE_PATHS.includes(p));
    const authoritativePath = totalScopePaths[0] ?? null;
    const authoritativeCents = authoritativePath ? toCents(paths[authoritativePath]) : 0;

    // ── Comparison: like with like.
    //
    // Each present path is measured against the baseline appropriate to ITS
    // scope. Total-scope paths are compared against the authoritative total;
    // the room-scope path is compared against the statistics room subtotal when
    // the caller supplied one.
    const baselineFor = (path) =>
      ROOM_SCOPE_PATHS.includes(path) && roomBaselineGiven
        ? toCents(statisticsRoomRevenue)
        : authoritativeCents;

    const toleranceCents = toCents(this.tolerance);
    const deviations = presentPaths.map((path) => {
      const valueCents = toCents(paths[path]);
      const baseCents = baselineFor(path);
      const deviationCents = Math.abs(valueCents - baseCents);
      return {
        path,
        value: fromCents(valueCents),
        scope: ROOM_SCOPE_PATHS.includes(path) ? 'room' : 'total',
        comparedAgainst: fromCents(baseCents),
        deviation: fromCents(deviationCents),
        deviationCents,
        // Guard the divide: a legitimately zero baseline must not yield NaN% or
        // Infinity% in an owner-facing drift report.
        percentDeviation: baseCents === 0 ? null : ((deviationCents / baseCents) * 100).toFixed(4),
      };
    });

    const maxDeviationCents = deviations.length
      ? Math.max(...deviations.map((d) => d.deviationCents))
      : 0;

    // ── Status.
    //
    // "No paths at all" is NOT a pass. The old code would have reported PASS for
    // an empty dataset, because zero deviations trivially satisfy the tolerance —
    // a green light on no evidence. NO_DATA says what is actually known.
    let status;
    if (presentPaths.length === 0) {
      status = RECON_STATUS.NO_DATA;
    } else if (maxDeviationCents <= toleranceCents) {
      status = RECON_STATUS.PASS;
    } else if (maxDeviationCents < toCents(1.0)) {
      status = RECON_STATUS.DRIFT_MINOR;
    } else {
      status = RECON_STATUS.DRIFT_MAJOR;
    }

    const allMatch = status === RECON_STATUS.PASS;

    // A path reading exactly $0.00 while another reads real money is the
    // signature of a broken derivation (wrong section name, wrong field name,
    // empty query) rather than a hotel that earned nothing. Name it explicitly:
    // it is the difference between "revenue was zero" and "we failed to read
    // revenue", and the old averaging behaviour erased that distinction.
    const suspectZeroPaths = presentPaths.filter(
      (p) => toCents(paths[p]) === 0 && presentPaths.some((q) => toCents(paths[q]) !== 0)
    );

    // Annotated rather than left to inference: a ternary of two string literals
    // widens to `string`, which does not satisfy the 'room'|'total' union this
    // function documents and returns.
    /** @type {'room'|'total'} */
    const occupancyScope = roomBaselineGiven ? 'room' : 'total';

    const record = {
      timestamp: new Date().toISOString(),
      dateRange,
      paths,
      presentPaths,
      missingPaths,
      suspectZeroPaths,
      occupancyScope,
      statisticsRoomRevenue: roomBaselineGiven ? Number(statisticsRoomRevenue) : null,
      deviations,
      maxDeviation: fromCents(maxDeviationCents),
      allMatch,
      status,
      authoritativePath,
      authoritative_revenue: fromCents(authoritativeCents),
    };

    this.reconciliationLog.push(record);

    if (!allMatch) this.logAlert(record);

    return {
      authoritative_revenue: record.authoritative_revenue,
      authoritative_path: authoritativePath,
      all_paths_match: allMatch,
      drift_detected: !allMatch,
      drift_details: this.formatDriftReport(record),
      reconciliation_status: status,
      missing_paths: missingPaths,
      suspect_zero_paths: suspectZeroPaths,
      occupancy_scope: record.occupancyScope,
      audit_record: record,
    };
  }

  /**
   * FORMAT: human-readable drift report.
   *
   * Written for an owner reading it in the UI, not for a developer reading a log:
   * it says which document disagrees with which, by how much, and — when the
   * comparison is scope-mismatched — that the "drift" may be ancillary revenue
   * rather than an error.
   */
  formatDriftReport(record) {
    const notes = [];
    if (record.missingPaths.length) {
      notes.push(`NOT AVAILABLE: ${record.missingPaths.join(', ')} (excluded from the comparison, not counted as $0)`);
    }
    if (record.suspectZeroPaths.length) {
      notes.push(`READS EXACTLY $0.00 while other paths show revenue: ${record.suspectZeroPaths.join(', ')} — likely a broken derivation, not zero revenue`);
    }
    if (record.status === RECON_STATUS.NO_DATA) {
      return ['No revenue derivation could be computed for this period.', ...notes].join(' | ');
    }
    if (record.allMatch) {
      const base = `All ${record.presentPaths.length} available path(s) agree within $0.01 (authoritative: ${record.authoritativePath})`;
      return [base, ...notes].join(' | ');
    }
    if (record.occupancyScope === 'total' && record.deviations.some((d) => d.scope === 'room')) {
      notes.push('NOTE: the occupancy path is ROOM revenue only and was compared against a TOTAL. Part of this difference is ancillary revenue (pet fee, laundry, restaurant), not error. Pass options.statisticsRoomRevenue for a like-for-like comparison.');
    }
    const report = record.deviations
      .map((d) => {
        const pct = d.percentDeviation === null ? 'n/a' : `${d.percentDeviation}%`;
        return `${d.path} [${d.scope}]: ${formatCents(toCents(d.value))} vs ${formatCents(toCents(d.comparedAgainst))} (off by ${formatCents(toCents(d.deviation))}, ${pct})`;
      })
      .join(' | ');
    return [`DRIFT DETECTED: ${report}`, ...notes].join(' | ');
  }

  /**
   * ALERT: build (and surface) an alert when paths diverge.
   *
   * console.warn/error rather than console.log — the production build strips
   * console.log, which would make this alert vanish exactly where it matters.
   */
  logAlert(record) {
    const alert = {
      level: record.status === RECON_STATUS.DRIFT_MAJOR ? 'ERROR' : 'WARNING',
      message: `Revenue reconciliation ${record.status} for ${record.dateRange}`,
      details: {
        max_deviation: record.maxDeviation,
        status: record.status,
        paths: record.paths,
        missing_paths: record.missingPaths,
        suspect_zero_paths: record.suspectZeroPaths,
        authoritative_path: record.authoritativePath,
        occupancy_scope: record.occupancyScope,
        audit_record_id: `RECON-${Date.now()}`,
      },
      timestamp: new Date().toISOString(),
    };

    if (alert.level === 'ERROR') {
      console.error(`[RevenueReconciliation] ${alert.level}: ${alert.message}`, alert.details);
    } else {
      console.warn(`[RevenueReconciliation] ${alert.level}: ${alert.message}`, alert.details);
    }

    return alert;
  }

  /**
   * GET: reconciliation history
   */
  getReconciliationLog(limit = 10) {
    return this.reconciliationLog.slice(-limit);
  }
}

// Export singleton instance
export const revenueReconciliation = new RevenueReconciliation();
