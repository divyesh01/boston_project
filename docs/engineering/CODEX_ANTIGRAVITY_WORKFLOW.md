# Codex + Antigravity Mandatory Work Contract

This file defines the required division of labor between **Codex** and
**Gemini/Antigravity** for this repository.

It applies to **every model, size, reasoning level, and variant** used under either
Codex or Antigravity. A model change does not change the role split.

## Mandatory startup

Before substantive repository work, both sides must read this file.

- Codex reaches this contract through `AGENTS.md -> docs/engineering/AGENT_RULES.md`.
- Antigravity reaches it through `GEMINI.md`, `.agents/agents.md`, and the V3 router.
- If an agent has not read the current contract, it must not claim the task is operating
  under the Codex + Antigravity workflow.

The repository owner may explicitly override the split for a specific task. Without an
explicit override, this contract is the default.

## Codex role: implementation owner

Codex spends its strongest reasoning and context budget on implementation work:

- understand the relevant architecture and existing behavior,
- inspect callers, data boundaries, and dependencies before changing code,
- make a concise implementation plan and fallback,
- write and edit production code,
- fix root causes instead of masking symptoms,
- perform necessary refactors, migrations, integration work, and documentation changes,
- review the final diff for unintended changes,
- respond to concrete failures reported by Antigravity with code fixes.

Codex should not burn substantial budget duplicating work assigned to Antigravity.
When Antigravity is available, Codex does **not** own exhaustive verification,
Playwright/browser sweeps, broad regression suites, mutation testing, stress testing,
long CI-log analysis, or repeated full builds.

Codex may still run:

1. mandatory startup/governance checks,
2. a tiny targeted sanity check when needed to avoid handing off obviously invalid code,
3. extra verification when Antigravity is unavailable or the owner explicitly requests it.

Implementation is not the same as verification. Codex must not call a change green merely
because the code looks correct.

## Antigravity role: verification owner

Antigravity spends its budget on proving whether Codex's implementation is correct.

Antigravity should:

- read the Codex handoff and independently inspect the changed behavior,
- reproduce the original failure or requested behavior when useful,
- run focused tests first, then the relevant regression gates,
- run browser, integration, mutation, security, performance, concurrency, recovery, or
  other broader checks when the risk requires them,
- test negative and edge cases instead of only the happy path,
- verify financial calculations, property isolation, imports, auth boundaries, and
  production-safety invariants when those areas are touched,
- distinguish product-code failures from flaky or broken test infrastructure,
- return exact commands, scenarios, files, logs, and observed results,
- re-test after Codex fixes a reported problem,
- provide the final verification evidence.

Antigravity should **not take over normal production implementation** merely because it
found a failure. The normal response to a product-code failure is to send precise evidence
back to Codex. Antigravity may create or improve tests, probes, fixtures, and verification
infrastructure when that is part of proving the behavior. Production-code edits by
Antigravity require an explicit owner override or a real blocker that prevents Codex from
performing the implementation work.

Antigravity must never weaken an assertion, remove coverage, skip a meaningful check, or
change expected behavior just to produce a green result.

## Required handoff: Codex -> Antigravity

Before asking Antigravity to verify an implementation, Codex should provide:

- branch name,
- base and head commit SHA when available,
- changed files,
- intended user-visible and internal behavior,
- root cause or implementation rationale,
- risky boundaries and likely regression areas,
- invariants that must remain true,
- tests/scenarios Antigravity should run,
- verification Codex deliberately did not run,
- known limitations or unresolved questions.

The handoff should be short enough to use, but precise enough that Antigravity does not
need to rediscover the entire task.

## Required report: Antigravity -> Codex

Antigravity returns one of:

- **PASS** — required verification passed,
- **FAIL** — at least one reproducible problem remains,
- **BLOCKED** — verification cannot be completed because of a real dependency or
  environment blocker.

For FAIL or BLOCKED, include the smallest useful reproduction, exact failing command or
scenario, observed output, expected output, likely affected files/boundary, and whether the
failure appears deterministic or intermittent.

Do not send vague feedback such as "tests failed" when actionable evidence is available.

## Normal operating loop

`Codex plans/implements -> Antigravity tests/verifies -> Codex fixes findings -> Antigravity re-verifies`

Repeat only when new evidence requires another implementation change.

The purpose of the split is not to reduce quality. It is to prevent expensive duplicate
work while giving implementation and verification clear owners.

## Completion rule

A coding task is not fully verified until the verification owner has produced evidence or
the owner explicitly accepts unverified risk.

Codex owns the code change. Antigravity owns the proof. Neither side should silently take
the other's role or claim the other's work was completed.
