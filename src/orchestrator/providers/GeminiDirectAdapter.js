/**
 * GeminiDirectAdapter
 * -------------------
 * Handles direct calls to Google AI Studio / Gemini REST API:
 * https://generativelanguage.googleapis.com/v1beta/models/...:generateContent
 */

import { BaseProviderAdapter } from './BaseProviderAdapter.js';
import { redactSecrets } from '../policies/SecretRedactor.js';

export class GeminiDirectAdapter extends BaseProviderAdapter {
  constructor(config = {}) {
    super({
      name: 'GEMINI_DIRECT',
      alias: config.alias || 'GEMINI',
      baseUrl: config.baseUrl || 'https://generativelanguage.googleapis.com/v1beta',
      defaultHeaders: config.defaultHeaders || {},
    });
    this.apiKey = config.apiKey || null;
    this.keyResolverFn = config.keyResolverFn || null;
    this.fetchFn = config.fetchFn || (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);
  }

  _getKey(accountAlias) {
    if (this.apiKey) return this.apiKey;
    if (typeof this.keyResolverFn === 'function') {
      return this.keyResolverFn('GEMINI', accountAlias);
    }
    return null;
  }

  async call(options) {
    const {
      model = 'gemini-2.5-flash',
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
        error: `NO_API_KEY_CONFIGURED: Missing Gemini API key (${accountAlias || 'default'})`,
        modelRequested: model,
        modelReturned: 'NONE',
        actualProvider: 'GOOGLE',
        transportProvider: 'GEMINI_DIRECT',
        upstreamProvider: 'Google AI Studio',
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
        actualProvider: 'GOOGLE',
        transportProvider: 'GEMINI_DIRECT',
        upstreamProvider: 'Google AI Studio',
        generationId: null,
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        latencySeconds: 0,
        cost: null,
        httpStatus: 'FETCH_UNAVAILABLE',
      };
    }

    // Build Gemini contents payload
    const contents = [];
    if (Array.isArray(messages)) {
      for (const m of messages) {
        contents.push({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content || '' }],
        });
      }
    } else if (typeof options.prompt === 'string') {
      contents.push({
        role: 'user',
        parts: [{ text: options.prompt }],
      });
    }

    const payload = {
      contents,
      generationConfig: {
        maxOutputTokens: maxTokens,
        temperature,
      },
    };

    if (systemPrompt && typeof systemPrompt === 'string') {
      payload.systemInstruction = {
        parts: [{ text: systemPrompt }],
      };
    }

    const cleanModel = model.replace(/^models\//, '').replace(/^google\//, '');
    const endpoint = `${this.baseUrl.replace(/\/+$/, '')}/models/${cleanModel}:generateContent`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await this.fetchFn(endpoint, {
        method: 'POST',
        headers: {
          'x-goog-api-key': key,
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
          actualProvider: 'GOOGLE',
          transportProvider: 'GEMINI_DIRECT',
          upstreamProvider: 'Google AI Studio',
          generationId: null,
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          latencySeconds,
          cost: null,
          httpStatus: res.status,
        };
      }

      const data = await res.json();
      const candidate = data?.candidates?.[0];
      const textParts = candidate?.content?.parts?.map((p) => p.text).filter(Boolean).join('\n') || '';
      const content = textParts.trim();
      const actualModel = cleanModel;
      const genId = data?.responseId || candidate?.citationMetadata?.citationSources?.[0]?.uri || null;

      const inTokens = data?.usageMetadata?.promptTokenCount || 0;
      const outTokens = data?.usageMetadata?.candidatesTokenCount || 0;
      const totalTokens = data?.usageMetadata?.totalTokenCount || (inTokens + outTokens);

      const usage = {
        prompt_tokens: inTokens,
        completion_tokens: outTokens,
        total_tokens: totalTokens,
      };

      if (!content || content.length === 0) {
        return {
          success: false,
          content: null,
          error: 'EMPTY_RESPONSE',
          modelRequested: model,
          modelReturned: actualModel,
          actualProvider: 'GOOGLE',
          transportProvider: 'GEMINI_DIRECT',
          upstreamProvider: 'Google AI Studio',
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
        actualProvider: 'GOOGLE',
        transportProvider: 'GEMINI_DIRECT',
        upstreamProvider: 'Google AI Studio',
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
        actualProvider: 'GOOGLE',
        transportProvider: 'GEMINI_DIRECT',
        upstreamProvider: 'Google AI Studio',
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
          'x-goog-api-key': key,
          ...this.defaultHeaders,
        },
        signal: controller.signal,
      });
      clearTimeout(timer);
      const latencyMs = Date.now() - t0;

      return {
        healthy: res.ok,
        status: res.ok ? 'HEALTHY' : `HTTP_${res.status}`,
        latencyMs,
        error: res.ok ? null : `Probe failed with HTTP ${res.status}`,
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
