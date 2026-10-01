#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { verifyRepository } from './verify-divyesh-v3.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GUIDE_PATH = 'docs/AI_REPO_GUIDE.md';
const MATRIX_PATH = 'docs/TEST_MATRIX.md';
const CONTRACTS_PATH = 'docs/MODULE_CONTRACTS.md';
const PROTECTED_PATH = 'PROTECTED_FILES.md';
const KNOWN_FAILURES_PATH = 'docs/engineering/KNOWN_FAILURES.json';
const MAP_GATE_PATH = 'scripts/verify-repo-map.mjs';
const DEFAULT_BASE = 'main';
const WIDE_FILE_COUNT = 8;

const AREA_ALIASES = Object.freeze({
  'HotelKey import': [
    'hotelkey', 'hotel key', 'import', 'upload', 'csv', 'report parser',
    'bulk import', 'ingestion', 'report upload', 'source report',
  ],
  'Revenue/KPIs': [
    'dashboard', 'revenue', 'kpi', 'adr', 'revpar', 'occupancy', 'money kept',
    'statistics', 'ytd', 'mtd', 'financial', 'reconciliation', 'aggregate',
  ],
  Transactions: [
    'transaction', 'transactions', 'ledger', 'dedupe', 'line item',
  ],
  'Property isolation': [
    'property isolation', 'tenant', 'tenancy', 'scope', 'property access',
    'cross property', 'authorization',
  ],
  'Business sync': [
    'business sync', 'sync', 'hydrate', 'hydration', 'bundle', 'migration',
    'snapshot', 'feed', 'startup data',
  ],
  Auth: [
    'auth', 'authentication', 'login', 'logout', 'password', 'session', 'mfa',
    'credential', 'account',
  ],
  IndexedDB: [
    'indexeddb', 'dexie', 'localdb', 'local db', 'browser cache', 'archive',
    'backup', 'offline',
  ],
  Payroll: [
    'payroll', 'employee', 'staff', 'timecard', 'labor', 'wage', 'shift',
  ],
  'Payments/refunds': [
    'payment', 'payments', 'refund', 'refunds', 'chargeback', 'card payment',
  ],
  Deployment: [
    'deploy', 'deployment', 'cloudflare', 'worker deploy', 'wrangler',
    'headers', 'vercel', 'build', 'production bundle',
  ],
});

function cleanCell(value) {
  return String(value ?? '').trim();
}

function splitTableRow(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|')) return [];
  return trimmed
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map(cleanCell);
}

function parseTable(source, headers) {
  const lines = source.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => {
    const cells = splitTableRow(line);
    return cells.length === headers.length && cells.every((cell, index) => cell === headers[index]);
  });
  if (headerIndex < 0) return [];

  const rows = [];
  for (let index = headerIndex + 2; index < lines.length; index += 1) {
    const cells = splitTableRow(lines[index]);
    if (cells.length !== headers.length) break;
    rows.push(Object.fromEntries(headers.map((header, cellIndex) => [header, cells[cellIndex]])));
  }
  return rows;
}

