# CLAUDE HIGH-TRUST REVIEW LAYER PROTOCOL

## Directive Overview

Claude acts as a high-trust independent inspector throughout the engineering lifecycle to ensure high-risk engineering decisions receive an additional independent reasoning pass.

Claude operates across 6 mandatory checkpoints with broad read/review permissions and a single controlled implementation path.

---

## 1. The 6 Mandatory Claude Checkpoints

```
[TASK START]
     │
     ▼
[CHECKPOINT 1: PRE-IMPLEMENTATION INSPECTOR]
  • Independent architectural & root-cause review
  • Explicit question: "WHAT COULD GEMINI OR THE CURRENT PLAN HAVE MISSED?"
     │
     ▼
[CHECKPOINT 2: INDEPENDENT PEER ENGINEER]
  • Independent Solution B from identical baseline
  • Component-by-component evidence fusion
     │
     ▼
[CONTROLLED IMPLEMENTATION (Single Upstream Fix)]
     │
     ▼
[CHECKPOINT 3: POST-IMPLEMENTATION INSPECTOR]
  • Git diff review & adversarial inspection
  • Actively attempt to prove implementation unsafe or incorrect
     │
     ▼
[CHECKPOINT 4: HOTEL DATA & FINANCIAL REVIEW]
  • Integer-cents, ADR, RevPAR, Occupancy, OTA commissions, RLS check
  • Searches for wrong denominators, double counting, date leaks, silent row loss
     │
     ▼
[CHECKPOINT 5: FINAL TRIBUNAL]
  • Final sign-off: Returns exactly one of [PASS | FAIL | UNPROVEN]
  • UNPROVEN blocks critical releases
     │
     ▼
[DETERMINISTIC RELEASE GATES & DEPLOY]
     │
     ▼
[CHECKPOINT 6: DEPLOYMENT / LIVE INSPECTOR]
  • Live production verification (KPIs, console, network, property switching)
  • Unexpected live discrepancy -> FAIL -> REOPEN -> ROLLBACK
```

---

## 2. Detailed Checkpoint Specifications

### Checkpoint 1 — Pre-Implementation Inspector
- **When**: Before code modification begins.
- **Scope**: Root cause, architecture, blast radius, hidden dependencies, data flow, security, financial, property isolation, date/filter, and edge-case risks.
- **Mandatory Output**: Explicitly answers: **"WHAT COULD GEMINI OR THE CURRENT PLAN HAVE MISSED?"**

### Checkpoint 2 — Independent Peer Engineer
- **When**: Architecture planning phase.
- **Scope**: Independent solution generation from the identical baseline without prior anchoring.
- **Mandatory Output**: Solution B specification with component-level strengths. Evidence decides adoption.

### Checkpoint 3 — Post-Implementation Inspector
- **When**: Immediately following code edits.
- **Scope**: Git diff, unexpected modifications, removed validations, weakened assertions, error-handling gaps, and concurrency risks.
- **Mindset**: Actively attempts to find reasons the change should **NOT** ship.

### Checkpoint 4 — Hotel Data & Financial Review
- **When**: Any task touching financial, reporting, import, or metric pipelines.
- **Scope**: Independent audit of Revenue, ADR, RevPAR, Occupancy, Rooms Sold/Available, Refunds, Payments, Commissions, Expenses, Taxes, and Net Profit.
- **Verification**: Zero-tolerance for wrong denominators, floating-point drift, or cross-property leakage.

### Checkpoint 5 — Final Tribunal
- **When**: Prior to deployment gate execution.
- **Input**: Complete evidence package (baseline, diff, probes, regression tests, Golden Dataset, Financial Truth, Security, Guardian report, Owner Agent score).
- **Output**: Exactly one verdict: `PASS`, `FAIL`, or `UNPROVEN`. `UNPROVEN` blocks release.

### Checkpoint 6 — Deployment / Live Inspector
- **When**: Post-deployment on live environment.
- **Scope**: Actual deployed dashboard load, console logs, network requests, property switching, date switching, and real KPI calculations.
- **Action on Failure**: Immediate `FAIL` $\rightarrow$ task reopened $\rightarrow$ rollback initiated if required.

---

## 3. Permission & Concurrency Rule

- **Review Authority**: Claude may read, trace, and review the entire codebase and test results broadly.
- **Controlled Implementation**: Claude does **NOT** independently write competing production code from every checkpoint.
- **Architecture**: **Many Claude Reviews + One Controlled Implementation Path**.

---

## 4. Availability & Honest Verification Rule

1. **No Simulated Attribution**: Never fabricate Claude participation. Do not generate an answer with another model and label it as Claude.
2. **Mandatory Checkpoint Record**:
   ```text
   CLAUDE CHECKPOINT: [1 - 6]
   CLAUDE MODEL: [Model ID / API Endpoint]
   INVOCATION METHOD: [Direct API / CLI / External Process]
   TASK SENT: [Exact prompt/context sent]
   OUTPUT RECEIVED: [Exact returned content]
   STATUS: [PASS / FAIL / UNPROVEN / UNAVAILABLE]
   EVIDENCE: [Audit log URI / process output]
   ```
3. **Handling Unavailability**:
   - If Claude cannot be reached or is unconfigured: `CLAUDE_STATUS = UNAVAILABLE`.
   - For critical workflows requiring Claude review, an unavailable checkpoint remains **`UNPROVEN`** and blocks progression unless explicit repository fallback policy is authorized.
