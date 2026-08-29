# MASTER PARALLEL ENGINEERING PROTOCOL
# GEMINI + CLAUDE — BOTH WORK ON EVERY TASK

This rule applies to EVERY engineering task.

There is no "primary model does the work and the other only reviews."

Gemini and Claude Opus are PEER ENGINEERS.

For EVERY task:

USER TASK
   ↓
SAME VERIFIED BASELINE
   ↓
┌────────────────────┬────────────────────┐
│ GEMINI SOLUTION A  │ CLAUDE SOLUTION B  │
│ independent work   │ independent work   │
└────────────────────┴────────────────────┘
           ↓
   EVIDENCE COMPARISON
           ↓
BEST PARTS OF A + B
           ↓
FINAL UNIFIED SOLUTION
           ↓
NVIDIA + GUARDIAN + WATCHER + TESTS


==================================================
1. ABSOLUTE RULE — BOTH MUST RUN
==================================================

For EVERY engineering task:

Gemini MUST independently:
- understand the request
- inspect evidence
- identify root cause
- propose solution
- identify risks
- propose tests
- implement its solution when code changes are required

Claude Opus MUST independently:
- understand the SAME request
- inspect the SAME relevant evidence
- identify root cause
- propose solution
- identify risks
- propose tests
- implement its solution when code changes are required

Neither model may simply copy the other's reasoning.

They must independently reach their own conclusions first.

A task is NOT considered properly processed until BOTH Gemini and Claude have contributed.


==================================================
2. SAME STARTING BASELINE
==================================================

Both engineers must start from exactly the SAME PRE-TASK BASELINE.

Important:

PRE-TASK BASELINE means the actual working state at the moment the task begins.

It is NOT automatically Git HEAD.

Uncommitted work may contain valuable changes.

Before work begins capture:

- git branch
- git status
- git diff
- relevant untracked files
- relevant modified files
- important runtime/database state if applicable
- existing test results where relevant

Gemini and Claude must receive equivalent starting material.


==================================================
3. ISOLATED WORKSPACES
==================================================

Gemini and Claude must NEVER edit the same working tree simultaneously.

For tasks involving code changes create isolated workspaces/worktrees:

Gemini:
agent/gemini-<task>

Claude:
agent/opus-<task>

Both must originate from the same verified baseline.

If the baseline contains uncommitted changes, safely reproduce the relevant baseline in BOTH workspaces before implementation.

Do not silently drop uncommitted work.


==================================================
4. PARALLEL EXECUTION
==================================================

After baseline verification:

Run Gemini and Claude simultaneously whenever practical.

GEMINI — SOLUTION A

Investigate:
- root cause
- dependencies
- data flow
- API/state/database interactions
- UX impact
- edge cases

Then produce:
- implementation plan
- code changes
- tests
- evidence


CLAUDE OPUS — SOLUTION B

Independently investigate:
- root cause
- dependencies
- state/database/API behavior
- security
- edge cases
- architecture

Then produce:
- implementation plan
- code changes
- tests
- evidence


Do not allow Gemini to see Claude's proposed implementation before Gemini has formed Solution A.

Do not allow Claude to simply approve Gemini.

Independent thinking comes first.


==================================================
5. NO MODEL REPUTATION
==================================================

Never decide:

"Claude is smarter, therefore Claude wins."

Never decide:

"Gemini owns the repo, therefore Gemini wins."

MODEL REPUTATION IS NOT EVIDENCE.

Every individual decision must be judged using proof.


==================================================
6. DECISION LEVEL COMPARISON
==================================================

Do NOT compare only the entire Solution A vs entire Solution B.

Compare decisions individually.

Example:

Authentication validation:
Gemini approach may be stronger.

Database transaction:
Claude approach may be stronger.

UI error handling:
Gemini approach may be stronger.

Concurrency protection:
Claude approach may be stronger.

Testing:
both may contribute useful cases.

Therefore the final implementation may be:

Gemini part
+
Claude part
+
shared improvements

= HYBRID SOLUTION C


==================================================
7. ACCEPTABLE FINAL OUTCOMES
==================================================

There are only three valid final outcomes:

A. GEMINI SOLUTION

Use Gemini's implementation when evidence proves it is superior across the relevant dimensions.


B. CLAUDE SOLUTION

Use Claude's implementation when evidence proves it is superior.


C. HYBRID SOLUTION

Use the strongest proven parts from BOTH solutions.

Hybrid is encouraged when:

- Gemini solves one area better
- Claude solves another area better
- each found unique edge cases
- one implementation has stronger architecture
- the other has better UX
- one has better performance
- the other has better security
- combining them creates a superior solution


==================================================
8. EVIDENCE SCORING
==================================================

Judge each important decision using:

1. REQUIREMENT COVERAGE
Does it actually solve the user's request?

2. ROOT-CAUSE QUALITY
Does it fix the real cause rather than symptoms?

3. DETERMINISTIC TESTS
Which approach has stronger passing tests?

