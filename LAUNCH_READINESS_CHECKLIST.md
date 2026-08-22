# LAUNCH READINESS CHECKLIST — Red Roof Intelligence

**Review date:** 2026-08-15
**Commit reviewed:** `d17e9e4` (working tree clean)
**Launch bar applied:** production go-live, real hotel, real money, multiple staff users
**Scope:** the audit itself modified no application code. Remediation began 2026-08-15 on the owner's instruction and is tracked per-blocker below; the working tree now differs from `d17e9e4`.
**Last updated:** 2026-08-16 — remediation complete; see VERDICT and REMEDIATION STATUS below.

---

## VERDICT

**As audited on 2026-08-15: NOT READY — 11 launch blockers.** That verdict is preserved below as written, because the reasoning is what made the work possible to scope.

**As of 2026-08-16, after remediation: the code side is clear. Three things stand between this and a launch, and all three are yours** — set `AUDIT_CHAIN_SECRET` in Vercel, run `npm run build` and `npm run test` on your own machine (neither can run here, so both are honestly **NOT RUN**), and check a real preview and a real import in a browser. Nothing in this environment can substitute for those. Until they are done, treat this as *verified in code, unverified in a browser*.

---

### The verdict as originally written, 2026-08-15

**11 launch blockers.** The codebase is in good mechanical health — lint and typecheck both pass with zero errors, the CSP is strong, RBAC route guarding is default-deny, the CSV parser core is genuinely well built, and the dedupe key correctly preserves identical rows. Real engineering has gone into this.

The blockers are not sloppiness. They cluster into three specific structural problems:

1. **Property isolation does not hold.** It is enforced entirely in client-side JavaScript, and it already fails for a restricted user on the default Dashboard, before any adversarial behaviour.
2. **Imports lie about their outcome.** Every import currently commits its rows and *then* reports failure to the operator, with no undo ever offered.
3. **The audit trail cannot be trusted.** It breaks permanently on the first admin action, and failed logins are unloggable.

Any one of these is disqualifying for real financial data. Together they mean that if something went wrong in week one, you would not be able to tell what happened, who did it, or whether the numbers were ever right.

*All three root causes are addressed below. The first is closed by a launch restriction plus defence-in-depth rather than by the server-side rewrite it really wants — see B5, which is the one thing on this page you are accepting rather than fixing.*

---

## REMEDIATION STATUS (updated 2026-08-16)

**All 11 launch blockers are now closed: 10 fixed, 1 (B5) accepted in writing with a launch restriction.** The verdict above stood as of the audit; the remaining work is in the 🟠 HIGH and 🟡 MEDIUM sections, not the blocker list.

| # | Blocker | Status | Evidence |
|---|---|---|---|
| B1 | Restricted user sees all properties | ✅ Fixed | `probe-property-isolation` 47/0 |
| B2 | Property roster leaks | ✅ Fixed | same |
| B3 | Access fails open | ✅ Fixed | same, §6 |
| B4 | 24 sites bypass the proxy | ✅ Fixed | same + `verify-timecard` 47/0 |
| B5 | Isolation is client-side | ⚠️ Accepted | launch restricted to all-property users; `probe-auth-audit` 56/0 |
| B6 | Imports commit then report failure | ✅ Fixed | `probe-import-txn-zone` 7/0 |
| B7 | Rollback is a silent no-op | ✅ Fixed | `probe-import-rollback-id` 16/0 |
| B8 | Checksum/skip counts discarded | ✅ Fixed | `probe-import-validation` 14/0 |
| B9 | Audit log not append-only | ✅ Fixed | `probe-audit-chain` 30/0 |
| B10 | Failed logins unloggable | ✅ Fixed | `probe-auth-audit` 56/0 |
| B11 | Reconciliation unprovable | ✅ Proven | `verify-transactions` 115/0 — $1,020,598.17 to the cent |

**Still open before you go live:** nothing on the 🟠 HIGH list is unaddressed. Two items are **deliberately declined with the reasoning recorded** — no CSRF check on `custom_auth_login` (the `SameSite=Lax` cookie is not sent on the cross-site POST the check would be for, so it would be skipped in the attack and could only break real sign-ins) and the wrong-reason message shown to a disabled user (a cosmetic label gap; revocation itself works). One 🟡 MEDIUM item is open: `applyPropertyFilter` widening a single-property query. The remaining work is yours, not the code's — the two items below.

The most consequential finds were not on the original list. Under 🚀 Deploy: **the deployed CSP forbade the `blob:` fetch that every CSV import runs through**, and a second CSP in a `<meta>` tag made the policy look correct. Under 🟠 Security: **the SDK freezes request headers at construction, so the ten pages that rotate the CSRF token after a save silently 403'd every subsequent call** — which is why the audit writes in B10 were disappearing.

**Two things only you can do**, both required before launch:

1. **Set `AUDIT_CHAIN_SECRET` in Vercel.** The audit write path now fails closed without it, and the verifier will report "cannot verify". This is deliberate — a silent audit log is worse than a missing one — but it means an unset secret blocks audit writes entirely.
2. **Run `npm run build` and `npm run test` on your own machine, then rebuild `dist/`.** Neither can run in this environment: Vite/Rollup cannot load `@rollup/rollup-linux-x64-gnu` here, so both are honestly **NOT RUN**, and `dist/` is stale.

**Four behaviour changes your staff will notice**, all deliberate:

- **Only accounts with access to all properties can sign in to this release** (the B5 restriction). A single-property account is refused with a clear message.
- **Disabling or rotating two-factor authentication now asks for your own password**, and disabling it signs out every session on that account, including the one you are using.
- **An admin password reset, a self-service password change, a privilege change, and a token-based reset all sign the affected sessions out.** Someone will be logged out mid-shift by this; it is the point.
- **A used authenticator code cannot be used again.** If someone re-enters the same six digits, they must wait for the next one.

---

### Evidence labels used below
- **OBSERVED** — verified directly by reading the code or from terminal output
- **INFERRED** — supported by code evidence, not directly executed
- **NOT RUN** — could not be executed in this environment; result unknown

---

## ⚠️ READ FIRST: protected-file conflict

Several blockers live in files that `PROTECTED_FILES.md` locks from AI modification:

| Blocker | File | Status |
|---|---|---|
| B2, B3, B4, B6 | `src/api/base44Client.js` | 🔒 PROTECTED |
| S2 (CSRF cookie) | `src/lib/securityUtils.js` | 🔒 PROTECTED |
| S4 (password rules) | `src/lib/security.js` | 🔒 PROTECTED |

- [x] **Decide how these get fixed.** They cannot be repaired without your explicit authorization. Fixing the isolation model without touching `base44Client.js` is not possible — the proxy lives there. Grant a scoped exception, or plan to make these edits yourself.

**AUTHORIZED 2026-08-15 by the repository owner: full exception granted for all protected files** for the duration of this launch-readiness work. `src/api/base44Client.js`, `src/lib/securityUtils.js`, and `src/lib/security.js` have been modified under that authorization. Every change to them is described in the blocker sections below.

---

## 🔴 LAUNCH BLOCKERS

### ✅ B1 — A restricted user sees every property's financials on the default Dashboard — RESOLVED
**OBSERVED — independently verified during this review.**

Three defects compose into a live cross-property leak with no adversarial behaviour required.

`src/lib/useGlobalFilters.jsx:169-180` promises a clamp in its comment and does not perform one:

```js
const effectiveProperties = useMemo(() => {
  const sel = selectedPropertyIds.filter((id) => accessibleProperties.some((p) => p.id === id));
  // Owner/admin with no selection = all; restricted users with no selection = all accessible
  return sel;
}, [selectedPropertyIds, accessibleProperties]);
```

`selectedPropertyIds` initialises to `[]` (line 143), so `sel` is `[]` and `property` becomes the literal string `"all"` for **every** user on first load — including a clerk assigned to one property.

That value reaches `src/lib/dailyAggregates.js:139-153`, which reads the raw Dexie table and therefore **bypasses the property-filter proxy entirely**:

```js
} else {
  rows = await localDb.DailyFinancialAggregate.toArray();   // ALL properties
}
```

`src/pages/Dashboard.jsx:110` then *prefers* that unfiltered source over the proxy-clamped one:

```js
const base = aggData ? aggData.occRows : occ.filter((r) => inRange(r.date, …));
```

Because `rebuildDailyAggregates` populates that table on every import, the unfiltered path is the one that renders in production. `PropertyRanking.jsx` closes the loop by rendering `s.property_name` per row — so a one-property clerk gets a ranked revenue table of the whole portfolio, with names attached.

- [x] Clamp `effectiveProperties` to `accessibleProperties` when the selection is empty
- [x] Route `getDailyAggregates` through the entity proxy, or pass and enforce an allowed-ID list
- [x] Re-test as a restricted (non-owner, non-admin) user on first load, before touching any filter

**RESOLVED 2026-08-16.** `effectiveProperties` now drops any selected id that is not accessible, so a stale selection surviving a permission change cannot widen the next query. The empty-selection sentinel `"all"` is kept deliberately and is no longer a hole: `applyScope` turns an absent property condition into *the caller's own allowance*, so `"all"` resolves to "all of mine". `getDailyAggregates` reads through `db.entities`. Verified by `scripts/probe-property-isolation.mjs` — **47 passed, 0 failed** (was 16 passed / 29 failed when the workstream began), including a case asserting that `'all'` means all *accessible*, not all *existing*.

### ✅ B2 — The full property roster leaks to every user — RESOLVED
**OBSERVED.** `src/api/base44Client.js:383-388` — `PROPERTY_TABLES` omits both `Property` and `User`, so `Property.list()` returns every property to everyone. `useGlobalFilters` computes a correct `accessibleProperties` but *also* exports the raw `properties` (`:288`), and **16 pages read the unfiltered one**: Dashboard, ActionCenter, ChannelManager, Compare, DataIntelligence, Employees, Expenses, Forecasting, Housekeeping, ManualEntry, MonthlyCalendar, MtdGrowth, Payments, Payroll, Pricing, RoomBoard. Forecasting and ManualEntry destructure *both*, which shows the correct variable existed and was not adopted.

- [x] Scope `Property` and `User` reads to the caller's access
- [x] Stop exporting the unfiltered `properties`, or rename it so misuse is obvious

**RESOLVED 2026-08-16.** `Property` is now scoped on its primary key via `ROSTER_TABLES`, so `Property.list()` returns only the caller's properties. Rather than rename `properties` and edit ~18 call sites, the provider now exports the **access-scoped** roster under both names — `properties` and `accessibleProperties` are the same list, so every existing call site became correct without being touched. The second clamp in `useGlobalFilters` is kept as defence-in-depth because that list is what the property picker renders, and a UI offering a property the data layer will refuse produces an empty screen with no explanation.

### ✅ B3 — Property access fails OPEN in three places — RESOLVED
**OBSERVED — independently verified during this review.** `src/api/base44Client.js:404-417`. `null` means "apply no filter" (`:421`), and `getUserPropertyAccess()` returns `null` on three failure paths:

```js
if (!user) return null;                                          // unauthenticated → NO FILTER
if (!user.property_access || user.property_access === 'all') return null;  // unset field → NO FILTER
} catch { return null; }                                         // any error → NO FILTER
```

A user record created without `property_access`, or any transient `auth.me()` failure, silently escalates that request to full-portfolio scope.

- [x] Make the sentinel fail **closed** (`return []`), and use a distinct explicit value for legitimate "all" access

**RESOLVED 2026-08-16.** All three paths now fail closed. Legitimate portfolio-wide access is a distinct explicit value, so "I could not determine your access" can no longer be confused with "you may see everything". Verified in `probe-property-isolation.mjs` §6 ("Failure must deny, not escalate"), including that an unauthenticated caller is refused and that a number/string type mismatch on `property_id` fails closed rather than matching loosely.

Consequence worth knowing: `db.entities` now refuses an unauthenticated caller outright, which is why every test harness signs in first via `scripts/_harness-auth.mjs`.

### ✅ B4 — 24 call sites bypass the isolation proxy — RESOLVED
**OBSERVED.** Direct `localDb` access outside `src/api/` skips both `applyPropertyFilter` and the immutability guard, in `src/lib/aiEngine.js`, `dailyAggregates.js`, `dataScanner.js`, `securityUtils.js`, `uploadRetention.js`, `src/pages/DataIntelligence.jsx`, and `src/pages/Import.jsx`. B1 is the confirmed exploit; the rest are the same defect class awaiting a caller that passes `'all'`.

- [x] Audit all 24 sites; route through the proxy or justify each in a comment

**RESOLVED 2026-08-16.** Every site was visited. Reads were routed through `db.entities` in `src/pages/Import.jsx`, `src/pages/DataIntelligence.jsx`, `src/lib/uploadRetention.js`, and `src/lib/dataScanner.js` (three sites). Four sites keep raw `localDb` access **with a written justification in the code**, for two distinct reasons:

- **Chain integrity** (`securityUtils.js`, two sites). The audit chain is one sequence over the whole table. Linking each new row to "the newest row this caller can see" would fork it into a chain per property, and any reader with wider access would then see a break at every fork. Likewise, verifying a *filtered* subset would report tampering wherever a row was merely hidden — the opposite of useful. `AuditLog` is append-only for every caller and these rows are never rendered from here, so reading the tip leaks nothing.
- **Transaction-zone safety** (`uploadRetention.js` writes, `dailyAggregates.js` writes). These run inside a `localDb.transaction` zone, and the proxy's access lookup can await a macrotask, which kills the zone (see B6). Scoping happens on the *read* that selects the ids, so the writes only ever touch rows the caller may write.

The sweep also surfaced a genuine pre-existing production defect of the B6 class: a dynamic `await import("@/lib/timecardCalc")` inside the timecard import's transaction zone (present at HEAD `d17e9e4` as `reportParsers.js:1375`). A dynamic import is a macrotask, so it left the zone and Dexie committed early — a `PrematureCommitError` mid-import with rows already written. Hoisted to a static import; `verify-timecard.mjs` is now **47 passed, 0 failed**.

