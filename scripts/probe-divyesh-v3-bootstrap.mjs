import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeContent, updateManifest, verifyRepository } from './verify-divyesh-v3.mjs';

let passed = 0;

async function write(root, relativePath, content) {
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
}

async function makeFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'divyesh-v3-probe-'));
  const canonicalBody = `# Canonical Pack\n\n${'Evidence-driven workflow rule. '.repeat(16)}\n`;
  await write(root, 'PROTOCOL_V3_ADDENDUM.md', '# Protocol\n\nCanonical constitution.\n');
  await write(root, 'docs/divyesh-v3/KERNEL.md', canonicalBody);
  await write(root, 'GEMINI.md', '# Adapter\nBOOTSTRAP_SCHEMA: 1.0.0\nCANONICAL_MANIFEST: docs/divyesh-v3/manifest.json\n');
  await write(root, '.agents/agents.md', '# Adapter\nBOOTSTRAP_SCHEMA: 1.0.0\nCANONICAL_MANIFEST: docs/divyesh-v3/manifest.json\n');
  await write(root, 'docs/divyesh-v3/manifest.json', `${JSON.stringify({
    system: 'DIVYESH-V3',
    protocol_version: '3.0.0',
    protocol_hash: 'PENDING',
    hash_algorithm: 'sha256-normalized-v1',
    bootstrap_schema_minimum: '1.0.0',
    canonical_files: [
      { path: 'PROTOCOL_V3_ADDENDUM.md', sha256: 'PENDING' },
      { path: 'docs/divyesh-v3/KERNEL.md', sha256: 'PENDING' },
    ],
    adapters: [
      { platform: 'gemini', path: 'GEMINI.md', bootstrap_schema: '1.0.0' },
      { platform: 'antigravity', path: '.agents/agents.md', bootstrap_schema: '1.0.0' },
    ],
    pending_protected_adapters: ['AGENTS.md', 'CLAUDE.md'],
  }, null, 2)}\n`);
  await updateManifest(root);
  return { root, canonicalBody };
}

async function test(name, mutation, expectedReason) {
  const fixture = await makeFixture();
  try {
    if (mutation) await mutation(fixture);
    const result = await verifyRepository(fixture.root);
    if (expectedReason === null) {
      assert.equal(result.drift, false, JSON.stringify(result.mismatches));
    } else {
      assert.equal(result.drift, true, `expected drift for ${name}`);
      assert.ok(result.mismatches.some((item) => item.reason.includes(expectedReason)), JSON.stringify(result.mismatches));
    }
    passed += 1;
    console.log(`PASS ${name}`);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

await test('clean fixture', null, null);

await test('wrong protocol hash', async ({ root }) => {
  const manifestPath = path.join(root, 'docs/divyesh-v3/manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.protocol_hash = 'sha256:deadbeef';
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}, 'protocol hash mismatch');

await test('missing canonical pack', async ({ root }) => {
  await rm(path.join(root, 'docs/divyesh-v3/KERNEL.md'));
}, 'ENOENT');

await test('old adapter bootstrap schema', async ({ root }) => {
  await write(root, 'GEMINI.md', '# Adapter\nBOOTSTRAP_SCHEMA: 0.9.0\nCANONICAL_MANIFEST: docs/divyesh-v3/manifest.json\n');
}, 'bootstrap schema is missing or older');

await test('adapter points at another manifest', async ({ root }) => {
  await write(root, '.agents/agents.md', '# Adapter\nBOOTSTRAP_SCHEMA: 1.0.0\nCANONICAL_MANIFEST: docs/other/manifest.json\n');
}, 'instead of docs/divyesh-v3/manifest.json');

await test('adapter duplicates canonical body', async ({ root, canonicalBody }) => {
  await write(root, 'GEMINI.md', `# Adapter\nBOOTSTRAP_SCHEMA: 1.0.0\nCANONICAL_MANIFEST: docs/divyesh-v3/manifest.json\n\n${normalizeContent(canonicalBody)}`);
}, 'duplicates canonical body');

await test('CRLF normalizes to LF', async ({ root }) => {
  const kernel = path.join(root, 'docs/divyesh-v3/KERNEL.md');
  const original = await readFile(kernel, 'utf8');
  await writeFile(kernel, normalizeContent(original).replace(/\n/g, '\r\n'), 'utf8');
}, null);

await test('marked legacy adapter checks only its bootstrap block', async ({ root }) => {
  const manifestPath = path.join(root, 'docs/divyesh-v3/manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.adapters[0].check_scope = 'marked-block';
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await write(root, 'GEMINI.md', `${'Legacy instructions. '.repeat(500)}\n<!-- DIVYESH-V3-BOOTSTRAP:START -->\nBOOTSTRAP_SCHEMA: 1.0.0\nCANONICAL_MANIFEST: docs/divyesh-v3/manifest.json\n<!-- DIVYESH-V3-BOOTSTRAP:END -->\n`);
}, null);

await test('missing marked bootstrap block', async ({ root }) => {
  const manifestPath = path.join(root, 'docs/divyesh-v3/manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.adapters[0].check_scope = 'marked-block';
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}, 'marked bootstrap block missing or malformed');

const failed = 9 - passed;
console.log(`${failed === 0 ? 'PASSED' : 'FAILED'}: ${passed} mutation and normalization cases passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
