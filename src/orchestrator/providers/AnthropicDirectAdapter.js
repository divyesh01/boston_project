/**
 * AnthropicDirectAdapter
 * ----------------------
 * Handles direct calls to the official Anthropic Messages API:
 * https://api.anthropic.com/v1/messages
 */

import { BaseProviderAdapter } from './BaseProviderAdapter.js';
import { redactSecrets } from '../policies/SecretRedactor.js';

export class AnthropicDirectAdapter extends BaseProviderAdapter {
  constructor(config = {}) {
    super({
      name: 'ANTHROPIC_DIRECT',
      alias: config.alias || 'ANTHROPIC',
      baseUrl: config.baseUrl || 'https://api.anthropic.com/v1',
      defaultHeaders: config.defaultHeaders || {},
    });
    this.apiKey = config.apiKey || null;
    this.keyResolverFn = config.keyResolverFn || null;
    this.fetchFn = config.fetchFn || (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);
    this.anthropicVersion = config.anthropicVersion || '2023-06-01';
  }

  _getKey(accountAlias) {
    if (this.apiKey) return this.apiKey;
    if (typeof this.keyResolverFn === 'function') {
      return this.keyResolverFn('ANTHROPIC', accountAlias);
    }
    return null;
  }

  async call(options) {
    const {
      model = 'claude-3-opus-20240229',
      messages,
      systemPrompt = null,
      maxTokens = 4000,
      temperature = 0.2,
      timeoutMs = 120000,
      accountAlias = null,
      extraHeaders = {},
    } = options;

    const tStart = Date.now();
    const key = this._getKey(accountAlias);

    if (!key) {
      return {
        success: false,
        content: null,
        error: `NO_API_KEY_CONFIGURED: Missing Anthropic API key (${accountAlias || 'default'})`,
        modelRequested: model,
        modelReturned: 'NONE',
        actualProvider: 'ANTHROPIC',
        transportProvider: 'ANTHROPIC_DIRECT',
        upstreamProvider: 'Anthropic Direct',
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
        actualProvider: 'ANTHROPIC',
        transportProvider: 'ANTHROPIC_DIRECT',
        upstreamProvider: 'Anthropic Direct',
        generationId: null,
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        latencySeconds: 0,
        cost: null,
        httpStatus: 'FETCH_UNAVAILABLE',
      };
    }

    // Build payload messages for Anthropic Messages API
    const formattedMessages = [];
    if (Array.isArray(messages)) {
      for (const m of messages) {
        if (m.role === 'user' || m.role === 'assistant') {
          formattedMessages.push({ role: m.role, content: m.content });
        }
      }
    } else if (typeof options.prompt === 'string') {
      formattedMessages.push({ role: 'user', content: options.prompt });
    }

    const payload = {
      model,
      messages: formattedMessages,
      max_tokens: maxTokens,
      temperature,
    };
    if (systemPrompt && typeof systemPrompt === 'string') {
      payload.system = systemPrompt;
    }

    const endpoint = `${this.baseUrl.replace(/\/+$/, '')}/messages`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await this.fetchFn(endpoint, {
        method: 'POST',
        headers: {
          'x-api-key': key,
          'anthropic-version': this.anthropicVersion,
          'Content-Type': 'application/json',
          ...this.defaultHeaders,
          ...extraHeaders,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timer);
      const latencySeconds = Number(((Date.now() - tStart) / 1000).toFixed(3));

      if (!res.ok) {
        const errText = redactSecrets(await res.text().catch(() => ''));
        return {
          success: false,
          content: null,
          error: `HTTP_${res.status}: ${errText.slice(0, 300)}`,
          modelRequested: model,
          modelReturned: 'NONE',
          actualProvider: 'ANTHROPIC',
          transportProvider: 'ANTHROPIC_DIRECT',
          upstreamProvider: 'Anthropic Direct',
          generationId: null,
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          latencySeconds,
          cost: null,
          httpStatus: res.status,
        };
      }

      const data = await res.json();
      const textBlocks = Array.isArray(data?.content)
        ? data.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
        : '';
      const content = textBlocks.trim();
      const actualModel = data?.model || model;
      const genId = data?.id || null;

      const inTokens = data?.usage?.input_tokens || 0;
      const outTokens = data?.usage?.output_tokens || 0;
      const usage = {
        prompt_tokens: inTokens,
        completion_tokens: outTokens,
        total_tokens: inTokens + outTokens,
      };

      if (!content || content.length === 0) {
        return {
          success: false,
          content: null,
          error: 'EMPTY_RESPONSE',
          modelRequested: model,
          modelReturned: actualModel,
          actualProvider: 'ANTHROPIC',
          transportProvider: 'ANTHROPIC_DIRECT',
          upstreamProvider: 'Anthropic Direct',
          generationId: genId,
          usage,
          latencySeconds,
          cost: null,
          httpStatus: res.status,
        };
      }

      return {
        success: true,
        content,
        error: null,
        modelRequested: model,
        modelReturned: actualModel,
        actualProvider: 'ANTHROPIC',
        transportProvider: 'ANTHROPIC_DIRECT',
        upstreamProvider: 'Anthropic Direct',
        generationId: genId,
        usage,
        latencySeconds,
        cost: null,
        httpStatus: res.status,
      };
    } catch (err) {
      clearTimeout(timer);
      const latencySeconds = Number(((Date.now() - tStart) / 1000).toFixed(3));
      const isTimeout = err.name === 'AbortError';

      return {
        success: false,
        content: null,
        error: isTimeout ? `TIMEOUT: Request exceeded ${timeoutMs}ms` : redactSecrets(err.message),
        modelRequested: model,
        modelReturned: 'NONE',
        actualProvider: 'ANTHROPIC',
        transportProvider: 'ANTHROPIC_DIRECT',
        upstreamProvider: 'Anthropic Direct',
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

    // Ping Anthropic with 1 token request or check key validity
    const res = await this.call({
      model: 'claude-3-haiku-20240307',
      prompt: 'ping',
      maxTokens: 1,
      timeoutMs: 8000,
    });

    return {
      healthy: res.success,
      status: res.success ? 'HEALTHY' : (res.httpStatus || 'ERROR'),
      latencyMs: Date.now() - t0,
      error: res.error,
    };
  }
}
