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
