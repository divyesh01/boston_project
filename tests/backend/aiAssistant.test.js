import { describe, it, expect, vi } from "vitest";

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
      }
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

describe("AI Assistant validation", () => {
  const headers = { get: (name) => name === 'cookie' ? 'base44_session=mocktoken' : '' };
  const getReq = (body, url = "/") => ({ headers, json: async () => body, url });
  const getRawReq = (rawBody, url = "/") => ({ headers, json: async () => { if(typeof rawBody === 'string' && !rawBody.startsWith('{')) throw new Error('bad'); return JSON.parse(rawBody); }, url });

  it("Case A (Valid Input): Returns HTTP 200", async () => {
    const res = await aiAssistant(getReq({ question: "hello" }));
    expect(res.status).toBe(200);
  });
  
  it("Case B (Malformed JSON): Returns HTTP 400 code: INVALID_JSON", async () => {
    const res = await aiAssistant({ headers, json: async () => { throw new SyntaxError("Unexpected token"); }, url: "/" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_JSON");
  });
  
  it("Case C (Injected / Unknown Fields): Returns HTTP 400 code: VALIDATION_ERROR", async () => {
    const res = await aiAssistant(getReq({ question: "hello", injected_hack: true }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_ERROR");
  });
  
  it("Case D (Boundary Violation / Out-of-Range): Returns HTTP 400 code: VALIDATION_ERROR", async () => {
    // question max length is 2000
    const res = await aiAssistant(getReq({ question: "a".repeat(2001) }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_ERROR");
  });
  
  it("Case E (Invalid Query Parameters): Returns HTTP 400 code: VALIDATION_ERROR", async () => {
    const res = await aiAssistant(getReq({ question: "hello" }, "/?hacked=true"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_ERROR");
  });
});
