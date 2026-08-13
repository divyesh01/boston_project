import { describe, it, expect } from "vitest";
import { generatePasswordResetToken, validateResetToken, formatMfaQrCodeUrl } from "@/lib/authHelpers";

describe("authHelpers — generatePasswordResetToken", () => {
  it("generates a 32-byte hex token", () => {
    const { token } = generatePasswordResetToken();
    expect(token.length).toBe(64); // 32 bytes * 2 hex chars per byte
    expect(/^[0-9a-f]+$/i.test(token)).toBe(true);
  });

  it("generates an expiresAt timestamp 1 hour in the future", () => {
    const { expiresAt } = generatePasswordResetToken();
    const now = Date.now();
    expect(expiresAt - now).toBeCloseTo(3600000, -1);
  });
});

describe("authHelpers — validateResetToken", () => {
  it("validates a correct token that has not expired", () => {
    const token = "abc123";
    const hashedToken = "abc123";
    const futureExpiresAt = Date.now() + 3600000;
    const result = validateResetToken(token, hashedToken, futureExpiresAt);
    expect(result.valid).toBe(true);
    expect(result.error).toBeNull();
  });

  it("rejects an expired token", () => {
    const token = "valid-token";
    const hashedToken = "valid-token";
    const pastExpiresAt = Date.now() - 3600000;
    const result = validateResetToken(token, hashedToken, pastExpiresAt);
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Token has expired.");
  });

  it("rejects a mismatched token", () => {
    const token = "correct-token";
    const hashedToken = "wrong-token";
    const futureExpiresAt = Date.now() + 3600000;
    const result = validateResetToken(token, hashedToken, futureExpiresAt);
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Invalid token.");
  });
});

describe("authHelpers — formatMfaQrCodeUrl", () => {
  it("generates a valid otpauth://totp/ URL", () => {
    const result = formatMfaQrCodeUrl("alice", "JDE2N2JjZmMtZDY5Zi00ZDM1LWEwZTctZDQ4ZDY2NjA", "Authenticator");
    expect(result).toMatch(/^otpauth:\/\/totp\/alice\?secret=JDE2N2JJZMMTZDY5ZI00ZDM1LWEWZTCTZDQ4ZDY2NJA&issuer=Authenticator&period=30&digits=6/);
  });

  it("encodes the username and issuer properly", () => {
    const result = formatMfaQrCodeUrl("john doe", "secret", "My App");
    expect(result).toContain("john%20doe");
    expect(result).toContain("My%20App");
  });

  it("normalizes the secret to uppercase and removes whitespace", () => {
    const result = formatMfaQrCodeUrl("user", "lowercase secret", "App");
    expect(result).not.toContain(" ");
    expect(result).not.toContain("lowercase");
    expect(result).toContain("LOWERCASE");
  });
});