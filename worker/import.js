// ===========================================================================
// worker/import.js — atomic, resumable, idempotent chunked transaction import.
//
// One request = ONE chunk. A chunk is written as ONE atomic D1 batch that
// commits the data rows AND advances import_progress together, so a retried
// chunk is a no-op and the client can resume from the returned cursor.
//
// D1 LIMITS RESPECTED (batch() does NOT pool these). Per invocation, worst case
// for a full chunk is:
//     1 import_progress read (cursor-sequence gate — see F5 fix)
//   + 1 property-resolution read (canonical `property_code` lookup, batched —
//     see F2 fix; skipped entirely when no row carries a usable code)
//   + 1 existing-dedupe-key read (to count rows ACTUALLY inserted — see F3 fix)
//   + MAX_ROWS_PER_CHUNK single-row INSERTs
//   + 1 progress upsert
//   = 3 + 40 + 1 = 44 queries < 50 (free plan). N+1-per-row lookups are GONE:
//     property resolution is ONE batched query regardless of row count.
//   * 100 bound params / statement — a transaction_line INSERT binds 29 params;
//     the resolution read binds ONE param per distinct code, so <= MAX (40)
//     params; both well under 100.
//   * 100 KB / statement, 2 MB / row — single-row inserts stay tiny.
//
// CURSOR SEQUENCE is enforced, not assumed. A chunk is accepted only at cursor
// `last_committed + 1` (or 0 for a brand-new import). An already-committed
// cursor is a true no-op 200 (zero writes); a GAP is a loud 409 naming the
// expected cursor. That is what keeps `rows_committed` exact: out-of-order
// arrivals can no longer write rows whose inserts are never counted.
//
// IDEMPOTENCY is PER-ROW via the UNIQUE `dedupe_key` (INSERT … ON CONFLICT
// DO NOTHING). The key is computed with the SERVER property id over
//   property_id | date | time | folio | code | amount | occurrence
// and it is built from the NORMALIZED values that are actually written, with
// every component LENGTH-PREFIXED (`<len>:<text>`). Both properties are load
// bearing, because `ON CONFLICT DO NOTHING` turns any key collision into a
// SILENTLY DROPPED posting:
//   * length prefixes make the encoding injective. A plain `join("|")` let a `|`
//     inside a component move a component BOUNDARY, so folio "A|B" + code "C"
//     and folio "A" + code "B|C" produced the same key and the second real
//     posting vanished.
//   * building from the normalized values keeps the key in agreement with the
//     row it identifies. Keying `row.amount ?? 0` while storing the normalized
//     amount made an EMPTY amount key as "0" and collide with a real $0.00
//     posting.
// This DELIBERATELY DIVERGES from src/lib/transactionNorm.js, whose key is still
// the forgeable `join("|")` form; mirroring it would mean keeping the defect. The
// Phase-2 client repoint must move the client onto THIS format.
// `occurrence` is assigned by the client over a deterministic GLOBAL file order
// and carried on each row — NOT re-derived per chunk (per-chunk occurrence
// would collide byte-identical rows that straddle a chunk boundary and silently
// drop a legitimate multi-night posting).
//
// MONEY IS NOT RE-PARSED HERE. The client already parses it (src/lib/csvParser.js
// parseAmount over amount/quantity/adults), so a legitimate row carries only an
// absent/null cell or a finite Number. Anything else means the client pipeline was
// bypassed; this handler REFUSES it with 422 rather than coercing, because every
// coercion the old code performed was a money defect ("5,000.00" -> NULL silently
// vanished $5,000; true -> 1 invented a dollar; "  " -> 0 invented a posting).
//
// PROPERTY RESOLUTION IS BY CANONICAL `property_code` ONLY, AGAINST THE
// ACCOUNT-SCOPED `property` ROSTER — the authoritative table the app itself
// writes when a property is created (UNIQUE(account_id, code) makes the code an
// exact single-row key). `property_id_map` is Phase-2 migration bookkeeping and
// is NOT consulted here; resolving through it made an entity-created property
// unimportable, because no production code ever writes that table. A row with no
// usable code, or with a code the account's roster does not carry, is REJECTED
// LOUDLY (422, naming the row) — never dropped, never written as a dangling FK,
// and never attributed by a browser-local numeric id. Import is scope-enforced:
// every row's server property id must be in the caller's resolved scope.
//
// Money stays REAL end-to-end; NOTHING here SQL-SUMs a fractional-dollar column.
//
// No import from src/ — Cloudflare Workers runtime.
// ===========================================================================

