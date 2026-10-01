# Tech Debt — Large-File Decomposition Register

Ranked by **danger and confusion**, not by line count. The original register was measured
2026-09-03; rows are updated when later repository evidence materially changes the risk or
status. This is a planning register, not permission to refactor opportunistically.

**Do not act on a P0/P1 row opportunistically.** Each row is a project with its own
failing-first proof obligation. Read `PROJECT_MAP.md` first, and `PROTECTED_FILES.md`
before touching anything marked PROTECTED.

## Why "large" is the wrong metric alone

Two of the three largest files in the repository are **protected** and cannot be
decomposed without explicit owner authorization, so they are ranked here as *reportable*
debt rather than actionable work. Meanwhile `worker/business-sync.js` at 1,000 lines is
the most dangerous file in the tree despite being tenth by size, because it is the only
writer on the production migration path.

---

## P0 — dangerous or actively confusing

### 1. `worker/business-sync.js` — 1,000 lines

**Responsibility today.** Two independent state machines plus their shared primitives,
in one module: the **dataset-migration** lifecycle (`startMigration`, `uploadChunk`,
`activateMigration`, `rollbackMigration`, `migrationStatus`) and the **staged-transaction**
lifecycle (`startTransaction`, `uploadTransactionChunk`, `commitTransaction`,
`abortTransaction`, `transactionStatus`, `expirePendingTransactions`,
`loadStagingTransaction`). Underneath both sit the canonicalization primitives
(`canonicalize`, `canonicalJson`, `assertLosslessJson`, `sha256`, `typedRecordKey`), the
authorization guards (`requireMigrationRole`, `requireMutationRole`), and the isolation
clause builder (`scopedRecordClause`).

**Why it is hard to maintain.** The two lifecycles have different authorization
requirements, different failure semantics, and different rollback stories, but they share
a file, a set of helpers, and a reviewer's attention. A change to one lifecycle is
indistinguishable at a glance from a change to the other. This is the file that carries
property isolation for business records, so a mistake here is a cross-tenant data leak,
not a rendering bug.

**Safe future boundaries.** Three modules with an explicit dependency direction:
`worker/business-sync-canonical.js` (the pure primitives — no `env`, no `request`, fully
unit-testable), `worker/business-sync-migration.js`, and
`worker/business-sync-transaction.js`. `scopedRecordClause` and the role guards belong
with `worker/scope.js`, which already owns isolation. The current `business-sync.js`
becomes the route dispatcher only.

**Dependencies and risk.** HIGH — and the risk is timing, not difficulty. This file is
the live cross-browser rollout surface. **Do not split it while that rollout is
unverified.** The canonicalization split is the one genuinely low-risk slice: those
functions take values and return values, so extracting them is mechanical and provable
by byte-comparing `canonicalJson` output over a fixture corpus before and after.

**Estimated benefit.** High. It converts the repository's highest-consequence file from
"read 1,000 lines to be sure" into "read the 200-line lifecycle you are changing."

### 2. `src/api/base44Client.js` — 2,620 lines · **PROTECTED**

**Responsibility today.** The client-side data access layer: entity CRUD, auth surface,
session touch/throttle, and the local-cache interplay. Named in `PROTECTED_FILES.md`.

**Why it is hard to maintain.** It is the largest file in the repository and every page
depends on it, so its blast radius is the whole SPA. Its size is why the harness reaches
into it by path (see the `test-throttle` note in
`docs/brain/BRAIN_TROUBLESHOOTING.md`) rather than by import.

**Safe future boundaries.** Not proposed. A protected file's decomposition plan is the
owner's to authorize; drafting one here would invite an unauthorized edit.

**Risk.** Blocked, by policy rather than by difficulty.

**Estimated benefit.** Deferred to the owner.

### 3. `src/lib/reportParsers.js` — 1,331 lines (remeasured 2026-09-30)

**Status changed since the original 2026-09-03 register.** Several safe extractions have
already landed:

- `src/lib/reportGrid.js` owns report detection and shared grid helpers.
- `src/lib/parsers/transactions.js` owns the transaction scanner.
- `src/lib/parsers/hotelStatistics.js` owns the hotel-statistics scanner.
- `src/lib/parsers/adjustmentsRefunds.js` owns adjustments/refunds scanning.
- `src/lib/__fixtures__/hotelkey/` is now a committed **synthetic-only** regression
  corpus, exercised by `hotelKeyParserFixtures.test.js`,
  `hotelKeyImportFixtures.test.js`, and the HotelKey mutation harness.

The old statement that "a committed in-repo fixture corpus does not exist yet" is
therefore obsolete and must not be used as a blocker or as a reason to recreate the same
fixtures elsewhere.

