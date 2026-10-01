// Use the existing entity API; never silently accept a truncated D1 ledger.
export async function readHotelDataRows(entity, filter, sortField) {
  if (import.meta.env?.VITE_USE_D1_API !== 'true') return entity.filter(filter, sortField);
  const rows = [], seenIds = new Set();
  let cursor = null, expectedTotal = null;
  for (;;) {
    const page = await entity.paginate(filter, sortField, 5000, cursor);
    if (!Array.isArray(page?.items) || !Number.isSafeInteger(page.total) || page.total < 0) {
      throw new Error('Incomplete hotel data response. Refresh before using these totals.');
    }
    if (expectedTotal === null) expectedTotal = page.total;
    if (page.total !== expectedTotal) throw new Error('Hotel data changed during loading. Please refresh.');
    for (const row of page.items) {
      const key = `${typeof row?.id}:${row?.id}`;
      if (row?.id == null || seenIds.has(key)) throw new Error('Hotel data changed during loading. Please refresh.');
      seenIds.add(key);
    }
    rows.push(...page.items);
    if (!page.hasMore) {
      if (rows.length !== expectedTotal) throw new Error('Incomplete hotel data response. Please refresh.');
      return rows;
    }
    if (!page.items.length || page.nextCursor == null || page.nextCursor === cursor || rows.length >= expectedTotal) {
      throw new Error('Hotel data pagination did not advance. Please refresh.');
    }
    cursor = page.nextCursor;
  }
}
