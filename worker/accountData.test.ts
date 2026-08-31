import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { __test } from './index';
import { validateAndNormalizeSnapshot } from '../shared/accountDataContract.js';

const owner = {
  access_sub: 'access-owner-1',
  account_id: 'account-1',
  email: 'owner@example.com',
  display_name: 'Owner',
  role: 'owner' as const,
  property_scope_json: '"all"',
  is_active: 1,
};

function snapshot(revenue = 100) {
  return validateAndNormalizeSnapshot({
    tables: {
      Property: [{ id: 'property-a', code: 'A', name: 'Hotel A' }],
      GrossRevenueDay: [{ id: 'revenue-1', property_id: 'property-a', date: '2026-08-30', revenue }],
    },
    settings: { rri_cc_fee_rate: '2.85' },
  });
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM account_snapshots'),
    env.DB.prepare('DELETE FROM snapshot_chunks'),
    env.DB.prepare('DELETE FROM snapshot_revisions'),
    env.DB.prepare('DELETE FROM principals'),
    env.DB.prepare('DELETE FROM accounts'),
  ]);
  await env.DB.batch([
    env.DB.prepare('INSERT INTO accounts (id, display_name, created_at) VALUES (?, ?, ?)')
      .bind(owner.account_id, 'Test', '2026-08-30T00:00:00.000Z'),
    env.DB.prepare(`INSERT INTO principals
      (access_sub, account_id, email, display_name, role, property_scope_json, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`)
      .bind(owner.access_sub, owner.account_id, owner.email, owner.display_name, owner.role,
        owner.property_scope_json, '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z'),
  ]);
});

describe('D1 authoritative snapshot boundary', () => {
  it('publishes a complete chunk set through one visible revision pointer', async () => {
    const result = await __test.bootstrapSnapshot(snapshot(), owner, env);
    const loaded = await __test.readSnapshot(owner, env);
    expect(result.version).toBe(1);
    expect(loaded?.version).toBe(1);
    expect(loaded?.snapshot.tables.GrossRevenueDay[0].revenue).toBe(100);
    expect(loaded?.checksum).toBe(result.checksum);
  });

  it('rejects a stale browser version without changing the visible financial data', async () => {
    await __test.bootstrapSnapshot(snapshot(100), owner, env);
    await __test.replaceSnapshot(snapshot(200), 1, owner, env);
    await expect(__test.replaceSnapshot(snapshot(999), 1, owner, env)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    const loaded = await __test.readSnapshot(owner, env);
    expect(loaded?.version).toBe(2);
    expect(loaded?.snapshot.tables.GrossRevenueDay[0].revenue).toBe(200);
  });

  it('rejects orphan property data before any revision becomes authoritative', async () => {
    const bad = validateAndNormalizeSnapshot({
      tables: { Property: [], Expense: [{ id: 'e-1', property_id: 'property-b', amount: 10 }] },
      settings: {},
    });
    await expect(__test.bootstrapSnapshot(bad, owner, env)).rejects.toThrow('unknown property_id');
    expect(await __test.readSnapshot(owner, env)).toBeNull();
  });

  it('never exposes staged orphan chunks after a compare-and-swap conflict', async () => {
    await __test.bootstrapSnapshot(snapshot(100), owner, env);
    await expect(__test.replaceSnapshot(snapshot(999), 7, owner, env)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    const pointer = await env.DB.prepare('SELECT version FROM account_snapshots WHERE account_id = ?')
      .bind(owner.account_id).first<{ version: number }>();
    const loaded = await __test.readSnapshot(owner, env);
    const revisionCount = await env.DB.prepare('SELECT COUNT(*) AS count FROM snapshot_revisions WHERE account_id = ?')
      .bind(owner.account_id).first<{ count: number }>();
    expect(pointer?.version).toBe(1);
    expect(loaded?.snapshot.tables.GrossRevenueDay[0].revenue).toBe(100);
    expect(revisionCount?.count).toBe(1);
  });
});
