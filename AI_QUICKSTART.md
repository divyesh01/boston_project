# AI Quickstart — fast, bounded code changes

This is an accelerator, not a second policy. The canonical engineering contract remains
`docs/engineering/AGENT_RULES.md`; `PROTECTED_FILES.md` and DIVYESH V3 outrank this file.

## Before editing

```bash
npm run verify:v3
npm run ai:context -- "describe the task or paste a file path"
```

`ai:context` is read-only. It combines the machine-verified repo guide, test matrix,
module contracts, protected-file list, current branch/diff, known-failure registry and
DIVYESH V3 state. It outputs the likely subsystem, risk, invariants, exact proof commands,
and a Codex → Antigravity handoff.

Examples:

```bash
npm run ai:context -- "Dashboard YTD revenue"
npm run ai:context -- src/lib/bulkHydrationService.js
npm run ai:context -- --changed "HotelKey import"
npm run ai:context -- --json "login session timeout"
```

## While editing

1. Read only the printed **Read first** files, direct callers/imports, and the relevant
   BRAIN spoke. Do not scan the whole repository unless the route is insufficient.
2. Treat `PROTECTED` as a hard boundary. A protected-file edit still requires explicit
   current-task owner authority; the tool has no bypass flag.
3. For `HIGH` risk modules, prove the failure first, then make the smallest complete fix.
4. Keep one concern per branch/PR. Reuse existing helpers and contracts.
5. Run the printed targeted proof before broad checks.

## Before handoff or merge

```bash
npm run ai:check -- "same task description"
```

`ai:check` evaluates the actual working tree and branch diff. It exits non-zero for hard
blockers such as V3 drift, a broken routing map, malformed/expired known-failure entries,
protected-file changes needing owner review, mapped changes outside the requested
subsystem, implementation changes on `main`, or a branch behind its base.

It also warns on wide diffs, ambiguous cross-domain routing, and unmapped files. Its final
section is a ready-to-use Codex → Antigravity verification handoff.

## Known failures are evidence, not a waiver

`docs/engineering/KNOWN_FAILURES.json` uses a strict schema. Every active exception must
name a real suite, stable signature, first-seen commit, affected area, accepter, review
date, expiry date and tracking issue. Expired or malformed active entries block the
context/check command.

Never register a failure introduced by the current change. An empty `failures` array means
there are no accepted pre-existing failures.

## Source-of-truth inputs

- `docs/AI_REPO_GUIDE.md` — subsystem → files → primary gate → protected files
- `docs/TEST_MATRIX.md` — subsystem → relevant suites → exact commands
- `docs/MODULE_CONTRACTS.md` — module invariants and risk
- `PROTECTED_FILES.md` — locked files
- `docs/engineering/KNOWN_FAILURES.json` — accepted pre-existing failures only

The goal: **route narrowly, edit minimally, prove exactly, and block silent scope creep
before review.**