import { queryAll, queryFirst, statement, batch } from "./db.js";
import { assertPropertyInScope, ScopeError } from "./scope.js";

/**
 * @typedef {import("./index.js").Env} Env
 * @typedef {import("./scope.js").Scope} Scope
 */

/**
 * Max data rows per chunk. Budget: 3 batched reads + 40 single-row INSERTs +
 * 1 progress upsert = 44 queries/invocation, comfortably < 50 (free plan).
 *
 * THE BINDING LIMIT IS THE 50-QUERIES-PER-INVOCATION CEILING, NOT THE 100-PARAM
 * ONE. Resolution binds ONE param per distinct `property_code`, so the
 * resolution read binds <= MAX (40) params — it bound <= 2*MAX (80) while
 * browser-local numeric ids were a second key space. Freeing those params does
 * NOT license a larger chunk: 40 is deliberate headroom under 50, because it is
 * NOT certain how D1 counts the worker/db.js wrappers or the implicit
 * transaction around batch(). 45 rows would arithmetically fit (49) with ZERO
 * margin and is a known-bad prior value.
 *
 * Enforced in BOTH the envelope validator (parseChunk) and importChunk itself,
 * because importChunk is a public export that callers reach without going
 * through parseChunk.
 */
export const MAX_ROWS_PER_CHUNK = 40;

/** Ordered column list for a transaction_line INSERT (29 columns => 29 params). */
const TXN_COLUMNS = [
  "id", "property_id", "date", "time", "username", "transaction_code",
  "transaction_type", "charge_category", "sub_charge_type", "outlet_name",
  "ledger_side", "payment_method", "account_class", "employee_label",
  "folio_number", "confirmation_number", "room_number", "guest_name",
  "guest_first_name", "guest_last_name", "card_last4", "amount", "quantity",
  "adults", "remarks", "import_id", "file_hash", "dedupe_key", "created_date",
];

/**
 * Compute an injective key from the normalized values that are actually stored.
 * @param {{serverPropertyId:string,date:string|null,time:string|null,folio_number:string|null,transaction_code:string|null,amount:number|null,occurrence:number}} components
 * @returns {string}
 */
export function transactionDedupeKey(components) {
  if (!components || typeof components !== "object" || Array.isArray(components)) {
    throw new TypeError("dedupe components are required");
  }
  const { serverPropertyId, date, time, folio_number, transaction_code, amount, occurrence } = components;
  if (typeof serverPropertyId !== "string" || serverPropertyId.length === 0) {
    throw new TypeError("serverPropertyId is required");
  }
  if (!Number.isInteger(occurrence) || occurrence < 0) throw new TypeError("occurrence is invalid");
  if (amount !== null && (typeof amount !== "number" || !Number.isFinite(amount))) {
    throw new TypeError("amount must already be normalized");
  }
  const encode = (value) => {
    if (value === null) return "n:0:";
    if (typeof value === "number") {
      const text = String(value);
      return `d:${text.length}:${text}`;
    }
    const text = String(value);
    return `s:${text.length}:${text}`;
  };
  return [serverPropertyId, date, time, folio_number, transaction_code, amount, occurrence]
    .map(encode)
    .join("|");
}

/**
 * A batched property resolver. Built ONCE per chunk from a single D1 read, then
 * consulted per row with zero further queries (kills the previous N+1). ONE key
 * space: the canonical `property_code`.
 * @typedef {Object} PropertyResolver
 * @property {Map<string, string>} codeToServer
 */

/**
 * Build the property resolver for a chunk with AT MOST ONE batched D1 read.
 * Collects every distinct non-empty string `property_code` referenced by the
 * rows and looks them all up together via `code IN (…)`.
 *
 * When NO row carries a usable code the map is returned having issued ZERO
 * queries. That is a correctness-adjacent budget property, not an optimisation:
 * such a chunk is already doomed (every row 422s on missing_code), so spending a
 * D1 query on it would be spending the invocation's query budget on nothing.
 * @param {Env} env
 * @param {string} accountId
 * @param {Record<string, unknown>[]} rows
 * @returns {Promise<PropertyResolver>}
 */
