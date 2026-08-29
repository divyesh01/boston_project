import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PatchApplier, sha256 } from '../../src/orchestrator/patch/PatchApplier.js';

describe('PatchApplier Suite', () => {
  let tmpDir;
  let applier;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-applier-test-'));
    applier = new PatchApplier(tmpDir);
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('computes exact SHA-256 hash of patch text', () => {
    const patch = 'FILE: src/test.js\n```javascript\nconsole.log(1);\n```';
    const hash = sha256(patch);
    const parsed = applier.parsePatch(patch);
    expect(parsed.patchHash).toBe(hash);
  });

  it('parses and applies full file overwrite patches', () => {
    const patch = `
FILE: src/demo.js
\`\`\`javascript
export const answer = 42;
\`\`\`
    `;
    const parsed = applier.parsePatch(patch);
    expect(parsed.actions.length).toBe(1);

    const result = applier.applyPatch(parsed);
    expect(result.success).toBe(true);
    expect(result.filesAffected).toContain('src/demo.js');

    const writtenContent = fs.readFileSync(path.join(tmpDir, 'src/demo.js'), 'utf8');
    expect(writtenContent.trim()).toBe('export const answer = 42;');
  });

  it('parses and applies SEARCH / REPLACE patches', () => {
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src/calc.js'), 'function add(a, b) {\n  return a - b;\n}\n', 'utf8');

    const patch = `
FILE: src/calc.js
<<<<<<< SEARCH
  return a - b;
=======
  return a + b;
>>>>>>> REPLACE
    `;
    const parsed = applier.parsePatch(patch);
    expect(parsed.actions.length).toBe(1);

    const result = applier.applyPatch(parsed);
    expect(result.success).toBe(true);

    const updated = fs.readFileSync(path.join(tmpDir, 'src/calc.js'), 'utf8');
    expect(updated).toContain('return a + b;');
    expect(updated).not.toContain('return a - b;');
  });

  it('fails safely if search target is not found in file', () => {
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src/calc.js'), 'const x = 1;\n', 'utf8');

    const patch = `
FILE: src/calc.js
<<<<<<< SEARCH
const missing = 999;
=======
const replacement = 1000;
>>>>>>> REPLACE
    `;
    const parsed = applier.parsePatch(patch);
    const result = applier.applyPatch(parsed);
    expect(result.success).toBe(false);
    expect(result.error).toContain('SEARCH_BLOCK_NOT_FOUND');
  });

  it('blocks modification of protected files even if in patch', () => {
    const patch = `
FILE: src/api/base44Client.js
\`\`\`javascript
export const malicious = true;
\`\`\`
    `;
    const parsed = applier.parsePatch(patch);
    expect(() => {
      applier.applyPatch(parsed);
    }).toThrowError(/PROTECTED_FILE_VIOLATION/);
  });
});
