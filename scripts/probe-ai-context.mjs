#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'ai-context.mjs');
const TEMP_PARENT = path.resolve(tmpdir());
const FIXTURE_PREFIX = 'probe-ai-context-';
const FIXTURE_FILES = {
  'src/api/base44Client.js': 'export const base44Client = "fixture";\n',
  'worker/bulk-import.js': 'export const bulkImport = "fixture";\n',
  'src/lib/bulkHydrationService.js': 'export const bulkHydrationService = "fixture";\n',
  'src/lib/dbArchive.js': 'export const dbArchive = "fixture";\n',
  'src/lib/stats util.js': 'export const statsUtil = "fixture";\n',
};
const MAPPED_PATHS = ['worker/bulk-import.js', 'src/lib/bulkHydrationService.js', 'src/lib/dbArchive.js'];
const fixtureDirs = [];
let passed = 0;
let failed = 0;

function check(condition, label) {
  if (condition) { passed += 1; return; }
  failed += 1;
  console.error(`FAIL: ${label}`);
}

function childEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  return { ...env, ...extra };
}

function invokeContext(args, env) {
  return spawnSync(process.execPath, [SCRIPT, '--json', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
    env: env ?? childEnv(),
  });
}

function runContext(args, label) {
  const result = invokeContext(args);
  check(!result.error && !result.signal && result.status === 0,
    `ai-context exits 0 for ${label} (status ${result.status}, signal ${result.signal ?? 'none'}, error ${result.error?.code ?? 'none'}, stderr ${result.stderr})`);
  try { return JSON.parse(result.stdout); }
  catch (error) {
    check(false, `ai-context returns JSON for ${label}: ${error.message}`);
    return {};
  }
}

function runCheck(args, label, env) {
  const result = invokeContext(args, env);
  check(!result.error && !result.signal,
    `${label} runs without spawn error/signal (error ${result.error?.code ?? 'none'}, signal ${result.signal ?? 'none'}, status ${result.status})`);
  let json = null;
  if (typeof result.stdout === 'string' && result.stdout.trim().length > 0) {
    try { json = JSON.parse(result.stdout); }
    catch (error) { check(false, `${label} returns JSON: ${error.message}`); }
  } else {
    check(false, `${label} returns JSON: empty stdout`);
  }
  if (json) check(Array.isArray(json.decision?.blockers), `${label} exposes decision.blockers array`);
  return { result, json };
}

const packageJson = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
check(packageJson.scripts?.['ai:context'] === 'node scripts/ai-context.mjs', 'package.json exposes ai:context');
check(packageJson.scripts?.['ai:check'] === 'node scripts/ai-context.mjs --check --changed', 'package.json exposes ai:check');

const registry = JSON.parse(readFileSync(path.join(ROOT, 'docs/engineering/KNOWN_FAILURES.json'), 'utf8'));
check(registry.schema_version === 2, 'known-failure registry uses schema v2');
check(Array.isArray(registry.failures), 'known-failure registry has failures array');

const dashboard = runContext(['Dashboard YTD revenue'], 'Dashboard YTD revenue');
check(dashboard.schema_version === 2, 'context schema v2');
check(dashboard.v3?.status === 'PASS', 'V3 PASS');
check(dashboard.route_map?.status === 'PASS', 'repo map PASS');
check(dashboard.known_failure_registry?.status === 'PASS', 'known-failure registry PASS');
check(dashboard.areas?.some((area) => area.area === 'Revenue/KPIs'), 'Dashboard routes to Revenue/KPIs');
check(dashboard.proof_plan?.ordered?.some((command) => command.includes('probe-financial-invariant')), 'financial invariant in proof plan');
check(dashboard.proof_plan?.ordered?.includes('npm run typecheck'), 'typecheck in proof plan');
check(dashboard.handoff?.implementation_owner === 'Codex', 'Codex owns implementation');
check(dashboard.handoff?.verification_owner === 'Antigravity', 'Antigravity owns verification');

const auth = runContext(['src/lib/AuthContext.jsx'], 'AuthContext path');
check(auth.areas?.some((area) => area.area === 'Auth'), 'AuthContext routes to Auth');
check(auth.protected_query_matches?.includes('src/lib/AuthContext.jsx'), 'AuthContext identified as protected');
check(auth.risk?.level === 'PROTECTED', 'AuthContext raises PROTECTED risk');
check(auth.decision?.warnings?.some((warning) => warning.includes('protected files')), 'protected-file warning is explicit');

