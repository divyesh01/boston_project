// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  BULK_ENTITIES,
  REPORT_ENTITY,
  normalizedContent,
  contentHash,
  parseBundle,
} from "../../worker/bulk-contract.js";
import { handleBulkImportRequest } from "../../worker/bulk-import.js";
import {
  compressPayloadGzip,
  decompressPayloadGzip,
} from "./bulkImportPipeline.js";

describe("Bulk Import Identity, Validation & Wire Invariants", () => {
  // ── 1. Canonical Hash Semantics & Invariants ──────────────────────────────
  describe("1. Canonical Hash Semantics", () => {
    it("normalizedContent strips all provenance fields and canonically sorts keys recursively", async () => {
      const rowWithProvenance = {
        id: 999999,
        import_id: "raw_test_123",
        bulk_import_id: "raw_test_123",
        created_date: "2026-09-23T00:00:00Z",
        updated_date: "2026-09-23T01:00:00Z",
        source_file: "upload.csv",
        property_name: "Test Hotel",
        file_hash: "abcd1234efgh5678",
        raw_archive_id: "raw_test_123",
        // Business data in reverse alphabetical order:
        revenue: 125000,
        rooms_sold: 85,
        occupancy_rate: 85.5,
        date: "2026-01-15",
        property_id: "prop_1",
      };

      const result = normalizedContent([{ entity: "OccupancyDay", row: rowWithProvenance }]);
      const parsed = JSON.parse(result);

      // Check that provenance fields are strictly absent
      expect(parsed.row.id).toBeUndefined();
      expect(parsed.row.import_id).toBeUndefined();
      expect(parsed.row.bulk_import_id).toBeUndefined();
      expect(parsed.row.created_date).toBeUndefined();
      expect(parsed.row.updated_date).toBeUndefined();
      expect(parsed.row.source_file).toBeUndefined();
      expect(parsed.row.property_name).toBeUndefined();
      expect(parsed.row.file_hash).toBeUndefined();
      expect(parsed.row.raw_archive_id).toBeUndefined();

      // Check that business fields are preserved
      expect(parsed.entity).toBe("OccupancyDay");
      expect(parsed.row.date).toBe("2026-01-15");
      expect(parsed.row.property_id).toBe("prop_1");
      expect(parsed.row.occupancy_rate).toBe(85.5);
      expect(parsed.row.revenue).toBe(125000);
      expect(parsed.row.rooms_sold).toBe(85);

      // Key order in serialized JSON must be deterministic (sorted)
      const rowKeys = Object.keys(parsed.row);
      expect(rowKeys).toEqual(["date", "occupancy_rate", "property_id", "revenue", "rooms_sold"]);
    });

    it("normalizedContent produces identical hash regardless of row arrival order", async () => {
      const rowA = { entity: "OccupancyDay", row: { property_id: "prop_1", date: "2026-01-01", revenue: 100 } };
      const rowB = { entity: "OccupancyDay", row: { property_id: "prop_1", date: "2026-01-02", revenue: 200 } };

      const hashOrder1 = await contentHash(normalizedContent([rowA, rowB]));
      const hashOrder2 = await contentHash(normalizedContent([rowB, rowA]));

      expect(hashOrder1).toBe(hashOrder2);
      expect(hashOrder1).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  // ── 2. Version Coexistence (identityVersion 1 vs 2) ────────────────────────
  describe("2. Version Coexistence & Wire Invariants", () => {
    it("identityVersion 1 preserves exact raw text hashing bit-for-bit including whitespace and blanks", async () => {
      const rawText = '{"entity":"OccupancyDay","row":{"property_id":"prop_1","date":"2026-01-01","id":1}}\n\n';
      const v1Hash = await contentHash(rawText);

      // Must be exact SHA-256 of the raw decompressed text bytes
      const expectedHash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawText))
        .then((buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join(""));

      expect(v1Hash).toBe(expectedHash);
    });

    it("identityVersion 1 and identityVersion 2 hashes are deterministically distinct for rows with provenance", async () => {
      const items = [
        {
          entity: "OccupancyDay",
          row: {
            id: 1,
            property_id: "prop_1",
            date: "2026-01-01",
            revenue: 50000,
            import_id: "raw_1",
          },
        },
      ];
      const rawText = items.map((it) => JSON.stringify(it)).join("\n");

      // v1 hashes the raw text directly (preserving exact wire bytes)
      const v1Hash = await contentHash(rawText);

      // v2 hashes the normalized canonical content (stripping provenance)
      const v2Hash = await contentHash(normalizedContent(items));

      expect(v1Hash).toMatch(/^[a-f0-9]{64}$/);
      expect(v2Hash).toMatch(/^[a-f0-9]{64}$/);
      expect(v1Hash).not.toBe(v2Hash);
    });
  });

  // ── 3. Compression / Decompression Round-trip ─────────────────────────────
  describe("3. Compression / Decompression Round-trip", () => {
    it("compressPayloadGzip and decompressPayloadGzip round-trip correctly within bounds", async () => {
      const originalText = "entity\tOccupancyDay\ndate\t2026-01-01\n".repeat(1000);
      const compressed = await compressPayloadGzip(originalText);
      expect(compressed.byteLength).toBeGreaterThan(0);
      expect(compressed.byteLength).toBeLessThan(originalText.length);

      const decompressed = await decompressPayloadGzip(compressed);
      expect(decompressed).toBe(originalText);
    });
  });

  // ── 4. Worker uploadBundle Validation & Failure Invariants ────────────────
  describe("4. Worker uploadBundle Validation & Safe Failure Invariants", () => {
    let mockEnv;
    let mockScope;
    let putCalls;

    beforeEach(() => {
      putCalls = [];
      mockEnv = {
        RAW_ARCHIVE: {
          head: vi.fn().mockResolvedValue(null),
          get: vi.fn().mockResolvedValue(null),
          put: vi.fn().mockImplementation(async (key, stream, options) => {
            putCalls.push({ key, options });
            return {};
          }),
          delete: vi.fn().mockResolvedValue({}),
        },
        BULK_DATA: {
          head: vi.fn().mockResolvedValue(null),
          get: vi.fn().mockResolvedValue(null),
          put: vi.fn().mockImplementation(async (key, bytes, options) => {
            putCalls.push({ key, bytes, options });
            return {};
          }),
          delete: vi.fn().mockResolvedValue({}),
        },
      };
      mockScope = {
        accountId: "acc-1",
        user: { id: "u-1", role: "owner" },
        propertyIds: ["prop-1"],
      };
    });

    it("accepts valid gzip bundle, verifies hash and single entity, and stores once in bulkStore", async () => {
      const items = [
        { entity: "OccupancyDay", row: { property_id: "prop-1", date: "2026-01-01", occupancy_rate: 80 } },
        { entity: "OccupancyDay", row: { property_id: "prop-1", date: "2026-01-02", occupancy_rate: 85 } },
      ];
      const ndjson = items.map((it) => JSON.stringify(it)).join("\n");
      const compressed = await compressPayloadGzip(ndjson);
      const normalizedHash = await contentHash(normalizedContent(items));

      const request = new Request("https://example.com/api/bulk-import/upload", {
        method: "PUT",
        headers: {
          "content-type": "application/x-ndjson",
          "content-encoding": "gzip",
          "x-server-property-id": "prop-1",
          "x-report-type": "occupancy",
          "x-raw-hash": "a".repeat(64),
          "x-normalized-hash": normalizedHash,
          "x-row-count": "2",
          "x-identity-version": "2",
        },
        body: compressed,
      });

      const response = await handleBulkImportRequest(
        request,
        mockEnv,
        mockScope,
        new URL(request.url),
        ["api", "bulk-import", "upload"]
      );

      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.ok).toBe(true);
      expect(data.status).toBe("uploaded");
      expect(data.normalized_hash).toBe(normalizedHash);

      // Verify bulkStore.put was called with exact metadata
      expect(putCalls).toHaveLength(1);
      const putCall = putCalls[0];
      expect(putCall.options.customMetadata.row_count).toBe("2");
      expect(putCall.options.customMetadata.report_type).toBe("occupancy");
      expect(putCall.options.customMetadata.min_date).toBe("2026-01-01");
      expect(putCall.options.customMetadata.max_date).toBe("2026-01-02");
    });

    it("v1 bundle upload verifies exact text hash and matches legacy behavior", async () => {
      const items = [
        { entity: "OccupancyDay", row: { property_id: "prop-1", date: "2026-01-01", revenue: 500 } },
      ];
      const text = items.map((it) => JSON.stringify(it)).join("\n");
      const compressed = await compressPayloadGzip(text);
      const v1Hash = await contentHash(text);

      const request = new Request("https://example.com/api/bulk-import/upload", {
        method: "PUT",
        headers: {
          "content-type": "application/x-ndjson",
          "content-encoding": "gzip",
          "x-server-property-id": "prop-1",
          "x-report-type": "occupancy",
          "x-raw-hash": "a".repeat(64),
          "x-normalized-hash": v1Hash,
          "x-row-count": "1",
          "x-identity-version": "1",
        },
        body: compressed,
      });

      const response = await handleBulkImportRequest(
        request,
        mockEnv,
        mockScope,
        new URL(request.url),
        ["api", "bulk-import", "upload"]
      );

      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.ok).toBe(true);
      expect(data.normalized_hash).toBe(v1Hash);
      expect(putCalls).toHaveLength(1);
    });

    it("rejects bundle with malformed JSON and NEVER writes to storage", async () => {
      const malformedText = '{"entity":"OccupancyDay","row":{"property_id":"prop-1"}}\n{invalid-json\n';
      const compressed = await compressPayloadGzip(malformedText);

      const request = new Request("https://example.com/api/bulk-import/upload", {
        method: "PUT",
        headers: {
          "x-server-property-id": "prop-1",
          "x-report-type": "occupancy",
          "x-raw-hash": "a".repeat(64),
          "x-normalized-hash": "b".repeat(64),
          "x-row-count": "2",
          "x-identity-version": "2",
        },
        body: compressed,
      });

      const response = await handleBulkImportRequest(
        request,
        mockEnv,
        mockScope,
        new URL(request.url),
        ["api", "bulk-import", "upload"]
      );

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.code).toBe("IMPORT_INVALID_BUNDLE");

      // Critical safety invariant: storage was NOT modified
      expect(putCalls).toHaveLength(0);
    });

    it("rejects bundle with mismatched property_id and NEVER writes to storage", async () => {
      const items = [
        { entity: "OccupancyDay", row: { property_id: "wrong-property", date: "2026-01-01" } },
      ];
      const compressed = await compressPayloadGzip(items.map((it) => JSON.stringify(it)).join("\n"));
      const normalizedHash = await contentHash(normalizedContent(items));

      const request = new Request("https://example.com/api/bulk-import/upload", {
        method: "PUT",
        headers: {
          "x-server-property-id": "prop-1",
          "x-report-type": "occupancy",
          "x-raw-hash": "a".repeat(64),
          "x-normalized-hash": normalizedHash,
          "x-row-count": "1",
          "x-identity-version": "2",
        },
        body: compressed,
      });

      const response = await handleBulkImportRequest(
        request,
        mockEnv,
        mockScope,
        new URL(request.url),
        ["api", "bulk-import", "upload"]
      );

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.code).toBe("IMPORT_INVALID_BUNDLE");
      expect(putCalls).toHaveLength(0);
    });

    it("rejects bundle with normalized_hash mismatch and NEVER writes to storage", async () => {
      const items = [
        { entity: "OccupancyDay", row: { property_id: "prop-1", date: "2026-01-01" } },
      ];
      const compressed = await compressPayloadGzip(items.map((it) => JSON.stringify(it)).join("\n"));

      const request = new Request("https://example.com/api/bulk-import/upload", {
        method: "PUT",
        headers: {
          "x-server-property-id": "prop-1",
          "x-report-type": "occupancy",
          "x-raw-hash": "a".repeat(64),
          "x-normalized-hash": "f".repeat(64), // Falsely claimed hash
          "x-row-count": "1",
          "x-identity-version": "2",
        },
        body: compressed,
      });

      const response = await handleBulkImportRequest(
        request,
        mockEnv,
        mockScope,
        new URL(request.url),
        ["api", "bulk-import", "upload"]
      );

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.code).toBe("BUNDLE_HASH_MISMATCH");
      expect(putCalls).toHaveLength(0);
    });

    it("rejects bundle with row-count mismatch and NEVER writes to storage", async () => {
      const items = [
        { entity: "OccupancyDay", row: { property_id: "prop-1", date: "2026-01-01" } },
      ];
      const compressed = await compressPayloadGzip(items.map((it) => JSON.stringify(it)).join("\n"));
      const normalizedHash = await contentHash(normalizedContent(items));

      const request = new Request("https://example.com/api/bulk-import/upload", {
        method: "PUT",
        headers: {
          "x-server-property-id": "prop-1",
          "x-report-type": "occupancy",
          "x-raw-hash": "a".repeat(64),
          "x-normalized-hash": normalizedHash,
          "x-row-count": "999", // Claims 999 rows, but payload has 1
          "x-identity-version": "2",
        },
        body: compressed,
      });

      const response = await handleBulkImportRequest(
        request,
        mockEnv,
        mockScope,
        new URL(request.url),
        ["api", "bulk-import", "upload"]
      );

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.code).toBe("BUNDLE_HASH_MISMATCH");
      expect(putCalls).toHaveLength(0);
    });

  });

  // ── 5. Worker uploadRawArchive no-partial-write invariant ────────────────
  describe("5. Worker uploadRawArchive no-partial-write invariant", () => {
    let mockEnv;
    let mockScope;
    let rawPutCalls;

    beforeEach(() => {
      rawPutCalls = [];
      mockEnv = {
        RAW_ARCHIVE: {
          head: vi.fn().mockResolvedValue(null),
          get: vi.fn().mockResolvedValue(null),
          put: vi.fn().mockImplementation(async (key, stream, options) => {
            rawPutCalls.push({ key, options });
            return {};
          }),
          delete: vi.fn().mockResolvedValue({}),
        },
        BULK_DATA: {
          head: vi.fn().mockResolvedValue(null),
          get: vi.fn().mockResolvedValue(null),
          put: vi.fn().mockResolvedValue({}),
          delete: vi.fn().mockResolvedValue({}),
        },
      };
      mockScope = {
        accountId: "acc-1",
        user: { id: "u-1", role: "owner" },
        propertyIds: ["prop-1"],
      };
    });

    it("streams an authorized raw archive to storage", async () => {
      const rawBytes = new TextEncoder().encode("Date,Revenue\n2026-01-01,500\n");
      const rawHash = await contentHash("Date,Revenue\n2026-01-01,500\n");

      const request = new Request("https://example.com/api/bulk-import/raw-upload", {
        method: "PUT",
        headers: {
          "content-length": String(rawBytes.byteLength),
          "x-server-property-id": "prop-1",
          "x-report-type": "occupancy",
          "x-raw-hash": rawHash,
          "x-archive-id": "raw_archive_1",
          "x-file-name": "jan_occupancy.csv",
        },
        body: rawBytes,
      });

      const response = await handleBulkImportRequest(
        request,
        mockEnv,
        mockScope,
        new URL(request.url),
        ["api", "bulk-import", "raw-upload"]
      );

      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.status).toBe("archived");
      expect(data.raw_hash).toBe(rawHash);
      expect(rawPutCalls).toHaveLength(1);
    });

  });
});
