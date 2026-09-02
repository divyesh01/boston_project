import { assertPropertyInScope, ScopeError, scopeConstraint } from "./scope.js";
import { queryAll, queryFirst } from "./db.js";

const JSON_FIELDS = new Set(["columns", "raw_rows", "payload"]);
const BOOLEAN_FIELDS = new Set(["active", "recurring", "taxable"]);
const MAX_QUERY_LIMIT = 5000;
const MAX_BULK_ROWS = 40;

const define = (table, columns, options = {}) => Object.freeze({
  table,
  columns: Object.freeze(columns.split(",")),
  scopeColumn: options.scopeColumn || "property_id",
  roster: !!options.roster,
  // The human-meaningful key a caller names a record by. Declared ONLY on roster
  // contracts, because the conflict pre-check that uses it scopes by `account_id`
  // and only roster tables carry that column.
  businessKey: options.businessKey || null,
});

// SQL identifiers never come from the request. This registry is the complete
// public D1 entity surface and is intentionally explicit.
export const ENTITY_CONTRACT = Object.freeze({
  Property: define("property", "id,code,name,rooms,address,city,state,phone,active,created_date", { roster: true, scopeColumn: "id", businessKey: "code" }),
  TransactionLine: define("transaction_line", "id,property_id,date,time,username,transaction_code,transaction_type,charge_category,sub_charge_type,outlet_name,ledger_side,payment_method,account_class,employee_label,folio_number,confirmation_number,room_number,guest_name,guest_first_name,guest_last_name,card_last4,amount,quantity,adults,remarks,import_id,file_hash,dedupe_key,created_date"),
  OccupancyDay: define("occupancy_day", "id,property_id,property_name,report_type,import_id,source_file,date,day_of_week,room_revenue,other_room_revenue,total_revenue,total_rooms,rooms_sold,rooms_sold_without_comp,down_rooms,vacant_rooms,clean_rooms,dirty_rooms,stayover_rooms,same_day_bookings,comp_rooms,house_rooms,zero_rate_rooms,day_use_rooms,no_shows,cancellations,total_guests,adr,occupancy,revpar,created_date"),
  SourceDay: define("source_day", "id,property_id,property_name,report_type,import_id,source_file,date,day_of_week,code,source,net_revenue,stays,adr,occupancy_contribution,revpar_contribution,created_date"),
  GrossRevenueDay: define("gross_revenue_day", "id,property_id,property_name,report_type,import_id,source_file,date,day_of_week,room_rent,misc_charge,system_charge,food,event,bar,laundry,phone,other,non_revenue,advance_deposit,beverage,created_date"),
  PaymentDay: define("payment_day", "id,property_id,property_name,report_type,import_id,source_file,date,day_of_week,cash,closed_balance_folio,corpay,direct_bill,loyalty_certificate,loyalty_discount,vip_pass,wire_transfer,amex,discover,master,other,visa,total,created_date"),
  ClerkShiftRecord: define("clerk_shift_record", "id,property_id,property_name,report_type,import_id,source_file,record_type,payment_type,clerk_name,shift_date,actual,adjusted,net_today,amount,transaction_count,created_date"),
  Expense: define("expense", "id,property_id,property_name,expense_name,vendor,category,frequency,amount,expense_date,payment_status,recurring,taxable,notes,import_id,created_date"),
  PayrollRun: define("payroll_run", "id,property_id,property_name,employee_name,department,pay_type,base_rate,hours,regular_pay,overtime_hours,overtime_rate,overtime_pay,bonus,deductions,total_pay,pay_period_start,pay_period_end,payroll_status,payroll_date,created_date"),
  Staff: define("staff", "id,property_id,property_name,employee_id,employee_name,department,role_title,pay_type,base_rate,hours,overtime_hours,overtime_rate,bonus,deductions,hire_date,active,import_id,created_date"),
  TimecardPunch: define("timecard_punch", "id,property_id,property_name,report_type,import_id,source_file,employee_name,employee_id,department,shift_date,clock_in,clock_out,break_minutes,created_date"),
  UploadedReport: define("uploaded_report", "id,property_id,property_name,report_type,import_id,source_file,drive_file_id,drive_backup_status,file_name,rows_imported,rows_skipped,rows_parsed,file_url,columns,raw_rows,created_date"),
  HotelMetric: define("hotel_metric", "id,property_id,business_date,section,metric_name,period,value,import_id,file_hash,created_date"),
  AnomalyAlert: define("anomaly_alert", "id,property_id,date,alert_type,status,amount,detail,dedupe_key,created_date"),
  Room: define("room", "id,property_id,room_number,room_type,floor,capacity,status,created_date"),
  RoomStay: define("room_stay", "id,property_id,date,room_number,room_type,guest_name,check_in,check_out,rate_cents,status,created_date"),
  HousekeepingTask: define("housekeeping_task", "id,property_id,task_date,room_number,room_type,assignee,status,created_date"),
  WeatherSnapshot: define("weather_snapshot", "id,property_id,date,kind,payload,created_date"),
  Review: define("review", "id,property_id,source,rating,sentiment,status,review_date,guest_name,created_date"),
  AdjustmentRefund: define("adjustment_refund", "id,property_id,date,record_type,username,amount,import_id,created_date"),
  DailyFinancialAggregate: define("daily_financial_aggregate", "id,property_id,business_date,total_revenue,room_revenue,other_revenue,payments_total,expenses_total,created_date"),
  ScanResult: define("scan_result", "id,property_id,file_id,scanned_at,health_score,created_date"),
  Reservation: define("reservation", "id,property_id,channel,confirmation_num,check_in,check_out,room_type_id,status,created_date"),
  RoomType: define("room_type", "id,property_id,name,total_inventory"),
  ChannelMap: define("channel_map", "id,property_id,channel_name,local_room_id,remote_room_id"),
});

