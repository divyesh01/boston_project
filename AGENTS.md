# AGENTS.md

## 🔒 Protected Files

**CRITICAL: Before modifying ANY file, check [`PROTECTED_FILES.md`](./PROTECTED_FILES.md).** Files listed there are permanently locked from AI modification. No AI agent (Gemini, Antigravity, Claude, OpenCode, Cursor, Copilot, or any other) may create, modify, delete, rename, or overwrite protected files without explicit owner authorization. See `.agents/rules/no-modify-protected.md` for enforcement details.

<!-- DIVYESH-V3-BOOTSTRAP:START -->
## DIVYESH V3 AUTO-BOOTSTRAP

SYSTEM: DIVYESH-V3
VERSION: 3.0.0
BOOTSTRAP_SCHEMA: 1.0.0
CANONICAL_MANIFEST: docs/divyesh-v3/manifest.json

Before substantive work on every repository task:

1. Run `npm run verify:v3`. If manifest, protocol hash, or bootstrap verification
   fails, stop with `SYSTEM_DRIFT = BLOCKED`.
2. Read `docs/divyesh-v3/KERNEL.md`, `docs/divyesh-v3/ROUTER.md`, and
   `docs/divyesh-v3/QUALITY_FIRST_COMPUTE.md`.
3. Load only the relevant role, domain, and workflow packs selected by the router.
4. Preserve V3-151 modular loading; never inject the full constitution by default.
5. Preserve V3-152 quality-first compute; never conserve compute at the expense of
   evidence, coverage, or correctness.

The owner must not need to remind Codex to use DIVYESH V3 on future repository tasks.
Platform capabilities may differ; project governance may not.
<!-- DIVYESH-V3-BOOTSTRAP:END -->

## Project Context

This is a Base44 app repository. Treat it as user-owned application code, keep changes focused on the user's request, and preserve existing project conventions.

Start with `README.md` for local setup, environment variables, and publish workflow.

## Base44 References

- CLI overview: https://docs.db.com/developers/references/cli/get-started/overview.md
- Agent skills: https://docs.db.com/developers/backend/overview/skills.md

If your agent supports Agent Skills, install or update Base44 skills before Base44-specific work:

```bash
npx skills add base44/skills
```

## Key Files

- `src/`: frontend application source.
- `src/api/base44Client.js`: frontend Base44 SDK client.
- `vite.config.js`: Vite config and Base44 Vite plugin setup.
- `.env.local`: local-only environment values; never commit secrets.

## Working Notes

- Use `base44 dev` as the default local development command when you need the local Base44 backend. It can run the backend and frontend together.
- When docs or code mention the frontend being started automatically, that usually means the Base44 project config includes `site.serveCommand`, for example `"serveCommand": "npm run dev"` in `base44/config.jsonc`.
- Use `npm run dev` only for frontend-only work against the hosted Base44 backend.
- Prefer the existing Base44 CLI workflow over adding new npm scripts for Base44-specific tasks.
- Reuse the existing SDK client and Vite plugin patterns before adding new Base44 integration paths.
- Run the relevant checks from `package.json` before finishing code changes.

## AI Core Philosophy
See [AI_CORE_RULES.md](./AI_CORE_RULES.md) for the absolute rules all agents must follow: Never guess, only prove. Always fix from the core. Keep it simple enough for a 10-year-old.

