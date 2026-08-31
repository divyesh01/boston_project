import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@/lib/cloudflareApi', () => ({ invokeAccountData: invokeMock }));

const values = new Map();
const storage = {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, String(value)),
  removeItem: (key) => values.delete(key),
  clear: () => values.clear(),
  key: (index) => [...values.keys()][index] ?? null,
  get length() { return values.size; },
};
vi.stubGlobal('localStorage', storage);
vi.stubGlobal('sessionStorage', storage);

const { default: localDb } = await import('@/api/localDb');
const hydration = await import('@/lib/dataHydration');

const serverTables = {
  Property: [{ id: 'property-1', name: 'Boston Hotel', code: 'BOS', rooms: 100 }],
  OccupancyDay: [{ id: 'occ-1', property_id: 'property-1', date: '2026-08-01', room_revenue: 12345.67, rooms_sold: 81 }],
  UploadedReport: [{ id: 'report-1', property_id: 'property-1', file_name: 'August.csv', report_type: 'occupancy' }],
  Expense: [{ id: 'expense-1', property_id: 'property-1', expense_date: '2026-08-01', amount: 456.78 }],
  PayrollRun: [{ id: 'payroll-1', property_id: 'property-1', pay_period_start: '2026-08-01', total_pay: 3000 }],
};
const serverSettings = {
  rri_cc_fee_rate: '2.85',
  rri_reportHistory: JSON.stringify([{ id: 'report-history-1', fileName: 'August.csv' }]),
};

function serverResponse(version = 1, tables = serverTables, settings = serverSettings) {
  return {
    success: true,
    hasData: true,
    version,
    checksum: `checksum-${version}`,
    tables,
    settings,
  };
}

async function clearBrowser() {
  hydration.stopAccountSync();
  await localDb.transaction('rw', localDb.tables, async () => {
    for (const table of localDb.tables) await table.clear();
  });
  values.clear();
  hydration.resetHydrationForTests();
  invokeMock.mockReset();
}

describe('cross-browser account hydration', () => {
  beforeEach(clearBrowser);

  it('restores properties, reports, finance, payroll, and settings in a fresh browser', async () => {
    invokeMock.mockResolvedValue(serverResponse());

    const result = await hydration.hydrateAccountData({ accountId: 'user-1' });

    expect(result.phase).toBe('ready');
    expect(result.hydrationComplete).toBe(true);
    expect(await localDb.Property.toArray()).toEqual(serverTables.Property);
    expect(await localDb.UploadedReport.toArray()).toEqual(serverTables.UploadedReport);
    expect((await localDb.OccupancyDay.toArray()).find((row) => row.id === 'occ-1').room_revenue).toBe(12345.67);
    expect((await localDb.Expense.toArray()).find((row) => row.id === 'expense-1').amount).toBe(456.78);
    expect((await localDb.PayrollRun.toArray()).find((row) => row.id === 'payroll-1').total_pay).toBe(3000);
    expect(localStorage.getItem('rri_cc_fee_rate')).toBe('2.85');
    expect(JSON.parse(localStorage.getItem('rri_reportHistory'))).toHaveLength(1);
  });

  it('does not migrate legacy browser data until the owner authorizes bootstrap', async () => {
    await localDb.Property.put({ id: 'legacy-property', name: 'Legacy Hotel', code: 'LEG' });
    await localDb.OccupancyDay.put({ id: 'legacy-occ', property_id: 'legacy-property', date: '2026-08-01', room_revenue: 9000 });
    invokeMock.mockImplementation(async (action, params) => {
      if (action === 'get_authoritative_data') {
        return { success: true, hasData: false, version: 0 };
      }
      expect(action).toBe('bootstrap_authoritative_data');
      expect(params.authorized).toBe(true);
      expect(params.tables.Property).toHaveLength(1);
      return { success: true, version: 1, checksum: 'bootstrapped' };
    });

    const before = await hydration.hydrateAccountData({ accountId: 'user-1' });
    expect(before.phase).toBe('needs-bootstrap');
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect((await localDb.Property.toArray()).some((row) => row.id === 'legacy-property')).toBe(true);

    expect(await hydration.authorizeServerBootstrap()).toBe(true);
    expect(hydration.getHydrationState().phase).toBe('ready');
    expect((await localDb.Property.toArray()).some((row) => row.id === 'legacy-property')).toBe(true);
  });

  it('refresh and logout/login restore the same authoritative account state', async () => {
    invokeMock.mockResolvedValue(serverResponse());
    await hydration.hydrateAccountData({ accountId: 'user-1' });

    hydration.resetHydrationForTests();
    const secondLogin = await hydration.hydrateAccountData({ accountId: 'user-1' });

    expect(secondLogin.phase).toBe('ready');
    expect(await localDb.Property.toArray()).toEqual(serverTables.Property);
    expect(await localDb.PayrollRun.toArray()).toEqual(serverTables.PayrollRun);
  });

  it('keeps unsynced or differently-owned browser data intact and reports a conflict', async () => {
    await localDb.Property.put({ id: 'other-property', name: 'Other Account Hotel', code: 'OTH' });
    invokeMock.mockResolvedValue(serverResponse());

    const result = await hydration.hydrateAccountData({ accountId: 'user-2' });

    expect(result.phase).toBe('conflict');
    const properties = await localDb.Property.toArray();
    expect(properties.some((row) => row.id === 'other-property')).toBe(true);
    expect(properties.some((row) => row.id === 'property-1')).toBe(false);
  });

  it('synchronizes committed IndexedDB mutations with an exact server base version', async () => {
    invokeMock.mockImplementation(async (action, params) => {
      if (action === 'get_authoritative_data') return serverResponse();
      if (action === 'push_local_data') {
        expect(params.base_version).toBe(1);
        expect(params.tables.Expense.some((row) => row.id === 'expense-2')).toBe(true);
        return { success: true, version: 2, checksum: 'checksum-2' };
      }
      throw new Error(`Unexpected action ${action}`);
    });
    await hydration.hydrateAccountData({ accountId: 'user-1' });
    hydration.startAccountSync();

    await localDb.Expense.put({ id: 'expense-2', property_id: 'property-1', expense_date: '2026-08-02', amount: 100 });
    await hydration.pushDataToServer();
    await vi.waitFor(() => expect(hydration.getHydrationState().serverVersion).toBe(2), { timeout: 2000 });

    expect(hydration.getHydrationState().phase).toBe('ready');
  });

  it('recreates an identical cache in a second fresh-browser simulation', async () => {
    invokeMock.mockResolvedValue(serverResponse());
    await hydration.hydrateAccountData({ accountId: 'user-1' });
    const browserA = await hydration.exportLocalData();

    await clearBrowser();
    invokeMock.mockResolvedValue(serverResponse());
    await hydration.hydrateAccountData({ accountId: 'user-1' });
    const browserB = await hydration.exportLocalData();

    expect(browserB).toEqual(browserA);
  });
});
