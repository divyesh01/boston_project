import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getQueueMetrics,
  confirmForceImportToggle,
  confirmBatchForceImport,
  confirmPropertyReassignment,
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

  describe('confirmPropertyReassignment', () => {
    it('prompts confirmation for single file with old and new targets', () => {
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      const res = confirmPropertyReassignment({
        oldTarget: 'Hotel Alpha (prop-a)',
        newTarget: 'Hotel Beta (prop-b)',
        count: 1,
      });
      expect(res).toBe(true);
      expect(confirmSpy).toHaveBeenCalledOnce();
      const msg = confirmSpy.mock.calls[0][0];
      expect(msg).toContain('This file was queued for:\nHotel Alpha (prop-a)');
      expect(msg).toContain('That property is no longer accessible or authorized.');
      expect(msg).toContain('Reassign this file to:\nHotel Beta (prop-b)?');
    });

    it('prompts batch confirmation naming file count', () => {
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      const res = confirmPropertyReassignment({
        oldTarget: 'Old Stale (prop-stale)',
        newTarget: 'Red Roof Middleboro (prop-middleboro)',
        count: 10,
      });
      expect(res).toBe(true);
      expect(confirmSpy).toHaveBeenCalledOnce();
      const msg = confirmSpy.mock.calls[0][0];
      expect(msg).toContain('10 files were queued for:\nOld Stale (prop-stale)');
      expect(msg).toContain('Reassign all 10 queued files to:\nRed Roof Middleboro (prop-middleboro)?');
    });

    it('returns false when user cancels reassignment', () => {
      vi.spyOn(window, 'confirm').mockReturnValue(false);
      const res = confirmPropertyReassignment({
        oldTarget: 'Hotel A',
        newTarget: 'Hotel B',
      });
      expect(res).toBe(false);
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

    it('rejects item whose scan metadata belongs to a different property when not reassigned/canonicalized', () => {
      const res = validateQueueProperty({
        item: { scan: { meta: { propertyId: 'old-prop' } } },
        propertyId: 'new-prop',
        accessibleProperties: [{ id: 'new-prop' }, { id: 'old-prop' }],
      });
      expect(res.ok).toBe(false);
      expect(res.error).toContain('was scanned for property "old-prop"');
    });

    it('accepts item whose scan metadata differs if reassignment was operator-confirmed', () => {
      const res = validateQueueProperty({
        item: { scan: { meta: { propertyId: 'old-prop' } }, reassignmentConfirmed: true },
        propertyId: 'new-prop',
        accessibleProperties: [{ id: 'new-prop' }],
      });
      expect(res.ok).toBe(true);
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

  describe('resolveQueueProperty (strict identity ladder)', () => {
    const propA = { id: 'prop-a', code: 'RR101', name: 'Hotel Alpha' };
    const propB = { id: 'prop-b', code: 'RR102', name: 'Hotel Beta' };

    it('CASE A: uses queue snapshot ID when it is CURRENTLY authorized (no reassignment)', () => {
      const res = resolveQueueProperty({
        item: { propertyId: 'prop-a', propertyName: 'Hotel Alpha' },
        propertyId: 'prop-b',
        accessibleProperties: [propA, propB],
      });
      expect(res.ok).toBe(true);
      expect(res.id).toBe('prop-a');
      expect(res.source).toBe('snapshot');
      expect(res.reassigned).toBe(false);
    });

    it('CASE B: authoritatively canonicalizes when snapshot matches property code', () => {
      const res = resolveQueueProperty({
        item: { propertyId: 'RR101', propertyName: 'Hotel Alpha' },
        propertyId: '',
        accessibleProperties: [propA, propB],
      });
      expect(res.ok).toBe(true);
      expect(res.id).toBe('prop-a');
      expect(res.source).toBe('authoritative_alias');
      expect(res.canonicalized).toBe(true);
      expect(res.reassigned).toBe(true);
      expect(res.originalPropertyId).toBe('RR101');
    });

    it('CASE C: safely falls back to canonical property when snapshot is EMPTY and exactly 1 property accessible', () => {
      const res = resolveQueueProperty({
        item: { propertyId: '', propertyName: '' },
        propertyId: '',
        accessibleProperties: [propA],
      });
      expect(res.ok).toBe(true);
      expect(res.id).toBe('prop-a');
      expect(res.name).toBe('Hotel Alpha');
      expect(res.source).toBe('canonical_single');
      expect(res.reassigned).toBe(false);
    });

    it('CASE D: NEVER silently re-homes a nonempty revoked snapshot even if only 1 accessible property exists', () => {
      // prop-revoked genuinely belonged to another hotel; user only has access to prop-b
      const res = resolveQueueProperty({
        item: { propertyId: 'prop-revoked', propertyName: 'Revoked Hotel' },
        propertyId: '',
        accessibleProperties: [propB],
      });
      expect(res.ok).toBe(false);
      expect(res.id).toBe('');
      expect(res.requiresReassignment).toBe(true);
      expect(res.originalPropertyId).toBe('prop-revoked');
      expect(res.originalPropertyName).toBe('Revoked Hotel');
      expect(res.suggestedTargetId).toBe('prop-b');
      expect(res.suggestedTargetName).toBe('Hotel Beta');
      expect(res.error).toContain('Explicit operator reassignment is required');
    });

    it('Explicit Reassignment: proceeds with confirmed target when operator has confirmed', () => {
      const res = resolveQueueProperty({
        item: {
          propertyId: 'prop-revoked',
          propertyName: 'Revoked Hotel',
          originalPropertyId: 'prop-revoked',
          originalPropertyName: 'Revoked Hotel',
          reassignmentConfirmed: true,
          reassignedFromPropertyId: 'prop-revoked',
        },
        propertyId: 'prop-b',
        accessibleProperties: [propB],
      });
      expect(res.ok).toBe(true);
      expect(res.id).toBe('prop-b');
      expect(res.name).toBe('Hotel Beta');
      expect(res.source).toBe('operator_reassigned');
      expect(res.reassigned).toBe(true);
      expect(res.originalPropertyId).toBe('prop-revoked');
      expect(res.reassignedFromPropertyId).toBe('prop-revoked');
    });

    it('CASE E: refuses to guess when multiple accessible properties exist and snapshot is stale', () => {
      const res = resolveQueueProperty({
        item: { propertyId: 'prop-stale', propertyName: 'Stale' },
        propertyId: '',
        accessibleProperties: [propA, propB],
      });
      expect(res.ok).toBe(false);
      expect(res.id).toBe('');
      expect(res.requiresReassignment).toBe(true);
      expect(res.requiresSelection).toBe(true);
      expect(res.error).toContain('Multiple accessible properties available');
    });

    it('Dropdown validation: blocks scan when selected property is invalid and multiple properties exist', () => {
      const res = resolveQueueProperty({
        propertyId: 'stale-c',
        accessibleProperties: [propA, propB],
      });
      expect(res.ok).toBe(false);
      expect(res.requiresSelection).toBe(true);
      expect(res.error).toContain('Multiple accessible properties available');
    });

    it('CASE F: fails closed when zero accessible properties exist', () => {
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

