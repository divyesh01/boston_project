#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const schema = JSON.parse(await readFile(new URL('../base44/entities/User.jsonc', import.meta.url), 'utf8'));
const generatedTypes = await readFile(new URL('../base44/.types/types.d.ts', import.meta.url), 'utf8');
const registerSource = await readFile(new URL('../base44/functions/custom_auth_register/entry.js', import.meta.url), 'utf8');
const loginSource = await readFile(new URL('../base44/functions/custom_auth_login/entry.js', import.meta.url), 'utf8');

let passed = 0;
let failed = 0;
const failures = [];
function check(name, assertion) {
  try {
    assertion();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    failures.push(`${name}: ${error.message}`);
    console.error(`FAIL ${name}`);
  }
}

check('User schema declares the email field used by authentication', () => {
  assert.equal(schema.properties.email?.type, 'string');
  assert.equal(schema.properties.email?.format, 'email');
});

check('User schema requires the email field required by registration', () => {
  assert.ok(schema.required?.includes('email'));
});

check('User schema declares the full_name field written by registration', () => {
  assert.equal(schema.properties.full_name?.type, 'string');
});

check('registration writes the fields covered by this contract', () => {
  assert.match(registerSource, /entities\.User\.create\(\{[\s\S]*?email:\s*email\.toLowerCase\(\)[\s\S]*?full_name:/);
});

check('login queries the declared email field', () => {
  assert.match(loginSource, /entities\.User\.filter\(\{\s*email:\s*normalized\s*\}/);
});

check('generated Base44 User type contains the schema contract', () => {
  const userInterface = generatedTypes.match(/export interface User \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(userInterface, /\n\s*email:\s*string;/);
  assert.match(userInterface, /\n\s*full_name\?:\s*string;/);
});

console.log(`\n${failed === 0 ? 'PASSED' : 'FAILED'}: ${passed} passed, ${failed} failed`);
for (const failure of failures) console.error(`  - ${failure}`);
process.exitCode = failed === 0 ? 0 : 1;
