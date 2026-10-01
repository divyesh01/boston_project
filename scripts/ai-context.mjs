#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
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

function textLine(label, value) {
  console.log(`${label}: ${value}`);
}

function renderText(context) {
  console.log('AI CONTEXT');
  textLine('V3', `${context.v3.status}${context.v3.protocol_version ? ` ${context.v3.protocol_version}` : ''}`);
  textLine('BRANCH', context.git.branch);
  textLine('HEAD', context.git.head);
  textLine('WORKTREE', context.git.changes.length ? `${context.git.changes.length} tracked change(s)` : 'clean (tracked files)');
  textLine('QUERY', context.query || '(none)');

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

  console.log('\nKNOWN ACCEPTED FAILURES');
  if (!context.known_failures.length) console.log('- none registered');
  else {
    for (const failure of context.known_failures) {
      console.log(`- ${failure.id ?? failure.suite ?? 'unnamed'}: ${failure.suite ?? ''} ${failure.signature ?? ''}`.trim());
    }
  }

  console.log('\nFINISH');
  console.log('- Run the targeted gate first.');
  console.log('- Then use the applicable repository checks: npm run typecheck, npm run lint, npm test, npm run build.');
  console.log('- Keep the final diff focused and report exact observed results.');
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const jsonMode = rawArgs.includes('--json');
  const query = rawArgs.filter((arg) => arg !== '--json').join(' ').trim();

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

  const ranked = guideRows
    .map((row) => ({ row, score: scoreArea(row, query) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score);

  const bestScore = ranked[0]?.score ?? 0;
  const selectedRows = ranked
    .filter((entry) => entry.score >= Math.max(4, Math.ceil(bestScore * 0.55)))
    .slice(0, 3)
    .map((entry) => entry.row);

  const relevantMatrix = matrixRowsForAreas(matrixRows, selectedRows);
  const relevantContracts = contractRowsForAreas(contractRows, selectedRows, query);

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

  const statusRaw = git(['status', '--short', '--untracked-files=no'], '');
  const changes = statusRaw
    ? statusRaw.split(/\r?\n/).filter(Boolean).slice(0, 40)
    : [];

  const context = {
    query,
    v3: {
      status: v3.status,
      drift: v3.drift,
      protocol_version: v3.protocolVersion ?? null,
      protocol_hash: v3.protocolHash ?? null,
      mismatches: v3.mismatches ?? [],
    },
    git: {
      branch: git(['branch', '--show-current']),
      head: git(['rev-parse', '--short=12', 'HEAD']),
      changes,
      note: 'Tracked-file status only. This repository may live on a mount where git status over-reports timestamp-only changes.',
    },
    protected_query_matches: directProtectedMatches(query, protectedList),
    available_areas: guideRows.map((row) => row.Area),
    areas,
    known_failures: activeFailures(registry, selectedRows),
    sources: {
      guide: GUIDE_PATH,
      test_matrix: MATRIX_PATH,
      module_contracts: CONTRACTS_PATH,
      protected_files: PROTECTED_PATH,
      known_failures: KNOWN_FAILURES_PATH,
    },
    finish_checks: unique([
      ...areas.map((area) => area.gate).filter(Boolean),
      'npm run typecheck',
      'npm run lint',
      'npm test',
      'npm run build',
    ]),
  };

  if (jsonMode) console.log(JSON.stringify(context, null, 2));
  else renderText(context);

  if (v3.drift) {
    if (!jsonMode) {
      console.error('\nSYSTEM_DRIFT = BLOCKED');
      console.error('Fix DIVYESH V3 drift before substantive repository work.');
    }
    process.exitCode = 2;
  }
}

await main();
