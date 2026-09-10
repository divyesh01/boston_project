import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getQueueMetrics,
  confirmForceImportToggle,
  confirmBatchForceImport,
  validateQueueProperty,
  resolveQueueProperty,
} from './importQueueHelpers';

describe('importQueueHelpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getQueueMetrics', () => {
    it('accurately derives counts and sums from diverse queue items', () => {
      const queue = [
        { key: '1', status: 'pending' },
        { key: '2', status: 'scanning' },
        { key: '3', status: 'ready', scan: {} },
        { key: '4', status: 'ready', scan: {} },
        { key: '5', status: 'error', error: 'Fail' },
        { key: '6', status: 'done', count: 120, excluded: 5 },
        { key: '7', status: 'done', count: 80, excluded: 2 },
        { key: '8', status: 'duplicate' },
      ];

      const metrics = getQueueMetrics(queue);
      expect(metrics.queuedCount).toBe(2);
      expect(metrics.readyCount).toBe(2);
      expect(metrics.errorItems).toHaveLength(1);
      expect(metrics.doneItems).toHaveLength(2);
      expect(metrics.duplicateItems).toHaveLength(1);
      expect(metrics.batchImported).toBe(200);
      expect(metrics.batchExcluded).toBe(7);
    });

    it('handles empty queue safely', () => {
      const metrics = getQueueMetrics([]);
      expect(metrics.queuedCount).toBe(0);
      expect(metrics.readyCount).toBe(0);
      expect(metrics.errorItems).toHaveLength(0);
      expect(metrics.doneItems).toHaveLength(0);
      expect(metrics.batchImported).toBe(0);
      expect(metrics.batchExcluded).toBe(0);
    });
  });

  describe('confirmForceImportToggle', () => {
    it('returns true when turning OFF without dialog', () => {
      const confirmSpy = vi.spyOn(window, 'confirm');
      expect(confirmForceImportToggle({ propertyName: 'Red Roof', enabling: false })).toBe(true);
      expect(confirmSpy).not.toHaveBeenCalled();
    });

    it('requires confirmation when enabling Force Import', () => {
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      const res = confirmForceImportToggle({ propertyName: 'Red Roof Middleboro', enabling: true });
      expect(res).toBe(true);
      expect(confirmSpy).toHaveBeenCalledOnce();
      expect(confirmSpy.mock.calls[0][0]).toContain('Red Roof Middleboro');
      expect(confirmSpy.mock.calls[0][0]).toContain('WARNING: Force import bypasses duplicate protection');
    });

    it('returns false when user cancels Force Import confirmation', () => {
      vi.spyOn(window, 'confirm').mockReturnValue(false);
      const res = confirmForceImportToggle({ propertyName: 'Red Roof Middleboro', enabling: true });
      expect(res).toBe(false);
    });
  });

  describe('confirmBatchForceImport', () => {
    it('prompts confirmation naming file count and property name', () => {
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      const res = confirmBatchForceImport({ propertyName: 'Red Roof Middleboro', count: 8 });
      expect(res).toBe(true);
      expect(confirmSpy).toHaveBeenCalledOnce();
      expect(confirmSpy.mock.calls[0][0]).toContain('FORCE IMPORT 8 reports');
      expect(confirmSpy.mock.calls[0][0]).toContain('Red Roof Middleboro');
    });
  });

  describe('validateQueueProperty', () => {
    it('rejects empty propertyId', () => {
      const res = validateQueueProperty({
        item: { scan: {} },
        propertyId: '',
        accessibleProperties: [{ id: 'p1' }],
      });
      expect(res.ok).toBe(false);
      expect(res.error).toContain('Select a property');
    });

    it('rejects property that was revoked from accessibleProperties', () => {
      const res = validateQueueProperty({
        item: { scan: {} },
        propertyId: 'p2',
        accessibleProperties: [{ id: 'p1' }],
      });
      expect(res.ok).toBe(false);
      expect(res.error).toContain('no longer accessible');
    });

    it('rejects item whose scan metadata belongs to a different property', () => {
      const res = validateQueueProperty({
        item: { scan: { meta: { propertyId: 'old-prop' } } },
        propertyId: 'new-prop',
        accessibleProperties: [{ id: 'new-prop' }, { id: 'old-prop' }],
      });
      expect(res.ok).toBe(false);
      expect(res.error).toContain('was scanned for property "old-prop"');
    });

    it('accepts valid item matching current property', () => {
      const res = validateQueueProperty({
        item: { scan: { meta: { propertyId: 'prop-1' } } },
        propertyId: 'prop-1',
        accessibleProperties: [{ id: 'prop-1' }],
      });
      expect(res.ok).toBe(true);
    });
  });

  describe('resolveQueueProperty (5-step ladder)', () => {
    const propA = { id: 'prop-a', name: 'Hotel Alpha' };
    const propB = { id: 'prop-b', name: 'Hotel Beta' };

    it('Step 1: uses queue snapshot ID when it is CURRENTLY authorized', () => {
      const res = resolveQueueProperty({
        item: { propertyId: 'prop-a', propertyName: 'Hotel Alpha' },
        propertyId: 'prop-b',
        accessibleProperties: [propA, propB],
      });
      expect(res.ok).toBe(true);
      expect(res.id).toBe('prop-a');
      expect(res.source).toBe('snapshot');
    });

    it('Step 1 -> 2: treats snapshot as STALE when unauthorized, and uses authorized selected property', () => {
      const res = resolveQueueProperty({
        item: { propertyId: 'prop-stale', propertyName: 'Old Hotel' },
        propertyId: 'prop-b',
        accessibleProperties: [propA, propB],
      });
      expect(res.ok).toBe(true);
      expect(res.id).toBe('prop-b');
      expect(res.source).toBe('selected');
      expect(res.reassigned).toBe(true);
    });

    it('Step 1 -> 3: uses canonical property automatically when exactly ONE accessible property exists', () => {
      // Exactly the production scenario: 1 property in portfolio, queue had stale/unauthorized propertyId
      const res = resolveQueueProperty({
        item: { propertyId: 'prop-stale', propertyName: 'Stale Middleboro' },
        propertyId: '',
        accessibleProperties: [propA],
      });
      expect(res.ok).toBe(true);
      expect(res.id).toBe('prop-a');
      expect(res.name).toBe('Hotel Alpha');
      expect(res.source).toBe('canonical_single');
      expect(res.reassigned).toBe(true);
    });

    it('Step 1 -> 4: refuses to guess when multiple accessible properties exist, asking user to select', () => {
      const res = resolveQueueProperty({
        item: { propertyId: 'prop-stale', propertyName: 'Stale' },
        propertyId: '',
        accessibleProperties: [propA, propB],
      });
      expect(res.ok).toBe(false);
      expect(res.id).toBe('');
      expect(res.requiresSelection).toBe(true);
      expect(res.error).toContain('Multiple accessible properties available');
    });

    it('Step 5: fails closed when zero accessible properties exist', () => {
      const res = resolveQueueProperty({
        item: { propertyId: 'prop-stale' },
        propertyId: '',
        accessibleProperties: [],
      });
      expect(res.ok).toBe(false);
      expect(res.id).toBe('');
      expect(res.error).toContain('No accessible properties found');
    });
  });
});