**Responsibility still remaining here.** The central registry/row plumbing, clerk and
timecard scanning, shared scan dispatch, dedupe/persistence behavior, and import
orchestration still make this a high-consequence ingestion file. It remains easy to
change one report path while accidentally changing another because the dispatch and
persistence contracts converge here.

**Coverage reality.** The committed corpus is real protection, but it does **not** mean
every historical local-data probe became portable. Real PMS exports under
`scripts/data/*.csv` are intentionally gitignored and may contain business/guest data.
Clean-clone CI must use the committed synthetic corpus; workstation-only probes that need
private exports must declare an honest `SKIP:` when those files are absent. Never commit
real hotel exports to make a probe green.

**Next safe boundaries.** Expand synthetic parser fixtures for any remaining report shape
before moving that shape, then extract the clerk and timecard scanners under
`src/lib/parsers/`. Move import orchestration only after its dedupe/idempotency behavior
is pinned independently. `mapRow` / `COLUMN_MAP` still have source-contract probes, so
moving them requires updating those guards in the same verified change.

**Risk.** HIGH. HotelKey behavior must remain byte/semantic-equivalent for accepted
inputs, malformed rows must still fail or quarantine the same way, re-import must remain
idempotent, and no real PMS data may enter git.

**Estimated benefit.** High, but the remaining work is now incremental decomposition,
not "build fixture coverage from scratch."

---

## P1 — should be decomposed soon

### 4. `src/pages/Payroll.jsx` — 1,860 lines

Nineteen `useState`/`useEffect` sites in one page component, mixing payroll period
selection, staff roster editing, calculation display, approval actions and export. The
money math itself is correctly delegated to `src/lib/payrollCalc.js`, which is what keeps
this at P1 rather than P0 — the risk is comprehension, not arithmetic. Natural seams:
period selector, roster table, run summary, and the approval action bar, with page-level
state lifted into one reducer.

Risk MEDIUM, and lower than it first looks. Measured 2026-09-03: the page contains **no**
`hasPermission`, role, or audit-log call — `grep` for all of them returns nothing — and
`/payroll` is mounted in `src/App.jsx` with no permission wrapper. The authorization
boundary for payroll writes is **server-side**: `PayrollRun` is one of the
`BUSINESS_ENTITIES` in `worker/business-sync.js`, so its mutations pass
`requireMutationRole` and the scope clause there. A component extraction therefore cannot
drop a client gate the page never had; the thing extraction must not break is the
`payrollCalc.js` call contract. Benefit: high, this is the second-most-edited page.

### 5. `src/pages/Import.jsx` — 1,264 lines

Owns file selection, the validation gate, the scan/import/replace flows, the undo path,
and it renders `BusinessMigrationCard` for the migration UI on the `/upload` route.
Five workflows in one component. Seams: file-intake, scan-review, commit/replace, and
undo, each already backed by its own lib module (`importValidation.js`, `importReset.js`,
`csvParser.js`). Risk MEDIUM-HIGH: this is the entry point for the migration the owner is
mid-rollout on. Defer until that rollout is verified. Benefit: high.

### 6. `src/pages/Settings.jsx` — 1,495 lines

Commission rates, tax, thresholds and financial configuration in one form surface, several
of which feed financial reconciliation directly. Seams are the settings *groups*, which
are already visually sectioned. Risk MEDIUM, and the risk is **silent field loss**, not
authorization: a group extracted without its save wiring changes revenue math without
erroring. Each extracted group needs a save-round-trip assertion. (Measured: the page
itself contains no `hasPermission` call — the only audit reference is a comment. Treat the
gate as server-side, as with Payroll.) Benefit: medium-high.

### 7. `src/lib/aiEngine.js` (1,230) and `src/lib/dataScanner.js` (830)

Analysis surfaces feeding `src/pages/DataIntelligence.jsx` (1,053). Risk LOW-MEDIUM:
these are read-only derivations, not writers, so a mistake shows as a wrong insight
rather than corrupted data. Seams are the individual analyses. Benefit: medium — mostly
comprehension, and worth doing precisely *because* the risk is low enough to be a safe
first decomposition for a new agent.

### 8. `src/components/dashboard/MoneyKept.jsx` (1,001) and `ClerkAuditMatrix.jsx` (826)