### ✅ B5 — Isolation is advisory: there is no server-side entity path — ACCEPTED WITH A LAUNCH RESTRICTION
**OBSERVED.** `realClient` appears exactly twice (`src/api/base44Client.js:1587`, `:1615`), both `functions.invoke`. There is no `realClient.entities` anywhere. Every financial row lives in the browser's IndexedDB via Dexie. **Every isolation and immutability control in this app is client-side JavaScript running inside the user's own browser** — a logged-in staff member with devtools can read all properties' data regardless of B1–B4.

- [x] Decide explicitly: move entity reads behind server-side authorization, **or** restrict launch to users authorised for all properties (which makes B1–B4 moot) and accept the limitation in writing

**DECIDED 2026-08-16 by the repository owner: restrict launch to all-property users, and fix B1–B4 anyway as defence-in-depth.** The server-side entity rewrite was explicitly *not* chosen.

### The limitation, accepted in writing

This release admits **only accounts entitled to every property**. Per-property staff accounts cannot sign in; they are refused at the login screen with a message naming the reason. The technical fact behind that decision is unchanged: entity data lives in the browser's IndexedDB, so every isolation control is client-side JavaScript. Restricting the audience to people who are *already* authorised for the whole portfolio means there is nothing for a devtools user to escalate *to* — the scope they could reach by bypassing the client is the scope they are entitled to anyway.

**What this costs you:** you cannot give a front-desk clerk or a single-property manager their own login in this release. Adding per-property staff accounts later requires the server-side entity path (a real project, not a patch), because at that point the client-side controls would be the only thing standing between a clerk and the whole portfolio's financials.

### How it is enforced

`LAUNCH_POLICY_V1` = `owner` | `admin` | `property_access === 'all'`, at three points:

1. **Login** (`base44/functions/custom_auth_login/entry.js`) — authoritative. Placed *after* password and MFA verification on purpose, so it cannot be used as an account-enumeration oracle: only a caller who already holds the credentials learns the reason. A wrong password on a restricted account returns the ordinary 401.
2. **Every navigation** (`AuthContext.validateCurrentAccountStatus`) — so narrowing someone's access takes effect on their next click instead of waiting out a week-long session.
3. **The offline shim** (`src/lib/launchPolicy.js`) — mirrors the server rule, and carries a machine-readable code `ALL_PROPERTY_ACCESS_REQUIRED` that survives `invokeBackend`'s error rewrap so the login page can distinguish this refusal from a credential failure.

Verified by `scripts/probe-auth-audit.mjs` — **56 passed, 0 failed** — which asserts the 403, the machine code, that no session row is created, that the refusal is written to the audit log as `result: 'failed'`, that the chain still verifies afterwards, and that no MFA-enrolment role is one the gate later refuses (so no TOTP secret is ever issued to an account about to be turned away). Real-time revocation of a narrowed account is verified by `scripts/test_realtime_revocation.mjs` — **26 passed, 0 failed**.

### B6 — Every import reports FAILURE while silently committing the data
**OBSERVED via probe against the real shipped modules.** `importReport` wraps writes in a Dexie `rw` transaction, but the proxy's `bulkCreate` first awaits `getUserPropertyAccess()` → `auth.me()` → a non-Dexie promise. Awaiting a macrotask inside a Dexie transaction destroys the transaction zone.

Probe output, authenticated owner session:

```
3. importReport (auth'd)   -> THREW PrematureCommitError: Transaction committed too early.
   TimecardPunch rows = 5 | ledger rows = 2
```

Consequences traced through `src/pages/Import.jsx`: the throw skips the `UploadedReport.create` history row (`:461`), so `UndoImportButton` can never render (`:34`); the queue row is set to `status: "error"` (`:490`) while the rows sit committed; lifecycle sessions strand at `in_progress` forever. Retries do **not** double-count — dedupe absorbs them — so the damage is truthfulness and recoverability, not inflation. Committed rows can only be removed by "Clear all imported data", which wipes every table.

`runInTransaction` therefore provides **no atomicity at all**. That conclusion holds regardless of environment; that the error surfaces identically in Chrome is INFERRED, but both production auth paths cross a macrotask boundary.

- [x] Hoist `getUserPropertyAccess()` outside the transaction (single call, passed in), or add a raw-table write path for imports
- [ ] Re-run a real import in Chrome and confirm success is reported as success

**FIXED 2026-08-15.** Root cause was one `await auth.me()` per entity-proxy call. `getUserPropertyAccess` is now a module-scope cached snapshot (`primePropertyAccess` / `invalidatePropertyAccess`, 30s TTL, force-primed at every transaction boundary, invalidated on privilege-mutating functions); `runInTransaction` primes before opening the zone and holds a `dexieZoneDepth` counter so nothing inside a zone can reach the network. Side effect: one fewer `custom_auth_me` round trip per row written.

Zone behaviour is now measured, not assumed — `scripts/probe-import-txn-zone.mjs`, **7/7 passed**: a macrotask await kills the zone, an already-resolved promise and a no-await async function do not. The Chrome re-test above is still yours to do; the harness cannot prove browser behaviour.


### B7 — Mid-import rollback is a guaranteed silent no-op
**OBSERVED.** The id-mismatch bug is **not fixed** on the failure path. `Import.jsx:343` mints its own `crypto.randomUUID()` and rolls back with it (`:476-481`), but `createImportSession` mints its own key (`src/api/base44Client.js:125`) and ignores the caller's:

```
caller importId = c4e6b799-fa7a-4ae8-b478-df53fa550273
ledger session  = imp_1786790366484_mnxqovf
rollbackImportSession(CALLER_ID) -> {"success":false,"error":"Import session not found"}
```

Compounding: `rollbackImportSession` *returns* `{success:false}` instead of throwing, so `.catch(console.error)` never fires and the return value is discarded — the failure is invisible even in the console. The Google Drive path (`:624-662`) has no rollback attempt at all.

- [x] Attach the real session id to the thrown error, or resolve it via `listImportSessions()`
- [x] Check `res.success` and surface failures
- [x] Note: `scripts/verify-import-rollback.mjs` only asserts the *correct-id* path, which is why it never caught this

**FIXED 2026-08-15.** `importReport` now attaches the real session id to the error it throws (non-enumerable, so it never leaks into a serialised error) and marks the session `failed` with its reason instead of leaving it `in_progress` forever. Both import paths in `Import.jsx` roll back with `err.importId || result.importId`, check `res.success`, and escalate the message when cleanup itself fails ("Rows may remain in the database; do not re-import until this is resolved").

`result.importId` closes a hole nobody had noticed: when the import succeeded but the `UploadedReport` history row failed, the rows stayed committed with no history entry and therefore no Undo button — invisible, unremovable data. The Google Drive path had no rollback at all and now has the same contract.

New coverage: `scripts/probe-import-rollback-id.mjs`, **16/16 passed**, which forces a mid-transaction failure and asserts zero rows committed, `status: 'failed'`, and a truthful `atomicRollback: true` response rather than a false "needs manual cleanup".


### B8 — Checksum mismatch and skipped-row counts are computed, then discarded
**OBSERVED.** `scanTransactions` detects the two most important integrity signals for the main revenue ledger (`src/lib/reportParsers.js:728-735`) — amounts disagreeing with the file's own trailer total, and rows skipped for unreadable dates. Both land in `scan.errors`. **`Import.jsx` never reads `scan.errors`** — it renders only `q.scan.validation` (`:960-983`), and `scanTransactions` returns no `validation` key at all. So the import-blocking gate (`:1153-1161`) **never fires for transactions**, a corrupt ledger imports silently clean, and skipped financial rows are lost without a word. `hotel_statistics` has the same defect (`:612`).

This is especially unfortunate because `src/lib/importValidation.js` is excellent work — four layers, counts, samples, severity, built explicitly against "unparseable numbers became 0". It is simply **not wired into the two highest-stakes report types**.

- [x] Call `validateImport` from `scanTransactions` and `scanHotelStatistics`
- [x] Render `scan.errors` in `Import.jsx`

**FIXED 2026-08-15.** Both scanners now return a `validation` object, so the blocking gate applies to them like every other type. The checksum mismatch is folded in as a `semantic` **error** — a ledger that disagrees with its own declared total is no longer imported unless the operator ticks Force import — and skipped dates are reported by the existing type layer. `scanTransactions` validates the section it actually imports (the widest grid), not the whole five-grid file, so the discarded sections cannot report raggedness that has no bearing on what gets written.

The transaction mapper also had no coercion log, so an amount of `"N/A"` became `0` with nothing recorded. Both mappers now log through one shared classifier (`recordCoercion`), because a value one path calls "truncated" and the other silently accepts is worse than no log at all. For statistics, unrecognised metric names are now named on screen instead of arriving quietly as `unknown`.

In the UI, `scan.errors` renders whenever a scan reports problems without a validation object, and the checksum readout — parsed vs the file's own declared total — is shown on every transaction scan. Both were computed on every scan and displayed nowhere.

Measured before choosing severities, since a gate that blocks real files is worse than no gate: `scripts/probe-import-validation.mjs`, **14/14 passed**. Both real files validate clean (`ok=true`, zero warnings); a $1,000 tamper inside the imported section is caught and blocked; `"N/A"` is reported as a zero-fill; a statistics file yielding no metrics is blocked; a renamed metric is surfaced.

Found and fixed while probing: `parseHotelReport` crashed with a raw `TypeError` on a statistics file whose sections carry no period columns (`universalParser.js:439` dereferenced a null `globalPeriodHeaders`). An operator uploading a truncated export got a stack trace instead of "no readable metrics".


### B9 — The audit log is not append-only and breaks on the first admin action
**OBSERVED.** Two independent problems.

*Deletable:* `base44/functions/audit_clear/entry.js` pages through and deletes **every** `AuditLog` row, then writes a self-authored "cleared" marker. It requires owner/admin — precisely the actors an audit log exists to hold accountable.

*Verifier poisoned:* `audit_log/entry.js` correctly recomputes a server-side sha256 hash chain, but `custom_user_admin/entry.js:181-197` (`writeAudit`) inserts rows **with no `hash` and no `previous_hash`**. `audit_verify` compares `ctEqual(expectedHash, row.hash || "")`, so the first user-admin action — create user, lock user, reset password — writes an unhashed row that reports `hash_mismatch` and **breaks the chain permanently from that point forward**. Staff will see a broken chain from day one, which trains them to ignore the signal. Tamper-evidence you cannot distinguish from routine noise is not tamper-evidence.

- [x] Make `writeAudit` go through the hashing path
- [x] Remove or hard-gate `audit_clear` (append-only means append-only)
- [x] Make `AUDIT_CHAIN_SECRET` fail closed instead of falling back to the published dev default
- [ ] **Set `AUDIT_CHAIN_SECRET` in Vercel before first use — yours to do.** The audit path now refuses to write and refuses to claim "verified" without it, so an unconfigured deployment is loud instead of quietly forgeable.

**FIXED 2026-08-15.** A correction to the audit above first: I had recorded that fixing the serverless audit functions would be theatre because the local shims shadow them. That was wrong. `src/api/base44Client.js:1798` returns `invokeBackend(...)` before every local audit handler whenever `USE_LOCAL_AUTH` is false, so **these four functions are the production audit path**. The fix was made there.

`writeAudit` in `custom_user_admin/entry.js` now loads the chain secret, reads the last row, and writes `hash` + `previous_hash` over the same canonical payload as the client-originated writer. All 12 call sites keep their signature. `audit_clear/entry.js` is now a 26-line hard 403 — kept rather than deleted so a stale client gets an unambiguous answer instead of a 404 that reads like a broken deploy — and `db.audit.clear()` is gone from the client, including the dev shim, so no code path anywhere can truncate the table. Bounding retention later has to be archive-then-trim with the trim itself recorded in the chain.

Fail-closed took some care about *where*. `audit_verify` returns "cannot verify" as **200 with `valid:false`**, not a 500, because `AuditLog.jsx` catches a throw and silently falls back to the weaker client-side check — a 500 would have converted a loud misconfiguration into a reassuring green banner. And `custom_user_admin` refuses a missing secret **up front, before anything mutates** (deny-by-default allowlist of read-only actions), because discovering it inside `writeAudit` would leave a privileged change applied but unrecorded.

Two smaller things surfaced while probing. `created_date` is what the verifier orders by, so two rows written in the same millisecond could be walked in the opposite order to the one they were linked in and reported as a chain break that never happened; both writers now nudge to strictly increasing (`monotonicIso`). And because the base44 host allows no module sharing between functions (every import is `npm:`, `node:`, or `base44:runtime`), the signed field list necessarily exists in three copies — comments asking for lockstep are not a mechanism, so all three carry an `AUDIT_CANONICAL_V1` marker and the probe asserts both that the markers match and that each file hashes exactly the fields it declares. I drifted one marker deliberately to confirm the guard fails (26 passed, 2 failed), then restored it.

New coverage: `scripts/probe-audit-chain.mjs`, **28/28 passed**, which executes the four *real* entry files against an in-memory base44 stub (`scripts/stubs/`, resolved by `scripts/resolve-base44.mjs`) rather than a reimplementation. On the shipped code it reproduced all three defects first: the `MFA Disabled` row landed with `hash=MISSING prev=MISSING` and the verifier reported `hash_mismatch` at index 1; `audit_clear` returned `{"success":true,"recordsDeleted":1}` while erasing the history; and with the secret unset the verifier answered `{"valid":true,"count":1,"source":"server"}`. It also asserts tamper evidence still fires for a genuine row edit, and that the *original row ids* survive the refused clear — a bare count check would have passed against the old code, which deleted one row and appended one of its own.

Remaining risk in this area: two concurrent writers can still read the same last row and share a `previous_hash` (a false chain break — `monotonicIso` narrows the window, it does not close it); a *transient* `AuditLog` write failure is still swallowed so a privileged change can proceed unrecorded; and `handleLocalAuditLog` still trusts a client-computed hash, which is acceptable only because it is `USE_LOCAL_AUTH`-only dev code. `npm run test` — **Not run** (`vitest` cannot start in this Linux VM; the rollup binding here is the Windows one).

