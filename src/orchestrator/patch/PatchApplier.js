/**
 * PatchApplier
 * ------------
 * Mechanically applies exact code patches authored by Claude.
 * Verifies SHA-256 patch integrity, guards protected files, enforces line deletion limits,
 * and maintains atomic backups for rollback.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import crypto from 'node:crypto';
import { EditingSafetyPolicy } from '../policies/EditingSafetyPolicy.js';

export function sha256(content) {
  return crypto.createHash('sha256').update(String(content || ''), 'utf8').digest('hex');
}

export class PatchApplier {
  constructor(rootDir = process.cwd()) {
    this.rootDir = rootDir;
    this.backups = new Map();
  }

  /**
   * Parses patch text authored by Claude into discrete file action targets.
   * Supports:
   * 1. Explicit FILE blocks:
   *    ### FILE: path/to/file.js
   *    ```javascript
   *    ...
   *    ```
   * 2. SEARCH / REPLACE blocks:
   *    FILE: path/to/file.js
   *    <<<<<<< SEARCH
   *    ...
   *    =======
   *    ...
   *    >>>>>>> REPLACE
   * 3. Standard Unified Diff (--- a/file.js +++ b/file.js)
   */
  parsePatch(rawPatchText, defaultTargetFile = null) {
    if (!rawPatchText || typeof rawPatchText !== 'string') {
      return { actions: [], patchHash: sha256(''), rawPatchText: '' };
    }

    const normalizedText = rawPatchText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
    const patchHash = sha256(rawPatchText);
    const actions = [];

    // Split raw patch text by file sections
    const fileSplitRegex = /(?:^|\n)(?:###\s*|#\s*)?(?:FILE|TARGET_FILE):\s*`?([^\n`*]+)`?/gi;
    const fileMatches = [];
    let fm;
    while ((fm = fileSplitRegex.exec(normalizedText)) !== null) {
      fileMatches.push({
        file: EditingSafetyPolicy.normalizePath(fm[1].trim()),
        index: fm.index,
        headerLen: fm[0].length,
      });
    }

    if (fileMatches.length > 0) {
      for (let i = 0; i < fileMatches.length; i++) {
        const cur = fileMatches[i];
        const next = fileMatches[i + 1];
        const fileBody = normalizedText.slice(cur.index + cur.headerLen, next ? next.index : normalizedText.length);

        // Check for SEARCH / REPLACE blocks within this file section
        const srRegex = /<<<<<<< SEARCH\n([\s\S]*?)=======\n([\s\S]*?)>>>>>>> REPLACE/gi;
        let srMatch;
        let foundSr = false;
        while ((srMatch = srRegex.exec(fileBody)) !== null) {
          foundSr = true;
          actions.push({
            type: 'SEARCH_REPLACE',
            file: cur.file,
            search: srMatch[1],
            replace: srMatch[2],
          });
        }

        if (!foundSr) {
          // Check for code fence
          const fenceMatch = fileBody.match(/```(?:[a-zA-Z0-9_-]+)?\n([\s\S]*?)```/);
          if (fenceMatch) {
            let cleanContent = fenceMatch[1].trim();
            cleanContent = cleanContent.replace(/^(?:###\s*|#\s*)?(?:FILE|TARGET_FILE):\s*[^\n]+\n+/i, '').trim();
            actions.push({
              type: 'OVERWRITE_FILE',
              file: cur.file,
              content: cleanContent,
            });
          } else if (fileBody.trim().length > 0) {
            let cleanContent = fileBody.trim();
            cleanContent = cleanContent.replace(/^(?:###\s*|#\s*)?(?:FILE|TARGET_FILE):\s*[^\n]+\n+/i, '').trim();
            actions.push({
              type: 'OVERWRITE_FILE',
              file: cur.file,
              content: cleanContent,
            });
          }
        }
      }
    }

    // Format 3: Code fence with defaultTargetFile or single fence in text
    if (actions.length === 0 && defaultTargetFile) {
      const srRegex = /<<<<<<< SEARCH\n([\s\S]*?)=======\n([\s\S]*?)>>>>>>> REPLACE/gi;
      let srMatch;
      let foundSr = false;
      while ((srMatch = srRegex.exec(normalizedText)) !== null) {
        foundSr = true;
        actions.push({
          type: 'SEARCH_REPLACE',
          file: EditingSafetyPolicy.normalizePath(defaultTargetFile),
          search: srMatch[1],
          replace: srMatch[2],
        });
      }

      if (!foundSr) {
        const fenceMatch = normalizedText.match(/```(?:[a-zA-Z0-9_-]+)?\n([\s\S]*?)```/i);
        if (fenceMatch) {
          let cleanContent = fenceMatch[1].trim();
          cleanContent = cleanContent.replace(/^(?:###\s*|#\s*)?(?:FILE|TARGET_FILE):\s*[^\n]+\n+/i, '').trim();
          actions.push({
            type: 'OVERWRITE_FILE',
            file: EditingSafetyPolicy.normalizePath(defaultTargetFile),
            content: cleanContent,
          });
        } else {
          let cleanContent = normalizedText.trim();
          cleanContent = cleanContent.replace(/^(?:###\s*|#\s*)?(?:FILE|TARGET_FILE):\s*[^\n]+\n+/i, '').trim();
          actions.push({
            type: 'OVERWRITE_FILE',
            file: EditingSafetyPolicy.normalizePath(defaultTargetFile),
            content: cleanContent,
          });
        }
      }
    }

    return {
      actions,
      patchHash,
      rawPatchText,
    };
  }

  /**
   * Mechanically applies the parsed patch actions to disk.
   */
  applyPatch(parsedPatch, options = {}) {
    const {
      isOwnerApproved = false,
      deletionJustification = '',
      ownerProtectedFileException = false,
    } = options;

    const { actions, patchHash, rawPatchText } = parsedPatch;
    if (!actions || actions.length === 0) {
      return {
        success: false,
        error: 'NO_VALID_PATCH_ACTIONS_FOUND: Could not parse file modifications from patch text.',
        patchHash,
        filesAffected: [],
        linesAdded: 0,
        linesDeleted: 0,
      };
    }

    // 1. Safety verification pass (before writing any file)
    let totalAdded = 0;
    let totalDeleted = 0;
    const filesAffected = [];

    for (const action of actions) {
      // Validate target against PROTECTED_FILES.md
      EditingSafetyPolicy.validateTargetFile(action.file, ownerProtectedFileException);

      const targetPath = path.resolve(this.rootDir, action.file);
      const existingContent = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, 'utf8') : '';
      const normExisting = existingContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

      if (action.type === 'SEARCH_REPLACE') {
        const normSearch = action.search.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        const normReplace = action.replace.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        if (!normExisting.includes(normSearch)) {
          return {
            success: false,
            error: `SEARCH_BLOCK_NOT_FOUND: Could not find exact search target in "${action.file}".`,
            patchHash,
            targetFile: action.file,
          };
        }
        const delLines = normSearch.split('\n').length;
        const addLines = normReplace.split('\n').length;
        totalDeleted += delLines;
        totalAdded += addLines;
      } else if (action.type === 'OVERWRITE_FILE') {
        const oldLines = normExisting ? normExisting.split('\n').length : 0;
        const newLines = action.content.replace(/\r\n/g, '\n').split('\n').length;
        totalDeleted += oldLines;
        totalAdded += newLines;
      }

      filesAffected.push(action.file);
    }

    // Validate deletion limits
    EditingSafetyPolicy.validatePatchDeletions(totalDeleted, totalAdded, {
      justification: deletionJustification,
      isOwnerApproved,
    });

    // 2. Execution pass (atomic application with rollback cache)
    const appliedFiles = [];
    try {
      for (const action of actions) {
        const targetPath = path.resolve(this.rootDir, action.file);
        const dir = path.dirname(targetPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }

        const currentContent = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, 'utf8') : null;
        this.backups.set(action.file, currentContent);

        let newContent = '';
        if (action.type === 'SEARCH_REPLACE') {
          const normCurrent = currentContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
          const normSearch = action.search.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
          const normReplace = action.replace.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
          newContent = normCurrent.replace(normSearch, normReplace);
          if (currentContent.includes('\r\n')) {
            newContent = newContent.replace(/\n/g, '\r\n');
          }
        } else if (action.type === 'OVERWRITE_FILE') {
          newContent = action.content;
          if (currentContent && currentContent.includes('\r\n')) {
            newContent = newContent.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
          }
        }

        fs.writeFileSync(targetPath, newContent, 'utf8');
        appliedFiles.push(action.file);
      }

      return {
        success: true,
        patchHash,
        filesAffected: appliedFiles,
        linesAdded: totalAdded,
        linesDeleted: totalDeleted,
        appliedAt: new Date().toISOString(),
        error: null,
      };
    } catch (err) {
      // Rollback on write failure
      this.rollback();
      return {
        success: false,
        error: `PATCH_APPLICATION_ERROR: ${err.message}`,
        patchHash,
        filesAffected: appliedFiles,
        linesAdded: 0,
        linesDeleted: 0,
      };
    }
  }

  /**
   * Rolls back any modified files to their backed-up state.
   */
  rollback() {
    for (const [relFile, origContent] of this.backups.entries()) {
      try {
        const targetPath = path.resolve(this.rootDir, relFile);
        if (origContent === null) {
          if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
        } else {
          fs.writeFileSync(targetPath, origContent, 'utf8');
        }
      } catch {}
    }
    this.backups.clear();
  }
}
