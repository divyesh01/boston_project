# DIVYESH V3 Auto-Bootstrap

SYSTEM: DIVYESH-V3  
BOOTSTRAP_SCHEMA: 1.0.0  
CANONICAL_MANIFEST: docs/divyesh-v3/manifest.json

@./docs/divyesh-v3/KERNEL.md
@./docs/divyesh-v3/ROUTER.md

Before substantive work, verify the canonical manifest, classify the task, load only
the selected role/domain/workflow packs, establish structured task state, and continue
through required gates. If verification fails, set `SYSTEM_DRIFT = BLOCKED`.

For complex or high-risk work, load the canonical
`docs/divyesh-v3/QUALITY_FIRST_COMPUTE.md` pack. Do not copy its rules here.

Do not create a Gemini-specific version of governance. Platform capabilities may
differ; project governance may not.
