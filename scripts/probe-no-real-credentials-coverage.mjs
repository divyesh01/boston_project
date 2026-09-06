// Regression proof for F-079: the credential probe's declared scan surface is
// itself a precondition for PASS. This operates only on throwaway fixtures, so
// neither outcome depends on files in this checkout.

import assert from 'node:assert/strict';
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { REPO_ROOT } from './_repo-root.mjs';

const PROBE = 'probe-no-real-credentials.mjs';
const ROOTS = ['src', 'scripts', 'base44', 'backend', 'tests'];

async function write(root, relativePath, content) {
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
}

async function fixture({ missing = [] } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'credential-coverage-'));
  await mkdir(path.join(root, 'scripts'), { recursive: true });
  await copyFile(path.join(REPO_ROOT, 'scripts', PROBE), path.join(root, 'scripts', PROBE));
  await copyFile(path.join(REPO_ROOT, 'scripts', '_repo-root.mjs'), path.join(root, 'scripts', '_repo-root.mjs'));

  for (const directory of ROOTS.filter((name) => !missing.includes(name))) {
    await write(root, path.join(directory, 'clean-fixture.js'), 'export const cleanFixture = true;\n');
  }
  await write(root, 'src/api/authLocal.test.js', "const address = 'owner@test.local';\nregisterUser();\ndb.auth.login();\n");

  // The target's allowlist must be represented in an otherwise clean fixture,
  // otherwise its independent stale-entry check would obscure the coverage case.
  const targetSource = await readFile(path.join(REPO_ROOT, 'scripts', PROBE), 'utf8');
  const fixtures = [...targetSource.matchAll(/^\s*\['([^']+)',/gm)].map((match) => match[1]);
  assert.ok(fixtures.length > 0, 'could not build clean fixture: target allowlist was not found');
  await write(root, 'src/allowlist-fixtures.js', `export const documentedFixtures = ${JSON.stringify(fixtures)};\n`);
  return root;
}

function run(root) {
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', PROBE)], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(result.error, undefined, result.error?.message);
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

let passed = 0;

const complete = await fixture();
try {
  const result = run(complete);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /PASSED: no real identity or credential in tracked source\./);
  passed += 1;
  console.log('PASS all declared scan roots present => PASS');
} finally {
  await rm(complete, { recursive: true, force: true });
}

const singleMissing = await fixture({ missing: ['base44'] });
try {
  const result = run(singleMissing);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /every directory declared in SCAN_DIRS exists/);
  assert.match(result.output, /not found: base44/);
  assert.doesNotMatch(result.output, /PASSED: no real identity or credential in tracked source\./);
  passed += 1;
  console.log('PASS one absent declared scan root => FAIL naming the root');
} finally {
  await rm(singleMissing, { recursive: true, force: true });
}

const incomplete = await fixture({ missing: ['base44', 'backend', 'tests'] });
try {
  const result = run(incomplete);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /every directory declared in SCAN_DIRS exists/);
  assert.match(result.output, /not found: base44, backend, tests/);
  assert.doesNotMatch(result.output, /PASSED: no real identity or credential in tracked source\./);
  passed += 1;
  console.log('PASS absent declared scan roots => FAIL naming each root');
} finally {
  await rm(incomplete, { recursive: true, force: true });
}

console.log(`PASSED: ${passed} F-079 coverage-verdict cases passed`);
if (passed !== 3) process.exit(1);
process.exit(0);
