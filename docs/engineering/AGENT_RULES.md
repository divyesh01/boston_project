# Canonical AI Engineering Rules

This file is the **single shared engineering contract** for every AI coding agent
working in this repository. Provider files such as `AGENTS.md`, `CLAUDE.md`, and
`GEMINI.md` are adapters for tool-specific bootstrapping only. They must not fork or
redefine the rules below.

## 1. Authority and startup

Before substantive repository work:

1. Read `PROTECTED_FILES.md`.
2. Run `npm run verify:v3`.
3. Read `docs/engineering/CODEX_ANTIGRAVITY_WORKFLOW.md`. This is mandatory for
   every Codex and Gemini/Antigravity model before substantive work.
4. Read `docs/divyesh-v3/KERNEL.md`, `docs/divyesh-v3/ROUTER.md`, and only the
   role/domain/workflow packs selected by the router.
5. Read `BRAIN.md` and the relevant spoke instead of scanning unrelated parts of
   the repository.
6. Check the working tree and current branch before editing.

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

The mandatory Codex + Antigravity contract in
`docs/engineering/CODEX_ANTIGRAVITY_WORKFLOW.md` defines who owns each part of this
evidence loop. These are team obligations, not duplicate work for both agents.

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

When Codex and Antigravity are both available, verification ownership follows
`docs/engineering/CODEX_ANTIGRAVITY_WORKFLOW.md`. Codex keeps mandatory startup checks,
diff review, and only the small implementation sanity checks allowed by that contract;
Antigravity owns the broader verification work.

## 7. Production and remote-data safety

Do not mutate production infrastructure, production databases, production credentials,
or live hotel/business data merely because repository write access exists. Remote
production work requires explicit task scope and must have a rollback/proof plan.

Staging or fixture work must still preserve property isolation and must never copy real
guest data into the repository.

## 8. Documentation and agent coordination

### Mandatory Codex + Antigravity contract

Every Codex model and every Gemini/Antigravity model must read
`docs/engineering/CODEX_ANTIGRAVITY_WORKFLOW.md` before substantive work. That file is
the authoritative role contract for implementation, verification, handoff, rework, and
completion.

The short version is: **Codex owns implementation; Antigravity owns verification.**
Do not duplicate the detailed role rules here; update the shared contract instead.

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
