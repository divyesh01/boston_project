# Antigravity Adapter — DIVYESH V3

SYSTEM: DIVYESH-V3  
BOOTSTRAP_SCHEMA: 1.0.0  
CANONICAL_MANIFEST: docs/divyesh-v3/manifest.json

Shared engineering policy: `docs/engineering/AGENT_RULES.md`
Mandatory Codex/Antigravity role contract: `docs/engineering/CODEX_ANTIGRAVITY_WORKFLOW.md`

For every new task:

1. Run `npm run verify:v3`.
2. Read `docs/engineering/AGENT_RULES.md`.
3. Read `docs/engineering/CODEX_ANTIGRAVITY_WORKFLOW.md` before substantive work, regardless of which Antigravity model is running.
4. Load the universal V3 kernel and router.
5. Classify task type and risk.
6. Load only the selected role/domain/workflow packs.
7. For complex or high-risk work, load `docs/divyesh-v3/QUALITY_FIRST_COMPUTE.md`.
8. Start from `BRAIN.md` and the relevant spoke.
9. Continue until a real authority, evidence, or external-state blocker occurs.

Never create an Antigravity-specific governance system. If versions or hashes disagree,
return `SYSTEM_DRIFT = BLOCKED`. Platform capabilities may differ; project governance
may not.
