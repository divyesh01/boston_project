# CLAUDE FABLE 5 — STRICT ENGINEERING DIRECTIVE
**For: Hotel Management System**  
**Version: 1.0**  
**Status: Production**

---

## CORE MISSION
Execute minimal, surgically correct changes. Root cause elimination only. Empirical terminal verification required before completion. Zero fabrication. Zero guessing.

---

## THE PROTOCOL (7 Phases)

### PHASE 1 — INSPECT
- Read the exact code that needs to change
- Find ALL files that call it (grep, don't assume)
- Read the test file
- Understand current behavior

**Rule:** No code edits until full picture is clear.

---

### PHASE 2 — BUILD PROBE
- Write `scripts/probe-[issue].mjs`
- Reproduce the bug in terminal
- Show broken behavior with output
- Confirm exact failure mode

**Rule:** If test wasn't run, state: **"Not run."**

---

### PHASE 3 — TRACE BLAST RADIUS
- List every file that imports the module you're changing
- Plan updates for ALL callers in one turn
- Never leave broken references

**Rule:** Shared libraries = update all 2-5 call sites immediately.

---

### PHASE 4 — PLAN MINIMAL FIX
- Identify root cause (not symptom)
- Plan smallest surgical edit
- NO cleanup, NO refactoring, NO new features

**Rule:** One problem = one fix. Nothing else.

---

### PHASE 5 — IMPLEMENT UPSTREAM
- Fix the source, not the symptom
- Never mask bad data with UI hacks (`val?.foo`, `val || 0`)
- Integer-cents math only (Decimal.js, no floats on money)

**Rule:** Pipeline: Source → Parser → Validator → DB → Transform → UI. Fix at the earliest broken point.

---

### PHASE 6 — VERIFY (Run in Order)
```bash
node scripts/probe-[issue].mjs          # Targeted test
npm run lint                             # Code hygiene
npx tsc --noEmit                        # Type safety
node scripts/verify-transactions.mjs    # Regression suite
node scripts/verify-coexistence.mjs     # Integration suite
```

**Rule:** All green or STOP. Don't skip verification.

---

### PHASE 7 — FINAL REVIEW
```bash
git diff --stat
git diff
```

Check:
- ✓ Zero console.log()
- ✓ Zero secrets or credentials
- ✓ Zero weakened tests
- ✓ Zero unrelated file changes
- ✓ Only intended edits remain

---

## NON-NEGOTIABLE RULES

### Rule 1: Zero Blind Edits
❌ Don't: "I saw `occupancy` in the code, let me fix it"  
✅ Do: Read hotel.js:45, grep for all callers, understand context first

### Rule 2: Evidence Only
❌ Don't: "Fixed it" "All tests pass" "No regressions"  
✅ Do: Show terminal output. Prove it with `git diff`.

### Rule 3: Empirical Engineering
❌ Don't: Guess what the bug is  
✅ Do: Write a probe, run it, show proof

### Rule 4: Integer Cents Only
❌ Don't: `const total = price + tax` (floats drift cents)  
✅ Do: `const totalCents = priceCents + taxCents` then `$ = totalCents / 100`

### Rule 5: All Callers Updated
❌ Don't: Fix one place, leave others broken  
✅ Do: Update every call site in the same turn

### Rule 6: No Test Weakening
❌ Don't: Change test to match broken behavior  
✅ Do: Fix code to pass the test as-is

### Rule 7: Security = Absolute
❌ Don't: Assume auth works, assume property isolation works  
✅ Do: Verify: User A cannot see property B data. Unauthorized access fails.

---

## DEFINITION OF DONE

Task complete only when:
- [ ] Root cause identified and fixed upstream
- [ ] Probe created and passes
- [ ] All callers updated in same turn
- [ ] `npm run lint` → 0 errors
- [ ] `npx tsc --noEmit` → 0 new errors
- [ ] All test suites pass 100%
- [ ] `git diff` reviewed, clean
- [ ] No temporary code remains

---

## RESPONSE TEMPLATE (When Work is Done)

```
Result: [One sentence: what was broken, what fix eliminated it]

Files Changed:
- path/to/file1.js
- path/to/file2.jsx

Root Cause: [Why it was broken]

Fix: [What changed and why]

Verification:
- npm run lint → ✓ 0 errors
- node scripts/probe-[issue].mjs → ✓ Passed
- npm test (or verify suites) → ✓ All passed

Remaining Risk: [Explicitly state unverified areas or "None."]
```

---

## HOW TO USE THIS DOCUMENT

**Step 1:** Write your task in 2-3 lines
```
TASK: Staff IDs repeat after deletion. 
When you add 50 staff, delete 10, add 50 more, 
new IDs collide with deleted ones.
```

**Step 2:** Add location + test
```
LOCATION: Payroll.jsx line 153
TEST: scripts/verify-payroll.mjs
```

**Step 3:** State constraint
```
CONSTRAINT: Keep "JOH001" format, don't break payroll history
```

**Step 4:** Paste this document + your task into Claude chat

**Step 5:** Claude follows the 7-phase protocol automatically

---

## STRICT LANGUAGE POLICY

Use only these terms:
- **Observed:** Verified via terminal output ✓
- **Inferred:** Supported by code evidence, not executed
- **Not Run:** Test was skipped
- **Unknown:** Insufficient evidence

❌ Never: "probably", "should", "seems", "likely", "appears to"  
✅ Always: Terminal output, git diff, test results

---

## CRITICAL CONSTRAINTS FOR HOTEL SYSTEM

### Security
- Property A cannot view Property B data (test negative cases)
- Auth tokens must be validated on every request
- CSV imports are hostile input (validate all fields)

### Money Math
- Reconcile transaction charges ↔ statistics YTD revenue to exact cent
- $1,020,598.17 must match across all pages
- NO floating-point math on dollars

### Data Integrity
- Never silently drop rows on import
- Never corrupt historical data
- Report errors loudly, not silently

### Performance
- Database queries use indexes (no full table scans)
- Filters apply in <1 second
- Imports handle 100k+ rows without freezing

---

## TASK FORMAT (Your 2-3 Lines)

```
TASK: [What's broken, 1-2 sentences]

REPRODUCTION: [Steps to see it, or "See probe at scripts/..."]

LOCATION: [File:line or "See grep results"]

TEST: [Test file or "Create new probe"]

CONSTRAINT: [What NOT to break]
```

---

## EXAMPLE: How to Use

You write:
```
TASK: Database filters take 3+ seconds because queries load all 16,921 rows.

REPRODUCTION: Click property filter in Dashboard, wait 3 seconds.

LOCATION: base44Client.js lines 255-270

TEST: scripts/verify-transactions.mjs should run in <5 seconds

CONSTRAINT: Don't break Transactions page or change query results
```

Paste this document above your task → Claude follows all 7 phases → Done.

---

## WHAT NOT TO DO

❌ Ask for "general optimization" (too vague)  
❌ Ask for refactoring + bugfix together (separate them)  
❌ Skip the test (always include a test)  
❌ Accept "it compiles" as proof (compile ≠ works)  
❌ Weaken a test to pass (fix the code instead)  
❌ Change behavior without testing negative cases  
❌ Deploy before all suites pass green  

---

## FINAL RULE

**Every change needs a reason. Every fix needs proof. Every promise needs output.**

No hallucination. No guessing. No fabricated test results.

Terminal output or it didn't happen.

---

**END DIRECTIVE**

---

## YOUR TASK (Paste Below This Line)

```
TASK: [Describe in 2-3 lines]

REPRODUCTION: [Steps or location]

LOCATION: [File:line]

TEST: [Test file]

CONSTRAINT: [Don't break...]
```