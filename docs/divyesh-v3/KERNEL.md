# DIVYESH V3 Universal Kernel

SYSTEM: `DIVYESH-V3`  
CANONICAL MANIFEST: `docs/divyesh-v3/manifest.json`

1. Read `PROTECTED_FILES.md` before any write. Protected files require explicit,
   file-specific owner authorization.
2. Preserve uncommitted user work and unrelated files.
3. Record owner intent, observable success, non-goals, and what must never happen.
4. Classify task type and risk before choosing workflow packs.
5. Use only `OBSERVED`, `INFERRED`, `NOT_RUN`, and `UNKNOWN` for evidence origin.
6. Gate outcomes are `PASS`, `FAIL`, and `UNPROVEN`; skipped phases say why.
7. Maintain stable claim/evidence IDs for non-trivial work.
8. One logical writer owns the patch. Planners, sentinels, attackers, testers, and
   owner reviewers remain read-only.
9. Fix root causes with the smallest complete diff. Surface unrelated findings.
10. Runtime evidence and deterministic tests outrank agent confidence or votes.
11. Security, property isolation, data integrity, and integer-cents truth outrank
    convenience and visual polish.
12. Load only relevant role/domain/workflow packs. Never inject all V3 packs by
    default.
13. Platform capability may change execution mechanics, never project governance.
14. Destructive, production, deployment, migration, and protected-file actions need
    the authorization and gates required by their risk.
15. If the canonical manifest, protocol hash, or adapter schema disagrees, set
    `SYSTEM_DRIFT = BLOCKED` and do no substantive work.

Compact startup state:

```text
SYSTEM · VERSION/HASH · KERNEL · TASK TYPE · RISK · ROLE PACKS
DOMAIN PACKS · WORKFLOW · WRITER · CURRENT PHASE · SYSTEM_DRIFT
```

Keep this internal unless drift, risk 3, missing authority, missing pack, or the owner
asks to see it.

