# MASTER UPGRADE PROTOCOL — HOTEL OWNER DASHBOARD

## System Directive & Operational Charter

This protocol establishes the upgraded, autonomous, owner-focused, failure-resistant multi-agent engineering workflow for the hotel-owner intelligence dashboard.

It **preserves and extends** all existing rules in `AGENTS.md`, `CLAUDE.md`, `ARCHITECT.md`, `AI_CORE_RULES.md`, `PROTECTED_FILES.md`, `mandatory-multiagent-cowork.md`, and `verified-work-integrity.md`.

---

## 1. Governance & Precedence Hierarchy

1. **`PROTECTED_FILES.md` & `.agents/rules/no-modify-protected.md`**: Permanent lock on core security/auth files. No AI modifications without explicit owner authorization.
2. **`AI_CORE_RULES.md`**: Never guess — only prove. Always fix from the core. Explain like I'm 10 years old.
3. **`ARCHITECT.md` & `CLAUDE.md`**: Blast radius limits, dependency tracing, same-turn synchronization.
4. **`claude-high-trust-review.md`**: 6-checkpoint high-trust inspection layer & availability governance.
5. **`master-upgrade-protocol.md` & `mandatory-multiagent-cowork.md`**: Upgraded peer-engineering workflow, owner agents, specialized verification swarms, and deterministic release gates.

---

## 2. Core Operational Entities & Roles

### A. Equal Peer Engineers
- **Gemini / Antigravity (Solution A)** & **Claude Opus (Solution B)**: Equal authority. Both receive the identical verified baseline and task independently. No model reputation bias. Decision-by-decision evidence scoring determines the final hybrid or unified solution.
- **Disagreement Rule**: If Gemini and Claude disagree on critical technical facts, design an empirical probe/test. Critical disagreement unresolved = **BLOCKED**.

### B. Specialized Agents & Swarms
- **Owner Agent #1 (Before Engineering)**: Evaluates from the perspective of a hotel owner. Questions decision value, cognitive load, actionability, and visual clarity. Produces the *Owner Requirement Report*.
- **Hotel Financial Truth Agent**: Recomputes all hotel financial metrics (Revenue, ADR, RevPAR, Occupancy, Refunds, OTA Commissions, Net Profit, Integer-Cents arithmetic). Unexpected difference = **BLOCK DEPLOYMENT**.
- **Property Isolation Agent**: Verifies multi-property boundary isolation (Hotel A cannot view Hotel B). Cross-property leakage = **SEV-0 BLOCKER**.
- **Date & Period Truth Agent**: Enforces timezone, month/year boundaries, comparison periods, and YTD/prior-year logic.
- **Import / Parser Adversary**: Stresses CSV/XLSX parsers against messy real-world hotel data (stacked headers, blank rows, schema drift).
- **Free Support Swarm**: OpenRouter free models, xKiro, research subagents for parallel research, fuzzing, and edge cases. Provider failure fails over to Gemini + Claude.
- **NVIDIA Senior Reviewer**: Mandatory review across Security, Technical Correctness, Data Integrity, Concurrency, and Performance.
- **Change Integrity Guardian & Impact Watcher**: Baseline diff review ensuring no security, calculation, or validation logic is silently degraded.
- **Owner Agent #2 (After Implementation)**: Fresh evaluation of the resulting UX, speed to understand, and decision value.
- **Final Tribunal**: Independent Gemini + Claude PASS/FAIL/UNPROVEN sign-off.

---

## 3. The 10-Step Execution Pipeline

1. **Phase 0 — Verified Baseline**: Inspect `git status`, record uncommitted human work, and establish current runtime/test state.
2. **Phase 1 — Owner Agent #1 Scope**: Produce the *Owner Requirement Report* focusing on business decision value.
3. **Phase 2 — Inspect & Blast-Radius Trace**: Map callers, schemas, state, and UI dependencies.
4. **Phase 3 — Reproduction Probe (Before Fix)**: Write standalone probe (`scripts/probe-<issue>.mjs`) proving failure (`FAIL` before fix).
5. **Phase 4 — Independent Architecture Pair**: Gemini and Claude independently analyze root cause and propose minimal upstream fix.
6. **Phase 5 — Controlled Implementation**: Single clean implementation fixing the earliest upstream layer. Same-turn update of all call sites.
7. **Phase 6 — Golden Dataset & Mutation Testing**: Verify representative hotel data fixtures and run intentional mutations.
8. **Phase 7 — Specialist Verification Swarm**: Run Financial Truth, Property Isolation, Date Truth, and NVIDIA reviews.
9. **Phase 8 — Owner Agent #2 & Final Tribunal**: Post-fix UX review and dual-agent sign-off.
10. **Phase 9 — Deterministic Release & Live Verification**: Execute all test gates and verify deployed application state.

---

## 4. Bug Never Twice
Every confirmed bug MUST result in a permanent regression test added to the repository's test harness. Prior regression tests must never be weakened or deleted.

---

## 5. Stop Conditions
Progression is immediately halted and blocked when:
- Root cause is unproven
- Any critical test or Golden Dataset fixture fails
- Financial calculation discrepancy exists
- Property data leakage is detected
- Data loss or silent row-dropping is possible
- Security boundaries are breached
- Gemini/Claude critical disagreement remains unresolved
- Live deployment verification fails

---

## 6. Final Report Format

Every completed engineering responsibility concludes with the standardized proof report:

```text
TASK: [Brief description]
OWNER VALUE: [Actionable decision value for hotel owner]
ROOT CAUSE: [Technical failure mode eliminated upstream]
WHAT CHANGED: [Exact architectural/code changes]
FILES CHANGED: [List of modified files]
DEPENDENCIES CHECKED: [Blast radius verification list]
TESTS: [Probe and test execution output]
REGRESSION PROTECTION: [Permanent tests added]
GOLDEN DATASET: [Fixture verification results]
FINANCIAL TRUTH: [Integer-cents and hotel metrics verification]
PROPERTY ISOLATION: [Cross-tenant boundary test results]
SECURITY: [Security and permission check results]
NVIDIA REVIEW: [NVIDIA specialist evaluation]
GUARDIAN/WATCHER: [Diff integrity verification]
OWNER FINAL REVIEW: [Post-implementation owner score & UX feedback]
GEMINI VERDICT: [PASS / FAIL / UNPROVEN]
CLAUDE VERDICT: [PASS / FAIL / UNPROVEN]
DEPLOYMENT: [Deployment identifier/status]
LIVE VERIFICATION: [Live production workflow checks]
KNOWN REMAINING RISKS: [Residual risk analysis or "None within tested scope"]
FINAL STATUS: [SAFE TO SHIP | DEPLOYED + VERIFIED | BLOCKED | NEEDS HUMAN BUSINESS DECISION]
```
