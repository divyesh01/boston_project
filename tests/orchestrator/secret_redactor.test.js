import { describe, it, expect } from 'vitest';
import { redactSecrets, maskSecretKey } from '../../src/orchestrator/policies/SecretRedactor.js';

describe('SecretRedactor Policy Suite', () => {
  it('redacts Nara API keys from strings', () => {
    const raw = 'Calling Nara with key sk-nry-abc1234567890abcdef1234 now';
    const redacted = redactSecrets(raw);
    expect(redacted).not.toContain('sk-nry-abc1234567890abcdef1234');
    expect(redacted).toContain('[REDACTED_NARA_KEY]');
  });

  it('redacts OpenRouter API keys from strings', () => {
    const raw = 'OpenRouter token sk-or-v1-abcdef0123456789abcdef0123456789 presented';
    const redacted = redactSecrets(raw);
    expect(redacted).not.toContain('sk-or-v1-abcdef0123456789abcdef0123456789');
    expect(redacted).toContain('[REDACTED_OPENROUTER_KEY]');
  });

  it('redacts Anthropic API keys from strings', () => {
    const raw = 'Anthropic key: sk-ant-api03-abcdef1234567890abcdef1234567890';
    const redacted = redactSecrets(raw);
    expect(redacted).not.toContain('sk-ant-api03-abcdef1234567890abcdef1234567890');
    expect(redacted).toContain('[REDACTED_ANTHROPIC_KEY]');
  });

  it('redacts NVIDIA API keys', () => {
    const raw = 'NVIDIA key nvapi-abcdef1234567890abcdef1234567890';
    const redacted = redactSecrets(raw);
    expect(redacted).not.toContain('nvapi-abcdef1234567890abcdef1234567890');
    expect(redacted).toContain('[REDACTED_NVIDIA_KEY]');
  });

  it('redacts generic Bearer authorization headers', () => {
    const raw = 'Authorization: Bearer mySecretSessionToken123456789';
    const redacted = redactSecrets(raw);
    expect(redacted).not.toContain('mySecretSessionToken123456789');
    expect(redacted).toContain('Bearer [REDACTED_AUTH_TOKEN]');
  });

  it('redacts deeply nested object properties', () => {
    const obj = {
      config: {
        apiKey: 'sk-nry-1234567890abcdef1234',
        user: 'admin',
      },
    };
    const redactedObj = redactSecrets(obj);
    expect(redactedObj.config.apiKey).toBe('[REDACTED_NARA_KEY]');
    expect(redactedObj.config.user).toBe('admin');
  });

  it('masks secret keys safely for previews', () => {
    expect(maskSecretKey('sk-ant-1234567890abcdef')).toBe('sk-a...cdef');
    expect(maskSecretKey('')).toBe('[UNSET]');
    expect(maskSecretKey(null)).toBe('[UNSET]');
  });
});