### B10 — Failed logins and all pre-auth events are unloggable
**OBSERVED.** `base44/functions/audit_log/entry.js` requires a valid session and rejects writes where `payload.user_id !== session.user_id`. A failed login has no session, so the write 403s, and `src/lib/auditLogger.js` swallows it into `console.error`. **Brute-force attempts, credential stuffing, and lockouts leave no audit record** — only a console line in the attacker's own browser.

- [x] Add a server-side path for pre-auth security events

**FIXED 2026-08-15 — but not the way this line originally proposed.** I did *not* add an unauthenticated audit endpoint. Doing so would hand anyone on the internet a way to write attacker-authored rows into the trail meant to convict them, and to flood the real ones out of view. Instead `custom_auth_login` now writes the rows itself: it is the only party that knows the truth about a pre-auth attempt, and it already knows the IP, the user agent, the account, and the failure count.

Recorded now, each hashed into the same chain as everything else: **Failed Login** (unknown identifier, wrong password with the running failure count, locked account, inactive account), **Account Locked** as its own row when the tenth consecutive failure trips the lock, **Failed MFA** for a correct password with a wrong code — a materially different event, because it means someone holds working credentials but not the second factor — **Login Rate Limit Reached**, and **Login** on success.

Successes are included deliberately. A trail of failures with no successes in it cannot answer the first question anyone asks after an attack, which is whether it eventually worked.

Three things I had to decide, all of which point at a design constraint rather than a preference:

*Volume.* The throttle event is logged **once per window**, on the attempt that fills it — not on each refusal afterwards. Refused attempts return 429 without touching the counter, so logging there would let one IP append audit rows for free until the window expired. Combined with the existing limiter, one IP can add at most ~6 rows per 15 minutes. The submitted identifier is truncated to 120 characters before it is stored, because it is attacker-controlled, unbounded, and about to be signed into a permanent row.

*Attribution.* `performed_by_id` stays **null** on every failure. The request was unauthenticated, so recording the account holder as the actor would assert that they did this — a brute-force row must not accuse its own victim. Only a completed login sets it.

*Availability.* This is the one place that takes the **opposite** call to `custom_user_admin`, which refuses a privileged change it cannot record. If `AUDIT_CHAIN_SECRET` is missing, logins still work and the event is dropped with a `console.error`. Refusing every login on a missing environment variable would lock the staff — and the operator who has to fix it — out of a running hotel mid-shift, and after B9 an unconfigured deployment is already loud. Writing an unhashed row instead would be worse than writing none, because it would read as a permanent chain break.

New coverage: `scripts/probe-auth-audit.mjs`, **35/35 passed**, running the real `custom_auth_login` against the in-memory backend. Against the shipped code it first showed `(no audit rows)` for every single case — wrong password, unknown identifier, lockout, throttle, successful login. It also asserts the response bodies did not change (a bad identifier still returns the generic `Invalid email or password`, so the new row does not come at the cost of user enumeration), and that the chain still verifies with pre-auth rows in it. `scripts/probe-audit-chain.mjs` now holds **four** copies of the canonical payload in lockstep: **30/30 passed**.

Two things found while doing this, neither a launch blocker:

- **The Category filter on the audit page matches nothing.** `AUDIT_CATEGORIES` (`src/lib/auditFilter.js:3-9`) lists actions as `LOGIN`, `AUTH_FAILURE`, `ACCOUNT_LOCKOUT`, `RATE_LIMIT_HIT`, `REPORT_IMPORT` — a vocabulary **no writer in the codebase produces**. Every actual row says `Failed Login`, `MFA Disabled`, `Unauthorized Route Access`. `filterAuditLogs` does `allowedActions.includes(log.action)`, so selecting any category except ALL empties the table. I kept the new rows in the human-readable vocabulary the badge colouring and the search box already use (`ACTION_BADGE` in `AuditLog.jsx:15-24` keys off `"Login"`, `"Failed"`, `"Locked"`), rather than adding a second one. Reconciling the two lists is a UI fix, tracked with the other UI work. **OBSERVED**
- **Failed logins will not appear in the audit page when you run `npm run dev`.** `.env.development` sets `VITE_USE_LOCAL_AUTH=true`, which routes login through the in-browser shim in `src/api/base44Client.js` instead of this function. That shim still records nothing. Verify this fix with the probe (which runs the real function) or on a deployed preview — not in dev mode, where it will look like nothing happened. **OBSERVED**

### B11 — The $1,020,598.17 reconciliation invariant is currently unprovable
**NOT RUN — and this is itself the blocker.** `CLAUDE.md:233` makes this a launch condition, but every suite that checks it fails on absent input: `scripts/data/` contains only `timecard-sample.csv`. `All Transactions.csv`, `Source Summary (1).csv`, and `Hotel Statistics (1).csv` are not on this mount.

Worse, **nothing in `src/` enforces the invariant at runtime.** The figure appears only in test scripts and comments. Three *independent* revenue derivations exist with no reconciliation between them (INFERRED from code):

| Surface | Derivation |
|---|---|
| Statistics | verbatim from imported CSV — `src/lib/statisticsAnalytics.js:83-86` |
| Transactions | `summarize()` charge-side sum — `src/lib/transactionAnalytics.js:69-72` |
| Dashboard / Expenses | `sum(occRows,"total_revenue")` from OccupancyDay — `src/pages/Expenses.jsx:84` |

No page displays a reconciled total and no code compares the three. **Drift would be silent.**

- [x] Restore the CSV fixtures and get `verify-transactions`, `verify-statistics`, `verify-coexistence` green
- [ ] Add a runtime cross-check that surfaces drift between the three derivations
- [x] Fix `scripts/_loader-boot.mjs` — it now shims `document`, which flips axios's `hasBrowserEnv` true and throws `Cannot read properties of undefined (reading 'href')`. Every static-import suite dies before its first check. This is a **regression**: `verify-transactions` recorded 114/114 on 2026-08-09

**PARTLY FIXED 2026-08-15 — the invariant is now PROVEN, the runtime cross-check is not built.** You restored the 17 CSV exports, and the harness has been repaired: the `document` shim is now internally consistent (it also provides `location` and event listeners, which is what axios actually needed), and a `Worker` shim runs the real `src/lib/parser.worker.js` in-process, since Node has no global `Worker` and `fetchCsvRows` spawns one.

Observed against the real files: **verify-transactions 115/115, verify-statistics 84/84, verify-coexistence 23/23, verify-source-contributions 12/12, verify-money-kept 23/23, verify-import-rollback 11/11** — revenue reconciles to **$1,020,598.17 (charge side only)** to the exact cent.

Two suites were reporting a false red: they finished fully green, then hung on pending SDK retry sockets until the timeout killed them. Both now exit explicitly. That matters because the whole protocol leans on exit codes.

The second box stands: nothing in `src/` compares the three derivations at runtime, so drift between them would still be silent in the product even though the suites now catch it in CI.


---

## 🟠 HIGH — fix before launch or accept a named risk

### Security
- [x] **`verify_mfa` has no authorization check and no rate limit** (`custom_user_admin/entry.js:569-577`). ✅ Fixed 2026-08-16. Every other sensitive action is `requireAdmin()`-gated; this one was gated by neither, and unlike `custom_auth_login` (5 per 15 min) it had no throttle. It is now **admin-or-self** (`if (!isAdmin && String(actor.id) !== String(id)) throw`) and throttled to **10 attempts per 15 minutes**, with the refusal written to the audit log as a `Failed MFA` row. The bucket is keyed on the **target account** (`user:${user.id}`), not the source IP: an attempt spread across many addresses is exactly the shape a determined attacker takes, and per-IP counting does not bound guessing against one account. **OBSERVED — `probe-auth-hardening` §7, §8**
- [x] **Privilege and credential changes do not revoke sessions.** ✅ Fixed 2026-08-16. `revokeUserSessions` was called in `set_status` and `delete` but **not** in `update` (the action that changes `role`, `permissions`, `property_access`), nor in `reset_password` / `set_password` / `change_own_password`, nor in the forgot-password flow — so demoting an owner left their session at old rights for up to 7 days, and a victim changing their password did **not** evict an intruder. `update` now computes `privilegeChanged` from the fields it actually receives and revokes on any of them; all four password paths revoke; and the token-based reset in `custom_auth_reset_password` revokes every live session and records the count in its audit detail.

  The dead `roleChanged`/`accessChanged` computation in `set_status` (lines 443-445, reading fields `set_status` never sets) is gone — that was the mis-wiring, and leaving it in place would have kept the appearance of a check that never ran.

  Two revocations deliberately **spare the caller's own session**, via a new `exceptTokenHash` argument: a self-service password change and self-enrolment in MFA. Signing you out of the tab you are currently working in is not a security gain, and for enrolment it is actively harmful — the next step is to confirm a code from the secret just issued, which requires being signed in. Every other case, including `disable_mfa`, takes **all** sessions. **OBSERVED — `probe-auth-hardening` §4, §5, §6, §10, §11**
- [x] **`enable_mfa` / `disable_mfa` require no re-authentication.** ✅ Fixed 2026-08-16. A stolen session could rotate the victim's MFA secret (locking out the real owner) or strip MFA entirely, defeating the forced owner/admin enrolment. Both now require the **actor's own password** (`assertActorPassword`): unconditionally for `disable_mfa`, and for `enable_mfa` when the target already has a live factor. First-time enrolment is not gated, because there is nothing yet to steal.

  **The actor's password, not a TOTP code**, for two reasons that rule the alternative out: an admin rotating another user's factor cannot produce that user's code, and an admin who never enrolled has no code of their own to give — a password is the only factor every account holds.

  The UI half matters as much as the server half: without it this is a feature that returns 403 every time a real operator touches it. A new `src/components/PasswordConfirmDialog.jsx` collects the password (never lifted into page state, cleared on every open and close) and is wired into `Settings.jsx` and `Users.jsx`. Two consequences are stated in the dialogs because they are surprising: disabling your own factor **signs you out of every session including the current one**, so Settings now performs the logout rather than leaving a signed-in-looking page whose next request 401s; and rotating a factor invalidates the existing authenticator entry. **OBSERVED — `probe-auth-hardening` §9 and §16 (12 static assertions on the UI wiring, self-tested against five mutations to confirm they go red on the old code and on deletion of the calls)**
- [ ] **`custom_auth_login` has no CSRF check** while every other state-changing function has one. **Deliberately not changed — reasoning recorded so the decision can be overruled rather than rediscovered.** The `csrf_token` cookie is `SameSite=Lax`, so it is **not sent on a cross-site POST**. A check here would therefore be skipped in exactly the request it is meant to stop, while any false negative locks a real hotel out of signing in. The residual exposure is login CSRF / session fixation into an attacker-controlled tenant; the effective mitigation is the `SameSite` cookie itself, which is already in place. **OBSERVED**
- [x] **`crypto.timingSafeEqual` throws on length mismatch**, so a legacy `$pbkdf2`-prefixed hash yielded HTTP 500 instead of "invalid credentials" — a lockout bug on exactly the accounts the upgrade path was written for, and a useful oracle. ✅ Fixed 2026-08-16. A shared `hashesEqual(a, b)` in both auth functions compares byte length first (leaking only the algorithm-fixed hash length) and rejects empty buffers, so the constant-time comparison is never reached with unequal inputs. An account whose stored credential is missing entirely — no `password_hash` or no `salt` — is now refused as a normal failed login **and audited with the specific reason**, instead of crashing. **OBSERVED — `probe-auth-hardening` §2**
- [x] **CSRF token snapshotted once at module load** (`src/api/base44Client.js:13-19`). ✅ Fixed 2026-08-16, and the mechanism was worse than the item describes. In `node_modules/@base44/sdk/dist/client.js:73-76` the headers object is spread **once** at `createClient` time into the axios defaults, so `X-CSRF-Token` is fixed for the whole page lifetime. Ten pages call `rotateCsrfToken()` after a save — Users, Settings, Import, Expenses, ManualEntry, Login, Setup, ChangePassword, ForgotPassword, ResetPassword — so the cookie and the header drifted apart on the first rotation and **every later invoke 403'd**, which is how B10's audit writes were failing silently. Fixed by capturing the header value once in `securityUtils` and re-pinning the cookie to that captured value before each invoke, so rotation still refreshes the client-side token without breaking the pair. **OBSERVED — `probe-auth-hardening` §12**
- [x] **Reset-token leak via `Host` header** (`custom_auth_reset_request/entry.js`). ✅ Fixed 2026-08-16 — this was the item flagged as "treat as a blocker if you cannot confirm Vercel normalises `Host`", so it was fixed rather than reasoned about. `host?.includes('localhost')` returned the raw reset token in the response body, and because `Host` is attacker-controlled and the test was `.includes()` rather than equality, **`localhost.evil.com` matched** — a request-only path to full account takeover. Replaced with `isLocalHost()`, which strips the port (and handles bracketed IPv6) and compares the hostname for **exact** equality against `localhost`, `127.0.0.1` and `::1`. The token design itself was already sound: `randomBytes(32)`, sha256 at rest, 1-hour expiry, single-use. **OBSERVED — `probe-auth-hardening` §13**
- [x] **Console statements ship to production.** ✅ Fixed 2026-08-16. `vite.config.js` now sets `esbuild: { pure: ['console.log', 'console.debug', 'console.info'], drop: ['debugger'] }`. `pure` rather than `drop: ['console']` is deliberate: `drop` is unconditional and would also delete the 17 `console.warn` and 38 `console.error` calls, and those are load-bearing — they are how the operator, or whoever is helping them over the phone, finds out that an import was rejected or a save failed. `pure` is applied by the minifier, so `vite dev` still prints everything and only the shipped bundle is quiet. Tests are unaffected; `vitest.config.js` is a separate config.

  A stripped call is a *removed* call, so two sites had to change before this was safe. `Email.SendEmail` (`base44Client.js`) and `fireAlert` (`alertEngine.js`) each had `console.log` as their **only** side effect — under the new config, "sending" a mail or "firing" an alert in production would have done nothing at all while still looking correct in dev. Both now write at `warn` level. Every remaining `console.log` (three `ChannelManager` traces) takes a plain string or a template literal over identifiers, so removal cannot discard work.

  **Two corrections to the original finding, both against my own claim.** First, "a temp password can be printed to the browser console" was wrong. `custom_auth_register` sends the welcome mail through `base44.asServiceRole.integrations.Core.SendEmail` — **server-side**, on the platform's own transport — and the client-side stub is not in that path at any point. Its one caller is the anomaly alert at `reportParsers.js:1262`. No password ever reached a browser console. Second, the underlying concern was still real for a different reason: that anomaly body carries property names and IDs, and it was being printed in full on what is often a shared front-desk machine. The stub now logs the body's *length* and never its content.

  Surfaced while fixing this, and worth knowing separately: **the client-side `Email` integration has no transport and cannot have one** — sending mail needs a credential, which must never reach the browser — so that anomaly alert to `alerts@hotel-operator.com` is not delivered, while `SendEmail` returns `{status:'success'}`. The detection itself is written to the audit log one line above the send (`reportParsers.js:1252`), so nothing is lost but the notification. Do not rely on that email; read anomalies from the dashboard and the audit log. **OBSERVED — `probe-deploy-config` §7, including a paren-balanced argument scan (self-tested against eight shapes) proving no stripped call does work in its arguments. NOT RUN: the stripping is verified from the configuration and the source, not from a built bundle, because `npm run build` cannot run in this environment — after your build, `grep -c "console\.log" dist/assets/*.js` closes it.**