4. REGRESSION SAFETY
Does existing good behavior remain intact?

5. SECURITY
Does it introduce or eliminate security risks?

6. DATA INTEGRITY
Could it corrupt, miscalculate, duplicate, or lose data?

7. DEPENDENCY IMPACT
Are connected components handled correctly?

8. CONCURRENCY / STATE
Could timing, async behavior, caching, tabs, retries, or state synchronization break it?

9. PERFORMANCE
Does it introduce unnecessary work or improve performance?

10. MAINTAINABILITY
Is the solution understandable and sustainable?

11. SCOPE CONTROL
Does it solve the task without unnecessary rewrites?

12. UI/UX
For user-facing work, which implementation produces the clearer, more premium experience?

Evidence decides.


==================================================
9. GRAPHIFY FIRST
==================================================

Before medium/high-impact implementation, and whenever dependencies are unclear:

Graphify:

User Problem
↓
Observable Failure
↓
Core Problem
↓
Root Cause
↓
Files
↓
Functions
↓
Callers / Callees
↓
Database / State
↓
APIs
↓
UI
↓
Reports / Calculations
↓
Tests
↓
Side Effects

Every important edge requires evidence.

If evidence is missing:

UNKNOWN — NEEDS VERIFICATION.


==================================================
10. xKIRO — RESEARCH TEAM
==================================================

xKiro supports BOTH Gemini and Claude.

Its job:

- official documentation
- GitHub issues
- implementation references
- library/framework behavior
- database patterns
- API documentation
- edge cases
- alternative solutions
- research evidence
- test ideas
- known security concerns

xKiro does NOT choose the winner.

It supplies evidence.


==================================================
11. OPENROUTER FREE — SUPPORT TEAM
==================================================

OpenRouter Free assists BOTH engineering branches.

Use it for:

- adversarial test cases
- additional edge cases
- log analysis
- code-diff review
- regression ideas
- repetitive verification
- documentation comparison
- alternative approaches

Use only FREE models.

Best suitable model first.

If unavailable:

best model
→ second-best
→ third-best
→ safe free fallback


==================================================
12. NVIDIA — ALWAYS-ON SENIOR SPECIALIST
==================================================

NVIDIA NIM MUST participate in EVERY coding task.

No task is too small.

NVIDIA is responsible for:

SECURITY
- authorization
- authentication
- property/tenant isolation
- unsafe inputs
- injection
- data exposure
- trust boundaries

TECHNICAL REVIEW
- architecture
- correctness
- state management
- async behavior
- API use
- database behavior

DATA INTEGRITY
- incorrect writes
- partial writes
- duplicate writes
- stale identifiers
- invalid states
- financial calculations

CONCURRENCY
- race conditions
- multi-tab behavior
- retries
- stale cache
- optimistic UI
- event ordering

PERFORMANCE
- unnecessary work
- expensive loops
- repeated queries
- render problems
- memory risks


NVIDIA uses the strongest available suitable model first.

Dynamic NVIDIA catalog is the source of truth.

Preferred logic:

strongest model
→ second-best model
→ fast fallback
→ reliable fallback

If a configured model is unavailable, skip it.

Do not use stale model IDs.


==================================================
13. NVIDIA DOES NOT CHOOSE BY OPINION
==================================================

NVIDIA acts as specialist reviewer.

It may say:

CLEAR
WARNING
BLOCK

But its claims must also contain evidence.

NVIDIA does not automatically override Gemini or Claude.

If NVIDIA identifies a real defect:

return evidence to both engineers.

Repair based on evidence.


==================================================
14. CHANGE INTEGRITY GUARDIAN
==================================================

After selecting/building the unified solution:

Run Change Integrity Guardian.

Compare against the exact PRE-TASK BASELINE.

Guardian checks:

- deleted behavior
- removed validation
- altered calculations
- removed security checks
- replaced production logic
- hardcoded values
- dummy implementations
- deleted assertions
- weakened tests
- changed expected values merely to match broken behavior

Deletion is acceptable only when behavior remains correct or improves.

Classify:

EXPECTED CHANGE
SAFE CLEANUP
JUSTIFIED REPLACEMENT
UNKNOWN
SUSPICIOUS REGRESSION
CRITICAL REGRESSION

UNKNOWN blocks completion until investigated.


==================================================
15. DEPENDENCY & IMPACT WATCHER
==================================================

After implementation run Impact Watcher.

Trace:

- imports
- exports
- callers
- callees
- database schema
- state
- caching
- APIs
- calculations
- reports
- UI
- tests
- deployment/runtime implications

Question:

"What else does this change touch?"

Unexpected dependencies return to Planner.


==================================================
16. TEST AUTHORITY
==================================================

AI confidence is NOT proof.

Run deterministic verification.

Examples:

- targeted unit tests
- regression tests
- project probes
- integration tests
- typecheck
- lint
- build
- security checks
- API tests
- database tests
- production scenario verification where appropriate

Never weaken a test to make an implementation pass.

Tests are evidence, not something to manipulate.


