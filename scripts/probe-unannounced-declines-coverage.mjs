// Regression proof for the next unannounced-decline cases. Each target runs in
// a throwaway checkout so a missing required path cannot be hidden by this repo.

import assert from 'node:assert/strict';
import { copyFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { REPO_ROOT } from './_repo-root.mjs';

async function write(root, relative, content = 'export const fixture = true;\n') {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
}

function run(root, script) {
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', script)], { cwd: root, encoding: 'utf8' });
  assert.equal(result.error, undefined, result.error?.message);
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

async function dbFixture({ missingAuditWriter = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-coverage-'));
  await mkdir(path.join(root, 'scripts'), { recursive: true });
  await copyFile(path.join(REPO_ROOT, 'scripts', 'probe-db-mock-rls.mjs'), path.join(root, 'scripts', 'probe-db-mock-rls.mjs'));
  await write(root, 'base44/functions/safe/entry.ts');
  if (!missingAuditWriter) await write(root, 'base44/functions/autoPayroll/entry.ts');
  await write(root, 'base44/functions/deleteAccount/entry.ts');
  await mkdir(path.join(root, 'base44', 'entities'), { recursive: true });
  await write(root, 'enhance.js');
  return root;
}

async function uiFixture({ missingPrimitive = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ui-exec-coverage-'));
  await mkdir(path.join(root, 'scripts'), { recursive: true });
  await copyFile(path.join(REPO_ROOT, 'scripts', 'verify-ui-exec-gates.mjs'), path.join(root, 'scripts', 'verify-ui-exec-gates.mjs'));
  for (const name of ['Button.jsx', 'Input.jsx', 'Select.jsx', 'SegmentedControl.jsx']) {
    if (missingPrimitive && name === 'Button.jsx') continue;
    await write(root, path.join('src', 'components', 'ui-exec', name));
  }
  return root;
}

let passed = 0;

for (const [name, build, script, expected] of [
  ['all audit writers present => PASS', () => dbFixture(), 'probe-db-mock-rls.mjs', null],
  ['missing tracked audit writer => FAIL', () => dbFixture({ missingAuditWriter: true }), 'probe-db-mock-rls.mjs', /autoPayroll\/entry\.ts is missing/],
  ['all named primitives present => PASS', () => uiFixture(), 'verify-ui-exec-gates.mjs', null],
  ['missing named primitive => FAIL', () => uiFixture({ missingPrimitive: true }), 'verify-ui-exec-gates.mjs', /all four named ui-exec primitives exist/],
]) {
  const root = await build();
  try {
    const result = run(root, script);
    assert.equal(result.status, expected ? 1 : 0, result.output);
    if (expected) assert.match(result.output, expected);
    passed += 1;
    console.log(`PASS ${name}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

console.log(`PASSED: ${passed} unannounced-decline coverage cases passed`);
if (passed !== 4) process.exit(1);
process.exit(0);