Two dashboard cards that each outgrew "one card, one component". `MoneyKept.jsx` composes
**twelve** financial lib modules inside a render function — `hotel`, `decimal`
(`fromCents`/`toCents`/`multiply`), `commissionRates`, `taxConfig`, `taxSettings`,
`taxLiability`, `expenseCategories`, `paymentNorm`, `payrollCalc` among them — so the
repository's money reconciliation was partly expressed as JSX-local `useMemo` work that
could not be asserted without rendering. **Extraction 1 completed 2026-09-30:** recurring
expense projection, the base deduction/tax model, and trend/chart derivation now live in
`src/lib/moneyKeptModel.js`; `MoneyKept.jsx` owns hooks, memoization, state, and rendering.
The remaining visual split is secondary. Risk LOW-MEDIUM. Benefit: medium.

---

## P2 — cosmetic or optional

- `src/pages/Users.jsx` (855), `src/pages/ManualEntry.jsx` (843), `src/pages/Expenses.jsx`
  (707), `src/pages/Payments.jsx` (613), `src/pages/AuditLog.jsx` (602) — large but
  single-purpose. Leave them.
- `src/lib/securityUtils.js` (768) — **PROTECTED**. Report only.
- `src/api/businessSync.js` (768) — the client half of the sync path. Same "wait for the
  rollout" rule as its server counterpart, but it is a thinner file with one concern.
- `src/components/ui/sidebar.jsx` (678) — vendored shadcn primitive. Do not touch.
- `base44/functions/custom_user_admin/entry.js` (1,051) and
  `custom_auth_login/entry.js` (622) — **historical**. `base44/` is no longer the live
  auth or data path (see `PROJECT_MAP.md`). Decomposing dead-but-tracked code has
  negative value; the open question is retirement, not refactoring, and that is an owner
  decision.
- Large probes (`probe-worker-import.mjs` 1,410; `acceptance-harness.mjs` 1,205;
  `probe-business-sync-global-records.mjs` 1,165; `probe-auth-hardening.mjs` 1,037) —
  test code, and length there buys coverage. One caveat worth knowing:
  `acceptance-harness.mjs` is **never executed by any gate**, because
  `scripts/verify-all.mjs` only discovers `probe-`, `verify-` and `test_` prefixes. It is
  1,205 lines of verification nobody runs. That is a harness question, not a size
  question.

---

## Cross-cutting debt that is not a file

1. **Dedup keys live in two modules.** `src/lib/reportParsers.js` and
   `src/lib/transactionNorm.js` both participate in the no-double-count invariant. Whoever
   splits either one must first write down which module owns the key.
2. **Verification discovery is now pinned against silent omissions.** Completed
   2026-10-01: `verify_cross_module_impact.mjs` was promoted to the discovered
   `verify-cross-module-impact.mjs` suite with an explicit PASS/FAIL contract, and
   `verify-acceptance-harness.mjs` now runs the real-data harness when private HotelKey
   exports are present while reporting an honest SKIP in clean CI. Both names are pinned in
   `MUST_DISCOVER` and the suite-integrity audit floor so a future rename/exclusion cannot
   silently remove them from verification.
3. **Unreachable-but-tracked UI.** Eight `src/` components have zero importers and are
   marked UNWIRED in `docs/brain/BRAIN_FRONTEND.md`: `propertyMap.jsx`,
   `MFARecoveryModal.jsx`, `HousekeepingSettingsModal.jsx`, `AnomalySignoffModal.jsx`,
   `PricingOverrideButton.jsx`, `ReconciliationExportButton.jsx`,
   `UserNotRegisteredError.jsx`, and `ui-exec/RangePicker.jsx`. They look like staged
   features. Deletion is an owner call; the standing repository convention is "reported,
   not deleted".
4. **`leaflet`, `react-leaflet`, `@types/leaflet`** are declared dependencies whose only
   consumer is the UNWIRED `propertyMap.jsx`. Proven removable, not removed — a
   dependency change carries lockfile and build blast radius that a docs pass should not
   absorb.
5. **`backend/webhooks.js`** is an orphan HMAC receiver with no importer. Security-relevant
   and therefore worth an explicit owner decision rather than a silent deletion.
6. **One misleading filename, and it matters.** `src/lib/hotelKeyRegression.test.js` reads
   as the HotelKey parsing regression suite. It is not: it imports
   `financialReconciliation`, `yieldOptimizer` and `fraudScoringEngine`, and its top-level
   `describe` is "HotelKey PMS Financial Reconciliation & Math Regression Suite". The name
   invites exactly the wrong conclusion — that parser changes are covered — which is how
   this register's first draft got it wrong. Renaming it to
   `financialMathRegression.test.js` is safe (vitest discovers by `*.test.js`, nothing
   imports it), but it is a rename with citation blast radius in `docs/`, so it is reported
   here rather than done in a docs pass.

---

*Register compiled 2026-09-03. Line counts are a snapshot; re-measure before planning.*
