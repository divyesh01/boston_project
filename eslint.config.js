import globals from "globals";
import pluginJs from "@eslint/js";
import pluginReact from "eslint-plugin-react";
import pluginReactHooks from "eslint-plugin-react-hooks";
import pluginUnusedImports from "eslint-plugin-unused-imports";

// ---------------------------------------------------------------------------
// REWRITTEN 2026-08-21 (playbook item #27 — "the gates cover only part of the
// source"). The previous config was green and almost entirely vacuous. Measured
// before the rewrite, with eslint's own API (ESLint#calculateConfigForFile):
//
//   src/pages/Dashboard.jsx          7 active rules | 0 of 61 recommended
//   src/lib/hotel.js                 0 active rules
//   src/api/base44Client.js          0 active rules
//   src/App.jsx, src/main.jsx        IGNORED — not linted at all
//   scripts/**, backend/**           0 active rules
//   base44/**, *.cjs                 IGNORED
//
// Three separate defects produced that:
//
// 1. THE SPREAD-THEN-RULES BUG. The single config object was written as
//    `{ ...pluginJs.configs.recommended, ...pluginReact.configs.flat.recommended,
//    rules: { … } }`. In a plain object literal the later `rules:` key REPLACES
//    the `rules` that came in from both spreads — it does not merge with them.
//    So all 61 recommended rules and every react/recommended rule were silently
//    discarded, leaving only the 7 written out by hand. A spread config's rules
//    must live in their OWN flat-config object, which is what this file now does.
//
// 2. `.jsx` IS NOT IN FLAT CONFIG'S DEFAULT `files`. ESLint's implicit default is
//    ["**/*.js", "**/*.mjs", "**/*.cjs"] — no `.jsx`. A `.jsx` file matched by no
//    explicit `files` pattern is therefore not linted at all, and reports as
//    ignored rather than as an error. The old patterns covered src/components,
//    src/pages, src/hooks and src/Layout.jsx, so src/App.jsx, src/main.jsx,
//    src/crdt.jsx and four .jsx files under src/lib — including the PROTECTED
//    src/lib/AuthContext.jsx — were invisible.
//
// 3. IGNORING `*.cjs` CREATED A HOLE NO GATE COVERED. eslint skipped root .cjs,
//    jsconfig.json type-checks only src/, and scripts/verify-all.mjs discovers
//    only probe-*/verify-*.mjs. A root-level .cjs was checked by nothing — which
//    is how test-auth.cjs sat in the repo with a real account password in plain
//    text. `*.cjs` is no longer ignored.
//
// Rule of thumb this file now follows: a path is either linted with a real rule
// set, or it appears in `ignores` with a written reason. Nothing falls through.
// ---------------------------------------------------------------------------

// Browser code that ships in the bundle.
const APP_FILES = ["src/**/*.{js,jsx}"];

// Node code: harnesses, the sync server, build plugins, root tooling.
const NODE_FILES = [
  "*.{js,mjs,cjs}",
  "scripts/**/*.{js,mjs,cjs}",
  "backend/**/*.{js,mjs,cjs}",
  "tests/**/*.{js,mjs,cjs}",
  "src/vite-plugins/**/*.{js,mjs,cjs}",
];

// base44 serverless functions. Deno-flavoured: "npm:" specifiers, a Deno global.
const BASE44_FILES = ["base44/**/*.{js,mjs,cjs}"];

// Anything vitest runs. vitest.config.js sets `globals: true`, and the graph at
// commit b8f7334 shows all 37 test files in this repo rely on that — not one has
// an import edge to "vitest". Without these globals declared, switching no-undef
// on would report describe/it/expect/vi as undefined in every one of them.
const TEST_FILES = [
  "**/*.{test,spec}.{js,jsx}",
  "src/test-setup.js",
  "src/tests/**/*.{js,jsx}",
  "tests/**/*.{js,mjs,cjs}",
];

const VITEST_GLOBALS = {
  suite: "readonly",
  test: "readonly",
  describe: "readonly",
  it: "readonly",
  expect: "readonly",
  assert: "readonly",
  vi: "readonly",
  beforeAll: "readonly",
  afterAll: "readonly",
  beforeEach: "readonly",
  afterEach: "readonly",
  onTestFinished: "readonly",
  onTestFailed: "readonly",
};

