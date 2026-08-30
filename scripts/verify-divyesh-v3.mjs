import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const MANIFEST_PATH = 'docs/divyesh-v3/manifest.json';
const REQUIRED_SYSTEM = 'DIVYESH-V3';
const REQUIRED_HASH_ALGORITHM = 'sha256-normalized-v1';
const ADAPTER_SIZE_LIMIT = 6_000;
const DUPLICATE_BODY_MIN = 200;

export function normalizeContent(value) {
  return Buffer.isBuffer(value) ? normalizeContent(value.toString('utf8')) :
    `${value}`.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/\n*$/, '\n');
}

export function sha256Normalized(value) {
  return createHash('sha256').update(normalizeContent(value), 'utf8').digest('hex');
}

function protocolHash(entries) {
  const payload = [...entries]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((entry) => `${entry.path}\0${entry.sha256}\n`)
    .join('');
  return `sha256:${createHash('sha256').update(payload, 'utf8').digest('hex')}`;
}

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value ?? '');
  return match ? match.slice(1).map(Number) : null;
}

function versionAtLeast(actual, minimum) {
  const left = parseVersion(actual);
  const right = parseVersion(minimum);
  if (!left || !right) return false;
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return true;
}

function resolveInside(root, relativePath) {
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw new Error(`unsafe manifest path: ${relativePath}`);
  }
  const base = path.resolve(root);
  const resolved = path.resolve(base, relativePath);
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) {
    throw new Error(`manifest path escapes repository: ${relativePath}`);
  }
  return resolved;
}

async function readUtf8(root, relativePath) {
  return readFile(resolveInside(root, relativePath), 'utf8');
}

export async function calculateCanonical(root, manifest) {
  const entries = [];
  const bodies = [];
  for (const declared of manifest.canonical_files ?? []) {
    const content = await readUtf8(root, declared.path);
    const normalized = normalizeContent(content);
    entries.push({ path: declared.path, sha256: sha256Normalized(normalized) });
    if (normalized.length >= DUPLICATE_BODY_MIN) {
      bodies.push({ path: declared.path, body: normalized.trim() });
    }
  }
  return { entries, bodies, protocolHash: protocolHash(entries) };
}

