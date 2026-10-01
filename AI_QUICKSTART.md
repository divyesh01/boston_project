# AI Quickstart — fast path for code changes

This file is an accelerator, not a second policy. The canonical engineering contract is
`docs/engineering/AGENT_RULES.md`; `PROTECTED_FILES.md` and DIVYESH V3 still outrank
everything here.

## Start every code task with two commands

```bash
npm run verify:v3
npm run ai:context -- "describe the task or paste the file path"
```

Examples:

```bash
npm run ai:context -- "Dashboard YTD revenue"
npm run ai:context -- src/lib/bulkHydrationService.js
npm run ai:context -- "login session timeout"
npm run ai:context -- --json "HotelKey import"
```

`ai:context` is read-only. It uses the repository's existing machine-verified routing
documents instead of inventing another map:

- `docs/AI_REPO_GUIDE.md` — subsystem → files → primary gate → protected files
- `docs/TEST_MATRIX.md` — subsystem → relevant suites → exact commands
- `docs/MODULE_CONTRACTS.md` — module invariant and risk
- `docs/engineering/KNOWN_FAILURES.json` — accepted pre-existing failures only
- `PROTECTED_FILES.md` — files an agent may not edit without current-task owner authority

## Fast workflow

1. Run the two commands above. If V3 reports `BLOCKED`, do not make substantive edits.
2. Read the listed **Read first** files, their direct callers/imports, and the one relevant
   BRAIN spoke. Do not scan the whole repository.
3. If the requested path is protected, stop unless the owner explicitly authorized that
   protected-file change in the current task.
4. Create a focused branch. Keep one concern per PR.
5. Make the smallest complete diff. Reuse existing helpers; do not create parallel
   implementations.
6. Run the targeted gate from `ai:context` first. Then run the applicable repository
   checks (`npm run typecheck`, `npm run lint`, tests/build, and any risk-specific gate).
7. Inspect the final diff and report exactly what changed, what did not change, what ran,
   and any remaining unverified state.

## Known-failure rule

`docs/engineering/KNOWN_FAILURES.json` is a registry, not a waiver. A failure may be
listed only when it is repeatable, existed before the current change, has a stable
signature, and is explicitly being carried as known debt. Never add a new failure just
to make a PR look green.

An empty `failures` array means there are no accepted pre-existing failures. A new
failure is therefore new until proven otherwise.

## Keep context small

Prefer the output of `npm run ai:context` over broad repository searches. Escalate to a
wider scan only when the printed routing is insufficient or contradicted by the code.
