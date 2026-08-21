// Resolves the specifiers that only exist inside the base44 serverless host onto
// something plain Node can load, so a probe can import and RUN the real function
// entry files (base44/functions/*/entry.js) instead of a reimplementation.
//
// Registered by the probe itself (scripts/probe-audit-chain.mjs,
// scripts/probe-audit-list.mjs, ...) rather than from scripts/_loader-boot.mjs,
// because _loader-boot is shared by every verify suite and none of them should
// silently gain the ability to import server code.
//
// Three rules, in order:
//   1. `npm:@base44/sdk@<range>`  -> scripts/stubs/base44-sdk.mjs      (in-memory backend)
//   2. `base44:runtime`           -> scripts/stubs/base44-runtime.mjs
//   3. any other `npm:<pkg>@<range>[/sub]` -> the real package from node_modules
//
// Rule 3 was added 2026-08-20. It used to be absent, and the consequence was a
// probe that could not start:
//     $ node scripts/probe-audit-chain.mjs
//     Error [ERR_UNSUPPORTED_ESM_URL_SCHEME]: ... Received protocol 'npm:'
// because base44/functions/custom_user_admin/entry.js imports `npm:zod`. Zod is
// installed in node_modules and behaves identically there, so an allowlist of
// two specifiers was the only thing standing between the probe and the real
// code. A general rule means the next server-side dependency does not silently
// take a suite offline — and a suite that cannot start is worse than one that
// fails, because it reports nothing at all.

const NPM_PREFIX = "npm:";

/**
 * `npm:zod`                     -> `zod`
 * `npm:zod@^3.25.0`             -> `zod`
 * `npm:@scope/pkg@1.0.0/sub`    -> `@scope/pkg/sub`
 * Returns null when the specifier is not an npm: URL.
 */
export function bareSpecifier(specifier) {
  if (!specifier.startsWith(NPM_PREFIX)) return null;
  const rest = specifier.slice(NPM_PREFIX.length);
  const scoped = rest.startsWith("@");
  // The version range is the '@' that follows the package name. For a scoped
  // package that is the SECOND '@', so the leading one is skipped rather than
  // treated as a delimiter — otherwise `@base44/sdk` resolves to the empty string.
  const searchFrom = scoped ? rest.indexOf("/") : 0;
  if (scoped && searchFrom < 0) return rest;
  const at = rest.indexOf("@", searchFrom < 0 ? 0 : searchFrom);
  if (at < 0) return rest;
  const name = rest.slice(0, at);
  const after = rest.slice(at + 1);
  const slash = after.indexOf("/");
  return slash >= 0 ? name + after.slice(slash) : name;
}

export async function resolve(specifier, context, nextResolve) {
  if (/^npm:@base44\/sdk(@|$)/.test(specifier)) {
    return nextResolve(new URL("./stubs/base44-sdk.mjs", import.meta.url).href, context);
  }
  if (specifier === "base44:runtime") {
    return nextResolve(new URL("./stubs/base44-runtime.mjs", import.meta.url).href, context);
  }
  const bare = bareSpecifier(specifier);
  if (bare) {
    try {
      return await nextResolve(bare, context);
    } catch (err) {
      // Name the package and the file that wanted it. The default failure here
      // is an ERR_MODULE_NOT_FOUND against a mangled specifier, which sends the
      // reader looking for a bug in the loader rather than a missing dependency.
      const from = context?.parentURL ? ` (imported by ${context.parentURL})` : "";
      throw new Error(
        `resolve-base44: '${specifier}' maps to the package '${bare}', which is not installed${from}. ` +
        `Install it or add a stub under scripts/stubs/. Original: ${err?.message || err}`,
      );
    }
  }
  return nextResolve(specifier, context);
}
