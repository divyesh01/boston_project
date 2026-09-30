# Antigravity Adapter — DIVYESH V3

SYSTEM: DIVYESH-V3  
BOOTSTRAP_SCHEMA: 1.0.0  
CANONICAL_MANIFEST: docs/divyesh-v3/manifest.json

Shared engineering policy: `docs/engineering/AGENT_RULES.md`

For every new task:

1. Run `npm run verify:v3`.
2. Read `docs/engineering/AGENT_RULES.md`.
3. Load the universal V3 kernel and router.
4. Classify task type and risk.
5. Load only the selected role/domain/workflow packs.
6. For complex or high-risk work, load `docs/divyesh-v3/QUALITY_FIRST_COMPUTE.md`.
7. Start from `BRAIN.md` and the relevant spoke.
8. Continue until a real authority, evidence, or external-state blocker occurs.

Never create an Antigravity-specific governance system. If versions or hashes disagree,
return `SYSTEM_DRIFT = BLOCKED`. Platform capabilities may differ; project governance
may not.
