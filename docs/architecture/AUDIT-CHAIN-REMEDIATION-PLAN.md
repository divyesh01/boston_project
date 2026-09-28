# Audit Chain Remediation — Design Plan

**Status:** **Phase 0 IMPLEMENTED** (2026-09-28). Phases 1–6 remain PLAN ONLY — no code for them has been written.
Phase 0 shipped: the fork/deletion discriminator, `brokenAt`, `reason` vocabulary, and `index` emission in `verifyAuditChain()`, plus the banner branch and regression tests. Phases 1–6 (D1 table, server writer, server verifier, client convergence, cutover, enforcement) are design only.
**Date:** 2026-09-28
**Baseline:** `main` @ `f2df464`, working tree clean, in sync with `origin/main` — captured *before* Phase 0.
**Deployment:** `boston-project.divyesh-boston.workers.dev` (Cloudflare Workers, D1 binding `DB`).
**Governance:** DEEP compute. Security-critical, schema migration, new write surface. Per CLAUDE.md this requires the six-agent workflow and independent review before any implementation.

---

## 1. Current state (OBSERVED)

The Audit Log page renders:

> Audit chain verification failed — tampering detected at log #16 (Local integrity check.)

### 1.1 Where audit rows actually live

`worker/schema.sql` defines 50 tables. **None is an audit table.** There are no `audit` references in `worker/db.js`, `worker/entities.js`, or `worker/index.js` (only the `view_audit_logs` permission string). `migrations-production/` has no audit migration.

All seven Base44 signers import `base44:runtime` and `npm:@base44/sdk` — Base44-only specifiers that **cannot execute on Cloudflare Workers**. Confirmed: `worker/*.js` contains zero `base44` imports; `wrangler.jsonc` ships only `dist/` + `worker/index.js`.

The **only** signer that executes in this deployment is `createAuditEntry` in `src/lib/securityUtils.js`, writing to browser IndexedDB via the Dexie `AuditLog` table (`src/api/localDb.js:67`).

### 1.2 The salt is public

```js
// src/lib/securityUtils.js:573
AUDIT_CHAIN_SALT = 'rri-local-audit-integrity-salt-v1'
```

Confirmed present in the shipped bundle `dist/assets/index-CY2xzpl4.js`. Anyone with browser devtools can recompute and forge rows.

### 1.3 Dispatch path (corrects an earlier misdiagnosis)

`VITE_USE_SERVER_AUTH=true` in `.env.production` makes the early return at `base44Client.js:2385` **skip**, so `functions.invoke('audit_verify')` **succeeds** via the local branch (`base44Client.js:2495` → `handleLocalAuditVerify`). The `catch` at `AuditLog.jsx:132` is **never entered**; `fallbackReason` is absent. The banner reads "Local integrity check" because `source: "local"` is set directly, **not** because a remote call threw.

An earlier HTTP probe (POST `/api/functions/audit_verify` → 403) does **not** prove the route is absent: that 403 is the CSRF guard at `worker/app-auth.js:98` firing before routing, and a deliberately fake function name returns an identical 403. Route absence is established by reading `worker/index.js:310-385` — no `/api/functions/*` branch exists.

### 1.4 Two contained bugs

| # | Location | Defect |
|---|---|---|
| B1 | `securityUtils.js:663` | Returns key `tamperedAt` for a chain **break**; the documented contract (`base44Client.js:1345`) specifies `brokenAt`. |
| B2 | `securityUtils.js:663` + `AuditLog.jsx:389` | Emits `reason: 'Chain break'`; UI checks `reason === "chain_break"`. **A genuine deleted row renders identically to tampering.** |

### 1.5 Fork vs tampering

`createAuditEntry` reads the tip via `.orderBy('created_date').reverse().first()`; two concurrent writers read the same tip and store the same `previous_hash` with different `hash`. The linear walk then mismatches at the second writer.

**INFERRED, not proven:** fork is the more likely cause, because an edited row would fail self-integrity while a fork produces a mismatch from a differing assumed parent — and B1/B2 make the two indistinguishable in the UI. Settling this requires reading the browser's chain state for its `reason` field. **NOT RUN** — needs the operator's browser.

### 1.6 The probe is misleading

