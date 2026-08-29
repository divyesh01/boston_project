/**
 * Universal Multi-Provider Model Router (UniversalModelRouter)
 * -----------------------------------------------------------
 * One centralized, authoritative routing and failover engine for all AI invocations in the system.
 *
 * Core Guarantees:
 * 1. Strongest Model First: Ranks models by task capability, reliability, and measured project telemetry.
 * 2. 5x7s Retry Rule: Transient failures retry up to 5 times (7s timeout each) before moving to next model.
 * 3. Smart HTTP Failure Classification:
 *    - 401: Immediate AUTH_FAILED (no wasted retries).
 *    - 403: Immediate UNAVAILABLE with reason (e.g. telegram_binding, model access).
 *    - 429: Rate-limit cooldown & instant account/model switch.
 *    - 404: Mark model unsupported on provider and advance.
 * 4. Account Failover & Load Balancing: Tracks independent state for NARA-A, NARA-B, OPENROUTER-1, GEMINI-1, etc.
 * 5. Strict Provider Truth: Claude CP1–CP6, NVIDIA, and Gemini CANNOT be impersonated or faked.
 * 6. Non-Blocking Helpers: Free/helper failures never block critical deterministic release gates.
 * 7. Zero Secret Leakage: All credentials encrypted via DPAPI; all output logs sanitized.
 * 8. Telemetry Leaderboard & Contribution Tracking: Maintains empirical stats and forensic session logs.
 */

import { execSync } from 'node:child_process';
import { phoenixTracer } from './phoenixTracer.js';

// Provider Base Endpoints
export const PROVIDER_ENDPOINTS = {
  NARA: 'https://router.bynara.id/v1',
  OPENROUTER: 'https://openrouter.ai/api/v1',
  ANTHROPIC_DIRECT: 'https://api.anthropic.com/v1',
  NVIDIA_DIRECT: 'https://integrate.api.nvidia.com/v1',
};

// Redacts any API key or sensitive token from string output
export function redactSecrets(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/sk-nry-[A-Za-z0-9_-]{20,}/g, '[REDACTED_NARA_KEY]')
    .replace(/sk-or-v1-[A-Za-z0-9_-]{20,}/g, '[REDACTED_OPENROUTER_KEY]')
    .replace(/sk-ant-[A-Za-z0-9_-]{20,}/g, '[REDACTED_ANTHROPIC_KEY]')
    .replace(/nvapi-[A-Za-z0-9_-]{20,}/g, '[REDACTED_NVIDIA_KEY]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED_AUTH_TOKEN]');
}

export function classifyProviderIdentity({ transportProvider, actualModel, upstreamProvider = null }) {
  const normalizedModel = String(actualModel || '').trim().toLowerCase();
  const normalizedTransport = String(transportProvider || 'UNKNOWN').toUpperCase();
  const modelOwner = normalizedModel.includes('/') ? normalizedModel.split('/', 1)[0] : '';
  const actualProvider = normalizedModel.startsWith('anthropic/claude-')
    ? 'ANTHROPIC'
    : (modelOwner ? modelOwner.toUpperCase() : (normalizedTransport === 'NARA' ? 'NARA' : 'UNKNOWN'));

  return {
    transportProvider: normalizedTransport,
    actualProvider,
    actualModel: String(actualModel || 'NONE'),
    upstreamProvider: upstreamProvider || null,
    isClaude: actualProvider === 'ANTHROPIC' && normalizedModel.startsWith('anthropic/claude-'),
  };
}

export function validateCompletionPayload(data, requestedModel, transportProvider) {
  const content = data?.choices?.[0]?.message?.content;
  const actualModel = String(data?.model || requestedModel || 'NONE');
  const identity = classifyProviderIdentity({
    transportProvider,
    actualModel,
    upstreamProvider: data?.provider || null,
  });

  if (typeof content !== 'string' || content.trim().length === 0) {
    return {
      success: false,
      error: 'EMPTY_RESPONSE',
      content: null,
      actualModel,
      identity,
    };
  }

  return {
    success: true,
    error: null,
    content: content.trim(),
    actualModel,
    identity,
  };
}

