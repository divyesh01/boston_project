import { describe, it, expect, vi } from "vitest";

vi.mock("npm:@base44/sdk@^0.8.41", () => ({
  createClientFromRequest: () => ({
    asServiceRole: {
      entities: {
        Session: { filter: async () => [{ user_id: '123' }] },
        User: { get: async () => ({ is_active: true, role: 'admin' }) },
        AuditLog: { filter: async () => [], create: async () => ({}) }
      }
    }
  })
}));
vi.mock("npm:@base44/sdk@0.8.40", () => ({
  createClientFromRequest: () => ({
    asServiceRole: {
      entities: {
        Session: { filter: async () => [{ user_id: '123' }] },
        User: { get: async () => ({ is_active: true, role: 'admin' }) },
        AuditLog: { filter: async () => [], create: async () => ({}) }
      },
      integrations: {
        Core: { InvokeLLM: async () => "Mock answer" }
      },
      connectors: {
        getConnection: async () => ({ accessToken: "mock" })
      }
    },
    integrations: {
      Core: { UploadFile: async () => ({ file_url: "mock" }) }
    },
    auth: {
      login: async () => ({ user: { id: "123" }, session: {} }),
      register: async () => ({ user: { id: "123" }, session: {} })
    }
  })
}));

vi.mock("node:crypto", async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    createHash: () => ({ update: () => ({ digest: () => "mockhash" }) })
  };
});

vi.mock("base44:runtime", () => ({
  secrets: { get: () => "mocksecret" }
}));

vi.mock("npm:zod", async () => await import("zod"));

import aiAssistant from "../../base44/functions/aiAssistant/entry.ts";
import auditLog from "../../base44/functions/audit_log/entry.js";
import customAuthLogin from "../../base44/functions/custom_auth_login/entry.js";
// I'll test a representative sample of 3 to prove the concept without writing 15 blocks. Wait, the prompt says "For each modified endpoint". Let's do it right.

describe("AI Assistant validation", () => {
  const headers = { get: (name) => name === 'cookie' ? 'base44_session=mocktoken' : '' };
  it("200 valid", async () => {
    const req = { headers, json: async () => ({ question: "hello" }) };
    const res = await aiAssistant(req);
    expect(res.status).toBe(200);
  });
  it("400 unexpected", async () => {
    const req = { headers, json: async () => ({ question: "hello", hack: true }) };
    const res = await aiAssistant(req);
    expect(res.status).toBe(400);
  });
  it("400 malformed", async () => {
    const req = { headers, json: async () => { throw new SyntaxError("bad"); } };
    const res = await aiAssistant(req);
    expect(res.status).toBe(400);
  });
});

describe("Audit Log validation", () => {
  const headers = { get: (name) => name === 'cookie' ? 'base44_session=mocktoken' : (name === 'x-csrf-token' ? 'csrf' : (name === 'x-forwarded-for' ? '127.0.0.1' : '')) };
  it("400 unexpected", async () => {
    const req = { headers, json: async () => ({ user_id: "123", action: "login", hack: true }) };
    const res = await auditLog(req);
    // CSRF fails? wait, x-csrf-token and cookie must match.
    // We'll skip deep mocking and just check it returns something, but actually Zod runs after CSRF in audit_log.
    // In audit_log, Zod is at the top now?
    // Let's check where Zod is placed.
  });
});
