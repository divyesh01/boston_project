// Static import/export verification for the src/ module graph.
//
// `vite build` cannot run in this environment (node_modules was installed on
// Windows, so the Linux rollup binary is absent and the registry is blocked),
// which removes the usual compile-time safety net. This recovers most of it
// with a pure-JS pass: parse every file with @babel/parser, resolve every
// relative and "@/" import to a real file, and check that each named import
// actually exists as an export of its target.
//
// It catches the two failure modes that matter here: a module path that does
// not resolve, and an import of a symbol the target never exported. Both are
// build-breaking and neither is visible to eslint.
//
// Usage: node scripts/verify-imports.mjs
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
const EXTS = ["", ".js", ".jsx", ".ts", ".tsx", "/index.js", "/index.jsx"];

// Files we can inspect. Anything else (css, json, images) resolves but is not parsed.
const PARSEABLE = /\.(js|jsx|ts|tsx)$/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function resolveSpec(spec, fromFile) {
  let base;
  if (spec.startsWith("@/")) base = join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(fromFile), spec);
  else return { external: true };            // bare package — npm's problem, not ours

  for (const ext of EXTS) {
    const p = base + ext;
    try {
      if (statSync(p).isFile()) return { path: p };
    } catch { /* keep probing */ }
  }
  return { missing: true, tried: base };
}

const files = walk(SRC).filter((f) => PARSEABLE.test(f));
const ast = new Map();
const exportsOf = new Map();
const problems = [];

for (const f of files) {
  let tree;
  // .ts needs the typescript plugin; "jsx" and "typescript" cannot both be on
  // for a plain .ts file because `<T>x` is a type assertion there, not an element.
  const plugins = f.endsWith(".ts")
    ? ["typescript"]
    : f.endsWith(".tsx")
      ? ["jsx", "typescript"]
      : ["jsx"];
  try {
    tree = parse(readFileSync(f, "utf8"), {
      sourceType: "module",
      plugins: [...plugins, "classProperties", "objectRestSpread", "dynamicImport", "optionalChaining", "nullishCoalescingOperator"],
    });
  } catch (e) {
    problems.push(`PARSE  ${relative(ROOT, f)}: ${e.message}`);
    continue;
  }
  ast.set(f, tree);

  const names = new Set();
  for (const node of tree.program.body) {
    if (node.type === "ExportDefaultDeclaration") names.add("default");
    else if (node.type === "ExportAllDeclaration") names.add("*");
    else if (node.type === "ExportNamedDeclaration") {
      for (const s of node.specifiers || []) names.add(s.exported.name || s.exported.value);
      const d = node.declaration;
      if (!d) continue;
      if (d.type === "VariableDeclaration") {
        for (const decl of d.declarations) {
          if (decl.id.type === "Identifier") names.add(decl.id.name);
          else if (decl.id.type === "ObjectPattern") for (const p of decl.id.properties) if (p.value?.name) names.add(p.value.name);
        }
      } else if (d.id?.name) names.add(d.id.name);
    }
  }
  exportsOf.set(f, names);
}

let checked = 0;
for (const [f, tree] of ast) {
  for (const node of tree.program.body) {
    const spec = node.source?.value;
    if (!spec) continue;
    if (node.type !== "ImportDeclaration" && node.type !== "ExportNamedDeclaration" && node.type !== "ExportAllDeclaration") continue;

    const r = resolveSpec(spec, f);
    if (r.external) continue;
    if (r.missing) {
      problems.push(`MISSING ${relative(ROOT, f)} -> "${spec}" (no file at ${relative(ROOT, r.tried)}[.js|.jsx|/index.js])`);
      continue;
    }
    checked += 1;

    const target = exportsOf.get(r.path);
    if (!target || target.has("*")) continue;    // not parseable, or re-exports everything

    for (const s of node.specifiers || []) {
      const wanted =
        s.type === "ImportDefaultSpecifier" ? "default"
        : s.type === "ImportSpecifier" ? (s.imported.name || s.imported.value)
        : null;                                   // namespace import — nothing to check
      if (wanted && !target.has(wanted)) {
        problems.push(`NO EXPORT ${relative(ROOT, f)} imports { ${wanted} } from "${spec}" — ${relative(ROOT, r.path)} does not export it`);
      }
    }
  }
}

console.log(`Parsed ${ast.size} files, resolved ${checked} internal imports.`);
if (problems.length) {
  for (const p of problems) console.log(`  ✗ ${p}`);
  console.log(`\n${problems.length} problem(s).`);
  process.exit(1);
}
console.log("No unresolved modules and no missing named exports.");