==================================================
17. SOLUTION EVALUATOR
==================================================

After Gemini A and Claude B complete:

Create:

SOLUTION COMPARISON

Requirement:
Gemini:
Claude:
Winner:
Evidence:

Root cause:
Gemini:
Claude:
Winner:
Evidence:

Security:
Gemini:
Claude:
Winner:
Evidence:

Data integrity:
Gemini:
Claude:
Winner:
Evidence:

Dependencies:
Gemini:
Claude:
Winner:
Evidence:

Testing:
Gemini:
Claude:
Winner:
Evidence:

Performance:
Gemini:
Claude:
Winner:
Evidence:

UX:
Gemini:
Claude:
Winner:
Evidence:


Then determine:

FINAL:
GEMINI
CLAUDE
HYBRID


==================================================
18. HYBRID INTEGRATION RULE
==================================================

If HYBRID is chosen:

Do NOT blindly combine both diffs.

Create a clean final implementation plan.

For each adopted part state:

Source:
Gemini / Claude

Why selected:
Evidence

Dependencies:
Evidence

Risks:
Evidence

Then implement the unified solution cleanly.

Avoid duplicated logic caused by mechanical merging.


==================================================
19. FAILURE PACKET LOOP
==================================================

If any reviewer/test/gate fails:

Create:

FAILURE PACKET

Failed requirement:
Exact failure:
Evidence:
Affected files:
Affected behavior:
Attempted solution:
Why it failed:
Gemini contribution:
Claude contribution:
NVIDIA finding:
Do-not-repeat:
Next investigation:

Send the Failure Packet back to BOTH Gemini and Claude.

Both reconsider the failed area independently.

Compare their new fixes again.

Maximum automatic repair cycles: 5.


==================================================
20. GIT SAFETY
==================================================

Do NOT automatically commit, push, merge, or deploy unless explicitly authorized by the user or existing release automation permits it.

Before release:

git status
git diff
git diff --stat

Confirm:

Guardian CLEAR
Impact Watcher CLEAR
NVIDIA CLEAR
Required reviewers CLEAR
Tests PASS
No secrets
No unrelated files
No debug code
No weakened tests

No force push.

No reset --hard without explicit approval.


==================================================
21. PRODUCTION SENTINEL
==================================================

After an authorized deployment:

Verify the REAL production scenario.

Do not treat HTTP 200 alone as success.

Verify:

- actual workflow
- data/state result
- user-facing behavior
- errors
- regressions
- important connected functionality


==================================================
22. MANDATORY FINAL PROOF
==================================================

Every completed engineering task must include:

[GEMINI PROOF]

Subagent/session:
Plan:
Implementation:
Unique findings:
Tests:


[CLAUDE OPUS PROOF]

Provider:
Requested model:
Returned model:
Fallback:
Correlation ID:
Plan:
Implementation:
Unique findings:


[xKIRO PROOF]

Provider/model:
Research contribution:
Evidence:


[OPENROUTER PROOF]

Model:
Support contribution:
Evidence:


[NVIDIA PROOF]

Requested model:
Returned model:
Fallback:
Security verdict:
Technical verdict:
Data integrity verdict:
Concurrency verdict:
Performance verdict:


[SOLUTION COMPARISON]

Gemini strengths:
Claude strengths:

Selected Gemini parts:
Selected Claude parts:

Rejected Gemini parts + reason:
Rejected Claude parts + reason:

Final solution:
GEMINI / CLAUDE / HYBRID


[GUARDIAN]

CLEAR / BLOCK
Evidence:


[IMPACT WATCHER]

CLEAR / BLOCK
Evidence:


[TESTS]

Commands:
Passed:
Failed:


[FINAL RESULT]

Requirements satisfied:
Regressions:
Remaining risks:
Production verified:
YES / NO


==================================================
23. CRITICAL RULES
==================================================

EVERY TASK = GEMINI + CLAUDE.

Both independently investigate.

Both independently propose a solution.

Both may implement their own solution.

They must never simultaneously edit the same workspace.

Both start from the same verified baseline.

Neither automatically wins.

Every individual decision is evidence-scored.

Final implementation may use the strongest parts from BOTH.

xKiro researches.

OpenRouter supports.

NVIDIA reviews EVERY coding task.

Guardian protects previously working behavior.

Watcher protects dependencies.

Tests determine whether behavior actually works.

NO GUESSING.

NO MODEL REPUTATION.

NO BLIND MERGING.

NO TEST WEAKENING.

NO UNPROVEN CLAIMS.

UNKNOWN = INVESTIGATE.

EVIDENCE > OPINION.

THE GOAL IS NOT:
"Gemini wins" or "Claude wins."

THE GOAL IS:

BEST PROVEN GEMINI IDEAS
+
BEST PROVEN CLAUDE IDEAS
+
RESEARCH
+
SECURITY REVIEW
+
REGRESSION PROTECTION
+
DETERMINISTIC TESTING

=

THE STRONGEST FINAL IMPLEMENTATION.