#### Found and fixed during the auth hardening — not in the original audit

- [x] **A TOTP code stayed valid for about 90 seconds after use.** ✅ Fixed 2026-08-16. `verifyTotpToken` accepted a ±1 window over 30-second counters and recorded nothing, so a code observed over someone's shoulder, read off a shared screen, or replayed from a proxied request worked again for up to three counters. `verifyTotpToken` now **returns the matched counter** (or `-1`) and takes a `notBefore` bound; every accepting path persists `mfa_last_counter` on the User and refuses anything at or below it. A used code is spent. The ±1 window is kept for genuine clock skew, which is the reason it exists. `base44/entities/User.jsonc` gained the `mfa_last_counter` field. **OBSERVED — `probe-auth-hardening` §7**
- [x] **A wrong MFA code did not count toward the lockout.** ✅ Fixed 2026-08-16. Only the wrong-password branch incremented `failed_login_count`, so an attacker holding a valid password had **unlimited** attempts at the second factor — the lockout protected the factor they already had and not the one they needed. A single in-handler `recordFailure` is now shared by the wrong-password branch and both MFA branches, and it locks the account at 10 consecutive failures with its own `Account Locked` audit row. **OBSERVED — `probe-auth-hardening` §3**
- [x] **The forgot-password endpoint was an account-existence oracle.** ✅ Fixed 2026-08-16. The response body was already uniform, but the throttle ran **after** the user lookup, so a refusal — and the timing of a hit versus a miss — distinguished a real address from an unknown one, and nothing bounded enumeration of the whole roster. Rate limiting (5 per 15 minutes, per IP **and** per submitted email) now runs **before** the lookup, so a refusal is computed without ever touching the user table. **OBSERVED — `probe-auth-hardening` §13**
- [x] **A weak new password burned the reset token.** ✅ Fixed 2026-08-16. `custom_auth_reset_password` did not check password strength at all, and adding the check naively would have consumed the single-use token on a refusal, leaving the user with a dead link and no way to try again. The strength check now runs **before any write**, so a rejected password leaves the token usable. The same function now writes a proper hash-chained `Password Reset` audit row — it was the one privileged write path with no audit entry, which meant a completed account takeover via reset left no trace. It is the fifth copy of `AUDIT_CANONICAL_V1`, and `probe-audit-chain` §6 enumerates all five and fails if any drifts. **OBSERVED — `probe-auth-hardening` §11, `probe-audit-chain` §6**
- [x] **A sliding session slid only on the server.** ✅ Fixed 2026-08-16. `custom_auth_me` extended the `Session` row's `expires_at` when under 3 days remained but never re-issued the cookie, and the browser deletes the cookie on the `Max-Age` written at login regardless of what the row says. The two clocks disagreed: the server believed the session was good for another week while the cookie carrying it expired on the original schedule, and **the user was signed out mid-shift by a session the database still considered live**. `custom_auth_me` now returns a matching `Set-Cookie` with the same token, flags and window — but **only** on the polls where the session actually slides, since a `Set-Cookie` on every poll would make the real lifetime unauditable. The absolute 30-day cap still ends the session on schedule however many times it slides. If the request URL cannot be parsed the cookie defaults to `Secure`, so an unreadable URL fails toward the stricter cookie rather than sending the session in clear text. **OBSERVED — `probe-auth-hardening` §14**
- [x] **An admin enabling MFA for a user locked them out.** ✅ Fixed 2026-08-16. `Users.jsx` called `enableMfa` and discarded the returned secret — the code even said *"In a real app, you'd show the secret/QR code here"* — while showing "MFA has been enabled". The secret is returned **exactly once** and is the only way to enrol. Combined with the session revocation added above, the user was signed out of an account that now demanded a code **nobody on the property could produce**. The secret and `otpauth://` URI are now shown in a hand-off dialog that says it will not be shown again and to pass it over in person; if the server returns success with no secret, the dialog says so plainly instead of claiming success. **OBSERVED — `probe-auth-hardening` §16**
- [x] **The offline dev shim does not implement any of this.** Recorded, not fixed. `handleLocalUserAdmin` in `base44Client.js` resolves no actor at all, so there is nothing to step up against; a half-mirrored check would read as protection that is not there. The divergence is documented in a comment above the shim's `enable_mfa` branch. It is reachable only with `VITE_USE_LOCAL_AUTH=true`, which `.env.development` sets and production does not. **OBSERVED**

#### Found and fixed during remediation — not in the original audit

- [x] **Cross-tab session revocation never fired.** ✅ Fixed 2026-08-16. `auth.getCurrentSession()` read `localStorage.getItem(LOCAL_SESSION_KEY)` raw, but both writers use `secureStore()`, which AES-GCM encrypts the value *and* prefixes the key — so it looked in a slot nothing ever writes and **returned null for every signed-in user**. `AuthContext.handleCrossTabRevocation` resolves identity as `user?.id ?? session?.userId`, so in any tab that had not yet hydrated `user`, an admin disabling an account was a silent no-op: `if (!selfId) return`. Fixed by extracting `readLocalSessionRecord()` as the single reader shared with `getLocalSessionUser()`, so the two copies cannot drift again. `scripts/test_bulletproof_auth.mjs` went **33 passed / 7 failed → 40 passed / 0 failed**, and `test_realtime_revocation.mjs` from dead-on-arrival → **26 passed / 0 failed**. Worth noting honestly: those 7 failures had been recorded earlier in this effort as environment limits (BroadcastChannel under Node). That was wrong — they were this defect, and the mislabel is what hid it. **OBSERVED**
- [x] **`PrematureCommitError` on every timecard import.** ✅ Fixed 2026-08-16. A dynamic `await import("@/lib/timecardCalc")` sat inside the timecard import's Dexie transaction zone (`reportParsers.js:1375` at `d17e9e4`). A dynamic import is a macrotask, so awaiting it left the zone and Dexie committed early — the B6 failure mode, mid-import, with rows already written. Hoisted to a static import. Only surfaced once the test harnesses were made to authenticate, which is why the original audit missed it. **OBSERVED**
- [x] **Two auth-suite fixtures could never log in.** ✅ Fixed 2026-08-16. `test_realtime_revocation.mjs` seeded users with `hashPassword()` from `@/lib/security.js`, but `handleLocalAuthLogin`'s `isBrowserHash` check only trusts the `$pbkdf2$`-prefixed form from `browserHashPassword()`. The seeded hash was rejected, the shim fell through to the remote backend, and the suite died on "Backend authentication required" at its first test — so **none of its assertions had ever executed**. **OBSERVED**
- [ ] 🔑 **OWNER ACTION REQUIRED — rotate your account password.** A file at the repository root, `test-auth.cjs`, hardcoded **your real email address and your real password** in plain text. It was a 50-line one-off puppeteer debug script that enumerated IndexedDB users; it was referenced by nothing (not `package.json`, not any tracked file), and it could not even run, because `puppeteer` is neither declared nor installed. It was **deleted 2026-08-21** rather than patched, since a credential is not something to tidy up in place. The working tree is now clean — a content search for the password returns no matches.

  **Deleting the file does not undo the exposure.** The value is still recoverable from git history, in `test-auth.cjs` and also in `HEAD:src/api/authLocal.test.js`, and rewriting that history is your call, not mine — it would break every existing clone. **Treat the password as compromised and change it.** If it was reused anywhere else, change it there too. Rewriting history is optional; rotating the password is not, and rotating is sufficient on its own.

  Why it survived this long is the finding worth keeping, because it is the same gap as #27: **a root-level `.cjs` file sits outside every gate this repo has.** `eslint.config.js` ignores `*.cjs`, `jsconfig.json` type-checks only `src/`, and `scripts/verify-all.mjs` discovers only `probe-*`/`verify-*` under `scripts/`. Nothing was ever going to look at it. `probe-deploy-config` §9 now closes the class: it fails if that file returns, and it fails if **any** root-level `.js`/`.cjs`/`.mjs` assigns a literal to a password/secret/api-key/token name. `password: process.env.X` stays legal, since reading a secret from the environment is the correct pattern. The assertions deliberately do not contain the credential they defend against. **OBSERVED — `probe-deploy-config` §9, 99/0; mutation-verified (restoring the file fails it, hardcoding a literal fails it, the same literal read via `process.env` correctly does not)**

### Money
- [x] **Draft payroll reduces a Dashboard money figure.** ✅ Fixed 2026-08-16. `src/lib/ownerIntelligence.js:224` — `payroll.reduce((a, p) => a + Number(p.total_pay || 0), 0)` with no `filterCommittedPay`, violating the contract stated at `src/lib/payrollCalc.js:185`. Proven by probe: a `draft` run of $70,000 against $100,000 revenue yields `sumCommittedPay = 0` but fired a $5,000 leak alert reading *"Total costs are 70.0% of revenue"*, reaching the user via `Dashboard.jsx:395-397` as a headline `money(totalLeakage)`. Now routed through `filterCommittedPay`, so the Dashboard, Money Kept, Expenses, Forecasting and the Action Center all describe the same month the same way. **OBSERVED — `scripts/probe-profit-leakage.mjs` 14/0**
- [x] **All-time payroll compared against period revenue.** ✅ Fixed 2026-08-16. `detectProfitLeakage` never date-scoped payroll or expenses while `grossRevenue` *was* period-scoped, and `Dashboard.jsx:70-72` fetches `PayrollRun` with no date range at all. Measured: with last year's $500,000 of payroll on file and a March filter over $100,000 of revenue, it reported *"Total costs are 530.0% of revenue"* and a **$465,000** leak that described no real period. `detectProfitLeakage` now takes `dateRange` (threaded from its sole caller, which already received one) and scopes both arrays with `inRange`. The dollar figure is computed in integer cents. **OBSERVED**
- [x] **`parseAmount` inverts the sign of `$-5`** ✅ Fixed 2026-08-16. `src/lib/csvParser.js` read the sign off the raw string before stripping `$`, so `startsWith("-")` was false and the `-` was then stripped unconditionally: **a refund written `$-50.00` booked as +$50.00**, straight into `TransactionLine.amount` via `reportParsers.js:230`. `$(50.00)` had the same inversion, and trailing-minus (`50.00-`) was never handled. The sign is now read after the symbol and separators are stripped, and all three conventions parse correctly. `null` vs `0` remains distinguishable, which `importValidation.js:87` depends on. **You no longer need to confirm which negative style your PMS exports** — `$-50.00`, `-$50.00`, `($50.00)`, `$(50.00)` and `50.00-` all book as −50. **OBSERVED — `scripts/probe-parse-amount.mjs` 28/0**
- [x] **The Action Center's payroll alarm had never been exercised.** ✅ Fixed 2026-08-16. `scripts/verify-actioncenter.mjs` had been failing on `payroll investigate fires` since before this effort began (proven identical at `d17e9e4`). The engine was correct; the **fixture** was wrong — `payrollRun()` omitted `payroll_status`, so `isCommittedPayroll` defaulted it to `"draft"` and the engine rightly ignored it. The fixture now sets a status explicitly, and two negative cases were **added**: a draft run above the guideline must not fire, and payroll outside the window must not fire. The assertion was strengthened, not weakened. **OBSERVED — `verify-actioncenter` now fully green**

### Data & UI
- [x] **Second, unhardened CSV importer on a live route.** ✅ Fixed 2026-08-16. `/manual-entry` (`src/App.jsx:253`) had its own parser using naive `line.split(",")` (`ManualEntry.jsx:279-287`) — the only naive split left on a live import path, writing straight to real entities (`:412-414`).

  Reproduced before fixing (probe section 0 keeps the old algorithm and asserts what it did): `"Smith, John"` split into two cells, so `code` became `"John"`, `net_revenue` became `"WI"` and **the revenue figure was lost entirely**; a quoted newline tore one row into two; and worst, **a CSV exported for a different report imported as a full row of zeros** — every unmatched numeric column defaulted to `0` with no message, which is indistinguishable from a real zero once saved.

  Both paths now go through the new `src/lib/manualEntryImport.js`, built on the already-hardened `parseCsvText`. Columns match on normalised key *or* visible label (first occurrence wins, so a duplicated header cannot overwrite the column the user can see); numbers go through `parseAmount`, so `"$1,234.56"` now imports instead of failing `Number()` at save time; dates go through `convertDate`. **Nothing is ever silently defaulted** — an unmatched column or unreadable cell is left blank and named in a warnings panel, because a fake `0` is invisible on the dashboard while a blank is not. A file matching no columns is refused outright rather than imported as zeros. Also added: a 10MB cap matching the report path, a NUL-byte binary check (`accept=".csv"` is only a dialog filter), and the file input is now mounted page-level so the Import button works from the empty grid. **OBSERVED — `scripts/probe-manual-entry-import.mjs` 45/0**

  *Correction to this item as originally written:* the BOM claim was **wrong**. `String.prototype.trim()` removes U+FEFF, and the legacy code trimmed every header, so a BOM did not break the upload path. It did survive in the **paste** path, which never trimmed — as did the `\r` from CRLF clipboard data. Both are fixed and both facts are now pinned by assertions so the incorrect claim cannot be reintroduced.

  *Still true, deliberately not changed:* manual entry writes **without an `ImportSession`**, so these rows have no undo — unlike report imports, which B7 made rollback-able. Dedupe was already correct here (`handleSave` builds the same key the report path uses, so manual rows cannot double-count against imported ones), and validation now runs before any write, with **nothing written at all if any row fails**. Giving manual entry a rollback ledger is a larger change than this defect warranted; the practical consequence is that a bad manual save must be corrected by editing the rows, not undone in one action.