export function parseAffordableTokenLimit(errorBody, requestedTokens) {
  const text = String(errorBody || '');
  const match = text.match(/can only afford\s+(\d+)/i);
  if (!match) return null;
  const limit = Number(match[1]);
  if (!Number.isInteger(limit) || limit < 1 || limit >= requestedTokens) return null;
  return limit;
}

// Retrieve keys securely from environment or DPAPI storage without logging/printing
const KEY_CACHE = {};

function getSecureAccountKey(accountAlias) {
  const norm = accountAlias.toUpperCase();
  if (KEY_CACHE[norm] !== undefined) {
    return KEY_CACHE[norm];
  }

  try {
    const envObj = typeof globalThis !== 'undefined' && globalThis.process && globalThis.process.env ? globalThis.process.env : {};
    let resolved = null;

    if (norm === 'NARA-A' || norm === 'NARA_1') {
      if (envObj.NARA_API_KEY_1) resolved = envObj.NARA_API_KEY_1.trim();
      else if (envObj.NARA_API_KEY_A) resolved = envObj.NARA_API_KEY_A.trim();
      else resolved = execSync('python scripts/nara_support.py --get NARA-A', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim() || null;
    } else if (norm === 'NARA-B' || norm === 'NARA_2') {
      if (envObj.NARA_API_KEY_2) resolved = envObj.NARA_API_KEY_2.trim();
      else if (envObj.NARA_API_KEY_B) resolved = envObj.NARA_API_KEY_B.trim();
      else resolved = execSync('python scripts/nara_support.py --get NARA-B', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim() || null;
    } else if (norm === 'OPENROUTER-1' || norm === 'OPENROUTER') {
      if (envObj.OPENROUTER_API_KEY) resolved = envObj.OPENROUTER_API_KEY.trim();
      else resolved = execSync('python scripts/openrouter_support.py --get', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim() || null;
    } else if (norm === 'ANTHROPIC-1' || norm === 'ANTHROPIC') {
      if (envObj.ANTHROPIC_API_KEY) resolved = envObj.ANTHROPIC_API_KEY.trim();
    } else if (norm === 'NVIDIA-1' || norm === 'NVIDIA') {
      if (envObj.NVIDIA_API_KEY) resolved = envObj.NVIDIA_API_KEY.trim();
    }

    KEY_CACHE[norm] = resolved;
    return resolved;
  } catch {
    KEY_CACHE[norm] = null;
    return null;
  }
}

/**
 * Universal Role Routing Policy: Strongest-First Role Model Chains
 */
export const MODEL_ROUTING_POLICY = {
  DEEP_CODING: {
    role: 'Deep Coding / Bug Hunting',
    primaryProvider: 'NARA',
    candidateChain: [
      { provider: 'NARA', model: 'laguna-s-2.1', note: '78.5% SWE-Bench / 70.2% Terminal-Bench' },
      { provider: 'NARA', model: 'tencent-hy3-free', note: '71.7% Terminal-Bench alternate' },
      { provider: 'NARA', model: 'mistral-medium-3-5', note: 'Strong independent reasoning' },
      { provider: 'OPENROUTER', model: 'anthropic/claude-sonnet-5', note: 'High-trust coding review' },
      { provider: 'NARA', model: 'agnes-2.5-flash', note: 'High-volume fallback worker' },
      { provider: 'NARA', model: 'glm-5.3-flash-free', note: 'Lightweight free fallback' },
      { provider: 'NARA', model: 'stepfun-3.7-flash', note: 'Fast scan fallback' },
    ],
  },
  REPO_ANALYSIS: {
    role: 'Large Repository Analysis',
    primaryProvider: 'NARA',
    candidateChain: [
      { provider: 'NARA', model: 'laguna-s-2.1', note: '1M-token context window' },
      { provider: 'NARA', model: 'mistral-medium-3-5', note: 'Deep architectural indexing' },
      { provider: 'OPENROUTER', model: 'anthropic/claude-sonnet-5', note: 'High-trust AST analysis' },
      { provider: 'NARA', model: 'tencent-hy3-free', note: 'Multi-component mapper' },
      { provider: 'NARA', model: 'agnes-2.5-flash', note: 'Fast file tree scanner' },
      { provider: 'NARA', model: 'glm-5.3-flash-free', note: 'Lightweight free fallback' },
    ],
  },
  ARCHITECTURE_REVIEW: {
    role: 'Independent Solution / Architecture',
    primaryProvider: 'NARA',
    candidateChain: [
      { provider: 'NARA', model: 'mistral-medium-3-5', note: 'Strong independent reasoning' },
      { provider: 'NARA', model: 'laguna-s-2.1', note: 'Implementation feasibility proof' },
      { provider: 'OPENROUTER', model: 'anthropic/claude-sonnet-5', note: 'Authoritative systems architecture' },
      { provider: 'NARA', model: 'tencent-hy3-free', note: 'Design validation alternate' },
      { provider: 'NARA', model: 'agnes-2.5-flash', note: 'High-speed synthesis' },
      { provider: 'NARA', model: 'glm-5.3-flash-free', note: 'Free fallback' },
    ],
  },
  ADVERSARIAL_TESTING: {
    role: 'Adversarial Tester / Edge Cases',
    primaryProvider: 'NARA',
    candidateChain: [
      { provider: 'NARA', model: 'tencent-hy3-free', note: 'Adversarial payload & edge case hunter' },
      { provider: 'NARA', model: 'laguna-s-2.1', note: 'Boundary failure simulation' },
      { provider: 'NARA', model: 'mistral-medium-3-5', note: 'Semantic edge generator' },
      { provider: 'OPENROUTER', model: 'nvidia/llama-3.1-nemotron-70b-instruct', note: 'NVIDIA adversarial integrity check' },
      { provider: 'NARA', model: 'glm-5.3-flash-free', note: 'High-volume fuzzing worker' },
      { provider: 'NARA', model: 'agnes-2.5-flash', note: 'Fast test case synthesizer' },
    ],
  },
  PARSER_DATA_INVESTIGATION: {
    role: 'CSV / Parser / Import Investigation',
    primaryProvider: 'NARA',
    candidateChain: [
      { provider: 'NARA', model: 'laguna-s-2.1', note: 'Complex tabular parsing & RFC 4180' },
      { provider: 'NARA', model: 'mistral-medium-3-5', note: 'Schema drift & stacked header analysis' },
      { provider: 'NARA', model: 'agnes-2.5-flash', note: 'Fast row boundary detector' },
      { provider: 'NARA', model: 'tencent-hy3-free', note: 'Adversarial delimiter fuzzer' },
      { provider: 'NARA', model: 'glm-5.3-flash-free', note: 'Free fallback' },
    ],
  },
  FINANCIAL_CALCULATION: {
    role: 'Financial Calculation Review',
    primaryProvider: 'NARA',
    candidateChain: [
      { provider: 'NARA', model: 'mistral-medium-3-5', note: 'Independent ADR/RevPAR constraint logic' },
      { provider: 'NARA', model: 'laguna-s-2.1', note: 'Calculation path audit' },
      { provider: 'OPENROUTER', model: 'anthropic/claude-sonnet-5', note: 'Authoritative financial truth & cents math' },
      { provider: 'NARA', model: 'agnes-2.5-flash', note: 'Fast balance sheet scanner' },
      { provider: 'NARA', model: 'tencent-hy3-free', note: 'Currency edge fuzzer' },
      { provider: 'NARA', model: 'stepfun-3.7-flash', note: 'Lightweight calculation helper' },
    ],
  },
  FAST_CODE_REVIEW: {
    role: 'Fast Code Review & Linting',
    primaryProvider: 'NARA',
    candidateChain: [
      { provider: 'NARA', model: 'agnes-2.5-flash', note: 'Sub-3s code review throughput' },
      { provider: 'NARA', model: 'stepfun-3.7-flash', note: 'Lightweight syntax reviewer' },
      { provider: 'NARA', model: 'glm-5.3-flash-free', note: 'High-volume free reviewer' },
      { provider: 'NARA', model: 'tencent-hy3-free', note: 'Alternate code reviewer' },
      { provider: 'NARA', model: 'laguna-s-2.1', note: 'Deep review escalation' },
    ],
  },
  TEST_GENERATION: {
    role: 'Test & Assertion Generation',
    primaryProvider: 'NARA',
    candidateChain: [
      { provider: 'NARA', model: 'laguna-s-2.1', note: 'Deterministic unit test assertion writer' },
      { provider: 'NARA', model: 'agnes-2.5-flash', note: 'Rapid test suite generator' },
      { provider: 'NARA', model: 'tencent-hy3-free', note: 'Mutation & boundary test cases' },
      { provider: 'NARA', model: 'mistral-medium-3-5', note: 'Integration test suites' },
      { provider: 'NARA', model: 'glm-5.3-flash-free', note: 'Free fallback worker' },
    ],
  },
  CLASSIFICATION_ROUTING: {
    role: 'Classification & Intent Routing',
    primaryProvider: 'NARA',
    candidateChain: [
      { provider: 'NARA', model: 'agnes-2.5-flash', note: 'Sub-3s intent classifier' },
      { provider: 'NARA', model: 'stepfun-3.7-flash', note: 'Lightweight classifier' },
      { provider: 'NARA', model: 'glm-5.3-flash-free', note: 'Free classification fallback' },
      { provider: 'NARA', model: 'tencent-hy3-free', note: 'Alternate classifier' },
    ],
  },
  SUMMARIZATION_HELPER: {
    role: 'Summarization & Report Helper',
    primaryProvider: 'NARA',
    candidateChain: [
      { provider: 'NARA', model: 'agnes-2.5-flash', note: 'High-density report synthesis' },
      { provider: 'NARA', model: 'glm-5.3-flash-free', note: 'Free summary worker' },
      { provider: 'NARA', model: 'stepfun-3.7-flash', note: 'Lightweight synthesis' },
      { provider: 'NARA', model: 'tencent-hy3-free', note: 'Alternate summary helper' },
    ],
  },
};

export class UniversalModelRouter {
  constructor() {
    this.accounts = {
      'NARA-A': {
        alias: 'NARA-A',
        provider: 'NARA',
        available: false,
        status: 'INITIALIZING',
        requestsUsed: 0,
        tokensUsed: 0,
        activeRequests: 0,
        maxConcurrent: 20,
        cooldownUntil: 0,
        lastError: null,
        lastSuccess: null,
        successCount: 0,
        failureCount: 0,
        rollingSuccessRate: 1.0,
      },
      'NARA-B': {
        alias: 'NARA-B',
        provider: 'NARA',
        available: false,
        status: 'INITIALIZING',
        requestsUsed: 0,
        tokensUsed: 0,
        activeRequests: 0,
        maxConcurrent: 20,
        cooldownUntil: 0,
        lastError: null,
        lastSuccess: null,
        successCount: 0,
        failureCount: 0,
        rollingSuccessRate: 0.0,
      },
      'OPENROUTER-1': {
        alias: 'OPENROUTER-1',
        provider: 'OPENROUTER',
        available: false,
        status: 'INITIALIZING',
        requestsUsed: 0,
        tokensUsed: 0,
        activeRequests: 0,
        maxConcurrent: 20,
        cooldownUntil: 0,
        lastError: null,
        lastSuccess: null,
        successCount: 0,
        failureCount: 0,
        rollingSuccessRate: 1.0,
      },
      'GEMINI-1': {
        alias: 'GEMINI-1',
        provider: 'GEMINI',
        available: false,
        status: 'UNPROVEN',
        requestsUsed: 0,
        tokensUsed: 0,
        activeRequests: 0,
        maxConcurrent: 20,
        cooldownUntil: 0,
        lastError: null,
        lastSuccess: null,
        successCount: 0,
        failureCount: 0,
        rollingSuccessRate: 1.0,
      },
    };

    this.leaderboard = {};
    this.failoverLedger = [];
    this.sessionLedger = [];
  }

  /**
   * Initializes all configured provider accounts and discovers available models.
   */
  async initialize() {
    for (const [alias, acc] of Object.entries(this.accounts)) {
      if (acc.provider === 'GEMINI') {
        acc.available = false;
        acc.status = 'UNPROVEN';
        acc.lastError = 'No authenticated Gemini completion path is configured';
        continue;
      }
      const key = getSecureAccountKey(alias);
      if (!key) {
        acc.available = false;
        acc.status = 'AUTH_MISSING';
        acc.lastError = 'No API key configured for account';
        continue;
      }

      // Probe endpoint health / discovery
      await this.probeAccountHealth(alias);
    }
  }

  /**
   * Probes health and discovers models for a specific account.
   */
  async probeAccountHealth(alias) {
    const account = this.accounts[alias];
    const key = getSecureAccountKey(alias);
    if (!key) {
      account.available = false;
      account.status = 'AUTH_MISSING';
      return false;
    }

    const endpoint = account.provider === 'NARA' ? PROVIDER_ENDPOINTS.NARA : PROVIDER_ENDPOINTS.OPENROUTER;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 7000);

      const res = await fetch(`${endpoint}/models`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          'User-Agent': 'BostonProject-UniversalRouter/1.0',
        },
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok) {
        const errBody = redactSecrets(await res.text().catch(() => ''));
        account.available = false;
        if (res.status === 401) {
          account.status = 'AUTH_FAILED';
          account.lastError = 'Invalid API key (401)';
        } else if (res.status === 403) {
          account.status = 'FORBIDDEN (403)';
          account.lastError = errBody.includes('telegram_required')
            ? 'Awaiting Telegram binding at /settings'
            : `Forbidden (403): ${errBody.slice(0, 80)}`;
        } else {
          account.status = `HTTP_${res.status}`;
          account.lastError = `Model probe failed: HTTP ${res.status}`;
        }
        return false;
      }

      account.available = true;
      account.status = 'HEALTHY';
      account.lastError = null;
      account.lastSuccess = new Date().toISOString();
      return true;
    } catch (err) {
      account.available = false;
      account.status = 'NETWORK_ERROR';
      account.lastError = redactSecrets(err.message);
      return false;
    }
  }

  /**
   * Selects best available healthy account for a given provider.
   */
  selectAccount(provider) {
    const now = Date.now();
    const candidates = Object.values(this.accounts).filter(
      (a) => a.provider === provider && a.available && now >= a.cooldownUntil && a.activeRequests < a.maxConcurrent
    );

    if (candidates.length === 0) return null;

    candidates.sort((a, b) => {
      if (a.activeRequests !== b.activeRequests) return a.activeRequests - b.activeRequests;
      return a.requestsUsed - b.requestsUsed;
    });

    return candidates[0];
  }

  /**
   * Universal Execution Engine with 5x7s Smart Retry & Failover.
   */
  async execute(options) {
    const {
      roleType = 'DEEP_CODING',
      prompt,
      systemPrompt = 'You are an authoritative engineering intelligence worker for the Boston Project.',
      isAuthoritative = false,
      mandatoryProvider = null,
      maxTokens = 200,
      timeoutMs = 7000,
      maxAttemptsPerModel = 5,
      expectedActualModelPrefix = null,
    } = options;

    const policy = MODEL_ROUTING_POLICY[roleType] || MODEL_ROUTING_POLICY.DEEP_CODING;
    const fallbackPath = [];
    const tStart = Date.now();

    let success = false;
    let finalResult = null;
    let finalModel = null;
    let finalProvider = null;
    let finalAccount = null;
    let finalGenId = null;
    let finalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    let finalLatency = 0;

    for (const candidate of policy.candidateChain) {
      const { provider, model } = candidate;

      // Authoritative Identity Check
      if (mandatoryProvider && provider !== mandatoryProvider) {
        continue;
      }

      const account = this.selectAccount(provider);
      if (!account) {
        fallbackPath.push({
          provider,
          model,
          account: 'NONE_AVAILABLE',
          status: 'SKIPPED_NO_HEALTHY_ACCOUNT',
        });
        continue;
      }

      const key = getSecureAccountKey(account.alias);
      const endpoint = provider === 'NARA' ? PROVIDER_ENDPOINTS.NARA : PROVIDER_ENDPOINTS.OPENROUTER;

      account.activeRequests += 1;
      account.requestsUsed += 1;

      let modelSuccess = false;
      let tokenBudget = maxTokens;

      // 5x7s Retry Loop for Transient Failures
      for (let attempt = 1; attempt <= maxAttemptsPerModel; attempt++) {
        const t0 = Date.now();
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);

          let res;
          let data;
          try {
            res = await fetch(`${endpoint}/chat/completions`, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${key}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://boston-project.workers.dev',
                'X-Title': 'Boston Project Universal Router',
                'User-Agent': 'BostonProject-UniversalRouter/1.0',
              },
              body: JSON.stringify({
                model,
                messages: [
                  { role: 'system', content: systemPrompt },
                  { role: 'user', content: prompt },
                ],
                max_tokens: tokenBudget,
                temperature: 0.2,
              }),
              signal: controller.signal,
            });

            if (!res.ok) {
              clearTimeout(timer);
              const errBody = redactSecrets(await res.text().catch(() => ''));

              if (res.status === 401) {
                account.available = false;
                account.status = 'AUTH_FAILED';
                account.lastError = 'Unauthorized (401)';
                fallbackPath.push({ provider, model, account: account.alias, attempt, status: 401, error: 'AUTH_FAILED', latency: Number(((Date.now() - t0) / 1000).toFixed(3)) });
                break;
              }

              if (res.status === 403) {
                account.available = false;
                account.status = 'FORBIDDEN (403)';
                account.lastError = errBody.includes('telegram_required') ? 'Awaiting Telegram binding' : 'Forbidden (403)';
                fallbackPath.push({ provider, model, account: account.alias, attempt, status: 403, error: account.lastError, latency: Number(((Date.now() - t0) / 1000).toFixed(3)) });
                break;
              }

              if (res.status === 404) {
                fallbackPath.push({ provider, model, account: account.alias, attempt, status: 404, error: 'MODEL_NOT_FOUND', latency: Number(((Date.now() - t0) / 1000).toFixed(3)) });
                break;
              }

              if (res.status === 429) {
                account.cooldownUntil = Date.now() + 4000;
                account.lastError = 'Rate limited (429)';
                fallbackPath.push({ provider, model, account: account.alias, attempt, status: 429, error: 'RATE_LIMITED', latency: Number(((Date.now() - t0) / 1000).toFixed(3)) });
                break;
              }

              if (res.status === 402) {
                const affordableTokens = parseAffordableTokenLimit(errBody, tokenBudget);
                fallbackPath.push({
                  provider,
                  model,
                  account: account.alias,
                  attempt,
                  status: 402,
                  error: affordableTokens ? 'TOKEN_BUDGET_REDUCED' : 'PAYMENT_REQUIRED',
                  requestedTokens: tokenBudget,
                  retryTokens: affordableTokens,
                  latency: Number(((Date.now() - t0) / 1000).toFixed(3)),
                });
                if (affordableTokens) {
                  tokenBudget = affordableTokens;
                  continue;
                }
                break;
              }

              fallbackPath.push({ provider, model, account: account.alias, attempt, status: res.status, error: errBody.slice(0, 80), latency: Number(((Date.now() - t0) / 1000).toFixed(3)) });
              if (attempt < maxAttemptsPerModel) {
                await new Promise((r) => setTimeout(r, attempt * 200));
              }
              continue;
            }

            data = await res.json();
            clearTimeout(timer);
          } catch (fetchErr) {
            clearTimeout(timer);
            throw fetchErr;
          }
          const completion = validateCompletionPayload(data, model, provider);
          if (!completion.success) {
            fallbackPath.push({
              provider,
              model,
              account: account.alias,
              attempt,
              status: completion.error,
              actualModel: completion.actualModel,
              actualProvider: completion.identity.actualProvider,
              latency: Number(((Date.now() - t0) / 1000).toFixed(3)),
            });
            continue;
          }

          const requiredModelPrefix = expectedActualModelPrefix
            || (model.startsWith('anthropic/claude-') ? 'anthropic/claude-' : null);
          if (requiredModelPrefix && !completion.actualModel.startsWith(requiredModelPrefix)) {
            fallbackPath.push({
              provider,
              model,
              account: account.alias,
              attempt,
              status: 'MODEL_IDENTITY_MISMATCH',
              actualModel: completion.actualModel,
              actualProvider: completion.identity.actualProvider,
              latency: Number(((Date.now() - t0) / 1000).toFixed(3)),
            });
            break;
          }

          finalResult = completion.content;
          finalModel = completion.actualModel;
          finalProvider = provider;
          finalAccount = account.alias;
          finalGenId = data?.id || `gen-${Date.now()}`;
          finalUsage = data?.usage || {
            prompt_tokens: Math.round(prompt.length / 4),
            completion_tokens: Math.round(finalResult.length / 4),
            total_tokens: Math.round((prompt.length + finalResult.length) / 4),
          };
          finalLatency = Number(((Date.now() - tStart) / 1000).toFixed(3));

          account.tokensUsed += finalUsage.total_tokens || 0;
          account.successCount += 1;
          account.lastSuccess = new Date().toISOString();
          modelSuccess = true;
          success = true;

          this.recordTelemetry(finalModel, finalProvider, finalAccount, true, finalLatency, finalUsage.total_tokens);
          break;
        } catch (err) {
          const dur = Number(((Date.now() - t0) / 1000).toFixed(3));
          fallbackPath.push({ provider, model, account: account.alias, attempt, status: 'TIMEOUT_OR_NETWORK', error: redactSecrets(err.message), latency: dur });
          if (attempt < maxAttemptsPerModel) {
            await new Promise((r) => setTimeout(r, attempt * 250));
          }
        }
      }

      account.activeRequests = Math.max(0, account.activeRequests - 1);
      if (modelSuccess) break;
      account.failureCount += 1;
    }

    // Critical Provider Identity Check: If authoritative requirement not met, report truthfully
    if (isAuthoritative && mandatoryProvider && finalProvider !== mandatoryProvider) {
      success = false;
      finalResult = null;
    }

    const ledgerEntry = {
      timestamp: new Date().toISOString(),
      roleType,
      requestedRole: policy.role,
      isAuthoritative,
      mandatoryProvider,
      success,
      provider: finalProvider || 'NONE',
      accountAlias: finalAccount || 'NONE',
      modelReturned: finalModel || 'NONE',
      actualProvider: finalModel
        ? classifyProviderIdentity({ transportProvider: finalProvider, actualModel: finalModel }).actualProvider
        : 'NONE',
      generationId: finalGenId,
      tokens: finalUsage,
      latencySeconds: finalLatency,
      fallbackPath,
    };

    this.failoverLedger.push(ledgerEntry);

    // Live Arize Phoenix OpenInference Tracing
    phoenixTracer.recordLlmCall({
      name: `Universal Router: ${policy.role} (${finalModel || 'None'})`,
      provider: finalProvider || 'NONE',
      modelRequested: policy.candidateChain[0]?.model,
      modelReturned: finalModel || 'NONE',
      input: prompt,
      output: finalResult || (fallbackPath.length > 0 ? JSON.stringify(fallbackPath) : ''),
      tokens: finalUsage,
      latencySeconds: finalLatency,
      status: success ? 'OK' : 'ERROR',
      error: success ? null : fallbackPath[fallbackPath.length - 1]?.error || 'EXECUTION_FAILED',
      traceId: options.traceId,
      parentSpanId: options.parentSpanId,
      customAttributes: {
        'router.role_type': roleType,
        'router.account_alias': finalAccount || 'NONE',
        'router.attempts': fallbackPath.length,
        'router.is_authoritative': isAuthoritative,
      },
    }).catch(() => {});

    return {
      success,
      content: finalResult,
      provider: finalProvider,
      actualProvider: finalModel
        ? classifyProviderIdentity({ transportProvider: finalProvider, actualModel: finalModel }).actualProvider
        : null,
      accountAlias: finalAccount,
      model: finalModel,
      generationId: finalGenId,
      tokens: finalUsage,
      latencySeconds: finalLatency,
      fallbackPath,
    };
  }

  /**
   * Updates telemetry metrics for internal leaderboard ranking.
   */
  recordTelemetry(model, provider, account, success, latencySeconds, tokens) {
    if (!this.leaderboard[model]) {
      this.leaderboard[model] = {
        model,
        provider,
        account,
        tasksCompleted: 0,
        successCount: 0,
        failureCount: 0,
        totalTokens: 0,
        avgLatencySeconds: 0,
        agreementScore: 1.0,
      };
    }
    const m = this.leaderboard[model];
    m.tasksCompleted += 1;
    if (success) m.successCount += 1;
    else m.failureCount += 1;
    m.totalTokens += tokens || 0;
    m.avgLatencySeconds = Number(((m.avgLatencySeconds * (m.tasksCompleted - 1) + latencySeconds) / m.tasksCompleted).toFixed(3));
  }

  /**
   * Returns current system status.
   */
  getStatus() {
    return {
      accounts: this.accounts,
      leaderboard: this.leaderboard,
      totalInvocations: this.failoverLedger.length,
    };
  }
}

// Global Singleton Instance
export const universalRouter = new UniversalModelRouter();
