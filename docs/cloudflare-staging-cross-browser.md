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

## Free-plan guardrails

- `workers.dev` remains the hostname because this account has no active DNS zone;
  a custom domain would require onboarding or buying one.
- The production Worker now accepts Git builds from `main` only. Its redundant
  non-production trigger was removed on 2026-08-31, and `wrangler.jsonc` pins
  `preview_urls: false`. Before this guardrail, every branch push spent build quota
  and exposed an unauthenticated preview alias inside the production Worker. The
  observed staging alias changed from HTTP 200 to HTTP 404; production remained on
  version `36993034-a938-4fb9-8b19-e7ac87820b34` throughout. Re-enable non-production
  builds only if previews are deliberately protected and no longer duplicate the
  separate staging Worker.
- Preview URLs are disabled so every live staging hostname is covered by the
  explicit Access application.
- Workers Free itself enforces the fixed 10 ms CPU ceiling, 50 external subrequests,
  and 1,000 Cloudflare-service subrequests per invocation. Free-plan quota exhaustion
  fails closed, and the project does not opt into paid overages. Cloudflare rejected
  the configurable `limits` block with error `100328`, which independently proves
  this account is on Workers Free and means the platform ceilings—not a local override—
  are authoritative.
- Invocation/error logs stay enabled at 100% with query strings redacted. Traces are
  disabled so they do not consume the observability event allowance when trace
  metering changes in October 2026. Query-string redaction is an API-managed script
  setting because Wrangler 4.127 does not expose that field in its config schema;
  verify and re-apply it after every staging deploy.
- Fingerprinted `/assets/*` files already use a one-year immutable browser cache in
  `public/_headers`; HTML keeps Cloudflare's revalidation behavior so deployments do
  not strand an old application shell.
- D1 read replication stays disabled. Account snapshots are financial authority, so
  strong, current reads are more important than eventually consistent replicas.

Cloudflare controls its plans and may change allowances; no configuration can promise
that a third-party free tier will exist forever. Re-check the official Workers, D1,
Access, and observability limits before production promotion.

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
