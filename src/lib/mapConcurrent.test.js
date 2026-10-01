import { describe, expect, it } from 'vitest';
import { mapConcurrent } from './mapConcurrent.js';

describe('mapConcurrent', () => {
  it('handles empty input array', async () => {
    const mapper = () => 1;
    const result = await mapConcurrent([], mapper);
    expect(result).toEqual([]);
  });

  it('preserves input ordering even when task durations differ', async () => {
    const items = [100, 20, 80, 10, 50];
    const result = await mapConcurrent(items, async (delay, idx) => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      return `item-${idx}-${delay}`;
    });
    expect(result).toEqual([
      'item-0-100',
      'item-1-20',
      'item-2-80',
      'item-3-10',
      'item-4-50',
    ]);
  });

  it('caps concurrent executions at 4', async () => {
    let active = 0;
    let maxActive = 0;
    const items = Array.from({ length: 12 }, (_, i) => i);

    const result = await mapConcurrent(items, async (item) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 25));
      active--;
      return item * 2;
    });

    expect(maxActive).toBeLessThanOrEqual(4);
    expect(result).toEqual(items.map((i) => i * 2));
  });

  it('drains pending in-flight work when a failure occurs', async () => {
    let completedCount = 0;
    let startedCount = 0;
    const items = [1, 2, 3, 4, 5, 6, 7, 8];

    await expect(
      mapConcurrent(items, async (item) => {
        startedCount++;
        if (item === 2) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          throw new Error('Task 2 failed');
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
        completedCount++;
        return item;
      })
    ).rejects.toThrow('Task 2 failed');

    // 4 tasks were started initially (1, 2, 3, 4).
    // Task 2 failed at 10ms. Tasks 1, 3, 4 were already in flight and drained to completion.
    // Tasks 5, 6, 7, 8 should never start because failure occurred.
    expect(startedCount).toBe(4);
    expect(completedCount).toBe(3);
  });
});
