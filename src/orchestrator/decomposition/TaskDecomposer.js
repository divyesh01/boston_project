/**
 * TaskDecomposer
 * --------------
 * Classifies task complexity (SMALL, MEDIUM, LARGE, CRITICAL),
 * identifies independent workstreams, and designs the multi-wave swarm execution plan.
 */

export const TASK_SCALE = {
  SMALL: 'SMALL',
  MEDIUM: 'MEDIUM',
  LARGE: 'LARGE',
  CRITICAL: 'CRITICAL',
};

export class TaskDecomposer {
  /**
   * Classifies task complexity based on prompt keywords, target files, and risk profile.
   */
  static classifyTask(prompt = '', targetFiles = []) {
    const normPrompt = prompt.toLowerCase();
    const targetCount = targetFiles.length;

    // Critical triggers: security, property isolation, tenant leak, financial calculation, auth
    const isCritical = (
      normPrompt.includes('security') ||
      normPrompt.includes('vulnerability') ||
      normPrompt.includes('exploit') ||
      normPrompt.includes('property isolation') ||
      normPrompt.includes('cross-property') ||
      normPrompt.includes('tenant') ||
      normPrompt.includes('financial invariant') ||
      normPrompt.includes('fraud') ||
      normPrompt.includes('money kept')
    );

    if (isCritical) {
      return {
        scale: TASK_SCALE.CRITICAL,
        rationale: 'Critical security, multi-tenant isolation, or financial invariant scope detected.',
        claudeWorkersCount: 4, // 2 Tabitoken + 2 GoRouter
        reviewerCount: 8,
        includeAdversarialReview: true,
      };
    }

    // Large triggers: major redesign, multi-agent overhaul, high parallelism, full-agent swarm, multi-file
    const isLarge = (
      normPrompt.includes('swarm') ||
      normPrompt.includes('active-active') ||
      normPrompt.includes('orchestrator') ||
      normPrompt.includes('redesign') ||
      normPrompt.includes('architecture') ||
      normPrompt.includes('upgrade') ||
      targetCount >= 3
    );

    if (isLarge) {
      return {
        scale: TASK_SCALE.LARGE,
        rationale: 'Substantial architecture, multi-agent swarm, or multi-file system upgrade detected.',
        claudeWorkersCount: 4, // 2 Tabitoken + 2 GoRouter
        reviewerCount: 6,
        includeAdversarialReview: true,
      };
    }

    // Small triggers: typo, comment, minor log format
    const isSmall = (
      (normPrompt.includes('typo') || normPrompt.includes('formatting') || normPrompt.includes('comment')) &&
      targetCount <= 1
    );

    if (isSmall) {
      return {
        scale: TASK_SCALE.SMALL,
        rationale: 'Trivial formatting, comment, or typo modification detected.',
        claudeWorkersCount: 1,
        reviewerCount: 2,
        includeAdversarialReview: false,
      };
    }

    // Default: Medium
    return {
      scale: TASK_SCALE.MEDIUM,
      rationale: 'Standard engineering feature, bug fix, or diagnostic module task.',
      claudeWorkersCount: 2, // 1 Tabitoken + 1 GoRouter
      reviewerCount: 4,
      includeAdversarialReview: true,
    };
  }