const errorResponse = (error, status = 400, details = null) =>
  Response.json({ error, ...(details || {}) }, { status });

function contractFor(entityName) {
  const contract = ENTITY_CONTRACT[entityName];
  if (!contract) throw new EntityRequestError("unknown entity", 404);
  return contract;
}

class EntityRequestError extends Error {
  constructor(message, status = 400, details = null) {
    super(message);
    this.status = status;
    // Optional machine-readable body fields merged into the JSON response, so a
    // 409 can carry the colliding value the UI must show.
    this.details = details;
  }
}

// A write rejected by the database is a FACT about the request, not a server
// malfunction, and the constraint KIND determines the class:
//   UNIQUE      -> 409, the row conflicts with a record that already exists;
//   NOT NULL / CHECK / FOREIGN KEY -> 422, the payload itself is unprocessable.
// Matching is on the constraint kind only. The values are deliberately NOT parsed
// out of the driver message: the message text is not a stable contract, and it
// names the constraint's COLUMNS (never the offending values), so parsing it would
// leak schema detail while still not telling the caller anything actionable.
// D1 prefixes the SQLite text with `D1_ERROR:`; node:sqlite does not. Both are
// matched by searching, not anchoring.
const WRITE_ERROR_CLASSES = Object.freeze([
  { pattern: /\b(UNIQUE constraint failed|PRIMARY KEY must be unique)\b/i, status: 409, text: "conflicts with an existing record" },
  { pattern: /\bNOT NULL constraint failed\b/i, status: 422, text: "a required field is missing" },
  { pattern: /\bCHECK constraint failed\b/i, status: 422, text: "a field value is not allowed" },
  { pattern: /\bFOREIGN KEY constraint failed\b/i, status: 422, text: "a referenced record does not exist" },
]);

/** Depth bound for the cause walk below: a cycle must not hang the isolate. */
const WRITE_ERROR_CAUSE_DEPTH = 5;

/**
 * Every message in the failure's cause chain, outermost first.
 *
 * A driver is not obliged to put the SQLite text on the OUTERMOST error. D1 has
 * shipped batch rejections whose own `.message` is only a generic wrapper
 * (`D1_ERROR: ...`) with the real `UNIQUE constraint failed: ...` text on `.cause`.
 * Reading `.message` alone therefore mis-reports a constraint violation as an
 * opaque 500 — the exact defect this module exists to prevent — so the chain is
 * searched, not just its head. Depth-bounded because `cause` can be cyclic.
 */
function errorMessageChain(error) {
  const out = [];
  let current = error;
  for (let depth = 0; current != null && depth < WRITE_ERROR_CAUSE_DEPTH; depth += 1) {
    out.push(String((typeof current === "object" && current.message) || current));
    current = typeof current === "object" ? current.cause : null;
  }
  return out;
}

