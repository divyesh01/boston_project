import { describe, it, expect, vi, beforeEach } from "vitest";

const { uploadFileMock } = vi.hoisted(() => ({ uploadFileMock: vi.fn() }));

vi.mock("npm:@base44/sdk@^0.8.41", () => ({
  createClientFromRequest: () => ({
    asServiceRole: {
      entities: {
        Session: { filter: async () => [{ user_id: "123" }] },
        User: { get: async () => ({ is_active: true, role: "owner" }) },
      },
    },
    integrations: {
      Core: { UploadFile: uploadFileMock },
    },
  }),
}));

import validateUpload from "../../base44/functions/validateUpload/entry.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\./i;

function buildReq({ bytes, name, type = "application/octet-stream", token = "sess", csrfCookie = "csrf", csrfHeader = "csrf" }) {
  const fd = new FormData();
  fd.append("file", new File([bytes], name, { type }));
  const cookie = `base44_session=${token}; __Host-csrf_token=${csrfCookie}`;
  return {
    headers: {
      get: (k) => {
        if (k === "cookie") return cookie;
        if (k === "x-csrf-token") return csrfHeader;
        return "";
      },
    },
    formData: async () => fd,
  };
}

function csvBytes(text) {
  return new TextEncoder().encode(text);
}

describe("validateUpload — server-side upload gate", () => {
  beforeEach(() => {
    uploadFileMock.mockReset();
    uploadFileMock.mockResolvedValue({ file_url: "https://mock-upload.example/file" });
  });

  it("accepts a genuine CSV and stores it under a UUID name (never the original)", async () => {
    const res = await validateUpload(buildReq({
      bytes: csvBytes("date,revenue\n2026-01-01,100\n"),
      name: "daily-report.csv",
      type: "text/csv",
    }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.valid).toBe(true);
    expect(body.ext).toBe("csv");
    expect(body.file_url).toBe("https://mock-upload.example/file");
    expect(body.fileName).toMatch(UUID_RE);
    expect(body.fileName).toMatch(/\.csv$/i);
    expect(body.fileName).not.toContain("daily-report");

    expect(uploadFileMock).toHaveBeenCalledTimes(1);
    const stored = uploadFileMock.mock.calls[0][0].file;
    expect(stored.name).toBe(body.fileName);
    expect(stored.name).not.toBe("daily-report.csv");
  });

  it("accepts a genuine XLSX (ZIP magic bytes)", async () => {
    const res = await validateUpload(buildReq({
      bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00]),
      name: "book.xlsx",
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.valid).toBe(true);
    expect(body.ext).toBe("xlsx");
    expect(body.fileName).toMatch(/\.xlsx$/i);
  });

  it("accepts a genuine XLS (OLE2 magic bytes)", async () => {
    const res = await validateUpload(buildReq({
      bytes: new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      name: "legacy.xls",
      type: "application/vnd.ms-excel",
    }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.valid).toBe(true);
    expect(body.ext).toBe("xls");
    expect(body.fileName).toMatch(/\.xls$/i);
  });

  it("rejects a disallowed extension (.exe is never stored)", async () => {
    const res = await validateUpload(buildReq({
      bytes: new Uint8Array([0x4d, 0x5a]),
      name: "payload.exe",
    }));
    const body = await res.json();
    expect(res.status).toBe(415);
    expect(body.code).toBe("bad_extension");
    expect(uploadFileMock).not.toHaveBeenCalled();
  });

  it("rejects an executable disguised as an XLSX (MZ magic bytes)", async () => {
    const res = await validateUpload(buildReq({
      bytes: new Uint8Array([0x4d, 0x5a, 0x90, 0x00]),
      name: "evil.xlsx",
    }));
    const body = await res.json();
    expect(res.status).toBe(415);
    expect(body.code).toBe("bad_magic");
    expect(uploadFileMock).not.toHaveBeenCalled();
  });

  it("rejects HTML masquerading as CSV (XSS vector)", async () => {
    const res = await validateUpload(buildReq({
      bytes: csvBytes("<!DOCTYPE html><html><head></head><body><script>alert(1)</script></body></html>"),
      name: "report.csv",
    }));
    const body = await res.json();
    expect(res.status).toBe(415);
    expect(body.code).toBe("bad_magic");
    expect(uploadFileMock).not.toHaveBeenCalled();
  });

  it("rejects HTML with leading whitespace masquerading as CSV", async () => {
    const res = await validateUpload(buildReq({
      bytes: csvBytes("   \n<script>alert(1)</script>"),
      name: "report.csv",
    }));
    const body = await res.json();
    expect(res.status).toBe(415);
    expect(body.code).toBe("bad_magic");
  });

  it("rejects a CSV containing binary null bytes", async () => {
    const res = await validateUpload(buildReq({
      bytes: new Uint8Array([0x41, 0x00, 0x42, 0x43]),
      name: "report.csv",
    }));
    const body = await res.json();
    expect(res.status).toBe(415);
    expect(body.code).toBe("bad_magic");
  });

  it("rejects a shebang script renamed to .csv", async () => {
    const res = await validateUpload(buildReq({
      bytes: csvBytes("#!/bin/sh\nrm -rf /"),
      name: "report.csv",
    }));
    const body = await res.json();
    expect(res.status).toBe(415);
    expect(body.code).toBe("bad_magic");
  });

  it("rejects files over the 25MB document cap before reading them", async () => {
    const big = new Uint8Array(25 * 1024 * 1024 + 1);
    const res = await validateUpload(buildReq({
      bytes: big,
      name: "huge.csv",
    }));
    const body = await res.json();
    expect(res.status).toBe(413);
    expect(body.code).toBe("file_too_large");
    expect(uploadFileMock).not.toHaveBeenCalled();
  });

  it("rejects requests with no session cookie", async () => {
    const res = await validateUpload(buildReq({
      bytes: csvBytes("a,b\n1,2"),
      name: "report.csv",
      token: "",
    }));
    expect(res.status).toBe(401);
    expect(uploadFileMock).not.toHaveBeenCalled();
  });

  it("rejects a CSRF token mismatch", async () => {
    const res = await validateUpload(buildReq({
      bytes: csvBytes("a,b\n1,2"),
      name: "report.csv",
      csrfCookie: "cookie-token",
      csrfHeader: "header-token",
    }));
    const body = await res.json();
    expect(res.status).toBe(403);
    expect(body.error).toBe("Invalid CSRF token");
    expect(uploadFileMock).not.toHaveBeenCalled();
  });

  it("rejects a request with no file part", async () => {
    const fd = new FormData();
    fd.append("note", "no file here");
    const req = {
      headers: {
        get: (k) => (k === "cookie" ? "base44_session=sess; __Host-csrf_token=csrf" : k === "x-csrf-token" ? "csrf" : ""),
      },
      formData: async () => fd,
    };
    const res = await validateUpload(req);
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.code).toBe("no_file");
    expect(uploadFileMock).not.toHaveBeenCalled();
  });
});