  /**
   * Generates a multi-wave swarm execution plan for a given task and context.
   */
  static planSwarmExecution(taskOptions, classification, liveAgents = []) {
    const { prompt, targetFiles = [] } = taskOptions;
    const { scale, claudeWorkersCount } = classification;

    // Wave A: Parallel Claude Opus Investigators
    const waveA = [];
    const claudeSpecialties = [
      {
        role: 'CLAUDE_OPUS_REPO_ARCHITECT',
        workstream: 'Repository Architecture & Root-Cause Diagnosis',
        focus: 'Analyze caller hierarchy, module boundaries, invariants, and author primary structural diagnosis.',
      },
      {
        role: 'CLAUDE_OPUS_INDEPENDENT_ARCHITECT',
        workstream: 'Independent Architectural Verification',
        focus: 'Independently formulate architectural solution and alternative edge-case safeguards.',
      },
      {
        role: 'CLAUDE_OPUS_STRATEGIST',
        workstream: 'Component & State Isolation Strategy',
        focus: 'Formulate surgical state isolation, error boundary handling, and behavioral contract.',
      },
      {
        role: 'CLAUDE_OPUS_INDEPENDENT_STRATEGIST',
        workstream: 'Independent Implementation Strategy',
        focus: 'Evaluate regression risks, blast radius, and clean API contract surface.',
      },
    ];

    for (let i = 0; i < claudeWorkersCount; i++) {
      const spec = claudeSpecialties[i % claudeSpecialties.length];
      waveA.push({
        workerId: `WAVE_A_WORKER_${i + 1}`,
        agentNumber: i + 1,
        role: spec.role,
        workstream: spec.workstream,
        focus: spec.focus,
      });
    }

    // Wave B: Specialist Peer Reviewer Swarm
    const waveB = [
      {
        reviewerId: 'NARA_ADVERSARIAL_CRITIC',
        agentNumber: 5,
        role: 'ADVERSARIAL_CRITIC',
        workstream: 'Adversarial Edge-Case Discovery',
        provider: 'NARA',
        accountAlias: 'NARA-A',
        model: 'tencent-hy3-free',
        focus: 'Find edge cases, concurrency race conditions, null leaks, and boundary violations.',
      },
      {
        reviewerId: 'NARA_DEEP_REASONER',
        agentNumber: 6,
        role: 'DEEP_REASONING_CRITIC',
        workstream: 'Logic Consistency & Invariant Proof',
        provider: 'NARA',
        accountAlias: 'NARA-A',
        model: 'mistral-medium-3-5',
        focus: 'Verify logical invariant preservation, precision standards, and mathematical consistency.',
      },
      {
        reviewerId: 'NARA_DEPENDENCY_AUDITOR',
        agentNumber: 7,
        role: 'DEPENDENCY_AND_INVARIANT_AUDITOR',
        workstream: 'Dependency Graph & Blast Radius',
        provider: 'NARA',
        accountAlias: 'NARA-B',
        model: 'laguna-s-2.1',
        focus: 'Audit all calling modules and verify no cross-module side effects or regressions occur.',
      },
      {
        reviewerId: 'NARA_REGRESSION_HUNTER',
        agentNumber: 8,
        role: 'REGRESSION_AND_TEST_HUNTER',
        workstream: 'Testing Strategy & Assertions',
        provider: 'NARA',
        accountAlias: 'NARA-B',
        model: 'agnes-2.5-flash',
        focus: 'Generate 3 rigorous assertions or mutation tests to ground truth the implementation.',
      },
      {
        reviewerId: 'NARA_SCALE_REVIEWER',
        agentNumber: 9,
        role: 'PERFORMANCE_AND_SCALE_REVIEWER',
        workstream: 'Concurrency & Performance Scale',
        provider: 'NARA',
        accountAlias: 'NARA-A',
        model: 'stepfun-3.7-flash',
        focus: 'Evaluate performance overhead, memory churn, and non-blocking asynchronous execution.',
      },
      {
        reviewerId: 'NARA_UI_UX_POLISH',
        agentNumber: 10,
        role: 'UI_UX_ACCESSIBILITY_CRITIC',
        workstream: 'UI/UX & Design Hierarchy',
        provider: 'NARA',
        accountAlias: 'NARA-B',
        model: 'agnes-2.5-flash',
        focus: 'Audit user interface clarity, responsive ergonomics, and accessibility standards.',
      },
      {
        reviewerId: 'XKIRO_STANDARDS_AUDITOR',
        agentNumber: 11,
        role: 'HOSPITALITY_STANDARDS_AUDITOR',
        workstream: 'USALI & Data Standards',
        provider: 'XKIRO',
        model: 'poolside/laguna-s-2.1:free',
        focus: 'Verify compliance with hospitality accounting and RFC formatting standards.',
      },
      {
        reviewerId: 'OPENROUTER_SECURITY_GATE',
        agentNumber: 12,
        role: 'SECURITY_RED_TEAM',
        workstream: 'Security & Property Isolation',
        provider: 'OPENROUTER',
        model: 'google/gemini-2.0-flash-exp:free',
        focus: 'Scan for unauthorized file modifications, credential leakage, and injection risks.',
      },
    ];

    // Wave C: Authoritative Claude Opus Synthesis
    const waveC = {
      role: 'CLAUDE_OPUS_AUTHORITATIVE_SYNTHESIS',
      agentNumber: waveA.length + waveB.length + 1,
      workstream: 'Authoritative Synthesis & Definitive Code Patch Authorship',
      focus: 'Synthesize all Wave A findings and Wave B reviewer critiques. Make definitive accept/reject decisions and author the final patch.',
    };

    return {
      classification,
      waveA,
      waveB,
      waveC,
    };
  }
}
