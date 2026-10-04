import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import DataIntelligence from '@/pages/DataIntelligence';

const mockProperties = [
  { id: 'BOS', name: 'Boston Inn' },
  { id: 'HART', name: 'Hartford Hotel' },
];

vi.mock('@/lib/useGlobalFilters', () => ({
  useGlobalFilters: () => ({
    property: 'all',
    properties: mockProperties,
    dateRange: { from: '2026-09-01', to: '2026-09-03' },
    setDateRange: vi.fn(),
  }),
}));

vi.mock('@/api/base44Client', () => ({
  db: {
    entities: {
      UploadedReport: { list: vi.fn().mockResolvedValue([]) },
      OccupancyDay: {
        filter: vi.fn().mockResolvedValue([
          { property_id: 'BOS', date: '2026-09-01', room_revenue: 5000, rooms_sold: 50 },
          { property_id: 'BOS', date: '2026-09-02', room_revenue: 5200, rooms_sold: 52 },
          { property_id: 'BOS', date: '2026-09-03', room_revenue: 4800, rooms_sold: 48 },
          { property_id: 'HART', date: '2026-09-01', room_revenue: 3000, rooms_sold: 30 },
        ]),
      },
      SourceDay: {
        filter: vi.fn().mockResolvedValue([
          { property_id: 'BOS', date: '2026-09-01', net_revenue: 5000 },
          { property_id: 'BOS', date: '2026-09-02', net_revenue: 5200 },
          { property_id: 'BOS', date: '2026-09-03', net_revenue: 4800 },
          { property_id: 'HART', date: '2026-09-01', net_revenue: 3000 },
        ]),
      },
      GrossRevenueDay: { filter: vi.fn().mockResolvedValue([]) },
      PaymentDay: { filter: vi.fn().mockResolvedValue([]) },
      ClerkShiftRecord: { filter: vi.fn().mockResolvedValue([]) },
    },
  },
}));

function renderWithClient(ui) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe('Data Intelligence Owner Data Center', () => {
  it('renders all 4 tabs and portfolio completeness matrix', async () => {
    renderWithClient(<DataIntelligence />);

    expect(screen.getByText('Loading data health evidence')).toBeInTheDocument();
    expect(screen.queryByText('Owner Intelligence Center')).not.toBeInTheDocument();
    expect(await screen.findByText('Owner Intelligence Center')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Portfolio Completeness/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Financial Reconciliation/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Data Scanner & Cleaner/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Uploaded Reports/ })).toBeInTheDocument();

    // Verify property names in grid
    expect(screen.getByText('Boston Inn')).toBeInTheDocument();
    expect(screen.getByText('Hartford Hotel')).toBeInTheDocument();
  });

  it('switches to Financial Reconciliation tab and displays balance cards', async () => {
    renderWithClient(<DataIntelligence />);

    const reconTab = await screen.findByRole('button', { name: /Financial Reconciliation/ });
    fireEvent.click(reconTab);

    expect(screen.getAllByText('Reported PMS Revenue')[0]).toBeInTheDocument();
    expect(screen.getAllByText('Channel Ledger Revenue')[0]).toBeInTheDocument();
    expect(screen.getByText('Total Settled Payments')).toBeInTheDocument();
    expect(screen.getByText(/Multi-Property Financial Reconciliation/)).toBeInTheDocument();
  });

  it('opens and closes missing dates inspection modal', async () => {
    renderWithClient(<DataIntelligence />);

    const inspectButtons = await screen.findAllByText('Inspect Gaps');
    fireEvent.click(inspectButtons[0]);

    expect(screen.getByText(/Data Completeness Audit:/)).toBeInTheDocument();
    expect(screen.getByText('Recommended Action:')).toBeInTheDocument();

    const closeBtn = screen.getByText('Close Audit');
    fireEvent.click(closeBtn);

    expect(screen.queryByText('Recommended Action:')).not.toBeInTheDocument();
  });
});
