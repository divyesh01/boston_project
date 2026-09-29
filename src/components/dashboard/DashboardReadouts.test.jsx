import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import ModuleCards from './ModuleCards';
import MoneyKept from './MoneyKept';
import PropertyRanking from './PropertyRanking';

const data = vi.hoisted(() => ({ occ: [], gross: [], payroll: [] }));
vi.mock('@/api/base44Client', () => ({ db: { entities: {} } }));
vi.mock('@tanstack/react-query', () => ({ useQuery: () => ({ data: data.payroll }) }));
vi.mock('@/lib/useHotelData', () => ({
  useOccupancy: () => ({ data: data.occ, isLoading: false }),
  useGrossRevenue: () => ({ data: data.gross, isLoading: false }),
  usePaymentData: () => ({ data: [] }),
}));
vi.mock('@/lib/useGlobalFilters', () => ({ useGlobalFilters: () => ({
  dateRange: { from: '2026-01-01', to: '2026-09-25' }, property: 'P_A', months: [],
}) }));
vi.mock('@/hooks/useSettingsVersion', () => ({ useSettingsVersion: () => 0 }));
vi.mock('@/lib/useCountUp', () => ({ CountUp: ({ value }) => <span>{value}</span> }));
vi.mock('@/components/charts/PieDonut', () => ({ default: () => null }));
vi.mock('recharts', () => Object.fromEntries([
  'ResponsiveContainer', 'Cell', 'Tooltip', 'BarChart', 'Bar', 'XAxis', 'YAxis',
  'CartesianGrid', 'AreaChart', 'Area', 'Line',
].map(name => [name, () => null])));

beforeEach(() => { data.occ = []; data.gross = []; data.payroll = []; });
afterEach(cleanup);
const modules = () => render(<MemoryRouter><ModuleCards /></MemoryRouter>);
const moneyKept = () => render(<MoneyKept occRows={[]} srcRows={[]} grossRows={[]}
  dateRange={{ from: '2026-01-01', to: '2026-09-25' }} property="P_A" payroll={data.payroll}
  aggPayRows={null} aggExpenses={null} />);

describe('dashboard financial readouts', () => {
  it('weights portfolio occupancy and RevPAR by available room nights', () => {
    render(<PropertyRanking properties={[{ id: 1, name: 'Middleboro', rooms: 100 }, { id: 2, name: 'Second', rooms: 50 }]}
      occRows={[
        { property_id: 1, date: '2026-01-01', rooms_sold: 60, room_revenue: 6000 },
        { property_id: 2, date: '2026-01-01', rooms_sold: 15, room_revenue: 1500 },
      ]} />);
    const total = screen.getByRole('row', { name: /Portfolio Total/ });
    expect(total).toHaveTextContent('50.0%');
    expect(total).toHaveTextContent('$100.00');
    expect(total).toHaveTextContent('$50.00');
  });
  it('shows paid runs instead of claiming the period has no runs', () => {
    data.payroll = [{ pay_period_start: '2026-01-01', payroll_status: 'paid', total_pay: 41400 }];
    modules();
    expect(screen.getByRole('link', { name: /Payroll Module/ })).toHaveTextContent('1 paid');
    expect(screen.queryByText('No runs in period')).not.toBeInTheDocument();
  });
  it('distinguishes drafts from an empty payroll period', () => {
    data.payroll = [{ pay_period_start: '2026-01-01', payroll_status: 'draft', total_pay: 100 }];
    modules();
    expect(screen.getByRole('link', { name: /Payroll Module/ })).toHaveTextContent('No approved runs');
  });
  it('uses gross report revenue when no occupancy report is present', () => {
    data.gross = [{ date: '2026-01-01', room_rent: 12000, misc_charge: 250 }];
    modules();
    expect(screen.getByRole('link', { name: /Revenue Module/ })).toHaveTextContent('$12,250');
  });
  it('includes ancillary revenue without double counting room rent', () => {
    data.occ = [{ date: '2026-01-01', room_revenue: 12000, rooms_sold: 60 }];
    data.gross = [{ date: '2026-01-01', room_rent: 12000, misc_charge: 250 }];
    modules();
    expect(screen.getByRole('link', { name: /Revenue Module/ })).toHaveTextContent('$12,250');
  });
  it('does not claim no deductions or divide by one dollar when revenue is absent', () => {
    data.payroll = [{ pay_period_start: '2026-01-01', payroll_status: 'paid', total_pay: 41400 }];
    moneyKept();
    expect(screen.queryByText(/No deductions/)).not.toBeInTheDocument();
    expect(screen.queryByText(/4140000/)).not.toBeInTheDocument();
    expect(screen.queryByText('(100%)')).not.toBeInTheDocument();
  });
});