const actual = runCheck(['--check', '--base', 'origin/main', 'Dashboard YTD revenue'], 'post-edit check mode');
const actualStatus = actual.result.status;
check(actualStatus === 0 || actualStatus === 2,
  `post-edit check mode exits 0 or 2 (status ${actualStatus}, stderr ${actual.result.stderr})`);
if (actual.json) {
  const blockers = actual.json.decision?.blockers ?? [];
  const cleanReport = blockers.length === 0 && actual.json.decision?.status !== 'BLOCKED';
  const blockedReport = blockers.length > 0 && actual.json.decision?.status === 'BLOCKED';
  check((actualStatus === 0) === cleanReport,
    `exit 0 iff no blockers and non-BLOCKED (status ${actualStatus}, decision ${actual.json.decision?.status}, blockers ${JSON.stringify(blockers)})`);
  check((actualStatus === 2) === blockedReport,
    `exit 2 iff nonempty blockers and BLOCKED (status ${actualStatus}, decision ${actual.json.decision?.status}, blockers ${JSON.stringify(blockers)})`);
  check(actual.json.mode === 'check', 'check invocation enters check mode');
  check(Array.isArray(actual.json.changed_scope), 'check mode emits classified diff scope');
  check(Array.isArray(actual.json.handoff?.verify_commands), 'check mode emits handoff commands');
}

function makeFixture(name) {
  const dir = mkdtempSync(path.join(TEMP_PARENT, `${FIXTURE_PREFIX}${name}-`));
  fixtureDirs.push(dir);
  const env = childEnv({
    GIT_AUTHOR_NAME: 'Probe Fixture',
    GIT_AUTHOR_EMAIL: 'probe-fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Probe Fixture',
    GIT_COMMITTER_EMAIL: 'probe-fixture@example.invalid',
  });
  const git = (args, step) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', timeout: 30_000, env });
    const ok = !r.error && !r.signal && r.status === 0;
    check(ok, `fixture ${name} ${step} exits 0 (status ${r.status}, signal ${r.signal ?? 'none'}, error ${r.error?.code ?? 'none'}, stderr ${r.stderr})`);
    if (!ok) throw new Error(`fixture ${name} ${step} failed`);
    return r;
  };
  git(['init'], 'init');
  git(['config', 'user.name', 'Probe Fixture'], 'config identity');
  git(['config', 'user.email', 'probe-fixture@example.invalid'], 'config email');
  git(['config', 'core.autocrlf', 'false'], 'config autocrlf');
  git(['config', 'commit.gpgsign', 'false'], 'config gpgsign');

  for (const rel of Object.keys(FIXTURE_FILES)) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, FIXTURE_FILES[rel]);
  }
  git(['add', '-A'], 'add base files');
  git(['commit', '--allow-empty', '-m', 'probe fixture base'], 'base commit');
  git(['update-ref', 'refs/remotes/origin/main', 'HEAD'], 'origin/main ref');
  git(['checkout', '-b', 'probe/ai-context-fixture'], 'test branch');
  return {
    dir,
    git,
    write(rel, content) {
      const abs = path.join(dir, rel);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    },
    run(label) {
      return runCheck(['--check', '--base', 'origin/main', 'Dashboard YTD revenue'], label,
        childEnv({ GIT_DIR: path.join(dir, '.git'), GIT_WORK_TREE: dir }));
    },
  };
}

