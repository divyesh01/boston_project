# AI CORE RULES & PHILOSOPHY

These rules apply to ALL AI agents working on this project (Gemini, Claude, Cursor, Copilot, etc.). They grant full permission while demanding absolute rigor and simplicity.

## THE GOLDEN RULES

1. **NEVER GUESS, ONLY PROVE.**
   - Do not make assumptions.
   - Scan the whole codebase/database before writing code or making decisions.
   - Always run tests and provide terminal output as proof.
   - If you aren't 100% sure, write a probe/test to prove it first.

2. **ALWAYS FIX FROM THE CORE.**
   - Do not apply band-aids.
   - Find the root cause of the problem and fix it there.
   - If the core is complex, simplify it.

3. **EXPLAIN LIKE I'M 10 YEARS OLD.**
   - Documentation, code comments, and explanations must be so simple that a 10-year-old could read it, understand it, and make a decision based on it.
   - Use plain language. Avoid unnecessary jargon.
   - Be smart, but make it easily understandable.

4. **FULL PERMISSION GRANTED.**
   - You have full permission to **edit, delete, create, or refactor** whatever you want, provided it follows the rules above.
   - *Exception: Do not modify files explicitly listed in PROTECTED_FILES.md without owner authorization.*

5. **CLAUDE PROOF RULE (NO FAKE ATTRIBUTION OR SIMULATED ACTIONS).**
   - No action may be labeled "Claude reviewed", "Claude proposed", or "Claude edited" unless a successful real Claude API generation exists.
   - Must record its exact OpenRouter Generation ID (`gen-...`), actual model, upstream provider, token usage, cost, latency, and HTTP 200 success.
   - The Generation ID must be verifiable in OpenRouter Logs.
   - If any of these are missing (e.g. HTTP 402, HTTP 429, or offline fallback), report **`CLAUDE = UNPROVEN`** and NEVER simulate Claude's contribution using Gemini or persona text.
   - Deterministic engineering fixes without a live Claude API response must be transparently labeled as **`DETERMINISTIC_ENGINEERING_FIX (NON_AI)`**.

## THE WORKFLOW

1. **Scan Everything:** Before starting a task, search the codebase, read relevant files, and understand the full context.
2. **Prove the Problem:** Write a test that fails to prove the problem exists.
3. **Fix the Core:** Apply the fix to the root cause.
4. **Prove the Fix:** Run the test again to show it passes.
5. **Document Simply:** Update documentation (like BRAIN.md) in simple, 10-year-old friendly language.

