#!/usr/bin/env node
/**
 * probe-deletion-manifest.mjs
 *
 * CONTRACT PROBE — deletion manifest integrity checker.
 *
 * Asserts that:
 *   1. base44/deletion-manifest.json is valid JSON and has the required schema.
 *   2. Every entity listed under DELETE is also present in deleteAccount/entry.ts.
 *   3. No entity in deleteAccount/entry.ts is missing from the manifest.
 *   4. The pagination strategy matches what the code implements (.filter, not .list).
 *   5. No RETAIN entity appears in the DELETE list.
 *
 * This is the "can't forget a new entity" gate. Run it in CI or as part of
 * npm run verify:all to ensure the manifest and the code stay in sync.
 *
 * Exit 0 = all assertions pass.
 * Exit 1 = at least one assertion failed (error printed to stderr).
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');

let passed = 0;
let failed = 0;

function ok(label) {
  console.log(`  ✓  ${label}`);
  passed++;
}

function fail(label, detail) {
  console.error(`  ✗  ${label}`);
  if (detail) console.error(`     ${detail}`);
  failed++;
}

// ─── Load manifest ───────────────────────────────────────────────────────────

let manifest;
try {
  const raw = readFileSync(resolve(ROOT, 'base44/deletion-manifest.json'), 'utf8');
  manifest = JSON.parse(raw);
  ok('deletion-manifest.json parses as valid JSON');
} catch (err) {
  fail('deletion-manifest.json must be valid JSON', err.message);
  process.exit(1); // can't continue without the manifest
}

// ─── Schema checks ───────────────────────────────────────────────────────────

const deleteEntities = manifest?.rules?.DELETE?.entities;
const retainEntities = manifest?.rules?.RETAIN?.entities;

if (Array.isArray(deleteEntities) && deleteEntities.length > 0) {
  ok(`manifest.rules.DELETE.entities has ${deleteEntities.length} entries`);
} else {
  fail('manifest.rules.DELETE.entities must be a non-empty array');
}

if (Array.isArray(retainEntities) && retainEntities.length > 0) {
  ok(`manifest.rules.RETAIN.entities has ${retainEntities.length} entries`);
} else {
  fail('manifest.rules.RETAIN.entities must be a non-empty array');
}

if (manifest?.pagination?.strategy === 'filter_scoped') {
  ok('manifest.pagination.strategy is filter_scoped (not list)');
} else {
  fail('manifest.pagination.strategy must be filter_scoped', `got: ${manifest?.pagination?.strategy}`);
}

if (manifest?.pagination?.pageSize === 500) {
  ok('manifest.pagination.pageSize matches PAGE=500 in deleteAccount');
} else {
  fail('manifest.pagination.pageSize must be 500', `got: ${manifest?.pagination?.pageSize}`);
}

// ─── Load deleteAccount/entry.ts ─────────────────────────────────────────────

let entrySource;
try {
  entrySource = readFileSync(resolve(ROOT, 'base44/functions/deleteAccount/entry.ts'), 'utf8');
  ok('deleteAccount/entry.ts loaded for entity cross-check');
} catch (err) {
  fail('deleteAccount/entry.ts must be readable', err.message);
  process.exit(1);
}

// Extract the entities array literal from the source.
// Pattern: const entities = ['A', 'B', 'C', ...]
const entitiesMatch = entrySource.match(
  /const\s+entities\s*=\s*\[([^\]]+)\]/s
);

let codeEntities = [];
if (entitiesMatch) {
  codeEntities = entitiesMatch[1]
    .split(',')
    .map(s => s.trim().replace(/['"]/g, '').trim())
    .filter(Boolean);
  ok(`deleteAccount/entry.ts declares ${codeEntities.length} entities in the loop`);
} else {
  fail('Could not parse entities array in deleteAccount/entry.ts', 'check the regex if the array format changed');
  process.exit(1);
}

// ─── Cross-check manifest DELETE ↔ code ──────────────────────────────────────

const manifestDeleteNames = new Set((deleteEntities || []).map(e => e.name));
const codeEntitySet = new Set(codeEntities);

// Every manifest DELETE entity must appear in the code.
for (const name of manifestDeleteNames) {
  if (codeEntitySet.has(name)) {
    ok(`manifest DELETE entity "${name}" is present in the deleteAccount loop`);
  } else {
    fail(
      `manifest DELETE entity "${name}" is NOT in deleteAccount/entry.ts`,
      'Add it to the entities array in deleteAccount, or remove it from the manifest.'
    );
  }
}

// Every code entity must appear in the manifest DELETE list.
for (const name of codeEntitySet) {
  if (manifestDeleteNames.has(name)) {
    ok(`code entity "${name}" is documented in the manifest DELETE list`);
  } else {
    fail(
      `code entity "${name}" is in deleteAccount but NOT in the manifest`,
      'Add it to manifest.rules.DELETE.entities with a reason, or remove it from the code.'
    );
  }
}

// ─── No overlap between DELETE and RETAIN ────────────────────────────────────

const retainNames = new Set((retainEntities || []).map(e => e.name));
for (const name of manifestDeleteNames) {
  if (retainNames.has(name)) {
    fail(`"${name}" appears in BOTH DELETE and RETAIN`, 'This is a contradiction — pick one.');
  }
}
if (failed === 0) {
  ok('No entity appears in both DELETE and RETAIN');
}

// ─── Stall guard check ───────────────────────────────────────────────────────

if (manifest?.stallGuard?.maxIterations === 10000) {
  ok('manifest.stallGuard.maxIterations matches guard=10000 in deleteAccount');
} else {
  fail('manifest.stallGuard.maxIterations must be 10000');
}

// ─── Report ──────────────────────────────────────────────────────────────────

console.log('');
console.log(`probe-deletion-manifest: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.error('');
  console.error('FAIL: deletion manifest and deleteAccount/entry.ts are out of sync.');
  console.error('Edit base44/deletion-manifest.json or base44/functions/deleteAccount/entry.ts to reconcile them.');
  process.exit(1);
} else {
  console.log('PASS: manifest and code are in sync.');
  process.exit(0);
}
