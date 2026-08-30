# Quality-First Compute Policy

Use this conditional pack for complex or high-risk Gemini and Antigravity work.

Do not conserve quota, agent count, tokens, runtime, or provider calls at the expense
of correctness, evidence, or coverage. Select as many genuinely useful independent
specialists as needed. Every specialist receives a distinct, bounded mission. Run
them concurrently where supported, cross-examine material disagreement, red-team the
leading conclusion, and synthesize only after adequate coverage. Do not stop merely
because one agent produced a plausible answer.

Do not create useless agents to consume quota. LIGHT remains correct for simple work.
Material-risk finance, authentication, security, property isolation, imports,
migrations, destructive workflows, and production incidents default to DEEP unless
the Commander records evidence that a smaller mode covers the actual risk.

Record in durable task state:

```text
COMPUTE_MODE: LIGHT | STANDARD | DEEP
AGENTS_USED: <non-negative integer>
WHY_THIS_DEPTH_WAS_SUFFICIENT: <evidence-based explanation>
```

Depth is sufficient only when the task’s meaningful workflows, trust boundaries,
failure modes, contradictions, and required independent reviews are dispositioned.
Token or quota preservation alone is never sufficient justification.
