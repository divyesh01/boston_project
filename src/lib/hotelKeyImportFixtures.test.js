import "fake-indexeddb/auto";
// Static, not dynamic: parser.worker.js assigns `self.onmessage` when it is
// evaluated, and that global slot is what the in-process Worker below dispatches
// into. scanReport needs it before importReport has anything to persist.
import "@/lib/parser.worker.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";

// Security utils and generateFileHash read crypto.subtle; jsdom's crypto may
// lack it, so pin the Node WebCrypto implementation the way the other DB-backed
// suites do. The shims below are deliberate PARTIAL doubles, so each assignment
// carries its own `any` cast: a Map stands in for `Storage` (no `length`/`key` —
// nothing under test reads them) and `screen` only needs width/height.
globalThis.crypto ??= /** @type {any} */ (await import("node:crypto").then((m) => m.webcrypto));
if (!globalThis.crypto?.subtle) globalThis.crypto = /** @type {any} */ (await import("node:crypto").then((m) => m.webcrypto));

const __store = new Map();
const __storage = {
  getItem: (/** @type {string} */ k) => (__store.has(k) ? __store.get(k) : null),
  setItem: (/** @type {string} */ k, /** @type {unknown} */ v) => __store.set(k, String(v)),
  removeItem: (/** @type {string} */ k) => __store.delete(k),
  clear: () => __store.clear(),
};
globalThis.localStorage = /** @type {any} */ (__storage);
globalThis.sessionStorage = /** @type {any} */ (__storage);
// Dexie resolves the IndexedDB API off `window`, so window must be globalThis.
globalThis.window = /** @type {any} */ (globalThis);
globalThis.screen = /** @type {any} */ ({ width: 1920, height: 1080 });
if (globalThis.navigator === undefined) {
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: "test-harness", language: "en-US" },
    configurable: true,
  });
}

const __g = /** @type {any} */ (globalThis);

// The parser runs in a Worker in the browser. Rather than mock the parse away —
// which would delete the behaviour under test — dispatch straight into the real
// handler parser.worker.js installed on the global, and capture the reply it
// posts back.
class InProcessWorker {
  constructor() {
    /** @type {((e: { data: any }) => void) | null} */
    this.onmessage = null;
    /** @type {((e: any) => void) | null} */
    this.onerror = null;
  }

  /** @param {any} data */
  postMessage(data) {
    const handler = __g.self?.onmessage || __g.onmessage;
    if (typeof handler !== "function") {
      throw new Error(
        "HOTELKEY_WORKER_SHIM_UNARMED: importing @/lib/parser.worker.js installed no self.onmessage handler",
      );
    }
    let reply;
    const realPost = __g.postMessage;
    __g.postMessage = (/** @type {any} */ msg) => { reply = msg; };
    try {
      handler({ data });
    } finally {
      __g.postMessage = realPost;
    }
    if (this.onmessage) this.onmessage({ data: reply });
  }

  terminate() {}
}
__g.Worker = InProcessWorker;

const { default: localDb } = await import("@/api/localDb");
const { db, listImportSessions } = await import("@/api/base44Client");
const { scanReport, importReport } = await import("@/lib/reportParsers.js");

// Resolved from this module's own path so the suite works from any cwd. The URL
// is handed to fileURLToPath as a STRING on purpose: under the jsdom environment
// the global URL constructor resolves a relative specifier against the document
// base (http://localhost:3000/) rather than against the file:// base it is given.
const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__", "hotelkey");

/** @param {string} name */
function fixtureText(name) {
  return readFileSync(path.join(FIXTURE_DIR, name), "utf8");
}

/**
 * scanReport's return shape differs per report type, so the union is widened
 * once here instead of casting at every call.
 * @param {string} name
 * @param {Record<string, unknown>} [meta]
 * @returns {Promise<any>}
 */
async function scan(name, meta = {}) {
  return /** @type {any} */ (
    await scanReport("auto", name, { csvText: fixtureText(name), sourceFile: name, ...meta })
  );
}

/**
 * @param {string} name
 * @param {Record<string, unknown>} meta
 * @returns {Promise<any>}
 */
async function importFixture(name, meta) {
  return /** @type {any} */ (await importReport(await scan(name), { sourceFile: name, ...meta }));
}