/**
 * Translate a driver write failure into a truthful client status, or return null
 * when the failure is NOT a constraint violation — those must keep propagating to
 * the router's catch-all, which answers a generic 500 and leaks no SQL.
 *
 * Widening the search to the cause chain cannot mis-class a non-constraint
 * failure: a SQLite constraint message anywhere in the chain means a constraint
 * WAS violated, whatever wrapper the driver put around it.
 */
function classifyWriteError(error) {
  const messages = errorMessageChain(error);
  for (const { pattern, status, text } of WRITE_ERROR_CLASSES) {
    if (messages.some((message) => pattern.test(message))) return new EntityRequestError(text, status);
  }
  return null;
}

function permissions(scope) {
  const raw = scope.user.permissions;
  if (!raw) return {};
  try { return typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return {}; }
}

function mayMutate(scope, contract) {
  const role = String(scope.user.role || "").toLowerCase();
  if (["owner", "admin"].includes(role)) return true;
  const p = permissions(scope);
  if (contract.roster) return role === "gm" && p.manage_properties === true;
  return ["gm", "manager"].includes(role) &&
    (p.import_reports === true || p.manual_entry === true || p.manage_operations === true);
}

function decodeRow(row) {
  if (!row) return row;
  const out = { ...row };
  for (const field of JSON_FIELDS) {
    if (typeof out[field] === "string") {
      try { out[field] = JSON.parse(out[field]); } catch { out[field] = null; }
    }
  }
  for (const field of BOOLEAN_FIELDS) {
    if (field in out && out[field] != null) out[field] = out[field] === 1;
  }
  return out;
}

function encodeValue(field, value) {
  if (value === undefined) return null;
  if (JSON_FIELDS.has(field)) return value == null ? null : JSON.stringify(value);
  if (BOOLEAN_FIELDS.has(field)) return value == null ? null : (value ? 1 : 0);
  return value;
}

function compileFilter(contract, filter = {}) {
  if (!filter || typeof filter !== "object" || Array.isArray(filter)) {
    throw new EntityRequestError("filter must be an object");
  }
  const clauses = [];
  const params = [];
  for (const [field, condition] of Object.entries(filter)) {
    if (!contract.columns.includes(field)) throw new EntityRequestError(`filter field not allowed: ${field}`);
    if (condition && typeof condition === "object" && !Array.isArray(condition)) {
      const entries = Object.entries(condition);
      if (entries.length !== 1) throw new EntityRequestError(`invalid filter for ${field}`);
      const [operator, operand] = entries[0];
      if (operator === "$in") {
        if (!Array.isArray(operand) || operand.length === 0 || operand.length > 50) {
          clauses.push("1 = 0");
        } else {
          clauses.push(`${field} IN (${operand.map(() => "?").join(",")})`);
          params.push(...operand.map((value) => encodeValue(field, value)));
        }
      } else {
        const sqlOperator = ({ $gte: ">=", $gt: ">", $lte: "<=", $lt: "<" })[operator];
        if (!sqlOperator) throw new EntityRequestError(`filter operator not allowed: ${operator}`);
        clauses.push(`${field} ${sqlOperator} ?`);
        params.push(encodeValue(field, operand));
      }
    } else {
      clauses.push(`${field} = ?`);
      params.push(encodeValue(field, condition));
    }
  }
  return { clauses, params };
}

function scopedWhere(contract, scope, filter = {}) {
  const compiled = compileFilter(contract, filter);
  const scoped = scopeConstraint(scope, contract.scopeColumn);
  return {
    sql: [scoped.sql, ...compiled.clauses].filter(Boolean).map((part) => `(${part})`).join(" AND "),
    params: [...scoped.params, ...compiled.params],
  };
}

function normalizedSort(contract, sort) {
  const raw = String(sort || "created_date");
  const desc = raw.startsWith("-");
  const field = raw.replace(/^[+-]/, "");
  const fallback = contract.columns.includes("created_date") ? "created_date" : "id";
  const selected = field && contract.columns.includes(field) ? field : fallback;
  if (field && !contract.columns.includes(field)) throw new EntityRequestError(`sort field not allowed: ${field}`);
  return `${selected} ${desc ? "DESC" : "ASC"}`;
}

function sanitizeData(contract, data, { update = false } = {}) {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new EntityRequestError("data must be an object");
  const out = {};
  for (const [field, value] of Object.entries(data)) {
    if (!contract.columns.includes(field)) throw new EntityRequestError(`field not allowed: ${field}`);
    if (field === "account_id" || (update && (field === "id" || field === contract.scopeColumn))) {
      throw new EntityRequestError("record scope cannot be changed", 403);
    }
    if (field === "id") continue;
    out[field] = encodeValue(field, value);
  }
  return out;
}

