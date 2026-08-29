/**
 * FallbackPolicy
 * --------------
 * Implements Active-Active Claude Opus execution, bounded retries,
 * and strict provider failover rules across Tabitoken and GoRouter.
 */

import { defaultActiveRouter } from '../routing/ActiveActiveRouter.js';
import { CLAUDE_OPUS_CANDIDATE_ROUTES } from '../providers/ProviderRegistry.js';

export class FallbackPolicy {
  constructor(options = {}) {
    this.maxRetriesPerProvider = options.maxRetriesPerProvider || 2;
    this.timeoutMs = options.timeoutMs || 180000;
    this.retryDelayMs = options.retryDelayMs !== undefined ? options.retryDelayMs : 1000;
    this.router = options.router || defaultActiveRouter;
  }

  /**
   * Executes an authoritative Claude Opus task with Active-Active load balancing and dynamic failover.
   */
  async executeAuthoritativeClaude(registry, taskOptions) {
    const {
      prompt,
      systemPrompt,
      context,
      maxTokens = 4000,
      taskId = null,
      preferredProvider = null,
      customCandidateRoutes = null,
      timeoutMs = this.timeoutMs,
      role = 'PRIMARY_ARCHITECT_AND_AUTHOR',
      agentNumber = 1,
      workstream = 'Authoritative Synthesis',
    } = taskOptions;

    const attempts = [];
    const tStartTotal = Date.now();
    const dispatchIso = new Date(tStartTotal).toISOString();

    // 1. First attempt Active-Active balanced selection between TABITOKEN and GOROUTER
    const activeRoute = this.router.selectProviderForClaude({ preferredProvider });
    const primaryChain = [];

    if (activeRoute) {
      primaryChain.push({
        provider: activeRoute.provider,
        model: activeRoute.model,
        note: `Active-Active ${activeRoute.provider} (${activeRoute.reason})`,
      });
      primaryChain.push({
        provider: activeRoute.provider,
        model: 'claude-opus-4-8',
        note: `${activeRoute.provider} Opus 4.8`,
      });
      const sibling = activeRoute.provider === 'TABITOKEN' ? 'GOROUTER' : 'TABITOKEN';
      primaryChain.push({
        provider: sibling,
        model: 'claude-opus-5',
        note: `Active-Active Sibling Failover ${sibling}`,
      });
      primaryChain.push({
        provider: sibling,
        model: 'claude-opus-4-8',
        note: `${sibling} Opus 4.8`,
      });
    }

    const fallbackRoutes = Array.isArray(customCandidateRoutes) && customCandidateRoutes.length > 0
      ? customCandidateRoutes
      : CLAUDE_OPUS_CANDIDATE_ROUTES;

    const combinedRoutes = Array.isArray(customCandidateRoutes) && customCandidateRoutes.length > 0
      ? customCandidateRoutes
      : primaryChain;

    if (!Array.isArray(customCandidateRoutes)) {
      for (const r of fallbackRoutes) {
        if (!combinedRoutes.some((c) => c.provider === r.provider && c.model === r.model)) {
          combinedRoutes.push(r);
        }
      }
    }

    for (let routeIdx = 0; routeIdx < combinedRoutes.length; routeIdx++) {
      const { provider, model, note } = combinedRoutes[routeIdx];

      for (let attemptNum = 1; attemptNum <= this.maxRetriesPerProvider; attemptNum++) {
        const tCallStart = Date.now();
        const startIso = new Date(tCallStart).toISOString();

        this.router.recordRequestStart(provider);

        const callResult = await registry.callAgent({
          role,
          provider,
          model,
          prompt,
          systemPrompt,
          context,
          maxTokens,
          timeoutMs,
          taskId,
        });

        const tCallFinish = Date.now();
        const finishIso = new Date(tCallFinish).toISOString();
        const latencySec = callResult.latencySeconds || Number(((tCallFinish - tCallStart) / 1000).toFixed(3));

        const isGenuineClaude = callResult.success && (
          callResult.actualProvider === 'ANTHROPIC' ||
          String(callResult.modelReturned).toLowerCase().includes('claude') ||
          String(callResult.generationId || '').startsWith('msg_')
        );

        this.router.recordRequestOutcome(provider, {
          ...callResult,
          success: callResult.success && isGenuineClaude,
          latencySeconds: latencySec,
        });

        const attemptRecord = {
          agentNumber,
          role,
          workstream,
          provider,
          modelRequested: model,
          modelReturned: callResult.modelReturned,
          actualProvider: isGenuineClaude ? 'ANTHROPIC' : callResult.actualProvider,
          transportProvider: callResult.transportProvider || provider,
          upstreamProvider: callResult.upstreamProvider,
          generationId: callResult.generationId,
          attemptNum,
          dispatchTimestamp: dispatchIso,
          startTimestamp: startIso,
          completionTimestamp: finishIso,
          latencySeconds: latencySec,
          success: callResult.success && isGenuineClaude,
          httpStatus: callResult.httpStatus,
          error: callResult.error,
          usage: callResult.usage,
          cost: callResult.cost,
          note,
          content: callResult.content,
        };

        attempts.push(attemptRecord);

        if (callResult.success && isGenuineClaude) {
          return {
            success: true,
            status: 'PROVEN',
            content: callResult.content,
            authoritativeModel: callResult.modelReturned,
            actualProvider: 'ANTHROPIC',
            transportProvider: callResult.transportProvider || provider,
            upstreamProvider: callResult.upstreamProvider,
            generationId: callResult.generationId,
            usage: callResult.usage,
            cost: callResult.cost,
            dispatchTimestamp: dispatchIso,
            startTimestamp: startIso,
            completionTimestamp: finishIso,
            totalLatencySeconds: Number(((Date.now() - tStartTotal) / 1000).toFixed(3)),
            totalAttempts: attempts.length,
            attempts,
            error: null,
          };
        }

        if (callResult.httpStatus === 401 || callResult.httpStatus === 404 || callResult.httpStatus === 'MISSING_KEY') {
          break;
        }

        if (attemptNum < this.maxRetriesPerProvider && this.retryDelayMs > 0) {
          await new Promise((r) => setTimeout(r, this.retryDelayMs * attemptNum));
        }
      }
    }

    return {
      success: false,
      status: 'UNAVAILABLE',
      content: null,
      authoritativeModel: null,
      actualProvider: 'NONE',
      transportProvider: 'NONE',
      upstreamProvider: null,
      generationId: null,
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      cost: null,
      totalLatencySeconds: Number(((Date.now() - tStartTotal) / 1000).toFixed(3)),
      totalAttempts: attempts.length,
      attempts,
      error: 'ALL_CLAUDE_OPUS_ROUTES_EXHAUSTED: No genuine Claude Opus provider route was reachable.',
    };
  }

