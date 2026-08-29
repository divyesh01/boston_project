/**
 * ReviewerSwarm
 * -------------
 * Dispatches high-parallelism peer review challenges to diverse external API models:
 * - Adversarial Critic (Nara / Tencent Hy3)
 * - Deep Reasoning & Logical Consistency (Nara / Mistral Medium)
 * - Dependency & Invariant Auditor (Nara / Laguna)
 * - Regression & Test Case Hunter (Nara / Agnes Flash)
 * - Concurrency & Scale Reviewer (Nara / Stepfun Flash)
 * - UI/UX & Accessibility Critic (Nara / Agnes Flash)
 * - Standards & Precision Auditor (xKiro)
 * - Security & Multi-Tenant Red Team (OpenRouter)
 *
 * Collects critiques deterministically and feeds them into the Claude Opus authoritative synthesis.
 */

export class ReviewerSwarm {
  constructor(registry) {
    this.registry = registry;
  }

  /**
   * Dispatches parallel reviews of Claude's proposed implementation.
   */
  async conductParallelReview(params) {
    const { taskPrompt, claudeProposal, context = '', taskId = null, waveBPlan = null } = params;
    const tStart = Date.now();

    const defaultReviewers = [
      {
        reviewerId: 'NARA_ADVERSARIAL_CRITIC',
        agentNumber: 5,
        role: 'ADVERSARIAL_CRITIC',
        workstream: 'Adversarial Edge-Case Discovery',
        provider: 'NARA',
        accountAlias: 'NARA-A',
        model: 'tencent-hy3-free',
        systemPrompt: (
          'You are the Adversarial Reviewer for a high-reliability hotel application. ' +
          'Critique the proposed Claude Opus solution aggressively. Actively find edge cases, ' +
          'unhandled nulls, concurrency race conditions, and boundary flaws. Be concise and specific.'
        ),
      },
      {
        reviewerId: 'NARA_DEEP_REASONER',
        agentNumber: 6,
        role: 'DEEP_REASONING_CRITIC',
        workstream: 'Logic Consistency & Invariant Proof',
        provider: 'NARA',
        accountAlias: 'NARA-A',
        model: 'mistral-medium-3-5',
        systemPrompt: (
          'You are the Deep Reasoning & Invariant Reviewer. ' +
          'Evaluate the proposed solution for mathematical correctness, invariant preservation, ' +
          'clean encapsulation, and strict type/data consistency.'
        ),
      },
      {
        reviewerId: 'NARA_DEPENDENCY_AUDITOR',
        agentNumber: 7,
        role: 'DEPENDENCY_AND_INVARIANT_AUDITOR',
        workstream: 'Dependency Graph & Blast Radius',
        provider: 'NARA',
        accountAlias: 'NARA-B',
        model: 'laguna-s-2.1',
        systemPrompt: (
          'You are the Repository Dependency & Call Graph Auditor. ' +
          'Trace the callers and consumers of modified functions. Identify potential side effects ' +
          'or cross-module regressions. State CLEAR or identify risk areas.'
        ),
      },
      {
        reviewerId: 'NARA_REGRESSION_HUNTER',
        agentNumber: 8,
        role: 'REGRESSION_AND_TEST_HUNTER',
        workstream: 'Testing Strategy & Assertions',
        provider: 'NARA',
        accountAlias: 'NARA-B',
        model: 'agnes-2.5-flash',
        systemPrompt: (
          'You are the Test Case & Regression Hunter. ' +
          'Generate 3 specific vitest assertions or boundary mutation test cases that should pass ' +
          'against the proposed solution.'
        ),
      },
      {
        reviewerId: 'NARA_SCALE_REVIEWER',
        agentNumber: 9,
        role: 'PERFORMANCE_AND_SCALE_REVIEWER',
        workstream: 'Concurrency & Performance Scale',
        provider: 'NARA',
        accountAlias: 'NARA-A',
        model: 'stepfun-3.7-flash',
        systemPrompt: (
          'You are the Performance & Scale Reviewer. ' +
          'Audit the proposal for event loop blocking, unnecessary re-renders, memory leaks, ' +
          'and non-blocking asynchronous execution efficiency.'
        ),
      },
      {
        reviewerId: 'NARA_UI_UX_POLISH',
        agentNumber: 10,
        role: 'UI_UX_ACCESSIBILITY_CRITIC',
        workstream: 'UI/UX & Design Hierarchy',
        provider: 'NARA',
        accountAlias: 'NARA-B',
        model: 'agnes-2.5-flash',
        systemPrompt: (
          'You are the UI/UX & Accessibility Reviewer. ' +
          'Audit the proposal for visual hierarchy, semantic clarity, WCAG keyboard accessibility, ' +
          'and responsive ergonomics.'
        ),
      },
      {
        reviewerId: 'XKIRO_STANDARDS_AUDITOR',
        agentNumber: 11,
        role: 'HOSPITALITY_STANDARDS_AUDITOR',
        workstream: 'USALI & Data Standards',
        provider: 'XKIRO',
        model: 'poolside/laguna-s-2.1:free',
        systemPrompt: (
          'You are the Hospitality Standards & Invariant Auditor. ' +
          'Audit the proposal against USALI financial conventions, integer-cents math, and RFC formatting.'
        ),
      },
      {
        reviewerId: 'OPENROUTER_SECURITY_GATE',
        agentNumber: 12,
        role: 'SECURITY_RED_TEAM',
        workstream: 'Security & Property Isolation',
        provider: 'OPENROUTER',
        model: 'google/gemini-2.0-flash-exp:free',
        systemPrompt: (
          'You are the Security & Multi-Tenant Red Team Auditor. ' +
          'Evaluate the proposed changes for property boundary isolation, input sanitization, ' +
          'and secret protection.'
        ),
      },
    ];

    const reviewTasks = Array.isArray(waveBPlan) && waveBPlan.length > 0 ? waveBPlan : defaultReviewers;

    const reviewPromises = reviewTasks.map(async (cfg) => {
      const prompt = (
        `### ORIGINAL TASK:\n${taskPrompt}\n\n` +
        `### PROPOSED ARCHITECTURAL DIAGNOSIS & PATCH:\n${claudeProposal}\n\n` +
        `Provide your independent specialist review critique now:`
      );

      const t0 = Date.now();
      const dispatchIso = new Date(t0).toISOString();

      try {
        const res = await this.registry.callAgent({
          role: cfg.role,
          provider: cfg.provider,
          model: cfg.model,
          prompt,
          systemPrompt: cfg.systemPrompt || `You are the ${cfg.role} specialist. Critique the proposed solution concisely.`,
          context,
          maxTokens: 500,
          timeoutMs: 30000,
          accountAlias: cfg.accountAlias || null,
          taskId,
        });

        const finishIso = new Date().toISOString();
        const latencySec = res.latencySeconds || Number(((Date.now() - t0) / 1000).toFixed(3));

        return {
          reviewerId: cfg.reviewerId,
          agentNumber: cfg.agentNumber,
          role: cfg.role,
          workstream: cfg.workstream || 'Peer Review & Critique',
          provider: res.transportProvider || cfg.provider,
          accountAlias: cfg.accountAlias || 'DEFAULT',
          modelRequested: cfg.model,
          modelReturned: res.modelReturned,
          actualProvider: res.actualProvider,
          generationId: res.generationId,
          dispatchTimestamp: dispatchIso,
          startTimestamp: dispatchIso,
          completionTimestamp: finishIso,
          latencySeconds: latencySec,
          success: res.success,
          critique: res.success ? res.content : null,
          error: res.error || null,
          httpStatus: res.httpStatus,
          tokens: res.usage,
          cost: res.cost,
        };
      } catch (err) {
        const finishIso = new Date().toISOString();
        const latencySec = Number(((Date.now() - t0) / 1000).toFixed(3));

        return {
          reviewerId: cfg.reviewerId,
          agentNumber: cfg.agentNumber,
          role: cfg.role,
          workstream: cfg.workstream || 'Peer Review & Critique',
          provider: cfg.provider,
          accountAlias: cfg.accountAlias || 'DEFAULT',
          modelRequested: cfg.model,
          modelReturned: 'NONE',
          actualProvider: 'NONE',
          generationId: null,
          dispatchTimestamp: dispatchIso,
          startTimestamp: dispatchIso,
          completionTimestamp: finishIso,
          latencySeconds: latencySec,
          success: false,
          critique: null,
          error: err.message,
          httpStatus: 'ERROR',
          tokens: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          cost: null,
        };
      }
    });

    const results = await Promise.all(reviewPromises);
    const successfulReviews = results.filter((r) => r.success && r.critique);
    const failedReviews = results.filter((r) => !r.success);

    let criticismPackage = `=== MULTI-AGENT REVIEWER CRITIQUES ===\n\n`;
    if (successfulReviews.length === 0) {
      criticismPackage += `[Note: External peer reviewers unavailable. Proceed with internal Claude Opus rigor.]\n`;
    } else {
      for (const r of successfulReviews) {
        criticismPackage += `--- Reviewer: ${r.reviewerId} (${r.actualProvider} / ${r.modelReturned}) ---\n`;
        criticismPackage += `${r.critique}\n\n`;
      }
    }

    return {
      totalReviewers: results.length,
      successfulCount: successfulReviews.length,
      failedCount: failedReviews.length,
      durationSeconds: Number(((Date.now() - tStart) / 1000).toFixed(3)),
      criticismPackage,
      reviewerResults: results,
    };
  }
}
