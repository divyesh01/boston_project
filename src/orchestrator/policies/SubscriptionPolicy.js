/**
 * SubscriptionPolicy
 * ------------------
 * Enforces strict subscription conservation rules:
 * 1. USE_CODEX_BY_DEFAULT = false
 * 2. REQUIRE_OWNER_PERMISSION_FOR_CODEX = true
 * 3. Antigravity & Gemini subscription models are prohibited from code authoring.
 * 4. External API models (Claude Opus API) serve as the primary workforce.
 */

export const USE_CODEX_BY_DEFAULT = false;
export const REQUIRE_OWNER_PERMISSION_FOR_CODEX = true;

export class PolicyError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.name = 'PolicyError';
    this.code = code;
    Object.assign(this, extra);
  }
}

export class SubscriptionPolicy {
  constructor() {
    this.antigravityUsed = false;
    this.antigravityReason = 'None';
    this.antigravityRole = 'Dashboard / Launcher only';

    this.codexUsed = false;
    this.codexReason = 'None';
    this.codexRole = 'Idle reserve';
  }

  /**
   * Validates whether Codex may be invoked.
   * Throws PolicyViolationError if Codex is invoked without explicit owner permission.
   */
  static validateCodexInvocation(options = {}) {
    const { isOwnerAuthorized = false, isEmergencyAudit = false, reason = '' } = options;

    if (!USE_CODEX_BY_DEFAULT && !isOwnerAuthorized && !isEmergencyAudit) {
      throw new PolicyError(
        '[CODEX_INVOCATION_BLOCKED] POLICY_VIOLATION: Codex subscription invocation is BLOCKED by default. ' +
        'Explicit owner authorization (isOwnerAuthorized = true) is required.',
        'CODEX_INVOCATION_BLOCKED',
        { policy: 'SubscriptionPolicy.validateCodexInvocation' }
      );
    }

    return {
      allowed: true,
      reason: isOwnerAuthorized ? `Owner authorized: ${reason}` : 'Emergency audit approved',
    };
  }

  /**
   * Validates whether an agent/model is authorized to author code patches.
   * Only external API models (specifically Claude Opus / authorized API models) may author code.
   */
  static validateCodeAuthor(authorInfo = {}) {
    const { role = '', model = '', provider = '', isSubscriptionModel = false } = authorInfo;
    const normModel = String(model || '').toLowerCase();
    const normProvider = String(provider || '').toUpperCase();

    // Rejection 1: Gemini or Antigravity subscription attempting to author code
    if (isSubscriptionModel || normProvider === 'ANTIGRAVITY_SUBSCRIPTION' || normProvider === 'GEMINI_SUBSCRIPTION') {
      throw new PolicyError(
        `[SUBSCRIPTION_CODE_AUTHOR_PROHIBITED] POLICY_VIOLATION: Subscription model "${model}" (${provider}) cannot act as code author. ` +
        'Code authorship is reserved for external API models (Claude Opus API).',
        'SUBSCRIPTION_CODE_AUTHOR_PROHIBITED'
      );
    }

    // Rejection 2: Codex subscription attempting to author code without explicit override
    if (normProvider === 'CODEX' || normModel.includes('codex')) {
      throw new PolicyError(
        '[CODEX_CODE_AUTHOR_PROHIBITED] POLICY_VIOLATION: Codex cannot act as code author by default. External API models must author code.',
        'CODEX_CODE_AUTHOR_PROHIBITED'
      );
    }

    return {
      authorized: true,
      role,
      model,
      provider,
    };
  }

  /**
   * Records subscription model usage for the final task report.
   */
  recordUsage({ antigravity = false, antigravityReason = '', codex = false, codexReason = '' }) {
    if (antigravity) {
      this.antigravityUsed = true;
      this.antigravityReason = antigravityReason;
      this.antigravityRole = 'Dashboard / Launcher / Status view';
    }
    if (codex) {
      this.codexUsed = true;
      this.codexReason = codexReason;
      this.codexRole = 'Emergency Recovery';
    }
  }

  /**
   * Emits the required Subscription Usage Accounting section for final reports.
   */
  generateAccountingReport() {
    return [
      '====================================================',
      'SUBSCRIPTION USAGE CONSERVATION ACCOUNTING',
      '====================================================',
      'ANTIGRAVITY SUBSCRIPTION',
      `Substantive reasoning / code authoring: ${this.antigravityUsed ? 'YES' : 'NO (100% offloaded to external API)'}`,
      `Interface / launcher usage: YES (Interactive terminal & launch interface)`,
      `Estimated role: ${this.antigravityRole}`,
      `Reason: ${this.antigravityReason}`,
      '',
      'CODEX SUBSCRIPTION',
      `Substantive reasoning / code authoring: ${this.codexUsed ? 'YES' : 'NO (Conserved at 0% usage)'}`,
      `Invocation status: ${this.codexUsed ? 'ACTIVE' : 'IDLE / BLOCKED BY DEFAULT'}`,
      `Estimated role: ${this.codexRole}`,
      `Reason: ${this.codexReason}`,
      `Could API have done this instead?: YES (Preserved for emergency reserve)`,
      '====================================================',
    ].join('\n');
  }
}
