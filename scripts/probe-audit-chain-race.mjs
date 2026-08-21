// Probe for "concurrent audit writers corrupt the chain" (known problem #15).
//
// THE CLAIM IN THE TRACKER WAS WRONG IN TWO WAYS, and both were measured here
// before anything was changed:
//
//   Tracker said:  concurrent writes produce a "chain break", severity LOW.
//   Measured:      concurrent writes produced { reason: "hash_mismatch" } — the
//                  single most alarming verdict this system can return, meaning
//                  "an audit row was rewritten" — about rows nobody touched.
//                  Three simultaneous logins were enough. Severity was not LOW.
//
//   Tracker said:  created_date monotonicity protects the ordering.
//   Measured:      all three racers received the IDENTICAL created_date, because
//                  monotonicIso() can only step past a row it has already READ,
//                  and all three read the same tail.
//
// ROOT CAUSE (fixed in base44/functions/audit_verify/entry.js): the verifier
// walked rows in created_date order and recomputed each row's hash over THE
// PREVIOUS ROW'S hash rather than over the row's OWN stored previous_hash. That
// conflates "are this row's contents authentic" with "did the rows come back in
// the order they were linked". A hash chain only asserts the former.
//
// The chain is a hash-linked DAG. This probe holds the verifier to DAG semantics:
// a fork is concurrency (valid, warned), a rewritten row is tampering, a deleted
// row is a break, and a detached sub-chain is unreachable. It runs the REAL
// function entry files against an in-memory backend (scripts/stubs/*), so these
// are observations about shipped code, not about a reimplementation.
//
// Section 6 is a mutation self-test: it re-implements the OLD linear walk over the
// same rows and asserts that it does raise the false alarm. Without that, a probe
// claiming "the false alarm is gone" would pass just as happily against a verifier
// that returns valid:true unconditionally.
//
// Run: node --import ./scripts/_loader-boot.mjs scripts/probe-audit-chain-race.mjs
//   or node scripts/probe-audit-chain-race.mjs

import { register } from "node:module";
import crypto from "node:crypto";

register(new URL("./resolve-base44.mjs", import.meta.url));

const sdk = await import("./stubs/base44-sdk.mjs");
const runtime = await import("./stubs/base44-runtime.mjs");

const auditLog = (await import("../base44/functions/audit_log/entry.js")).default;
const auditVerify = (await import("../base44/functions/audit_verify/entry.js")).default;