- [x] **Rows with data but no date were dropped in silence.** ✅ Fixed 2026-08-16. `handleSave` began `if (!row.date && !row.shift_date) continue;`, so a row carrying revenue but no date was skipped, excluded from the `N records saved` count, and reported as a **success**. It is now counted and refuses the save with `"N rows have data but no date"`. Genuinely blank grid lines are still ignored, since those are unused rows rather than lost data. **OBSERVED — lint and typecheck clean; no harness coverage for this page (React page, cannot run headlessly here)**
- [x] **Every message on `/manual-entry` rendered in success green.** ✅ Fixed 2026-08-16. `saveMsg` was printed as `text-[#00E096]` unconditionally (`:575`), so `"Not saved — …"`, `"Rate limited"`, `"Invalid security token"` and `"You do not have access to the selected property"` all looked like confirmations. Severity is now explicit at every call site and resolved through a `MSG_TONE_CLASS` lookup rather than a ternary, so a new tone cannot fall through to green; errors also carry `role="alert"`. Errors that leave the grid empty are shown in a page-level panel, because the inline message sits inside the `rows.length > 0` block and would otherwise be invisible in exactly the case where the user needs it. **OBSERVED**
- [x] **No page distinguishes error from empty.** ✅ Fixed 2026-08-16. The item as written understated it: `isError` appeared in **zero** page files, and the reason was structural rather than twenty separate oversights. `src/lib/query-client.js` sets no `throwOnError` and the query functions in `useHotelData.js` do not catch, so a rejection leaves `isError: true` with `data: undefined` — and **every page destructured `const { data: rows = [] } = useX()`. That `= []` default is the swallow.** One idiom, repeated everywhere, converted every failed read into a normal-looking empty page.

  Twenty pages now capture the query object alongside the data and render the shared `<ErrorState>`: ActionCenter, AuditLog, ChartBuilder, Compare, Dashboard, DataIntelligence, Employees, Expenses, Forecasting, Housekeeping, MonthlyCalendar, MtdGrowth, OtaChannels, Payments, Payroll, Pricing, Reviews, RoomBoard, Statistics, Transactions, Users. The `= []` defaults were left byte-identical, so no downstream calculation changed. Each message names the specific consequence of trusting the blank version rather than saying "something went wrong" — Payroll's says *"Do not run payroll again until this loads — that would pay the same period twice"*; RoomBoard's says the board it would otherwise draw shows every room clean and empty, which a front desk reads as "available" and sells twice; MtdGrowth's says a 0.0% delta would be indistinguishable from a genuinely flat period.

  Two shapes are in use and both are real: most pages render `<ErrorState>`, while AuditLog and Users load imperatively into a `loadError` state and render a dedicated row inside the table so the filters stay usable.

  **Deliberately still open, and recorded rather than forgotten:** `Import.jsx`, `ManualEntry.jsx` and `Settings.jsx` still default a failed read to empty. All three are write-first pages whose blank state is far less misleading than a financial report's, and the probe prints the residual list on every run and **fails if that list grows**. **OBSERVED — `scripts/probe-ui-feedback.mjs` 83/0; lint and typecheck clean. Not verified in a browser — the probe is static and does not render React.**
- [x] **A whole toast system rendered nothing.** ✅ Fixed 2026-08-16 — **found while wiring the delete guards, not in the original audit.** The app uses two toast libraries: radix `useToast` (8 callers) and sonner's `toast` (3 files, 22 calls in Expenses and DataIntelligence). Only the radix `<Toaster />` was mounted; `src/components/ui/sonner.jsx` is imported by **no file**. In `node_modules/sonner/dist/index.mjs` the dispatch is `subscribers.forEach(...)` and the only subscribers in the package are `useSonner()` and its own `<Toaster/>` — with neither mounted, **every sonner call dispatched into a store with no subscriber and displayed nothing at all**, including a failed delete, a rate-limit refusal and an invalid-CSRF refusal. Fixed by mounting sonner's `Toaster` in `App.jsx` (two lines, versus rewriting 22 call sites) at `position="top-right"`, because the radix viewport sits bottom-right on `sm` and up. The probe now asserts the general rule: every toast system with callers has its renderer mounted. **OBSERVED — `probe-ui-feedback` §1**
- [x] **Failed writes reported as successes on the room board.** ✅ Fixed 2026-08-16. `RoomBoard.jsx` had `Room.update(...).catch((e) => console.warn("Room update failed:", e))` followed **unconditionally** by `setNotice({ type: "ok", text: "Checked in …" })`: the guest was written, the room was never marked occupied, and the operator was told the check-in succeeded — the board then still showed the room sellable. Three fixes: the stay `create` reports its own failure and says *"Nothing was saved — the guest is not on the board"* (leaving the form filled for a retry); an unmatched room number no longer throws on `room.id` after the stay is written; and a stay that saves without its room status now renders **amber**, not green or red, naming exactly what did and did not happen. The bootstrap `bulkCreate` and the housekeeping status taps report failures too — `bulkCreate` is not wrapped in a transaction, so the message says rows may already exist and pressing again would duplicate them. **OBSERVED — `probe-ui-feedback` §3**
- [x] **Five more failures that were swallowed into `console` or a plausible-looking fallback.** ✅ Fixed 2026-08-16, found while sweeping for the pattern above.
  - `Employees.jsx` fell back to `managerUserId: "manager"`, `managerName: "Manager"` whenever `db.auth.me()` had failed — so a fraud-anomaly sign-off wrote a permanent `ANOMALY_SIGN_OFF` audit row and a `reviewed_by_name` **attributing the review to nobody**. It now refuses the sign-off and says the account could not be identified.
  - `Settings.jsx` wrapped both audit writes in `catch { console.error("[audit] …") }` while the setting itself had already been applied — the operator saw "Saved" and the audit trail silently lost a commission-rate or tax-rate change. Now says *"Saved, but not logged"* and names the reason, distinguishing a failed save from an unlogged one.
  - `Settings.jsx` MFA enrolment ended `.catch(console.error)`, leaving the dialog saying "Scan the QR code" over a **blank canvas**. It now explains the failure and points at the manual secret key, which still works.
  - `OtaChannels.jsx` had `catch (e) {}` around the PDF export: a failed export reset the button to "Export PDF" with no message, which is indistinguishable from a file that saved to the downloads folder.
  - `usePricing.js` discarded all three of its query objects (`useRooms`, `useReservations`, `useWeatherSnapshots`), and `buildPricingForecast` answers empty inputs with base rates and a default occupancy assumption — so a failed reservation read produced a **complete, confident 14-day rate card** on both `/pricing` and the Dashboard panel. The hook now exposes `isError`/`error`/`refetch` and both consumers render it. **OBSERVED — `probe-ui-feedback` §4**
- [x] **An unscoped raw table read on the Data Intelligence page.** ✅ Fixed 2026-08-16. `useFiles()` read `localDb.UploadedReport.toArray()` directly, bypassing the property scope that `db.entities` applies — so the file browser and preview pane listed uploads belonging to properties the user cannot access. Now `db.entities.UploadedReport.list()`, which is what every other reader of that table already uses (`useHotelData`, `dataScanner`, `uploadRetention`, `Import`). Same defect class as B4. **OBSERVED — `probe-ui-feedback` §4**
- [ ] **A disabled user is told the wrong reason.** `AuthContext.validateCurrentAccountStatus` has `'disabled'` and `'locked'` branches that are **unreachable**: both auth backends drop the record before the caller sees it — the local shim in `getLocalSessionUser()`, and `base44/functions/custom_auth_me/entry.js`, which answers `401 {user: null}` on `!user.is_active || user.is_locked`. So `me()` is null and the status collapses to `'revoked'`. Revocation itself works correctly; the user is simply told "session revoked" instead of "your account has been disabled — contact your administrator". Fixing it means changing that function's 401 contract to report a reason to a caller who already holds a valid session cookie for that account. The current contract is pinned by assertions in `scripts/test_realtime_revocation.mjs` Tests 2 and 3 — update them together with any fix. **OBSERVED**
- [x] **`'Failed Login'` renders as a blue success badge.** ✅ Fixed 2026-08-16. `ACTION_BADGE` tested for `"Login"` before `"Failed"`, so the substring match on the friendlier word won and every row B10 made loggable was coloured as an ordinary login. Fixing it surfaced **two more defects on the same page**: the audit **category filter was dead** — it matched SCREAMING_SNAKE actions (`AUDIT_CLEAR_ATTEMPT`) while `custom_auth_login` and `custom_user_admin` write Title Case (`"Failed Login"`), so filtering by category hid the very rows the filter was for; and a `result: 'pending'` row rendered in failure red, which for a two-step admin action reads as "it failed" rather than "it has not finished". All three are fixed and the matching is now order-independent. **OBSERVED — `scripts/probe-audit-filter.mjs` 48/0**

---

## 🟡 MEDIUM