async function buildPropertyResolver(env, accountId, rows) {
  /** @type {Set<string>} */
  const codes = new Set();
  for (const row of rows) {
    const code = row.property_code;
    // Same predicate resolveServerPropertyId uses for `hasCode`: the resolver
    // must never BIND a value the resolution step would refuse, nor omit one it
    // would look up.
    if (typeof code === "string" && code !== "") codes.add(code);
  }

  /** @type {Map<string, string>} */
  const codeToServer = new Map();
  if (codes.size === 0) return { codeToServer };

  const codeArr = [...codes];
  const hits = await queryAll(
    env,
    `SELECT code, id AS server_id FROM property WHERE account_id = ? AND code IN (${codeArr.map(() => "?").join(", ")})`,
    [accountId, ...codeArr],
  );
  for (const h of hits) {
    const r = /** @type {{ code: unknown, server_id: unknown }} */ (h);
    if (r.code != null) codeToServer.set(String(r.code), String(r.server_id));
  }
  return { codeToServer };
}

/**
 * The outcome of resolving ONE row's property reference.
 *   resolved     — the canonical `property_code` is on the account's `property`
 *                  roster.
 *   missing_code — the row never named a canonical property: `property_code` is
 *                  absent, `null`, `""`, or NOT a string (a JSON *number* like
 *                  `8`, a boolean, an array, an object).
 *   unresolved   — the row DID name one (a non-empty string) but the account's
 *                  `property` roster does not carry that code.
 * The two rejection shapes stay SEPARATE because they demand different operator
 * action: re-export from the canonical browser vs. create the property.
 * @typedef {{ kind: "resolved", serverId: string }
 *         | { kind: "missing_code" }
 *         | { kind: "unresolved" }} PropertyResolution
 */

/**
 * Resolve one row's property reference to a SERVER property id using the
 * pre-built resolver (no query). CODE-ONLY: `row.property_local_id` is not read
 * here, is never bound as a SQL param, and is never a rejection cause.
 *
 * WHY THE BROWSER-LOCAL ID IS NOT A RESOLUTION KEY. Only `Property.code` is
 * cross-browser-stable in this project. A `property_local_id` is Dexie
 * autoincrement output: stable only inside ONE browser profile, so it may be
 * stale or come from a DIFFERENT browser's numbering. Resolving by it attributes
 * money to whichever property happens to hold that number on the SERVER, with no
 * error at all — the wrong hotel, silently. That is why the owner removed it as
 * a resolution key and made `property_code` required.
 *
 * WHY DROPPING THE CONTRADICTION DETECTOR IS SAFE — BY SHIPPED PRECEDENT, not by
 * "a local-id-only row is structurally impossible" (that argument only covers the
 * batch-misattribution case). This project ALREADY makes the identical trade:
 * `row.property_id` — which, per src/api/localDb.js:142, is the property field a
 * real client actually carries — is OVERWRITTEN with the server id at the
 * `property_id: serverPid` assignment in importChunk and is never read as a
 * reference. A client-supplied property reference the server does not resolve by
 * is simply ignored. `property_local_id` now joins that category. There is no
 * second resolution left to disagree with, so there is nothing to arbitrate.
 *
 * REJECTING A PRESENT `property_local_id` WAS CONSIDERED AND REFUSED. A naive
 * client that always emits the field alongside a valid code would then have 100%
 * of its legitimate traffic rejected, and with resolution code-only no
 * wrong-data case is constructible from the field's mere presence.
 *
 * PHASE 2 NOTE: nothing in the runtime validates `property_id_map.local_numeric_id`
 * any more. Phase 2 must add an explicit `(local_numeric_id, code, server_id)`
 * consistency gate before that column is trusted as a key again.
 * @param {PropertyResolver} resolver
 * @param {Record<string, unknown>} row
 * @returns {PropertyResolution}
 */
function resolveServerPropertyId(resolver, row) {
  const code = row.property_code;
  // ONE definition of "the row named a canonical property". `""`, `null`,
  // `undefined` and every non-string shape are ABSENT, not unknown.
  const hasCode = typeof code === "string" && code !== "";
  if (!hasCode) return { kind: "missing_code" };
  const serverId = resolver.codeToServer.get(/** @type {string} */ (code));
  if (serverId !== undefined) return { kind: "resolved", serverId };
  return { kind: "unresolved" };
}

/**
 * @typedef {Object} ChunkRequest
 * @property {string} import_id
 * @property {number} cursor
 * @property {Record<string, unknown>[]} rows
 */

/**
 * @typedef {{ ok: true, value: ChunkRequest } | { ok: false, error: string }} ParseResult
 */

