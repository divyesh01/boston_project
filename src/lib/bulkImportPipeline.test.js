import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  checkDuplicateServer,
  checkRawDuplicateServer,
  uploadRawArchiveToServer,
  recordRawArchiveOnServer,
  uploadBundleToServer,
  activateBundleOnServer,
  supersedeBundleOnServer,
  destroyRawArchiveOnServer,
  deleteBundleOnServer,
  JSON_MUTATION_HEADERS,
} from "./bulkImportPipeline.js";

describe("bulkImportPipeline mutating fetch headers", () => {
  let originalFetch;
  let captured;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    captured = [];
    const fetchStub = /** @type {typeof fetch} */ (/** @type {unknown} */ (vi.fn(async (url, init = {}) => {
      captured.push({ url, init });
      return /** @type {Response} */ (/** @type {unknown} */ ({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, is_duplicate: false, exists: false }),
        headers: new Headers({ "content-type": "application/json" }),
      }));
    })));
    globalThis.fetch = fetchStub;
    vi.stubGlobal("fetch", fetchStub);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.fetch = originalFetch;
  });

  it("exports JSON_MUTATION_HEADERS with XMLHttpRequest and application/json", () => {
    expect(JSON_MUTATION_HEADERS).toEqual({
      "Content-Type": "application/json",
      "X-Requested-With": "XMLHttpRequest",
    });
  });

  it("1. checkDuplicateServer sends POST with X-Requested-With and Content-Type: application/json", async () => {
    await checkDuplicateServer({ serverPropertyId: "prop-1", rawFileHash: "hash-raw", normalizedHash: "hash-norm" });
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe("/api/bulk-import/check-duplicate");
    expect(captured[0].init.method).toBe("POST");
    expect(captured[0].init.headers["X-Requested-With"]).toBe("XMLHttpRequest");
    expect(captured[0].init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(captured[0].init.body)).toEqual({
      server_property_id: "prop-1",
      raw_file_hash: "hash-raw",
      normalized_hash: "hash-norm",
    });
  });

  it("2. checkRawDuplicateServer sends POST with X-Requested-With and Content-Type: application/json", async () => {
    await checkRawDuplicateServer({ serverPropertyId: "prop-1", rawFileHash: "hash-raw" });
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe("/api/bulk-import/raw-check");
    expect(captured[0].init.method).toBe("POST");
    expect(captured[0].init.headers["X-Requested-With"]).toBe("XMLHttpRequest");
    expect(captured[0].init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(captured[0].init.body)).toEqual({
      server_property_id: "prop-1",
      raw_file_hash: "hash-raw",
    });
  });

  it("3. uploadRawArchiveToServer sends PUT with X-Requested-With and preserves binary Content-Type and x-* headers", async () => {
    const rawBuffer = new Uint8Array([1, 2, 3]);
    await uploadRawArchiveToServer({
      serverPropertyId: "prop-1",
      reportType: "occupancy",
      rawFileHash: "hash-raw",
      rawArchiveId: "raw-123",
      originalFileName: "report.csv",
      mimeType: "text/csv",
      reportDate: "2026-01-01",
      rawBuffer,
    });
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe("/api/bulk-import/raw-upload");
    expect(captured[0].init.method).toBe("PUT");
    expect(captured[0].init.headers["X-Requested-With"]).toBe("XMLHttpRequest");
    expect(captured[0].init.headers["Content-Type"]).toBe("text/csv");
    expect(captured[0].init.headers["x-server-property-id"]).toBe("prop-1");
    expect(captured[0].init.headers["x-report-type"]).toBe("occupancy");
    expect(captured[0].init.headers["x-raw-hash"]).toBe("hash-raw");
    expect(captured[0].init.headers["x-archive-id"]).toBe("raw-123");
    expect(captured[0].init.headers["x-file-name"]).toBe("report.csv");
    expect(captured[0].init.headers["x-report-date"]).toBe("2026-01-01");
  });

  it("4. recordRawArchiveOnServer sends POST with X-Requested-With and Content-Type: application/json", async () => {
    const meta = { id: "raw-123", server_property_id: "prop-1", raw_file_hash: "hash-raw" };
    await recordRawArchiveOnServer(meta);
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe("/api/bulk-import/raw-archive");
    expect(captured[0].init.method).toBe("POST");
    expect(captured[0].init.headers["X-Requested-With"]).toBe("XMLHttpRequest");
    expect(captured[0].init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(captured[0].init.body)).toEqual(meta);
  });

  it("5. uploadBundleToServer sends PUT with X-Requested-With, gzip headers, and x-* metadata headers", async () => {
    const compressedBuffer = new Uint8Array([4, 5, 6]);
    await uploadBundleToServer({
      serverPropertyId: "prop-1",
      reportType: "occupancy",
      rawFileHash: "hash-raw",
      normalizedHash: "hash-norm",
      rowCount: 42,
      compressedBuffer,
      identityVersion: 2,
    });
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe("/api/bulk-import/upload");
    expect(captured[0].init.method).toBe("PUT");
    expect(captured[0].init.headers["X-Requested-With"]).toBe("XMLHttpRequest");
    expect(captured[0].init.headers["Content-Type"]).toBe("application/x-ndjson");
    expect(captured[0].init.headers["Content-Encoding"]).toBe("gzip");
    expect(captured[0].init.headers["x-server-property-id"]).toBe("prop-1");
    expect(captured[0].init.headers["x-report-type"]).toBe("occupancy");
    expect(captured[0].init.headers["x-raw-hash"]).toBe("hash-raw");
    expect(captured[0].init.headers["x-normalized-hash"]).toBe("hash-norm");
    expect(captured[0].init.headers["x-row-count"]).toBe("42");
    expect(captured[0].init.headers["x-identity-version"]).toBe("2");
    expect(captured[0].init.headers["x-payload-sha256"]).toBeDefined();
  });

  it("6. activateBundleOnServer sends POST with X-Requested-With and Content-Type: application/json", async () => {
    const meta = { id: "bundle-1", server_property_id: "prop-1" };
    await activateBundleOnServer(meta);
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe("/api/bulk-import/activate");
    expect(captured[0].init.method).toBe("POST");
    expect(captured[0].init.headers["X-Requested-With"]).toBe("XMLHttpRequest");
    expect(captured[0].init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(captured[0].init.body)).toEqual(meta);
  });

  it("7. supersedeBundleOnServer sends POST with X-Requested-With and Content-Type: application/json", async () => {
    await supersedeBundleOnServer({ oldBundleId: "old-1", newBundleId: "new-2" });
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe("/api/bulk-import/supersede");
    expect(captured[0].init.method).toBe("POST");
    expect(captured[0].init.headers["X-Requested-With"]).toBe("XMLHttpRequest");
    expect(captured[0].init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(captured[0].init.body)).toEqual({
      old_bundle_id: "old-1",
      new_bundle_id: "new-2",
    });
  });

  it("8. destroyRawArchiveOnServer sends POST with X-Requested-With and Content-Type: application/json", async () => {
    await destroyRawArchiveOnServer({ archiveId: "raw-123", confirmDestroy: true });
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe("/api/bulk-import/raw-destroy");
    expect(captured[0].init.method).toBe("POST");
    expect(captured[0].init.headers["X-Requested-With"]).toBe("XMLHttpRequest");
    expect(captured[0].init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(captured[0].init.body)).toEqual({
      archive_id: "raw-123",
      confirm_destroy: true,
    });
  });

  it("9. deleteBundleOnServer sends POST with X-Requested-With and Content-Type: application/json", async () => {
    await deleteBundleOnServer({ bundleId: "bundle-1", serverPropertyId: "prop-1" });
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe("/api/bulk-import/delete");
    expect(captured[0].init.method).toBe("POST");
    expect(captured[0].init.headers["X-Requested-With"]).toBe("XMLHttpRequest");
    expect(captured[0].init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(captured[0].init.body)).toEqual({
      bundle_id: "bundle-1",
      server_property_id: "prop-1",
    });
  });
});
