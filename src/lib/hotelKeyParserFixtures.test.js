/**
 * HotelKey scanner regression net — committed synthetic fixtures.
 *
 * Why this file exists: the only end-to-end proof reportParsers.js had was
 * scripts/test-parser.mjs, which reads a real export out of a temporary upload
 * directory that is not in the repository, so the proof left with the directory.
 * hotelKeyRegression.test.js does not touch the parser at all despite its name.
 *
 * The fixtures in __fixtures__/hotelkey are synthetic — reserved example.com
 * addresses, invented folio and confirmation numbers, no guest data — and
 * committed, so the behaviours that must stay identical while this 1,900-line
 * module is split (revenue, dates, stacked sections, repeated headers, dedupe,
 * malformed money, property assignment) are pinned by files that travel with the
 * repository. Property assignment and dedupe-at-persist need a database and live
 * in hotelKeyImportFixtures.test.js; everything reachable without one is here.
 *
 * Every expected value below was derived by reading the implementation, then
 * confirmed by execution. This suite changes no production behaviour.
 */
import "fake-indexeddb/auto";
// Static, not dynamic: parser.worker.js assigns `self.onmessage` when it is
// evaluated, and that global slot is what the in-process Worker below dispatches
// into. Loading it by file:// URL the way scripts/_dom-shims.mjs does would skip
// Vite's transform pipeline for its `@/`-adjacent import chain.
import "@/lib/parser.worker.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// generateFileHash reads crypto.subtle; jsdom's crypto may lack it, so pin the
// Node WebCrypto implementation as the harness scripts and the rollback suite do.
globalThis.crypto ??= /** @type {any} */ (await import("node:crypto").then((m) => m.webcrypto));
if (!globalThis.crypto?.subtle) globalThis.crypto = /** @type {any} */ (await import("node:crypto").then((m) => m.webcrypto));

// reportParsers.js statically imports @/api/base44Client, which opens Dexie at
// module-evaluation time even for a scan that never persists a row — so the
// storage globals must exist before the dynamic import further down.
const __store = new Map();
const __storage = {
  getItem: (/** @type {string} */ k) => (__store.has(k) ? __store.get(k) : null),
  setItem: (/** @type {string} */ k, /** @type {unknown} */ v) => __store.set(k, String(v)),
  removeItem: (/** @type {string} */ k) => __store.delete(k),
  clear: () => __store.clear(),
};
globalThis.localStorage = /** @type {any} */ (__storage);
globalThis.sessionStorage = /** @type {any} */ (__storage);
globalThis.window = /** @type {any} */ (globalThis);

const __g = /** @type {any} */ (globalThis);

/**
 * csvParser.parseTextInWorker is the only door into the scanner when meta.csvText
 * is set, and it constructs a real Worker. The worker's text branch is entirely
 * synchronous, so running its handler in-process is behaviour-preserving rather
 * than a stub: the same parseCsvText/rowsToObjects/detectSections code runs, and
 * `rows` — the only field parseTextInWorker consumes — is produced by the real
 * implementation. Installing this unconditionally keeps the suite deterministic
 * instead of depending on whether jsdom happens to expose a Worker.
 */
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

const { scanReport } = await import("@/lib/reportParsers.js");
const { assignDedupeKeys, transactionDedupeKey } = await import("@/lib/transactionNorm.js");
// Same money helpers reportParsers.js itself uses, so revenue assertions are made
// in integer cents rather than in floats that could drift by a fraction of a cent.
const { fromCents, sumCents } = await import("@/lib/decimal.js");

// Resolved from this module's own path so the suite works from any cwd. The URL
// is handed to fileURLToPath as a STRING on purpose: under the jsdom environment
// the global URL constructor resolves a relative specifier against the document
// base (http://localhost:3000/) rather than against the file:// base it is given,
// which turns the result into an http URL that fileURLToPath rejects.
const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__", "hotelkey");

/** @param {string} name */
function fixtureText(name) {
  return readFileSync(path.join(FIXTURE_DIR, name), "utf8");
}

/**
 * scanReport's return shape differs per report type, so the union is widened once
 * here instead of casting at every assertion.
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
 * Findings are compared as a sorted `code:severity` set: the contract is which
 * findings fire and how hard they bite, not the order the layers push them in.
 * @param {any} validation
 */
