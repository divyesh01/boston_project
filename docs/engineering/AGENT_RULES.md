# Canonical AI Engineering Rules

This file is the **single shared engineering contract** for every AI coding agent
working in this repository. Provider files such as `AGENTS.md`, `CLAUDE.md`, and
`GEMINI.md` are adapters for tool-specific bootstrapping only. They must not fork or
redefine the rules below.

## 1. Authority and startup

Before substantive repository work:

1. Read `PROTECTED_FILES.md`.
2. Run `npm run verify:v3`.
3. Read `docs/divyesh-v3/KERNEL.md`, `docs/divyesh-v3/ROUTER.md`, and only the
   role/domain/workflow packs selected by the router.
4. Read `BRAIN.md` and the relevant spoke instead of scanning unrelated parts of
   the repository.
5. Check the working tree and current branch before editing.

If V3 verification fails, report `SYSTEM_DRIFT = BLOCKED` and do not claim the
repository is in a verified state.

## 2. Protected files

`PROTECTED_FILES.md` is authoritative. A protected file may be changed only when the
repository owner gives explicit authorization for that change in the current task.

Never bypass protection by adding a wrapper, duplicate, monkey patch, runtime override,
or renamed replacement that changes protected behavior indirectly.

## 3. Branch and change discipline

- Do not make ordinary implementation changes directly on `main`.
- Create a focused branch and PR for non-trivial work.
- Keep one concern per PR whenever practical.
- Do not mix cleanup with business-logic changes.
- Preserve unrelated user work and never erase uncommitted changes.
- Before finishing, inspect the final diff and confirm every changed file belongs to
  the requested task.

## 4. Evidence, not guesses

Never claim that something is fixed, secure, passing, production-ready, or regression-free
because it looks correct.

For a bug or risky change:

1. Inspect the implementation, callers, data/schema boundaries, and existing tests.
2. Reproduce or prove the failure with the smallest useful test/probe.
3. Fix the earliest broken boundary rather than masking the symptom downstream.
4. Re-run the targeted proof.
5. Run the relevant regression gates.
6. Report observed results separately from checks that were not run.

A test that cannot fail is not evidence. Never weaken an assertion merely to make CI green.

When the owner is using the Codex + Antigravity split defined in section 8, these are
**team obligations**, not duplicate work for both agents: Codex owns investigation,
planning, implementation, and fixes; Antigravity owns reproduction, test execution,
regression verification, and the final evidence that the change is green.

## 5. Required engineering invariants

### Security and tenancy

Treat authentication, authorization, session state, audit trails, CSV imports, and
`property_id` isolation as hostile-input boundaries. Negative cases matter: unauthorized
access must fail, and one property must never read or mutate another property's data.

### Financial correctness

Money must use the repository's integer-cents/decimal helpers. Do not introduce raw
floating-point dollar arithmetic. Reconciliation differences must be explicit rather than
rounded away or replaced with zero.

### HotelKey and imported data

The ingestion order is:

`raw input -> parse -> normalize -> validate -> sanitize -> persist -> consume`

Do not hide malformed upstream data with UI fallbacks. Regression fixtures must be
synthetic and contain **no real guest, hotel, PMS, or production data**. Follow
`src/lib/__fixtures__/hotelkey/README.md` for HotelKey fixtures.

### UI truthfulness

Loading, error, empty, permission-denied, and unavailable are different states. Do not
collapse them into the same empty screen or invented default value.

## 6. Verification commands

Use repository commands exactly as defined in `package.json`.

Typical order:

```bash
# targeted probe or focused test first
npm run typecheck
npm run lint
npm test
npm run build
npm run verify:all
```

Use `npm run typecheck`; **do not use `npx tsc --noEmit`**. This repository uses
`jsconfig.json`, and the bare command has previously checked nothing useful.

For changes covered by dedicated gates, run those gates too. Examples include:

```bash
npm run map:verify
npm run mutate:all
npm run verify:v3
```

If the full verification sweep is too long for one command, shard it with
`npm run verify:all -- --shard i/n`. Do not reduce timeouts just to make a run fit.

When Antigravity is assigned and available as the verification agent, the command list
above is primarily Antigravity's responsibility. Codex should not run broad suites such
as full `npm test`, Playwright/browser suites, mutation suites, production builds, or
`npm run verify:all` merely to duplicate Antigravity. Codex still performs required
startup/governance checks such as `npm run verify:v3`, reviews its diff, and may run one
small targeted syntax/type/import sanity check when that is necessary to avoid handing off
obviously broken code. If Antigravity is unavailable or the owner explicitly asks Codex
to verify, the normal verification rules apply.

## 7. Production and remote-data safety

Do not mutate production infrastructure, production databases, production credentials,
or live hotel/business data merely because repository write access exists. Remote
production work requires explicit task scope and must have a rollback/proof plan.

Staging or fixture work must still preserve property isolation and must never copy real
guest data into the repository.

## 8. Documentation and agent coordination

### Codex + Antigravity division of labor

When both Codex and Antigravity are available for a task, this split is the default unless
the repository owner explicitly overrides it. It applies to **every Codex model or variant**.

**Codex is the implementation owner.** Spend Codex reasoning/context budget on the work
that changes the product:

- inspect the relevant implementation and architecture,
- plan the smallest correct solution and its fallback,
- write and edit production code,
- fix root causes rather than symptoms,
- perform refactors, migrations, documentation changes, and integration work required by
  the requested change,
- review the final diff for correctness and unintended changes,
- respond to Antigravity findings with additional code fixes.

Codex must **not** spend substantial context or execution budget duplicating verification
that Antigravity can perform. Do not use Codex for exhaustive test runs, repeated CI-style
verification, browser/Playwright sweeps, mutation testing, stress testing, or long test-log
debugging when Antigravity is assigned and available. A tiny implementation sanity check
is allowed when needed, but it is not a substitute for Antigravity verification.

**Antigravity is the verification owner.** Antigravity should:

- reproduce the reported failure when useful,
- run targeted tests and the relevant regression gates,
- run browser, integration, mutation, security, performance, and broader verification when
  the task calls for them,
- inspect failures independently rather than accepting Codex's success claim,
- return concrete failing commands, logs, files, and scenarios to Codex for repair,
- provide the final verification evidence after Codex's implementation is ready.

The normal loop is:

`Codex plans/implements -> Antigravity tests/verifies -> Codex fixes findings -> Antigravity re-verifies`.

Before handoff, Codex must provide Antigravity with the branch/commit, changed files,
intended behavior, risky boundaries, expected invariants, and the tests or scenarios that
need verification. Codex must label unrun verification as pending and must not claim a
change is green merely because implementation is complete. Antigravity must not rewrite
production code merely to make a test pass when the failure belongs back with Codex.

- Update documentation when a contract, architecture boundary, verification command, or
  behavior actually changes.
- Do not rewrite historical evidence to make the present look cleaner.
- Provider-specific files may describe syntax or platform capabilities, but shared
  engineering policy belongs here.
- When multiple agents are working, prefer small PRs with explicit base/head SHAs so one
  agent's branch does not silently overwrite another's work.

## 9. Completion standard

A repository task is complete only when the final report states:

- what changed,
- what was deliberately left unchanged,
- exact verification that ran and its observed result,
- anything that remains unverified or blocked,
- the branch/PR or commit that contains the work.

Simple language is preferred, but precision must never be sacrificed for simplicity.
