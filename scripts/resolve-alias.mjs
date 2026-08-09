// Resolves the app's "@/" import alias to the real src path so verify scripts
// can load production modules directly, appending ".js" when the source imports
// omit the extension. Registered from the test script via node:module
// register(); see verify-actioncenter.mjs.
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    let target = new URL("../src/" + specifier.slice(2), import.meta.url).href;
    if (!/\.[a-z]+$/i.test(target)) target = `${target}.js`;
    return nextResolve(target, context);
  }
  // Extensionless RELATIVE specifiers get the same treatment.
  //
  // Vite resolves both forms; bare Node only resolved the aliased one, so a
  // production module written as `import localDb from './localDb'` — which
  // src/api/base44Client.js is — threw ERR_MODULE_NOT_FOUND and took four
  // verify suites down with it. The failure looked like a broken import but was
  // purely a gap in this hook.
  if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) {
    try {
      return await nextResolve(`${specifier}.js`, context);
    } catch {
      // Fall through: let Node report the original specifier, not the guess.
    }
  }
  return nextResolve(specifier, context);
}