async function stableId(scope, entityName, row) {
  if (!row.import_id) return crypto.randomUUID();
  const ordered = Object.keys(row).filter((key) => key !== "id").sort().map((key) => [key, row[key]]);
  const bytes = new TextEncoder().encode(JSON.stringify([scope.accountId, entityName, ordered]));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `imp_${Array.from(digest.slice(0, 16), (value) => value.toString(16).padStart(2, "0")).join("")}`;
}

async function readBody(request) {
  try { return await request.json(); } catch { throw new EntityRequestError("invalid JSON body"); }
}

async function findScoped(env, contract, scope, id) {
  const c = scopeConstraint(scope, contract.scopeColumn);
  return queryFirst(env, `SELECT ${contract.columns.join(",")} FROM ${contract.table} WHERE id = ? AND ${c.sql} LIMIT 1`, [id, ...c.params]);
}

// WRITE CONFIRMATION ONLY — THIS IS NOT AN AUTHORIZATION READ. MUST NOT BE REUSED
// ON ANY READ PATH.
//
// A write is confirmed under the same authority and by the same key the INSERT
// bound, never through the caller's read-authorization predicate. `scope` is
// deliberately NOT a parameter: scopeConstraint() derives its predicate from
// scope.propertyIds, a snapshot materialized in resolveScope() BEFORE the insert,
// so a brand-new roster id can never satisfy it (and an account with zero
// properties yields `1 = 0`). Not accepting `scope` makes that mistake
// unrepresentable here.
//
// `writeKey` is the authority value the INSERT itself bound, supplied by
// createRows: scope.accountId for a roster contract, and for every other contract
// the exact property_id that assertPropertyInScope() approved. The non-roster form
// is therefore STRICTLY NARROWER than the read predicate (one value, not the whole
// snapshot).
//
// Authorization for the row being written is established EARLIER in createRows —
// the `scope.all` gate for a roster contract, assertPropertyInScope() otherwise.
// Calling this helper on a read path (mutateById, bulk-delete, GET-by-id) would
// bypass the caller's scope entirely; those paths keep using findScoped().
async function confirmWritten(env, contract, id, writeKey) {
  const column = contract.roster === true ? "account_id" : contract.scopeColumn;
  return queryFirst(
    env,
    `SELECT ${contract.columns.join(",")} FROM ${contract.table} WHERE id = ? AND ${column} = ? LIMIT 1`,
    [id, writeKey],
  );
}

async function queryEntity(request, env, scope, contract) {
  const body = await readBody(request);
  const filter = body.filter || {};
  const limit = Math.max(1, Math.min(MAX_QUERY_LIMIT, Number(body.limit) || 100));
  const skip = Math.max(0, Number(body.skip) || 0);
  const where = scopedWhere(contract, scope, filter);
  const order = normalizedSort(contract, body.sort);
  const count = await queryFirst(env, `SELECT COUNT(*) AS total FROM ${contract.table} WHERE ${where.sql}`, where.params);
  const rows = await queryAll(env, `SELECT ${contract.columns.join(",")} FROM ${contract.table} WHERE ${where.sql} ORDER BY ${order} LIMIT ? OFFSET ?`, [...where.params, limit, skip]);
  return Response.json({ items: rows.map(decodeRow), total: Number(count?.total || 0), hasMore: skip + rows.length < Number(count?.total || 0), nextCursor: skip + rows.length });
}

/**
 * REPORTING AID FOR ROSTER BUSINESS-KEY CONFLICTS — NOT THE UNIQUENESS BOUNDARY.
 *
 * A caller names a hotel by its `code`, so a rejection is only actionable if it
 * says WHICH code collided. The database cannot supply that: its message names the
 * constraint's columns, never the offending values. So the value has to come from
 * a read, and this is that read — ONE batched statement, and only for roster
 * contracts (the import path adds zero queries).
 *
 * It resolves two cases the caller cannot distinguish otherwise:
 *   - a key already held by a DIFFERENT record in this account, and
 *   - two rows of ONE request claiming the same key, which no pre-existing row
 *     could reveal.
 *
 * A row whose computed id already exists is the SAME record re-submitted; that is
 * the idempotent path and must NOT be reported as a conflict.
 *
 * The uniqueness guarantee remains `UNIQUE (account_id, code)`: this read is not
 * serialized with the write, so a code taken in between is still caught by the
 * index and answered 409 (without a named value) by classifyWriteError.
 */
