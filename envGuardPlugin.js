// Build-time guard: a production bundle must declare the STANDALONE shape.
//
// ── WHAT WENT WRONG, measured 2026-08-23 ───────────────────────────────────
// Cloudflare's Git build (Workers Builds) runs `npm run build` on its own
// machine with "Build variables: None". `.env.production` is gitignored, so
// that build sees NEITHER VITE_USE_LOCAL_AUTH nor VITE_STANDALONE_LOCAL.
//
// The build then exits 0 and deploys a bundle that CANNOT AUTHENTICATE ANYONE:
// with VITE_USE_LOCAL_AUTH unset, base44Client.js:2033 resolves USE_LOCAL_AUTH
// to false, so login is routed to the base44 backend — and base44 is no longer
// used, so nothing answers. The page loads, the login form paints, and every
// sign-in attempt fails. Exactly the shape of failure this repo keeps getting
// bitten by: a green build that ships a dead app.
//
// main.jsx's runtime guard cannot catch this. It refuses to boot when local
// auth is on WITHOUT the standalone flag; it says nothing when BOTH are absent,
// because that combination is a legitimate server-backed build — for a server
// this deployment does not have.
//
// ── THE RULE ───────────────────────────────────────────────────────────────
// With base44 gone there is exactly one production shape that works: local auth
// plus an explicit standalone declaration, served behind an identity proxy
// (Cloudflare Access). So a production build that does not declare it is a
// mistake, not a variant, and it fails here — at configResolved, in seconds,
// before a single asset is written.
//
// `config.env` is the resolved import.meta.env object vite will inline into the
// bundle: .env files plus any VITE_-prefixed process.env from the host. Reading
// it means this checks the values that actually ship, not a file that may or
// may not have been loaded.
//
// If this deployment ever gains a real auth backend, this guard must be edited
// deliberately, together with scripts/probe-standalone-deploy.mjs. There is no
// opt-out flag on purpose: an escape hatch is how the original defect ships.
//
// Gated by scripts/probe-standalone-deploy.mjs.

const REQUIRED = ['VITE_USE_LOCAL_AUTH', 'VITE_STANDALONE_LOCAL'];

export default function standaloneEnvGuard() {
  return {
    name: 'standalone-env-guard',
    apply: 'build',

    configResolved(config) {
      if (config.mode !== 'production') return;

      const env = config.env || {};
      const missing = REQUIRED.filter((key) => env[key] !== 'true');
      if (missing.length === 0) return;

      throw new Error(
        [
          '[standalone-env-guard] refusing to build a production bundle that cannot log anybody in.',
          '',
          `  not set to "true": ${missing.join(', ')}`,
          '',
          '  With base44 retired, the only working production shape is the standalone one:',
          '  in-browser auth behind an identity proxy. Both flags must be "true".',
          '',
          '  Local build:        set them in .env.production (gitignored, so it never',
          '                      reaches a CI or hosting checkout).',
          '  Cloudflare build:   Workers -> Settings -> Build -> Variables and Secrets.',
          '  GitHub Actions:     the env: block of the "Verify Production Build" step.',
        ].join('\n'),
      );
    },
  };
}
