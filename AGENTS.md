# AGENTS.md — Agent Adapter

> Canonical engineering policy: [`docs/engineering/AGENT_RULES.md`](./docs/engineering/AGENT_RULES.md)
>
> This file is an adapter. Do not create a separate Codex/OpenCode/Cursor policy here.

## Protected files

Read [`PROTECTED_FILES.md`](./PROTECTED_FILES.md) before editing. Files listed there
require explicit owner authorization in the current task.

<!-- DIVYESH-V3-BOOTSTRAP:START -->
## DIVYESH V3 AUTO-BOOTSTRAP

SYSTEM: DIVYESH-V3
VERSION: 3.0.0
BOOTSTRAP_SCHEMA: 1.0.0
CANONICAL_MANIFEST: docs/divyesh-v3/manifest.json

Before substantive work:

1. Run `npm run verify:v3`.
2. Read `docs/divyesh-v3/KERNEL.md`, `docs/divyesh-v3/ROUTER.md`, and
   `docs/divyesh-v3/QUALITY_FIRST_COMPUTE.md` when the router requires it.
3. Load only the relevant role/domain/workflow packs.
4. Apply `docs/engineering/AGENT_RULES.md` as the shared engineering contract.

If verification fails, stop with `SYSTEM_DRIFT = BLOCKED`.

Platform capabilities may differ; project governance may not.
<!-- DIVYESH-V3-BOOTSTRAP:END -->

## Repository routing

Start at `BRAIN.md`, then read only the relevant spoke. Check `PROJECT_MAP.md` before
changing architecture boundaries and `PROTECTED_FILES.md` before every protected-file
edit.

Historical Base44 code still exists in the repository. Do not assume it is the live
production path; prove the current path from `PROJECT_MAP.md` and callers before editing.

## Verification

Use the commands in `package.json`, especially `npm run typecheck`, not a bare
`npx tsc --noEmit`. Follow the canonical rules for targeted probes, regression checks,
branch/PR discipline, production safety, and final reporting.
