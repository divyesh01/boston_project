/**
 * ContextGatherer
 * ---------------
 * Gathers deterministic repository context (files, imports, callers, schemas, tests, git diff)
 * without consuming any LLM tokens. Applies automated secret & PII redaction.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execSync } from 'node:child_process';
import { redactSecrets } from '../policies/SecretRedactor.js';

export class ContextGatherer {
  constructor(rootDir = process.cwd()) {
    this.rootDir = rootDir;
  }

  /**
   * Deterministically reads file content relative to repo root.
   */
  readFile(relativePath) {
    try {
      const fullPath = path.resolve(this.rootDir, relativePath);
      if (!fs.existsSync(fullPath)) return null;
      const content = fs.readFileSync(fullPath, 'utf8');
      return redactSecrets(content);
    } catch {
      return null;
    }
  }

  /**
   * Finds caller files that import a given module name or path.
   */
  findCallers(moduleName, maxCallers = 10) {
    const callers = [];
    try {
      const srcDir = path.resolve(this.rootDir, 'src');
      if (fs.existsSync(srcDir)) {
        const files = this._getFilesRecursive(srcDir, ['.js', '.jsx', '.ts', '.tsx']);
        const searchPattern = new RegExp(`from\\s+['"][^'"]*${moduleName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^'"]*['"]|import\\s*\\(['"][^'"]*${moduleName}[^'"]*['"]\\)`, 'i');
        for (const f of files) {
          try {
            const code = fs.readFileSync(f, 'utf8');
            if (searchPattern.test(code)) {
              callers.push(path.relative(this.rootDir, f).replace(/\\/g, '/'));
              if (callers.length >= maxCallers) break;
            }
          } catch {}
        }
      }
    } catch {}
    return callers;
  }

  /**
   * Gathers current Git status and diff without destructive actions.
   */
  getGitStatus() {
    try {
      const status = execSync('git status --short', { cwd: this.rootDir, encoding: 'utf8' }).trim();
      const diffStat = execSync('git diff --stat', { cwd: this.rootDir, encoding: 'utf8' }).trim();
      return {
        status: redactSecrets(status),
        diffStat: redactSecrets(diffStat),
      };
    } catch {
      return { status: 'UNKNOWN', diffStat: '' };
    }
  }

  /**
   * Gathers comprehensive deterministic context bundle for a task.
   */
  gatherContext(targetFiles = [], taskDescription = '') {
    const filesContext = [];

    for (const relPath of targetFiles) {
      const content = this.readFile(relPath);
      if (content !== null) {
        filesContext.push({
          path: relPath,
          content,
          lines: content.split('\n').length,
          callers: this.findCallers(path.basename(relPath, path.extname(relPath))),
        });
      }
    }

    const git = this.getGitStatus();

    let contextText = `=== REPOSITORY BASELINE & CONTEXT ===\n`;
    contextText += `Git Status:\n${git.status || 'Clean working tree'}\n\n`;
    if (git.diffStat) {
      contextText += `Current Uncommitted Diff Stat:\n${git.diffStat}\n\n`;
    }

    contextText += `=== TARGET FILE IMPLEMENTATIONS ===\n`;
    for (const f of filesContext) {
      contextText += `--- File: ${f.path} (${f.lines} lines) ---\n`;
      if (f.callers.length > 0) {
        contextText += `Known Callers: ${f.callers.join(', ')}\n`;
      }
      contextText += `${f.content}\n\n`;
    }

    return {
      text: redactSecrets(contextText),
      files: filesContext,
      git,
    };
  }

  _getFilesRecursive(dir, extensions) {
    let results = [];
    if (!fs.existsSync(dir)) return results;
    const list = fs.readdirSync(dir, { withFileTypes: true });
    for (const item of list) {
      const fullPath = path.resolve(dir, item.name);
      if (item.isDirectory()) {
        if (item.name !== 'node_modules' && item.name !== '.git' && item.name !== 'dist') {
          results = results.concat(this._getFilesRecursive(fullPath, extensions));
        }
      } else {
        const ext = path.extname(item.name).toLowerCase();
        if (extensions.includes(ext)) {
          results.push(fullPath);
        }
      }
    }
    return results;
  }
}