function findingCodes(validation) {
  return validation.findings.map((/** @type {any} */ f) => `${f.code}:${f.severity}`).sort();
}

/**
 * Money is summed in integer cents, the same way the scanner does it, so the
 * assertion cannot pass or fail on float drift.
 * @param {any[]} rows
 */
function dollars(rows) {
  return fromCents(sumCents(rows.map((r) => r.amount)));
}

describe("HotelKey transactions — detection and stacked sections", () => {
  it("routes on the header signature, not on the file name", async () => {
    // The filename fallbacks in detectReportType would not match this name, so a
    // pass here proves the four-keyword header signature did the routing.
    const result = await scan("transactions-narrow-only.csv", { sourceFile: "quarterly-export-final.txt" });
    expect(result.type).toBe("transactions");
  });

  it("keeps the widest section that has rows and still reports the ones it skipped", async () => {
    const result = await scan("transactions-stacked-sections.csv");

    expect(result.sections.map((/** @type {any} */ s) => s.columns)).toEqual([19, 26, 26, 12, 34]);
    // Section rows include the trailer line; only the three postings import.
    expect(result.sections.map((/** @type {any} */ s) => s.rows)).toEqual([4, 0, 0, 0, 4]);
    expect(result.sections.filter((/** @type {any} */ s) => s.used).map((/** @type {any} */ s) => s.columns)).toEqual([34]);
    expect(result.totalRows).toBe(3);
  });

  it("breaks a width tie by keeping the first grid, and drops the second one", async () => {
    // Two grids, same 19 columns, both carrying rows. The winner is chosen with a
    // strict `>` (parsers/transactions.js#scanTransactions), so the FIRST of
    // equal-width sections wins and the second one's rows never reach rowsToImport.
    //
    // This pins that tie-break, and it also pins the consequence: section 2's
    // 900.00 + 135.00 are silently discarded, and the checksum reconciles against
    // section 1's trailer alone, so the file looks perfectly balanced while a
    // third of it is gone. Reported as a hazard, not changed here — an export that
    // repeats a same-width grid after a blank line would under-report revenue. A
    // future change to which section wins has to come through this test.
    const result = await scan("transactions-tied-sections.csv");

    expect(result.sections.map((/** @type {any} */ s) => s.columns)).toEqual([19, 19]);
    expect(result.sections.map((/** @type {any} */ s) => s.rows)).toEqual([3, 3]);
    expect(result.sections.map((/** @type {any} */ s) => s.used)).toEqual([true, false]);

    expect(result.totalRows).toBe(2);
    expect(result.rowsToImport.map((/** @type {any} */ r) => r.folio_number)).toEqual([
      "F0000201", "F0000201",
    ]);
    expect(result.rowsToImport.map((/** @type {any} */ r) => r.amount)).toEqual([100, 15]);
    expect(result.rowsToImport.some((/** @type {any} */ r) => r.folio_number === "F0000202")).toBe(false);
    // Balanced against the wrong trailer: nothing in the scan result says 1035.00
    // was ever in the file.
    expect(result.checksum).toEqual({ parsed: 115, declared: 115, matches: true });
    expect(result.validation.ok).toBe(true);
  });

  it("reconciles the parsed amounts against the file's own trailer total", async () => {
    const result = await scan("transactions-stacked-sections.csv");

    expect(result.checksum).toEqual({ parsed: 575, declared: 575, matches: true });
    expect(result.errors).toEqual([]);
    expect(findingCodes(result.validation)).toEqual([]);
    expect(result.validation.ok).toBe(true);
  });

  it("keeps the wide grid's extra columns and leaves an empty numeric cell null", async () => {
    const result = await scan("transactions-stacked-sections.csv");
    const [rent, tax, settlement] = result.rowsToImport;

    // Fields that exist only in the 34-column section: proof the widest grid won.
    expect(rent.guest_first_name).toBe("Ada");
    expect(rent.guest_last_name).toBe("Sample");
    expect(rent.account_type).toBe("Guest");
    expect([rent.quantity, rent.adults]).toEqual([1, 2]);
    expect([tax.quantity, tax.adults]).toEqual([1, 2]);
    // mapTransactionRow defaults a null `amount` to 0 and ONLY `amount`
    // (transactionNorm.js:219). An empty Quantity/Adults cell keeps its null, so
    // "not stated" never masquerades as a real zero.
    expect([settlement.quantity, settlement.adults]).toEqual([null, null]);
    // Quoted comma inside the guest name survives the CSV scanner intact.
    expect(rent.guest_name).toBe("Sample, Ada");
  });

  it("classifies each row's ledger side, payment method and account class", async () => {
    const result = await scan("transactions-stacked-sections.csv");
    const [rent, tax, settlement] = result.rowsToImport;

    expect(result.rowsToImport.map((/** @type {any} */ r) => r.ledger_side)).toEqual([
      "charge", "charge", "payment",
    ]);
    expect(rent.payment_method).toBe("");
    expect(tax.payment_method).toBe("");
    expect(settlement.payment_method).toBe("Card");
    expect(settlement.card_last4).toBe("1111");
    // An automation account is still real revenue, just not a person.
    expect([rent.account_class, settlement.account_class]).toEqual(["staff", "system"]);
    expect([rent.employee_label, settlement.employee_label]).toEqual(["Ada Lovelace", "hkcrsuser"]);
  });
});

