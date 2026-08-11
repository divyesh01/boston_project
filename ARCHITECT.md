# ARCHITECT DIRECTIVES — BLAST RADIUS & CROSS-FILE IMPACT

## 1. DEPENDENCY TRACING PROTOCOL
- Before editing any shared function or file, search the entire codebase for all import and usage statements.
- Never delete or rename exported functions, constants, or types without checking external callers.

## 2. SAME-TURN SYNCHRONIZATION
- When modifying shared data normalization modules (`src/lib/paymentNorm.js`, `src/lib/transactionNorm.js`, `src/lib/hotel.js`, `src/lib/reportParsers.js`), identify every dependent component or page.
- Update all 2–5 dependent call sites across `src/pages/` and `src/components/` in the exact same execution turn to prevent cascade failures or desynced state.

## 3. DB & API SCHEMA CONSISTENCY
- Ensure IndexedDB table declarations in `src/lib/localDb.js` maintain strict schema parity with API entity proxies in `src/api/base44Client.js`.
- Any new column or indexed property added to IndexedDB must be populated during import and handled safely across queries.