/**
 * EditingSafetyPolicy
 * -------------------
 * Enforces repository editing safety:
 * 1. Permanently locks all 14 files listed in PROTECTED_FILES.md.
 * 2. Enforces deletion controls:
 *    - >25 deleted lines requires written justification in ledger.
 *    - >50 deleted lines requires explicit owner approval.
 * 3. Blocks destructive commands (git reset --hard, rm -rf, git clean -fd, git restore .).
 */

import path from 'node:path';

export const LOCKED_PROTECTED_FILES = [
  'src/api/base44Client.js',
  'src/lib/AuthContext.jsx',
  'src/lib/security.js',
  'src/lib/securityUtils.js',
  'src/lib/permissions.js',
  'src/lib/validator.js',
  'src/pages/Login.jsx',
  'src/pages/Setup.jsx',
  'src/pages/ForgotPassword.jsx',
  'src/pages/ResetPassword.jsx',
  'AGENTS.md',
  'CLAUDE.md',
  'PROTECTED_FILES.md',
  '.agents/rules/no-modify-protected.md',
];

export const DESTRUCTIVE_COMMAND_PATTERNS = [
  /git\s+reset\s+--hard/i,
  /git\s+clean\s+-[a-zA-Z]*f/i,
  /git\s+restore\s+\./i,
  /rm\s+-rf\s+/i,
  /rmdir\s+\/s\s+\/q/i,
  /drop\s+table/i,
  /drop\s+database/i,
  /truncate\s+/i,
];

export class PolicyError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.name = 'PolicyError';
    this.code = code;
    Object.assign(this, extra);
  }
}

export class EditingSafetyPolicy {
  /**
   * Normalizes a file path relative to repo root.
   */
  static normalizePath(filePath) {
    if (!filePath || typeof filePath !== 'string') return '';
    return filePath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^c:\/Users\/[^\/]+\/OneDrive\/Desktop\/boston_project\//i, '');
  }

  /**
   * Validates if a target file is protected from AI modification.
   * Throws PolicyViolationError if target is in PROTECTED_FILES.md without explicit exception.
   */
  static validateTargetFile(filePath, ownerExceptionGranted = false) {
    const norm = EditingSafetyPolicy.normalizePath(filePath);
    const isProtected = LOCKED_PROTECTED_FILES.some((p) => norm === p || norm.endsWith(`/${p}`));

    if (isProtected && !ownerExceptionGranted) {
      throw new PolicyError(
        `PROTECTED_FILE_VIOLATION: File "${norm}" is permanently locked in PROTECTED_FILES.md. ` +
        'No AI agent may modify this file without explicit written owner authorization.',
        'PROTECTED_FILE_LOCKED',
        { targetFile: norm }
      );
    }

    return {
      allowed: true,
      file: norm,
      isProtected,
      ownerExceptionGranted,
    };
  }

  /**
   * Validates patch line deletions against threshold rules.
   */
  static validatePatchDeletions(linesDeleted, linesAdded, options = {}) {
    const { justification = '', isOwnerApproved = false } = options;

    if (linesDeleted > 50 && !isOwnerApproved) {
      throw new PolicyError(
        `DELETION_LIMIT_EXCEEDED: Patch attempts to delete ${linesDeleted} lines (>50 lines). ` +
        'Explicit owner approval is required to delete more than 50 lines.',
        'DELETION_THRESHOLD_50_EXCEEDED',
        { linesDeleted }
      );
    }

    if (linesDeleted > 25 && (!justification || justification.trim().length < 10)) {
      throw new PolicyError(
        `DELETION_JUSTIFICATION_REQUIRED: Patch attempts to delete ${linesDeleted} lines (>25 lines). ` +
        'A substantive written justification must be recorded in the evidence ledger.',
        'DELETION_JUSTIFICATION_MISSING',
        { linesDeleted }
      );
    }

    return {
      allowed: true,
      linesDeleted,
      linesAdded,
      justification: linesDeleted > 25 ? justification.trim() : 'Under 25 lines threshold',
    };
  }

  /**
   * Validates shell command against destructive command guards.
   */
  static validateCommand(commandLine, isOwnerApproved = false) {
    if (typeof commandLine !== 'string') return { allowed: true };

    for (const pattern of DESTRUCTIVE_COMMAND_PATTERNS) {
      if (pattern.test(commandLine)) {
        if (!isOwnerApproved) {
          throw new PolicyError(
            `DESTRUCTIVE_COMMAND_BLOCKED: Command "${commandLine}" matches destructive pattern ${pattern}. ` +
            'Explicit owner authorization is required.',
            'DESTRUCTIVE_COMMAND_PROHIBITED',
            { command: commandLine }
          );
        }
      }
    }

    return {
      allowed: true,
      command: commandLine,
    };
  }
}