let pass = 0;
let fail = 0;
const T = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`); }
};

const TOKEN = "probe-race-token";
const CSRF = "probe-race-csrf";
const TOKEN_HASH = crypto.createHash("sha256").update(TOKEN).digest("hex");
const SECRET = "probe-race-secret";
const GENESIS = "0".repeat(64);

function setup() {
  runtime.__clearSecrets();
  runtime.__setSecret("AUDIT_CHAIN_SECRET", SECRET);
  return sdk.__installBackend({
    users: [{ id: "u_owner", username: "owner1", email: "owner@example.com", role: "owner", is_active: true, is_locked: false }],
    sessions: [{ id: "s_1", token_hash: TOKEN_HASH, user_id: "u_owner", is_revoked: false, expires_at: new Date(Date.now() + 3600e3).toISOString() }],
  });
}

const req = (body = {}) => ({
  headers: new Headers({
    cookie: `base44_session=${TOKEN}; __Host-csrf_token=${CSRF}`,
    "x-csrf-token": CSRF,
    "x-forwarded-for": "203.0.113.7",
  }),
  json: async () => body,
});

const call = async (fn, body) => {
  const res = await fn(req(body));
  return { status: res.status, body: await res.json() };
};

/** One login event. Returns the promise UNAWAITED so callers can overlap them. */
const login = (detail) =>
  call(auditLog, {
    user_id: "u_owner", username: "owner1", action: "Login",
    performed_by_id: "u_owner", performed_by: "owner1",
    result: "success", detail, device: "probe",
  });

/**
 * Force a genuinely simultaneous fork of exactly `n` writers.
 *
 * WHY THIS EXISTS. Plain `Promise.all([login(), login(), login()])` does NOT
 * reliably fork. Observed across two consecutive runs of this probe: fork widths
 * of 3, then 2 (the third racer's read landed after the second's write), and at
 * n=20, fork shapes [5,9,6] then [15,5]. Real contention is a tree of whatever
 * shape the scheduler picks. Asserting a fixed shape would make this probe flaky,
 * and a flaky probe gets re-run until green, which is the same as having none.
 *
 * So the interleaving is pinned instead of hoped for: every writer is held at its
 * AuditLog.create() until all `n` of them have finished their AuditLog.filter()
 * read of the tail. That is the exact definition of the race, made deterministic.
 * Only the two methods audit_log touches on this table are wrapped, and the
 * originals are restored by the returned function — the stub's own semantics are
 * left alone so other probes are unaffected.
 */
function forkBarrier(table, n) {
  const origFilter = table.filter.bind(table);
  const origCreate = table.create.bind(table);
  let reads = 0;
  let release = () => {};
  const gate = new Promise((r) => { release = r; });
  // Safety valve: if a writer errors out before reading, the gate would never open
  // and the probe would hang instead of failing. Fail loudly rather than silently.
  const bail = setTimeout(() => release(), 5000);
  bail.unref?.();

  table.filter = async (...args) => {
    const out = await origFilter(...args);
    if (++reads >= n) release();
    return out;
  };
  table.create = async (...args) => {
    await gate;
    return origCreate(...args);
  };
  return () => {
    clearTimeout(bail);
    table.filter = origFilter;
    table.create = origCreate;
    return reads;
  };
}

/** `n` logins that are guaranteed to fork off the same parent. */
async function concurrentLogins(table, details) {
  const restore = forkBarrier(table, details.length);
  try {
    return await Promise.all(details.map((d) => login(d)));
  } finally {
    restore();
  }
}

const shape = (rows) =>
  rows.map((r) => `${String(r.detail).padEnd(8)} created=${r.created_date} hash=${String(r.hash).slice(0, 10)} prev=${String(r.previous_hash).slice(0, 10)}`).join("\n      ");

// ── 1. The race reproduces: three concurrent writers share a parent ─────────
console.log("\n=== 1. Three simultaneous logins fork the chain (the bug is real) ===");
let tables = setup();
await login("seq-1");
await concurrentLogins(tables.AuditLog, ["race-a", "race-b", "race-c"]);
let rows = tables.AuditLog.__rows();
console.log(`    ${rows.length} rows:\n      ${shape(rows)}`);

T("all four writes landed (nothing was lost)", rows.length === 4, `rows=${rows.length}`);

const racers = rows.filter((r) => String(r.detail).startsWith("race-"));
const racerParents = new Set(racers.map((r) => r.previous_hash));
T("the three racers all link to the SAME parent (fork confirmed)",
  racers.length === 3 && racerParents.size === 1,
  `parents=${[...racerParents].map((p) => String(p).slice(0, 10)).join(", ")}`);
T("that shared parent is the sequential row that preceded them",
  racerParents.has(rows[0].hash),
  `shared=${[...racerParents][0]} seq-1.hash=${rows[0].hash}`);

// The tracker assumed monotonicIso() prevented this. It cannot: it only steps past
// a timestamp it was handed, and all three racers were handed the same one.
const racerDates = new Set(racers.map((r) => r.created_date));
T("the racers also share a created_date — monotonicIso cannot order concurrent writes",
  racerDates.size < racers.length,
  `distinct dates=${racerDates.size} of ${racers.length}: ${[...racerDates].join(", ")}`);

// Every racer must still be individually authentic: distinct content, distinct hash.
const racerHashes = new Set(racers.map((r) => r.hash));
T("each racer still got its own distinct hash", racerHashes.size === 3,
  `distinct hashes=${racerHashes.size}`);

// ── 2. The verifier must call a fork concurrency, not tampering ─────────────
console.log("\n=== 2. The verifier reports the fork honestly ===");
let verified = await call(auditVerify, {});
console.log(`    verify => ${JSON.stringify(verified.body)}`);

T("the chain is VALID — no row was tampered with", verified.body.valid === true,
  JSON.stringify(verified.body));
T("it does NOT accuse anyone of rewriting a row", verified.body.reason !== "hash_mismatch",
  `reason=${verified.body.reason}`);
T("it does NOT report a chain break either", verified.body.reason !== "chain_break",
  `reason=${verified.body.reason}`);
T("every row was counted", verified.body.count === 4, `count=${verified.body.count}`);
T("the fork is reported rather than hidden", Array.isArray(verified.body.forks) && verified.body.forks.length === 1,
  JSON.stringify(verified.body.forks));
T("the fork names all three rows", verified.body.forks?.[0]?.count === 3,
  JSON.stringify(verified.body.forks?.[0]));
T("the warning is classified as concurrent_append",
  verified.body.warnings?.[0]?.reason === "concurrent_append",
  JSON.stringify(verified.body.warnings));
// An operator reading the warning must be able to tell it apart from an intrusion
// without reading the source, or they will escalate — or worse, learn to ignore it.
const warnText = String(verified.body.warnings?.[0]?.message || "");
T("the warning says plainly that this is not tampering", /not tampering/i.test(warnText), warnText);
T("the warning also discloses the cost (a fork branch could be dropped undetected)",
  /delet/i.test(warnText), warnText);
T("a fork means three tips, and they are listed",
  Array.isArray(verified.body.tips) && verified.body.tips.length === 3,
  JSON.stringify(verified.body.tips));
// Owner-facing text must never leak NaN/undefined/[object Object].
T("the report contains no NaN / undefined / [object Object]",
  !/NaN|undefined|\[object Object\]/.test(JSON.stringify(verified.body)),
  JSON.stringify(verified.body));

// ── 3. Tamper detection must NOT be weakened by any of the above ────────────
// This is the whole point of the log. If accepting forks cost us tamper evidence,
// the fix would be worse than the bug.
console.log("\n=== 3. Real tampering is still caught, on the forked chain ===");

// 3a. A row's contents edited behind the app's back.
tables = setup();
await login("t-1");
await login("t-2");
await concurrentLogins(tables.AuditLog, ["t-3a", "t-3b"]);
rows = tables.AuditLog.__rows();
const victim = rows[1];
const originalDetail = victim.detail;
victim.detail = "t-2 (rewritten by a DB admin)";
verified = await call(auditVerify, {});
console.log(`    edited row  => ${JSON.stringify(verified.body)}`);
T("editing a row is detected even though the chain also forks", verified.body.valid === false);
T("the verdict is hash_mismatch", verified.body.reason === "hash_mismatch", JSON.stringify(verified.body));
T("the report identifies the edited row", verified.body.tamperedAt === victim.id,
  `tamperedAt=${verified.body.tamperedAt} expected=${victim.id}`);
victim.detail = originalDetail;
verified = await call(auditVerify, {});
T("restoring the original content clears the alarm", verified.body.valid === true,
  JSON.stringify(verified.body));

// 3b. Back-dating a row. created_date is signed, so this is also a content edit —
// worth asserting separately because "adjust the timestamp" is the obvious way to
// hide when something happened.
const backdated = rows[1];
const trueDate = backdated.created_date;
backdated.created_date = "2020-01-01T00:00:00.000Z";
verified = await call(auditVerify, {});
console.log(`    back-dated  => ${JSON.stringify(verified.body)}`);
T("back-dating a row is detected", verified.body.valid === false && verified.body.reason === "hash_mismatch",
  JSON.stringify(verified.body));
backdated.created_date = trueDate;

// 3c. Deleting a row from the middle. The links exist to catch exactly this.
let liveRows = tables.AuditLog.__rows();
const removedIdx = 1;
const [removed] = liveRows.splice(removedIdx, 1);
verified = await call(auditVerify, {});
console.log(`    deleted mid => ${JSON.stringify(verified.body)}`);
T("deleting a row from the middle is detected", verified.body.valid === false);
T("the verdict is chain_break, not hash_mismatch", verified.body.reason === "chain_break",
  JSON.stringify(verified.body));
T("the break explains that a row was deleted", /delet/i.test(String(verified.body.detail || "")),
  String(verified.body.detail));
liveRows.splice(removedIdx, 0, removed);
verified = await call(auditVerify, {});
T("putting the row back clears the alarm", verified.body.valid === true, JSON.stringify(verified.body));

// 3d. A row forged by someone with DB write access but NOT the chain secret.
// They can see every existing row, so they can copy a valid previous_hash. What
// they cannot do is produce the hash.
const forged = {
  id: "forged_1",
  user_id: "u_owner", username: "owner1", action: "Login",
  performed_by_id: "u_owner", performed_by: "owner1",
  property_id: null, result: "success", detail: "forged without the secret",
  created_date: new Date(Date.now() + 1000).toISOString(),
  previous_hash: liveRows[0].hash,
  hash: crypto.createHash("sha256").update("guessed").digest("hex"),
};
liveRows.push(forged);
verified = await call(auditVerify, {});
console.log(`    forged row  => ${JSON.stringify(verified.body)}`);
T("a row forged without AUDIT_CHAIN_SECRET is rejected", verified.body.valid === false);
T("the forgery reads as hash_mismatch", verified.body.reason === "hash_mismatch", JSON.stringify(verified.body));
liveRows.pop();

// 3e. A "re-rooted" log. This is the insider case: someone who holds BOTH DB write
// access and AUDIT_CHAIN_SECRET can sign anything, so individual rows will pass the
// self-integrity check. What they cannot do is make an island descend from genesis.
console.log("\n=== 3e. A properly signed island that never reaches genesis ===");
tables = setup();
await login("island-root");
liveRows = tables.AuditLog.__rows();

/** Sign a row exactly the way every writer does. Used to forge WITH the secret. */
const signRow = (row) => {
  // AUDIT_CANONICAL_V1 = user_id,action,performed_by_id,performed_by,property_id,result,detail,created_date,previous_hash
  const canonical = JSON.stringify({
    user_id: row.user_id,
    action: row.action,
    performed_by_id: row.performed_by_id,
    performed_by: row.performed_by,
    property_id: row.property_id || null,
    result: row.result || "success",
    detail: row.detail || "",
    created_date: row.created_date,
    previous_hash: row.previous_hash,
  });
  return crypto.createHash("sha256").update(`${SECRET}:${canonical}`).digest("hex");
};

const islandRow = (id, detail, previous_hash, offsetMs) => {
  const row = {
    id, user_id: "u_owner", username: "owner1", action: "Login",
    performed_by_id: "u_owner", performed_by: "owner1", property_id: null,
    result: "success", detail,
    created_date: new Date(Date.now() + offsetMs).toISOString(),
    previous_hash,
  };
  row.hash = signRow(row);
  return row;
};

// Two correctly signed rows forming their own little chain, rooted on a hash that
// belongs to no row in the table.
const nowhere = crypto.createHash("sha256").update("a row that is not in this table").digest("hex");
const islandA = islandRow("island_a", "island-a", nowhere, 2000);
const islandB = islandRow("island_b", "island-b", islandA.hash, 3000);
liveRows.push(islandA, islandB);

verified = await call(auditVerify, {});
console.log(`    island      => ${JSON.stringify(verified.body)}`);
T("both island rows pass self-integrity (they were signed with the real secret)",
  signRow(islandA) === islandA.hash && signRow(islandB) === islandB.hash);
T("an island that does not reach genesis is NOT reported as valid",
  verified.body.valid === false, JSON.stringify(verified.body));
// Linkage (pass 2) sees the orphaned root before reachability (pass 4) can, so
// chain_break is the correct and more specific verdict here.
T("the verdict is chain_break — the island's root names a row that isn't there",
  verified.body.reason === "chain_break", JSON.stringify(verified.body));
T("the report points at the island's root, not at a healthy row",
  verified.body.brokenAt === islandA.id,
  `brokenAt=${verified.body.brokenAt} expected=${islandA.id}`);
liveRows.length = 1;
verified = await call(auditVerify, {});
T("removing the island restores a valid chain", verified.body.valid === true,
  JSON.stringify(verified.body));
// NOTE on pass 4 (reachability): with linkage passing, the only remaining way for a
// row to miss genesis is a previous_hash CYCLE, which requires a sha256 preimage
// cycle and is computationally infeasible to construct — so pass 4 is defence in
// depth against a future storage bug, not something this probe can trigger. Stated
// rather than faked: a test that cannot fail is worse than an absent one.

// ── 4. A strictly sequential chain must report cleanly — no fork noise ──────
// A warning that fires on healthy data gets muted, and a muted warning is worse
// than no warning.
console.log("\n=== 4. Sequential writes produce NO fork warning ===");
tables = setup();
for (let i = 1; i <= 5; i++) await login(`seq-${i}`);
rows = tables.AuditLog.__rows();
verified = await call(auditVerify, {});
console.log(`    verify => ${JSON.stringify(verified.body)}`);
T("five sequential writes verify", verified.body.valid === true && verified.body.count === 5,
  JSON.stringify(verified.body));
T("no fork is reported", verified.body.forks === undefined, JSON.stringify(verified.body.forks));
T("no warning is reported", verified.body.warnings === undefined, JSON.stringify(verified.body.warnings));
T("a linear chain has exactly one tip", verified.body.tips?.length === 1, JSON.stringify(verified.body.tips));
T("that tip is the newest row", verified.body.tips?.[0] === rows[rows.length - 1].id,
  `tip=${verified.body.tips?.[0]} newest=${rows[rows.length - 1].id}`);
T("sequential writes DO get strictly increasing created_date",
  rows.every((r, i) => i === 0 || r.created_date > rows[i - 1].created_date),
  rows.map((r) => r.created_date).join(" -> "));
T("the first row links to genesis", rows[0].previous_hash === GENESIS);

// ── 5. Verification must not depend on created_date order ───────────────────
// The chain's structure lives in the hashes; created_date is a display column. The
// old walk conflated the two, so this is the property that regressed.
//
// Reversing the stored array proves nothing, because the verifier's query re-sorts
// by created_date. So build a chain whose LINK order and TIMESTAMP order genuinely
// disagree: A -> B -> C by hash, with created_date C < B < A. That is not exotic —
// there are six independent writers on this chain and no shared clock between them.
console.log("\n=== 5. created_date order is not part of the chain's integrity ===");
tables = setup();
const skewed = [];
{
  // Timestamps deliberately DESCENDING while the links go A -> B -> C.
  const a = islandRow("skew_a", "skew-a", GENESIS, 3000);
  const b = islandRow("skew_b", "skew-b", a.hash, 2000);
  const c = islandRow("skew_c", "skew-c", b.hash, 1000);
  skewed.push(a, b, c);
}
const skewStore = tables.AuditLog.__rows();
skewStore.length = 0;
skewStore.push(...skewed);
T("the fixture really is skewed (link order disagrees with timestamp order)",
  skewed[0].created_date > skewed[1].created_date && skewed[1].created_date > skewed[2].created_date,
  skewed.map((r) => `${r.detail}@${r.created_date}`).join(" | "));

verified = await call(auditVerify, {});
console.log(`    clock-skewed chain => ${JSON.stringify(verified.body)}`);
T("a correctly linked chain verifies even when created_date runs backwards",
  verified.body.valid === true && verified.body.count === 3, JSON.stringify(verified.body));
T("no fork is invented by the re-sort", verified.body.forks === undefined,
  JSON.stringify(verified.body.forks));
T("the single tip is the LINK tip (skew_c), not the newest timestamp (skew_a)",
  verified.body.tips?.length === 1 && verified.body.tips[0] === "skew_c",
  JSON.stringify(verified.body.tips));

// The pre-fix walk visits these in created_date order — C, B, A — and so recomputes
// every hash against the wrong parent. Confirming it fails here is what makes the
// assertion above meaningful.
const skewOldVerdict = (() => {
  const byDate = skewed.slice().sort((x, y) => (x.created_date < y.created_date ? -1 : 1));
  let previousHash = GENESIS;
  for (let i = 0; i < byDate.length; i++) {
    const expected = signRow({ ...byDate[i], previous_hash: previousHash });
    if (expected !== byDate[i].hash) return { valid: false, reason: "hash_mismatch", index: i };
    previousHash = byDate[i].hash;
  }
  return { valid: true };
})();
console.log(`    same rows, pre-fix walk => ${JSON.stringify(skewOldVerdict)}`);
T("the pre-fix walk DID fail on clock skew (so the assertion above is meaningful)",
  skewOldVerdict.valid === false, JSON.stringify(skewOldVerdict));

// ── 6. MUTATION SELF-TEST: the old algorithm really did raise a false alarm ──
// Re-implement the pre-fix linear walk over the SAME forked rows this probe
// produced. If it comes back clean, this probe's section 2 proves nothing and the
// tracker entry was fiction — so an unraised false alarm is a FAILURE here.
console.log("\n=== 6. Mutation self-test: the pre-fix linear walk, replayed ===");
tables = setup();
await login("m-1");
await concurrentLogins(tables.AuditLog, ["m-2a", "m-2b", "m-2c"]);
const forkedRows = tables.AuditLog.__rows()
  .slice()
  .sort((a, b) => (a.created_date < b.created_date ? -1 : a.created_date > b.created_date ? 1 : 0));

// EXACTLY the pre-fix logic: expected hash computed over the PREVIOUS ROW'S hash.
const oldWalk = (rowsIn) => {
  let previousHash = GENESIS;
  for (let i = 0; i < rowsIn.length; i++) {
    const row = rowsIn[i];
    const expected = signRow({ ...row, previous_hash: previousHash });
    if (expected !== row.hash) return { valid: false, reason: "hash_mismatch", index: i, rowId: row.id };
    previousHash = row.hash;
  }
  return { valid: true };
};
const oldVerdict = oldWalk(forkedRows);
console.log(`    old linear walk => ${JSON.stringify(oldVerdict)}`);
T("the OLD walk falsely reports tampering on a concurrent fork",
  oldVerdict.valid === false && oldVerdict.reason === "hash_mismatch",
  `If this passes as valid, section 2 proves nothing. verdict=${JSON.stringify(oldVerdict)}`);

const newVerdict = await call(auditVerify, {});
T("the NEW verifier reports the same rows as valid",
  newVerdict.body.valid === true, JSON.stringify(newVerdict.body));
T("so the fix changed the verdict on identical data (false alarm eliminated)",
  oldVerdict.valid === false && newVerdict.body.valid === true,
  `old=${JSON.stringify(oldVerdict)} new=${JSON.stringify(newVerdict.body)}`);

// And the converse: the old walk and the new verifier must AGREE that a genuinely
// edited row is tampering. The fix must not have bought fork tolerance by going blind.
tables.AuditLog.__rows()[0].detail = "m-1 (edited)";
const editedSorted = tables.AuditLog.__rows()
  .slice()
  .sort((a, b) => (a.created_date < b.created_date ? -1 : a.created_date > b.created_date ? 1 : 0));
const oldOnEdit = oldWalk(editedSorted);
const newOnEdit = await call(auditVerify, {});
T("old and new agree that a rewritten row is tampering",
  oldOnEdit.valid === false && newOnEdit.body.valid === false
  && oldOnEdit.reason === "hash_mismatch" && newOnEdit.body.reason === "hash_mismatch",
  `old=${JSON.stringify(oldOnEdit)} new=${JSON.stringify(newOnEdit.body)}`);

// ── 7. Scale: twenty writers forking off one parent ─────────────────────────
// Barriered, so the shape is pinned at a flat 20-way fork and the assertions can be
// exact. Section 8 covers the messier natural case.
console.log("\n=== 7. Twenty writers forking off the same parent ===");
tables = setup();
await login("base");
await concurrentLogins(tables.AuditLog, Array.from({ length: 20 }, (_, i) => `burst-${i}`));
rows = tables.AuditLog.__rows();
verified = await call(auditVerify, {});
let vForks = verified.body.forks || [];
let vTips = verified.body.tips || [];
console.log(`    ${rows.length} rows; valid=${verified.body.valid} fork points=${vForks.length} fork sizes=[${vForks.map((f) => f.count).join(",")}] tips=${vTips.length}`);

T("no write was lost under contention", rows.length === 21, `rows=${rows.length}`);
T("the chain still verifies", verified.body.valid === true, JSON.stringify(verified.body).slice(0, 400));
T("contention is reported as concurrency, not tampering",
  verified.body.reason === undefined && verified.body.warnings?.[0]?.reason === "concurrent_append",
  JSON.stringify(verified.body.warnings));
T("all twenty are grouped into exactly ONE fork point",
  vForks.length === 1 && vForks[0].count === 20,
  `fork sizes=[${vForks.map((f) => f.count).join(",")}]`);
T("the fork names all twenty rows", vForks[0]?.row_ids?.length === 20,
  `row_ids=${vForks[0]?.row_ids?.length}`);
T("twenty leaves plus the shared parent means twenty tips", vTips.length === 20,
  `tips=${vTips.length}`);
T("the report is free of NaN / undefined / [object Object]",
  !/NaN|undefined|\[object Object\]/.test(JSON.stringify(verified.body)));

// ── 8. Natural contention: the report must survive any DAG shape ─────────────
// Unbarriered, so the shape is whatever the scheduler produces — a TREE of fork
// points, not a star, because a writer that starts slightly later reads a tail that
// already contains an earlier writer's row. Observed shapes across runs: [3],
// [2], [5,9,6], [15,5]. Nothing here asserts a shape; the shape is printed for the
// record and only structural invariants are checked. This is the section that would
// catch a fork report that only happens to work on the tidy case.
console.log("\n=== 8. Natural contention, any shape ===");
tables = setup();
await login("nat-base");
await Promise.all(Array.from({ length: 25 }, (_, i) => login(`nat-${i}`)));
rows = tables.AuditLog.__rows();
verified = await call(auditVerify, {});
vForks = verified.body.forks || [];
vTips = verified.body.tips || [];
console.log(`    ${rows.length} rows; valid=${verified.body.valid} fork points=${vForks.length} fork sizes=[${vForks.map((f) => f.count).join(",")}] tips=${vTips.length}`);

T("no write was lost", rows.length === 26, `rows=${rows.length}`);
T("the chain verifies whatever shape the scheduler produced",
  verified.body.valid === true, JSON.stringify(verified.body).slice(0, 400));
T("no tampering verdict is ever produced by mere concurrency",
  verified.body.reason === undefined, `reason=${verified.body.reason}`);
T("every row is counted exactly once", verified.body.count === rows.length,
  `count=${verified.body.count} rows=${rows.length}`);
// Each fork entry must be internally consistent, or an operator cannot act on it.
T("every fork's row_ids length matches its count",
  vForks.every((f) => Array.isArray(f.row_ids) && f.row_ids.length === f.count),
  JSON.stringify(vForks.map((f) => ({ count: f.count, ids: f.row_ids?.length }))));
T("every fork's created_dates length matches its count",
  vForks.every((f) => Array.isArray(f.created_dates) && f.created_dates.length === f.count),
  JSON.stringify(vForks.map((f) => ({ count: f.count, dates: f.created_dates?.length }))));
const allIds = new Set(rows.map((r) => r.id));
T("every row id named in a fork is a real row",
  vForks.every((f) => f.row_ids.every((id) => allIds.has(id))));
T("no row is reported in two different forks",
  (() => { const ids = vForks.flatMap((f) => f.row_ids); return new Set(ids).size === ids.length; })(),
  JSON.stringify(vForks.map((f) => f.row_ids)));
T("every fork point has at least two children (or it isn't a fork)",
  vForks.every((f) => f.count >= 2), JSON.stringify(vForks.map((f) => f.count)));
// Structural closure: rows = interior (rows that are somebody's parent) + tips.
// This is what proves the report describes the WHOLE table and not a subset of it.
const parentHashes = new Set(rows.map((r) => r.previous_hash).filter((h) => h !== GENESIS));
T("tips + interior accounts for every row",
  vTips.length + parentHashes.size === rows.length,
  `tips=${vTips.length} interior=${parentHashes.size} rows=${rows.length}`);
T("every tip is a real row that nothing points at",
  vTips.every((id) => allIds.has(id) && !parentHashes.has(rows.find((r) => r.id === id).hash)),
  JSON.stringify(vTips));
// The number in the warning must match the forks it describes, or the operator is
// reading a figure that means nothing.
if (vForks.length) {
  const forkedRowCount = vForks.reduce((n, f) => n + f.count, 0);
  T("the warning's row count matches the reported forks",
    new RegExp(`^${forkedRowCount} rows across ${vForks.length} point`).test(String(verified.body.warnings?.[0]?.message || "")),
    String(verified.body.warnings?.[0]?.message || ""));
} else {
  // Possible in principle if the scheduler serialised all 25. Then there must be
  // no warning either — silence and a clean chain must agree.
  T("with no fork there is also no warning", verified.body.warnings === undefined,
    JSON.stringify(verified.body.warnings));
}
T("the report is free of NaN / undefined / [object Object]",
  !/NaN|undefined|\[object Object\]/.test(JSON.stringify(verified.body)));

// Tamper evidence must hold on this shape too, not just on the tidy ones.
tables.AuditLog.__rows()[12].detail = "nat-11 (edited on a messy DAG)";
verified = await call(auditVerify, {});
T("a rewritten row is still caught on an arbitrarily shaped DAG",
  verified.body.valid === false && verified.body.reason === "hash_mismatch",
  JSON.stringify(verified.body));

console.log(`\n${fail === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
