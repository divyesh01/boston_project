/**
 * OpenAICompatibleAdapter
 * -----------------------
 * Handles HTTP requests to any standard OpenAI-compatible completions endpoint:
 * OpenRouter, Tabitoken, GoRouter, NaraRouter, xKiro proxy, NVIDIA NIM, and custom servers.
 */

import { BaseProviderAdapter } from './BaseProviderAdapter.js';
import { redactSecrets } from '../policies/SecretRedactor.js';

export class OpenAICompatibleAdapter extends BaseProviderAdapter {
  constructor(config = {}) {
    super(config);
    this.apiKey = config.apiKey || null;
    this.keyResolverFn = config.keyResolverFn || null;
    this.fetchFn = config.fetchFn || (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);
  }

  _getKey(accountAlias) {
    if (this.apiKey) return this.apiKey;
    if (typeof this.keyResolverFn === 'function') {
      return this.keyResolverFn(this.name, accountAlias);
    }
    return null;
  }

  _classifyModelIdentity(actualModel, transportName, upstream = null) {
    const normModel = String(actualModel || '').trim().toLowerCase();
    let actualProvider = 'UNKNOWN';

    if (normModel.startsWith('anthropic/claude-') || normModel.startsWith('claude-')) {
      actualProvider = 'ANTHROPIC';
    } else if (normModel.startsWith('google/gemini-') || normModel.startsWith('gemini-')) {
      actualProvider = 'GOOGLE';
    } else if (normModel.startsWith('nvidia/') || normModel.startsWith('nemotron')) {
      actualProvider = 'NVIDIA';
    } else if (normModel.includes('/')) {
      actualProvider = normModel.split('/', 1)[0].toUpperCase();
    } else {
      actualProvider = String(transportName || 'UNKNOWN').toUpperCase();
    }

    return {
      actualProvider,
      actualModel: String(actualModel || 'UNKNOWN'),
      upstreamProvider: upstream || null,
      isClaude: actualProvider === 'ANTHROPIC' || normModel.includes('claude'),
      isOpus: normModel.includes('opus'),
    };
  }

