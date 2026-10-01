# AI Core Rules

The canonical shared policy for all coding agents is:

[`docs/engineering/AGENT_RULES.md`](./docs/engineering/AGENT_RULES.md)

Mandatory Codex + Antigravity role contract:

[`docs/engineering/CODEX_ANTIGRAVITY_WORKFLOW.md`](./docs/engineering/CODEX_ANTIGRAVITY_WORKFLOW.md)

The short version remains:

1. **Never guess; prove.**
2. **Fix the earliest broken boundary, not the symptom.**
3. **Protect security, property isolation, financial correctness, and user data.**
4. **Use the repository's real verification commands and report what actually ran.**
5. **Keep explanations simple without making technical claims less precise.**

Provider-specific bootstrapping lives in `AGENTS.md`, `CLAUDE.md`, and `GEMINI.md`.
Those adapters must not fork the shared engineering rules.