describe("HotelKey transactions — revenue is the charge side only", () => {
  // This is the single most expensive contract in the file. Section 1 and section
  // 5 hold the SAME postings, and within a section a CHARGE raises the folio while
  // a REFUND settles it. Summing every row double-counts. In this fixture the
  // naive sum is exactly 2x the truth, so a regression cannot hide inside rounding.
  for (const fixture of ["transactions-stacked-sections.csv", "transactions-narrow-only.csv"]) {
    it(`charges sum to 287.50 and all rows to exactly double that — ${fixture}`, async () => {
      const result = await scan(fixture);
      const charges = result.rowsToImport.filter((/** @type {any} */ r) => r.ledger_side === "charge");
      const payments = result.rowsToImport.filter((/** @type {any} */ r) => r.ledger_side === "payment");

      expect(dollars(charges)).toBe(287.5);
      expect(dollars(payments)).toBe(287.5);
      expect(dollars(result.rowsToImport)).toBe(575);
      // The relationship, stated as such: the trailer total is not revenue.
      expect(dollars(result.rowsToImport)).toBe(dollars(charges) * 2);
      expect(result.checksum.declared).toBe(dollars(result.rowsToImport));
    });
  }

  it("reads the same revenue whether or not the wide section is present", async () => {
    const stacked = await scan("transactions-stacked-sections.csv");
    const narrow = await scan("transactions-narrow-only.csv");
    const chargeOnly = (/** @type {any} */ r) => r.ledger_side === "charge";

    expect(dollars(narrow.rowsToImport.filter(chargeOnly)))
      .toBe(dollars(stacked.rowsToImport.filter(chargeOnly)));
    // Section geometry differs; the money does not.
    expect(narrow.sections).toHaveLength(1);
    expect(stacked.sections).toHaveLength(5);
  });
});

describe("HotelKey transactions — a repeated header row is not data", () => {
  it("skips the mid-grid header, keeps the three postings, and blocks the import", async () => {
    const result = await scan("transactions-repeated-header.csv");

    // splitTransactionSections only starts a new grid after a BLANK line, so a
    // header repeated mid-grid arrives as an ordinary row. It must not import.
    expect(result.sections).toHaveLength(1);
    expect(result.totalRows).toBe(3);
    expect(result.rowsToImport.map((/** @type {any} */ r) => r.transaction_code)).toEqual([
      "RENT", "TAX", "FPCC",
    ]);
    expect(result.errors).toEqual(["1 row(s) skipped: no readable date."]);
    // The header's own "Amount" cell is an unreadable number, and an unreadable
    // number stored as 0 is an ERROR — so this file is refused, not silently
    // imported one row short.
    expect(findingCodes(result.validation)).toEqual([
      "unparseable_dates:warning",
      "unparseable_numbers:error",
    ]);
    expect(result.validation.ok).toBe(false);
    expect(result.validation.firstFailingLayer).toBe("type");
    // The money that did parse still reconciles, which is exactly why the
    // checksum alone cannot be trusted to catch this.
    expect(result.checksum).toEqual({ parsed: 575, declared: 575, matches: true });
  });
});

