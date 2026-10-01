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
  if (condition) {
    passed += 1;
    return;
  }
  failed += 1;
  console.error(`FAIL: ${label}`);
}

function runContext(query) {
  const result = spawnSync(process.execPath, ['scripts/ai-context.mjs', '--json', query], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 20_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  check(result.status === 0, `ai-context exits 0 for ${query} (status ${result.status}, stderr ${result.stderr})`);
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    check(false, `ai-context returns JSON for ${query}: ${error.message}`);
    return {};
  }
}

const packageJson = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
check(packageJson.scripts?.['ai:context'] === 'node scripts/ai-context.mjs', 'package.json exposes npm run ai:context');

const dashboard = runContext('Dashboard YTD revenue');
check(dashboard.v3?.status === 'PASS', 'Dashboard context reports V3 PASS');
check(dashboard.areas?.some((area) => area.area === 'Revenue/KPIs'), 'Dashboard routes to Revenue/KPIs');
check(
  dashboard.areas?.some((area) => area.tests?.some((test) => test.command?.includes('probe-financial-invariant'))),
  'Dashboard context includes the revenue financial invariant gate',
);
check(Array.isArray(dashboard.known_failures), 'Dashboard context includes the known-failure registry result');

const auth = runContext('src/lib/AuthContext.jsx');
check(auth.areas?.some((area) => area.area === 'Auth'), 'AuthContext routes to Auth');
check(
  auth.protected_query_matches?.includes('src/lib/AuthContext.jsx'),
  'AuthContext is identified as protected',
);
check(
  auth.areas?.some((area) => area.never_touch?.includes('src/lib/AuthContext.jsx')),
  'Auth area repeats the protected-file boundary',
);

if (failed === 0) {
  console.log(`PASSED: probe-ai-context — ${passed} passed, 0 failed`);
} else {
  console.error(`FAILED: probe-ai-context — ${passed} passed, ${failed} failed`);
  process.exitCode = 1;
}
