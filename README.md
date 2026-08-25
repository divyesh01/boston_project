# Red Roof Intelligence

Hotel analytics and operations for a Red Roof property: revenue, occupancy, booking
sources, payroll, expenses and a tamper-evident audit trail. It is a React + Vite
single-page app on a [Base44](https://base44.com) backend, with a Dexie/IndexedDB
cache so the front desk keeps working when the network does not.

At the time of writing the app is 34 pages against 16 database entities and 19
serverless functions.

## Start here

```bash
npm install
cp .env.example .env.local     # then fill it in — see the notes inside the file
npm run dev
```

`.env.example` is the only place the required variable names are written down, and
each one is annotated with the file and line that reads it. Two things in there are
easy to get wrong and expensive: `VITE_USE_LOCAL_AUTH` must never be `true` in a
deployed build (it moves authentication into the browser), and `VITE_BASE44_APP_ID`
currently falls back to a hardcoded production app id, so an unconfigured build does
not fail — it quietly talks to the production tenant. Set it explicitly everywhere.

Server-side secrets (`AUDIT_CHAIN_SECRET`, `OPENWEATHER_API_KEY`, `CRON_SECRET`) are
**not** environment variables. The functions read them from the Base44 secret store
via `secrets.get()`, so putting them in a `.env` file accomplishes nothing except
risking a commit.

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
