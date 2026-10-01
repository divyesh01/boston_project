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
const coordinationPath = "docs/engineering/CODEX_ANTIGRAVITY_WORKFLOW.md";
const canonical = read(canonicalPath);
const coordination = read(coordinationPath);
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
check("canonical policy makes Codex the implementation owner", canonical.includes("Codex is the implementation owner"));
check("canonical policy makes Antigravity the verification owner", canonical.includes("Antigravity is the verification owner"));
check("Codex role split applies to every model", canonical.includes("every Codex model or variant"));
check("Codex avoids duplicate broad verification", canonical.includes("must **not** spend substantial context or execution budget duplicating verification"));
check("canonical policy requires the shared Codex/Antigravity contract", canonical.includes(coordinationPath));
check("shared role contract exists", coordination.length > 2000);
check("shared role contract applies to every Codex and Antigravity model", coordination.includes("every model, size, reasoning level, and variant"));
check("shared role contract makes Codex implementation owner", coordination.includes("Codex role: implementation owner"));
check("shared role contract makes Antigravity verification owner", coordination.includes("Antigravity role: verification owner"));
check("shared role contract requires Codex handoff", coordination.includes("Required handoff: Codex -> Antigravity"));
check("shared role contract requires Antigravity report", coordination.includes("Required report: Antigravity -> Codex"));
check("shared role contract preserves implementation-verification loop", coordination.includes("Codex plans/implements -> Antigravity tests/verifies -> Codex fixes findings -> Antigravity re-verifies"));

for (const adapter of adapters) {
  const text = read(adapter);
  check(`${adapter} routes to canonical policy`, text.includes(canonicalPath));
}

const mandatoryCoordinationAdapters = [
  "GEMINI.md",
  ".agents/agents.md",
  ".agents/skills/divyesh-v3-router/SKILL.md",
  "AI_CORE_RULES.md",
  ".agents/rules/project-context.md",
];
for (const adapter of mandatoryCoordinationAdapters) {
  const text = read(adapter);
  check(`${adapter} routes to mandatory Codex/Antigravity contract`, text.includes(coordinationPath));
}

const codexAdapter = read("AGENTS.md");
check(
  "Codex reaches mandatory role contract through canonical policy",
  codexAdapter.includes(canonicalPath) && canonical.includes(coordinationPath),
);

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
    return /(?:do not use|do not substitute|never substitute|not a bare)[\s\S]{0,120}npx tsc --noEmit/i.test(text);
  }),
);

console.log(`${failed ? "FAILED" : "PASSED"}: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