/** @param {string} propertyId */
async function ledger(propertyId) {
  const rows = await db.entities.TransactionLine.filter({ property_id: propertyId });
  return rows.slice().sort((/** @type {any} */ a, /** @type {any} */ b) =>
    String(a.dedupe_key).localeCompare(String(b.dedupe_key)));
}

beforeEach(async () => {
  await localDb.open();
  await Promise.all(localDb.tables.map((/** @type {any} */ t) => t.clear()));
  localStorage.clear();
  sessionStorage.clear();

  // An authenticated owner, so the property-isolation proxy permits writes at
  // all. Without this every persist below would fail for the wrong reason.
  await db.auth.registerUser({
    username: "owner",
    email: "owner@test.local",
    role: "owner",
    permissions: "all",
    property_access: "all",
    is_active: true,
    password: "Password1!",
  });
  await db.auth.login("owner@test.local", "Password1!", true);
});

const P1 = "P-BOS-001";
const P1_NAME = "Boston Test House";
const P2 = "P-CAM-002";
const P2_NAME = "Cambridge Test House";

describe("HotelKey persist — property assignment", () => {
  const NAME = "transactions-stacked-sections.csv";

  it("stamps every row with the property, the session import id and the source file", async () => {
    const result = await importFixture(NAME, { propertyId: P1, propertyName: P1_NAME });
    expect(result).toMatchObject({ count: 3, excluded: 0 });

    const rows = await ledger(P1);
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.property_id).toBe(P1);
      expect(r.property_name).toBe(P1_NAME);
      expect(r.source_file).toBe(NAME);
      expect(r.report_type).toBe("transactions");
      // addMeta stamps the id doImport was handed, which is the id
      // createImportSession minted — the same one importReport returns. A caller
      // that rolled back with its own meta.importId would find no ledger.
      expect(r.import_id).toBe(result.importId);
    }
    expect(result.importId).toBeTruthy();

    // The rollback ledger must be able to find this import by that id, and must
    // record which table to undo. Session records are camelCase (createImportSession
    // spreads its own metadata), unlike the snake_case entity rows.
    const sessions = await listImportSessions();
    const session = sessions.find((/** @type {any} */ s) => s.importId === result.importId);
    expect(session).toMatchObject({
      status: "completed",
      sourceFile: NAME,
      propertyId: P1,
      reportType: "transactions",
      rowCounts: { TransactionLine: 3 },
    });
  });

  it("puts the property into the dedupe key, so the scan-time key is not the stored key", async () => {
    const scanned = await scan(NAME);
    // Pre-persist the rows carry no property at all, so their keys start with an
    // empty field. addMeta runs BEFORE assignDedupeKeys in doImport; reversing
    // that order would store keys with an EMPTY leading field instead of the
    // property, which is what the assertion below catches.
    //
    // It would not cause cross-property data loss: existingTxnDedupeKeys scopes its
    // read to `{ property_id: propertyId }` (reportParsers.js#existingTxnDedupeKeys),
    // so one property's guard never compares against another's stored keys. The property
    // component of the key is defence-in-depth, not the isolating mechanism.
    expect(scanned.rowsToImport.every((/** @type {any} */ r) => !r.property_id)).toBe(true);

    await importReport(scanned, { propertyId: P1, propertyName: P1_NAME, sourceFile: NAME });
    const rows = await ledger(P1);
    // Sorted by key, so the 06:42 PM settlement leads. The settlement is stored
    // as a POSITIVE 287.50 with ledger_side "payment"; the sign is not what
    // separates revenue from settlement here, the classification is.
    expect(rows.map((/** @type {any} */ r) => r.dedupe_key)).toEqual([
      `${P1}|2026-02-14|06:42 PM|F0000001|FPCC|287.5|0`,
      `${P1}|2026-02-14|09:15 AM|F0000001|RENT|250|0`,
      `${P1}|2026-02-14|09:15 AM|F0000001|TAX|37.5|0`,
    ]);
  });

  it("stamps the file hash the scan computed, which is what the re-import guard reads", async () => {
    const scanned = await scan(NAME);
    await importReport(scanned, { propertyId: P1, propertyName: P1_NAME, sourceFile: NAME });
    const rows = await ledger(P1);
    expect(rows.every((/** @type {any} */ r) => r.file_hash === scanned.fileHash)).toBe(true);
    expect(scanned.fileHash).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("HotelKey persist — the property gate is fail-closed", () => {
  const NAME = "transactions-stacked-sections.csv";

  // Every value a non-UI caller could plausibly arrive with. An empty id is the
  // dangerous one: addMeta would stamp `property_id: ""` and the dedupe read
  // would degrade to filter({}) — a scan across EVERY property, which is how a
  // "Property A cannot see Property B" violation would start.
  /** @type {[string, Record<string, unknown>][]} */
  const REFUSED = [
    ["omitted", {}],
    ["empty string", { propertyId: "" }],
    ["whitespace only", { propertyId: "   " }],
    ["a tab", { propertyId: "\t" }],
    ["null", { propertyId: null }],
    ["a number", { propertyId: 123 }],
    ["an object", { propertyId: { id: P1 } }],
  ];

  for (const [label, meta] of REFUSED) {
    it(`refuses ${label} before creating a session or a row`, async () => {
      const scanned = await scan(NAME);
      await expect(importReport(scanned, /** @type {any} */ ({ ...meta, sourceFile: NAME })))
        .rejects.toMatchObject({ code: "IMPORT_PROPERTY_REQUIRED" });

      // Fail-closed means nothing was started, not merely nothing was finished:
      // an in_progress session left behind would keep offering an Undo for an
      // import that never happened.
      expect(await listImportSessions()).toEqual([]);
      expect(await db.entities.TransactionLine.filter({})).toEqual([]);
    });
  }

  it("names the isolation boundary in the message, so the cause is not guessed", async () => {
    const scanned = await scan(NAME);
    await expect(importReport(scanned, { propertyId: "", sourceFile: NAME }))
      .rejects.toThrow(/non-empty propertyId is required.*property isolation boundary/);
  });

  it("accepts an id that only needs trimming to be non-empty", async () => {
    // The gate tests `.trim() === ""`, so " P1 " passes it. It is then stamped
    // VERBATIM — untrimmed — which is worth pinning: two callers disagreeing on
    // whitespace would write two properties that look identical on screen.
    const result = await importFixture(NAME, { propertyId: ` ${P1} `, propertyName: P1_NAME });
    expect(result.count).toBe(3);
    expect(await ledger(P1)).toEqual([]);
    expect(await ledger(` ${P1} `)).toHaveLength(3);
  });
});

describe("HotelKey persist — the validation gate", () => {
  // Three different layers must all be able to stop an import, so the gate is
  // proven per layer rather than once: type (money the parser mangled), semantic
  // (a total that contradicts the file's own trailer) and constraint (occupancy
  // out of range). Each is a real HotelKey failure mode, not a synthetic one.
  const BLOCKED = [
    ["type", "transactions-malformed-money.csv", "unparseable_numbers"],
    ["semantic", "transactions-checksum-mismatch.csv", "checksum_mismatch"],
    ["constraint", "occupancy-percent-branches.csv", "out_of_range"],
  ];

  for (const [layer, name, code] of BLOCKED) {
    it(`refuses a file failing ${layer} validation, and starts nothing`, async () => {
      const scanned = await scan(name);
      expect(scanned.validation.ok).toBe(false);
      expect(scanned.validation.firstFailingLayer).toBe(layer);

      let caught = /** @type {any} */ (null);
      await importReport(scanned, { propertyId: P1, propertyName: P1_NAME, sourceFile: name })
        .catch((/** @type {any} */ e) => { caught = e; });

      expect(caught?.code).toBe("IMPORT_VALIDATION_BLOCKED");
      expect(caught.message).toContain(`Import blocked by ${layer} validation`);
      // The validation object rides along, so the UI can show the same findings
      // the preview showed instead of a bare string.
      expect(caught.validation.errors.map((/** @type {any} */ f) => f.code)).toContain(code);
      expect(await listImportSessions()).toEqual([]);
    });
  }

  it("blocks before the persist path, so nothing lands in either entity", async () => {
    // Asserting the rejection CODE, not just the empty tables. A bare
    // `.catch(() => {})` here would let any unrelated early crash satisfy this
    // test — the tables would be empty because nothing ran, and the gate would
    // look proven while being bypassed entirely.
    await expect(importReport(await scan("transactions-malformed-money.csv"),
      { propertyId: P1, propertyName: P1_NAME, sourceFile: "x.csv" }))
      .rejects.toMatchObject({ code: "IMPORT_VALIDATION_BLOCKED" });
    await expect(importReport(await scan("occupancy-percent-branches.csv"),
      { propertyId: P1, propertyName: P1_NAME, sourceFile: "y.csv" }))
      .rejects.toMatchObject({ code: "IMPORT_VALIDATION_BLOCKED" });
    expect(await db.entities.TransactionLine.filter({})).toEqual([]);
    expect(await db.entities.OccupancyDay.filter({})).toEqual([]);
  });

  it("forceImport overrides the gate and persists the mangled money as parsed", async () => {
    // The owner is allowed to override — but the override must not quietly
    // repair anything. All nine sign conventions land exactly as the scanner
    // read them, including the four that became 0.
    const result = await importFixture("transactions-malformed-money.csv", {
      propertyId: P1, propertyName: P1_NAME, forceImport: true,
    });
    expect(result.count).toBe(9);
    const amounts = (await ledger(P1)).map((/** @type {any} */ r) => r.amount).sort((a, b) => a - b);
    expect(amounts).toEqual([-75.5, -40.25, -12.75, 0, 0, 0, 0, 12, 1250]);
  });
});

describe("HotelKey persist — dedupe keeps real duplicates and stops false ones", () => {
  const IDENTICAL = "transactions-identical-rows.csv";
  const CLEAN = "transactions-stacked-sections.csv";

  it("persists all three byte-identical postings, because they are three real nights", async () => {
    // Collapsing these would understate revenue by two thirds. The occurrence
    // index is the only thing standing between the ledger and that loss.
    const result = await importFixture(IDENTICAL, { propertyId: P1, propertyName: P1_NAME });
    expect(result).toMatchObject({ count: 3, excluded: 0 });

    const rows = await ledger(P1);
    expect(rows.map((/** @type {any} */ r) => r.dedupe_key)).toEqual([
      `${P1}|2026-02-14|09:15 AM|F0000050|RENT|60|0`,
      `${P1}|2026-02-14|09:15 AM|F0000050|RENT|60|1`,
      `${P1}|2026-02-14|09:15 AM|F0000050|RENT|60|2`,
    ]);
    expect(rows.reduce((/** @type {number} */ s, /** @type {any} */ r) => s + r.amount, 0)).toBe(180);
  });

  it("treats the same file re-imported for the same property as a no-op", async () => {
    await importFixture(IDENTICAL, { propertyId: P1, propertyName: P1_NAME });
    const again = await importFixture(IDENTICAL, { propertyId: P1, propertyName: P1_NAME });

    // The file-level guard short-circuits before the row read: it reports every
    // row excluded and names the reason, rather than silently returning 0.
    expect(again).toMatchObject({ count: 0, excluded: 3, cleaned: 0, reason: "already-imported" });
    expect(await ledger(P1)).toHaveLength(3);
  });

  it("still stops the duplicate rows when the file hash is bypassed", async () => {
    // A re-export with an extra row, or any change to the bytes, defeats the
    // file-level guard. The row-level dedupe_key read is the guard that has to
    // hold, so it is proven independently by forcing past the first one.
    await importFixture(IDENTICAL, { propertyId: P1, propertyName: P1_NAME });
    const scanned = await scan(IDENTICAL);
    scanned.fileHash = "";
    const again = await importReport(scanned, { propertyId: P1, propertyName: P1_NAME, sourceFile: IDENTICAL });
    expect(again).toMatchObject({ count: 0, excluded: 3 });
    expect(await ledger(P1)).toHaveLength(3);
  });

  it("imports the new days of an overlapping export without duplicating the old ones", async () => {
    await importFixture(CLEAN, { propertyId: P1, propertyName: P1_NAME });
    // A different file (different hash) whose rows partly overlap: the three
    // clean postings again, plus five new dated rows.
    const overlap = await scan("transactions-dates.csv");
    overlap.rowsToImport = [...(await scan(CLEAN)).rowsToImport, ...overlap.rowsToImport];
    const result = await importReport(overlap, { propertyId: P1, propertyName: P1_NAME, sourceFile: "overlap.csv" });
    expect(result).toMatchObject({ count: 5, excluded: 3 });
    expect(await ledger(P1)).toHaveLength(8);
  });

  it("forceImport bypasses both guards and does duplicate the ledger", async () => {
    // Pinned as a hazard, not as a feature: the override the validation gate
    // needs is the same flag that lets a double-import through.
    await importFixture(IDENTICAL, { propertyId: P1, propertyName: P1_NAME });
    const again = await importFixture(IDENTICAL, { propertyId: P1, propertyName: P1_NAME, forceImport: true });
    expect(again.count).toBe(3);
    expect(await ledger(P1)).toHaveLength(6);
  });
});

describe("HotelKey persist — property isolation", () => {
  const NAME = "transactions-identical-rows.csv";

  it("does not let Property A's import block the identical file for Property B", async () => {
    // Two hotels running the same PMS export template produce the same bytes and
    // therefore the SAME file hash. If the already-imported guard were global
    // instead of per-property, Property B's real revenue would vanish with a
    // cheerful count of 0 — a silent, total data loss for the second property.
    const a = await importFixture(NAME, { propertyId: P1, propertyName: P1_NAME });
    const b = await importFixture(NAME, { propertyId: P2, propertyName: P2_NAME });

    expect(a).toMatchObject({ count: 3, excluded: 0 });
    expect(b).toMatchObject({ count: 3, excluded: 0 });
    expect(b.reason).toBeUndefined();

    const rowsA = await ledger(P1);
    const rowsB = await ledger(P2);
    expect(rowsA).toHaveLength(3);
    expect(rowsB).toHaveLength(3);
    // Same file hash on both sides — the guard is scoped by property, not by file.
    expect(new Set(rowsA.map((/** @type {any} */ r) => r.file_hash)))
      .toEqual(new Set(rowsB.map((/** @type {any} */ r) => r.file_hash)));
    // …and the keys differ only in the property field. That is a consequence of
    // the stamp order, not the reason the row-level guard leaves Property B
    // alone: the guard's read is already scoped to one property
    // (reportParsers.js#existingTxnDedupeKeys). Both layers have to hold, so both
    // are asserted.
    expect(rowsA.map((/** @type {any} */ r) => r.dedupe_key.replace(P1, "X")))
      .toEqual(rowsB.map((/** @type {any} */ r) => r.dedupe_key.replace(P2, "X")));
  });

  it("keeps each property's rows out of the other's read", async () => {
    await importFixture(NAME, { propertyId: P1, propertyName: P1_NAME });
    await importFixture("transactions-stacked-sections.csv", { propertyId: P2, propertyName: P2_NAME });

    expect((await ledger(P1)).every((/** @type {any} */ r) => r.property_name === P1_NAME)).toBe(true);
    expect((await ledger(P2)).every((/** @type {any} */ r) => r.property_name === P2_NAME)).toBe(true);
    expect((await ledger(P1)).map((/** @type {any} */ r) => r.transaction_code)).toEqual(["RENT", "RENT", "RENT"]);
    expect((await ledger(P2)).map((/** @type {any} */ r) => r.transaction_code)).toEqual(["FPCC", "RENT", "TAX"]);
    // Neither property's total absorbs the other's.
    const sum = (/** @type {any[]} */ rows) => rows.reduce((s, r) => s + r.amount, 0);
    expect(sum(await ledger(P1))).toBe(180);
    expect(sum(await ledger(P2))).toBe(575);
  });

  it("rolls each property's import back independently", async () => {
    const a = await importFixture(NAME, { propertyId: P1, propertyName: P1_NAME });
    const b = await importFixture(NAME, { propertyId: P2, propertyName: P2_NAME });
    expect(a.importId).not.toBe(b.importId);

    const { rollbackImportSession } = await import("@/api/base44Client");
    await rollbackImportSession(a.importId);
    expect(await ledger(P1)).toEqual([]);
    expect(await ledger(P2)).toHaveLength(3);
  });
});

describe("HotelKey persist — the flat-table path stamps and dedupes too", () => {
  const NAME = "occupancy-percent-branches.csv";
  // The fixture carries a deliberate out-of-range occupancy so it exercises the
  // constraint layer; forcing past that is the only way to reach the persist
  // path with it, and the force is the point of the earlier gate test.
  const FORCED = { propertyId: P1, propertyName: P1_NAME, forceImport: true };

  it("stamps the flat rows and keys them by property and date", async () => {
    const result = await importFixture(NAME, FORCED);
    expect(result.count).toBe(5);
    const rows = await db.entities.OccupancyDay.filter({ property_id: P1 });
    expect(rows).toHaveLength(5);
    for (const r of rows) {
      expect(r.property_id).toBe(P1);
      expect(r.property_name).toBe(P1_NAME);
      expect(r.report_type).toBe("occupancy");
      expect(r.source_file).toBe(NAME);
      expect(r.import_id).toBe(result.importId);
    }
    expect(rows.map((/** @type {any} */ r) => r.occupancy).sort((a, b) => a - b))
      .toEqual([0, 0.72, 0.8, 0.85, 1.5]);
  });

  it("re-importing the same days for the same property adds nothing", async () => {
    await importFixture(NAME, FORCED);
    // forceImport is required to pass the constraint gate, and on this path it
    // ALSO skips the existing-row read — so the second call is deliberately made
    // through a scan whose validation has been satisfied instead.
    const scanned = await scan(NAME);
    scanned.validation = { ...scanned.validation, ok: true, errors: [] };
    const again = await importReport(scanned, { propertyId: P1, propertyName: P1_NAME, sourceFile: NAME });
    expect(again).toMatchObject({ count: 0, excluded: 5 });
    expect(await db.entities.OccupancyDay.filter({ property_id: P1 })).toHaveLength(5);
  });

  it("keeps the two properties' occupancy days apart", async () => {
    await importFixture(NAME, FORCED);
    await importFixture(NAME, { ...FORCED, propertyId: P2, propertyName: P2_NAME });
    expect(await db.entities.OccupancyDay.filter({ property_id: P1 })).toHaveLength(5);
    expect(await db.entities.OccupancyDay.filter({ property_id: P2 })).toHaveLength(5);
    expect(await db.entities.OccupancyDay.filter({})).toHaveLength(10);
  });
});

describe("HotelKey persist — a failed import stays undoable", () => {
  const NAME = "transactions-stacked-sections.csv";

  /**
   * Fails the ledger write once, so the failure path can be exercised without
   * pretending a real defect exists. The collaborator is stubbed, not the
   * contract under test — what is under test is what importReport does WITH a
   * failure: which id it surfaces and what state it leaves the session in.
   * @param {() => Promise<any>} body
   */
  async function withFailingLedgerWrite(body) {
    const real = db.entities.TransactionLine.bulkCreate;
    db.entities.TransactionLine.bulkCreate = async () => {
      throw new Error("SIMULATED_STORAGE_FAILURE");
    };
    try {
      return await body();
    } finally {
      db.entities.TransactionLine.bulkCreate = real;
    }
  }

  it("surfaces the session id on the error, non-enumerably, and marks the session failed", async () => {
    let caught = /** @type {any} */ (null);
    await withFailingLedgerWrite(async () => {
      await importFixture(NAME, { propertyId: P1, propertyName: P1_NAME })
        .catch((/** @type {any} */ e) => { caught = e; });
    });

    expect(caught?.message).toContain("SIMULATED_STORAGE_FAILURE");
    // The caller mints its own meta.importId for queue bookkeeping; the rollback
    // ledger is keyed by the session id minted in here. Without this the caller
    // looks up an import that has no ledger and is told, wrongly, that the undo
    // is impossible.
    expect(typeof caught.importId).toBe("string");
    expect(caught.importId).toMatch(/^imp_/);
    // Deliberately non-enumerable, so the id never leaks into a serialised error.
    expect(Object.keys(caught)).not.toContain("importId");
    expect(JSON.parse(JSON.stringify({ ...caught })).importId).toBeUndefined();

    // Not left indistinguishable from an import that is still running.
    const sessions = await listImportSessions();
    expect(sessions.find((/** @type {any} */ s) => s.importId === caught.importId))
      .toMatchObject({ status: "failed" });
    expect(await db.entities.TransactionLine.filter({})).toEqual([]);
  });

  it("lets the next attempt succeed, because the failure committed nothing", async () => {
    await withFailingLedgerWrite(async () => {
      await importFixture(NAME, { propertyId: P1, propertyName: P1_NAME }).catch(() => {});
    });
    // No rows and no file_hash row landed, so the already-imported guard cannot
    // mistake the failed attempt for a completed one and refuse the retry.
    const retry = await importFixture(NAME, { propertyId: P1, propertyName: P1_NAME });
    expect(retry).toMatchObject({ count: 3, excluded: 0 });
    expect(retry.reason).toBeUndefined();
    expect(await ledger(P1)).toHaveLength(3);
  });
});

