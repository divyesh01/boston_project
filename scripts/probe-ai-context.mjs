#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
let failed = 0;

function check(condition, label) {
  if (condition) { passed += 1; return; }
  failed += 1;
  console.error(`FAIL: ${label}`);
}

function runContext(args, label) {
  const result = spawnSync(process.execPath, ['scripts/ai-context.mjs', '--json', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  check(result.status === 0, `ai-context exits 0 for ${label} (status ${result.status}, stderr ${result.stderr})`);
  try { return JSON.parse(result.stdout); }
  catch (error) {
    check(false, `ai-context returns JSON for ${label}: ${error.message}`);
    return {};
  }
}

const packageJson = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
check(packageJson.scripts?.['ai:context'] === 'node scripts/ai-context.mjs', 'package.json exposes ai:context');
check(packageJson.scripts?.['ai:check'] === 'node scripts/ai-context.mjs --check --changed', 'package.json exposes ai:check');

const registry = JSON.parse(readFileSync(path.join(ROOT, 'docs/engineering/KNOWN_FAILURES.json'), 'utf8'));
check(registry.schema_version === 2, 'known-failure registry uses schema v2');
check(Array.isArray(registry.failures), 'known-failure registry has failures array');

const dashboard = runContext(['Dashboard YTD revenue'], 'Dashboard YTD revenue');
check(dashboard.schema_version === 2, 'context schema v2');
check(dashboard.v3?.status === 'PASS', 'V3 PASS');
check(dashboard.route_map?.status === 'PASS', 'repo map PASS');
check(dashboard.known_failure_registry?.status === 'PASS', 'known-failure registry PASS');
check(dashboard.areas?.some((area) => area.area === 'Revenue/KPIs'), 'Dashboard routes to Revenue/KPIs');
check(dashboard.proof_plan?.ordered?.some((command) => command.includes('probe-financial-invariant')), 'financial invariant in proof plan');
check(dashboard.proof_plan?.ordered?.includes('npm run typecheck'), 'typecheck in proof plan');
check(dashboard.handoff?.implementation_owner === 'Codex', 'Codex owns implementation');
check(dashboard.handoff?.verification_owner === 'Antigravity', 'Antigravity owns verification');

const auth = runContext(['src/lib/AuthContext.jsx'], 'AuthContext path');
check(auth.areas?.some((area) => area.area === 'Auth'), 'AuthContext routes to Auth');
check(auth.protected_query_matches?.includes('src/lib/AuthContext.jsx'), 'AuthContext identified as protected');
check(auth.risk?.level === 'PROTECTED', 'AuthContext raises PROTECTED risk');
check(auth.decision?.warnings?.some((warning) => warning.includes('protected files')), 'protected-file warning is explicit');

const checkMode = runContext(['--check', 'Dashboard YTD revenue'], 'post-edit check mode');
check(checkMode.mode === 'check', 'check invocation enters check mode');
check(Array.isArray(checkMode.changed_scope), 'check mode emits classified diff scope');
check(Array.isArray(checkMode.handoff?.verify_commands), 'check mode emits handoff commands');

if (failed === 0) console.log(`PASSED: probe-ai-context — ${passed} passed, 0 failed`);
else {
  console.error(`FAILED: probe-ai-context — ${passed} passed, ${failed} failed`);
  process.exitCode = 1;
}