function tickValues(value) {
  const out = [];
  for (const match of String(value ?? '').matchAll(/`([^`]+)`/g)) out.push(match[1].trim());
  return out;
}

function normalize(value) {
  return String(value ?? '').toLowerCase().replace(/\\/g, '/').replace(/\s+/g, ' ').trim();
}

function queryTerms(query) {
  return [...new Set(
    normalize(query)
      .split(/[^a-z0-9_.\/-]+/)
      .map((term) => term.trim())
      .filter((term) => term.length >= 2),
  )];
}

function scoreArea(row, query) {
  const q = normalize(query);
  if (!q) return 0;

  const area = normalize(row.Area);
  const aliases = AREA_ALIASES[row.Area] ?? [];
  const haystack = normalize([
    row.Area,
    row['Read first'],
    row['Proves it'],
    row.Gate,
    aliases.join(' '),
  ].join(' '));

  let score = 0;
  if (q === area || q.includes(area)) score += 30;

  for (const alias of aliases) {
    const normalizedAlias = normalize(alias);
    if (q === normalizedAlias) score += 20;
    else if (q.includes(normalizedAlias)) score += 10;
  }

  for (const term of queryTerms(query)) {
    if (area.includes(term)) score += 7;
    if (aliases.some((alias) => normalize(alias).includes(term))) score += 5;
    if (haystack.includes(term)) score += 2;
  }

  for (const ref of [...tickValues(row['Read first']), ...tickValues(row['Proves it'])]) {
    const normalizedRef = normalize(ref);
    const withoutSymbol = normalizedRef.split('#')[0];
    const basename = path.posix.basename(withoutSymbol);
    if (q.includes(withoutSymbol) || q === basename || q.includes(basename)) score += 25;
  }

  return score;
}

function git(args, fallback = 'UNKNOWN') {
  try {
    const output = execFileSync('git', args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 8_000,
    }).trim();
    return output || fallback;
  } catch {
    return fallback;
  }
}



function gitLines(args) {
  const raw = git(args, '');
  return raw ? raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : [];
}

function refExists(ref) {
  if (!ref) return false;
  return git(['rev-parse', '--verify', '--quiet', ref], '') !== '';
}

function parseStatusLine(line) {
  if (!line || line.length < 4) return null;
  const status = line.slice(0, 2);
  const rawPath = line.slice(3).trim();
  const target = rawPath.includes(' -> ') ? rawPath.split(' -> ').at(-1) : rawPath;
  return { status, path: target.replace(/^"|"$/g, '') };
}

function worktreeChanges() {
  return gitLines(['status', '--porcelain=v1', '--untracked-files=all'])
    .map(parseStatusLine)
    .filter(Boolean);
}

function committedDiffPaths(baseRef) {
  if (!baseRef || !refExists(baseRef) || !refExists('HEAD')) return [];
  return gitLines(['diff', '--name-only', '--diff-filter=ACMR', `${baseRef}...HEAD`]);
}

function branchDivergence(baseRef) {
  if (!baseRef || !refExists(baseRef) || !refExists('HEAD')) {
    return { base: baseRef, ahead: null, behind: null, available: false };
  }
  const raw = git(['rev-list', '--left-right', '--count', `${baseRef}...HEAD`], '');
  const [behindRaw, aheadRaw] = raw.split(/\s+/);
  const behind = Number(behindRaw);
  const ahead = Number(aheadRaw);
  if (!Number.isFinite(ahead) || !Number.isFinite(behind)) {
    return { base: baseRef, ahead: null, behind: null, available: false };
  }
  return { base: baseRef, ahead, behind, available: true };
}

function mapCheck() {
  const result = spawnSync(process.execPath, [MAP_GATE_PATH], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 20_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
  return {
    status: result.status === 0 ? 'PASS' : 'FAIL',
    exit_code: result.status,
    summary: output.split(/\r?\n/).find((line) => /^(PASSED|FAILED):/.test(line))
      ?? output.split(/\r?\n/).filter(Boolean).at(-1)
      ?? '',
  };
}

function validateKnownFailures(registry, validAreas) {
  const problems = [];
  const active = [];
  if (registry.schema_version !== 2) problems.push('schema_version must be 2');
  if (!Array.isArray(registry.failures)) problems.push('failures must be an array');
  if (problems.length) return { status: 'FAIL', problems, active };

  const required = ['id', 'suite', 'signature', 'first_seen_commit', 'areas', 'accepted_by', 'reviewed_on', 'expires_on', 'issue', 'active'];
  const ids = new Set();
  const now = Date.now();

  for (const failure of registry.failures) {
    const label = failure?.id || '<missing-id>';
    for (const key of required) if (!(key in (failure ?? {}))) problems.push(`${label}: missing ${key}`);
    if (failure?.id) {
      if (ids.has(failure.id)) problems.push(`${label}: duplicate id`);
      ids.add(failure.id);
    }
    if (failure?.active !== true) continue;
    active.push(failure);
    if (!failure.suite || !existsSync(path.join(ROOT, String(failure.suite)))) problems.push(`${label}: suite does not exist`);
    if (!Array.isArray(failure.areas) || failure.areas.length === 0) problems.push(`${label}: active failure must name at least one area`);
    else for (const area of failure.areas) if (!validAreas.has(area)) problems.push(`${label}: unknown area ${area}`);
    if (!failure.signature || String(failure.signature).length < 8) problems.push(`${label}: signature is too weak`);
    for (const field of ['reviewed_on', 'expires_on']) {
      const parsed = Date.parse(failure[field]);
      if (!Number.isFinite(parsed)) problems.push(`${label}: ${field} is not a valid date`);
    }
    const expires = Date.parse(failure.expires_on);
    if (Number.isFinite(expires) && expires < now) problems.push(`${label}: waiver expired on ${failure.expires_on}`);
    if (!failure.accepted_by || String(failure.accepted_by).length < 2) problems.push(`${label}: accepted_by is missing`);
    if (!failure.issue || String(failure.issue).length < 2) problems.push(`${label}: issue is missing`);
  }

  return { status: problems.length ? 'FAIL' : 'PASS', problems, active };
}

function protectedPaths(source) {
  const out = new Set();
  for (const token of tickValues(source)) {
    if (!token.includes(' ') && (token.includes('/') || /\.[a-z0-9]+$/i.test(token))) out.add(token);
  }
  return [...out].sort();
}

function directProtectedMatches(query, paths) {
  const q = normalize(query);
  if (!q) return [];
  return paths.filter((item) => {
    const normalizedPath = normalize(item);
    const basename = path.posix.basename(normalizedPath);
    return q.includes(normalizedPath) || q === basename;
  });
}

function activeFailures(registry, areas) {
  const areaNames = new Set(areas.map((area) => area.Area));
  return (registry.failures ?? []).filter((failure) => {
    if (failure.active === false) return false;
    if (!Array.isArray(failure.areas) || failure.areas.length === 0 || areaNames.size === 0) return true;
    return failure.areas.some((area) => areaNames.has(area));
  });
}

function contractRowsForAreas(rows, areas, query) {
  const areaNames = new Set(areas.map((area) => area.Area));
  const q = normalize(query);
  return rows
    .filter((row) => areaNames.has(row.Area))
    .sort((left, right) => {
      const leftMatch = q && normalize(left.Module).includes(q) ? 1 : 0;
      const rightMatch = q && normalize(right.Module).includes(q) ? 1 : 0;
      if (leftMatch !== rightMatch) return rightMatch - leftMatch;
      const riskOrder = { PROTECTED: 0, HIGH: 1, NORMAL: 2, LOW: 3 };
      return (riskOrder[left.Risk] ?? 9) - (riskOrder[right.Risk] ?? 9);
    })
    .slice(0, 8);
}

function matrixRowsForAreas(rows, areas) {
  const areaNames = new Set(areas.map((area) => area.Area));
  return rows.filter((row) => areaNames.has(row.Area));
}

function unique(values) {
  return [...new Set(values)];
}


function stripSymbol(value) {
  return String(value ?? '').split('#')[0];
}

function normalizePath(value) {
  return stripSymbol(normalize(value)).replace(/^\.\//, '');
}

function modulePath(row) {
  return normalizePath(tickValues(row.Module)[0] ?? row.Module);
}

function classifyChangedPath(file, guideRows, contractRows, matrixRows) {
  const p = normalizePath(file);
  const areas = new Set();
  const reasons = [];
  for (const row of guideRows) {
    if (tickValues(row['Read first']).map(normalizePath).includes(p)) {
      areas.add(row.Area);
      reasons.push(`Read first: ${row.Area}`);
    }
  }
  for (const row of contractRows) {
    if (modulePath(row) === p) {
      areas.add(row.Area);
      reasons.push(`Contract ${cleanCell(row.Risk).toUpperCase()}: ${row.Area}`);
    }
  }
  for (const row of matrixRows) {
    if (normalizePath(tickValues(row.Suite)[0] ?? row.Suite) === p) {
      areas.add(row.Area);
      reasons.push(`Test: ${row.Area}`);
    }
  }
  const documentation = p.endsWith('.md') || p.startsWith('docs/');
  return { path: p, areas: [...areas], reasons, documentation };
}

function touchedContracts(rows, changedPaths) {
  const changed = new Set(changedPaths.map(normalizePath));
  return rows
    .filter((row) => changed.has(modulePath(row)))
    .map((row) => ({
      module: tickValues(row.Module)[0] ?? row.Module,
      path: modulePath(row),
      invariant: row.Invariant,
      risk: cleanCell(row.Risk).toUpperCase(),
      area: row.Area,
    }));
}

function buildProofPlan(areas, riskLevel, checkMode) {
  const targeted = unique([
    ...areas.map((area) => area.gate).filter(Boolean),
    ...areas.flatMap((area) => area.tests.slice(0, riskLevel === 'HIGH' || riskLevel === 'PROTECTED' ? 3 : 2).map((test) => test.command)),
  ]);
  const regression = ['npm run typecheck', 'npm run lint'];
  if (checkMode || riskLevel === 'HIGH' || riskLevel === 'PROTECTED') regression.push('npm test', 'npm run build');
  if (checkMode && (riskLevel === 'HIGH' || areas.length > 1)) regression.push('npm run verify:all');
  return { targeted, regression: unique(regression), ordered: unique([...targeted, ...regression]) };
}

function textLine(label, value) {
  console.log(`${label}: ${value}`);
}

function renderText(context) {
  console.log('AI CHANGE CONTROL');
  textLine('DECISION', context.decision.status);
  textLine('MODE', context.mode.toUpperCase());
  textLine('RISK', `${context.risk.level} (${context.risk.score})`);
  textLine('V3', `${context.v3.status}${context.v3.protocol_version ? ` ${context.v3.protocol_version}` : ''}`);
  textLine('ROUTE MAP', context.route_map.status);
  textLine('KNOWN FAILURE REGISTRY', context.known_failure_registry.status);
  textLine('BRANCH', context.git.branch);
  textLine('HEAD', context.git.head);
  textLine('BASE', context.git.divergence.available ? `${context.git.divergence.base} (ahead ${context.git.divergence.ahead}, behind ${context.git.divergence.behind})` : `${context.git.divergence.base} (unavailable locally)`);
  textLine('CHANGED FILES', context.git.changed_files.length);
  textLine('QUERY', context.query || '(none — inferred from diff when possible)');

  if (context.decision.blockers.length) {
    console.log('\nBLOCKERS');
    for (const item of context.decision.blockers) console.log(`- ${item}`);
  }
  if (context.decision.warnings.length) {
    console.log('\nWARNINGS');
    for (const item of context.decision.warnings) console.log(`- ${item}`);
  }

  if (context.protected_query_matches.length) {
    console.log('\nPROTECTED QUERY MATCH');
    for (const item of context.protected_query_matches) console.log(`- ${item}`);
    console.log('Owner authorization is required for a protected-file edit in the current task.');
  }

  if (!context.areas.length) {
    console.log('\nMATCHED AREA');
    console.log('- No confident subsystem match. Use one of:');
    for (const area of context.available_areas) console.log(`  - ${area}`);
    console.log('\nTry: npm run ai:context -- "Dashboard YTD revenue"');
  } else {
    console.log('\nMATCHED AREA');
    for (const area of context.areas) {
      console.log(`\n[${area.area}]`);
      console.log('Read first:');
      for (const item of area.read_first) console.log(`- ${item}`);
      console.log(`Primary gate: ${area.gate || 'not mapped'}`);

      if (area.never_touch.length) {
        console.log('Never touch without current-task owner authority:');
        for (const item of area.never_touch) console.log(`- ${item}`);
      }

      console.log('Relevant checks:');
      for (const test of area.tests) console.log(`- ${test.command}  # ${test.suite}`);

      if (area.contracts.length) {
        console.log('Module contracts:');
        for (const contract of area.contracts) {
          console.log(`- [${contract.risk}] ${contract.module} — ${contract.invariant}`);
        }
      }
    }
  }

  if (context.git.changed_files.length) {
    console.log('\nDIFF SCOPE');
    for (const item of context.changed_scope) {
      const suffix = item.areas.length ? ` -> ${item.areas.join(', ')}` : item.documentation ? ' -> documentation/governance' : ' -> unmapped';
      console.log(`- ${item.path}${suffix}`);
    }
  }

  console.log('\nPROOF PLAN');
  context.proof_plan.ordered.forEach((command, index) => console.log(`${index + 1}. ${command}`));

  console.log('\nKNOWN ACCEPTED FAILURES');
  if (!context.known_failures.length) console.log('- none registered');
  else {
    for (const failure of context.known_failures) {
      console.log(`- ${failure.id ?? failure.suite ?? 'unnamed'}: ${failure.suite ?? ''} ${failure.signature ?? ''}`.trim());
    }
  }

  console.log('\nCODEX -> ANTIGRAVITY HANDOFF');
  console.log(`Branch/commit: ${context.handoff.branch} @ ${context.handoff.head}`);
  console.log(`Areas: ${context.handoff.areas.join(', ') || 'unmapped'}`);
  console.log(`Risk: ${context.handoff.risk}`);
  console.log(`Changed: ${context.handoff.changed_files.join(', ') || '(none yet)'}`);
  console.log('Verify:');
  for (const command of context.handoff.verify_commands) console.log(`- ${command}`);
  console.log('Expected: no new failures; only active, valid, explicitly registered pre-existing failures may be carried.');
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const jsonMode = rawArgs.includes('--json');
  const checkMode = rawArgs.includes('--check');
  const changedMode = checkMode || rawArgs.includes('--changed');
  const baseIndex = rawArgs.indexOf('--base');
  const baseRef = baseIndex >= 0 ? (rawArgs[baseIndex + 1] ?? DEFAULT_BASE) : DEFAULT_BASE;
  const query = rawArgs
    .filter((arg, index) => !['--json', '--check', '--changed'].includes(arg) && index !== baseIndex && index !== baseIndex + 1)
    .join(' ')
    .trim();

  const [guideSource, matrixSource, contractsSource, protectedSource, registrySource, v3] = await Promise.all([
    readFile(path.join(ROOT, GUIDE_PATH), 'utf8'),
    readFile(path.join(ROOT, MATRIX_PATH), 'utf8'),
    readFile(path.join(ROOT, CONTRACTS_PATH), 'utf8'),
    readFile(path.join(ROOT, PROTECTED_PATH), 'utf8'),
    readFile(path.join(ROOT, KNOWN_FAILURES_PATH), 'utf8'),
    verifyRepository(ROOT),
  ]);

  const guideRows = parseTable(guideSource, ['Area', 'Read first', 'Proves it', 'Gate', 'Never touch']);
  const matrixRows = parseTable(matrixSource, ['Area', 'Suite', 'Kind', 'Command']);
  const contractRows = parseTable(contractsSource, ['Module', 'Invariant', 'Risk', 'Area']);
  const protectedList = protectedPaths(protectedSource);
  const registry = JSON.parse(registrySource);
  const routeMap = mapCheck();
  const validAreas = new Set(guideRows.map((row) => row.Area));
  const registryValidation = validateKnownFailures(registry, validAreas);

  const worktree = worktreeChanges();
  const branchDiff = changedMode ? committedDiffPaths(baseRef) : [];
  const changedFiles = unique([...worktree.map((entry) => entry.path), ...branchDiff].map(normalizePath)).filter(Boolean);
  const routingQuery = [query, ...changedFiles].filter(Boolean).join(' ');

  const ranked = guideRows
    .map((row) => ({ row, score: scoreArea(row, routingQuery) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score);

  const bestScore = ranked[0]?.score ?? 0;
  const selectedRows = ranked
    .filter((entry) => entry.score >= Math.max(4, Math.ceil(bestScore * 0.55)))
    .slice(0, 3)
    .map((entry) => entry.row);

  const relevantMatrix = matrixRowsForAreas(matrixRows, selectedRows);
  const relevantContracts = contractRowsForAreas(contractRows, selectedRows, routingQuery);

  const areas = selectedRows.map((row) => ({
    area: row.Area,
    read_first: tickValues(row['Read first']),
    gate: tickValues(row.Gate)[0] ?? '',
    never_touch: tickValues(row['Never touch']),
    tests: relevantMatrix
      .filter((test) => test.Area === row.Area)
      .map((test) => ({
        suite: tickValues(test.Suite)[0] ?? test.Suite,
        kind: cleanCell(test.Kind),
        command: tickValues(test.Command)[0] ?? test.Command,
      })),
    contracts: relevantContracts
      .filter((contract) => contract.Area === row.Area)
      .map((contract) => ({
        module: tickValues(contract.Module)[0] ?? contract.Module,
        invariant: contract.Invariant,
        risk: cleanCell(contract.Risk),
      })),
  }));

  const protectedQueryMatches = directProtectedMatches(query, protectedList);
  const protectedChangedFiles = changedFiles.filter((file) => protectedList.includes(normalizePath(file)));
  const changedScope = changedFiles.map((file) => classifyChangedPath(file, guideRows, contractRows, matrixRows));
  const selectedAreaSet = new Set(selectedRows.map((row) => row.Area));
  const mappedOutOfScope = changedScope.filter((item) => item.areas.length && !item.areas.some((area) => selectedAreaSet.has(area)));
  const unmappedChanges = changedScope.filter((item) => !item.areas.length && !item.documentation);
  const touched = touchedContracts(contractRows, changedFiles);
  const divergence = branchDivergence(baseRef);
  const branch = git(['branch', '--show-current'], 'DETACHED');

  const blockers = [];
  const warnings = [];
  if (v3.drift) blockers.push('DIVYESH V3 drift detected.');
  if (routeMap.status !== 'PASS') blockers.push(`Repo routing map failed: ${routeMap.summary || 'unknown failure'}`);
  if (registryValidation.status !== 'PASS') blockers.push(`Known-failure registry invalid: ${registryValidation.problems.join('; ')}`);
  if (checkMode && protectedChangedFiles.length) blockers.push(`Protected files changed: ${protectedChangedFiles.join(', ')}; owner-authorization review required.`);
  if (checkMode && query && mappedOutOfScope.length) blockers.push(`Mapped scope mismatch: ${mappedOutOfScope.map((item) => `${item.path} -> ${item.areas.join('/')}`).join(', ')}`);
  if (checkMode && branch === 'main' && changedFiles.length) blockers.push('Post-edit check is running on main with changes.');
  if (checkMode && divergence.available && divergence.behind > 0) blockers.push(`Branch is ${divergence.behind} commit(s) behind ${baseRef}.`);
  if (!selectedRows.length) warnings.push('No confident subsystem route. Name a subsystem or concrete file before editing.');
  if (selectedRows.length > 2) warnings.push(`Task spans ${selectedRows.length} mapped areas; split it unless cross-domain scope is intentional.`);
  if (changedFiles.length > WIDE_FILE_COUNT) warnings.push(`Wide diff: ${changedFiles.length} files changed; review for scope creep.`);
  if (unmappedChanges.length) warnings.push(`Unmapped changed files: ${unmappedChanges.map((item) => item.path).join(', ')}`);
  if (protectedQueryMatches.length) warnings.push(`Task text names protected files: ${protectedQueryMatches.join(', ')}; editing requires explicit current-task owner authority.`);
  if (!checkMode && divergence.available && divergence.behind > 0) warnings.push(`Branch is ${divergence.behind} commit(s) behind ${baseRef}.`);

  const protectedTouched = touched.filter((item) => item.risk === 'PROTECTED');
  const highTouched = touched.filter((item) => item.risk === 'HIGH');
  let riskScore = blockers.length ? 100 : 0;
  if (protectedQueryMatches.length || protectedTouched.length) riskScore += 100;
  riskScore += Math.min(75, highTouched.length * 25);
  if (selectedRows.length > 1) riskScore += 15;
  if (changedFiles.length > WIDE_FILE_COUNT) riskScore += 15;
  const riskLevel = protectedQueryMatches.length || protectedTouched.length ? 'PROTECTED'
    : riskScore >= 40 ? 'HIGH'
    : riskScore >= 20 ? 'MODERATE'
    : 'NORMAL';

  const proofPlan = buildProofPlan(areas, riskLevel, checkMode);
  const knownFailures = activeFailures({ failures: registryValidation.active }, selectedRows);

  const context = {
    schema_version: 2,
    mode: checkMode ? 'check' : changedMode ? 'context+diff' : 'context',
    query,
    decision: {
      status: blockers.length ? 'BLOCKED' : warnings.length ? 'READY_WITH_WARNINGS' : 'READY',
      blockers,
      warnings,
    },
    risk: {
      level: riskLevel,
      score: riskScore,
      protected_touched: protectedTouched,
      high_touched: highTouched,
    },
    v3: {
      status: v3.status,
      drift: v3.drift,
      protocol_version: v3.protocolVersion ?? null,
      protocol_hash: v3.protocolHash ?? null,
      mismatches: v3.mismatches ?? [],
    },
    route_map: routeMap,
    known_failure_registry: {
      status: registryValidation.status,
      problems: registryValidation.problems,
      active_count: registryValidation.active.length,
    },
    git: {
      branch,
      head: git(['rev-parse', '--short=12', 'HEAD']),
      divergence,
      worktree,
      branch_diff_files: branchDiff,
      changed_files: changedFiles,
    },
    protected_query_matches: protectedQueryMatches,
    protected_changed_files: protectedChangedFiles,
    changed_scope: changedScope,
    mapped_out_of_scope_changes: mappedOutOfScope,
    unmapped_changes: unmappedChanges,
    touched_contracts: touched,
    available_areas: guideRows.map((row) => row.Area),
    areas,
    proof_plan: proofPlan,
    known_failures: knownFailures,
    handoff: {
      implementation_owner: 'Codex',
      verification_owner: 'Antigravity',
      branch,
      head: git(['rev-parse', '--short=12', 'HEAD']),
      base: baseRef,
      changed_files: changedFiles,
      areas: selectedRows.map((row) => row.Area),
      risk: riskLevel,
      invariants: touched.map((item) => `${item.module}: ${item.invariant}`),
      verify_commands: proofPlan.ordered,
      known_failures: knownFailures.map((failure) => ({ id: failure.id, suite: failure.suite, signature: failure.signature })),
      expected_result: 'No new failures; carry only active, valid, explicitly registered pre-existing failures.',
    },
    sources: {
      guide: GUIDE_PATH,
      test_matrix: MATRIX_PATH,
      module_contracts: CONTRACTS_PATH,
      protected_files: PROTECTED_PATH,
      known_failures: KNOWN_FAILURES_PATH,
    },
    finish_checks: proofPlan.ordered,
  };

  if (jsonMode) console.log(JSON.stringify(context, null, 2));
  else renderText(context);

  if (context.decision.blockers.length) process.exitCode = 2;
}

await main();