  async executeParallelClaudeWave(registry, wavePlan, baseTaskOptions) {
    const { prompt, context, taskId = null } = baseTaskOptions;
    const workerCount = wavePlan.length;
    const assignments = this.router.planParallelClaudeWave(workerCount);

    const workerPromises = wavePlan.map(async (workerCfg, idx) => {
      const assignment = assignments[idx] || { provider: idx % 2 === 0 ? 'TABITOKEN' : 'GOROUTER', model: 'claude-opus-5' };
      const systemPrompt = (
        `You are ${workerCfg.role}, an Authoritative Claude Opus Chief Architect for this repository.\n` +
        `Workstream: ${workerCfg.workstream}.\n` +
        `Focus: ${workerCfg.focus}\n` +
        `Analyze the problem deeply, determine root causes, trace all callers, and propose concrete code modifications.`
      );

      return this.executeAuthoritativeClaude(registry, {
        prompt: `### TASK OBJECTIVE:\n${prompt}\n\n### INSTRUCTION FOR ${workerCfg.role}:\nProvide your independent root-cause analysis and proposed architectural changes now:`,
        systemPrompt,
        context,
        maxTokens: 2500,
        taskId,
        preferredProvider: assignment.provider,
        role: workerCfg.role,
        agentNumber: workerCfg.agentNumber,
        workstream: workerCfg.workstream,
      });
    });

    const results = await Promise.all(workerPromises);
    return results;
  }
}