describe("HotelKey transactions — dates", () => {
  it("normalises all five spellings the PMS emits and skips the unreadable one", async () => {
    const result = await scan("transactions-dates.csv");

    expect(result.rowsToImport.map((/** @type {any} */ r) => r.date)).toEqual([
      "2026-02-14", "2026-02-15", "2026-02-16", "2026-02-17", "2026-02-18",
    ]);
    // 99.00 belonged to the unreadable-date row and is therefore excluded, which
    // is why the parsed total is 150.00 and still equals the trailer.
    expect(result.checksum).toEqual({ parsed: 150, declared: 150, matches: true });
    expect(result.errors).toEqual(["1 row(s) skipped: no readable date."]);
    // One bad date out of six rows is a warning, not a block: the file imports.
    expect(findingCodes(result.validation)).toEqual(["unparseable_dates:warning"]);
    expect(result.validation.ok).toBe(true);
  });

  it("treats an impossible calendar date as a trailer, not as a skipped row", async () => {
    const result = await scan("transactions-impossible-date.csv");

    // convertDate("2026-02-30") returns "" because Feb 30 does not exist, and a
    // row with no date but an amount IS the trailer shape. So the row is absorbed
    // as this file's declared total — and the mismatch is what surfaces it.
    expect(result.totalRows).toBe(1);
    expect(result.errors).toEqual([
      "Amount total does not match the file's own total: parsed 100.00, file says 777.77.",
    ]);
    expect(result.checksum).toEqual({ parsed: 100, declared: 777.77, matches: false });
    // Deliberately asserted absent: it never reached the skipped-date counter.
    expect(findingCodes(result.validation)).toEqual(["checksum_mismatch:error"]);
    expect(result.validation.firstFailingLayer).toBe("semantic");
    expect(result.validation.ok).toBe(false);
  });
});

describe("HotelKey transactions — malformed money", () => {
  it("reads every sign convention, logs only what it actually mangled, and blocks", async () => {
    const result = await scan("transactions-malformed-money.csv");

    expect(result.rowsToImport.map((/** @type {any} */ r) => r.amount)).toEqual([
      1250,      // "$1,250.00"  currency symbol + thousands separator
      -75.5,     // "($75.50)"   accounting parentheses
      -40.25,    // "$-40.25"    minus AFTER the currency symbol
      -12.75,    // "12.75-"     trailing minus
      0,         // "N/A"        unreadable  -> fabricated 0
      0,         // ""           genuinely empty
      0,         // "Infinity"   non-finite  -> rejected
      0,         // "1e999"      overflows to Infinity -> rejected
      12,        // "12abc"      partly numeric -> silently truncated
    ]);
    // Integer-cents sum, and it equals the trailer: the checksum cannot see this
    // damage, so the coercion log is the only thing that can.
    expect(dollars(result.rowsToImport)).toBe(1133.5);
    expect(result.checksum).toEqual({ parsed: 1133.5, declared: 1133.5, matches: true });
    expect(result.errors).toEqual([]);

    const money = result.validation.findings.filter((/** @type {any} */ f) => f.layer === "type");
    // finding() spreads its detail onto the finding itself, so count/field/samples
    // sit at the top level. count is the BLANKED subset -- "N/A", "Infinity",
    // "1e999" -> 3. The empty cell is NOT a coercion: nothing was stated, so
    // nothing was mangled.
    //
    // samples, however, is built from the WHOLE per-field coercion list
    // (importValidation.js: `[...new Set(list.map(c => c.raw))].slice(0, 5)`), so it
    // mixes truncated raws in with the unparseable ones and does not line up with
    // count. Pinned as observed behaviour so a future change to either the count
    // basis or the samples basis has to come here and say so.
    expect(money.find((/** @type {any} */ f) => f.code === "unparseable_numbers"))
      .toMatchObject({
        field: "amount",
        count: 3,
        samples: ["12.75-", "N/A", "Infinity", "1e999", "12abc"],
      });
    // "12.75-" parses CORRECTLY yet is still flagged, because recordCoercion only
    // strips a LEADING minus before its all-digits test. Pinned as observed
    // behaviour, not endorsed as ideal.
    expect(money.find((/** @type {any} */ f) => f.code === "truncated_numbers"))
      .toMatchObject({ field: "amount", count: 2 });
    expect(findingCodes(result.validation)).toEqual([
      "truncated_numbers:error",
      "unparseable_numbers:error",
    ]);
    expect(result.validation.ok).toBe(false);
    expect(result.validation.firstFailingLayer).toBe("type");
  });
});