  async call(options) {
    const {
      model,
      messages,
      systemPrompt = null,
      maxTokens = 4000,
      temperature = 0.2,
      timeoutMs = 60000,
      accountAlias = null,
      extraHeaders = {},
    } = options;

    const tStart = Date.now();
    const key = this._getKey(accountAlias);

    if (!key) {
      return {
        success: false,
        content: null,
        error: `NO_API_KEY_CONFIGURED: Missing credentials for ${this.name} (${accountAlias || 'default'})`,
        modelRequested: model,
        modelReturned: 'NONE',
        actualProvider: 'NONE',
        transportProvider: this.name,
        upstreamProvider: null,
        generationId: null,
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        latencySeconds: 0,
        cost: null,
        httpStatus: 'MISSING_KEY',
      };
    }

    if (!this.fetchFn) {
      return {
        success: false,
        content: null,
        error: 'NO_FETCH_TRANSPORT_AVAILABLE',
        modelRequested: model,
        modelReturned: 'NONE',
        actualProvider: 'NONE',
        transportProvider: this.name,
        upstreamProvider: null,
        generationId: null,
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        latencySeconds: 0,
        cost: null,
        httpStatus: 'FETCH_UNAVAILABLE',
      };
    }

    // Build payload messages
    const formattedMessages = [];
    if (systemPrompt && typeof systemPrompt === 'string') {
      formattedMessages.push({ role: 'system', content: systemPrompt });
    }
    if (Array.isArray(messages)) {
      formattedMessages.push(...messages);
    } else if (typeof options.prompt === 'string') {
      formattedMessages.push({ role: 'user', content: options.prompt });
    }

    const endpoint = `${this.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await this.fetchFn(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://boston-project.local',
          'X-Title': 'Boston-Project-Orchestrator',
          'User-Agent': 'BostonProject-Orchestrator/2.0',
          ...this.defaultHeaders,
          ...extraHeaders,
        },
        body: JSON.stringify({
          model,
          messages: formattedMessages,
          max_tokens: maxTokens,
          temperature,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutHandle);
      const latencySeconds = Number(((Date.now() - tStart) / 1000).toFixed(3));

      if (!res.ok) {
        const errText = redactSecrets(await res.text().catch(() => ''));
        return {
          success: false,
          content: null,
          error: `HTTP_${res.status}: ${errText.slice(0, 300)}`,
          modelRequested: model,
          modelReturned: 'NONE',
          actualProvider: 'NONE',
          transportProvider: this.name,
          upstreamProvider: null,
          generationId: null,
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          latencySeconds,
          cost: null,
          httpStatus: res.status,
        };
      }

      const data = await res.json();
      const rawChoice = data?.choices?.[0]?.message;
      const content = (rawChoice?.content || rawChoice?.reasoning || '').trim();
      const actualModel = data?.model || model;
      const genId = data?.id || res.headers?.get?.('x-generation-id') || res.headers?.get?.('x-request-id') || null;
      const identity = this._classifyModelIdentity(actualModel, this.name, data?.provider || null);

      const usage = data?.usage || {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      };

      let cost = usage.cost !== undefined ? usage.cost : null;
      if (typeof cost === 'number') {
        cost = `$${cost.toFixed(6)}`;
      }

      if (!content || content.length === 0) {
        return {
          success: false,
          content: null,
          error: 'EMPTY_RESPONSE',
          modelRequested: model,
          modelReturned: actualModel,
          actualProvider: identity.actualProvider,
          transportProvider: this.name,
          upstreamProvider: identity.upstreamProvider,
          generationId: genId,
          usage,
          latencySeconds,
          cost,
          httpStatus: res.status,
        };
      }

      return {
        success: true,
        content,
        error: null,
        modelRequested: model,
        modelReturned: actualModel,
        actualProvider: identity.actualProvider,
        transportProvider: this.name,
        upstreamProvider: identity.upstreamProvider,
        generationId: genId,
        usage,
        latencySeconds,
        cost,
        httpStatus: res.status,
      };
    } catch (err) {
      clearTimeout(timeoutHandle);
      const latencySeconds = Number(((Date.now() - tStart) / 1000).toFixed(3));
      const isTimeout = err.name === 'AbortError';

      return {
        success: false,
        content: null,
        error: isTimeout ? `TIMEOUT: Request exceeded ${timeoutMs}ms` : redactSecrets(err.message),
        modelRequested: model,
        modelReturned: 'NONE',
        actualProvider: 'NONE',
        transportProvider: this.name,
        upstreamProvider: null,
        generationId: null,
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        latencySeconds,
        cost: null,
        httpStatus: isTimeout ? 'TIMEOUT' : 'NETWORK_ERROR',
      };
    }
  }

  async probeHealth() {
    const t0 = Date.now();
    const key = this._getKey(null);
    if (!key) {
      return { healthy: false, status: 'MISSING_KEY', latencyMs: 0, error: 'No API key configured' };
    }

    try {
      const endpoint = `${this.baseUrl.replace(/\/+$/, '')}/models`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);

      const res = await this.fetchFn(endpoint, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${key}`,
          ...this.defaultHeaders,
        },
        signal: controller.signal,
      });
      clearTimeout(timer);
      const latencyMs = Date.now() - t0;

      if (!res.ok) {
        return {
          healthy: false,
          status: `HTTP_${res.status}`,
          latencyMs,
          error: `Endpoint returned HTTP ${res.status}`,
        };
      }

      return {
        healthy: true,
        status: 'HEALTHY',
        latencyMs,
        error: null,
      };
    } catch (err) {
      return {
        healthy: false,
        status: 'UNREACHABLE',
        latencyMs: Date.now() - t0,
        error: redactSecrets(err.message),
      };
    }
  }
}
