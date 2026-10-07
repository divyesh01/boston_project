// Synthetic local fixture only; this entry is never wired into production.
import { handleBulkImportRequest } from "../../../worker/bulk-import.js";

function createBoundedStream(inputStream, maxBytes, emptyCode = "IMPORT_EMPTY_PAYLOAD") {
  let bytesRead = 0;
  const transform = new TransformStream({
    transform(chunk, controller) {
      bytesRead += chunk.byteLength;
      if (bytesRead > maxBytes) {
        controller.error(new Error(`PAYLOAD_TOO_LARGE: ${bytesRead} > ${maxBytes}`));
        return;
      }
      controller.enqueue(chunk);
    },
    flush(controller) {
      if (bytesRead === 0) {
        controller.error(new Error(`IMPORT_EMPTY_PAYLOAD: 0 bytes`));
      }
    },
  });

  return {
    stream: inputStream.pipeThrough(transform),
    getBytesRead: () => bytesRead,
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/prove-old-failure") {
      // Replicate the exact old behavior in uploadRawArchive:
      // bounded.stream passed directly to native R2 rawStore.put()
      const bounded = createBoundedStream(request.body, 50 * 1024 * 1024);
      try {
        await env.RAW_ARCHIVE.put("test-key-old", bounded.stream);
        return new Response(JSON.stringify({ ok: true, message: "unexpected success" }), { status: 200 });
      } catch (err) {
        return new Response(JSON.stringify({
          ok: false,
          errorName: err?.name,
          errorMessage: err?.message,
          stack: err?.stack,
        }), { status: 500, headers: { "Content-Type": "application/json" } });
      }
    }

    if (url.pathname === "/prove-arraybuffer-success") {
      const bounded = createBoundedStream(request.body, 50 * 1024 * 1024);
      try {
        const buf = await new Response(bounded.stream).arrayBuffer();
        const obj = await env.RAW_ARCHIVE.put("test-key-buf", buf);
        return new Response(JSON.stringify({
          ok: true,
          key: obj.key,
          size: obj.size,
          bytesRead: bounded.getBytesRead(),
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      } catch (err) {
        return new Response(JSON.stringify({
          ok: false,
          errorMessage: err?.message,
        }), { status: 500, headers: { "Content-Type": "application/json" } });
      }
    }

    if (url.pathname === "/prove-fixedlength-success") {
      const cl = Number(request.headers.get("content-length") || 0);
      const bounded = createBoundedStream(request.body, 50 * 1024 * 1024);
      try {
        const NativeFixedLengthStream = /** @type {{ FixedLengthStream: new (length: number) => TransformStream }} */ (/** @type {unknown} */ (globalThis)).FixedLengthStream;
        const fixed = bounded.stream.pipeThrough(new NativeFixedLengthStream(cl));
        const obj = await env.RAW_ARCHIVE.put("test-key-fixed", fixed);
        return new Response(JSON.stringify({
          ok: true,
          key: obj.key,
          size: obj.size,
          bytesRead: bounded.getBytesRead(),
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      } catch (err) {
        return new Response(JSON.stringify({
          ok: false,
          errorMessage: err?.message,
        }), { status: 500, headers: { "Content-Type": "application/json" } });
      }
    }

    if (url.pathname === "/inspect-object") {
      const key = url.searchParams.get("key");
      const obj = await env.RAW_ARCHIVE.head(key);
      return new Response(JSON.stringify({
        exists: !!obj,
        key,
        size: obj?.size ?? null,
        customMetadata: obj?.customMetadata ?? null,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    if (url.pathname === "/seed-object" && request.method === "POST") {
      const body = await request.json();
      const obj = await env.RAW_ARCHIVE.put(body.key, body.content || "seed", {
        customMetadata: body.customMetadata || {},
      });
      return new Response(JSON.stringify({ ok: true, key: obj.key }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/prove-consumed-oversize") {
      let chunksYielded = 0;
      const chunk10MB = new Uint8Array(10 * 1024 * 1024);
      const largeStream = new ReadableStream({
        pull(controller) {
          if (chunksYielded < 6) { // 6 * 10MB = 60MB > 50MB
            chunksYielded++;
            controller.enqueue(chunk10MB);
          } else {
            controller.close();
          }
        },
      });
      const req = new Request("http://127.0.0.1/api/bulk-import/raw-upload", {
        method: "PUT",
        headers: {
          "x-server-property-id": "prop_test",
          "x-report-type": "occupancy",
          "x-raw-hash": "2".repeat(64),
          "content-length": String(50 * 1024 * 1024),
        },
        body: largeStream,
        duplex: "half",
      });
      const mockScope = {
        accountId: "acc-12345678901234567890123456789012",
        propertyIds: ["prop_test"],
        user: { id: "user-1", role: "owner" },
      };
      const mockEnv = {
        ...env,
        BULK_DATA: env.RAW_ARCHIVE,
        DB: { prepare: () => ({ bind: () => ({ first: async () => null, all: async () => ({ results: [] }), run: async () => ({ success: true }) }) }) },
      };
      const res = await handleBulkImportRequest(req, mockEnv, mockScope, new URL(req.url), ["api", "bulk-import", "raw-upload"]);
      const data = await res.json();
      return new Response(JSON.stringify({ status: res.status, json: data }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/prove-stream-length-mismatch") {
      const mode = url.searchParams.get("mode"); // "shorter" or "longer"
      const declared = mode === "shorter" ? 10 : 50;
      const actualBytes = mode === "shorter" ? new Uint8Array(20) : new Uint8Array(10);
      const hash = mode === "shorter" ? "5".repeat(64) : "6".repeat(64);
      const req = new Request("http://127.0.0.1/api/bulk-import/raw-upload", {
        method: "PUT",
        headers: {
          "x-server-property-id": "prop_test",
          "x-report-type": "occupancy",
          "x-raw-hash": hash,
          "content-length": String(declared),
        },
        body: actualBytes,
      });
      const mockScope = {
        accountId: "acc-12345678901234567890123456789012",
        propertyIds: ["prop_test"],
        user: { id: "user-1", role: "owner" },
      };
      const mockEnv = {
        ...env,
        BULK_DATA: env.RAW_ARCHIVE,
        DB: { prepare: () => ({ bind: () => ({ first: async () => null, all: async () => ({ results: [] }), run: async () => ({ success: true }) }) }) },
      };
      const res = await handleBulkImportRequest(req, mockEnv, mockScope, new URL(req.url), ["api", "bulk-import", "raw-upload"]);
      const data = await res.json();
      return new Response(JSON.stringify({ status: res.status, json: data }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/prove-header-oversize") {
      const req = new Request("http://127.0.0.1/api/bulk-import/raw-upload", {
        method: "PUT",
        headers: {
          "x-server-property-id": "prop_test",
          "x-report-type": "occupancy",
          "x-raw-hash": "1".repeat(64),
          "content-length": String(55 * 1024 * 1024),
        },
        body: "short",
      });
      const mockScope = {
        accountId: "acc-12345678901234567890123456789012",
        propertyIds: ["prop_test"],
        user: { id: "user-1", role: "owner" },
      };
      const mockEnv = {
        ...env,
        BULK_DATA: env.RAW_ARCHIVE,
        DB: { prepare: () => ({ bind: () => ({ first: async () => null, all: async () => ({ results: [] }), run: async () => ({ success: true }) }) }) },
      };
      const res = await handleBulkImportRequest(req, mockEnv, mockScope, new URL(req.url), ["api", "bulk-import", "raw-upload"]);
      const data = await res.json();
      return new Response(JSON.stringify({ status: res.status, json: data }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/prove-missing-cl-oversize") {
      let chunksYielded = 0;
      const chunk2MB = new Uint8Array(2 * 1024 * 1024);
      const stream12MB = new ReadableStream({
        pull(controller) {
          if (chunksYielded < 6) { // 6 * 2MB = 12MB > 10MB
            chunksYielded++;
            controller.enqueue(chunk2MB);
          } else {
            controller.close();
          }
        },
      });
      const req = new Request("http://127.0.0.1/api/bulk-import/raw-upload", {
        method: "PUT",
        headers: {
          "x-server-property-id": "prop_test",
          "x-report-type": "occupancy",
          "x-raw-hash": "4".repeat(64),
        },
        body: stream12MB,
        duplex: "half",
      });
      const mockScope = {
        accountId: "acc-12345678901234567890123456789012",
        propertyIds: ["prop_test"],
        user: { id: "user-1", role: "owner" },
      };
      const mockEnv = {
        ...env,
        BULK_DATA: env.RAW_ARCHIVE,
        DB: { prepare: () => ({ bind: () => ({ first: async () => null, all: async () => ({ results: [] }), run: async () => ({ success: true }) }) }) },
      };
      const res = await handleBulkImportRequest(req, mockEnv, mockScope, new URL(req.url), ["api", "bulk-import", "raw-upload"]);
      const data = await res.json();
      return new Response(JSON.stringify({ status: res.status, json: data }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/prove-invalid-cl") {
      const val = url.searchParams.get("val");
      const req = new Request("http://127.0.0.1/api/bulk-import/raw-upload", {
        method: "PUT",
        headers: {
          "x-server-property-id": "prop_test",
          "x-report-type": "occupancy",
          "x-raw-hash": "3".repeat(64),
          "content-length": val,
        },
        body: "test",
      });
      const mockScope = {
        accountId: "acc-12345678901234567890123456789012",
        propertyIds: ["prop_test"],
        user: { id: "user-1", role: "owner" },
      };
      const mockEnv = {
        ...env,
        BULK_DATA: env.RAW_ARCHIVE,
        DB: { prepare: () => ({ bind: () => ({ first: async () => null, all: async () => ({ results: [] }), run: async () => ({ success: true }) }) }) },
      };
      const res = await handleBulkImportRequest(req, mockEnv, mockScope, new URL(req.url), ["api", "bulk-import", "raw-upload"]);
      const data = await res.json();
      return new Response(JSON.stringify({ status: res.status, json: data }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname.startsWith("/api/bulk-import/")) {
      const role = request.headers.get("x-test-role") || "owner";
      const accountId = request.headers.get("x-test-account-id") || "acc-12345678901234567890123456789012";
      const propertyIds = request.headers.has("x-test-property-ids")
        ? request.headers.get("x-test-property-ids").split(",").map((s) => s.trim())
        : ["prop_test"];

      const mockScope = {
        accountId,
        propertyIds,
        user: { id: "user-1", role },
      };
      // Supply mock DB if needed
      const mockEnv = {
        ...env,
        BULK_DATA: env.RAW_ARCHIVE, // for getStores check
        DB: {
          prepare: () => ({
            bind: () => ({
              first: async () => null,
              all: async () => ({ results: [] }),
              run: async () => ({ success: true }),
            }),
          }),
        },
      };
      const parts = url.pathname.split("/").filter(Boolean);
      return await handleBulkImportRequest(request, mockEnv, mockScope, url, parts);
    }

    return new Response("Not found", { status: 404 });
  },
};
