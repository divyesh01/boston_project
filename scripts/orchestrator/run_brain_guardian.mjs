#!/usr/bin/env node
/**
 * BRAIN_MD_GUARDIAN Runner (with Active-Active FallbackPolicy)
 * -----------------------------------------------------------
 * Dedicated Claude Opus agent: BRAIN_MD_GUARDIAN
 * Model: Claude Opus (Active-Active Tabitoken + GoRouter)
 * Role: Final authority for project brain/instruction documentation.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  ProviderRegistry,
  FallbackPolicy,
  defaultActiveRouter,
} from '../../src/orchestrator/index.js';

const BRAIN_FILES = [
  'AGENTS.md',
  'CLAUDE.md',
  'AI_CORE_RULES.md',
  'ARCHITECT.md',
  'BRAIN.md',
  'BUSINESS.md',
  'SECURITY.md',
  'INFRASTRUCTURE_SECURITY.md',
  'TESTING.md',
  'UI_UX.md',
  'PROJECT_MAP.md',
  'PROTECTED_FILES.md',
  '.agents/rules/no-modify-protected.md',
  '.agents/rules/mandatory-multiagent-cowork.md',
  '.agents/rules/claude-high-trust-review.md',
  '.agents/rules/verified-work-integrity.md',
  '.agents/rules/master-upgrade-protocol.md',
  'README.md',
];

async function main() {
  console.log('================================================================================');
  console.log('BRAIN_MD_GUARDIAN: DEDICATED CLAUDE OPUS DOCUMENTATION AUTHORITY');
  console.log('================================================================================\n');

  const rootDir = process.cwd();
  const registry = new ProviderRegistry({ rootDir });
  const fallbackPolicy = new FallbackPolicy({ timeoutMs: 180000 });

  // Gather brain markdown files
  const brainContents = {};
  for (const relPath of BRAIN_FILES) {
    const fullPath = path.join(rootDir, relPath);
    if (fs.existsSync(fullPath)) {
      const raw = fs.readFileSync(fullPath, 'utf8');
      // For massive 50k reference files, sample structure and headers to keep prompt within bounds
      if (raw.length > 15000) {
        brainContents[relPath] = raw.slice(0, 8000) + '\n\n... [TRUNCATED FOR CONTEXT EFFICIENCY — PRESERVE DOMAIN INVARIANTS] ...\n\n' + raw.slice(-4000);
      } else {
        brainContents[relPath] = raw;
      }
      console.log(`[+] Loaded brain file: ${relPath} (${raw.length} bytes)`);
    } else {
      console.log(`[-] Warning: ${relPath} not found`);
    }
  }

  const systemPrompt = `You are BRAIN_MD_GUARDIAN, the Final Authority for project brain and instruction documentation in this repository.
Model: Claude Opus.
Role: Inspect EVERY project brain .md file against the REAL codebase state, identify outdated details, add new architecture/rules, ensure Active-Active Tabitoken + GoRouter, Executive Dashboard 3-box standard, and Luxury 3D button system are accurately documented, and output exact file patch blocks for any needed updates.

Current Ground-Truth Codebase State:
- Test Suite: 59 test files, 505 unit & integration tests passing (Vitest).
- Lint & Typecheck: 0 ESLint errors, 0 TypeScript errors (tsc -p jsconfig.json).
- Multi-Agent Orchestrator:
  * Primary Author: Claude Opus API (Active-Active dual channel over Tabitoken + GoRouter).
  * Reviewer Swarm: Nara (free tier), xKiro, NVIDIA NIM, Gemini API.
  * Wave A: 4 parallel Claude Opus workers (strictly balanced 2 Tabitoken + 2 GoRouter).
  * Wave B: Parallel specialist reviewers.
  * Wave C: Authoritative Claude Opus synthesis & definitive patch creation.
  * Mechanical Patch Applier: Deterministic CRLF/LF-normalized search/replace with SHA-256 validation.
  * Executive Dashboard Presentation Standard: 3-box display (Multi-Agent Comparison Box -> Main Contribution Box -> Run Summary Box) before receipts.
  * Subscription Quota Conservation: 0% Codex subscription usage, Antigravity launcher/dashboard only (0% substantive reasoning/authoring offloaded to Claude Opus API).
- Central Design System:
  * Luxury 3D Button System in src/components/ui/button.jsx and src/index.css (layered linear gradients, specular top highlights, contact shadows, active compression, scoped transitions, emerald brand focus rings).
  * 14 Protected Files locked in PROTECTED_FILES.md.

Instructions:
1. Review all provided brain .md files.
2. For any file needing an update, emit the exact file modification block:
### FILE: <relative_path>
\`\`\`markdown
<complete updated file content>
\`\`\`
or SEARCH/REPLACE blocks.
3. Provide the structured final audit report with exact sections:
Brain files checked:
Files updated:
Files already current:
Important information added:
Conflicts fixed:
Anything still uncertain:
Final verdict: BRAIN DOCS = PASS / FAIL / UNPROVEN`;

  let prompt = '### CURRENT BRAIN MARKDOWN FILES:\n\n';
  for (const [relPath, content] of Object.entries(brainContents)) {
    prompt += `=== FILE: ${relPath} ===\n${content}\n\n`;
  }
  prompt += 'Conduct your authoritative audit across all brain files now and output any required updates:';

  console.log('\n[Phase 1] Launching Claude Opus BRAIN_MD_GUARDIAN via Active-Active FallbackPolicy...');
  const result = await fallbackPolicy.executeAuthoritativeClaude(registry, {
    role: 'BRAIN_MD_GUARDIAN',
    prompt,
    systemPrompt,
    maxTokens: 4000,
    preferredProvider: 'GOROUTER',
  });

  console.log(`[+] Claude Opus Response Received in ${result.totalLatencySeconds}s via ${result.transportProvider} (${result.authoritativeModel})`);

  if (!result.success || !result.content) {
    console.error('[-] Claude Opus call failed:', result.error);
    process.exit(1);
  }

  // Save the full raw guardian output
  fs.writeFileSync('scripts/orchestrator/guardian_response.txt', result.content, 'utf8');
  console.log('[+] Saved raw response to scripts/orchestrator/guardian_response.txt');

  console.log('\n================================================================================');
  console.log('BRAIN_MD_GUARDIAN AUDIT OUTPUT');
  console.log('================================================================================\n');
  console.log(result.content);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
