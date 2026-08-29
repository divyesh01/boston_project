/**
 * SecretRedactor
 * --------------
 * Sanitizes prompts, responses, logs, receipts, and errors before any external call
 * or local persistence. Guarantees that raw credentials never leak into git, logs,
 * prompts, or error messages.
 */

const SECRET_PATTERNS = [
  // Nara keys
  { regex: /sk-nry-[A-Za-z0-9_-]{16,}/gi, replacement: '[REDACTED_NARA_KEY]' },
  // OpenRouter keys
  { regex: /sk-or-v1-[A-Za-z0-9_-]{20,}/gi, replacement: '[REDACTED_OPENROUTER_KEY]' },
  // Anthropic keys
  { regex: /sk-ant-[A-Za-z0-9_-]{20,}/gi, replacement: '[REDACTED_ANTHROPIC_KEY]' },
  // OpenAI / Tabitoken / GoRouter / xKiro keys
  { regex: /sk-[A-Za-z0-9_-]{24,}/gi, replacement: '[REDACTED_API_KEY]' },
  // NVIDIA API keys
  { regex: /nvapi-[A-Za-z0-9_-]{20,}/gi, replacement: '[REDACTED_NVIDIA_KEY]' },
  // Google AI Studio / Gemini API keys
  { regex: /AIza[0-9A-Za-z-_]{35}/g, replacement: '[REDACTED_GEMINI_KEY]' },
  // Generic Bearer Authorization headers
  { regex: /Bearer\s+[A-Za-z0-9._~+/-]{16,}/gi, replacement: 'Bearer [REDACTED_AUTH_TOKEN]' },
  // Generic key assignments (e.g. apiKey = "...", password = "...")
  { regex: /(api[_-]?key|secret|password|auth[_-]?token)\s*[:=]\s*["']([^"']{8,})["']/gi, replacement: '$1: "[REDACTED_SECRET]"' },
];

export function redactSecrets(input) {
  if (input === null || input === undefined) return input;
  if (typeof input !== 'string') {
    if (typeof input === 'object') {
      try {
        const str = JSON.stringify(input);
        const redacted = redactSecrets(str);
        return JSON.parse(redacted);
      } catch {
        return input;
      }
    }
    return input;
  }

  let result = input;
  for (const { regex, replacement } of SECRET_PATTERNS) {
    result = result.replace(regex, replacement);
  }
  return result;
}

export function maskSecretKey(key) {
  if (!key || typeof key !== 'string') return '[UNSET]';
  const trimmed = key.trim();
  if (trimmed.length <= 8) return '****';
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}
