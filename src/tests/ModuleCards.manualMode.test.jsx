// R78: universal honest manual tile in ALL modes — no flag switch (root
// architecture decision; legacy provider auto-config UNPROVEN in every env).
// Real candidate render, public-seam mocks only; same manual-tile DOM,
// no 'final day'/'month-end' promise, links/other cards intact in all 3 envs.
// beforeAll warmup retained for cold-transform isolation (R75).
import React from 'react';
import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const useGlobalFiltersMock = vi.hoisted(() => vi.fn());
const payrollFilterMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/useGlobalFilters', () => ({ useGlobalFilters: useGlobalFiltersMock }));
vi.mock('@/lib/useHotelData', () => ({
  useOccupancy: () => ({ data: [], isLoading: false }),
  useGrossRevenue: () => ({ data: [], isLoading: false }),
}));
vi.mock('@/api/base44Client', () => ({
  db: {
    entities: { PayrollRun: { filter: payrollFilterMock } },
    functions: { invoke: vi.fn() },
  },
}));

let StrictCards;
let FalseCards;
let UndefCards;

async function loadCardsFor(envValue) {
  if (envValue === 'absent') vi.stubEnv('VITE_USE_SERVER_AUTH', undefined);
  else vi.stubEnv('VITE_USE_SERVER_AUTH', envValue);
  vi.resetModules();
  const mod = await import('@/components/dashboard/ModuleCards');
  return mod.default;
}

// Warmup: pay the cold-transform cost once, outside any timed test body.
beforeAll(async () => {
  StrictCards = await loadCardsFor('true');
  FalseCards = await loadCardsFor('false');
  UndefCards = await loadCardsFor('absent');
  vi.unstubAllEnvs();
  vi.resetModules();
}, 120000);

function setupMocks() {
  useGlobalFiltersMock.mockReturnValue({
    property: 'propA',
    properties: [{ id: 'propA', name: 'Test Hotel' }],
    dateRange: { from: '2026-09-01', to: '2026-09-30' },
    months: [],
  });
  payrollFilterMock.mockResolvedValue([]);
}

function renderCards(Cards) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Cards />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  setupMocks();
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

function payrollLink() {
  return screen.getByText('Payroll Module').closest('a');
}

function expectUniversalManualTile() {
  expect(screen.getByText('Use Payroll to generate approved runs for the selected property.')).toBeTruthy();
  expect(screen.queryByText(/final day of every month/i)).toBeNull();
  expect(screen.queryByText(/month-end/i)).toBeNull();
  expect(payrollLink().getAttribute('href')).toBe('/payroll');
  expect(screen.getByText('Open Payroll')).toBeTruthy();
  expect(screen.getByText('Room Sales')).toBeTruthy();
  expect(screen.getByText('Open Room Board')).toBeTruthy();
  expect(screen.getByText('Revenue')).toBeTruthy();
  expect(screen.getByText('Open Executive Hub')).toBeTruthy();
}

describe('ModuleCards payroll tile universal manual mode', () => {
  it("flag 'true': universal manual tile, links/other cards intact", async () => {
    renderCards(StrictCards);
    expect(await screen.findByText('Payroll Module')).toBeTruthy();
    expectUniversalManualTile();
  });

  it("flag 'false': same universal manual tile, links/other cards intact", async () => {
    renderCards(FalseCards);
    expect(await screen.findByText('Payroll Module')).toBeTruthy();
    expectUniversalManualTile();
  });

  it('flag undefined (absent): same universal manual tile, links/other cards intact', async () => {
    renderCards(UndefCards);
    expect(await screen.findByText('Payroll Module')).toBeTruthy();
    expectUniversalManualTile();
  });
});
