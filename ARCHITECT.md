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

## 4. API-FIRST MULTI-AGENT ORCHESTRATION ARCHITECTURE
- **Primary Author Authority**: Claude Opus API (`claude-opus-5`, `claude-opus-4-8`) acts as the authoritative investigator and code patch author.
- **Active-Active Dual-Channel Routing**: Concurrent dispatch across **Tabitoken** (`https://tabitoken.com/v1`) and **GoRouter** (`https://gorouter.app/v1`).
- **Wave Execution Pipeline**:
  - **Wave A**: 4 parallel Claude Opus workers with strictly enforced 2 Tabitoken + 2 GoRouter balance.
  - **Wave B**: Parallel specialist reviewer swarm (Nara free tier, xKiro, NVIDIA NIM, Gemini API).
  - **Wave C**: Authoritative Claude Opus synthesis and definitive code patch generation.
- **Deterministic Mechanical Application**: CRLF/LF-normalized search/replace with SHA-256 integrity checks; zero manual repair needed.
- **Automated QA Feedback**: Terminal test failure outputs are fed directly into Claude Opus correction workers.
- **Executive Dashboard 3-Box Standard**: Mandatory output order for all runs:
  1. Multi-Agent Comparison Table
  2. Main Contribution Table
  3. Run Summary Box (followed downstream by telemetry receipts).
- **Subscription Conservation**: 0% Codex subscription usage (idle emergency reserve); Antigravity used as launcher/dashboard only (0% substantive reasoning/authoring offloaded to Claude Opus API).