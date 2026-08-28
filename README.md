# Red Roof Intelligence

> [!IMPORTANT]
> **Current runtime (August 2026): this project is not connected to Base44.**
> Base44 was the original website builder and its name remains in legacy paths such
> as `base44/`, `src/api/base44Client.js`, and two compatibility dependencies. Do
> not use the Base44 CLI, dashboard, logs, entities, functions, secrets, or deploy
> commands when diagnosing the live app unless the owner explicitly says that a
> Base44 migration has been restarted.
>
> The live site is a standalone React/Vite bundle hosted by the Cloudflare Worker
> `boston-project`. Cloudflare rebuilds it from the GitHub repository's `main`
> branch after a push. The active database is Dexie/IndexedDB inside each user's
> browser; there is no active Base44 cloud database or Base44 serverless backend.

Hotel analytics and operations for a Red Roof property: revenue, occupancy, booking
sources, payroll, expenses and an audit trail. It is a standalone React + Vite
single-page app whose application data is stored locally in Dexie/IndexedDB.

The `base44/entities/` schemas and `base44/functions/` sources are retained legacy
artifacts and test fixtures. They describe the former hosted system; they are not
the production database or executable production backend.

## Start here

AI repair work: read [the owner repair checklist](docs/OWNER_REPAIR_CHECKLIST.md)
before starting. It records verified fixes, unfinished work, and owner decisions.
Re-engage an independent checklist reviewer for each batch; do not call the whole
project finished because one batch passes its tests.

```bash
npm install
cp .env.example .env.local     # then fill it in — see the notes inside the file
npm run dev
```

`.env.example` is the only place the required variable names are written down, and
each one is annotated with the file and line that reads it. Development defaults to
the local browser data path. The committed `.env.production` deliberately enables
both `VITE_USE_LOCAL_AUTH` and `VITE_STANDALONE_LOCAL`; the build guard requires that
pair for the current standalone deployment. Do not add secrets to either env file.

Old Base44 app IDs, backend URLs, function secrets, and connector settings are not
live production configuration. Before investigating a data problem, inspect
`src/api/localDb.js` and the compatibility adapter in `src/api/base44Client.js`, then
reproduce it in the same browser profile where the data lives.

## Production and data flow

1. Code is pushed to the GitHub repository `divyesh01/boston_project`, branch `main`.
2. Cloudflare Workers Builds runs the Vite production build and deploys `dist/` to
   the Worker named `boston-project` (configured by `wrangler.jsonc`).
3. The browser runs the app in standalone-local mode.
4. Records are stored in that browser profile's IndexedDB through Dexie. They do not
   automatically sync to another browser, device, Base44, or a central SQL database.

`vercel.json` and `base44/config.jsonc` remain as compatibility/security-header
specifications used by verification scripts. Their presence does not mean either
Vercel or Base44 hosts the live site.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run build` | Production build |
| `npm run verify:all` | **Every** probe/verify suite — start here after any change |
| `npm run lint` / `npm run lint:fix` | ESLint (`--quiet`); 0 errors expected |
| `npm run typecheck` | `tsc -p ./jsconfig.json` with `checkJs` |
| `npm test` / `npm run test:watch` | Vitest unit tests |
| `npm run brain:map` | Regenerates `docs/brain/BRAIN_DEPENDENCIES.md` — never hand-edit that file |
| `npm run brain:verify` | Documentation gate (git hook), not a behaviour suite |

`npm run verify:all` auto-discovers every `scripts/probe-*.mjs` and
`scripts/verify-*.mjs` and reports six distinct outcomes, because a suite that could
not *start* otherwise looks exactly like a suite that passed. Useful flags:
`--list`, `--filter <substring>`, `--shard i/n`, `--bail`, `--json`. Every run prints
a `list <id> (<n> discovered)` fingerprint; if you split a run into shards, confirm
all shards printed the same id before adding the results up.

Measured baseline, 2026-08-25 (list `2f3a5c5a`): **111 suites, 108 pass, 0 fail, 3
skip.** The three skips need a Windows/CI environment rather than a Linux sandbox: two
want Vite (whose Rollup native binding is missing here) or a dev server, and one wants
a `dist/` newer than its inputs. A skip is *not run*, so 108 is what was verified.
The previous baseline was 72 suites at `53aa539e` on 2026-08-20.

A single suite needs the loader, which resolves the `@/` alias:

```bash
node --import ./scripts/_loader-boot.mjs scripts/probe-<name>.mjs
```

Use `npm run typecheck` rather than calling `npx tsc` directly — `npx tsc` resolves to
the wrong package here.

## Documentation

`BRAIN.md` in the repo root is the hub and contains only routing; the depth lives in
seven spokes under `docs/brain/` covering finance, security, frontend, backend,
troubleshooting, a file index, and an auto-generated dependency map. Read the hub,
then the one spoke you need — the spokes exist so an agent or a new engineer does not
have to scan the whole project. `BRAIN_TROUBLESHOOTING.md` carries the known-problems
tracker and a catalogue of the defect classes this codebase keeps producing.

`CLAUDE.md` is the engineering protocol (inspect, probe, trace, plan, edit, verify,
review, report) and applies to humans as much as to agents.

## Two rules that are not negotiable

**Check `PROTECTED_FILES.md` before editing anything.** The files listed there are
locked: auth, session, permission, validation and security modules, the four auth
pages, and the protocol documents themselves. Locked means no edits, and also no
copies, `v2` variants, wrappers or runtime monkey-patches around them.

**Money is integer cents.** All financial arithmetic goes through
`src/lib/decimal.js`; floating-point `+` and `-` on dollar amounts is forbidden
because it drifts (measured: `2.05 - 2.01` is `0.040000000000000036`). The year-to-date
gross reconciles exactly — `$1,020,598.17` = `$1,011,258.67` room + `$9,339.50`
ancillary — and `scripts/probe-money-kept-gross.mjs` holds that to the cent. Note that
`multiply(a, b)` in `decimal.js` treats `b` as a *rate*, not a count.

## Environment limits worth knowing

`npm test` and `scripts/acceptance-harness.mjs` will not run on Linux if
`node_modules` was installed on Windows — Rollup's native binding is missing
(`Cannot find module @rollup/rollup-linux-x64-gnu`). That is an environment limit, not
a passing result; run them on Windows or in CI and record them as *not run* anywhere
else. `probe-config-exposure.mjs` needs a dev server on `localhost:5173`.
