import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Dashboard from '@/pages/Dashboard';

const testState = vi.hoisted(() => ({
  occ: [],
  property: 'all',
  properties: [
    { id: 'prop-1', name: 'Hotel Alpha', rooms: 100 },
    { id: 'prop-2', name: 'Hotel Beta', rooms: 100 },
  ],
  dateRange: { from: '2026-01-01', to: '2026-01-02' },
}));

vi.mock('@/lib/useGlobalFilters', () => ({
  useGlobalFilters: () => ({
    dateRange: testState.dateRange,
    property: testState.property,
    properties: testState.properties,
    compareOn: false,
    compareDateRange: { from: '', to: '' },
    compareMonths: [],
    employee: 'all',
    paymentType: 'all',
    channel: 'all',
    months: [],
  }),
}));

vi.mock('@/lib/useHotelData', () => ({
  useOccupancy: () => ({ data: testState.occ, isLoading: false, isError: false }),
  useSources: () => ({ data: [], isLoading: false }),
  useClerkRecords: () => ({ data: [], isLoading: false }),
  useGrossRevenue: () => ({ data: [], isLoading: false }),
  usePaymentData: () => ({ data: [], isLoading: false }),
  useDailyFinancialAggregates: () => ({ data: null, isLoading: false }),
  filterByMonths: (rows) => rows,
}));

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useQuery: () => ({ data: [] }),
  };
});

vi.mock('@/api/base44Client', () => ({
  db: {
    entities: {
      AnomalyAlert: {
        filter: () => Promise.resolve([]),
      },
    },
  },
}));

vi.mock('@/hooks/usePullToRefresh', () => ({
  usePullToRefresh: () => ({ pullDist: 0, refreshing: false }),
}));

vi.mock('@/lib/realtime', () => ({
  useRealtimeInvalidation: () => {},
}));

vi.mock('@/lib/featureFlags', () => ({
  FEATURE_FLAGS: { LUXURY_UI_ENABLED: 'luxury_ui_enabled' },
  useFeatureFlag: () => false,
}));

vi.mock('canvas-confetti', () => ({
  default: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/useCountUp', () => ({
  useCountUp: (val) => val,
}));

// Mock subcomponents
vi.mock('@/components/dashboard/YieldAdvisor', () => ({ default: () => null }));
vi.mock('@/components/dashboard/RevenueTrend', () => ({ default: () => null }));
vi.mock('@/components/dashboard/PropertyRanking', () => ({ default: () => null }));
vi.mock('@/components/dashboard/LowOccAlert', () => ({ default: () => null }));
vi.mock('@/components/dashboard/ModuleCards', () => ({ default: () => null }));
vi.mock('@/components/dashboard/ClerkAudit', () => ({ default: () => null }));
vi.mock('@/components/dashboard/WeatherPanel', () => ({ default: () => null }));
vi.mock('@/components/dashboard/PricingPanel', () => ({ default: () => null }));
vi.mock('@/components/dashboard/SmartButtonGroup', () => ({ default: () => null }));
vi.mock('@/components/dashboard/OTAShiftSimulator', () => ({ default: () => null }));
vi.mock('@/components/dashboard/ScheduleReportDialog', () => ({ default: () => null }));
vi.mock('@/components/dashboard/OwnerPacketPreview', () => ({ default: () => null }));
vi.mock('@/components/lineage/KpiProvenanceDrawer', () => ({ default: () => null }));
vi.mock('@/components/dashboard/MoneyKept', () => ({ default: () => null }));

function getOccupancyCard() {
  const label = screen.getByText('Occupancy');
  return label.closest('div.fx-enter') || label.closest('div');
}

describe('Dashboard portfolio rooms/night calculation regression', () => {
  beforeEach(() => {
    testState.occ = [];
    testState.property = 'all';
    testState.dateRange = { from: '2026-01-01', to: '2026-01-02' };
  });

  afterEach(cleanup);

  it('two properties one date 40+35 rooms => 75 rooms/night (old 38 FAIL)', () => {
    testState.property = 'all';
    testState.dateRange = { from: '2026-01-01', to: '2026-01-01' };
    testState.occ = [
      { property_id: 'prop-1', date: '2026-01-01', rooms_sold: 40, room_revenue: 4000 },
      { property_id: 'prop-2', date: '2026-01-01', rooms_sold: 35, room_revenue: 3500 },
    ];

    render(<Dashboard />);
    const card = getOccupancyCard();
    expect(card?.textContent).toContain('Avg 75 rooms/night');
  });

  it('same property two dates 40+30 => 35 unchanged', () => {
    testState.property = 'prop-1';
    testState.dateRange = { from: '2026-01-01', to: '2026-01-02' };
    testState.occ = [
      { property_id: 'prop-1', date: '2026-01-01', rooms_sold: 40, room_revenue: 4000 },
      { property_id: 'prop-1', date: '2026-01-02', rooms_sold: 30, room_revenue: 3000 },
    ];

    render(<Dashboard />);
    const card = getOccupancyCard();
    expect(card?.textContent).toContain('Avg 35 rooms/night');
  });

  it('portfolio two dates with distinct totals correct', () => {
    testState.property = 'all';
    testState.dateRange = { from: '2026-01-01', to: '2026-01-02' };
    testState.occ = [
      { property_id: 'prop-1', date: '2026-01-01', rooms_sold: 40, room_revenue: 4000 },
      { property_id: 'prop-2', date: '2026-01-01', rooms_sold: 35, room_revenue: 3500 },
      { property_id: 'prop-1', date: '2026-01-02', rooms_sold: 50, room_revenue: 5000 },
      { property_id: 'prop-2', date: '2026-01-02', rooms_sold: 45, room_revenue: 4500 },
    ];

    render(<Dashboard />);
    const card = getOccupancyCard();
    // 75 + 95 = 170 rooms sold across 2 dates => 170 / 2 = 85 rooms/night
    expect(card?.textContent).toContain('Avg 85 rooms/night');
  });

  it('zero rows safe and unchanged', () => {
    testState.property = 'all';
    testState.dateRange = { from: '2026-01-01', to: '2026-01-02' };
    testState.occ = [];

    render(<Dashboard />);
    const card = getOccupancyCard();
    expect(card?.textContent).toContain('Avg 0 rooms/night');
  });
});