describe("HotelKey transactions — checksum shortfall", () => {
  it("names both totals and the signed difference when the download is truncated", async () => {
    const result = await scan("transactions-checksum-mismatch.csv");

    expect(result.totalRows).toBe(2);
    expect(result.checksum).toEqual({ parsed: 300, declared: 350, matches: false });
    expect(result.errors).toEqual([
      "Amount total does not match the file's own total: parsed 300.00, file says 350.00.",
    ]);
    const [mismatch] = result.validation.errors;
    expect(mismatch.code).toBe("checksum_mismatch");
    // The difference is signed and computed in cents, so a shortfall reads as
    // negative rather than as an unsigned "off by 50".
    expect(mismatch.message).toContain("difference -50.00");
    expect(mismatch).toMatchObject({ parsed: 300, declared: 350 });
    expect(result.validation.firstFailingLayer).toBe("semantic");
    expect(result.validation.ok).toBe(false);
  });
});

describe("HotelKey transactions — byte-identical rows are real", () => {
  it("keeps all three identical postings by giving each its own occurrence index", async () => {
    const result = await scan("transactions-identical-rows.csv");

    // One posting action against a three-night stay writes one line per night with
    // the same timestamp. Deduping them overstated revenue by $6,943.82 on the
    // real corpus, which is why the natural key carries an occurrence index.
    expect(result.totalRows).toBe(3);
    expect(dollars(result.rowsToImport)).toBe(180);
    expect(result.checksum).toEqual({ parsed: 180, declared: 180, matches: true });
    expect(findingCodes(result.validation)).toEqual([]);

    const keyed = assignDedupeKeys(result.rowsToImport);
    const keys = keyed.map((/** @type {any} */ r) => r.dedupe_key);
    expect(new Set(keys).size).toBe(3);
    expect(keys).toEqual([
      "|2026-02-14|09:15 AM|F0000050|RENT|60|0",
      "|2026-02-14|09:15 AM|F0000050|RENT|60|1",
      "|2026-02-14|09:15 AM|F0000050|RENT|60|2",
    ]);
    // Same file replayed gives the same occurrences in the same order, so a
    // re-import is idempotent without discarding legitimate repeats.
    expect(assignDedupeKeys(result.rowsToImport).map((/** @type {any} */ r) => r.dedupe_key)).toEqual(keys);
    expect(transactionDedupeKey(result.rowsToImport[0], 0)).toBe(keys[0]);
  });
});

describe("HotelKey transactions — byte-level noise from the download", () => {
  const NAME = "transactions-narrow-only.csv";
  const rowsOf = (/** @type {any} */ r) =>
    r.rowsToImport.map((/** @type {any} */ x) => [x.date, x.time, x.transaction_code, x.amount]);

  it("parses identically with CRLF line endings", async () => {
    const lf = await scan(NAME);
    const crlf = await scan(NAME, { csvText: fixtureText(NAME).replace(/\n/g, "\r\n") });

    expect(rowsOf(crlf)).toEqual(rowsOf(lf));
    expect(crlf.checksum).toEqual(lf.checksum);
    expect(findingCodes(crlf.validation)).toEqual(findingCodes(lf.validation));
  });

  it("parses identically behind a UTF-8 BOM", async () => {
    const lf = await scan(NAME);
    // The BOM is built from its code point so the source stays pure ASCII and an
    // editor or lint autofix cannot silently strip the very byte under test.
    const bom = await scan(NAME, { csvText: String.fromCharCode(0xfeff) + fixtureText(NAME) });

    // A BOM sits in front of the first header cell, so if it were not stripped
    // "Date" would stop mapping and every row would lose its date.
    expect(rowsOf(bom)).toEqual(rowsOf(lf));
    expect(bom.type).toBe("transactions");
    expect(bom.checksum).toEqual(lf.checksum);
    expect(findingCodes(bom.validation)).toEqual(findingCodes(lf.validation));
  });

  it("gives the re-encoded file a different identity but the same row keys", async () => {
    const lf = await scan(NAME);
    const crlf = await scan(NAME, { csvText: fixtureText(NAME).replace(/\n/g, "\r\n") });

    // fileHash is over the raw text, so re-encoding defeats the file-level
    // already-imported guard. Pinned deliberately: the row-level dedupe_key is
    // what actually stops the duplicate, and it is unaffected.
    //
    // 32 hex chars, not 64: generateFileHash digests SHA-256 and then truncates
    // with `.slice(0, 32)` (universalParser.js:559), keeping 128 of the 256 bits.
    // Pinned so a change to the digest or the truncation is a visible decision.
    expect(lf.fileHash).toMatch(/^[0-9a-f]{32}$/);
    expect(crlf.fileHash).not.toBe(lf.fileHash);
    expect(assignDedupeKeys(crlf.rowsToImport).map((/** @type {any} */ r) => r.dedupe_key))
      .toEqual(assignDedupeKeys(lf.rowsToImport).map((/** @type {any} */ r) => r.dedupe_key));
  });
});

