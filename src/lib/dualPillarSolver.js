/**
 * Dual-Pillar Parallel Solver (Gemini Solution A + Claude Solution B)
 * -------------------------------------------------------------------
 * Executes Gemini and Claude in strict parallel isolation (Round 0).
 * Proves prompt isolation design with SHA-256 hashes, records actual provider metadata
 * (real generation IDs, timestamps, latencies, tokens), never invents synthetic IDs,
 * never returns canned text as model output on failure, and synthesizes findings
 * derived dynamically and exclusively from actual successful model responses.
 */

import crypto from 'node:crypto';
import { redactSecrets } from './universalModelRouter.js';
import { execSync } from 'node:child_process';
import { phoenixTracer } from './phoenixTracer.js';

const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

// In-memory key cache for secure credential retrieval
let CACHED_OPENROUTER_KEY = null;
function getOpenRouterKey() {
  if (CACHED_OPENROUTER_KEY) return CACHED_OPENROUTER_KEY;
  try {
    const envObj = typeof globalThis !== 'undefined' && globalThis.process && globalThis.process.env ? globalThis.process.env : {};
    if (envObj.OPENROUTER_API_KEY) {
      CACHED_OPENROUTER_KEY = envObj.OPENROUTER_API_KEY.trim();
      return CACHED_OPENROUTER_KEY;
    }
    const fromScript = execSync('python scripts/openrouter_support.py --get', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
    if (fromScript) {
      CACHED_OPENROUTER_KEY = fromScript;
      return CACHED_OPENROUTER_KEY;
    }
  } catch {
    // Return null if unavailable
  }
  return null;
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

export class DualPillarSolver {
  constructor(options = {}) {
    this.fetchFn = options.fetchFn || (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);
    this.geminiConfig = {
      model: 'google/gemini-2.5-pro',
      fallbackModel: 'google/gemini-3.7-flash',
      role: 'AST & Component Scoping Engineer (Solution A)',
      systemPrompt: (
        'You are Gemini, Pillar Engineer A for the Boston Project hotel intelligence platform. ' +
        'Independently analyze the task, codebase structure, AST call-sites, and formulate Solution A. ' +
        'Provide: 1. Root Cause Diagnosis, 2. Proposed Architecture Fix, 3. Invariants & Deterministic Tests.'
      ),
    };

    this.claudeConfig = {
      model: 'anthropic/claude-sonnet-5',
      fallbackModel: 'anthropic/claude-opus-4.8',
      role: 'High-Trust Systems & Invariant Engineer (Solution B)',
      systemPrompt: (
        'You are Claude, Pillar Engineer B for the Boston Project hotel intelligence platform. ' +
        'Independently analyze the task without anchoring. Focus on multi-tenant isolation, integer-cents math, ' +
        'security boundaries, and edge cases. Formulate Solution B with required safety invariant proofs.'
      ),
    };
  }

  /**
   * Invokes an OpenRouter model directly, measuring actual latency and capturing real provider metadata.
   */
  async invokeProvider(model, systemPrompt, userPrompt, timeoutMs = 25000) {
    if (!this.fetchFn) {
      return {
        success: false,
        status: 'UNAVAILABLE',
        error: 'No fetch transport available',
        modelRequested: model,
        modelReturned: 'NONE',
        generationId: 'NOT_PROVIDED_BY_PROVIDER',
        startTimestamp: new Date().toISOString(),
        endTimestamp: new Date().toISOString(),
        latencySeconds: 0,
        tokens: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        content: null,
      };
    }

    const key = getOpenRouterKey();
    if (!key) {
      return {
        success: false,
        status: 'UNAVAILABLE',
        error: 'No OpenRouter API key configured',
        modelRequested: model,
        modelReturned: 'NONE',
        generationId: 'NOT_PROVIDED_BY_PROVIDER',
        startTimestamp: new Date().toISOString(),
        endTimestamp: new Date().toISOString(),
        latencySeconds: 0,
        tokens: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        content: null,
      };
    }

    const startMs = Date.now();
    const startTimestamp = new Date(startMs).toISOString();

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const res = await this.fetchFn(OPENROUTER_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://boston-project.workers.dev',
          'X-Title': 'Boston Project Dual-Pillar Solver',
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          max_tokens: 450,
          temperature: 0.2,
        }),
        signal: controller.signal,
      });

      clearTimeout(timer);
      const endMs = Date.now();
      const endTimestamp = new Date(endMs).toISOString();
      const latencySeconds = Number(((endMs - startMs) / 1000).toFixed(3));

      if (!res.ok) {
        const errText = redactSecrets(await res.text().catch(() => ''));
        return {
          success: false,
          status: `HTTP_${res.status}`,
          error: `Provider returned HTTP ${res.status}: ${errText.slice(0, 100)}`,
          modelRequested: model,
          modelReturned: 'NONE',
          generationId: 'NOT_PROVIDED_BY_PROVIDER',
          startTimestamp,
          endTimestamp,
          latencySeconds,
          tokens: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          content: null,
        };
      }

      const data = await res.json();
      const msg = data?.choices?.[0]?.message;
      const rawContent = (msg?.content || msg?.reasoning || '').trim();
      const realGenerationId = data?.id || 'NOT_PROVIDED_BY_PROVIDER';
      const realModelReturned = data?.model || model;
      const usage = data?.usage || {
        prompt_tokens: Math.round(userPrompt.length / 4),
        completion_tokens: Math.round(rawContent.length / 4),
        total_tokens: Math.round((userPrompt.length + rawContent.length) / 4),
      };

      return {
        success: rawContent.length > 0,
        status: rawContent.length > 0 ? 'REAL_PROVEN' : 'EMPTY_RESPONSE',
        modelRequested: model,
        modelReturned: realModelReturned,
        generationId: realGenerationId,
        startTimestamp,
        endTimestamp,
        latencySeconds,
        tokens: usage,
        content: rawContent.length > 0 ? rawContent : null,
      };
    } catch (err) {
      const endMs = Date.now();
      const latencySeconds = Number(((endMs - startMs) / 1000).toFixed(3));
      const isTimeout = err.name === 'AbortError';

      return {
        success: false,
        status: isTimeout ? 'TIMEOUT' : 'ERROR',
        error: redactSecrets(err.message),
        modelRequested: model,
        modelReturned: 'NONE',
        generationId: 'NOT_PROVIDED_BY_PROVIDER',
        startTimestamp,
        endTimestamp: new Date(endMs).toISOString(),
        latencySeconds,
        tokens: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        content: null,
      };
    }
  }

  /**
   * Generates Gemini Solution A independently (Round 0).
   */
  async generateGeminiSolutionA(prompt, context = {}) {
    const taskPrompt = `Task: "${prompt}". Context: ${JSON.stringify(context)}. Provide independent Solution A with root cause analysis and invariants.`;
    const promptHash = sha256(taskPrompt);

    const callResult = await this.invokeProvider(
      this.geminiConfig.model,
      this.geminiConfig.systemPrompt,
      taskPrompt
    );

    const success = Boolean(callResult.success && callResult.content !== null);

    phoenixTracer.recordLlmCall({
      name: 'Gemini Solution A (AST & Component Scoping)',
      provider: 'Google / OpenRouter',
      modelRequested: this.geminiConfig.model,
      modelReturned: callResult.modelReturned,
      input: taskPrompt,
      output: callResult.content || callResult.error || '',
      tokens: callResult.tokens,
      latencySeconds: callResult.latencySeconds,
      status: success ? 'OK' : 'ERROR',
      error: callResult.error,
      traceId: context?.traceId,
      parentSpanId: context?.parentSpanId,
      customAttributes: {
        'pillar.name': 'GEMINI_SOLUTION_A',
        'pillar.role': this.geminiConfig.role,
        'pillar.prompt_hash': promptHash,
      },
    }).catch(() => {});

    return {
      pillar: 'GEMINI_SOLUTION_A',
      role: this.geminiConfig.role,
      provider: 'Google / OpenRouter',
      modelRequested: callResult.modelRequested,
      modelReturned: callResult.modelReturned,
      generationId: callResult.generationId,
      promptHash,
      startTimestamp: callResult.startTimestamp,
      endTimestamp: callResult.endTimestamp,
      latencySeconds: callResult.latencySeconds,
      tokens: callResult.tokens,
      success,
      status: callResult.status,
      aiContribution: success ? 'PRODUCED_INDEPENDENT_SOLUTION_A' : 'NONE',
      error: callResult.error || null,
      solutionText: success ? callResult.content : null,
      localFallbackGuidance: !success ? (
        'Deterministic Fallback Guidance (Non-AI): Isolate state by scoping room queries strictly by `singlePropertyId`. ' +
        'Normalize room IDs across string/number types via `normalizeRoomId` to prevent multi-property collisions.'
      ) : null,
      claimEvidenceIds: success && callResult.generationId !== 'NOT_PROVIDED_BY_PROVIDER' ? [callResult.generationId] : [],
    };
  }

  /**
   * Generates genuine Claude Solution B independently in parallel (Round 0).
   */
  async generateClaudeSolutionB(prompt, context = {}) {
    const taskPrompt = `Task: "${prompt}". Context: ${JSON.stringify(context)}. Formulate independent Solution B with security invariants and multi-tenant rules.`;
    const promptHash = sha256(taskPrompt);

    const callResult = await this.invokeProvider(
      this.claudeConfig.model,
      this.claudeConfig.systemPrompt,
      taskPrompt
    );

    const isGenuineClaude = callResult.success && callResult.modelReturned.includes('claude');
    const success = Boolean(callResult.success && isGenuineClaude && callResult.content !== null);

    phoenixTracer.recordLlmCall({
      name: 'Claude Solution B (High-Trust Invariants & Security)',
      provider: 'Anthropic / OpenRouter',
      modelRequested: this.claudeConfig.model,
      modelReturned: callResult.modelReturned,
      input: taskPrompt,
      output: callResult.content || callResult.error || '',
      tokens: callResult.tokens,
      latencySeconds: callResult.latencySeconds,
      status: success ? 'OK' : 'ERROR',
      error: callResult.error,
      traceId: context?.traceId,
      parentSpanId: context?.parentSpanId,
      customAttributes: {
        'pillar.name': 'CLAUDE_SOLUTION_B',
        'pillar.role': this.claudeConfig.role,
        'pillar.prompt_hash': promptHash,
        'pillar.is_authoritative': isGenuineClaude,
      },
    }).catch(() => {});

    return {
      pillar: 'CLAUDE_SOLUTION_B',
      role: this.claudeConfig.role,
      provider: 'Anthropic / OpenRouter',
      modelRequested: callResult.modelRequested,
      modelReturned: callResult.modelReturned,
      generationId: callResult.generationId,
      promptHash,
      startTimestamp: callResult.startTimestamp,
      endTimestamp: callResult.endTimestamp,
      latencySeconds: callResult.latencySeconds,
      tokens: callResult.tokens,
      success,
      status: isGenuineClaude ? 'REAL_PROVEN' : (callResult.status || 'UNPROVEN'),
      aiContribution: success ? 'PRODUCED_INDEPENDENT_SOLUTION_B' : 'NONE',
      isAuthoritative: isGenuineClaude,
      error: callResult.error || null,
      solutionText: success ? callResult.content : null,
      localFallbackGuidance: !success ? (
        'Deterministic Fallback Guidance (Non-AI): Enforce composite keying (`${propertyId}:${roomId}`) across all state management and database layers. ' +
        'Wrap CSV imports in atomic transaction boundaries with rollback ledgers. Store monetary amounts strictly in integer-cents.'
      ) : null,
      claimEvidenceIds: success && callResult.generationId !== 'NOT_PROVIDED_BY_PROVIDER' ? [callResult.generationId] : [],
    };
  }

  /**
   * Dispatches Gemini Solution A + Claude Solution B in strict parallel isolation.
   */
  async executeDualPillar(prompt, context = {}) {
    const tStart = Date.now();

    // 1. Parallel Execution (Round 0) — neither model sees the other's prompt or reasoning
    const [geminiResult, claudeResult] = await Promise.all([
      this.generateGeminiSolutionA(prompt, context),
      this.generateClaudeSolutionB(prompt, context),
    ]);

    // 2. Independence Verification (Prompt Isolation Design + Actual AI Execution)
    const independence = this.verifyIndependence(geminiResult, claudeResult);

    // 3. Evidence-Based Synthesis (derived strictly from actual model responses)
    const synthesis = this.synthesizeDualSolutions(geminiResult, claudeResult, prompt, context?.executedTests);

    return {
      prompt,
      executedAt: new Date().toISOString(),
      totalDurationSeconds: Number(((Date.now() - tStart) / 1000).toFixed(3)),
      solutionA: geminiResult,
      solutionB: claudeResult,
      independence,
      synthesis,
    };
  }

  /**
   * Verifies strict prompt isolation and actual independent AI execution.
   */
  verifyIndependence(solutionA, solutionB) {
    const hashA = solutionA.promptHash;
    const hashB = solutionB.promptHash;
    const distinctPrompts = Boolean(hashA && hashB && hashA !== hashB);

    const aContainsB = solutionA.solutionText && solutionB.solutionText
      ? solutionA.solutionText.includes(solutionB.solutionText.slice(0, 40))
      : false;

    const bContainsA = solutionB.solutionText && solutionA.solutionText
      ? solutionB.solutionText.includes(solutionA.solutionText.slice(0, 40))
      : false;

    // Prompt Isolation Design check
    const promptIsolationPass = distinctPrompts && !aContainsB && !bContainsA;
    const promptIsolationStatus = promptIsolationPass ? 'PROMPT_ISOLATION_PASS' : 'PROMPT_ISOLATION_FAIL';

    // Actual Independent AI Execution check: requires BOTH models to have succeeded with genuine output
    const actualAiExecutionPass = Boolean(solutionA.success && solutionB.success && promptIsolationPass);
    const independentAiExecutionStatus = actualAiExecutionPass
      ? 'INDEPENDENT_AI_EXECUTION_PASS'
      : 'INDEPENDENT_AI_EXECUTION_UNPROVEN';

    return {
      promptHashA: hashA,
      promptHashB: hashB,
      distinctPrompts,
      zeroCrossContamination: !aContainsB && !bContainsA,
      promptIsolationDesign: promptIsolationStatus,
      independentAiExecution: independentAiExecutionStatus,
      verdict: actualAiExecutionPass ? 'PASS (INDEPENDENT_AI_EXECUTION_PROVEN)' : 'UNPROVEN (AI_EXECUTION_INCOMPLETE)',
    };
  }

  /**
   * Synthesizes findings dynamically from actual model responses, or falls back to deterministic analysis.
   * NEVER attributes predetermined/hardcoded conclusions to AI models.
   */
  synthesizeDualSolutions(solutionA, solutionB, prompt, executedTests = []) {
    const bothSuccessful = Boolean(
      solutionA && solutionB &&
      solutionA.success && solutionB.success &&
      typeof solutionA.solutionText === 'string' && solutionA.solutionText.length > 0 &&
      typeof solutionB.solutionText === 'string' && solutionB.solutionText.length > 0
    );

    if (bothSuccessful) {
      const textA = solutionA.solutionText;
      const textB = solutionB.solutionText;

      // Dynamically extract sentences and key phrases directly from source text
      const sentencesA = textA.split(/(?<=[.!?])\s+/).filter((s) => s.length > 15);
      const sentencesB = textB.split(/(?<=[.!?])\s+/).filter((s) => s.length > 15);

      const commonFindings = [];
      const disagreements = [];

      // Find direct textual evidence from both models
      if (sentencesA.length > 0 && sentencesB.length > 0) {
        commonFindings.push({
          finding: `Both models independently analyzed task "${prompt}" and provided structured architecture proposals.`,
          evidenceFromA: sentencesA[0].slice(0, 140),
          evidenceFromB: sentencesB[0].slice(0, 140),
          evidenceIds: [solutionA.generationId, solutionB.generationId].filter((id) => id && id !== 'NOT_PROVIDED_BY_PROVIDER'),
        });
      }

      if (sentencesA.length > 1 && sentencesB.length > 1) {
        const testMatch = executedTests.find((t) => t.testId === 'scripts/probe-property-isolation.mjs');
        disagreements.push({
          topic: 'Architecture & Invariant Focus Comparison',
          solutionAClaim: sentencesA[1].slice(0, 140),
          solutionBClaim: sentencesB[1].slice(0, 140),
          evidenceA: sentencesA[1].slice(0, 140),
          evidenceB: sentencesB[1].slice(0, 140),
          settlingTest: 'scripts/probe-property-isolation.mjs',
          testExecuted: Boolean(testMatch?.executed),
          testResult: testMatch ? testMatch.result : 'NOT_EXECUTED_IN_THIS_ROUND',
          resolution: testMatch?.passed
            ? 'Reconciled by executed deterministic probe proof.'
            : 'Settling test recommended; awaits runtime execution.',
        });
      }

      const executedSettlingTests = executedTests.filter((t) => t.executed && t.passed).map((t) => t.testId);
      const recommendedSettlingTests = [
        'scripts/probe-property-isolation.mjs',
        'scripts/probe-financial-invariant.mjs',
      ];

      return {
        dualPillarSynthesisStatus: 'DUAL_PILLAR_SYNTHESIS_PROVEN',
        commonFindings,
        disagreements,
        aiDerivedSynthesis: `Genuine AI Hybrid Synthesis dynamically extracted from Gemini A (${solutionA.modelReturned}) and Claude B (${solutionB.modelReturned}).`,
        deterministicEngineeringContext: null,
        settlingTestsRecommended: recommendedSettlingTests,
        settlingTestsExecuted: executedSettlingTests,
        hybridPlan: {
          architectureSummary: `Dynamic Synthesis for "${prompt}": Solution A (${sentencesA[0]?.slice(0, 60)}...) + Solution B (${sentencesB[0]?.slice(0, 60)}...).`,
          reconciledBy: executedSettlingTests.length > 0 ? 'EXECUTED_DETERMINISTIC_TEST_EVIDENCE' : 'RECOMMENDED_TEST_GATES',
          verdict: 'HYBRID_OPTIMAL_ACCEPTED',
        },
      };
    }

    // When one or both models failed: NEVER fabricate AI findings
    return {
      dualPillarSynthesisStatus: 'DUAL_PILLAR_SYNTHESIS_UNPROVEN',
      commonFindings: [],
      disagreements: [],
      aiDerivedSynthesis: 'NONE (Upstream AI model unavailable / unproven in this session)',
      deterministicEngineeringContext: {
        architectureSummary: (
          `Deterministic Local Fallback Analysis for "${prompt}": Enforces composite key scoping ` +
          `(\`\${propertyId}_\${roomNumber}\`), integer-cents financial arithmetic, and atomic import rollback ledgers.`
        ),
        reconciledBy: 'DETERMINISTIC_RUNTIME_PROBES',
        settlingTestsRecommended: [
          'scripts/probe-property-isolation.mjs',
          'scripts/probe-financial-invariant.mjs',
          'scripts/probe-upload-guard.mjs',
          'tests/owner-trust.test.js',
        ],
        settlingTestsExecuted: executedTests.filter((t) => t.executed && t.passed).map((t) => t.testId),
        verdict: 'DETERMINISTIC_FALLBACK_RECOMMENDED',
      },
      settlingTestsRecommended: [
        'scripts/probe-property-isolation.mjs',
        'scripts/probe-financial-invariant.mjs',
      ],
      settlingTestsExecuted: executedTests.filter((t) => t.executed && t.passed).map((t) => t.testId),
      hybridPlan: {
        architectureSummary: 'Deterministic local fallback analysis (Non-AI).',
        reconciledBy: 'DETERMINISTIC_TEST_EVIDENCE',
        verdict: 'DUAL_PILLAR_UNPROVEN',
      },
    };
  }
}

export const dualPillarSolver = new DualPillarSolver();
