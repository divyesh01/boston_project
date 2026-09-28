// @ts-nocheck
// Phase 0 regression tests for verifyAuditChain() in src/lib/securityUtils.js.
//
// These are FAILING-FIRST tests. They encode the contract the local verifier must
// already satisfy but does not (Phase 0 audit of securityUtils.js:632-671).
//
// The governing contract is NOT invented here. It is the project's own:
//
//   base44/functions/audit_verify/entry.js:29-54  — the authoritative server
//     verifier's documented return shapes.
//   src/api/base44Client.js:1342-1345             — the client-side mirror:
//       { valid: false, tamperedAt, expected, actual, source }   (hash drift)
//       { valid: false, brokenAt,   expectedPrevious, actualPrevious, source }
//
// That server file already carries the diagnosis of this defect, at
// audit_verify/entry.js:48-54:
//
//   "NOTE: that client-side verifier still walks the chain linearly and so
//    still misreports a concurrent fork; it was left untouched deliberately
//    because securityUtils.js is listed in PROTECTED_FILES.md."
//
// So these tests assert what the project has already decided the local verifier
// owes. The fork/deletion discriminator is the load-bearing part; the exact
// return shape around it is deliberately left open.
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";

// Pin Node WebCrypto like the sibling harness (jsdom may lack subtle).
globalThis.crypto ??= await import("node:crypto").then((m) => m.webcrypto);
if (!globalThis.crypto?.subtle) globalThis.crypto = await import("node:crypto").then((m) => m.webcrypto);

const __store = new Map();
const __storage = {
  getItem: (k) => (__store.has(k) ? __store.get(k) : null),
  setItem: (k, v) => __store.set(k, String(v)),
  removeItem: (k) => __store.delete(k),
  clear: () => __store.clear(),
};
globalThis.localStorage = __storage;
globalThis.sessionStorage = __storage;
globalThis.window = globalThis;

const { createAuditEntry, verifyAuditChain } = await import("@/lib/securityUtils");
const localDbModule = await import("@/api/localDb");
const localDb = localDbModule.default;

// ─── Helpers (same approach as securityUtils.test.js) ───
//
// createAuditEntry stamps `new Date().toISOString()`, so inserts are spaced by
// `tick()` to keep created_date strictly increasing and the chain order stable.

const tick = () => new Promise((r) => setTimeout(r, 3));

// Build a real, signed entry WITHOUT persisting it. Needed to model concurrency
// faithfully: a second writer's entry must be hashed by createAuditEntry over the
// SAME tip the first writer saw, so that both previous_hash values are authentic.
async function stage(action, o = {}) {
  return createAuditEntry(action, {
    userId: null, username: o.username ?? "u", performedById: null,
    performedBy: o.performed_by ?? "system", propertyId: null, propertyName: null,
    result: "success", detail: o.detail ?? "",
  });
}

// Persist a staged entry verbatim — its own hash AND its own previous_hash.
// Never override previous_hash: an entry whose stored hash was produced over a
// different parent than the one stored alongside it is genuine tampering, not
// concurrency, and would silently turn a fork test into a hash-mismatch test.
async function persist(entry) {
  const id = await localDb.AuditLog.add({
    action: entry.action,
    created_date: entry.timestamp,
    ip_address: entry.ipAddress,
    device: entry.device,
    user_id: entry.userId,
    username: entry.username,
    performed_by_id: entry.performedById,
    performed_by: entry.performedBy,
    property_id: entry.propertyId,
    property_name: entry.propertyName,
    result: entry.result,
    detail: entry.detail,
    hash: entry.hash,
    previous_hash: entry.previous_hash,
  });
  return { ...entry, id, created_date: entry.timestamp };
}

const append = async (action, o) => persist(await stage(action, o));

const rowsInOrder = () => localDb.AuditLog.orderBy("created_date").toArray();

// Normalize a reason for COMPARISON only, so a test cannot pass just because
// the current code writes 'Chain break' where the contract says 'chain_break'.
// "Chain break" and "chain_break" are the same verdict in different spelling;
// treating them as different is exactly the bug under test.
const normReason = (r) => String(r ?? "").toLowerCase().replace(/[\s-]+/g, "_");

// Build a GENUINE concurrent-write fork, using only real createAuditEntry hashes.
//
//   P          prev = GENESIS
//   ├─ A        prev = P.hash      writer A read the tip as P
//   └─ B        prev = P.hash      writer B read the tip as P, before A committed
//
// Ordering note: B is staged first (so its created_date precedes A's) but
// persisted last, so the created_date walk sees P, B, A. The walk accepts B,
// then finds A.previous_hash (P.hash) != running hash (B.hash) — a linkage
// failure, which is exactly the code path a deletion also takes. That collision
// is the defect under test.
async function buildFork() {
  const parent = await append("P", { username: "alice", performed_by: "alice" });
  await tick();
  const bStaged = await stage("Session Opened", { username: "bob", performed_by: "bob" });
  await tick();
  const a = await append("Session Opened", { username: "alice", performed_by: "alice" });
  const b = await persist(bStaged);
  return { parent, a, b };
}