/**
 * Validate the chunk envelope. Rejects (loudly) anything malformed.
 * @param {unknown} body
 * @returns {ParseResult}
 */
export function parseChunk(body) {
  if (!body || typeof body !== "object") return { ok: false, error: "body must be an object" };
  const b = /** @type {Record<string, unknown>} */ (body);
  if (typeof b.import_id !== "string" || !b.import_id) {
    return { ok: false, error: "import_id is required" };
  }
  if (typeof b.cursor !== "number" || !Number.isInteger(b.cursor) || b.cursor < 0) {
    return { ok: false, error: "cursor must be a non-negative integer" };
  }
  if (!Array.isArray(b.rows)) return { ok: false, error: "rows must be an array" };
  if (b.rows.length > MAX_ROWS_PER_CHUNK) {
    return { ok: false, error: `chunk exceeds MAX_ROWS_PER_CHUNK (${MAX_ROWS_PER_CHUNK})` };
  }
  return {
    ok: true,
    value: {
      import_id: b.import_id,
      cursor: b.cursor,
      rows: /** @type {Record<string, unknown>[]} */ (b.rows),
    },
  };
}

/** Text columns copied verbatim (null when absent). */
const TEXT_FIELDS = [
  "date", "time", "username", "transaction_code", "transaction_type",
  "charge_category", "sub_charge_type", "outlet_name", "ledger_side",
  "payment_method", "account_class", "employee_label", "folio_number",
  "confirmation_number", "room_number", "guest_name", "guest_first_name",
  "guest_last_name", "card_last4", "remarks", "file_hash",
];

/** Numeric (REAL) columns; kept as real JS Numbers, never cents-rescaled. */
const NUMERIC_FIELDS = ["amount", "quantity", "adults"];

/**
 * @param {unknown} v
 * @returns {string | null}
 */
function asText(v) {
  return v == null ? null : String(v);
}

/**
 * @param {unknown} v
 * @returns {number | null}
 */
function asNumber(v) {
  return v == null ? null : /** @type {number} */ (v);
}

/**
 * @typedef {{ status: number, body: Record<string, unknown> }} HandlerResponse
 */

/**
 * Count how many of `keys` are NOT already committed in transaction_line — i.e.
 * how many rows this chunk will ACTUALLY insert once ON CONFLICT DO NOTHING
 * collapses the duplicates. Distinct keys only (intra-chunk dupes insert once).
 * ONE batched read (params chunked at 90 to stay < 100/statement). Used so the
 * progress counter reflects real inserts, not the submitted count (F3).
 *
 * GUARANTEE, stated honestly: this is a pre-read OUTSIDE the atomic batch, so it
 * is EXACT for a sequential single-writer import (the only shape the cursor gate
 * in importChunk admits for one import_id) and an UPPER BOUND when two imports
 * with DIFFERENT import_ids carry overlapping dedupe keys concurrently — both
 * can see the same key as new and each count it. The DATA stays correct
 * regardless: `transaction_line.dedupe_key` is UNIQUE, so only one row lands.
 * Only `rows_committed` can over-report in that concurrent-import case.
 * @param {Env} env
 * @param {string[]} keys
 * @returns {Promise<number>}
 */
async function countNewKeys(env, keys) {
  const distinct = [...new Set(keys)];
  if (distinct.length === 0) return 0;
  /** @type {Set<string>} */
  const existing = new Set();
  for (let i = 0; i < distinct.length; i += 90) {
    const slice = distinct.slice(i, i + 90);
    const rows = await queryAll(
      env,
      `SELECT dedupe_key FROM transaction_line WHERE dedupe_key IN (${slice.map(() => "?").join(", ")})`,
      slice,
    );
    for (const r of rows) {
      existing.add(String(/** @type {{ dedupe_key: unknown }} */ (r).dedupe_key));
    }
  }
  return distinct.filter((k) => !existing.has(k)).length;
}

/**
 * Process ONE chunk: enforce the size cap and the cursor sequence, resolve +
 * scope-check every row, then commit the rows and the progress marker in a
 * single atomic batch. Returns a typed response.
 * @param {Env} env
 * @param {Scope} scope
 * @param {ChunkRequest} chunk
 * @param {boolean} [final]
 * @returns {Promise<HandlerResponse>}
 */
