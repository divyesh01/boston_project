# Independent Solution and Arbitration Protocol

## 1. Establish the task contract

Record the user's intended outcome, observable acceptance criteria, non-goals, repository rules, protected files, current uncommitted work, and the checks that can decide correctness. Identify actions that would require additional authorization.

Classify whether the task is substantial. If it is not, state that the external workflow was skipped as unnecessary and proceed normally.

## 2. Produce the sealed Codex proposal (C1)

Before contacting Gemini, inspect the repository and independently produce a concise proposal containing:

- likely root cause or design model;
- proposed changes and affected files;
- important invariants and risks;
- expected tests and evidence;
- open uncertainties.

Keep C1 unchanged until Gemini's independent proposal has been captured. Do not implement yet unless a time-critical incident requires an explicitly justified exception.

## 3. Build a safe Gemini context

Create a disposable directory outside the live worktree. Put only the minimum context Gemini needs into the prompt or curated copies in that directory. Gemini must not receive C1 at this stage.

Exclude secret or private material, including:

- `.env*`, credentials, tokens, cookies, session data, private keys, certificates, and password stores;
- `.git`, credential helpers, shell profiles, cloud configuration, and package-manager auth files;
- production/customer data, personal data, logs containing identifiers or tokens, database dumps, and unrestricted telemetry;
- unrelated files, dependencies, build output, caches, and binary artifacts.

Inspect selected context for likely secrets before sending it. Redact values rather than merely renaming fields. If relevant context cannot be shared safely, do not call Gemini; report the external review as unavailable and use the failure policy below.

The first Gemini prompt (G1) must include only the task, acceptance criteria, applicable repository constraints, necessary sanitized evidence, and a request for an independent read-only solution. Explicitly instruct Gemini not to modify files, execute destructive actions, or assume facts absent from the context.

Keep prompts focused. The wrapper's default 60,000-character ceiling is a safety guard, not a claim about Antigravity's actual model limit. If the prompt exceeds it, reduce context by relevance, summarize low-level repetition while preserving exact contracts and errors, or split discovery into clearly labeled evidence requests. Never truncate code or contracts silently.

## 4. Capture Gemini's independent proposal (G1)

Invoke `scripts/invoke-agy.ps1` with the curated prompt and disposable working directory. A valid G1 requires all of:

- wrapper status `success`;
- process exit code `0`;
- non-empty response;
- no timeout or size-limit failure.

Preserve the returned response for the active task only. Do not commit prompts or model output unless the user explicitly requests a durable record.

## 5. Exchange critiques

Codex critiques G1 against repository evidence without changing C1. Label unsupported assumptions, missing workflows, regressions, and useful improvements.

Then make a second Gemini call (G2) from the disposable directory. Provide the sanitized task context, C1, and G1, and ask Gemini to critique C1 specifically, identify disagreements, and name evidence or tests that would resolve each disagreement. Do not ask Gemini to choose by preference.

One further Gemini round is allowed only when new evidence creates a material unresolved question. Do not loop debate. Repository-specific governance may impose a stricter bound.

## 6. Arbitrate with evidence

Create a short disagreement ledger. For each material claim, record:

- Codex position;
- Gemini position;
- deciding repository evidence, authoritative documentation, reproduction, static analysis, or test;
- result: supported, rejected, or unresolved.

Run the smallest meaningful tests that can fail for the disputed behavior, followed by relevant neighboring regression checks. Model agreement without evidence is not a passing gate. When evidence supports parts of both proposals, a synthesized solution may win.

If a test cannot be run, label the claim unproven and explain why. High-risk unresolved claims block implementation when repository policy or user safety requires independent evidence.

## 7. Implement and verify

Codex selects and implements the evidence-backed winner as the sole writer. Keep the diff focused and preserve unrelated user changes. Re-run the deciding tests and relevant regression checks after implementation.

In the final report, distinguish:

- what Codex proposed;
- what Gemini proposed and critiqued;
- which disagreements evidence resolved;
- what was implemented;
- tests run and their outcomes;
- any unresolved or unverified items.

Do not call the result a mutual review if either required Gemini call failed.

## Failure policy

On missing executable, authentication failure, nonzero exit, timeout, empty output, context rejection, or unsafe context:

1. State the exact observed failure without fabricating a Gemini opinion.
2. Do not treat the failure as approval or consensus.
3. Retry once only when the cause is transient or a safe configuration correction is available. Reuse the same sanitized context; do not broaden access to make the retry succeed.
4. Proceed with a clearly labeled Codex-only workflow only when the task can be completed responsibly with repository evidence and tests.
5. Stop and request direction when independent review is an explicit acceptance requirement or unresolved risk makes solo implementation unsafe.

Always remove disposable prompts and review directories after the task unless retention is explicitly requested. Remove only directories created for the current review, after verifying their resolved paths.
