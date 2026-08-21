import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import localDb from '@/api/localDb';
import { db } from '@/api/base44Client';

describe('Data Integrity & Group 2', () => {
  beforeEach(async () => {
    // Clear databases before tests
    await Promise.all(localDb.tables.map(table => table.clear()));

    // Mock authenticated owner so property isolation proxy permits writes
    await db.auth.registerUser({
      username: "owner",
      email: "owner@test.local",
      role: "owner",
      permissions: "all",
      property_access: "all",
      is_active: true,
      password: "MockSecurePass#2026",
    });
    await db.auth.login("owner@test.local", "MockSecurePass#2026", true);
  });

  it('15. Property uniqueness constraint: should reject duplicate property codes', async () => {
    // Create first property
    await localDb.Property.add({
      code: 'PROP1',
      name: 'Property One',
      active: true,
      created_date: new Date().toISOString()
    });

    // Try to create second property with same code
    await expect(
      localDb.Property.add({
        code: 'PROP1',
        name: 'Duplicate Property',
        active: true,
        created_date: new Date().toISOString()
      })
    ).rejects.toThrow();
  });

  it('13. Cascading Deletes: should delete associated records when Property is deleted', async () => {
    // Create a property
    const propId = await localDb.Property.add({
      code: 'DEL_TEST',
      name: 'Delete Test',
      active: true,
      created_date: new Date().toISOString()
    });

    const strPropId = String(propId);

    // Create associated records
    await localDb.OccupancyDay.bulkAdd([
      { date: '2023-01-01', property_id: strPropId, created_date: new Date().toISOString() },
      { date: '2023-01-02', property_id: strPropId, created_date: new Date().toISOString() }
    ]);
    await localDb.Expense.add({
      property_id: strPropId,
      expense_date: '2023-01-01',
      category: 'maintenance',
      status: 'paid',
      created_date: new Date().toISOString()
    });

    // Verify they exist
    let occCount = await localDb.OccupancyDay.where({ property_id: strPropId }).count();
    let expCount = await localDb.Expense.where({ property_id: strPropId }).count();
    expect(occCount).toBe(2);
    expect(expCount).toBe(1);

    // Call base44Client delete which handles cascading
    await db.entities.Property.delete(propId);

    // Verify cascading deletes
    occCount = await localDb.OccupancyDay.where({ property_id: strPropId }).count();
    expCount = await localDb.Expense.where({ property_id: strPropId }).count();
    expect(occCount).toBe(0);
    expect(expCount).toBe(0);
  });
});