`scripts/probe-audit-chain.mjs` passes **36 passed / 0 failed, exit 0**. It executes the Base44 entry files against in-memory stubs. Those files never run in this deployment, so **its green says nothing about production**. Its header also still describes three defects that are already fixed.

---

## 2. Target state

A server-authoritative, org-wide, append-only audit trail in D1, signed with a **server-held** secret, verified by the four-pass DAG algorithm. The browser holds no signing key.

---

## 3. Work items

### Phase 0 — Contain the false accusation (no schema, no migration) — ✅ SHIPPED

Owner authorized `src/lib/securityUtils.js` (PROTECTED #4) and `src/pages/AuditLog.jsx` by name before implementation.

| # | Change | File | Status |
|---|---|---|---|
| 0.1 | Return `brokenAt` (not `tamperedAt`) on linkage break | `src/lib/securityUtils.js` | done |
| 0.2 | Emit `reason: "chain_break"` (snake_case) to match UI + contract | `src/lib/securityUtils.js` | done |
| 0.3 | Show `reason` in the banner so fork/break/hash-drift are distinguishable | `src/pages/AuditLog.jsx` | done |
| 0.4 | Emit `index` so the UI can render "row N" (the original wording item was unbuildable — see below) | `src/lib/securityUtils.js` | done |
| 0.5 | Update stale probe header | `scripts/probe-audit-chain.mjs` | **not done — deferred** |
| 0.6 | **Added during implementation:** fork-vs-deletion discriminator (a `knownHashes` set built before the walk) — the causal fix, not a wording fix | `src/lib/securityUtils.js` | done |
| 0.7 | **Added during implementation:** `reason: "hash_mismatch"` on the hash-drift branch, unblocking the dead UI branch | `src/lib/securityUtils.js` | done |
| 0.8 | **Added during implementation:** `concurrent_fork` banner branch | `src/pages/AuditLog.jsx` | done |

**Plan corrections made during implementation** (recorded so the original design is not mistaken for what shipped):

- **0.4 as originally written was unbuildable.** It assumed `tamperedAt` is a string id like `auditlog_16` and that `index` exists. Both false for the local path: the Dexie primary key is an auto-increment integer, and `verifyAuditChain` never emitted `index` at all, so the UI's `(row N)` suffix was unreachable. Restated as "emit `index`".
- **The original 0.1/0.2 were wording, not cause.** They fix which key is emitted but cannot distinguish a fork from a deletion — both tripped the same branch. The `knownHashes` discriminator (0.6) is the actual fix; 0.1/0.2 make its verdict legible.
- **0.5 deferred.** Its header fix is still worth doing, but the header should not be updated in isolation: the probe exercises Base44 stubs this deployment never runs, so a tidier header over dead code is a better-formatted lie. It should ship together with a probe that runs the real product path.

**Known limitation of the shipped fix (adversarially verified):** parent-survival is *necessary but not sufficient*. An attacker who deletes rows **and re-signs the tip** produces `valid: true`, because the HMAC salt (`AUDIT_CHAIN_SALT`, `securityUtils.js:573`) is a public source literal present in the shipped bundle, so a re-signer can recompute any row's hash. The same tampering on a non-tip row yields `chain_break`. This gap pre-existed — the pre-fix verifier missed the same case via hash drift — and Phase 0 neither opens nor closes it. It is inherent to an unanchored hash chain and is **only** properly fixed by the server-held secret in Phases 1–2.

| # | Change | File | Authorization |
|---|---|---|---|
| 0.1 | Return `brokenAt` (not `tamperedAt`) on linkage break | `src/lib/securityUtils.js` | **PROTECTED #4** |
| 0.2 | Emit `reason: "chain_break"` (snake_case) to match UI + contract | `src/lib/securityUtils.js` | **PROTECTED #4** |
| 0.3 | Show `reason` in the banner so fork/break/hash-drift are distinguishable | `src/pages/AuditLog.jsx` | not protected |
| 0.4 | Render `chain.index` as an ordinal; `tamperedAt` is a row **id** | `src/pages/AuditLog.jsx` | not protected |
| 0.5 | Update stale probe header; add an assertion that the probe targets files the deployment actually runs | `scripts/probe-audit-chain.mjs` | not protected |

**0.1/0.2 require explicit owner authorization for `securityUtils.js`.** Without them a genuine deleted row still displays as "tampering detected" — the most damaging failure mode remaining.

### Phase 1 — Server-side storage

| # | Change | Artifact |
|---|---|---|
| 1.1 | New migration `0008_audit_log.sql` creating `audit_log` | `migrations-production/` |
| 1.2 | Columns mirror the canonical payload: `id`, `account_id`, `user_id`, `action`, `performed_by_id`, `performed_by`, `property_id`, `result`, `detail`, `created_date`, `hash`, `previous_hash` | |
| 1.3 | Indexes: `(account_id, created_date)`, `hash`, `previous_hash` | |
| 1.4 | `account_id` FK to `account(id)`; **`property_id` NOT NULL-or-explicit-null with an index** — addresses the "11 of 17 events had no property" finding | |
| 1.5 | Mirror `app_setting_history`'s shape for consistency: `INTEGER PRIMARY KEY AUTOINCREMENT`, `TEXT NOT NULL`, named `idx_*` indexes | |

**Do NOT** store `ip_address` / `device` in the signed payload. `getClientIpHint()` (`securityUtils.js:673`) returns the literal `'client-side'` and its own comment calls it a placeholder. Capture the real IP **server-side** from `x-forwarded-for` and store it unsigned.

### Phase 2 — Server-side writer

| # | Change | Artifact |
|---|---|---|
| 2.1 | `POST /api/audit/log` on the worker, same-origin/CSRF-guarded like existing routes | `worker/audit.js` (new) |
| 2.2 | Read `AUDIT_CHAIN_SECRET` from `env` (Wrangler secret) — **fail closed** if absent, mirroring `audit_verify/entry.js:93-102` | |
| 2.3 | Recompute the hash server-side; **never trust a client-supplied hash** | |
| 2.4 | Propagate `monotonicIso()` so concurrent writers produce a strict order; alternatively accept forks and report them as warnings | |
| 2.5 | Admin/owner gate per `business-sync.js:920` | |

**2.4 is the key design decision.** A monotonic timestamp makes the chain linear again and removes false accusations at the source. It does not remove genuine forks from true concurrency, so the four-pass verifier is still required as a backstop. Both together is the correct posture.

### Phase 3 — Server-side verifier

Port the four-pass DAG from `base44/functions/audit_verify/entry.js` to `GET/POST /api/audit/verify`:

- **Pass 1** self-integrity (recompute each row's hash over its own stored `previous_hash`) — order-independent
- **Pass 2** linkage (every `previous_hash` names an existing row or genesis)
- **Pass 4** reachability to genesis (compute before pass 3 so detached loops are caught)
- **Pass 3** forks → `warnings`, `valid` stays `true`

The algorithm is already written and reviewed. This is a **port, not a redesign** — the hard part is done.

### Phase 4 — Client convergence

| # | Change | File | Authorization |
|---|---|---|---|
| 4.1 | Point `db.audit.verifyChain()` at the worker route | `src/api/base44Client.js` | **PROTECTED #1** |
| 4.2 | Point `db.audit.log()` / `.list()` at the worker routes | `src/api/base44Client.js` | **PROTECTED #1** |
| 4.3 | Remove the hardcoded `AUDIT_CHAIN_SALT`; client stops signing entirely | `src/lib/securityUtils.js` | **PROTECTED #4** |
| 4.4 | Render `source`, `warnings`, `forks`, `tips` in the UI | `src/pages/AuditLog.jsx` | not protected |

### Phase 5 — Migration & cutover

Existing rows live only in per-browser IndexedDB and **cannot be migrated** — each browser holds a different history, signed with the public salt. There is nothing trustworthy to import.

- New `audit_log` table starts empty; the banner reports `count: 0` honestly.
- **Existing per-browser history is not evidence.** It must not be presented as an audit trail.
- Rollback: revert the worker; the client falls back to the local branch automatically.

### Phase 6 — Enforce

- New probe asserting the Cloudflare worker path, not the Base44 stubs — the current probe's blind spot is why this shipped.
- CI gate: fail if any file under `base44/functions/` is the only signer for a production path.
- Add `/health` returning audit-chain status so regressions surface without opening 25 pages.

---

## 4. Secret management

`wrangler` is **not installed** on this machine, so none of this can be deployed or verified from here until it is.

```
npx wrangler secret put AUDIT_CHAIN_SECRET
```

Never commit it; never log it. The current public salt must be treated as **burned** — rows signed with it prove nothing.

---

## 5. Authorization required

| File | PROTECTED_FILES.md | Needed for |
|---|---|---|
| `src/lib/securityUtils.js` | #4 | 0.1, 0.2, 4.3 |
| `src/api/base44Client.js` | #1 | 4.1, 4.2 |

Phase 1–3 and 5–6 touch no protected file. Phase 4 does.

Per `PROTECTED_FILES.md` rule 2, no workaround (wrapper, override, copy) is permitted for these.

---

## 6. Open questions for the reviewer

1. **Does D1's `batch()` provide the atomicity a hash-linked append needs?** If two workers write concurrently, a read-then-write tail races. `env.DB.batch` is used at `app-auth.js:156` but its isolation guarantees are unverified here.
2. **Can a fork be made impossible instead of merely detectable?** A `UNIQUE` constraint on `previous_hash` would force writers to retry — worth evaluating.
2b. **A deletion can be relabelled as a fork** (raised by independent Gemini review, NOT YET FIXED): an attacker deletes row *N* and re-points *N+1* at the surviving *N-1*. Because *N-1* is in the pre-built set, the verdict is `concurrent_fork`, not `chain_break`. The deletion is masked. Only the server-side `unreachable` pass (Phase 3) catches a detached sub-chain; Phase 0 has no reachability check, so a locally-forked branch is indistinguishable from honest concurrency. Closing this properly requires the reachability pass, not a Phase 0 tweak.
2c. **Multi-branch interleaving**: with two concurrent writers each producing a 2-row branch, `created_date` ordering can interleave them (`P, A₁, B₁, A₂, B₂`). At `A₂` the previous walked row is `B₁`, so a *legitimate* `A₁→A₂` link is reported as a fresh fork root. The verdict type is still `concurrent_fork` (correct class), but the reported position is the first interleaving point, not the true branch origin. Phase 0 stops at the first failure by design; the server's pass 3 collects all forks and would be accurate.
3. **What is the retention story?** An unbounded hash chain grows without bound; trimming breaks linkage unless the trim is itself recorded in-chain.
4. **What was `fallbackReason`?** The discriminator for fork-vs-break, still unread.
5. **Should `AUDIT_CHAIN_SALT` be removed even before Phase 1 ships?** Until the server path exists, the client must sign — but the UI should disclose that the chain is tamper-*evident* only, so nobody mistakes it for tamper-*resistant*.

---

## 7. Verification criteria (proposed)

| Step | Proof |
|---|---|
| 0.x | `node --import ./scripts/_loader-boot.mjs scripts/probe-audit-chain.mjs` → 0 failed, **and** a new negative test renders a chain break as "chain break", not "tampering" |
| 1.x | `npx wrangler d1 migrations list DB` shows `0008_audit_log` applied |
| 2.x | Concurrent-write test: N parallel `POST /api/audit/log` → chain verifies `valid: true`, forks reported as `warnings` |
| 3.x | Tamper test: direct D1 `UPDATE` of a signed column → verifier returns `reason: "hash_mismatch"` at the right index |
| 3.x | Delete test: `DELETE` a mid-chain row → `reason: "chain_break"` |
| 4.x | Live page shows `source: "server"`; `fallbackReason` absent |
| 5.x | `count: 0` on a fresh deployment, stated plainly |
| 6.x | CI fails if the signer is Base44-only |

---

## 8. What was NOT done

- **Phases 1–6: not implemented.** No D1 table, no server writer, no server verifier, no cutover. This document is the design for them.
- **No migration applied, no deploy, no D1 access.** `wrangler` absent from this machine.
- **`Re-verify chain` not clicked in production** — it re-runs the local check, and the live site is unchanged until this is deployed.
- **The production banner still reads "tampering detected at log #16".** The fix is committed but not deployed; `wrangler` is not installed.
- **Phase 0.5 (probe header) not done** — see the Phase 0 section for why.
- **The re-sign-the-tip attack is not fixed** — see the Known limitation note under Phase 0. Requires Phases 1–2.
- **No browser verification of the rendered banner.** The fork/deletion/edit ternary was evaluated in Node against real verifier output, not a live DOM.