export async function importChunk(env, scope, chunk, final = false) {
  // Size cap enforced HERE, not only in parseChunk: this function is exported and
  // reachable without the envelope validator, and an oversized chunk would blow
  // the D1 per-invocation ceilings (rows+4 statements; the resolution read binds
  // ONE param per distinct `property_code`, so <= rows params).
  if (chunk.rows.length > MAX_ROWS_PER_CHUNK) {
    return {
      status: 400,
      body: {
        error:
          `chunk exceeds MAX_ROWS_PER_CHUNK (${MAX_ROWS_PER_CHUNK}): ` +
          `received ${chunk.rows.length} rows`,
      },
    };
  }

  // CURSOR SEQUENCE GATE — one read, before anything is built or written.
  // rows_committed can only stay exact if chunks commit in order, because the
  // count of rows a chunk inserts is decided per chunk. So: reject gaps loudly,
  // treat an already-committed cursor as a zero-write no-op, and let only
  // `last + 1` (or 0 for a new import) through to the batch.
  const progressRow = await queryFirst(
    env,
    "SELECT chunk_cursor, status FROM import_progress WHERE account_id = ? AND import_id = ?",
    [scope.accountId, chunk.import_id],
  );
  if (!progressRow) {
    if (chunk.cursor !== 0) {
      return {
        status: 409,
        body: {
          error: `unknown import ${chunk.import_id}: a new import must start at cursor 0, got ${chunk.cursor}`,
          import_id: chunk.import_id,
          expected_cursor: 0,
        },
      };
    }
  } else {
    const p = /** @type {{ chunk_cursor: unknown, status: unknown }} */ (progressRow);
    const committedCursor = Number(p.chunk_cursor);
    if (chunk.cursor <= committedCursor) {
      // Already committed. Rows and progress commit in ONE batch, so if this
      // cursor is recorded, its rows are durable — this is an idempotent retry.
      // Answer with the normal 200 shape (rows_inserted: 0) and write NOTHING;
      // next_cursor points at where the client should actually resume.
      return {
        status: 200,
        body: {
          import_id: chunk.import_id,
          cursor: chunk.cursor,
          next_cursor: committedCursor + 1,
          rows_received: chunk.rows.length,
          rows_inserted: 0,
          status: String(p.status ?? (final ? "completed" : "in_progress")),
        },
      };
    }
    if (chunk.cursor > committedCursor + 1) {
      return {
        status: 409,
        body: {
          error:
            `chunk ${chunk.import_id}#${chunk.cursor} is out of sequence: ` +
            `expected cursor ${committedCursor + 1} (last committed ${committedCursor})`,
          import_id: chunk.import_id,
          expected_cursor: committedCursor + 1,
        },
      };
    }
  }

  const placeholders = TXN_COLUMNS.map(() => "?").join(", ");
  const insertSql =
    `INSERT INTO transaction_line (${TXN_COLUMNS.join(", ")}) ` +
    `VALUES (${placeholders}) ON CONFLICT(dedupe_key) DO NOTHING`;

  // ONE batched read resolves EVERY row's property — no per-row N+1 (F2).
  const resolver = await buildPropertyResolver(env, scope.accountId, chunk.rows);

  /** @type {{ params: unknown[], dedupeKey: string }[]} */
  const prepared = [];
  for (let i = 0; i < chunk.rows.length; i++) {
    const row = chunk.rows[i];
    const label = `chunk ${chunk.import_id}#${chunk.cursor} row ${i}`;

    // Occurrence must arrive from the client's deterministic global ordering.
    const occurrence = row.occurrence;
    if (typeof occurrence !== "number" || !Number.isInteger(occurrence) || occurrence < 0) {
      return {
        status: 400,
        body: { error: `${label}: missing/invalid occurrence (client must assign globally)` },
      };
    }

    for (const field of NUMERIC_FIELDS) {
      const value = row[field];
      if (value !== undefined && value !== null && (typeof value !== "number" || !Number.isFinite(value))) {
        return {
          status: 422,
          body: {
            error: `${label}: ${field} must be a finite number or absent`,
            field,
          },
        };
      }
    }

    // Resolve to a SERVER property id or REJECT LOUDLY (never a dangling FK).
    // TWO DISTINCT loud cases, both whole-chunk-atomic (we return before any
    // write). They are deliberately SEPARATE branches with separate wording,
    // because they demand different operator action: re-export from the
    // canonical browser vs. create/seed the property. Folding them into one
    // generic message would make the distinction decoration.
    const resolution = resolveServerPropertyId(resolver, row);
    if (resolution.kind === "missing_code") {
      return {
        status: 422,
        body: {
          error:
            `${label}: property_code is required ` +
            `(canonical property code; browser-local ids are not accepted)`,
          property_code: asText(row.property_code),
          // DIAGNOSTICS ONLY, never resolution input: echoing the local id shows
          // an operator that a stale client sent a browser-local id and no
          // canonical code, which is the single most useful clue for fixing the
          // export. It is not read anywhere in the resolution path.
          property_local_id: asText(row.property_local_id),
        },
      };
    }
    if (resolution.kind !== "resolved") {
      // `unresolved`: the row DID name a canonical property; the server does not
      // know it. No `property_local_id` echo here — the local id is irrelevant to
      // why this row failed, and echoing it invites an operator to "fix" the
      // import by trusting it.
      return {
        status: 422,
        body: {
          error: `${label}: property did not resolve`,
          property_code: asText(row.property_code),
        },
      };
    }
    const serverPid = resolution.serverId;

    // Import is scope-enforced: the row's property must be in caller scope.
    try {
      assertPropertyInScope(scope, serverPid);
    } catch (err) {
      if (err instanceof ScopeError) {
        return { status: 403, body: { error: `${label}: ${err.message}` } };
      }
      throw err;
    }

    /** @type {Record<string, unknown>} */
    const values = {
      id: crypto.randomUUID(),
      property_id: serverPid,
      import_id: chunk.import_id,
      created_date: new Date().toISOString(),
    };
    for (const f of TEXT_FIELDS) values[f] = asText(row[f]);
    for (const f of NUMERIC_FIELDS) values[f] = asNumber(row[f]);

    const dedupeKey = transactionDedupeKey({
      serverPropertyId: serverPid,
      date: /** @type {string|null} */ (values.date),
      time: /** @type {string|null} */ (values.time),
      folio_number: /** @type {string|null} */ (values.folio_number),
      transaction_code: /** @type {string|null} */ (values.transaction_code),
      amount: /** @type {number|null} */ (values.amount),
      occurrence,
    });
    values.dedupe_key = dedupeKey;

    prepared.push({ params: TXN_COLUMNS.map((c) => values[c] ?? null), dedupeKey });
  }

  // How many rows will ACTUALLY be inserted (ON CONFLICT collapses the rest).
  const insertedCount = await countNewKeys(env, prepared.map((p) => p.dedupeKey));
  const rowStatements = prepared.map((p) => statement(env, insertSql, p.params));

  // Progress upsert. Only cursor `last + 1` reaches here (the gate above turned
  // retries into no-ops and gaps into 409s), so rows_committed advances by the
  // count ACTUALLY inserted and duplicates collapsed by ON CONFLICT don't
  // inflate it (F3). The MAX()/CASE guards are kept as defence-in-depth for the
  // read-then-write race the gate cannot cover: two concurrent requests carrying
  // the SAME cursor both pass the read, but only the first may advance the
  // counter — the second's rows collapse on the UNIQUE dedupe_key.
  const status = final ? "completed" : "in_progress";
  const now = new Date().toISOString();
  const progressSql =
    "INSERT INTO import_progress " +
    "(account_id, import_id, property_id, chunk_cursor, rows_committed, status, created_date, updated_date) " +
    "VALUES (?, ?, NULL, ?, ?, ?, ?, ?) " +
    "ON CONFLICT(account_id, import_id) DO UPDATE SET " +
    "chunk_cursor = MAX(import_progress.chunk_cursor, excluded.chunk_cursor), " +
    "rows_committed = CASE WHEN excluded.chunk_cursor > import_progress.chunk_cursor " +
    "THEN import_progress.rows_committed + excluded.rows_committed " +
    "ELSE import_progress.rows_committed END, " +
    "status = excluded.status, updated_date = excluded.updated_date";
  const progressStmt = statement(env, progressSql, [
    scope.accountId,
    chunk.import_id,
    chunk.cursor,
    insertedCount,
    status,
    now,
    now,
  ]);

  // ONE atomic transaction: data rows AND the progress marker commit together.
  await batch(env, [...rowStatements, progressStmt]);

  return {
    status: 200,
    body: {
      import_id: chunk.import_id,
      cursor: chunk.cursor,
      next_cursor: chunk.cursor + 1,
      rows_received: chunk.rows.length,
      rows_inserted: insertedCount,
      status,
    },
  };
}