- [ ] **`applyPropertyFilter` silently widens a single-property query.** A caller passing a plain string `property_id` has it *replaced* by the user's entire allowed set (`base44Client.js:424-434`). Not a leak — stays within authorised scope — but a query for one property returns the sum of several. Against an exact-cent requirement, that is a correctness defect. Intersect instead of replace. **OBSERVED**
- [x] **`convertDate` accepts impossible dates.** ✅ Fixed 2026-08-16. `"13/25/2026"` → `"2026-13-25"` and `"31-Feb-26"` → `"2026-02-31"` were both accepted, and because date filtering is string comparison, such a row is **invisible to every date-range query while still counted in unfiltered totals** — a reconciliation mismatch with no visible cause. `convertDate` now validates the calendar (month 1–12, day within that month's real length, leap years included) and `isIsoDate` rejects the same impossibilities, so a bad date is refused at the parser rather than persisted. `"not a date"` is refused instead of ingested. The `"1-Jan-99"` → 2099 pivot is unchanged and deliberate: a two-digit year is genuinely ambiguous, and the pivot is documented rather than guessed at per-row. **OBSERVED — `scripts/probe-date-validation.mjs` 42/0**
- [x] **Financial records delete on one unconfirmed click.** ✅ Fixed 2026-08-16. `Payroll.jsx` staff and payroll-run deletes had **no confirmation, no CSRF and no rate limit**; `Expenses.jsx` had CSRF and rate limiting but still no confirmation — so one mis-click on a phone permanently removed a payroll run. Rather than copy fifteen lines four times, all four now go through a single new `src/lib/deleteGuard.js`, which runs **confirm → rate limit → CSRF** in that order. The order matters: `sensitiveActionRateLimiter.check()` consumes a slot on **every** call, so validating before asking would let three cancelled mis-clicks burn the operator's budget for a delete they do want. The token is rotated only *after* the write, since rotating first invalidates the token the write is authorised by, and a missing `window.confirm` returns **false** — no dialog means no informed consent was obtained.

  The dialogs name the record, not the noun: employee name, `employee_id`, department and rate; expense name, amount, vendor, category and frequency. Two consequences are stated explicitly because they are counter-intuitive: deleting a Staff row **does not** damage payroll history (runs store `employee_name`, and `employee_id` is a display label that is deliberately reissued — see `src/lib/employeeId.js`), and deleting an **approved or paid** payroll run *increases* reported Money Kept, so the dialog gives the exact dollar amount it will move. `Expenses.handleDeletePayroll` also had no error handling at all: a rejection left the row on screen with no message, which reads as "the click didn't register".

  The probe's static half enumerates every `delete`/`bulkDelete`/`clear` call site in `src/pages` and fails if a new one appears without a confirmation upstream, so this cannot silently regress. **OBSERVED — `scripts/probe-delete-guard.mjs` 61/0**
- [ ] **Duplicate/long-row cell loss.** `rowsToObjects` uses `obj[h] = row[i] || ""`, so a repeated column name keeps only the last value and extra cells are dropped (`csvParser.js:122-135`). Flagged by `validateStructure` — but only for the types that actually run validation, which excludes transactions and statistics. **OBSERVED**
- [x] **Shadow Money Kept implementations with wrong gating.** ✅ Fixed 2026-08-16. `src/lib/calculationService.js:194` (`calculateMoneyKept`) and `:234` (`calculateProfitMetrics`) omitted the committed filter, and `keepRate` guarded `gross > 0` while dividing by `gross - refunds - estimatedTaxes` — a full-refund or all-tax period returned `Infinity` as a percentage. Both now filter through `filterCommittedPay`, and the rate guards its actual denominator. Still **zero call sites**: kept rather than deleted because they hold the tax and keep-rate logic, but note they duplicate the live `MoneyKept.jsx` widget — if you ever wire one up, reconcile the two deliberately. **OBSERVED**
- [x] **AI cost totals skip the committed filter.** ✅ Fixed 2026-08-16. `costTotals` in `src/lib/aiEngine.js` summed every payroll run, so the assistant quoted a payroll figure and a net profit that no page agreed with, across three answers (`intentSummary`, `intentExpenses`, `intentProfit`). Now filters to approved/paid and sums in integer cents. The *"(N records)"* caption beside the total also counted the unfiltered set — it now reads *"(N committed of M records)"* so the caption cannot describe a different set of rows than the number next to it. **OBSERVED**
- [ ] **Headline Money Kept uses float dollars throughout.** `MoneyKept.jsx` imports no decimal helper: `:178` `comm = rev * info.rate`, `:445-446` `kept = gross - totalDeductions`, `:531`. Each line item is snapped at `:381`, so residual is ~1e-10 and invisible after formatting — **materially safe, but a direct violation of the integer-cents directive on the flagship figure.** Same class at `statisticsAnalytics.js:199-203` and `paymentNorm.js:84,89`. **OBSERVED**
- [ ] **Password rules disagree and the weaker one wins.** Client requires 12+ with a special character; server `createUser` requires 8 with upper/lower/digit; `set_password` requires **length ≥ 8 only**. The server is authoritative. **OBSERVED**
- [ ] **Welcome email contains the plaintext temporary password.** Use a single-use invite link. **OBSERVED**
- [ ] **CSRF cookie lacks `Secure` and host-binding.** `securityUtils.js:260` sets `csrf_token` with `Path=/; SameSite=Lax` only — no `Secure`, no `__Host-` prefix, so it is subdomain-writable. Client validation also fails open at `:278` (`if (!ss) return true`). Server-side double-submit still validates. 🔒 protected file. **OBSERVED**
- [ ] **`audit_list` forwards a client-supplied filter object straight to the datastore.** Admin-gated, but unvalidated. **OBSERVED**
- [ ] **`touchSession` and `rotateSession` are no-ops.** `AuthContext.jsx:78` calls `touchSession()` believing it extends the session; it does nothing. `rotateSession` has **zero callers** — confirming there is no session rotation anywhere, which compounds the revocation gap above. **OBSERVED**

---

## 🚀 DEPLOY & INFRASTRUCTURE

- [x] **No SPA rewrite in `vercel.json`, and the app uses `BrowserRouter`** (`src/App.jsx:7`). ✅ Fixed 2026-08-16. There was no `rewrites`/`routes` key at all, so every deep link and every hard refresh on a non-root route depended on whatever fallback Vercel's Vite preset happens to supply. `vercel.json` now declares the catch-all explicitly: `{"source": "/(.*)", "destination": "/index.html"}`. A catch-all is safe here because Vercel checks the filesystem *before* applying rewrites, so `/assets/*`, `/manifest.json`, the icons and any future function route are still served as themselves. **Still do the manual check** — deploy a preview, open `/transactions`, press refresh. The config is now correct by inspection, but only a real request proves it. **OBSERVED (config) — `scripts/probe-deploy-config.mjs` §1. NOT RUN (a real request)**
- [x] **The CSP blocked the CSV import path in production, and a `<meta>` tag hid it.** ✅ Fixed 2026-08-16 — **this turned out to be the serious defect in this section, not the cosmetic one.** `index.html` carried a *second* CSP as `<meta http-equiv>` that allowed `blob:` in `connect-src` while the real header in `vercel.json` did not. When a document is delivered with both, the browser enforces the **intersection**, so the wider-looking meta tag could never widen anything — it was a decoy that made the policy look correct while the header governed. And `blob:` is not cosmetic here: `UploadFile()` returns a **blob: URL** (`base44Client.js:1200`), which `csvParser.js:261` and `DataIntelligence.jsx:139` then `fetch()`. `'self'` does not cover `blob:`. Every CSV import and every Data Intelligence scan went through a `fetch()` the deployed policy forbade.

  The meta CSP is gone, along with the `meta http-equiv` copies of `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy` and `Permissions-Policy` (all four are **ignored by browsers** when set that way, and their presence disguised the fact that `vercel.json` was the only thing enforcing them). There is now one policy, and `vite.config.js` derives both the preview and dev policies from the same string so `vite preview` reproduces production instead of merely resembling it. Added deliberately: `connect-src blob:` and `worker-src 'self' blob:` (the parser runs in a module Worker, `csvParser.js:275`), `img-src blob:` and `font-src data:` (html2canvas/jspdf render the PDF exports through a canvas and inline fonts as data URLs). **OBSERVED — `probe-deploy-config` §2/§3, which asserts the premise from the source it governs rather than trusting the directive list.**
- [x] **CSP `connect-src 'self' https: wss:` permitted exfiltration to any HTTPS origin.** ✅ Fixed 2026-08-16. Now `connect-src 'self' blob: https://base44.app https://*.base44.app` — the SDK's own base URL (`https://base44.app`, read out of the installed package) plus same-origin and the blob URLs above. `wss:` was removed because **nothing connected over it**: see the websocket item below. The script axis was already strong (no `unsafe-eval`, no script `unsafe-inline`) and stays that way. `img-src` deliberately keeps `https:` — uploads resolve to storage hosts this review could not enumerate, and a wrong allowlist there breaks images silently. **OBSERVED**
- [x] **Every production page load opened a websocket to the viewer's own machine.** ✅ Fixed 2026-08-16 — **not in the original audit; found while deciding whether `connect-src` still needed `wss:`.** `src/crdt.jsx:4` read `process.env.REACT_APP_WEBSOCKET_ENDPOINT` — a Create React App variable name Vite does not substitute, on a `process` object that does not exist in the browser — so the `typeof` guard always fell through to the hardcoded default `ws://localhost:1234`. `YDocProvider` wraps the entire app (`App.jsx:308`), so every deployed page load tried to open a plaintext socket to the *user's own* port 1234: blocked as mixed content on an https page, blocked again by the CSP, then retried on a backoff loop for as long as the tab stayed open. y-websocket reports that failure asynchronously, so the surrounding `try/catch` never saw it. The endpoint now comes from `import.meta.env.VITE_WEBSOCKET_ENDPOINT` and **connecting is skipped entirely when it is unset**. Nothing is lost: `useYDoc` is consumed only by `src/pages/DemoYDoc.jsx` at `/demo` and `src/lib/ySync.js` is imported by no file, so no real data ever crossed this transport. **OBSERVED — `probe-deploy-config` §2**
- [x] **`public/manifest.json` was not valid JSON.** ✅ Fixed 2026-08-16 — **not in the original audit.** The file began with a line of JavaScript (`const db = globalThis.__B44_DB__ || { auth:{ … } };`) that some codemod had prepended to it, so `JSON.parse` failed and **the browser discarded the entire manifest** — no name, no theme colour, no icons, not installable. It shipped that way: `dist/manifest.json` has the same first line. Rewritten as valid JSON, and `orientation` changed from `"portrait"` to `"any"` — an installed copy locked to portrait cannot display the room board or the transaction table on a tablet. `scope` and `id` are now declared so the install identity is stable. **OBSERVED — `probe-deploy-config` §4, which parses the file rather than pattern-matching it**
- [x] **Favicon and both manifest icons loaded from `https://db.com/logo_v2.svg`.** ✅ Fixed 2026-08-16 — an unrelated third-party domain (Deutsche Bank), a base44 template leftover, pinged on every load of a private hotel dashboard. Replaced with local assets generated for this app: `public/favicon.svg` plus `icon-192.png`, `icon-512.png` and `apple-touch-icon.png` (a red roof over a dark building with a rising bar chart, in the app's own palette). The PNGs are full-bleed so they are safe as maskable icons. The probe verifies each PNG's real pixel dimensions against the size the manifest declares, because a mismatch there is rejected by the install prompt for a reason nobody can see. **OBSERVED**
- [x] **`Cross-Origin-Opener-Policy` and `Cross-Origin-Resource-Policy` were set in the dev-server headers but missing from `vercel.json`** — dev was hardened more than production. ✅ Fixed 2026-08-16; both are now served on every response, and `vite.config.js` derives the dev headers *from* the production set so this particular asymmetry cannot recur. `COEP` was deliberately **not** added: `require-corp` would break the third-party images that `img-src https:` exists to allow. **OBSERVED**
- [x] **Viewport blocked zoom** — `user-scalable=no, maximum-scale=1.0` (`index.html:6`) fails WCAG 1.4.4. ✅ Fixed 2026-08-16; both removed, `viewport-fit=cover` kept for notched devices. Someone reading a transaction row on a phone at the front desk can pinch-zoom again. **OBSERVED**
- [x] **Hashed assets were not cached.** ✅ Fixed 2026-08-16 — a `/assets/(.*)` rule now serves `Cache-Control: public, max-age=31536000, immutable`. This is only safe because `vite.config.js` content-hashes every asset filename, so the probe asserts that precondition in the same breath rather than trusting the header alone. HTML caching is left to Vercel's default (`max-age=0, must-revalidate`), which is already the correct behaviour for an SPA shell. **OBSERVED (config) — INFERRED (Vercel's documented default for static HTML; not verified against a live response)**
- [x] **`leaflet` was a phantom dependency.** ⚠️ Resolved by removing the dependence, not by adding the package. `vite.config.js` `manualChunks` named `leaflet`, which is absent from `package.json` and present only because npm auto-installs `react-leaflet`'s peer. But the only file that imports `react-leaflet` — `src/components/propertyMap.jsx` — **is imported by nothing**, so neither package is in the module graph and that chunk was empty. `manualChunks` groups modules, it never pulls them in, so the entry was deleted: no output changes and the build config no longer names an undeclared package. **If the map is ever wired up, run `npm i leaflet@^1.9.4` first.** I could not add the declaration here: `npm install --package-lock-only` needs the registry (`ENOTCACHED` offline), and hand-editing `package-lock.json` to match would risk breaking `npm ci` — a worse failure than the one being fixed. **OBSERVED**
- [ ] **`npm run build` — NOT RUN.** Cannot execute in this Linux VM: `node_modules` is a Windows install (`@rollup` has only `win32-x64`) and the npm registry is unreachable. **You must run this on your Windows machine before deploying.** A green lint and typecheck do not prove the bundle builds. The same constraint means `npm run test` (vitest) is **NOT RUN**.
- [ ] **Rebuild `dist/` before deploying.** It is stale for certain now: `dist/index.html` still points the favicon at `db.com` and `dist/manifest.json` still carries the JavaScript line, and the new icon files do not exist in it at all. (`dist/` is correctly gitignored and is not what Vercel deploys — Vercel builds from source — so this only matters for a local `vite preview`.)
- [ ] **Confirm production environment variables in Vercel:** `AUDIT_CHAIN_SECRET` must be set (see B9), and `VITE_USE_LOCAL_AUTH` must not be `true`. The flag fails safe — `USE_LOCAL_AUTH` requires the exact string `'true'` and `src/main.jsx:13` refuses to boot a production build that has it — so its **absence** is correct and no `.env.production` is needed on Vercel. Note that `.gitignore` ignores `.env.*`, so a fresh clone has no `.env.development` either and `npm run dev` will talk to the real backend until you create one. **OBSERVED**
- [x] **A dead CSP generator that could only do harm — deleted 2026-08-20.** `base44/lib/securityHeaders.js` presented itself as the production header generator, and its `buildCompleteCsp()` emitted `'unsafe-inline'`, `'unsafe-eval'` and a blanket `https:` in **both** `default-src` and `script-src` — the primary XSS control switched off — together with HSTS `31536000`, no `worker-src`, and a bare unquoted `self`, which CSP reads as a hostname rather than the keyword. It could not even run: `package.json` declares `"type": "module"` and nothing under `base44/` overrides that, so its `module.exports = {…}` assigned to Node 22's *global* `module` function instead of throwing, and importing it yielded **zero exports**. Nothing imported it, so its only reachable use was a human pasting `buildNginxSnippet()` output into a real server — a file that hands an operator a broken policy while looking authoritative. Deleted rather than corrected, because the root cause of the header drift was four hand-maintained copies and reducing that to three beats adding a fourth thing to keep in step. `probe-deploy-config` §3 now fails if it returns or if any undeclared file defines a policy. **OBSERVED**
- [ ] **One server-shaped module still sits under `base44/lib/`.** `base44/lib/corsConfig.js:19` reads `process.env.ALLOWED_ORIGINS` at **module scope**. `process` does not exist in the browser and Vite does not shim it, so importing it from anything reachable by `src/main.jsx` is an immediate `ReferenceError` on load — a blank page, not a degraded feature. It shares the CommonJS-in-an-ESM-package defect described above, so it exports nothing today either. **Nothing imports it**, which is the only reason this is not already a live defect, and it is left in place on that basis rather than edited. If it is ever wired up, note first that its allowlist hardcodes `http://localhost:5173`, `http://127.0.0.1:5173` and `http://localhost:3000` *in addition to* whatever `ALLOWED_ORIGINS` names, so any developer's machine would be a permitted credentialed origin against production. `probe-deploy-config` §6 fails if anything imports it or if a new file adopts the same shape. **OBSERVED**
- [x] **`npm run ws` could never start — the sync server was dead on arrival.** ✅ Fixed 2026-08-21 — **not in the original audit; found by widening the typecheck (see #27).** Two independent defects in `backend/websocket.js`, the second hiding behind the first.

  It imported `setupWSConnection` from `'y-websocket'`, but that entry point exports the **client** surface (`WebsocketProvider`, `messageSync`, …); the server helper lives on the `'y-websocket/bin/utils'` subpath. Node rejects an unresolvable named import at load time, so the process died before `listen()` with `SyntaxError: The requested module 'y-websocket' does not provide an export named 'setupWSConnection'`. Reproduced in the terminal, and the probe reproduces it on demand.

  Fixing only that import would have been **worse than the crash**, which is the part worth recording. The call was `setupWSConnection(socket, head, { docName })` — the real signature is `(WebSocket, IncomingMessage, opts)`, and it was being handed the raw TCP socket and the upgrade `head` buffer, with no handshake ever performed. Measured failure sequence: a `net.Socket` **is** an EventEmitter, so `setupWSConnection`'s `conn.on('message'|'close'|'pong')` registrations all succeed in silence; it then calls `send()`, which compares `conn.readyState` against the numeric WebSocket constants `0`/`1`, while a `net.Socket` reports the **string** `'open'` — so `send()` concludes the peer is gone, calls `closeConn()`, and that ends in `conn.close()`, which a `net.Socket` does not have. `TypeError: conn.close is not a function`, thrown into the existing `try/catch`, which destroys the socket and logs a generic validation error. The client would have seen an ordinary dropped connection and `crdt.jsx` would have fallen back to offline mode. **A server that starts, listens, and silently rejects every connection is harder to diagnose than one that refuses to boot** — so the handshake was implemented properly (`new WebSocketServer({ noServer: true })` and `wss.handleUpgrade(req, socket, head, ws => setupWSConnection(ws, req, { docName }))`) rather than patched to the point of looking healthy.

  The auth block (cookie → token → `base44.auth.me()` → `is_active` → `property_access`) is **byte-for-byte unchanged** — it was correct, and the diff shows it only as context.

  **Nothing at launch depends on this**: `src/crdt.jsx` skips connecting entirely unless `VITE_WEBSOCKET_ENDPOINT` is set, which is the state production has always been in (see the item above). This was fixed because a dead server that fails on a *different* line every time someone tries it is a trap for whoever eventually turns sync on. **OBSERVED — `scripts/probe-ws-server.mjs` 20/0, including a real handshake reaching `OPEN` and receiving Yjs sync step 1. Both mutations verified: reverting the specifier fails 4 assertions with the original SyntaxError, removing the `handleUpgrade` wrapper fails 2.**
- [x] **The lint and typecheck gates covered only a fraction of the source, and the lint gate had a silent bug that made its "0 errors" almost entirely vacuous. Fixed 2026-08-21 (playbook item #27).**

  Typecheck half: `jsconfig.json` had an enumerated `include` (8 patterns covering `src/components`, `src/pages`, `src/Layout.jsx`, `src/types`, `src/lib`), so the gate silently skipped `src/api` — including the `base44Client.js` that every entity read and write passes through — plus `src/hooks`, `src/utils`, `src/tests`, and `App.jsx` / `main.jsx` / `crdt.jsx` / `test-setup.js` at the `src` root. Replaced with the glob `["src/**/*.js", "src/**/*.jsx"]`, which cannot develop that kind of gap as the tree grows. `noEmit` was also made explicit: TypeScript applies a jsconfig's *implied* `noEmit` only to a file named exactly `jsconfig.json`, and a differently-named copy used to measure coverage therefore **emitted** — 111 stray `.js` twins, five of them twins of PROTECTED files, with no `TS5055` guard firing because the output name differs from the input.

  Lint half: three independent defects, any one of which would have gutted the gate on its own. **(1) The spread-then-`rules:` bug.** The single config object was `{ ...pluginJs.configs.recommended, ...pluginReact.configs.flat.recommended, rules: { … } }`; in an object literal the later `rules:` key *replaces* what the spreads brought in rather than merging with it, so all 61 `@eslint/js` recommended rules and every `react/recommended` rule were silently discarded, leaving only the 7 written out by hand. **(2) `.jsx` is not in flat config's default `files`**, which is `["**/*.js","**/*.mjs","**/*.cjs"]`. The old patterns named `src/components`, `src/pages`, `src/hooks` and `src/Layout.jsx`, so `src/App.jsx`, `src/main.jsx`, `src/crdt.jsx` and four `.jsx` files under `src/lib` — including the PROTECTED `src/lib/AuthContext.jsx` — were not linted at all, and reported as *ignored* rather than as an error. **(3) `*.cjs` was in `ignores`**, and since jsconfig type-checks only `src/` while `verify-all.mjs` discovers only `probe-*`/`verify-*.mjs`, a root-level `.cjs` was checked by nothing — which is how `test-auth.cjs` sat in the repo with an account password in plain text. Seven stale ignore entries for files that no longer exist were removed as well, since a stale ignore hides the return of a file you meant to keep out.

  Widening the gate immediately found 2 real defects in files it had never inspected. `src/lib/authHelpers.js:30` called `require("crypto")` inside a module that is bundled for the browser — **OBSERVED `ReferenceError: require is not defined`** on every call, including inside its own vitest suite, which had been failing invisibly because `npx vitest` cannot run in this VM. Replaced with `globalThis.crypto.getRandomValues`, which exists in browsers and in Node 18+. Its JSDoc was self-contradictory too ("a 32-character hex string (64 bytes / 256 bits)") and now matches the measured output: 64 hex characters, 32 bytes, 256 bits. `src/lib/PageNotFound.jsx` had `function PageNotFound({})` — an empty destructuring pattern (`no-empty-pattern`), now `()`.

  Four severity choices are deliberate, and each is a constraint rather than a convenience. `no-useless-escape` **cannot** be an error: 2 of its 12 reports are in `src/pages/ResetPassword.jsx`, which PROTECTED_FILES.md bars an AI agent from editing and which the one-time exception granted for this work does not cover — an error there could never legally be cleared. `unused-imports/*` is a warning because 3 of the 5 affected files (`calculationService.js`, `hotel.js`, `reportParsers.js`) carry **uncommitted edits from a concurrent session**, and auto-fixing them would overwrite another agent's in-flight work (CLAUDE.md Phase 0). `no-empty` keeps `allowEmptyCatch` because all 27 reports are best-effort `localStorage` guards that deliberately degrade instead of failing a render. `no-irregular-whitespace` skips strings, templates, regexes and comments because all 7 reports are deliberate U+FEFF byte-order-mark strippers — a BOM left in place becomes part of the first CSV header name and breaks every header lookup.

  One rule was **added**: `no-console`, at warning severity with `console.warn` and `console.error` allowed. CLAUDE.md Phase 7 requires "Zero `console.log()`" in a reviewed diff and *nothing was enforcing it*, because `no-console` is not part of the recommended set and no config object here switched it on. Measured with the rule forced on: 3 reports, all in `src/api/base44Client.js`'s ChannelManager stubs, which `vite.config.js` strips from the production bundle via `esbuild.pure`. The existing sites are deliberate and build-stripped, so a warning is the honest severity — but any *new* debug logging now surfaces in the gate instead of reaching a diff review unannounced.

  **Residual gap, disclosed rather than closed:** `**/*.ts` is lint-exempt because `typescript-eslint` is not installed and the npm registry is unreachable from this VM, and `jsconfig.json`'s `include` covers only `.js`/`.jsx`. Measured consequence: **zero `.ts` files are in the tsc program**, so `src/utils/index.ts` and the 7 `base44/functions/*/entry.ts` files are covered by *neither* gate. Separately, `src/utils/index.ts` and `src/utils/index.js` are the same `createPageUrl` helper, typed and untyped, and **nothing in the repo imports either one** — dead code plus an ambiguous module resolution, flagged for an owner decision rather than deleted here.

  A fourth defect surfaced while verifying the rewrite, in the rewrite itself, and it is the same failure mode as defect 1. The app-code block switches the core `no-unused-vars` off because `unused-imports/no-unused-vars` replaces it, but the repo-wide policy block sets the core rule and, being **later in the array**, silently undid that. Measured: 108 core-rule reports across 32 files under `src/` that were already reporting the unused-imports equivalent — `src/api/base44Client.js` alone counted 24 and 26 for the same variables. Fixed by re-asserting `"no-unused-vars": "off"` for app files in the last object of the array, which dropped the repo total from 328 warnings to 220 with errors unchanged at 0. Flat config is order-dependent, so an `"off"` is only durable if nothing after it says otherwise — a lint config is exactly as trustworthy as its last matching object.

  **OBSERVED — `npm run lint` → exit 0. Full pass: 407 files, 0 errors, 220 warnings, 0 parse errors. Coverage re-measured with ESLint's own API (`calculateConfigForFile` / `isPathIgnored`) across 25 probe paths: 61/61 recommended rules active on every one, 84 active rules on app files, nothing reporting IGNORED — against 0/61 everywhere and 4 outright-ignored probe paths before. `npx tsc -p jsconfig.json --noEmit` → exit 0, 0 `error TS` lines, 221 project files in the program, with `src/api` (5), `src/hooks` (4), `src/utils` (19) and `src/tests` (2) now included. Mutation-tested inside the newly covered files: a duplicate key plus an undefined identifier injected into `src/App.jsx`, and unreachable code into `src/lib/PageNotFound.jsx`, produced exactly 4 errors (`no-dupe-keys`, `no-undef` ×2, `no-unreachable`); both files were then restored and confirmed byte-identical by sha256, with zero mutation survivors. `scripts/probe-ws-server.mjs` still 20 passed, 0 failed.**

- [ ] **Owner action — run `npm install ws` before enabling multi-device sync.** `backend/websocket.js` needs the `ws` package for the upgrade handshake. `ws@8.21.2` is currently present and resolvable, but **only** as a transitive dependency of `engine.io-client` (`ws@~8.21.0`) — neither this project nor `y-websocket` declares it, so any dependency change could remove it without warning. I could not add the declaration here for the same reason as `leaflet` above: the registry is unreachable in this VM, so `package-lock.json` cannot be regenerated and hand-editing it risks breaking `npm ci`. Until then the server **fails loudly on purpose** — it catches the resolution error at startup and prints the exact remedy instead of a bare `MODULE_NOT_FOUND`. This only matters if you set `VITE_WEBSOCKET_ENDPOINT`; with it unset, nothing runs this file. **OBSERVED (the preflight and its message) — NOT RUN (the install itself)**


---

## ✅ VERIFIED GOOD — no action needed

Recording these so they don't get re-litigated:

**Mechanical health.** `npm run lint` → **0 errors** (OBSERVED). `npm run typecheck` → **0 errors** (OBSERVED) — a real improvement; this repo carried ~159 `error TS` lines on 2026-08-12. Working tree clean at `d17e9e4`.

> **Correction, 2026-08-21.** Both of those numbers were true and one of them was close to meaningless. Measured with ESLint's own API rather than by reading its output: `src/pages/Dashboard.jsx` had **7 rules active and 0 of the 61 `@eslint/js` recommended rules**, `src/lib/*` and `src/api/*` had **0 rules**, and `src/App.jsx` and `src/main.jsx` were **not linted at all**. The lint gate returned 0 errors largely because it was not looking. See the #27 entry under 🚀 Deploy. `npm run typecheck` was genuine but covered 185 files out of 201.


**Secrets hygiene is clean.** No live-key patterns anywhere in `src`, `base44`, `backend`, or `scripts`. No `.env` file is tracked, and none has **ever** been committed in the repo's history (OBSERVED). `.gitignore` is thorough — it excludes real PMS CSV exports, dev logs, and AI tooling that carries keys. The only "suspicious assignments" found were the sentinel string `'http-only'`.

**The local-auth shim cannot activate in production.** The flag parse is strict `=== 'true'` (`base44Client.js:1607-1609`), so `"false"` and absence both yield `false`; the whole shim is gated at `:1671-1673`; and `src/main.jsx:13-16` adds a hard refuse-to-boot guard when `PROD && VITE_USE_LOCAL_AUTH === 'true'`. Even a stray `.env.local` set to `true` — which Vite loads in all modes — is caught. **Closed.**

**`getCurrentSession()` returning truthy is NOT an auth bypass.** I flagged this myself and it was chased down: the production return has no `userId`, and its one non-test caller (`AuthContext.jsx:187-191`) consumes only `session?.userId`, falling back to `user?.id` and short-circuiting. Real auth state comes from `isAuthenticated()` → `custom_auth_me`. The function is misleading and should return `null`, but it grants no access.

**XSS sinks are clean.** Exactly one `dangerouslySetInnerHTML` (`components/ui/chart.jsx:166-182`), doubly defended by a colour allowlist *and* `DOMPurify.sanitize`. Zero `eval`, `new Function`, `document.write` in `src/`.

**RBAC route guarding is the strongest component in the codebase.** `canAccessRoute` is default-deny for unmapped paths, `PUBLIC_ROUTES` is minimal, and `ProtectedRoute` re-checks live account status on every navigation with distinct disabled/locked/restricted states.

**Error boundaries exist and work.** `TopLevelErrorBoundary` wraps the router (`App.jsx:305-318`) plus a per-route `LazyErrorBoundary` with retry. A page throw does **not** white-screen the app.

**`custom_auth_me` session handling is correct** — revoked/expired/locked checks, 30-day absolute cap, 7-day slide, explicit response field whitelist, `HttpOnly; SameSite=Lax; Secure` cookie. *Amended 2026-08-16:* the slide was correct on the server and incomplete in the browser — it extended the `Session` row but never re-issued the cookie, so the two clocks disagreed and users were signed out mid-shift by sessions the database still considered live. Fixed under 🟠 Security; everything else in this item held up.

**No privilege escalation via request body.** `custom_auth_register` always derives `permissions` from `role` server-side; `update` blocks `role`/`permissions`/`property_access`/`is_active`/`is_locked` for non-admin callers.

**The CSV parser core is well built.** `parseCsvText` is a correct character-level scanner — quoted commas, CRLF, BOM stripping, embedded newlines, `""` escaping, and unicode all verified by probe. `parseAmount` correctly handles `$`, thousands separators, and `(...)` negatives (the `$-5` case above is the one exception). No `parseFloat` arithmetic anywhere in `src/`.

**`toFixed` is display-only everywhere** — no occurrence in `src/` is a rounding step inside a calculation chain.

**`sum` is cents-safe.** `src/lib/hotel.js:46` routes through `sumCents`/`fromCents`, so every `sum(rows, key)` call site is compliant. `src/lib/financialReconciliation.js` is integer-cents end to end.

**Revenue is CHARGE-only and refunds are not subtracted.** `transactionNorm.js:214` maps `REFUND` to the payment side; `transactionAnalytics.js:69-72` sums charges only via `sumCents`. `Expenses.jsx:86` subtracting `refundTotal` is *not* a violation — those come from PaymentDay columns, a different report.

**Identical rows are preserved.** The occurrence-indexed dedupe key (`transactionNorm.js:161-182`) gives 3 byte-identical rows 3 distinct keys and stays idempotent on re-import — verified by probe, not assumed. The chunk-boundary collision hypothesis was tested and **ruled out**: `assignDedupeKeys` runs once over the whole file before chunking.

**Payroll is not double-counted on the headline surfaces.** `MoneyKept.jsx:422` gates `payInPeriod` through `filterCommittedPay` and `:435` keeps the payroll bucket out of the generic expense loop. `Expenses.jsx` and `actionCenter.js` apply the same exclusion. After the 2026-08-16 fixes, a repo-wide sweep of every place `total_pay` is summed shows **one deliberate deviation**: `Payroll.jsx:641` `payrollForMonth` intentionally counts draft runs, because it feeds a forward break-even projection against hypothetical revenue where a draft is the best available estimate of future cost. That reasoning is now written into the code so it is not "corrected" later. The page's own KPI row already shows the gross register total beside `sumCommittedPay` so the owner can see why the two differ.

**Import-page destructive actions are done properly** — `handleClearAll` and `UndoImportButton` both use confirmation + CSRF + rate limiting.

---

## 📋 VERIFICATION EVIDENCE

Two notes on reading this table. First, the original audit table recorded five suites as **NOT RUN** because the CSV fixtures under `scripts/data/` were missing and `_loader-boot.mjs` could not boot the Dexie/DOM shims; both were repaired (B11), and every one of those suites has since been run to completion. Second, the probes written during the audit are **no longer outside the repo** — 14 of them now live in `scripts/` and are part of the regression set below, so a future change that reintroduces one of these defects fails a command rather than relying on someone remembering.

Every row below was re-run at the end of the work, after the last code edit, on 2026-08-16.

| Check | Command | Result |
|---|---|---|
| Lint | `npm run lint` | **OBSERVED PASS — 0 errors** |
| Typecheck | `npm run typecheck` | **OBSERVED PASS — 0 errors** |
| Transactions ↔ statistics reconciliation | `node --import ./scripts/_loader-boot.mjs scripts/verify-transactions.mjs` | **OBSERVED PASS — 115 checks, 0 failed**, YTD revenue reconciled to `$1,020,598.17` exactly |
| Statistics | same form, `verify-statistics.mjs` | **OBSERVED PASS — 84 checks, 0 failed** |
| Money Kept | same form, `verify-money-kept.mjs` | **OBSERVED PASS — 23 checks, 0 failed** |
| Coexistence (statistics + transactions in one DB) | same form, `verify-coexistence.mjs` | **OBSERVED PASS — 23 checks, 0 failed** |
| Timecard | same form, `verify-timecard.mjs` | **OBSERVED PASS — 47 checks, 0 failed** (previously crashed at §4) |
| Source contributions | same form, `verify-source-contributions.mjs` | **OBSERVED PASS — 12 checks, 0 failed** |
| Anomaly ingestion | same form, `verify-anomaly-ingestion.mjs` | **OBSERVED PASS — 9 checks, 0 failed** |
| Action Center | same form, `verify-actioncenter.mjs` | **OBSERVED PASS — all scenarios correct** |
| Property isolation (negative cases) | same form, `probe-property-isolation.mjs` | **OBSERVED PASS — 47 checks, 0 failed** |
| Auth audit trail | `node scripts/probe-auth-audit.mjs` | **OBSERVED PASS — 56 checks, 0 failed** |
| Auth / MFA / session hardening | `node scripts/probe-auth-hardening.mjs` | **OBSERVED PASS — 105 checks, 0 failed** |
| Audit hash chain | `node scripts/probe-audit-chain.mjs` | **OBSERVED PASS — 32 checks, 0 failed** |
| Audit Log filters & severity | `node scripts/probe-audit-filter.mjs` | **OBSERVED PASS — 48 checks, 0 failed** |
| Date validation | `node scripts/probe-date-validation.mjs` | **OBSERVED PASS — 42 checks, 0 failed** |
| Delete guards | `node scripts/probe-delete-guard.mjs` | **OBSERVED PASS — 61 checks, 0 failed** |
| Error-vs-empty & write honesty | `node scripts/probe-ui-feedback.mjs` | **OBSERVED PASS — 83 checks, 0 failed** |
| Deploy configuration | `node scripts/probe-deploy-config.mjs` | **OBSERVED PASS — 77 checks, 0 failed** |
| Import Dexie zone | `node --import ./scripts/_loader-boot.mjs scripts/probe-import-txn-zone.mjs` | **OBSERVED PASS — 7 checks, 0 failed** |
| Import rollback | same form, `probe-import-rollback-id.mjs` | **OBSERVED PASS — 16 checks, 0 failed** (previously `document is not defined`) |
| Import validation gate | same form, `probe-import-validation.mjs` | **OBSERVED PASS — 14 checks, 0 failed** |
| Manual entry import | `node scripts/probe-manual-entry-import.mjs` | **OBSERVED PASS — 45 checks, 0 failed** |
| Amount parsing | `node scripts/probe-parse-amount.mjs` | **OBSERVED PASS — 28 checks, 0 failed** |
| Profit leakage / payroll double-count | `node --import ./scripts/_loader-boot.mjs scripts/probe-profit-leakage.mjs` | **OBSERVED PASS — 14 checks, 0 failed** |
| Real-time session revocation | same form, `test_realtime_revocation.mjs` | **OBSERVED PASS — 26 checks, 0 failed** (previously died at test 1 on a fixture that could not log in) |
| Auth end-to-end (login, lockout, cross-tab) | same form, `test_bulletproof_auth.mjs` | **OBSERVED PASS — 40 checks, 0 failed** (previously 33 passed / 7 failed) |
| Acceptance harness | `npx vitest run` | **NOT RUN** — `Cannot find module '@rollup/rollup-linux-x64-gnu'`; Vite cannot start in this environment |
| Production build | `npm run build` | **NOT RUN** — same rollup native binary. **Run this on your Windows machine** |
| Browser / manual QA | — | **NOT RUN** — no browser in this environment |

That is **1,054 individual assertions green across 26 suites**, 0 failed. (`verify-actioncenter.mjs` contributes none to that count — it prints a scenario verdict rather than a total — so the real number is higher.) Two scripts in `scripts/` fail at `HEAD` for reasons that predate this work and are unrelated to it: `probe-adjustments.mjs` imports an export that no longer exists, and `test-parser.mjs` hard-codes an absolute path from another machine. Neither is part of the regression set.

The commands above are the regression set. When something in this app changes, run them; `npm run lint` and `npm run typecheck` should be run as two separate commands rather than chained, because together they take long enough to hit a tool timeout.

### What this review did NOT cover
- No browser testing whatsoever — no click-through, no visual check, no responsive or cross-browser pass
- No load or performance testing; the <1s filter and 100k-row import targets in `CLAUDE.md` §10 are **unverified**
- No penetration testing; findings come from code reading and targeted Node probes
- Stripe integration (`@stripe/*` is a dependency) was not audited — no payment flow was reviewed
- The CRDT/websocket sync path (`yjs`, `y-websocket`, `backend/websocket.js`) was not audited
- Vercel project settings, environment variables, and DNS/TLS were not inspected — no access

---

## SUGGESTED ORDER OF WORK

All the code items are done. What is left is yours, and the order matters.

1. **The two-minute check first:** deploy a preview, hard-refresh `/transactions`. If it 404s, nothing else matters. (Fixed under deploy config — verify it on a real preview regardless.)
2. **Set `AUDIT_CHAIN_SECRET` in the Vercel project.** Without it the audit chain cannot be verified — the endpoint now says so out loud instead of reporting a valid chain, but the gap in coverage is unrecoverable after real activity starts, so set it *before* anyone signs in.
3. **Run `npm run build` and `npm run test` on Windows** and rebuild `dist/`. Neither can run in this environment, so both are genuinely unknown. Then `grep -c "console\.log" dist/assets/*.js` to close the console-stripping item.
4. **Sign in once as yourself and enrol in MFA**, then disable it again. That single round trip exercises the step-up prompt, the one-time secret hand-off, and the forced sign-out — the three newest paths, and the ones with no browser coverage.
5. **Re-run one real import in Chrome** before trusting the import surface with a month you care about.
6. **Confirm every account that needs access has `property_access: 'all'`** before you hand out logins. Under the B5 restriction, any other account is refused at sign-in.

---

## ADDENDUM — 2026-08-21

Work done after the 2026-08-16 pass. Same labelling rules: OBSERVED means terminal
output exists, NOT RUN means genuinely unknown.

### Closed

- [x] **Both upload doors now enforce the same rules.** OBSERVED. `Import.jsx`
  gated extension, executables, a 10MB cap and magic bytes; `DataIntelligence.jsx`
  tested the filename extension and nothing else, on the same import pipeline. A
  renamed executable, a mislabelled `.xlsx`, or a 500MB file was refused at one
  door and accepted at the other. The checks moved unchanged into
  `src/lib/uploadGuard.js` and both pages now import it. Proof:
  `node scripts/probe-upload-guard.mjs` → `PASS 32 FAIL 0`.
- [x] **The orphan `validateUpload` suite is gone.** OBSERVED.
  `base44/functions/validateUpload/entry.js` never existed in git history, so
  `tests/backend/validateUpload.test.js` could never do anything but fail at
  import — a permanently red gate that read like server-side upload validation
  existed. It was deleted rather than "repaired": both real `UploadFile` call
  sites read and parse the CSV client-side *before* uploading
  (`Import.jsx:365` reads `file.text()` at line 365 and uploads at 367), so a
  server validator interposed at the upload call would arrive after the hostile
  bytes had already reached the parser. Validation belongs where the bytes are
  first touched, which is where `uploadGuard.js` now sits.
- [x] **The donut label test is green and stronger.** OBSERVED. Its fixture
  claimed a 360px-wide box with a 70px ring — a geometry the sizer never produces
  (at 360px it picks 39px) — so the test had been red since the commit that
  introduced it, and the engine it accused was correct. The fixture now describes
  the box `MoneyKept.jsx:817` actually renders, the no-ellipsis assertion was
  kept, and a second test pins the truncation fallback: one ellipsis, at the end,
  and what survives must be a real prefix. Both geometries are cross-checked
  against the live sizer by section 12 of the harness. Proof:
  `node scripts/verify-donut-labels.mjs` → `PASS 738 FAIL 0` (was 728).
- [x] **`verify:all`'s arithmetic reconciles.** OBSERVED. The 78-vs-80
  discrepancy was two untracked `probe-donut-truncation*.mjs` scratch files that
  matched the runner's discovery glob, contained only `console.log` and no
  assertions, and would have reported a vacuous PASS. Deleted; their one real
  assertion was folded into the donut harness. The runner now prints its list
  fingerprint next to the tally with an explicit `every discovered suite ran` /
  `narrowed run` / `MISMATCH` verdict, prints real stderr for BROKEN suites
  instead of just the matched signature, and exits non-zero if the buckets fail
  to sum. Current list: `790b17e1 (79 discovered)`.
- [x] **`tests/backend` can resolve its imports.** OBSERVED (resolution),
  NOT RUN (the suites themselves — `npx vitest` cannot run in the Linux VM).
  `vitest.config.js` aliases the Deno-only specifiers and
  `tests/stubs/base44-runtime.js` stands in for `base44:runtime`;
  `aiAssistant.test.js` was failing on a missing `RateLimit` entity mock, which
  threw inside the function's try block and surfaced as HTTP 500 — an incomplete
  fixture reading as a broken endpoint.

### Open — deferred deliberately, with reasons

- [ ] **Three disagreeing `@base44/sdk` pins.** The `.ts` functions import
  `npm:@base44/sdk@0.8.40`, the `.js` functions `npm:@base44/sdk@^0.8.41`, and
  `package.json` carries `^0.8.41`. One dependency, three versions. Not unified
  because it means editing ~20 deployed server functions, and two of them
  (`custom_auth_login/entry.js:204`, `custom_user_admin/entry.js:311`) record
  that the signed audit payload depends on those import lines staying
  byte-identical across copies. Unify deliberately, in its own change, with the
  audit chain re-verified afterwards.
- [ ] **`validateUpload`'s three server-only clauses are not implemented**: the
  UUID rename that strips the original filename, `base44_session` cookie
  authentication, and the `__Host-csrf_token` / `x-csrf-token` double-submit
  match. They are listed here so the threat model is not lost with the deleted
  test. They matter only if a server-side upload endpoint is ever introduced;
  today no upload path routes through one.
- [ ] **`chooseOuterRadiusPct` returns its LARGEST ring when the box measures 0**
  (`donutLabelLayout.js:162`) — the least room for labels in exactly the state
  where nothing is known, which inverts the function's own purpose. It
  self-corrects when the ResizeObserver fires, so the cost is one frame on mount;
  the alternative (`minPct`) trades that for a ring that visibly grows every
  time. Left alone because the visual outcome cannot be judged without a browser,
  and neither `npm run build` nor a Vite server runs in the Linux VM. Decide this
  one by looking at it.
- [ ] **The client-side upload gate has no browser test.** `uploadGuard.js` is
  covered by a Node probe, but no test drives a real `<input type="file">`
  through either page. NOT RUN.
- [ ] **`base44/functions/validateUpload/` is an empty directory** left on disk.
  Git does not track empty directories, so it is a local artifact only. Harmless;
  delete it whenever convenient.
- [ ] **The dependency graph was not rebuilt after these edits.** `python -m
  graphify update .` NOT RUN — the AST pass over 459 files does not fit the Linux
  VM's ~178s per-command ceiling and writes no cache until it completes, so three
  attempts (400/459, 400/459, 200/459) all ended at the same starting point.
  Please run it once on Windows; `graphify-out/` is stale by exactly this
  session's diff (`src/lib/uploadGuard.js` is a new node, and `Import.jsx` /
  `DataIntelligence.jsx` each gained an edge to it).

---

*Originally generated by code review and targeted Node probes on 2026-08-15, then updated in place as the findings were fixed on 2026-08-16, with an addendum on 2026-08-21. Claims are labelled OBSERVED, INFERRED, or NOT RUN — please treat INFERRED items as requiring confirmation, and NOT RUN items as genuinely unknown rather than passing. Ticked items name the command that proves them.*
