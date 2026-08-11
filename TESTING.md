# TESTING DIRECTIVES — EMPIRICAL PROBING & RELENTLESS QA

## 1. EMPIRICAL PROBING FIRST
- Never assume code works based on static visual inspection alone.
- Before modifying application code, create a temporary probe script in `scripts/` (e.g. `node scripts/probe-*.mjs`) and execute it in the terminal against real sample CSV files or IndexedDB records.
- Observe raw execution output, stack traces, and data structures to confirm root causes.

## 2. CLOSED-LOOP QA CYCLE
- Execute: Edit Code $\rightarrow$ Run `npm run lint` $\rightarrow$ Run `node scripts/verify-transactions.mjs`.
- If any test or assertion fails, analyze the terminal stack trace, modify the underlying logic, and re-run until all suites report 100% green.

## 3. ENVIRONMENT VS APPLICATION ISOLATION
- Distinguish between mock environment bottlenecks (e.g. `fake-indexeddb` linear index rebuilding slowness during large deletes) and actual application defects.
- Use truncated CSV data slices in `/tmp` or persistent test scripts to run fast, deterministic checks without distorting application code.