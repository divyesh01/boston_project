// Everything a report import creates, and the one correct way to remove it.
//
// WHY THIS MODULE EXISTS. The set of stores an import owns used to be written
// down in three places that nothing kept in sync:
//
//   src/lib/reportParsers.js   writes the rows (its ENTITY map, plus a few
//                              direct writes for the sections that are not
//                              per-report-type)
//   src/api/base44Client.js    writes the rollback ledger (ImportRecordIds) and
//                              the lifecycle record the Import page renders
//   src/pages/Import.jsx       a literal array of table names inside a React
//                              event handler decided what "Clear all imported
//                              data" removed
//
// The copy in the event handler named the eleven data tables and stopped there,
// so a clear-all deleted the rows and left behind BOTH pieces of rollback state.
// The confirm dialog promises to delete "ALL imported report data and import
// history"; it deleted the data and kept the history. The Import page therefore
// went on listing those imports with a working-looking "Undo" button, and
// rollbackImportSession — reading a ledger full of ids whose rows no longer
// existed — returned `{ success: true, deletedCount: 3 }` for deleting nothing
// (measured: scripts/probe-clear-all-rollback.mjs section 2).
//
// That is worse than a cosmetic leftover. rollbackImportSession documents its own
// idempotency guard as protecting against "ids that may since have been
// reassigned by Dexie's auto-increment to unrelated rows" — and a clear-all
// manufactures exactly that state. Section 1 of the probe measures whether
// IndexedDB's key generator is reset by clear() (on the measured build it is NOT,
// so ids are not currently handed back out), but the fix does not rest on that
// answer: a ledger naming rows that do not exist is wrong either way, and one
// Dexie version bump is all it takes for the answer to change.
//
// So the list lives here once, derived from the writer's own map, and the page
// calls this. A report type added to reportParsers.js is now automatically
// something clear-all knows how to remove.

import { db, clearImportSessions } from "@/api/base44Client";
import localDb from "@/api/localDb";
import { ENTITY as IMPORT_ENTITY_BY_REPORT_TYPE } from "@/lib/reportParsers";

// Stores that hold rows a report import creates.
//
// The per-report-type stores come from the writer's map rather than a copy of it.
// The rest are written directly by reportParsers.js (the sections that are not
// keyed by report type) and by the Import page itself:
//
//   ClerkShiftRecord  written directly by the shift-report path
//   AnomalyAlert      raised during ingestion, about imported rows only
//   TimecardPunch     written directly by the timecard path
//   UploadedReport    the file-level record Import.jsx creates per upload
//
// Every name here is a store whose rows exist ONLY because something was
// imported. Staff, Expense and PayrollRun are deliberately absent even though
// localDb indexes import_id on all three: those tables are written by the Payroll
// and Expenses pages, never by the import pipeline (verified by grepping every
// create/bulkCreate call site), so they hold hand-entered records. Clearing them
// would destroy the staff directory and posted payroll history, which is both
// unrecoverable and the opposite of what the dialog promises.
export const IMPORT_DATA_TABLES = Object.freeze([
  ...new Set([
    ...Object.values(IMPORT_ENTITY_BY_REPORT_TYPE),
    "ClerkShiftRecord",
    "AnomalyAlert",
    "TimecardPunch",
    "UploadedReport",
  ]),
]);

// Materialized from the tables above rather than imported, so it is not "imported
// data" — but it is derived from nothing else, and it is the cache the Dashboard
// prefers over the raw ledgers. Left behind, it keeps reporting revenue for rows
// that no longer exist.
export const DERIVED_CACHE_TABLES = Object.freeze(["DailyFinancialAggregate"]);

// The rollback ledger: one row per (import_id, entity) holding the array of record
// ids that "Undo import" deletes.
export const IMPORT_LEDGER_TABLE = "ImportRecordIds";

/**
 * Delete every trace of every import: the rows, the derived aggregate cache, the
 * rollback ledger and the lifecycle history.
 *
 * Clears through `db.entities[...]` rather than `localDb[...]` on purpose. The
 * entity proxy's clear() refuses any caller who is not entitled to every property
 * ("Only owner/admin can clear all data"), so routing through it keeps a
 * property-scoped manager from wiping the portfolio. A raw localDb.clear() here
 * would bypass that check on every table at once.
 *
 * The Dexie work runs in one rw transaction so a failure part-way through cannot
 * leave some stores cleared and others populated. The lifecycle history is written
 * with secureStore (not Dexie) and so is cleared after the transaction commits —
 * awaiting a non-Dexie promise inside a transaction zone silently breaks it, which
 * is how a previous change to this area broke every import.
 *
 * Deliberately NOT cleared:
 *
 *   IdSequence   the persisted per-prefix high-water mark for employee ids. It is
 *                not imported data, and clearing it restarts staff numbering, which
 *                reissues ids that payroll history still keys on — reintroducing
 *                the exact defect it was added to fix. Asserted in section 5 of
 *                scripts/probe-clear-all-rollback.mjs.
 *   AuditLog     append-only by contract; the entity proxy refuses to clear it.
 *   Property, User, Staff, Expense, PayrollRun, Room and the rest of the operating
 *                configuration — the dialog says these are kept.
 *
 * @returns {Promise<{deletedRows: number, deletedByTable: Record<string, number>,
 *                    ledgerRows: number, sessions: number}>}
 *   Real counts, so the caller can tell the operator what was removed instead of
 *   asserting that something happened.
 */
export async function clearAllImportedData() {
  const tableNames = [...IMPORT_DATA_TABLES, ...DERIVED_CACHE_TABLES, IMPORT_LEDGER_TABLE];

  // Fail loudly on a name that is not a declared store, rather than clearing the
  // other twelve and moving on. `db.entities[unknown]` builds a proxy over
  // `undefined` and only console.warns, so a typo here would otherwise look like
  // a successful clear of a table that was never touched.
  const unknown = tableNames.filter((name) => typeof localDb[name]?.toArray !== "function");
  if (unknown.length) {
    throw new Error(`clearAllImportedData: not declared in localDb: ${unknown.join(", ")}`);
  }

  /** @type {Record<string, number>} */
  const deletedByTable = {};
  await localDb.transaction(
    "rw",
    tableNames.map((name) => localDb[name]),
    async () => {
      for (const name of tableNames) {
        // Counted before the clear so the caller reports what actually went.
        deletedByTable[name] = await localDb[name].count();
        await db.entities[name].clear();
      }
    }
  );

  const ledgerRows = deletedByTable[IMPORT_LEDGER_TABLE] || 0;
  const deletedRows = [...IMPORT_DATA_TABLES, ...DERIVED_CACHE_TABLES]
    .reduce((sum, name) => sum + (deletedByTable[name] || 0), 0);

  // After the transaction: secureStore is not Dexie.
  const sessions = await clearImportSessions();

  return { deletedRows, deletedByTable, ledgerRows, sessions };
}
