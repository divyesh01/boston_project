# CLAUDE.md — Claude / OpenCode Adapter

> Canonical engineering policy: [`docs/engineering/AGENT_RULES.md`](./docs/engineering/AGENT_RULES.md)
>
> This file contains Claude/OpenCode bootstrapping only. Shared engineering rules belong
> in the canonical document above.

## Protected files

Read [`PROTECTED_FILES.md`](./PROTECTED_FILES.md) before editing. A protected file may
be changed only with explicit owner authorization in the current task.

<!-- DIVYESH-V3-BOOTSTRAP:START -->
## DIVYESH V3 AUTO-BOOTSTRAP

SYSTEM: DIVYESH-V3
VERSION: 3.0.0
BOOTSTRAP_SCHEMA: 1.0.0
CANONICAL_MANIFEST: docs/divyesh-v3/manifest.json

@docs/divyesh-v3/KERNEL.md
@docs/divyesh-v3/ROUTER.md
@docs/divyesh-v3/QUALITY_FIRST_COMPUTE.md
@docs/engineering/AGENT_RULES.md

Before substantive work, run `npm run verify:v3`. If manifest, protocol hash, or
bootstrap verification fails, stop with `SYSTEM_DRIFT = BLOCKED`. Load only the
relevant role/domain/workflow packs selected by the router.

Platform capabilities may differ; project governance may not.
<!-- DIVYESH-V3-BOOTSTRAP:END -->

## Claude/OpenCode routing

Use `BRAIN.md` as the repository hub and read the relevant spoke. Use
`PROJECT_MAP.md`, `ARCHITECT.md`, `SECURITY.md`, `TESTING.md`, `BUSINESS.md`, and
`UI_UX.md` only when the task touches those domains.

Do not duplicate their rules in this adapter. In particular, verification uses
`npm run typecheck`; never substitute bare `npx tsc --noEmit`.

For historical Anthropic references, use `Anthropic/` as reference material only, not
as a second source of repository governance.
