import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

// `import.meta.dirname`, not `__dirname`.
//
// The audit filed this as a live crash — "__dirname is undefined in ESM, and
// package.json declares type: module, so loading this config throws". That is
// not what happens today. Vite bundles the config file before evaluating it
// (`loadConfigFromFile(..., configLoader = "bundle")` is the default) and that
// bundler both defines `__dirname` and injects the constant behind it:
// `define: { __dirname: "__vite_injected_original_dirname" }` plus an
// `inject-file-scope-variables` esbuild plugin that prepends
// `const __vite_injected_original_dirname = "<dir>"` to every module it loads.
// Measured in vite@6.4.3. So `__dirname` here resolved correctly.
//
// It is changed anyway, because it was only correct by virtue of a default.
// Vite accepts `configLoader: 'runner'` and `'native'`, and under either the
// config is evaluated as real ESM where `__dirname` genuinely is not defined —
// so the old line would have started throwing the day anyone set that option,
// for a reason nobody would connect to this file. `import.meta.dirname` is
// correct under all three: Node 20.11+ provides it natively, and Vite's define
// map covers it in bundle mode.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Deno specifiers, mapped so the backend suites can load at all.
      //
      // base44/functions/** is deployed to base44's Deno runtime, which resolves
      // `npm:<pkg>@<range>` and `base44:runtime` itself. Node and vitest do not, so
      // tests/backend/* died at import with "Cannot bundle built-in module" before
      // reaching an assertion. `vi.mock()` cannot rescue that: the specifier has to
      // resolve before the mock is applied.
      //
      // One SDK spelling, because the functions now agree. All 18 entry files —
      // 7 `.ts` and 11 `.js` — pin `npm:@base44/sdk@^0.8.41`, matching
      // package.json. Unified 2026-08-22; the `@0.8.40` key that used to sit here
      // was deleted in the same change, per the instruction it carried, so any
      // function that regresses to the old pin now fails to resolve loudly
      // instead of being silently aliased to a version nothing declares.
      //
      // Do NOT "fix" the specifiers in base44/functions/** to make this
      // unnecessary — Deno needs them as written. And note what
      // custom_auth_login/entry.js:204 / custom_user_admin/entry.js:311 actually
      // say: it is the CANONICAL AUDIT FIELD LIST that must be byte-identical
      // across copies, not the import lines. An earlier version of this comment
      // claimed the import lines were frozen, which is why the version split
      // survived this long.
      "npm:@base44/sdk@^0.8.41": "@base44/sdk",
      "npm:zod": "zod",
      "base44:runtime": path.resolve(import.meta.dirname, "./tests/stubs/base44-runtime.js"),

      // Keep last. @rollup/plugin-alias matches a string `find` when the importee
      // equals it or starts with it + "/", so "@" catches "@/lib/hotel" and does
      // NOT catch "@base44/sdk" — but a shorter key added above this line could.
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test-setup.js"],
    // Tests exercise the local/offline auth shim, so opt into local auth mode.
    env: { VITE_USE_LOCAL_AUTH: "true" },
    css: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/components/**/*.{js,jsx}"],
    },
  },
});
