#!/usr/bin/env node
// scripts/audit-production-d1-readonly.mjs
// Verifies and executes the read-only production D1 audit queries.
// Asserts ZERO mutating statements exist before execution.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SQL_PATH = path.resolve(__dirname, 'audit-production-d1-readonly.sql');

export function loadAndVerifyQueries(sqlPath = SQL_PATH) {
  const content = fs.readFileSync(sqlPath, 'utf8');
  const statements = content
    .split(';')
    .map(s => s.replace(/--.*$/gm, '').trim())
    .filter(Boolean);

  const MUTATING_PATTERN = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|TRUNCATE|ATTACH|DETACH)\b/i;
  const ALLOWED_STARTS = /^(SELECT|PRAGMA\s+foreign_key_check)\b/i;

  const verified = [];
  for (let i = 0; i < statements.length; i++) {
    const raw = statements[i];
    // Remove comments
    const clean = raw.replace(/--.*$/gm, '').trim();
    if (!clean) continue;

    if (!ALLOWED_STARTS.test(clean)) {
      throw new Error(`Statement ${i + 1} does not start with an allowed read-only command: "${clean.slice(0, 40)}..."`);
    }
    if (MUTATING_PATTERN.test(clean)) {
      throw new Error(`Statement ${i + 1} contains prohibited mutating keyword: "${clean.slice(0, 40)}..."`);
    }
    verified.push(clean);
  }
  return verified;
}

export function printWranglerCommands() {
  console.log('\n=== CLOUDFLARE PRODUCTION READ-ONLY D1 AUDIT COMMAND ===\n');
  console.log('Execute the complete read-only audit against production D1:\n');
  console.log('  npx wrangler d1 execute boston-project-production-auth --remote --file=scripts/audit-production-d1-readonly.sql\n');
  console.log('Execute with JSON output formatting:\n');
  console.log('  npx wrangler d1 execute boston-project-production-auth --remote --file=scripts/audit-production-d1-readonly.sql --json\n');
  console.log('========================================================\n');
}

// Self-test execution when run directly
const args = process.argv.slice(2);
const queries = loadAndVerifyQueries();
console.log(`[audit-production-d1-readonly] Verified ${queries.length} queries in audit-production-d1-readonly.sql (100% read-only).`);

if (args.includes('--instructions') || args.includes('--help')) {
  printWranglerCommands();
} else {
  printWranglerCommands();
}
