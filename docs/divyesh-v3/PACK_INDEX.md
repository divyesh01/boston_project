# V3 Pack Index

Load `KERNEL.md` and `ROUTER.md`, then only the packs justified by the task.

For complex or high-risk Gemini/Antigravity work, also load
`QUALITY_FIRST_COMPUTE.md`. Simple tasks do not load it automatically.

## Roles

| Need | Pack |
|---|---|
| Orchestration and ledger | `roles/commander.md` |
| Architecture, workflow, archaeology | `roles/nisarg-1-architecture.md` |
| Risk, security, reliability, tests | `roles/nisarg-2-risk.md` |
| Owner, product, UX | `roles/nisarg-3-owner.md` |
| Implementation | `roles/editor.md` |
| Sealed sentinel and diff review | `roles/vansh.md` |
| Independent adversarial review | `roles/independent-attacker.md` |
| Empirical and mutation verification | `roles/tester.md` |
| Final user acceptance | `roles/owner-agent.md` |

## Domains

Finance, authentication/security, property isolation, imports/ingestion,
UI/accessibility, privacy/destructive work, deployment/operations, and
incident/recovery each have one file under `domains/`.

## Workflows

Choose exactly one primary workflow under `workflows/`. Add domain packs as needed.
Read-only work must not inherit a change workflow merely because one exists.