beforeEach(async () => {
  __store.clear();
  try {
    await localDb.AuditLog.clear();
  } catch {}
});

describe("verifyAuditChain — Phase 0 contract", () => {
  it("d. no regression: a clean linear chain still verifies", async () => {
    await append("User Login", { username: "alice", performed_by: "alice" });
    await tick();
    await append("Password Changed", { username: "alice", performed_by: "alice" });
    await tick();
    await append("User Created", { username: "bob", performed_by: "alice" });

    const res = await verifyAuditChain();
    expect(res.valid).toBe(true);
    expect(res.count).toBe(3);
  });

  it("b. a genuine DELETION reports brokenAt, not tamperedAt", async () => {
    const r0 = await append("User Login", { username: "alice", performed_by: "alice" });
    await tick();
    const r1 = await append("Suspicious Action", { username: "alice", performed_by: "alice", detail: "$200 void" });
    await tick();
    const r2 = await append("User Logout", { username: "alice", performed_by: "alice" });

    // Delete the middle row. r2's own hash still validates (its canonical is
    // unchanged), so this is a pure linkage failure: r2.previous_hash is r1.hash,
    // which no longer exists anywhere in the table.
    await localDb.AuditLog.delete(r1.id);

    const res = await verifyAuditChain();

    expect(res.valid).toBe(false);
    // B1: a break is a BREAK, not tampering. base44Client.js:1345 and
    // audit_verify/entry.js:37 both name this key `brokenAt`. Emitting
    // `tamperedAt` is what makes AuditLog.jsx:387 render "tampering detected"
    // for a row that was merely deleted.
    expect(res.brokenAt).toBe(r2.id);
    expect(res.tamperedAt).toBeUndefined();
  });

  it("b2. a genuine DELETION uses the snake_case reason 'chain_break'", async () => {
    const r0 = await append("User Login", { username: "alice", performed_by: "alice" });
    await tick();
    const r1 = await append("Suspicious Action", { username: "alice", performed_by: "alice", detail: "$200 void" });
    await tick();
    const r2 = await append("User Logout", { username: "alice", performed_by: "alice" });
    await localDb.AuditLog.delete(r1.id);

    const res = await verifyAuditChain();

    expect(res.valid).toBe(false);
    // B2: the server verifier emits exactly "chain_break"
    // (audit_verify/entry.js:248) and AuditLog.jsx:390 tests that literal. The
    // current 'Chain break' never matches, so that UI branch is dead code.
    expect(res.reason).toBe("chain_break");
  });

  it("c. a genuine EDIT (hash drift) still reports tamperedAt AND reason 'hash_mismatch'", async () => {
    const r0 = await append("User Login", { username: "alice", performed_by: "alice" });
    await tick();
    const r1 = await append("Void Adjustment", { username: "alice", performed_by: "alice", detail: "$200 void" });

    // A DB admin rewrites the row's content in place. The stored hash no longer
    // matches its content, but its previous_hash still resolves.
    await localDb.AuditLog.update(r1.id, { detail: "$2 void (harmless)" });

    const res = await verifyAuditChain();

    expect(res.valid).toBe(false);
    // B3: the hash-drift branch carries no reason today. The server sets
    // reason:"hash_mismatch" (audit_verify/entry.js:228) and AuditLog.jsx:389
    // renders it; without it the UI falls through to a bare "— undefined".
    expect(res.tamperedAt).toBe(r1.id);
    expect(res.reason).toBe("hash_mismatch");
    expect(res.expected).not.toBe(res.actual);
  });

  it("a. a CONCURRENT-WRITE FORK is not reported as a deleted row", async () => {
    const { parent, a, b } = await buildFork();

    // Precondition: this is a fork, not tampering. Every stored hash is
    // authentic and the shared parent is present in the table.
    expect(b.previous_hash).toBe(a.previous_hash);
    expect(b.hash).not.toBe(a.hash);
    const present = new Set((await rowsInOrder()).map((r) => r.hash));
    expect(present.has(a.previous_hash)).toBe(true);
    expect(present.has(parent.hash)).toBe(true);

    const res = await verifyAuditChain();

    // Compared through normReason, not by string identity: 'Chain break' IS a
    // deletion verdict, and it must not be able to pass here merely because it
    // does not literally match the snake_case the contract specifies.
    const isDeletion =
      res.valid === false && (normReason(res.reason) === "chain_break" || res.brokenAt !== undefined);
    expect(isDeletion).toBe(false);
  });

  it("a2. a CONCURRENT-WRITE FORK is not reported as tampering", async () => {
    await buildFork();

    const res = await verifyAuditChain();

    // Every row in the fork was written by a holder of the chain secret and each
    // verifies against its own content. Calling it tampering is the most alarming
    // and, here, most false verdict (audit_verify/entry.js:44-46).
    expect(res.tamperedAt).toBeUndefined();
  });

  it("a3. a CONCURRENT-WRITE FORK is distinguishable from a genuine DELETION", async () => {
    // Two runs of the same writes, differing ONLY in whether the shared parent
    // still exists. That single fact is the entire discriminator, so the two
    // verdicts must differ. This is the test that fails if the fix is
    // incomplete — any implementation reporting both as the same shape fails here.
    const forkRes = await (async () => {
      await buildFork();
      return verifyAuditChain();
    })();

    await localDb.AuditLog.clear();
    const { parent } = await buildFork();
    await localDb.AuditLog.delete(parent.id); // same writes, parent now gone
    const delRes = await verifyAuditChain();

    // Positive control: run 2 really is a deletion and must be judged as one.
    expect(delRes.valid).toBe(false);
    expect(delRes.brokenAt !== undefined || normReason(delRes.reason) === "chain_break").toBe(true);

    // Compare the fields that CLASSIFY a failure. Raw row ids are excluded:
    // they are an auto-increment sequence and can collide across the clear.
    const classify = (r) => ({
      valid: r.valid,
      reason: normReason(r.reason) || null,
      reportsTampering: r.tamperedAt !== undefined,
      reportsBreak: r.brokenAt !== undefined,
      forks: Array.isArray(r.forks) ? r.forks.length : null,
    });

    expect(classify(forkRes)).not.toEqual(classify(delRes));
  });

  it("a4. a CONCURRENT-WRITE FORK surfaces the fork rather than silently passing", async () => {
    await buildFork();

    const res = await verifyAuditChain();

    // Accepted shapes (deliberately not over-constrained):
    //   (i)   valid:true  + a non-empty forks/warnings array — the server's
    //         advisory style (audit_verify/entry.js:31-32, 44-46); or
    //   (ii)  valid:false + reason 'concurrent_fork'; or
    //   (iii) valid:false + any other reason that is neither 'chain_break'
    //         nor 'hash_mismatch'.
    const advisory =
      res.valid === true &&
      ((Array.isArray(res.forks) && res.forks.length > 0) ||
        (Array.isArray(res.warnings) && res.warnings.length > 0));
    const explicit = res.valid === false && res.reason === "concurrent_fork";

    expect(advisory || explicit).toBe(true);

    // The fork must be attributable, not merely non-fatal. An implementation that
    // returns an unrecognised reason token ("banana") and reports nothing about
    // forks has deleted the discrimination entirely while still satisfying every
    // other assertion in this file: `a` only forbids a deletion verdict, `a2`
    // only forbids tamperedAt, `a3` compares classification fields that such an
    // implementation happens to also produce. This is the assertion that pins
    // the headline claim, so it demands a named fork — not merely "not a break".
    //
    // Accepted: an advisory forks/warnings array, or the explicit
    // 'concurrent_fork' token. Nothing else.
    if (explicit) {
      expect(res.forkedAt !== undefined || typeof res.index === "number").toBe(true);
    }
  });

  it("e. a failure result carries the row `index` the UI renders", async () => {
    const r0 = await append("User Login", { username: "alice", performed_by: "alice" });
    await tick();
    const r1 = await append("Suspicious Action", { username: "alice", performed_by: "alice", detail: "$200 void" });
    await tick();
    const r2 = await append("User Logout", { username: "alice", performed_by: "alice" });
    await localDb.AuditLog.delete(r1.id);

    const res = await verifyAuditChain();
    const rows = await rowsInOrder();

    expect(res.valid).toBe(false);
    // B5: AuditLog.jsx:387-388 appends " (row N)" only when
    // `typeof chain.index === "number"`. The local verifier never sets it, so the
    // suffix can never render. The server sets it (audit_verify/entry.js:246).
    expect(typeof res.index).toBe("number");
    // The index must actually point at the offending row, whatever key the
    // implementer uses to name it. This is 0-based over the surviving rows, so
    // the offending row sits at index 1.
    expect(rows[res.index].id).toBe(res.brokenAt ?? res.tamperedAt);
    expect(res.index).toBeGreaterThanOrEqual(0);
    expect(res.index).toBeLessThan(rows.length);
  });
});
