// Ensures provider-specific AI instruction files all route to one canonical policy.
// This prevents the exact drift that previously left CLAUDE.md recommending a bare
// `npx tsc --noEmit` even though the verified repository command is `npm run typecheck`.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0;
let failed = 0;

function check(label, condition, detail = "") {
  if (condition) {
    passed += 1;
    return;
  }
  failed += 1;
  console.error(`FAILED: ${label}${detail ? ` — ${detail}` : ""}`);
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

const canonicalPath = "docs/engineering/AGENT_RULES.md";
const canonical = read(canonicalPath);
const adapters = [
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  "AI_CORE_RULES.md",
  ".agents/agents.md",
  ".agents/skills/divyesh-v3-router/SKILL.md",
  ".claude/skills/divyesh-v3-router/SKILL.md",
  ".cursorrules",
  ".windsurfrules",
];

check("canonical policy exists", canonical.length > 1000);
check("canonical policy names protected-file authority", canonical.includes("PROTECTED_FILES.md"));
check("canonical policy requires V3 verification", canonical.includes("npm run verify:v3"));
check("canonical policy uses the real typecheck command", canonical.includes("npm run typecheck"));
check("canonical policy forbids direct ordinary work on main", canonical.includes("directly on `main`"));
check("canonical policy protects synthetic-only HotelKey fixtures", canonical.includes("no real guest, hotel, PMS, or production data"));
check("canonical policy does not recommend the broken bare tsc command", !canonical.includes("\n\`\`\`bash\nnpx tsc --noEmit"));

for (const adapter of adapters) {
  const text = read(adapter);
  check(`${adapter} routes to canonical policy`, text.includes(canonicalPath));
}

const v3Adapters = [
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  ".agents/agents.md",
  ".agents/skills/divyesh-v3-router/SKILL.md",
  ".claude/skills/divyesh-v3-router/SKILL.md",
];

for (const adapter of v3Adapters) {
  const text = read(adapter);
  check(
    `${adapter} keeps DIVYESH V3 identity`,
    /DIVYESH(?:-| )V3/i.test(text) || /divyesh-v3-router/i.test(text),
  );
  check(`${adapter} keeps canonical manifest routing`, text.includes("docs/divyesh-v3/manifest.json"));
}

// User-facing adapters name the executable commands directly. Router skills stay thin:
// they route to the canonical engineering policy instead of duplicating command policy.
const commandAdapters = ["AGENTS.md", "CLAUDE.md", "GEMINI.md", ".cursorrules", ".windsurfrules"];
for (const adapter of commandAdapters) {
  const text = read(adapter);
  check(`${adapter} requires verify:v3`, text.includes("npm run verify:v3"));
  check(`${adapter} names the correct typecheck command`, text.includes("npm run typecheck"));
}

check(
  "user-facing adapters prohibit bare npx tsc as the command",
  commandAdapters.every((file) => {
    const text = read(file);
    return /do not use|never substitute/i.test(text) && text.includes("npx tsc --noEmit");
  }),
);

console.log(`${failed ? "FAILED" : "PASSED"}: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
