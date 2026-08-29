/**
 * KeyResolver
 * -----------
 * Deterministically and securely retrieves provider API keys from environment
 * variables or Windows DPAPI storage. Never prints, logs, or persists raw keys.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import process from 'node:process';
import { maskSecretKey } from '../policies/SecretRedactor.js';

const IN_MEMORY_CACHE = new Map();
let DOTENV_LOCAL_CACHE = null;

function loadLocalEnvFiles() {
  if (DOTENV_LOCAL_CACHE !== null) {
    return DOTENV_LOCAL_CACHE;
  }
  const envMap = {};
  const root = process.cwd();
  const envFiles = ['.env.local', '.env', '.env.development'];

  for (const file of envFiles) {
    const fullPath = path.resolve(root, file);
    if (fs.existsSync(fullPath)) {
      try {
        const content = fs.readFileSync(fullPath, 'utf8');
        const lines = content.split('\n');
        for (let line of lines) {
          line = line.trim();
          if (!line || line.startsWith('#') || !line.includes('=')) continue;
          const eqIdx = line.indexOf('=');
          const k = line.substring(0, eqIdx).trim();
          let v = line.substring(eqIdx + 1).trim();
          if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
            v = v.substring(1, v.length - 1);
          }
          if (k && v && !envMap[k]) {
            envMap[k] = v;
          }
        }
      } catch (_e) {
        // Ignore read errors
      }
    }
  }

  DOTENV_LOCAL_CACHE = envMap;
  return envMap;
}

export class KeyResolver {
  /**
   * Resolves the API key for a given provider or account alias.
   * @param {string} providerName - e.g. 'OPENROUTER', 'TABITOKEN', 'GOROUTER', 'NARA', 'NVIDIA', 'GEMINI', 'ANTHROPIC'
   * @param {string} [accountAlias] - e.g. 'NARA-A', 'NARA-B', 'CLAUDE_PRIMARY'
   * @returns {string|null}
   */
  static resolveKey(providerName, accountAlias = null) {
    const keyId = `${providerName.toUpperCase()}_${(accountAlias || '').toUpperCase()}`;
    if (IN_MEMORY_CACHE.has(keyId)) {
      return IN_MEMORY_CACHE.get(keyId);
    }

    const localEnv = loadLocalEnvFiles();
    const env = { ...localEnv, ...(typeof process !== 'undefined' && process.env ? process.env : {}) };
    let resolved = null;
    const normProvider = providerName.toUpperCase();
    const normAlias = (accountAlias || '').toUpperCase();

    // 1. Specific account alias checks in ENV
    if (normAlias === 'NARA-A' || normAlias === 'NARA_1') {
      resolved = env.NARA_API_KEY_1 || env.NARA_API_KEY_A || null;
    } else if (normAlias === 'NARA-B' || normAlias === 'NARA_2') {
      resolved = env.NARA_API_KEY_2 || env.NARA_API_KEY_B || null;
    }

    // 2. Generic provider environment variable checks
    if (!resolved) {
      switch (normProvider) {
        case 'TABITOKEN':
          resolved = env.TABITOKEN_API_KEY || env.TABI_API_KEY || env.TABITOKEN_KEY || null;
          break;
        case 'GOROUTER':
          resolved = env.GOROUTER_API_KEY || env.GO_ROUTER_API_KEY || null;
          break;
        case 'XKIRO':
          resolved = env.XKIRO_API_KEY || env.XKIRO_KEY || null;
          break;
        case 'NARA':
        case 'NARAROUTER':
          resolved = env.NARA_API_KEY || env.NARA_API_KEY_1 || env.NARA_API_KEY_A || null;
          break;
        case 'OPENROUTER':
          resolved = env.OPENROUTER_API_KEY || env.OPENROUTER_KEY || null;
          break;
        case 'ANTHROPIC':
        case 'CLAUDE':
          resolved = env.ANTHROPIC_API_KEY || env.CLAUDE_API_KEY || null;
          break;
        case 'GEMINI':
        case 'GOOGLE':
          resolved = env.GEMINI_API_KEY || env.GOOGLE_API_KEY || env.GOOGLE_AI_KEY || null;
          break;
        case 'NVIDIA':
        case 'NVIDIA_NIM':
          resolved = env.NVIDIA_API_KEY || env.NVIDIA_NIM_KEY || env.NVAPI_KEY || null;
          break;
        default:
          resolved = env[`${normProvider}_API_KEY`] || env[`${normProvider}_KEY`] || null;
      }
    }

    // 3. Fallback to Windows DPAPI helper scripts if available locally
    if (!resolved) {
      try {
        if (normProvider === 'OPENROUTER') {
          resolved = execSync('python scripts/openrouter_support.py --get', {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'ignore'],
          }).trim() || null;
        } else if (normProvider === 'NARA' || normAlias.startsWith('NARA')) {
          const targetAlias = normAlias.includes('B') || normAlias.includes('2') ? 'NARA-B' : 'NARA-A';
          resolved = execSync(`python scripts/nara_support.py --get ${targetAlias}`, {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'ignore'],
          }).trim() || null;
        }
      } catch {
        // DPAPI script unavailable or returned error; resolved remains null
      }
    }

    if (resolved && typeof resolved === 'string') {
      resolved = resolved.trim();
    } else {
      resolved = null;
    }

    IN_MEMORY_CACHE.set(keyId, resolved);
    return resolved;
  }

  /**
   * Returns safe metadata status for an account (whether a key exists and its masked preview).
   */
  static getKeyStatus(providerName, accountAlias = null) {
    const key = KeyResolver.resolveKey(providerName, accountAlias);
    return {
      configured: Boolean(key && key.length > 0),
      masked: maskSecretKey(key),
    };
  }

  /**
   * Resets the in-memory key cache and reloads local dotenv files.
   */
  static clearCache() {
    IN_MEMORY_CACHE.clear();
    DOTENV_LOCAL_CACHE = null;
  }
}
