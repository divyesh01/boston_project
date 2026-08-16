// Resolves the two specifiers that only exist inside the base44 serverless host
// (`npm:@base44/sdk@<range>` and `base44:runtime`) onto local test stubs, so a
// probe can import and RUN the real function entry files in plain Node.
//
// Registered by the probe itself (scripts/probe-audit-chain.mjs) rather than
// from scripts/_loader-boot.mjs, because _loader-boot is shared by every verify
// suite and none of them should silently gain the ability to import server code.
export async function resolve(specifier, context, nextResolve) {
  if (/^npm:@base44\/sdk(@|$)/.test(specifier)) {
    return nextResolve(new URL("./stubs/base44-sdk.mjs", import.meta.url).href, context);
  }
  if (specifier === "base44:runtime") {
    return nextResolve(new URL("./stubs/base44-runtime.mjs", import.meta.url).href, context);
  }
  return nextResolve(specifier, context);
}
