import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CostCoverageNotice, ReportFreshnessNotice } from '@/components/OwnerTrustNotices';

const mocks = vi.hoisted(() => ({ latest: vi.fn(), retry: vi.fn(), today: '2026-08-28' }));
vi.mock('@/lib/useHotelData', () => ({ useLatestDate: mocks.latest }));
vi.mock('@/lib/hotel', () => ({ localTodayIso: () => mocks.today }));
beforeEach(() => {
  mocks.today = '2026-08-28';
  mocks.latest.mockReturnValue({ data: '2026-08-02', isLoading: false, isError: false, refetch: mocks.retry });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });

describe('freshness notice', () => {
  it('uses selected property, warns about stale reports, never claims full coverage', () => {
    render(<ReportFreshnessNotice property="p1" />);
    expect(mocks.latest).toHaveBeenCalledWith('p1');
    expect(screen.getByRole('status')).toHaveTextContent('26 days old');
    expect(screen.getByRole('status')).toHaveTextContent('not proof that every report');
  });
  it('refreshes with the property selection, including portfolio arrays', () => {
    const { rerender } = render(<ReportFreshnessNotice property="p1" />);
    mocks.latest.mockReturnValue({ data: '2026-08-27' });
    rerender(<ReportFreshnessNotice property={['p2', 'p3']} />);
    expect(mocks.latest).toHaveBeenLastCalledWith(['p2', 'p3']);
    expect(screen.getByRole('status')).toHaveTextContent('1 day old');
    expect(screen.getByRole('status')).not.toHaveTextContent('26 days old');
  });
  it('does not show an empty database while a read is pending', () => {
    mocks.latest.mockReturnValue({ isLoading: true });
    render(<ReportFreshnessNotice property="p1" />);
    expect(screen.getByRole('status')).toHaveTextContent('Checking newest occupancy');
    expect(screen.getByRole('status')).not.toHaveTextContent('No occupancy report');
  });
  it('offers retry and does not present cached dates as verified after error', () => {
    mocks.latest.mockReturnValue({ data: '2026-08-28', isError: true, refetch: mocks.retry });
    render(<ReportFreshnessNotice property="p1" />);
    expect(screen.getByRole('status')).toHaveTextContent('Could not check');
    expect(screen.getByRole('status')).not.toHaveTextContent('Newest occupancy report:');
    fireEvent.click(screen.getByRole('button', { name: /Retry freshness/ }));
    expect(mocks.retry).toHaveBeenCalledOnce();
  });
  it('distinguishes a successful empty read', () => {
    mocks.latest.mockReturnValue({ data: '' });
    render(<ReportFreshnessNotice property="p1" />);
    expect(screen.getByRole('status')).toHaveTextContent('No occupancy report found');
  });
  it('updates across midnight and on return to the tab, then removes timers', () => {
    vi.useFakeTimers();
    const { unmount } = render(<ReportFreshnessNotice property="p1" />);
    mocks.today = '2026-08-29';
    act(() => { vi.advanceTimersByTime(60000); });
    expect(screen.getByRole('status')).toHaveTextContent('27 days old');
    mocks.today = '2026-08-30';
    fireEvent.focus(window);
    expect(screen.getByRole('status')).toHaveTextContent('28 days old');
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('cost notice', () => {
  const props = { expenses: [], payroll: [], dateRange: { from: '2026-08-01', to: '2026-08-31' } };
  it('does not report missing costs while loading', () => {
    render(<CostCoverageNotice {...props} loading />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading cost records');
    expect(screen.getByRole('status')).not.toHaveTextContent('Missing cost records');
  });
  it('distinguishes a failed read from an empty one', () => {
    render(<CostCoverageNotice {...props} failed />);
    expect(screen.getByRole('status')).toHaveTextContent('read failed');
    expect(screen.getByRole('status')).not.toHaveTextContent('Missing cost records');
  });
  it('warns that missing costs are not zero', () => {
    render(<CostCoverageNotice {...props} />);
    expect(screen.getByRole('status')).toHaveTextContent('Missing does not mean $0');
  });
});
