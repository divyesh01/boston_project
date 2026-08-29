/**
 * ProviderRegistry
 * ----------------
 * Centralized registry of all AI provider adapters.
 * Implements callAgent({ role, provider, model, messages, ... }) and provider health management.
 */

import { OpenAICompatibleAdapter } from './OpenAICompatibleAdapter.js';
import { AnthropicDirectAdapter } from './AnthropicDirectAdapter.js';
import { GeminiDirectAdapter } from './GeminiDirectAdapter.js';
import { KeyResolver } from './KeyResolver.js';

export const DEFAULT_PROVIDER_CONFIGS = {
  TABITOKEN: {
    name: 'TABITOKEN',
    alias: 'TABITOKEN_PRIMARY',
    baseUrl: 'https://tabitoken.com/v1',
    defaultHeaders: {},
  },
  GOROUTER: {
    name: 'GOROUTER',
    alias: 'GOROUTER_PRIMARY',
    baseUrl: 'https://gorouter.app/v1',
    defaultHeaders: {},
  },
  XKIRO: {
    name: 'XKIRO',
    alias: 'XKIRO_PRIMARY',
    baseUrl: 'https://api.xkiro.com/v1',
    defaultHeaders: {},
  },
  NARA: {
    name: 'NARA',
    alias: 'NARA_PRIMARY',
    baseUrl: 'https://router.bynara.id/v1',
    defaultHeaders: {},
  },
  OPENROUTER: {
    name: 'OPENROUTER',
    alias: 'OPENROUTER_PRIMARY',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultHeaders: {
      'HTTP-Referer': 'https://boston-project.local',
      'X-Title': 'Boston Project Multi-Agent Orchestrator',
    },
  },
  NVIDIA: {
    name: 'NVIDIA',
    alias: 'NVIDIA_NIM',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    defaultHeaders: {},
  },
  GEMINI_DIRECT: {
    name: 'GEMINI_DIRECT',
    alias: 'GOOGLE_AI_STUDIO',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultHeaders: {},
  },
  ANTHROPIC_DIRECT: {
    name: 'ANTHROPIC_DIRECT',
    alias: 'ANTHROPIC_MESSAGES_API',
    baseUrl: 'https://api.anthropic.com/v1',
    defaultHeaders: {},
  },
};

/**
 * Priority candidate chains for Claude Opus across configured providers
 */
export const CLAUDE_OPUS_CANDIDATE_ROUTES = [
  { provider: 'GOROUTER', model: 'claude-opus-5', note: 'GoRouter Opus 5' },
  { provider: 'TABITOKEN', model: 'claude-opus-5', note: 'Tabitoken Opus 5' },
  { provider: 'GOROUTER', model: 'claude-opus-4-8', note: 'GoRouter Opus 4.8' },
  { provider: 'TABITOKEN', model: 'claude-opus-4-8', note: 'Tabitoken Opus 4.8' },
  { provider: 'XKIRO', model: 'anthropic/claude-opus-5', note: 'xKiro Opus 5' },
  { provider: 'XKIRO', model: 'anthropic/claude-opus-4.8', note: 'xKiro Opus 4.8' },
  { provider: 'OPENROUTER', model: 'anthropic/claude-opus-5', note: 'OpenRouter Opus 5' },
  { provider: 'OPENROUTER', model: 'anthropic/claude-opus-4.8', note: 'OpenRouter Opus 4.8' },
  { provider: 'ANTHROPIC_DIRECT', model: 'claude-3-opus-20240229', note: 'Direct Anthropic Opus' },
];

export class ProviderRegistry {
  constructor(options = {}) {
    this.adapters = new Map();
    this.keyResolver = options.keyResolver || KeyResolver.resolveKey.bind(KeyResolver);
    this.fetchFn = options.fetchFn || (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);

    this._initializeDefaultAdapters();
  }

  _initializeDefaultAdapters() {
    // OpenAI-compatible adapters
    const oaiProviders = ['TABITOKEN', 'GOROUTER', 'XKIRO', 'NARA', 'OPENROUTER', 'NVIDIA'];
    for (const pName of oaiProviders) {
      const cfg = DEFAULT_PROVIDER_CONFIGS[pName];
      this.registerAdapter(pName, new OpenAICompatibleAdapter({
        ...cfg,
        keyResolverFn: this.keyResolver,
        fetchFn: this.fetchFn,
      }));
    }

    // Direct Adapters
    this.registerAdapter('ANTHROPIC_DIRECT', new AnthropicDirectAdapter({
      ...DEFAULT_PROVIDER_CONFIGS.ANTHROPIC_DIRECT,
      keyResolverFn: this.keyResolver,
      fetchFn: this.fetchFn,
    }));

    this.registerAdapter('GEMINI_DIRECT', new GeminiDirectAdapter({
      ...DEFAULT_PROVIDER_CONFIGS.GEMINI_DIRECT,
      keyResolverFn: this.keyResolver,
      fetchFn: this.fetchFn,
    }));
  }

  /**
   * Registers a custom or overridden adapter.
   */
  registerAdapter(name, adapter) {
    this.adapters.set(name.toUpperCase(), adapter);
  }

  /**
   * Retrieves an adapter by name.
   */
  getAdapter(name) {
    return this.adapters.get(name.toUpperCase()) || null;
  }

  /**
   * Universal agent calling interface.
   */
  async callAgent(options) {
    const {
      role = 'GENERAL_WORKER',
      provider = 'OPENROUTER',
      model,
      messages,
      prompt,
      systemPrompt,
      context,
      maxTokens = 4000,
      temperature = 0.2,
      timeoutMs = 60000,
      accountAlias = null,
      taskId = null,
    } = options;

    const normProvider = provider.toUpperCase();
    let adapter = this.getAdapter(normProvider);

    // Fallback alias mappings
    if (!adapter) {
      if (normProvider.includes('ANTHROPIC')) adapter = this.getAdapter('ANTHROPIC_DIRECT');
      else if (normProvider.includes('GEMINI') || normProvider.includes('GOOGLE')) adapter = this.getAdapter('GEMINI_DIRECT');
      else adapter = this.getAdapter('OPENROUTER');
    }

    if (!adapter) {
      return {
        success: false,
        content: null,
        error: `UNKNOWN_PROVIDER: No adapter registered for "${provider}"`,
        modelRequested: model,
        modelReturned: 'NONE',
        actualProvider: 'NONE',
        transportProvider: provider,
        upstreamProvider: null,
        generationId: null,
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        latencySeconds: 0,
        cost: null,
        httpStatus: 'CONFIG_ERROR',
        role,
        taskId,
      };
    }

    // Build context-enhanced messages if context object provided
    let combinedPrompt = prompt;
    if (context && typeof context === 'string') {
      combinedPrompt = `### REPOSITORY EVIDENCE & CONTEXT:\n${context}\n\n### INSTRUCTION:\n${prompt || ''}`;
    }

    const res = await adapter.call({
      model,
      messages,
      prompt: combinedPrompt,
      systemPrompt,
      maxTokens,
      temperature,
      timeoutMs,
      accountAlias,
    });

    return {
      ...res,
      role,
      taskId,
    };
  }

  /**
   * Returns a status map of all configured providers and key availability.
   */
  getProviderStatus() {
    const status = {};
    for (const [name] of this.adapters.entries()) {
      const keyStatus = KeyResolver.getKeyStatus(name);
      status[name] = {
        registered: true,
        keyConfigured: keyStatus.configured,
        keyMasked: keyStatus.masked,
      };
    }
    return status;
  }
}

export const defaultRegistry = new ProviderRegistry();
