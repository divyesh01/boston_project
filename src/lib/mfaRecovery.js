import { sanitizeInput } from './securityUtils';

/**
 * Generates an array of secure, random 8-character single-use recovery codes.
 * @param {number} [count=8] - Number of recovery codes to generate
 * @returns {Array<string>} Plaintext recovery codes (to display once to the user)
 */
export function generateRecoveryCodes(count = 8) {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // Base32-like, excludes ambiguous 0/O, 1/I
  const codes = [];
  const randomBytes = new Uint8Array(count * 8);
  crypto.getRandomValues(randomBytes);

  for (let i = 0; i < count; i++) {
    let code = '';
    for (let j = 0; j < 8; j++) {
      code += chars[randomBytes[i * 8 + j] % chars.length];
    }
    // Format as XXXX-XXXX for readability
    codes.push(`${code.slice(0, 4)}-${code.slice(4)}`);
  }

  return codes;
}

/**
 * Hashes a plaintext recovery code with SHA-256 for secure database storage.
 * @param {string} code - The plaintext recovery code (e.g., "ABCD-EFGH")
 * @returns {Promise<string>} Hex-encoded SHA-256 hash
 */
export async function hashRecoveryCode(code) {
  const normalized = String(code).trim().replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  const encoder = new TextEncoder();
  const data = encoder.encode(normalized);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Verifies and burns a single-use recovery code.
 * @param {string} inputCode - Code entered by the user
 * @param {Array<{ code_hash: string, used: boolean }>} storedHashedCodes - Hashed codes from user record
 * @returns {Promise<{ valid: boolean, updatedCodes: Array<Object>, matchedIndex: number }>}
 */
export async function verifyAndConsumeRecoveryCode(inputCode, storedHashedCodes = []) {
  if (!inputCode || !storedHashedCodes.length) {
    return { valid: false, updatedCodes: storedHashedCodes, matchedIndex: -1 };
  }

  const inputHash = await hashRecoveryCode(inputCode);
  const matchIndex = storedHashedCodes.findIndex(c => !c.used && c.code_hash === inputHash);

  if (matchIndex === -1) {
    return { valid: false, updatedCodes: storedHashedCodes, matchedIndex: -1 };
  }

  // Mark code as used (single-use enforcement)
  const updatedCodes = storedHashedCodes.map((item, idx) =>
    idx === matchIndex ? { ...item, used: true, used_at: new Date().toISOString() } : item
  );

  return {
    valid: true,
    updatedCodes,
    matchedIndex
  };
}
