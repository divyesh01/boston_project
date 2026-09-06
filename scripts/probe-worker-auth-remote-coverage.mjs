// Regression proof for F-076: the remote Worker-auth probe must honestly SKIP
// (not FAIL) when Cloudflare's control plane transiently refuses the
// pre-assertion temporary-D1 provisioning call with
// `Authentication error [code: 10000]` — and must keep failing loudly on
// everything else. Purely local: no Cloudflare calls, no fixtures on disk.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { classifySuiteRun } from './_verdict.mjs';
import { isTransientD1ProvisioningOutage } from './_cloudflare-transient.mjs';
import { REPO_ROOT } from './_repo-root.mjs';

let passed = 0;
function check(name, condition, detail = '') {
  assert.ok(condition, `${name}${detail ? ` — ${detail}` : ''}`);
  passed += 1;
  console.log(`PASS ${name}`);
}

// 1. The proven transient signature SKIP-classifies...
check(
  'exact transient signature is recognised',
  isTransientD1ProvisioningOutage('Authentication error [code: 10000]') === true,
);
check(
  'transient signature inside the probe wrangler() wrapper is recognised',
  isTransientD1ProvisioningOutage(
    'Wrangler failed (1): POST (/accounts/8142xxx/d1/database) failed. Authentication error [code: 10000]',
  ) === true,
);
check(
  'transient signature on an Error object is recognised',
  isTransientD1ProvisioningOutage(new Error('Authentication error [code: 10000]')) === true,
);

// ...and the runner files that shape as SKIP, not FAIL.
{
  const skipRun = classifySuiteRun({
    out: 'SKIP: Cloudflare control plane returned a transient authentication error ([code: 10000]) while provisioning the temporary D1; no Worker auth assertion ran.',
    code: 0,
  });
  check('SKIP line with exit 0 classifies as SKIP', skipRun.status === 'SKIP', skipRun.status);
  const crashRun = classifySuiteRun({
    out: 'Error: Wrangler failed (1): POST (/accounts/8142xxx/d1/database) failed. Authentication error [code: 10000]',
    code: 1,
  });
  check('unconverted transient crash still classifies as FAIL', crashRun.status === 'FAIL', crashRun.status);
}

// 2. Lookalikes and real failures must NOT SKIP.
for (const [name, value] of [
  ['different Cloudflare code is not transient', 'Authentication error [code: 10001]'],
  ['truncated code is not transient', 'Authentication error [code: 1000]'],
  ['bare authentication error without a code is not transient', 'Authentication error'],
  ['generic wrangler failure is not transient', 'Wrangler failed (1): Command failed: wrangler d1 create rri-x'],
  ['missing database id is not transient', 'Could not resolve temporary D1 id.'],
  ['preview timeout is not transient', 'Timed out waiting for remote preview: Ready on http://127.0.0.1:8793'],
  ['early preview exit is not transient', 'Remote preview exited early: JavaScript error'],
  ['assertion text is not transient', 'valid password creates a session failed (status=401)'],
  ['empty string is not transient', ''],
  ['null is not transient', null],
  ['undefined is not transient', undefined],
]) {
  check(name, isTransientD1ProvisioningOutage(value) === false, String(value));
}

// 3. Wiring: the SKIP path exists exactly once, scoped to the d1-create call,
// and no assertion was weakened to buy it.
{
  const source = await readFile(path.join(REPO_ROOT, 'scripts', 'probe-worker-auth-remote.mjs'), 'utf8');
  const skipSites = source.match(/^.*SKIP:.*$/gm) || [];
  check('probe has exactly one SKIP: site', skipSites.length === 1, `${skipSites.length} sites`);
  const createAt = source.indexOf('"d1", "create"');
  const skipAt = source.indexOf('SKIP:');
  const executeAt = source.indexOf('"d1", "execute"');
  check('SKIP site is scoped after the d1-create call', createAt !== -1 && skipAt > createAt);
  check('SKIP site is before any d1-execute call', executeAt !== -1 && skipAt < executeAt);
  check(
    'id-parse miss deletes the temporary database by name before throwing',
    /"d1",\s*"delete",\s*database[\s\S]{0,400}Could not resolve temporary D1 id\./.test(source),
  );
  for (const name of [
    'plaintext absent from D1 seed',
    'malformed input is controlled 4xx',
    'nonexistent user rejects without 500',
    'wrong password rejects without 500',
    'valid password creates a session',
    'legacy format fails closed',
    'unsupported version fails closed',
    'remote runtime logged no auth 500',
  ]) {
    check(`assertion kept: ${name}`, source.includes(`check("${name}"`));
  }
}

console.log(`\nPASSED: ${passed} F-076 coverage-verdict cases passed`);
if (passed !== 28) process.exit(1);
process.exit(0);