try {
  try {
    const clean = makeFixture('clean');
    const cleanRun = clean.run('clean fixture check');
    check(cleanRun.result.status === 0,
      `clean fixture exits 0 (status ${cleanRun.result.status}, stderr ${cleanRun.result.stderr})`);
    if (cleanRun.json) {
      const blockers = cleanRun.json.decision?.blockers ?? [];
      check(blockers.length === 0, `clean fixture has no blockers (got ${JSON.stringify(blockers)})`);
      check(cleanRun.json.decision?.status !== 'BLOCKED',
        `clean fixture decision non-BLOCKED (got ${cleanRun.json.decision?.status})`);
      check(cleanRun.json.mode === 'check', 'clean fixture enters check mode');
      check(Array.isArray(cleanRun.json.changed_scope) && cleanRun.json.changed_scope.length === 0,
        `clean fixture changed_scope empty (got ${JSON.stringify(cleanRun.json.changed_scope)})`);
    }
  } catch (error) {
    check(false, `clean fixture scenario aborted: ${error.message}`);
  }

  try {
    const protectedFixture = makeFixture('protected');
    protectedFixture.write('src/api/base44Client.js', 'export const base44Client = "dirty";\n');
    protectedFixture.git(['mv', 'src/lib/stats util.js', 'src/lib/stats util v2.js'], 'spaced rename');
    const protectedRun = protectedFixture.run('protected fixture check');
    check(protectedRun.result.status === 2,
      `protected fixture exits 2 (status ${protectedRun.result.status}, stderr ${protectedRun.result.stderr})`);
    if (protectedRun.json) {
      const blockers = protectedRun.json.decision?.blockers ?? [];
      check(blockers.length > 0, 'protected fixture reports blockers');
      check(protectedRun.json.decision?.status === 'BLOCKED',
        `protected fixture decision BLOCKED (got ${protectedRun.json.decision?.status})`);
      const protectedFiles = Array.isArray(protectedRun.json.protected_changed_files)
        ? protectedRun.json.protected_changed_files : [];
      check(protectedFiles.some((file) => String(file).toLowerCase() === 'src/api/base44client.js'),
        `protected_changed_files explicitly includes src/api/base44Client.js (got ${JSON.stringify(protectedFiles)})`);
      check(!protectedFiles.some((file) => String(file).toLowerCase() === 'rc/api/base44client.js'),
        `protected path not truncated to rc/api (got ${JSON.stringify(protectedFiles)})`);
      check(blockers.some((blocker) => /protected/i.test(blocker)
        && String(blocker).toLowerCase().includes('src/api/base44client.js')),
        `decision.blockers names protected change (got ${JSON.stringify(blockers)})`);
      const worktree = Array.isArray(protectedRun.json.git?.worktree) ? protectedRun.json.git.worktree : [];
      check(worktree.some((entry) => entry.path === 'src/api/base44Client.js' && entry.status === ' M'),
        `git.worktree carries raw src/api/base44Client.js with ' M' status (got ${JSON.stringify(worktree)})`);
      check(!worktree.some((entry) => entry.path === 'rc/api/base44Client.js'),
        'git.worktree has no rc/api truncation');
      check(worktree.some((entry) => entry.path === 'src/lib/stats util v2.js' && /^R/.test(String(entry.status))),
        `git.worktree shows rename destination with rename status (got ${JSON.stringify(worktree)})`);
      check(!worktree.some((entry) => entry.path === 'src/lib/stats util.js'),
        'git.worktree has no phantom rename source row');
    }
  } catch (error) {
    check(false, `protected fixture scenario aborted: ${error.message}`);
  }

  try {
    const mappedFixture = makeFixture('mapped');
    for (const rel of MAPPED_PATHS) {
      mappedFixture.write(rel, `export const changed = () => "${rel}";\n`);
      mappedFixture.git(['add', '--', rel], `stage ${rel}`);
      mappedFixture.git(['commit', '-m', `probe fixture mapped change ${rel}`], `commit ${rel}`);
      mappedFixture.write(rel, `export const changed = () => "${rel} dirty";\n`);
    }
    const mappedRun = mappedFixture.run('mapped fixture check');
    check(mappedRun.result.status === 2,
      `mapped fixture exits 2 (status ${mappedRun.result.status}, stderr ${mappedRun.result.stderr})`);
    if (mappedRun.json) {
      const blockers = mappedRun.json.decision?.blockers ?? [];
      check(blockers.length > 0, 'mapped fixture reports blockers');
      check(mappedRun.json.decision?.status === 'BLOCKED',
        `mapped fixture decision BLOCKED (got ${mappedRun.json.decision?.status})`);
      check(blockers.some((blocker) => blocker.includes('Mapped scope mismatch:')),
        `mapped fixture reports 'Mapped scope mismatch:' blocker (got ${JSON.stringify(blockers)})`);
      const changedScope = Array.isArray(mappedRun.json.changed_scope) ? mappedRun.json.changed_scope : [];
      const selected = Array.isArray(mappedRun.json.areas)
        ? mappedRun.json.areas.map((area) => area?.area).filter(Boolean) : [];
      const reportedRaw = Array.isArray(mappedRun.json.mapped_out_of_scope_changes)
        ? mappedRun.json.mapped_out_of_scope_changes : [];
      const reported = reportedRaw.map((entry) => (typeof entry === 'string' ? entry : entry?.path ?? entry?.file)).filter(Boolean);
      const scopeItems = changedScope.filter((item) => item && Array.isArray(item.areas));
      const changedPaths = changedScope.map((item) => String(item?.path ?? item?.file ?? '')).filter(Boolean);
      const selectedSet = new Set(selected.map((area) => String(area).toLowerCase()));
      const expectedOutOfScope = scopeItems
        .filter((item) => item.areas.length > 0
          && !item.areas.some((area) => selectedSet.has(String(area).toLowerCase())))
        .map((item) => String(item.path ?? item.file));
      const norm = (list) => list.map((value) => String(value).toLowerCase()).sort();
      check(changedPaths.length > 0 && scopeItems.length === changedPaths.length && selected.length > 0,
        `mapped fixture shapes usable (changed ${changedPaths.length}, scoped ${scopeItems.length}, selected ${selected.length})`);
      check(reportedRaw.length > 0 && reported.length === reportedRaw.length && expectedOutOfScope.length > 0
        && JSON.stringify(norm(reported)) === JSON.stringify(norm(expectedOutOfScope)),
        `mapped_out_of_scope_changes exactly equals derived set (reported ${JSON.stringify(reported)}, expected ${JSON.stringify(expectedOutOfScope)})`);
      check(reported.length > 0 && reported.every((path) => {
        const item = scopeItems.find((entry) => String(entry.path ?? entry.file).toLowerCase() === String(path).toLowerCase());
        return Boolean(item) && item.areas.length > 0
          && !item.areas.some((area) => selectedSet.has(String(area).toLowerCase()));
      }), 'every reported out-of-scope path has nonempty areas with no selected-area intersection');
      const fixtureReported = reported.filter((path) =>
        MAPPED_PATHS.some((rel) => rel.toLowerCase() === String(path).toLowerCase()));
      check(fixtureReported.length >= 1, `at least one fixture path out of scope (got ${JSON.stringify(fixtureReported)})`);
      for (const rel of MAPPED_PATHS) {
        check(changedPaths.some((path) => path.toLowerCase() === rel.toLowerCase()),
          `changed_scope retains fixture path ${rel}`);
      }
    }
  } catch (error) {
    check(false, `mapped fixture scenario aborted: ${error.message}`);
  }
  for (const scenario of ['staged-rename', 'committed-rename', 'committed-delete']) {
    try {
      const fixture = makeFixture(scenario);
      const original = 'src/api/base44Client.js';
      const destination = 'src/lib/unprotected-renamed-fixture.js';
      if (scenario === 'committed-delete') fixture.git(['rm', '--', original], 'remove protected original');
      else fixture.git(['mv', original, destination], 'rename protected original');
      if (scenario !== 'staged-rename') fixture.git(['commit', '-m', `probe ${scenario}`], 'commit protected change');
      const run = fixture.run(`${scenario} check`);
      check(!run.result.error && !run.result.signal && run.result.status === 2,
        `${scenario} protected change exits 2 (status ${run.result.status})`);
      check(Boolean(run.json), `${scenario} exposes required JSON`);
      if (!run.json) continue;
      check(run.json.decision?.status === 'BLOCKED', `${scenario} reports BLOCKED`);
      check(run.json.protected_changed_files?.includes(original), `${scenario} retains canonical protected original`);
      check(run.json.decision?.blockers?.some(blocker => /protected/i.test(blocker) && blocker.includes(original)),
        `${scenario} protected blocker names original`);
      check(run.json.git?.changed_files?.includes(original.toLowerCase()), `${scenario} classifies original touched path`);
      const worktree = run.json.git?.worktree;
      if (scenario === 'staged-rename') {
        check(Array.isArray(worktree) && worktree.length === 1
          && worktree[0].path === destination && worktree[0].originalPath === original && /^R/.test(worktree[0].status),
        'staged-rename keeps source and destination on one rename entry without phantom rows');
      } else {
        check(Array.isArray(worktree) && worktree.length === 0, `${scenario} worktree is clean`);
        check(run.json.git?.branch_diff_files?.includes(original), `${scenario} committed diff retains protected original`);
      }
      if (scenario !== 'committed-delete') {
        check(run.json.git?.changed_files?.includes(destination.toLowerCase()), `${scenario} classifies destination touched path`);
        if (scenario === 'committed-rename') check(run.json.git?.branch_diff_files?.includes(destination),
          'committed-rename diff retains destination');
      }
    } catch (error) {
      check(false, `${scenario} protection scenario aborted: ${error.message}`);
    }
  }
} finally {
  for (const dir of fixtureDirs) {
    const resolved = path.resolve(dir);
    const owned = resolved.startsWith(TEMP_PARENT + path.sep)
      && path.basename(resolved).startsWith(FIXTURE_PREFIX);
    if (!owned) { check(false, `fixture cleanup refuses unexpected target ${resolved}`); continue; }
    try { rmSync(resolved, { recursive: true, force: true, maxRetries: 3 }); }
    catch (error) { check(false, `fixture cleanup failed for ${resolved}: ${error.message}`); }
  }
}

if (failed === 0) console.log(`PASSED: probe-ai-context — ${passed} passed, 0 failed`);
else {
  console.error(`FAILED: probe-ai-context — ${passed} passed, ${failed} failed`);
  process.exitCode = 1;
}
