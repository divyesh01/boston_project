import React, { useEffect, useState } from 'react';
import { useLatestDate } from '@/lib/useHotelData';
import { localTodayIso } from '@/lib/hotel';
import { costCoverage, reportFreshness } from '@/lib/ownerTrust';

const noticeClass = 'rounded-xl border border-amber-400/30 bg-amber-400/10 p-4 text-sm leading-relaxed text-amber-100';

export function ReportFreshnessNotice({ property }) {
  const query = useLatestDate(property);
  const [today, setToday] = useState(localTodayIso);
  useEffect(() => {
    const refresh = () => setToday(localTodayIso());
    const interval = window.setInterval(refresh, 60000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);
  const latest = query.data || '';
  const { state, ageDays } = reportFreshness(latest, today);
  let text;
  if (query.isError) text = 'Could not check report freshness. Retry before making current-day decisions.';
  else if (query.isLoading) text = 'Checking newest occupancy report for this selection…';
  else if (state === 'empty') text = 'No occupancy report found for this selection. Import a report to begin.';
  else if (state === 'invalid') text = 'The newest occupancy report has an invalid date. Check the imported dates.';
  else if (state === 'future') text = `Newest occupancy report: ${latest} — this is in the future. Check the report date and device clock.`;
  else text = `Newest occupancy report: ${latest} · ${ageDays === 0 ? 'today' : `${ageDays} day${ageDays === 1 ? '' : 's'} old`}.${state === 'stale' ? ' Import newer reports before using this history for today’s decisions.' : ''}`;
  return (
    <div className={`${noticeClass} mt-3`} role="status" aria-live="polite" aria-atomic="true">
      <p>{text}</p>
      {!query.isLoading && !query.isError && latest && <p className="mt-1 text-xs">This is the newest occupancy date only—not proof that every report, day, or selected property is complete. Historical analysis remains available.</p>}
      {query.isError && <button type="button" onClick={() => query.refetch()} className="mt-2 min-h-9 rounded border border-amber-300/50 px-3 underline focus-visible:outline focus-visible:outline-2">Retry freshness check</button>}
    </div>
  );
}

export function CostCoverageNotice({ expenses, payroll, dateRange, loading = false, failed = false }) {
  const coverage = costCoverage(expenses, payroll, dateRange);
  let text = 'Only recorded costs are included. Having some entries does not prove all costs or all selected properties are covered.';
  if (failed) text = 'Costs could not be verified because a read failed. Do not treat displayed profit as complete.';
  else if (loading) text = 'Loading cost records. Profit is not verified yet.';
  else if (coverage.state === 'unknown') text = 'Select a valid date range to check cost records. Profit is not verified yet.';
  else if (coverage.missing.length) text = `Missing cost records for this period: ${coverage.missing.join(' and ')}. Missing does not mean $0; displayed profit may be overstated.`;
  return <div className={noticeClass} role="status" aria-live="polite" aria-atomic="true"><p className="font-semibold">Cost coverage is not confirmed</p><p>{text}</p><p className="mt-1 text-xs">Review Expenses and Payroll for the selected period before treating these figures as profit.</p></div>;
}

export function PricingScenarioNotice({ startDate = '' }) {
  return <div className={noticeClass}><p className="font-semibold">Local what-if scenario — not live market rates</p><p>{startDate ? `Scenario starts ${startDate}. ` : ''}Uses local records and configured assumptions. Competitor prices are manually configured; reservations and weather are not verified live feeds. No rates are automatically changed or sent to OTAs.</p></div>;
}