async function assertNoBusinessKeyConflict(env, contract, scope, prepared) {
  if (!contract.roster || !contract.businessKey) return;
  const field = contract.businessKey;
  const keyed = prepared.filter((item) => item.row[field] != null);
  if (keyed.length === 0) return;

  const claimedBy = new Map();
  const collisions = new Set();
  for (const item of keyed) {
    const value = String(item.row[field]);
    if (!claimedBy.has(value)) claimedBy.set(value, item.id);
    else if (claimedBy.get(value) !== item.id) collisions.add(value);
  }

  const values = [...claimedBy.keys()];
  const existing = await queryAll(
    env,
    `SELECT id, ${field} AS conflict_value FROM ${contract.table} WHERE account_id = ? AND ${field} IN (${values.map(() => "?").join(",")})`,
    [scope.accountId, ...values],
  );
  for (const row of existing) {
    const value = String(row.conflict_value);
    if (claimedBy.get(value) !== row.id) collisions.add(value);
  }

  if (collisions.size > 0) {
    const values2 = [...collisions];
    throw new EntityRequestError(
      `${field} already in use: ${values2.join(", ")}`,
      409,
      { conflict: { entity: contract.table, field, values: values2 } },
    );
  }
}

async function createRows(env, scope, entityName, contract, rows) {
  if (!mayMutate(scope, contract)) throw new EntityRequestError("forbidden", 403);
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > MAX_BULK_ROWS) throw new EntityRequestError(`rows must contain 1-${MAX_BULK_ROWS} records`);
  const prepared = [];
  for (const raw of rows) {
    const data = sanitizeData(contract, raw);
    // `writeKey` is the authority value this INSERT binds, and it is the ONLY key
    // the post-insert confirmation is allowed to use (see confirmWritten).
    let writeKey;
    if (contract.roster) {
      if (!scope.all) throw new EntityRequestError("forbidden", 403);
      data.account_id = scope.accountId;
      writeKey = scope.accountId;
    } else {
      const propertyId = String(data.property_id || "");
      if (!propertyId) throw new EntityRequestError("property_id is required", 422);
      assertPropertyInScope(scope, propertyId);
      writeKey = propertyId;
    }
    // The id is ALWAYS server-derived. A client-supplied id let a caller name a row
    // that already exists: INSERT OR IGNORE skipped the write and the confirmation
    // then found that pre-existing row, answering 201 with someone else's record
    // while the requested row was never written.
    const id = String(await stableId(scope, entityName, data));
    const createdDate = /** @type {Record<string, unknown>} */ (data).created_date || new Date().toISOString();
    /** @type {Record<string, unknown>} */
    const row = { ...data, id };
    if (contract.columns.includes("created_date")) row.created_date = createdDate;
    const columns = ["id", ...(contract.roster ? ["account_id"] : []), ...Object.keys(row).filter((field) => field !== "id" && field !== "account_id")];
    // ON CONFLICT(id) DO NOTHING suppresses EXACTLY ONE conflict: a re-submission
    // of the same server-derived id, which stableId() makes deterministic for an
    // import row and which is therefore genuinely idempotent. `id` is the PRIMARY
    // KEY of every entity table, so it is a valid conflict target.
    //
    // It must NEVER be widened back to `INSERT OR IGNORE`. OR IGNORE suppresses
    // every constraint — a duplicate business key, a missing NOT NULL column, a
    // dangling foreign key — as `changes: 0` with no error, which destroys the only
    // authoritative signal about what happened. The outcome then has to be guessed
    // from a post-hoc read, which cannot tell an idempotent re-submission from a
    // lost write, and every cause collapsed into one misleading 500.
    const statement = env.DB.prepare(`INSERT INTO ${contract.table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")}) ON CONFLICT(id) DO NOTHING`).bind(...columns.map((field) => field === "account_id" ? scope.accountId : row[field]));
    prepared.push({ id, writeKey, row, statement });
  }
  // Runs BEFORE the batch so a named conflict costs no write at all.
  await assertNoBusinessKeyConflict(env, contract, scope, prepared);
  try {
    // One atomic transaction: a constraint violation anywhere rolls the whole
    // request back, so a rejected bulk create leaves no partially committed rows.
    await env.DB.batch(prepared.map((item) => item.statement));
  } catch (error) {
    const classified = classifyWriteError(error);
    if (classified) throw classified;
    throw error;
  }
  const created = [];
  for (const item of prepared) {
    const row = await confirmWritten(env, contract, item.id, item.writeKey);
    if (!row) throw new EntityRequestError("created row was not readable", 500);
    created.push(decodeRow(row));
  }
  return created;
}

