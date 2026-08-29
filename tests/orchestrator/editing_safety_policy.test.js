import { describe, it, expect } from 'vitest';
import {
  EditingSafetyPolicy,
  LOCKED_PROTECTED_FILES,
} from '../../src/orchestrator/policies/EditingSafetyPolicy.js';

describe('EditingSafetyPolicy Suite', () => {
  it('contains all 14 protected files from PROTECTED_FILES.md', () => {
    expect(LOCKED_PROTECTED_FILES).toContain('src/api/base44Client.js');
    expect(LOCKED_PROTECTED_FILES).toContain('src/lib/AuthContext.jsx');
    expect(LOCKED_PROTECTED_FILES).toContain('src/lib/security.js');
    expect(LOCKED_PROTECTED_FILES).toContain('src/lib/securityUtils.js');
    expect(LOCKED_PROTECTED_FILES).toContain('src/lib/permissions.js');
    expect(LOCKED_PROTECTED_FILES).toContain('src/lib/validator.js');
    expect(LOCKED_PROTECTED_FILES).toContain('src/pages/Login.jsx');
    expect(LOCKED_PROTECTED_FILES).toContain('src/pages/Setup.jsx');
    expect(LOCKED_PROTECTED_FILES).toContain('src/pages/ForgotPassword.jsx');
    expect(LOCKED_PROTECTED_FILES).toContain('src/pages/ResetPassword.jsx');
    expect(LOCKED_PROTECTED_FILES).toContain('AGENTS.md');
    expect(LOCKED_PROTECTED_FILES).toContain('CLAUDE.md');
    expect(LOCKED_PROTECTED_FILES).toContain('PROTECTED_FILES.md');
    expect(LOCKED_PROTECTED_FILES).toContain('.agents/rules/no-modify-protected.md');
  });

  it('strictly blocks modification of protected files without exception', () => {
    expect(() => {
      EditingSafetyPolicy.validateTargetFile('src/api/base44Client.js', false);
    }).toThrowError(/PROTECTED_FILE_VIOLATION/);

    expect(() => {
      EditingSafetyPolicy.validateTargetFile('src/lib/AuthContext.jsx', false);
    }).toThrowError(/PROTECTED_FILE_VIOLATION/);
  });

  it('allows non-protected files', () => {
    const result = EditingSafetyPolicy.validateTargetFile('src/lib/myNewModule.js');
    expect(result.allowed).toBe(true);
  });

  it('requires written justification when deleting >25 lines', () => {
    expect(() => {
      EditingSafetyPolicy.validatePatchDeletions(30, 10, { justification: '' });
    }).toThrowError(/DELETION_JUSTIFICATION_REQUIRED/);

    const valid = EditingSafetyPolicy.validatePatchDeletions(30, 10, {
      justification: 'Refactored duplicate utility functions into common helper',
    });
    expect(valid.allowed).toBe(true);
  });

  it('requires explicit owner approval when deleting >50 lines', () => {
    expect(() => {
      EditingSafetyPolicy.validatePatchDeletions(60, 10, {
        justification: 'Large cleanup',
        isOwnerApproved: false,
      });
    }).toThrowError(/DELETION_LIMIT_EXCEEDED/);

    const valid = EditingSafetyPolicy.validatePatchDeletions(60, 10, {
      justification: 'Large cleanup approved by owner',
      isOwnerApproved: true,
    });
    expect(valid.allowed).toBe(true);
  });

  it('blocks destructive shell commands', () => {
    expect(() => {
      EditingSafetyPolicy.validateCommand('git reset --hard HEAD', false);
    }).toThrowError(/DESTRUCTIVE_COMMAND_BLOCKED/);

    expect(() => {
      EditingSafetyPolicy.validateCommand('rm -rf src/', false);
    }).toThrowError(/DESTRUCTIVE_COMMAND_BLOCKED/);
  });
});
