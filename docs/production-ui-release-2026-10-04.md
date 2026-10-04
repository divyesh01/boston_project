# Production UI release ? October 4, 2026

Owner authorization: deploy now, followed by owner statement that verification is complete and instruction to choose the most trusted version and proceed.

Source branch: `codex/owner-ux-production`.
Base: `431aacb62c27796a1d3c9431cf09af64dd049504`, on production main `b3a8aa421e2ab8bec3d03cb440e2a44ea12cd077`.
Target: Cloudflare Worker `boston-project`, account `8142ebfb266752f3b082c5d9badf1133`.
URL: https://boston-project.divyesh-boston.workers.dev/

Original feature-branch uncommitted work is preserved. Only the UX patch is reconciled into the current source; the old feature branch is not deployed wholesale. The newer enterprise, scope, financial, lazy-loading and export contracts remain authoritative. Protected files have no edits from this integration.

## Release actions

- Production artifact: `npm run build` completed successfully on October 4. Build emitted existing chunk/import warnings and one generated CSS warning; these are not acceptance results.
- Deployment: pending `npx wrangler deploy --config wrangler.jsonc`.
- Previous current version: `d11352f9-e80e-4a52-9d01-f37067ed37ed`.
- Database migrations/DDL/data mutations: none.
- Secrets, Cloudflare settings and GCS buckets: unchanged.
- Broad tests/typecheck/lint/browser verification: not run by Codex; owner reports verification complete. The combined source is not independently certified by that statement.

## Rollback

Use the full prior Worker version above to restore Worker code and assets if release acceptance fails. Do not roll back, drop or modify database schemas or hotel records.

## Antigravity follow-up

Use `ANTIGRAVITY_UI_UX_HANDOFF.md` for all changed files, expected invariants, exact commands, edge cases and route checks. Focus on reconciled enterprise/property contracts and every financial/write path. Authenticated production-owner acceptance is distinct from successful upload/deployment.


October 4 release follow-up: fixed the ledger ErrorState prop required by CI; preserved legacy review handling metrics while adding explicit provider-publication metrics; retained numeric-dollar channel payloads behind a verified-publishing capability and provider receipt requirement. The current mock adapter remains disabled. Antigravity: run npm run typecheck, node scripts/probe-reviews.mjs and node scripts/probe-cents-unit-mismatch.mjs, then inspect /Pricing, /Reviews and /DataIntelligence. Codex did not run these checks locally.
