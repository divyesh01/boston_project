---
name: divyesh-v3-router
description: Route repository tasks through the canonical DIVYESH V3 kernel and only the relevant role, domain, and workflow packs.
---

# DIVYESH V3 Router

BOOTSTRAP_SCHEMA: 1.0.0  
CANONICAL_MANIFEST: docs/divyesh-v3/manifest.json

1. Read `docs/divyesh-v3/manifest.json` and verify it with
   `node scripts/verify-divyesh-v3.mjs --startup --json`.
2. Read `docs/engineering/AGENT_RULES.md` as the shared engineering contract.
3. Read `docs/divyesh-v3/KERNEL.md` and `docs/divyesh-v3/ROUTER.md` completely.
4. Select the minimum relevant packs from `docs/divyesh-v3/PACK_INDEX.md`.
5. Read every selected canonical pack completely before acting.
6. Do not duplicate, reinterpret, or cache canonical rules in this skill.
7. If verification fails, stop with `SYSTEM_DRIFT = BLOCKED`.
