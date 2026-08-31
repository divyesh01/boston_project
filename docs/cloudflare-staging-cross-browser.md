# Cloudflare staging cross-browser architecture

This branch deploys only to `boston-project-staging.divyesh-boston.workers.dev`.
The production Worker named `boston-project` remains assets-only until a separate
production review and authorization.

## Request path

`Browser -> Cloudflare Access -> Worker JWT verification -> D1 authoritative snapshot -> IndexedDB cache`

- Cloudflare Access application: `Boston Project D1 Staging`
- Access audience: `67befe0c14f5acc168e10af9e93ad7a58880875d5251f3d87497a86c2f019128`
- D1 database: `boston-project-staging-data`
- D1 database ID: `5d5ff049-c273-4557-9938-e89c5d32112c`
- Worker configuration: `wrangler.staging.jsonc` (intentionally separate from production `wrangler.jsonc`)

The Worker verifies the `Cf-Access-Jwt-Assertion` signature, issuer, audience,
expiry, stable subject, and email. It derives account, role, and property scope
from D1; the browser cannot select them.

## Data safety

- Existing IndexedDB data is never uploaded automatically.
- The first server snapshot requires an explicit owner action in the hydration gate.
- Server data is never silently overwritten: every write uses an exact base version.
- Snapshot chunks, revision metadata, and the visible version pointer commit in one
  D1 batch. A stale write rolls back instead of publishing partial financial data.
- Snapshot reads verify chunk count, byte length, SHA-256, table allowlists, setting
  allowlists, and property references before browser hydration.
- A browser cache belonging to a different account or carrying uncommitted changes
  is preserved and shown as a conflict.
- Restricted principals receive property-filtered reads and cannot replace the
  account-wide snapshot. The first staging principal is the exact Access-verified
  owner email configured in the Worker.

No legacy password hashes, local sessions, or MFA secrets are copied to D1.
No snapshot cleanup or legacy-data deletion is automated in this stage.

## Commands

```bash
npm run cf:test
npm run cf:build:staging
npm run cf:deploy:staging
```

Apply D1 migrations explicitly and only to the staging database:

```bash
npx wrangler d1 migrations apply boston-project-staging-data --remote --config wrangler.staging.jsonc
```

## Promotion gate

Do not promote this architecture to production until authenticated fresh-browser,
existing-browser bootstrap, refresh, logout/login, cross-browser consistency,
property-isolation, and financial-total comparisons pass against staging evidence.
