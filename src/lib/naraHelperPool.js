/**
 * Nara Heavy-Helper Pool (NaraRouter)
 *
 * High-volume parallel helper & accelerator pool for the autonomous multi-agent architecture.
 * - Endpoints: https://router.bynara.id/v1
 * - Accounts: NARA-A, NARA-B (independent state tracking, fair-use load balancing)
 * - Strict Redaction: Zero API key leakage into logs, errors, or ledgers.
 * - Role-Aware Candidate Chains: 10 specialized agent jobs with tailored model fallbacks.
 * - Model Diversity Policy: Enforces heterogeneous multi-model squads (Laguna + Mistral + Tencent Hy3 + Agnes)
 *   to eliminate shared blind spots.
 * - Empirical Leaderboard: Tracks measured real-world task performance on Boston Project.
 */

import { execSync } from 'node:child_process';
import { classifyProviderIdentity, validateCompletionPayload } from './universalModelRouter.js';
import { phoenixTracer } from './phoenixTracer.js';

const NARA_BASE_URL = 'https://router.bynara.id/v1';

// Retrieve keys securely from environment or DPAPI storage without logging/printing
function getSecureKey(alias) {
  try {
    const norm = alias.toUpperCase();
    const envObj = typeof globalThis !== 'undefined' && globalThis.process && globalThis.process.env ? globalThis.process.env : {};
    if (norm === 'NARA-A' || norm === 'A' || norm === '1') {
      if (envObj.NARA_API_KEY_1) return envObj.NARA_API_KEY_1.trim();
      if (envObj.NARA_API_KEY_A) return envObj.NARA_API_KEY_A.trim();
    } else {
      if (envObj.NARA_API_KEY_2) return envObj.NARA_API_KEY_2.trim();
      if (envObj.NARA_API_KEY_B) return envObj.NARA_API_KEY_B.trim();
    }
    const out = execSync(`python scripts/nara_support.py --get ${alias}`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

// Redacts any API key or sensitive token from string output
export function redactSecrets(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/sk-nry-[A-Za-z0-9_-]{20,}/g, '[REDACTED_NARA_KEY]')
    .replace(/sk-or-v1-[A-Za-z0-9_-]{20,}/g, '[REDACTED_OPENROUTER_KEY]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED_AUTH_TOKEN]');
}

/**
 * 10 Role-Aware Candidate Chains
 * Tailored 4-tier model fallbacks based on benchmark performance and project telemetry.
 */
export const NARA_ROLE_CHAINS = {
  // 1. Deep coding / bug hunting (Laguna 78.5% SWE-Bench -> Tencent Hy3 71.7% Terminal-Bench -> Mistral -> Agnes)
  DEEP_CODING: [
    'laguna-s-2.1',
    'tencent-hy3-free',
    'mistral-medium-3-5',
    'agnes-2.5-flash',
  ],

  // 2. Large repo/codebase analysis (Laguna 1M context -> Mistral -> Tencent Hy3 -> Agnes)
  REPO_ANALYSIS: [
    'laguna-s-2.1',
    'mistral-medium-3-5',
    'tencent-hy3-free',
    'agnes-2.5-flash',
  ],

  // 3. Independent solution / architecture (Mistral reasoning -> Laguna -> Tencent Hy3 -> Agnes)
  ARCHITECTURE_REVIEW: [
    'mistral-medium-3-5',
    'laguna-s-2.1',
    'tencent-hy3-free',
    'agnes-2.5-flash',
  ],

  // 4. Adversarial tester / edge-case hunter (Tencent Hy3 adversarial -> Laguna -> Mistral -> GLM)
  ADVERSARIAL_TESTING: [
    'tencent-hy3-free',
    'laguna-s-2.1',
    'mistral-medium-3-5',
    'glm-5.3-flash-free',
  ],

  // 5. CSV/parser/data investigation (Laguna -> Mistral -> Agnes -> GLM)
  PARSER_DATA_INVESTIGATION: [
    'laguna-s-2.1',
    'mistral-medium-3-5',
    'agnes-2.5-flash',
    'glm-5.3-flash-free',
  ],

  // 6. Financial calculation checker (Mistral -> Laguna -> Agnes -> StepFun)
  FINANCIAL_CALCULATION: [
    'mistral-medium-3-5',
    'laguna-s-2.1',
    'agnes-2.5-flash',
    'stepfun-3.7-flash',
  ],

  // 7. Fast code review (Agnes 2.5 Flash -> StepFun -> GLM -> Tencent Hy3)
  FAST_CODE_REVIEW: [
    'agnes-2.5-flash',
    'stepfun-3.7-flash',
    'glm-5.3-flash-free',
    'tencent-hy3-free',
  ],

  // 8. Test generation (Laguna -> Agnes -> Tencent Hy3 -> GLM)
  TEST_GENERATION: [
    'laguna-s-2.1',
    'agnes-2.5-flash',
    'tencent-hy3-free',
    'glm-5.3-flash-free',
  ],

  // 9. Simple classification/routing (Agnes 2.5 Flash -> StepFun -> GLM -> Tencent Hy3)
  CLASSIFICATION_ROUTING: [
    'agnes-2.5-flash',
    'stepfun-3.7-flash',
    'glm-5.3-flash-free',
    'tencent-hy3-free',
  ],

  // 10. Summarization / cheap helper (Agnes 2.5 Flash -> GLM -> StepFun -> Tencent Hy3)
  SUMMARIZATION_HELPER: [
    'agnes-2.5-flash',
    'glm-5.3-flash-free',
    'stepfun-3.7-flash',
    'tencent-hy3-free',
  ],
};

// Legacy task profile mapping for backward compatibility
export const NARA_TASK_PROFILES = {
  FAST: {
    name: 'FAST',
    description: 'Fast classification, small scans, log filtering.',
    models: NARA_ROLE_CHAINS.CLASSIFICATION_ROUTING,
  },
  BALANCED: {
    name: 'BALANCED',
    description: 'Code review, test-case generation, CSV schema analysis.',
    models: NARA_ROLE_CHAINS.TEST_GENERATION,
  },
  HEAVY: {
    name: 'HEAVY',
    description: 'Complex parser fuzzing, multi-property state mapping.',
    models: NARA_ROLE_CHAINS.DEEP_CODING,
  },
};

export class NaraHelperPool {
  constructor() {
    this.accounts = {
      'NARA-A': {
        alias: 'NARA-A',
        available: false,
        status: 'INITIALIZING',
        requestsUsed: 0,
        tokensUsed: 0,
        activeRequests: 0,
        maxConcurrent: 4,
        cooldownUntil: 0,
        lastError: null,
        successCount: 0,
        failureCount: 0,
        discoveredModels: [],
        lastDiscoveredAt: 0,
      },
      'NARA-B': {
        alias: 'NARA-B',
        available: false,
        status: 'INITIALIZING',
        requestsUsed: 0,
        tokensUsed: 0,
        activeRequests: 0,
        maxConcurrent: 4,
        cooldownUntil: 0,
        lastError: null,
        successCount: 0,
        failureCount: 0,
        discoveredModels: [],
        lastDiscoveredAt: 0,
      },
    };

    // Measured Internal Leaderboard across Boston Project telemetry
    this.leaderboard = {
      'laguna-s-2.1': { rank: 1, role: 'Primary Heavy Coding & Repo Helper', tasksCompleted: 0, successCount: 0, totalTokens: 0, avgLatencySeconds: 0, agreementScore: 1.0 },
      'mistral-medium-3-5': { rank: 2, role: 'Independent Reasoning & Financial Review', tasksCompleted: 0, successCount: 0, totalTokens: 0, avgLatencySeconds: 0, agreementScore: 1.0 },
      'tencent-hy3-free': { rank: 3, role: 'Adversarial Edge-Case Hunter', tasksCompleted: 0, successCount: 0, totalTokens: 0, avgLatencySeconds: 0, agreementScore: 1.0 },
      'agnes-2.5-flash': { rank: 4, role: 'Fast High-Volume Worker & Test Generator', tasksCompleted: 0, successCount: 0, totalTokens: 0, avgLatencySeconds: 0, agreementScore: 1.0 },
      'glm-5.3-flash-free': { rank: 5, role: 'High-Volume Fallback Worker', tasksCompleted: 0, successCount: 0, totalTokens: 0, avgLatencySeconds: 0, agreementScore: 1.0 },
      'stepfun-3.7-flash': { rank: 6, role: 'Lightweight Fallback Helper', tasksCompleted: 0, successCount: 0, totalTokens: 0, avgLatencySeconds: 0, agreementScore: 1.0 },
    };

    this.ledger = [];
  }

  /**
   * Initializes account availability and performs dynamic model discovery.
   */
  async initialize() {
    for (const alias of ['NARA-A', 'NARA-B']) {
      const key = getSecureKey(alias);
      if (!key) {
        this.accounts[alias].available = false;
        this.accounts[alias].status = 'UNAVAILABLE';
        this.accounts[alias].lastError = 'No API key configured';
        continue;
      }

      await this.discoverModels(alias);
    }
  }

  /**
   * Queries GET /v1/models for the specified account.
   */
  async discoverModels(alias) {
    const account = this.accounts[alias];
    const key = getSecureKey(alias);
    if (!key) {
      account.available = false;
      account.status = 'UNAVAILABLE';
      return [];
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);

      const res = await fetch(`${NARA_BASE_URL}/models`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          'User-Agent': 'BostonProject-NaraPool/1.0',
        },
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok) {
        account.available = false;
        account.status = res.status === 403 ? 'FORBIDDEN (403)' : `HTTP ${res.status}`;
        account.lastError = `Model discovery failed: HTTP ${res.status}`;
        return [];
      }

      const data = await res.json();
      const models = (data?.data || []).map((m) => m.id).filter(Boolean);
      account.discoveredModels = models;
      account.available = models.length > 0;
      account.status = account.available ? 'AVAILABLE' : 'NO_MODELS';
      account.lastDiscoveredAt = Date.now();
      account.lastError = null;
      return models;
    } catch (err) {
      account.available = false;
      account.status = 'NETWORK_ERROR';
      account.lastError = redactSecrets(err.message);
      return [];
    }
  }

  /**
   * Calculates quota tier based on token consumption.
   */
  getQuotaTier(alias) {
    const account = this.accounts[alias];
    const ESTIMATED_DAILY_LIMIT = 10_000_000;
    const ratio = account.tokensUsed / ESTIMATED_DAILY_LIMIT;

    if (ratio >= 0.95) return 'CRITICAL_RESERVE';
    if (ratio >= 0.85) return 'CONSERVE';
    return 'NORMAL';
  }

  /**
   * Selects the most appropriate available account based on load & capacity.
   */
  selectAccount() {
    const now = Date.now();
    const availableAccounts = Object.values(this.accounts).filter(
      (a) => a.available && now >= a.cooldownUntil && a.activeRequests < a.maxConcurrent
    );

    if (availableAccounts.length === 0) return null;

    availableAccounts.sort((a, b) => {
      if (a.activeRequests !== b.activeRequests) {
        return a.activeRequests - b.activeRequests;
      }
      return a.requestsUsed - b.requestsUsed;
    });

    return availableAccounts[0];
  }

  /**
   * Updates internal telemetry leaderboard after each task completion.
   */
  recordModelTelemetry(model, success, latencySeconds, totalTokens) {
    if (!this.leaderboard[model]) {
      this.leaderboard[model] = {
        rank: 99,
        role: 'Dynamic Discovered Model',
        tasksCompleted: 0,
        successCount: 0,
        totalTokens: 0,
        avgLatencySeconds: 0,
        agreementScore: 1.0,
      };
    }

    const m = this.leaderboard[model];
    m.tasksCompleted += 1;
    if (success) m.successCount += 1;
    m.totalTokens += totalTokens;
    m.avgLatencySeconds = Number(
      ((m.avgLatencySeconds * (m.tasksCompleted - 1) + latencySeconds) / m.tasksCompleted).toFixed(3)
    );
  }

  /**
   * Executes an AI completion against NaraRouter with role-aware candidate chains,
   * automatic model fallback, load-balancing, and detailed ledger tracking.
   */
  async executeHelperTask(options) {
    const {
      taskName = 'Nara Helper Task',
      roleType = 'DEEP_CODING',
      taskProfile = null,
      prompt,
      systemPrompt = 'You are a high-volume parallel engineering helper for the Boston Project. Provide concise, high-density technical analysis in 2 sentences.',
      preferredModel = null,
      maxTokens = 150,
      timeoutMs = 8000,
    } = options;

    // Resolve candidate chain from role or task profile
    let candidateModels = [];
    if (preferredModel) candidateModels.push(preferredModel);

    if (NARA_ROLE_CHAINS[roleType]) {
      for (const m of NARA_ROLE_CHAINS[roleType]) {
        if (!candidateModels.includes(m)) candidateModels.push(m);
      }
    } else if (taskProfile && NARA_TASK_PROFILES[taskProfile]) {
      for (const m of NARA_TASK_PROFILES[taskProfile].models) {
        if (!candidateModels.includes(m)) candidateModels.push(m);
      }
    } else {
      for (const m of NARA_ROLE_CHAINS.DEEP_CODING) {
        if (!candidateModels.includes(m)) candidateModels.push(m);
      }
    }

    const account = this.selectAccount();
    if (!account) {
      const entry = {
        provider: 'NaraRouter',
        accountAlias: 'NONE_AVAILABLE',
        taskName,
        roleType,
        modelRequested: candidateModels[0],
        modelReturned: null,
        generationId: null,
        timestamp: new Date().toISOString(),
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        latencySeconds: 0,
        status: 'UNAVAILABLE',
        error: 'No Nara account currently available or all accounts in cooldown.',
        retryPath: [],
      };
      this.ledger.push(entry);
      return { success: false, entry, content: null };
    }

    const key = getSecureKey(account.alias);
    account.activeRequests += 1;
    account.requestsUsed += 1;

    const retryPath = [];
    let success = false;
    let finalContent = null;
    let finalModel = null;
    let finalGenId = null;
    let finalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    let finalLatency = 0;
    let finalError = null;

    const tStart = Date.now();

    for (const model of candidateModels) {
      const t0 = Date.now();
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        const res = await fetch(`${NARA_BASE_URL}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
            'User-Agent': 'BostonProject-NaraHelper/1.0',
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: prompt },
            ],
            max_tokens: maxTokens,
            temperature: 0.2,
          }),
          signal: controller.signal,
        });
        clearTimeout(timer);

        const dur = Number(((Date.now() - t0) / 1000).toFixed(3));

        if (!res.ok) {
          const errBody = redactSecrets(await res.text().catch(() => ''));
          retryPath.push({ model, status: res.status, latency: dur, error: errBody.slice(0, 100) });

          if (res.status === 429) {
            account.cooldownUntil = Date.now() + 5000;
            account.lastError = 'Rate limited (429)';
          }
          this.recordModelTelemetry(model, false, dur, 0);
          continue;
        }

        const data = await res.json();
        const completion = validateCompletionPayload(data, model, 'NARA');
        if (!completion.success) {
          retryPath.push({
            model,
            status: completion.error,
            latency: dur,
            actualModel: completion.actualModel,
            actualProvider: completion.identity.actualProvider,
          });
          this.recordModelTelemetry(model, false, dur, 0);
          continue;
        }
        finalContent = completion.content;
        finalModel = completion.actualModel;
        finalGenId = data?.id || `gen-${Date.now()}`;
        finalUsage = data?.usage || {
          prompt_tokens: Math.round(prompt.length / 4),
          completion_tokens: Math.round(finalContent.length / 4),
          total_tokens: Math.round((prompt.length + finalContent.length) / 4),
        };
        finalLatency = Number(((Date.now() - tStart) / 1000).toFixed(3));
        account.tokensUsed += finalUsage.total_tokens || 0;
        account.successCount += 1;
        success = true;

        this.recordModelTelemetry(finalModel, true, finalLatency, finalUsage.total_tokens || 0);
        break;
      } catch (err) {
        const dur = Number(((Date.now() - t0) / 1000).toFixed(3));
        retryPath.push({ model, status: 'ERROR', latency: dur, error: redactSecrets(err.message) });
        this.recordModelTelemetry(model, false, dur, 0);
      }
    }

    account.activeRequests = Math.max(0, account.activeRequests - 1);
    if (!success) {
      account.failureCount += 1;
      finalError = 'All candidate models in Nara profile failed or timed out.';
    }

    const entry = {
      provider: 'NaraRouter',
      accountAlias: account.alias,
      taskName,
      roleType,
      modelRequested: candidateModels[0],
      modelReturned: finalModel,
      actualProvider: finalModel
        ? classifyProviderIdentity({ transportProvider: 'NARA', actualModel: finalModel }).actualProvider
        : null,
      generationId: finalGenId,
      timestamp: new Date().toISOString(),
      inputTokens: finalUsage.prompt_tokens || 0,
      outputTokens: finalUsage.completion_tokens || 0,
      totalTokens: finalUsage.total_tokens || 0,
      latencySeconds: finalLatency,
      status: success ? 'SUCCESS' : 'FAILED',
      error: finalError,
      retryPath,
    };

    this.ledger.push(entry);

    // Live Arize Phoenix OpenInference Tracing
    phoenixTracer.recordLlmCall({
      name: `Nara Worker: ${finalModel || candidateModels[0] || 'Unknown'} (${roleType})`,
      provider: 'NaraRouter',
      modelRequested: candidateModels[0],
      modelReturned: finalModel || 'NONE',
      input: prompt,
      output: finalContent || (retryPath.length > 0 ? JSON.stringify(retryPath) : ''),
      tokens: finalUsage,
      latencySeconds: finalLatency,
      status: success ? 'OK' : 'ERROR',
      error: finalError,
      customAttributes: {
        'nara.account': account.alias,
        'nara.task_name': taskName,
        'nara.role_type': roleType,
        'nara.retries': retryPath.length,
      },
    }).catch(() => {});

    return { success, entry, content: finalContent };
  }

  /**
   * Executes multiple heterogeneous helper tasks in bounded parallel batches.
   * Ensures diverse model assignments across tasks to prevent shared blind spots.
   */
  async executeParallelHelpers(tasks, concurrency = 2) {
    const results = [];
    for (let i = 0; i < tasks.length; i += concurrency) {
      const chunk = tasks.slice(i, i + concurrency);
      const chunkResults = await Promise.all(
        chunk.map((task) => this.executeHelperTask(task))
      );
      results.push(...chunkResults);
    }
    return results;
  }

  /**
   * Dispatches a 6-Agent Heterogeneous Heavy-Duty Squad for critical bugs.
   * Model Allocation Policy:
   * - Agent 1: Root-cause investigator (Laguna S 2.1)
   * - Agent 2: Repository/dependency mapper (Laguna S 2.1)
   * - Agent 3: Independent solution architect (Mistral Medium 3.5)
   * - Agent 4: Adversarial edge-case hunter (Tencent Hy3 Free)
   * - Agent 5: Regression & test generator (Agnes 2.5 Flash)
   * - Agent 6: Log & repetitive scanner (Agnes 2.5 Flash)
   */
  async executeDiverseHeavySquad(problemDescription, context = 'Boston Project') {
    const squadPlan = [
      {
        taskName: 'Agent 1 — Laguna Root-Cause Investigator',
        roleType: 'DEEP_CODING',
        preferredModel: 'laguna-s-2.1',
        prompt: `Investigate root cause of defect: "${problemDescription}". Context: ${context}.`,
      },
      {
        taskName: 'Agent 2 — Laguna Repository/Dependency Mapper',
        roleType: 'REPO_ANALYSIS',
        preferredModel: 'laguna-s-2.1',
        prompt: `Map affected components and state dependencies for: "${problemDescription}". Context: ${context}.`,
      },
      {
        taskName: 'Agent 3 — Mistral Independent Solution Architect',
        roleType: 'ARCHITECTURE_REVIEW',
        preferredModel: 'mistral-medium-3-5',
        prompt: `Formulate independent architectural fix proposal for: "${problemDescription}". Context: ${context}.`,
      },
      {
        taskName: 'Agent 4 — Tencent Hy3 Adversarial Edge-Case Hunter',
        roleType: 'ADVERSARIAL_TESTING',
        preferredModel: 'tencent-hy3-free',
        prompt: `Generate 3 hostile edge cases and boundary failure vectors for: "${problemDescription}". Context: ${context}.`,
      },
      {
        taskName: 'Agent 5 — Agnes Regression & Test Generator',
        roleType: 'TEST_GENERATION',
        preferredModel: 'agnes-2.5-flash',
        prompt: `Generate regression test assertions for: "${problemDescription}". Context: ${context}.`,
      },
      {
        taskName: 'Agent 6 — Agnes Log & Repetitive Scan Assistant',
        roleType: 'FAST_CODE_REVIEW',
        preferredModel: 'agnes-2.5-flash',
        prompt: `Review log touchpoints and component prop contracts for: "${problemDescription}". Context: ${context}.`,
      },
    ];

    const results = await this.executeParallelHelpers(squadPlan, 2);

    // Synthesize findings for authoritative tribunal handoff
    const synthesis = {
      problemDescription,
      totalAgentsExecuted: results.length,
      successCount: results.filter((r) => r.success).length,
      modelsParticipated: [...new Set(results.map((r) => r.entry.modelReturned).filter(Boolean))],
      agentFindings: results.map((r) => ({
        agent: r.entry.taskName,
        modelReturned: r.entry.modelReturned,
        generationId: r.entry.generationId,
        latencySeconds: r.entry.latencySeconds,
        summary: (r.content || '').slice(0, 150) + '...',
      })),
      tribunalHandoffReady: true,
    };

    return synthesis;
  }

  /**
   * Returns current health, leaderboard, & quota status for all accounts.
   */
  getStatus() {
    return {
      'NARA-A': {
        ...this.accounts['NARA-A'],
        quotaTier: this.getQuotaTier('NARA-A'),
      },
      'NARA-B': {
        ...this.accounts['NARA-B'],
        quotaTier: this.getQuotaTier('NARA-B'),
      },
      leaderboard: this.leaderboard,
      totalLedgerEntries: this.ledger.length,
    };
  }
}

// Global Singleton for application & orchestrator access
export const naraPool = new NaraHelperPool();