async function mutateById(request, env, scope, contract, id, method) {
  if (!mayMutate(scope, contract)) throw new EntityRequestError("forbidden", 403);
  const current = await findScoped(env, contract, scope, id);
  if (!current) throw new EntityRequestError("not found", 404);
  if (method === "DELETE") {
    const c = scopeConstraint(scope, contract.scopeColumn);
    await env.DB.prepare(`DELETE FROM ${contract.table} WHERE id = ? AND ${c.sql}`).bind(id, ...c.params).run();
    return Response.json({ success: true });
  }
  const body = await readBody(request);
  const data = sanitizeData(contract, body.data || body, { update: true });
  const entries = Object.entries(data);
  if (entries.length === 0) return Response.json(decodeRow(current));
  const c = scopeConstraint(scope, contract.scopeColumn);
  await env.DB.prepare(`UPDATE ${contract.table} SET ${entries.map(([field]) => `${field} = ?`).join(",")} WHERE id = ? AND ${c.sql}`)
    .bind(...entries.map(([, value]) => value), id, ...c.params).run();
  return Response.json(decodeRow(await findScoped(env, contract, scope, id)));
}

export async function handleEntityRequest(request, env, scope, pathParts) {
  try {
    const entityName = decodeURIComponent(pathParts[2] || "");
    const contract = contractFor(entityName);
    const action = pathParts[3] || "";
    if (action === "query" && request.method === "POST") return queryEntity(request, env, scope, contract);
    if (action === "count" && request.method === "POST") {
      const body = await readBody(request);
      const where = scopedWhere(contract, scope, body.filter || {});
      const row = await queryFirst(env, `SELECT COUNT(*) AS count FROM ${contract.table} WHERE ${where.sql}`, where.params);
      return Response.json({ count: Number(row?.count || 0) });
    }
    if (action === "bulk-create" && request.method === "POST") {
      const body = await readBody(request);
      return Response.json({ items: await createRows(env, scope, entityName, contract, body.rows) }, { status: 201 });
    }
    if (action === "bulk-delete" && request.method === "POST") {
      if (!mayMutate(scope, contract)) throw new EntityRequestError("forbidden", 403);
      const body = await readBody(request);
      const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
      if (ids.length === 0 || ids.length > MAX_BULK_ROWS) throw new EntityRequestError(`ids must contain 1-${MAX_BULK_ROWS} values`);
      const rows = [];
      for (const id of ids) {
        const row = await findScoped(env, contract, scope, id);
        if (!row) throw new EntityRequestError("not found", 404);
        rows.push(row);
      }
      await env.DB.batch(rows.map((row) => env.DB.prepare(`DELETE FROM ${contract.table} WHERE id = ?`).bind(row.id)));
      return Response.json({ success: true, deleted: rows.length });
    }
    if (!action && request.method === "POST") {
      const body = await readBody(request);
      const items = await createRows(env, scope, entityName, contract, [body.data || body]);
      return Response.json(items[0], { status: 201 });
    }
    if (!action && request.method === "DELETE") {
      if (!scope.all || !["owner", "admin"].includes(String(scope.user.role || "").toLowerCase())) throw new EntityRequestError("forbidden", 403);
      const c = scopeConstraint(scope, contract.scopeColumn);
      await env.DB.prepare(`DELETE FROM ${contract.table} WHERE ${c.sql}`).bind(...c.params).run();
      return Response.json({ success: true });
    }
    if (action && request.method === "GET") {
      const row = await findScoped(env, contract, scope, decodeURIComponent(action));
      return row ? Response.json(decodeRow(row)) : errorResponse("not found", 404);
    }
    if (action && ["PATCH", "DELETE"].includes(request.method)) return mutateById(request, env, scope, contract, decodeURIComponent(action), request.method);
    return errorResponse("method not allowed", 405);
  } catch (error) {
    if (error instanceof ScopeError) return errorResponse("forbidden", 403);
    if (error instanceof EntityRequestError) return errorResponse(error.message, error.status, error.details);
    throw error;
  }
}
