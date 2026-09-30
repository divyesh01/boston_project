# GEMINI.md — Gemini / Antigravity Adapter

> Canonical engineering policy: [`docs/engineering/AGENT_RULES.md`](./docs/engineering/AGENT_RULES.md)
>
> Do not create a Gemini-specific fork of repository governance.

SYSTEM: DIVYESH-V3
VERSION: 3.0.0
BOOTSTRAP_SCHEMA: 1.0.0
CANONICAL_MANIFEST: docs/divyesh-v3/manifest.json

@./docs/divyesh-v3/KERNEL.md
@./docs/divyesh-v3/ROUTER.md
@./docs/divyesh-v3/QUALITY_FIRST_COMPUTE.md
@./docs/engineering/AGENT_RULES.md

Before substantive work:

1. Read `PROTECTED_FILES.md`.
2. Run `npm run verify:v3`.
3. Classify the task with the V3 router and load only the selected packs.
4. Apply `docs/engineering/AGENT_RULES.md`.
5. Start from `BRAIN.md` and the relevant spoke rather than scanning unrelated code.

If verification fails, set `SYSTEM_DRIFT = BLOCKED`.

Use `npm run typecheck`; do not use bare `npx tsc --noEmit`. Platform capabilities
may differ; project governance may not.