export async function updateManifest(root = process.cwd()) {
  const manifestFile = resolveInside(root, MANIFEST_PATH);
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  const calculated = await calculateCanonical(root, manifest);
  manifest.canonical_files = calculated.entries;
  manifest.protocol_hash = calculated.protocolHash;
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

export async function verifyRepository(root = process.cwd()) {
  const errors = [];
  let manifest;
  try {
    manifest = JSON.parse(await readUtf8(root, MANIFEST_PATH));
  } catch (error) {
    return {
      system: REQUIRED_SYSTEM,
      drift: true,
      status: 'BLOCKED',
      mismatches: [{ path: MANIFEST_PATH, reason: `manifest unreadable: ${error.message}` }],
    };
  }

  if (manifest.system !== REQUIRED_SYSTEM) {
    errors.push({ path: MANIFEST_PATH, reason: `system is ${manifest.system ?? 'missing'}` });
  }
  if (manifest.hash_algorithm !== REQUIRED_HASH_ALGORITHM) {
    errors.push({ path: MANIFEST_PATH, reason: `unsupported hash algorithm ${manifest.hash_algorithm ?? 'missing'}` });
  }
  if (!parseVersion(manifest.protocol_version)) {
    errors.push({ path: MANIFEST_PATH, reason: 'invalid protocol version' });
  }
  if (!parseVersion(manifest.bootstrap_schema_minimum)) {
    errors.push({ path: MANIFEST_PATH, reason: 'invalid bootstrap schema minimum' });
  }
  if (!Array.isArray(manifest.canonical_files) || manifest.canonical_files.length === 0) {
    errors.push({ path: MANIFEST_PATH, reason: 'canonical_files is empty' });
  }

  let calculated = { entries: [], bodies: [], protocolHash: '' };
  try {
    calculated = await calculateCanonical(root, manifest);
  } catch (error) {
    errors.push({ path: MANIFEST_PATH, reason: error.message });
  }

  const declared = new Map((manifest.canonical_files ?? []).map((entry) => [entry.path, entry.sha256]));
  for (const entry of calculated.entries) {
    if (declared.get(entry.path) !== entry.sha256) {
      errors.push({ path: entry.path, reason: `hash mismatch: expected ${declared.get(entry.path)}, got ${entry.sha256}` });
    }
  }
  if (manifest.protocol_hash !== calculated.protocolHash) {
    errors.push({ path: MANIFEST_PATH, reason: `protocol hash mismatch: expected ${manifest.protocol_hash}, got ${calculated.protocolHash}` });
  }

  const adapters = manifest.adapters ?? [];
  const adapterManifests = new Set();
  for (const adapter of adapters) {
    let content;
    try {
      content = normalizeContent(await readUtf8(root, adapter.path));
    } catch (error) {
      errors.push({ path: adapter.path, reason: `adapter unreadable: ${error.message}` });
      continue;
    }
    const schemaMatch = /BOOTSTRAP_SCHEMA:\s*`?([0-9]+\.[0-9]+\.[0-9]+)`?/i.exec(content);
    const manifestMatch = /CANONICAL_MANIFEST:\s*`?([^\s`]+)`?/i.exec(content);
    if (!schemaMatch || !versionAtLeast(schemaMatch[1], manifest.bootstrap_schema_minimum)) {
      errors.push({ path: adapter.path, reason: `bootstrap schema is missing or older than ${manifest.bootstrap_schema_minimum}` });
    }
    if (!manifestMatch) {
      errors.push({ path: adapter.path, reason: 'canonical manifest reference missing' });
    } else {
      adapterManifests.add(manifestMatch[1]);
      if (manifestMatch[1] !== MANIFEST_PATH) {
        errors.push({ path: adapter.path, reason: `references ${manifestMatch[1]} instead of ${MANIFEST_PATH}` });
      }
    }
    if (Buffer.byteLength(content, 'utf8') > ADAPTER_SIZE_LIMIT) {
      errors.push({ path: adapter.path, reason: `adapter exceeds ${ADAPTER_SIZE_LIMIT} bytes` });
    }
    for (const canonical of calculated.bodies) {
      if (content.includes(canonical.body)) {
        errors.push({ path: adapter.path, reason: `duplicates canonical body from ${canonical.path}` });
      }
    }
  }
  if (adapterManifests.size > 1) {
    errors.push({ path: MANIFEST_PATH, reason: `adapters reference different manifests: ${[...adapterManifests].join(', ')}` });
  }

  return {
    system: manifest.system ?? REQUIRED_SYSTEM,
    protocolVersion: manifest.protocol_version ?? null,
    protocolHash: calculated.protocolHash || null,
    bootstrapSchema: manifest.bootstrap_schema_minimum ?? null,
    canonicalFiles: calculated.entries.length,
    adapters: adapters.length,
    pendingProtectedAdapters: manifest.pending_protected_adapters ?? [],
    drift: errors.length > 0,
    status: errors.length > 0 ? 'BLOCKED' : 'PASS',
    mismatches: errors,
  };
}

function parseArgs(argv) {
  const rootIndex = argv.indexOf('--root');
  return {
    root: rootIndex >= 0 ? argv[rootIndex + 1] : process.cwd(),
    json: argv.includes('--json') || argv.includes('--startup'),
    update: argv.includes('--update-manifest'),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.update) await updateManifest(options.root);
  const result = await verifyRepository(options.root);
  let passed = 0;
  let failed = 0;
  if (result.drift) failed += 1;
  else passed += 1;
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.drift) {
    console.error(`DIVYESH V3: SYSTEM_DRIFT = BLOCKED (${result.mismatches.length} mismatch(es))`);
    for (const mismatch of result.mismatches) console.error(`- ${mismatch.path}: ${mismatch.reason}`);
  } else {
    console.log(`DIVYESH V3: PASS ${result.protocolVersion} ${result.protocolHash}`);
    console.log(`Canonical files: ${result.canonicalFiles}; active adapters: ${result.adapters}`);
    if (result.pendingProtectedAdapters.length > 0) {
      console.log(`Pending protected adapters: ${result.pendingProtectedAdapters.join(', ')}`);
    }
  }
  if (!options.json) {
    console.log(`${failed === 0 ? 'PASSED' : 'FAILED'}: ${passed} verification passed, ${failed} failed`);
  }
  process.exitCode = result.drift ? 1 : 0;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