describe("HotelKey occupancy — the five branches of the 2026-08-20 fix", () => {
  const NAME = "occupancy-percent-branches.csv";

  it("resolves each row by its own evidence and preserves what the PMS printed", async () => {
    // Routed on "total sold rooms", not on the filename: a neutral name still
    // reaches the occupancy scanner.
    const result = await scan(NAME, { sourceFile: "monthly-summary.csv" });
    expect(result.type).toBe("occupancy");
    expect(result.totalRows).toBe(5);

    expect(result.rowsToImport.map((/** @type {any} */ r) => r.occupancy)).toEqual([
      0.85, // 85 printed, no room counts -> /100. THE 2026-08-20 DEFECT: this used
            //   to fall into the counts branch, find total 0, and record 0%.
      0.72, // 0.72 printed WITH counts saying 0.80 -> left exactly as printed.
            //   Recomputing here would silently overwrite the PMS and hide the
            //   disagreement. This is the assertion that separates the correct
            //   contract from the plausible wrong one.
      1.5,  // 150 printed, nothing to derive from -> stays ABOVE 1 on purpose,
            //   because >100% occupancy is the duplicated-import signal.
      0.8,  // both present -> the two audited integers win over the printed 85.
      0,    // nothing stated at all -> 0, and reported as underivable below.
    ]);
    // Row 2 is the discriminator, stated as a relationship so the intent survives.
    const row2 = result.rowsToImport[1];
    expect(row2.occupancy).not.toBe(Number(row2.rooms_sold) / Number(row2.total_rooms));
  });

  it("reports the underivable row and refuses the file for the above-1 value", async () => {
    const result = await scan(NAME);

    expect(findingCodes(result.validation)).toEqual([
      "occupancy_underivable:warning", // 1 of 5 rows, so a warning, not a block
      "out_of_range:error",            // occupancy 1.5 exceeds the 0-1 ratio range
    ]);
    expect(result.validation.findings.find((/** @type {any} */ f) => f.code === "occupancy_underivable"))
      .toMatchObject({ layer: "structural", count: 1, rows: 5 });
    expect(result.validation.findings.find((/** @type {any} */ f) => f.code === "out_of_range").message)
      .toContain("appears to store occupancy as a percentage");
    expect(result.validation.firstFailingLayer).toBe("constraint");
    expect(result.validation.ok).toBe(false);
  });

  it("returns the flat-table shape, which carries no trailer checksum", async () => {
    const result = await scan(NAME);

    // Pinned because the two shapes are easy to conflate while splitting this
    // module: the flat path has no `checksum`, no `errors` and no `fileHash`.
    expect(result.sections).toEqual([
      { name: "Occupancy Summary", rows: 5, preview: result.rowsToImport },
    ]);
    expect(result.checksum).toBeUndefined();
    expect(result.errors).toBeUndefined();
    expect(result.fileHash).toBeUndefined();
    expect(result.debug.dateParseErrors).toBeUndefined();
  });
});
