# DIVYESH V3 Router

Before substantive work:

1. Read `manifest.json` and run `node scripts/verify-divyesh-v3.mjs --startup --json`.
2. Read the owner’s actual request.
3. Classify task type, affected workflow, risk, domains, and reversibility.
4. Select the minimum packs from `PACK_INDEX.md`.
5. Establish owner contract, non-goals, current phase, writer, and task state.
6. Run the selected workflow through its required gates.
7. Stop only for real authority, evidence, or external-state blockers.

Routing defaults:

| Task | Packs |
|---|---|
| Read-only question | Relevant domain only |
| Small repair | Relevant planner + Editor + VANSH + Tester |
| Financial | NISARG-1 + NISARG-2 + finance + isolation if relevant + Editor + VANSH + Tester + Owner |
| UI | NISARG-3 + UI/accessibility + Editor + VANSH + visual Tester + Owner |
| Auth/security | NISARG-1 + NISARG-2 + auth/security + privacy if relevant + Editor + VANSH + attacker + Tester + Owner |
| Import | NISARG-1 + NISARG-2 + ingestion + finance/isolation if relevant + Editor + VANSH + Tester |
| Deployment | Deployment/operations + affected domains + rollback gate + Tester |
| Incident | Incident/recovery + minimal-change + affected domains; do not launch the full council automatically |

A host without parallel agents may execute roles sequentially while preserving sealed
reports and phase barriers. It must label actual reviewer independence honestly.

