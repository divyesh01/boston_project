// scripts/probe-entity-rls-declarations.mjs
// Verifies that every entity declaring a property_id field carries an RLS policy.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPTS_DIR, '..');

const argv = process.argv.slice(2);
const dirArgIndex = argv.indexOf('--dir');
const targetDir = dirArgIndex >= 0 && argv[dirArgIndex + 1]
  ? path.resolve(argv[dirArgIndex + 1])
  : path.resolve(REPO_ROOT, 'base44', 'entities');

console.log(`=== PROBE: ENTITY RLS DECLARATIONS ===`);
console.log(`Scanning entity directory: ${targetDir}\n`);

function stripJsonComments(str) {
  return str
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^\\:])\/\/.*$/gm, '$1');
}

let passed = 0;
let failed = 0;

function check(condition, name, detail = '') {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`);
  }
}

const files = fs.readdirSync(targetDir).filter((f) => f.endsWith('.jsonc') || f.endsWith('.json')).sort();

for (const file of files) {
  const filePath = path.join(targetDir, file);
  const raw = fs.readFileSync(filePath, 'utf8');
  let entity;
  try {
    entity = JSON.parse(stripJsonComments(raw));
  } catch (err) {
    check(false, `Valid JSON in ${file}`, err.message);
    continue;
  }

  const entityName = entity.name || path.basename(file, path.extname(file));
  const hasPropertyId = !!(entity.properties && entity.properties.property_id);

  if (hasPropertyId) {
    const hasRls = !!(entity.rls && typeof entity.rls === 'object' && Object.keys(entity.rls).length > 0);

    check(
      hasRls,
      `${entityName} (${file}): carries property_id and has a non-empty rls declaration`,
      `hasRls=${hasRls}`
    );
  } else {
    check(
      true,
      `${entityName} (${file}): no property_id field (global/unscoped entity)`
    );
  }
}

console.log('');
if (failed === 0) {
  console.log(`PASSED: ${passed} passed, ${failed} failed`);
} else {
  console.log(`FAILED: ${passed} passed, ${failed} failed`);
}

process.exit(failed > 0 ? 1 : 0);