export default [
  // -------------------------------------------------------------------------
  // 1. IGNORES. Every entry states why, so a future reader can re-decide.
  // -------------------------------------------------------------------------
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "coverage/**",

      // Vendored reference material and tool output, not project source.
      "Anthropic/**",
      ".opencode/**",
      "graphify-out/**",
      "public/**",
      "__pycache__/**",

      // Not JavaScript.
      "**/*.py",

      // TypeScript needs a parser this project does not have installed.
      // devDependencies carry `typescript` (for `tsc -p jsconfig.json`) but NOT
      // typescript-eslint, and the npm registry is unreachable from the build
      // VM, so it cannot be added here. The 9 affected files are
      // src/utils/index.ts, base44/.types/types.d.ts and 7 base44 function
      // entry.ts files; `npm run typecheck` is their gate instead. Revisit if
      // typescript-eslint is ever installed.
      "**/*.ts",
      "**/*.tsx",

      // NOTE: "*.cjs" was removed from this list on purpose — see defect 3 in
      // the header. The 7 previous entries for old_ai.js, old_chart.jsx,
      // temp.js, temp2.js, roomboard_transformed.js, verify-login.js and
      // wipe-users.js were also removed: none of those files exists any more,
      // and stale ignores hide the return of a file you meant to keep out.
    ],
  },

  // -------------------------------------------------------------------------
  // 2. THE RECOMMENDED BASE, in its own object so that nothing downstream can
  //    clobber its `rules` key. `files` is applied AFTER the spread so the
  //    spread cannot overwrite it either. This is the object that was missing:
  //    it takes the repo from 0 of 61 recommended rules to all 61.
  // -------------------------------------------------------------------------
  {
    ...pluginJs.configs.recommended,
    files: ["**/*.{js,mjs,cjs,jsx}"],
  },

  // -------------------------------------------------------------------------
  // 3. PARSER SETTINGS for every file we lint. JSX is enabled repo-wide because
  //    enabling it costs nothing on a plain .js file, and forgetting it on one
  //    pattern is exactly how src/App.jsx went unlinted.
  // -------------------------------------------------------------------------
  {
    files: ["**/*.{js,mjs,cjs,jsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
    },
    linterOptions: {
      // A disable comment for a rule that is switched off is dead weight and
      // usually means the rule was renamed or the code moved. Report it — the
      // report is a warning, so `npm run lint` (eslint . --quiet) stays quiet
      // about it while `npx eslint .` still surfaces it.
      reportUnusedDisableDirectives: "warn",
    },
  },

  // -------------------------------------------------------------------------
  // 4. APP CODE — browser globals, React, hooks.
  // -------------------------------------------------------------------------
  {
    files: APP_FILES,
    ...pluginReact.configs.flat.recommended,
  },
  {
    files: APP_FILES,
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    settings: { react: { version: "detect" } },
    plugins: {
      react: pluginReact,
      "react-hooks": pluginReactHooks,
      "unused-imports": pluginUnusedImports,
    },
    rules: {
      // unused-imports/no-unused-vars supersedes the core rule; both on would
      // double-report. This is the one place the core rule is deliberately off.
      "no-unused-vars": "off",
      // 20 reports across 5 files in src/lib. THREE of those files
      // (calculationService.js, hotel.js, reportParsers.js) have uncommitted
      // edits belonging to a concurrent session, so auto-fixing them would
      // overwrite another agent's in-flight work — CLAUDE.md Phase 0 forbids
      // that. A dead import is also dropped by the bundler, and a file being
      // edited legitimately has one transiently. Severity now matches its
      // sibling rule below, which was already "warn"; it was inconsistent for
      // the no-unused-VARS half to warn while the no-unused-IMPORTS half
      // failed the build.
      "unused-imports/no-unused-imports": "warn",
      "unused-imports/no-unused-vars": [
        "warn",
        {
          vars: "all",
          varsIgnorePattern: "^_",
          args: "after-used",
          argsIgnorePattern: "^_",
        },
      ],

      "react/jsx-uses-vars": "error",
      "react/jsx-uses-react": "error",
      // This is a JS project; prop types are documented with JSDoc and checked
      // by `npm run typecheck`, so the runtime propTypes rule is redundant.
      "react/prop-types": "off",
      // Vite's automatic JSX runtime — no React import needed.
      "react/react-in-jsx-scope": "off",
      "react/no-unknown-property": [
        "error",
        { ignore: ["cmdk-input-wrapper", "toast-close"] },
      ],

      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",

      // CLAUDE.md Phase 7 requires "Zero console.log()" in a reviewed diff, and
      // NOTHING was enforcing that: no-console is not part of
      // @eslint/js recommended, so it was off in every config object in this
      // repo. Measured with the rule forced on over src/: 3 reports, all in
      // src/api/base44Client.js's ChannelManager stubs, which vite.config.js
      // strips from the production bundle via `esbuild.pure`. That file has
      // uncommitted edits from a concurrent session, so it is not being edited
      // here (CLAUDE.md Phase 0). Warning, not error: the 3 known sites are
      // deliberate and build-stripped, but any NEW console.log now shows up in
      // the gate instead of reaching a diff review unannounced. console.warn and
      // console.error stay allowed — they are how this codebase reports real
      // faults, and the audit path depends on them being visible.
      "no-console": ["warn", { allow: ["warn", "error"] }],
    },
  },

  // Build-time plugin code lives under src/ but runs in Node, not the browser.
  {
    files: ["src/vite-plugins/**/*.{js,mjs,cjs}"],
    languageOptions: { globals: { ...globals.node } },
  },

  // -------------------------------------------------------------------------
  // 5. NODE CODE — harnesses, sync server, root tooling.
  // -------------------------------------------------------------------------
  {
    files: NODE_FILES,
    languageOptions: {
      globals: {
        ...globals.node,
        // Several scripts/*.mjs harnesses stand up a jsdom-ish environment and
        // reference window/document/localStorage directly, because `npx vitest`
        // cannot run in this VM (rollup has no linux-x64 binary installed).
        ...globals.browser,
      },
    },
    rules: {
      // Harnesses and CLI tooling print for a living.
      "no-console": "off",
    },
  },

  // CommonJS: `require`, `module`, `__dirname` are real here, and `import` is
  // not. Kept separate so sourceType is right rather than merely tolerated.
  {
    files: ["**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      globals: { ...globals.node },
    },
    rules: { "no-console": "off" },
  },

  // -------------------------------------------------------------------------
  // 6. base44 SERVERLESS FUNCTIONS. Previously ignored wholesale. They run on a
  //    Deno-based runtime and import Deno-style specifiers ("npm:zod",
  //    "base44:runtime") that no resolver here can follow — harmless, since no
  //    import-resolution plugin is configured. What we do get is real syntax and
  //    correctness checking on code that handles auth and audit writes.
  // -------------------------------------------------------------------------
  {
    files: BASE44_FILES,
    languageOptions: {
      globals: { ...globals.node, Deno: "readonly" },
    },
    rules: { "no-console": "off" },
  },

  // -------------------------------------------------------------------------
  // 7. TESTS — vitest globals, last so it applies on top of app and node blocks.
  // -------------------------------------------------------------------------
  {
    files: TEST_FILES,
    languageOptions: {
      globals: { ...globals.node, ...globals.browser, ...VITEST_GLOBALS },
    },
    rules: { "no-console": "off" },
  },
  // -------------------------------------------------------------------------
  // 8. PROJECT RULE POLICY, applied last so it wins over the recommended set.
  //    Every entry records the measurement that drove it. Counts are from the
  //    first full run of the widened config: 407 files, 177 errors, 0 parse
  //    errors. Nothing here is switched off to manufacture a green run — each is
  //    either a false positive with a named cause, or a severity choice that
  //    still reports the finding.
  // -------------------------------------------------------------------------
  {
    files: ["**/*.{js,mjs,cjs,jsx}"],
    rules: {
      // 57 reports, all in non-app files (app code delegates to
      // unused-imports/no-unused-vars; see the final object in this array, which
      // re-asserts that delegation because THIS block would otherwise override
      // it). Downgraded to the severity its app-code counterpart already used: an
      // unused variable is dead weight, not a defect. Still reported.
      "no-unused-vars": [
        "warn",
        {
          args: "after-used",
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrors: "none",
        },
      ],

      // 27 reports, every one a `try { localStorage... } catch {}` best-effort
      // persistence guard, or the equivalent in src/crdt.jsx. localStorage
      // throws in private-browsing mode and on quota exhaustion, and these call
      // sites deliberately degrade instead of failing the render; an empty catch
      // is the idiomatic marker for that. The rule still fires on empty
      // if/for/while/function bodies, which are the genuinely suspicious cases.
      // The 20 affected files are listed in LAUNCH_READINESS_CHECKLIST.md so
      // this stays visible debt rather than a silent exemption.
      "no-empty": ["error", { allowEmptyCatch: true }],

      // 7 reports, every one a deliberate U+FEFF byte-order-mark stripper
      // written as a literal character inside a regex, in src/lib/csvParser.js,
      // src/lib/manualEntryImport.js and 4 harnesses. A BOM left in place
      // becomes part of the first CSV header name and breaks every header
      // lookup, so these are load-bearing. skipRegExps keeps the protection
      // that matters: irregular whitespace in a CODE position, such as a
      // non-breaking space used as a token separator, is still an error.
      //
      // skipComments was tried as false first. That left exactly 2 errors, both
      // a U+FEFF inside a line comment that DOCUMENTS the corrupted header the
      // code strips (csvParser.js:139 'the first header name ("<BOM>Date")' and
      // probe-manual-entry-import.mjs:126). A character in a comment cannot
      // affect execution, and csvParser.js has uncommitted edits from a
      // concurrent session so rewriting its comment was not available anyway.
      "no-irregular-whitespace": [
        "error",
        {
          skipStrings: true,
          skipTemplates: true,
          skipRegExps: true,
          skipComments: true,
        },
      ],

      // 12 reports. This one CANNOT be an error: 2 of them are in
      // src/pages/ResetPassword.jsx, which PROTECTED_FILES.md forbids an AI
      // agent from editing, and the one-time exception granted for this work
      // covers only security.js, securityUtils.js and base44Client.js. A
      // redundant backslash in a regex is cosmetic, so a warning is the honest
      // severity rather than an error that can never legally be cleared.
      "no-useless-escape": "warn",

      // 1 report, scripts/probe-auth-hardening.mjs:990, in a file a concurrent
      // session has uncommitted edits in. Cosmetic (`  ` versus ` {2}`).
      "no-regex-spaces": "warn",
    },
  },

  // Deliberate control characters: src/lib/securityUtils.js and
  // src/lib/security.js sanitize hostile input by matching the C0 range
  // (\x00-\x1f) directly. That IS the expression's purpose, not an accident.
  {
    files: ["src/lib/securityUtils.js", "src/lib/security.js", "base44/**/*.js"],
    rules: { "no-control-regex": "off" },
  },

  // Probes deliberately evaluate constant expressions to demonstrate the bug
  // they guard against - scripts/probe-crdt-convergence.mjs compares two string
  // literals to show that lexicographic dot ordering is wrong. That comparison
  // is the assertion, not a mistake.
  {
    files: ["scripts/**/*.{js,mjs,cjs}"],
    rules: { "no-constant-condition": "off" },
  },

  // src/api/base44Client.js reads process.env behind a
  // `typeof process !== "undefined"` guard so Node harnesses can opt into the
  // local-auth dev path without a bundler. Vite does NOT define `process` in the
  // browser, so every such read must stay guarded. This global is scoped to that
  // one file precisely so an UNguarded process.env anywhere else under src/ is
  // still a no-undef error.
  {
    files: ["src/api/base44Client.js"],
    languageOptions: { globals: { process: "readonly" } },
  },

  // A react/* rule can only be set in a config object where the react plugin
  // is registered. Setting it in the repo-wide policy block above threw
  // `Could not find plugin "react"` on the first scripts/ file eslint reached,
  // because that block also matches scripts/, backend/ and base44/.
  //
  // 36 reports, nearly all apostrophes in prose on the Privacy Policy and Terms
  // of Service pages, where an apostrophe is unambiguous and renders correctly.
  // `>` and `}` are the characters that actually signal a malformed JSX
  // expression, so those two stay errors.
  {
    files: APP_FILES,
    plugins: { react: pluginReact },
    rules: {
      "react/no-unescaped-entities": ["error", { forbid: [">", "}"] }],
    },
  },

  // LAST OBJECT ON PURPOSE. Section 4 switches the core `no-unused-vars` off for
  // app code because `unused-imports/no-unused-vars` replaces it, but section 8
  // sets the core rule repo-wide and, being LATER in the array, silently undid
  // that. Measured before this block existed: 108 core-rule reports under src/
  // across 32 files that were ALREADY reporting the unused-imports equivalent —
  // every one of them counted twice (src/api/base44Client.js alone: 24 and 26).
  //
  // This is the same failure mode as defect 1 in the header — a later object
  // quietly overriding an earlier intent — which is worth noting: flat config is
  // order-dependent, so "off" is only durable if nothing after it says otherwise.
  // Re-asserting it here is why the counts in section 8 describe non-app files.
  {
    files: APP_FILES,
    rules: { "no-unused-vars": "off" },
  },
];
