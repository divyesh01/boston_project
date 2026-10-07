import assert from 'node:assert/strict';
import { parsePorcelainZ, parseNameStatusZ } from '../scripts/ai-context.mjs';

let passed = 0;
let failed = 0;

function runCheck(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failed++;
    console.error(`FAILED: ${name}`);
    console.error(err);
  }
}

// 1. Exact baseline pipeline deficiency proving the fixed-XY shift defect
runCheck('Baseline pipeline demonstrates fixed-XY shift and corrupts status/path', () => {
  const raw = ' M src/api/base44Client.js\n';
  const lines = raw.trim().split(/\r?\n/).map(line => line.trim());
  const entries = lines.map(line => ({
    status: line.slice(0, 2),
    rawPath: line.slice(3).trim()
  }));

  assert.deepStrictEqual(entries, [
    { status: 'M ', rawPath: 'rc/api/base44Client.js' }
  ]);
});

// 2. parsePorcelainZ resolves unstaged modified status with leading space
runCheck('parsePorcelainZ preserves leading-space status and path', () => {
  const result = parsePorcelainZ(' M src/api/base44Client.js\0');
  assert.deepStrictEqual(result, [
    { status: ' M', path: 'src/api/base44Client.js' }
  ]);
});

// 3. Staged / unstaged added, modified, deleted, untracked
runCheck('parsePorcelainZ handles added, modified, deleted, and untracked entries', () => {
  const raw = [
    'A  src/staged-add.js',
    ' M src/unstaged-mod.js',
    'M  src/staged-mod.js',
    'MM src/both-mod.js',
    ' D src/unstaged-del.js',
    'D  src/staged-del.js',
    '?? src/untracked.js'
  ].join('\0') + '\0';

  const result = parsePorcelainZ(raw);
  assert.deepStrictEqual(result, [
    { status: 'A ', path: 'src/staged-add.js' },
    { status: ' M', path: 'src/unstaged-mod.js' },
    { status: 'M ', path: 'src/staged-mod.js' },
    { status: 'MM', path: 'src/both-mod.js' },
    { status: ' D', path: 'src/unstaged-del.js' },
    { status: 'D ', path: 'src/staged-del.js' },
    { status: '??', path: 'src/untracked.js' }
  ]);
});

// 4. Preserves leading and trailing path spaces without trim side effects
runCheck('parsePorcelainZ preserves leading and trailing spaces in path', () => {
  const raw = ' M   path/with spaces/file.js  \0';
  const result = parsePorcelainZ(raw);
  assert.deepStrictEqual(result, [
    { status: ' M', path: '  path/with spaces/file.js  ' }
  ]);
});

// 5. Special characters: quotes, arrows, newlines, backslashes, Unicode
runCheck('parsePorcelainZ preserves quotes, arrows, newlines, backslashes, and Unicode', () => {
  const raw = [
    '?? "quoted_file".js',
    '?? file -> target.js',
    '?? file\nwith\nnewline.js',
    '?? path\\with\\backslash.js',
    '?? 🚀_unicode_日本語_файл.txt'
  ].join('\0') + '\0';

  const result = parsePorcelainZ(raw);
  assert.deepStrictEqual(result, [
    { status: '??', path: '"quoted_file".js' },
    { status: '??', path: 'file -> target.js' },
    { status: '??', path: 'file\nwith\nnewline.js' },
    { status: '??', path: 'path\\with\\backslash.js' },
    { status: '??', path: '🚀_unicode_日本語_файл.txt' }
  ]);
});

// 6. Rename/copy destination and source tokens consumed without phantom rows
runCheck('parsePorcelainZ consumes rename/copy source tokens without phantom rows', () => {
  const raw = 'R  dest-rename.js\0src-rename.js\0C  dest-copy.js\0src-copy.js\0';
  const result = parsePorcelainZ(raw);
  assert.deepStrictEqual(result, [
    { status: 'R ', path: 'dest-rename.js', originalPath: 'src-rename.js' },
    { status: 'C ', path: 'dest-copy.js', originalPath: 'src-copy.js' }
  ]);
});

// 7. Modified record immediately following rename/copy still appears
runCheck('parsePorcelainZ parses record immediately following rename/copy', () => {
  const raw = 'R  dest.js\0orig.js\0 M next-modified.js\0';
  const result = parsePorcelainZ(raw);
  assert.deepStrictEqual(result, [
    { status: 'R ', path: 'dest.js', originalPath: 'orig.js' },
    { status: ' M', path: 'next-modified.js' }
  ]);
});

// 8. Multiple records and empty / falsy raw inputs
runCheck('parsePorcelainZ handles empty or falsy inputs and returns empty array', () => {
  assert.deepStrictEqual(parsePorcelainZ(''), []);
  assert.deepStrictEqual(parsePorcelainZ(null), []);
  assert.deepStrictEqual(parsePorcelainZ(undefined), []);
});

runCheck('parsePorcelainZ retains protected rename source in the same entry', () => {
  assert.deepStrictEqual(parsePorcelainZ('R  src/lib/unprotected.js\0src/api/base44Client.js\0'), [
    { status: 'R ', path: 'src/lib/unprotected.js', originalPath: 'src/api/base44Client.js' }
  ]);
});

runCheck('parseNameStatusZ retains ordinary additions, modifications, deletions and type changes', () => {
  assert.deepStrictEqual(parseNameStatusZ('A\0added.js\0M\0modified.js\0D\0src/api/base44Client.js\0T\0type.js\0'),
    ['added.js', 'modified.js', 'src/api/base44Client.js', 'type.js']);
});

runCheck('parseNameStatusZ retains rename and copy sources and destinations without consuming following record', () => {
  assert.deepStrictEqual(parseNameStatusZ('R100\0src/api/base44Client.js\0dest.js\0C050\0copy-src.js\0copy-dest.js\0M\0next.js\0'),
    ['src/api/base44Client.js', 'dest.js', 'copy-src.js', 'copy-dest.js', 'next.js']);
});

runCheck('parseNameStatusZ preserves literal whitespace, quotes, Unicode and newlines', () => {
  assert.deepStrictEqual(parseNameStatusZ('R100\0  日本語 "original"\n.js  \0 dest -> file.js \0D\0deleted\nfile.js\0'),
    ['  日本語 "original"\n.js  ', ' dest -> file.js ', 'deleted\nfile.js']);
});

runCheck('parseNameStatusZ accepts empty and falsy inputs', () => {
  assert.deepStrictEqual(parseNameStatusZ(''), []);
  assert.deepStrictEqual(parseNameStatusZ(null), []);
  assert.deepStrictEqual(parseNameStatusZ(undefined), []);
});

if (failed > 0) {
  console.error(`FAILED: probe-ai-context-porcelain — ${failed} failed`);
  process.exit(1);
}
console.log(`PASSED: probe-ai-context-porcelain — ${passed} passed, 0 failed`);
