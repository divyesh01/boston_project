// Committing the Manual Data Entry grid (src/pages/ManualEntry.jsx).
//
// Extracted from the page for the same reason the parser was
// (src/lib/manualEntryImport.js): the write path is the part that can corrupt the
// ledger, and inside a component's event handler it cannot be probed headlessly.
// scripts/probe-manual-entry-save.mjs drives this module directly.
//
// THE DEFECT (launch item #4). handleSave wrote the grid with a bare loop:
//
//     for (const { row, record } of prepared) {
//       if (row._id) await db.entities[entityName].update(row._id, record);
//       else await db.entities[entityName].create(record);
//       saved++;
//     }
//
// One await per row, no transaction, and no try/catch anywhere in handleSave. A
// failure on row 7 of 20 therefore:
//
//   * left rows 1-6 committed to a financial ledger, with 7-20 missing — a
//     half-entered day of revenue that reconciles against nothing;
//   * threw out of an async onClick, so React reported nothing and the page's
//     `saving` flag was never cleared: the Save button span forever and the
//     operator had no way to know that six rows had in fact landed;
//   * skipped rotateCsrfToken(), so the next save attempted with a stale token.
//
// WHY ALL-OR-NOTHING IS THE RIGHT CONTRACT. This grid posts occupancy, payments,
// gross revenue and source rows — the same entities the report importer writes,
// and that importer already commits inside runInTransaction (see
// reportParsers.js#importReport). A partial manual save is strictly worse than a
// rejected one: rejected, the operator fixes the flagged cell and saves again;
// partial, the totals are wrong and nothing says so. Matching the importer also
// means the two write paths cannot drift into different durability guarantees.
//
// NOTE ON THE DEXIE ZONE. runInTransaction primes property access before opening
// the zone so entity methods inside read a cached authorization snapshot; awaiting
// anything that leaves the zone (an auth round-trip, a fetch) forces an early
// commit and breaks atomicity. That is why the dedupe decision below is made
// BEFORE the transaction opens and the zone contains writes and nothing else.

import { db, runInTransaction } from '@/api/base44Client';

/**
 * @typedef {Object} PreparedRow
 * @property {{ _id?: string }} row the grid row (its `_id` marks an edit, not an insert)
 * @property {Record<string, any>} record the validated entity fields to write
 */

/**
 * Commit a validated batch of manual-entry rows: every row or none of them.
 *
 * Rows are assumed already validated by the caller — this function decides
 * insert-vs-update and duplicate-vs-new, then writes. It does not coerce or
 * default any field, because a silently defaulted value is the class of bug
 * manualEntryImport.js exists to prevent.
 *
 * @param {Object} args
 * @param {string} args.entityName entity to write, e.g. "OccupancyDay"
 * @param {PreparedRow[]} args.prepared
 * @param {Set<string>} [args.existingKeys] dedupe keys already in the database
 * @param {(record: Record<string, any>) => string} args.dedupeKey
 * @returns {Promise<{ saved: number, skipped: number }>} counts that reflect what
 *          COMMITTED; on failure this throws and nothing was written.
 */
export async function saveManualRows({ entityName, prepared = [], existingKeys, dedupeKey }) {
  // Argument faults are the caller's bug, so they throw here rather than being
  // absorbed into a "0 records saved" that reads like an empty grid.
  if (!entityName) throw new Error('saveManualRows: entityName is required');
  if (typeof dedupeKey !== 'function') throw new Error('saveManualRows: dedupeKey must be a function');
  // No existence check on the entity itself: `db.entities` is a Proxy that builds
  // a no-op entity for any name (base44Client.js#entitiesHandler), so `!entity` is
  // never true and a guard on it would be dead code. A typo'd name is a developer
  // error, not hostile input — `entityName` comes from this page's own hardcoded
  // report config — and it surfaces on the first click, loudly, having committed
  // nothing, because the write happens inside the transaction. Probe section [7]
  // pins that behaviour so it stays true.
  const entity = db.entities[entityName];

  // A COPY of the caller's key set. The in-loop `add` is what stops two grid rows
  // for the same date from both being inserted, but mutating the caller's set
  // would leave it claiming rows exist after a failed commit rolled them back —
  // and the retry would then skip exactly the rows that were never written.
  const seen = new Set(existingKeys || []);
  const writes = [];
  let skipped = 0;
  for (const item of prepared) {
    const row = item?.row || {};
    const record = item?.record;
    if (!record) continue;
    const key = dedupeKey(record);
    // An edit targets a known id, so it is never a duplicate of itself.
    if (!row._id && seen.has(key)) {
      skipped++;
      continue;
    }
    seen.add(key);
    writes.push({ id: row._id || null, record });
  }

  // Nothing to write is not a failure — it means every row was already present.
  // Opening a transaction to do nothing would still take the write lock.
  if (!writes.length) return { saved: 0, skipped };

  await runInTransaction([async () => {
    for (const w of writes) {
      if (w.id) await entity.update(w.id, w.record);
      else await entity.create(w.record);
    }
  }]);

  return { saved: writes.length, skipped };
}
