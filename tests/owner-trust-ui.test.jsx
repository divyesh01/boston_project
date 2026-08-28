import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ChannelManager from '@/pages/ChannelManager';
import Pricing from '@/pages/Pricing';

const mocks = vi.hoisted(() => ({ push: vi.fn(), connect: vi.fn(), create: vi.fn(), loading: false, failed: false }));
vi.mock('@/api/base44Client', () => ({ db: {
  integrations: { ChannelManager: { PushInventory: mocks.push, Connect: mocks.connect } },
  entities: { Reservation: { create: mocks.create } },
} }));
vi.mock('@/lib/useGlobalFilters', () => ({ useGlobalFilters: () => ({ property: 'p1', properties: [{ id: 'p1', name: 'Test Hotel' }] }) }));
vi.mock('@/lib/useHotelData', () => ({ useRooms: () => ({ data: [], isError: false, refetch: vi.fn() }) }));
vi.mock('@/lib/realtime', () => ({ useRealtimeInvalidation: vi.fn() }));
vi.mock('@/lib/pricingOverride', () => ({ applyDynamicRateOverride: vi.fn() }));
vi.mock('@/lib/usePricing', () => ({ usePricingForecast: () => ({
  enabled: true, isLoading: mocks.loading, isError: mocks.failed, refetch: vi.fn(),
  forecast: Array.from({ length: 14 }, (_, i) => ({
    date: `2026-08-${String(i + 2).padStart(2, '0')}`, occupancy: 0.6,
    types: { Standard: { baseCents: 10000, recommendedCents: 11000 } },
    projectedRevenueCents: 110000, projectedBaseRevenueCents: 100000,
  })),
}) }));

afterEach(() => { cleanup(); vi.clearAllMocks(); mocks.loading = false; mocks.failed = false; });
const show = (page) => render(<MemoryRouter>{page}</MemoryRouter>);

describe('standalone integration safety', () => {
  it('cannot connect or sync simulated reservations from Channel Manager', () => {
    show(<ChannelManager />);
    expect(screen.getByText(/OTA connections are unavailable/i)).toBeInTheDocument();
    for (const button of screen.queryAllByRole('button')) {
      expect(button).toBeDisabled();
      fireEvent.click(button);
    }
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('labels pricing as a dated local scenario and never publishes rates', () => {
    show(<Pricing />);
    expect(screen.getByText(/Local what-if scenario/i)).toBeInTheDocument();
    expect(screen.getAllByText(/2026-08-02/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Tonight.s Recommended Rate/i)).not.toBeInTheDocument();
    const publish = screen.getByRole('button', { name: /OTA publishing unavailable/i });
    expect(publish).toBeDisabled();
    fireEvent.click(publish);
    expect(mocks.push).not.toHaveBeenCalled();
  });
  it('does not label a 14-day sum as a 30-day or 90-day forecast', () => {
    show(<Pricing />);
    for (const label of ['30-day', '90-day']) {
      expect(screen.getByText(label).parentElement).toHaveTextContent('Not calculated');
    }
    expect(screen.getByText('14-day').parentElement).toHaveTextContent('$15,400.00');
  });
  it('hides default scenario values until reads finish', () => {
    mocks.loading = true;
    show(<Pricing />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading local scenario inputs');
    expect(screen.queryByText('14-day')).not.toBeInTheDocument();
  });
  it('does not present usable rate cards after a read failure', () => {
    mocks.failed = true;
    show(<Pricing />);
    expect(screen.getByText('Could not load the demand signals')).toBeInTheDocument();
    expect(screen.queryByText('14-day')).not.toBeInTheDocument();
  });
});
