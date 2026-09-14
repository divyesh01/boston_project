import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { AwsClient } from "aws4fetch";
import { isR2S3Enabled, resolveR2S3Stores } from "../worker/r2-s3-adapter.js";

// Synthetic redaction fixture assembled at runtime; it is not an account credential.
const redactionFixture = ["redaction", "fixture", "value"].join(":");
const ENV = {
  R2_S3_ENABLED: "true",
  R2_S3_ACCOUNT_ID: "a".repeat(32),
  R2_S3_RAW_BUCKET: "rri-raw-canary-a61a110",
  R2_S3_DATA_BUCKET: "rri-data-canary-a61a110",
  R2_S3_ACCESS_KEY_ID: "fake-access-key",
  R2_S3_SECRET_ACCESS_KEY: redactionFixture,
};

let assertions = 0;
const check = (condition, message) => {
  assert.ok(condition, message);
  assertions += 1;
};

function fakeClientFactory(responder, calls = [], optionsSeen = []) {
  return (options) => {
    optionsSeen.push(options);
    return {
      async fetch(url, init = {}) {
        calls.push({ url: String(url), init });
        return responder(String(url), init, calls.length - 1);
      },
    };
  };
}

check(isR2S3Enabled({ R2_S3_ENABLED: "true" }), "string true enables S3 mode");
check(isR2S3Enabled({ R2_S3_ENABLED: true }), "boolean true enables S3 mode");
for (const value of [undefined, false, "false", "1", 1, ""]) {
  check(!isR2S3Enabled({ R2_S3_ENABLED: value }), `value ${String(value)} keeps native mode`);
}
check(resolveR2S3Stores({}) === null, "disabled S3 mode does not require configuration");

{
  let error;
  try {
    resolveR2S3Stores({ R2_S3_ENABLED: "true", R2_S3_SECRET_ACCESS_KEY: redactionFixture });
  } catch (caught) {
    error = caught;
  }
  check(error?.code === "R2_S3_CONFIG_MISSING", "incomplete S3 configuration fails closed");
  check(!String(error?.message).includes(redactionFixture), "configuration error does not expose secrets");
}

{
  const calls = [];
  const optionsSeen = [];
  const factory = fakeClientFactory(() => new Response(null, {
    status: 200,
    headers: { etag: '"created"' },
  }), calls, optionsSeen);
  const { rawStore } = resolveR2S3Stores(ENV, { clientFactory: factory });
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("payload"));
      controller.close();
    },
  });
  const digest = "b".repeat(64);
  const result = await rawStore.put("rri-raw/account/property/Café report.csv", stream, {
    customMetadata: { original_file_name: "Café ✓.csv", account_id: "account" },
    httpMetadata: { contentType: "text/csv" },
    sha256: digest,
    onlyIf: { etagDoesNotMatch: "*" },
  });
  const request = calls[0];
  const url = new URL(request.url);
  check(url.origin === `https://${"a".repeat(32)}.r2.cloudflarestorage.com`, "endpoint is derived from account ID");
  check(url.pathname.includes("/rri-raw-canary-a61a110/rri-raw/account/property/Caf%C3%A9%20report.csv"), "object key is encoded per path segment");
  check(request.init.method === "PUT" && request.init.body === stream, "PUT preserves the streaming body");
  check(request.init.headers.get("if-none-match") === "*", "conditional write sends If-None-Match star");
  check(request.init.headers.get("x-amz-content-sha256") === digest, "expected payload digest is sent to R2");
  check(request.init.headers.get("x-amz-meta-original_file_name").startsWith("=?UTF-8?B?"), "Unicode metadata uses RFC 2047");
  check(request.init.headers.get("content-type") === "text/csv", "HTTP metadata is forwarded");
  check(result.etag === "created", "PUT response exposes the normalized ETag");
  check(optionsSeen[0].service === "s3" && optionsSeen[0].region === "auto", "client uses the documented R2 signing scope");
  check(!("fetch" in optionsSeen[0]), "AwsClient receives only documented constructor options");
}

{
  const unicode = "Café ✓.csv";
  const encoded = Buffer.from(unicode, "utf8").toString("base64");
  const factory = fakeClientFactory(() => new Response(null, {
    status: 200,
    headers: {
      etag: '"head-etag"',
      "content-length": "42",
      "last-modified": "Wed, 01 Jan 2025 00:00:00 GMT",
      "content-type": "text/csv",
      "x-amz-meta-original_file_name": `=?UTF-8?B?${encoded}?=`,
    },
  }));
  const head = await resolveR2S3Stores(ENV, { clientFactory: factory }).rawStore.head("key");
  check(head.etag === "head-etag" && head.httpEtag === '"head-etag"', "HEAD exposes both ETag forms");
  check(head.size === 42 && head.uploaded instanceof Date, "HEAD exposes size and upload time");
  check(head.customMetadata.original_file_name === unicode, "RFC 2047 metadata round-trips");
  check(head.httpMetadata.contentType === "text/csv", "HEAD exposes HTTP metadata");
}

{
  const factory = fakeClientFactory(() => new Response('{"ok":true}', {
    status: 200,
    headers: { "content-type": "application/json", "content-length": "11" },
  }));
  const object = await resolveR2S3Stores(ENV, { clientFactory: factory }).bulkStore.get("key");
  check(object.body instanceof ReadableStream, "GET exposes a readable body");
  check((await object.json()).ok === true, "GET exposes Response-compatible readers");
  check(object.bodyUsed === true, "GET readers follow the one-consumption Body contract");
}

{
  const factory = fakeClientFactory(() => new Response("missing", { status: 404 }));
  const store = resolveR2S3Stores(ENV, { clientFactory: factory }).rawStore;
  check(await store.head("missing") === null, "HEAD maps 404 to null");
  check(await store.get("missing") === null, "GET maps 404 to null");
}

{
  const calls = [];
  const factory = fakeClientFactory(() => new Response("precondition", { status: 412 }), calls);
  const result = await resolveR2S3Stores(ENV, { clientFactory: factory }).rawStore.put("key", "body", {
    onlyIf: { etagDoesNotMatch: "*" },
  });
  check(result === null, "conditional PUT maps 412 to native R2 null semantics");
  check(calls[0].init.headers.get("if-none-match") === "*", "412 probe used a conditional write");
}

{
  const calls = [];
  const factory = fakeClientFactory(() => new Response(null, { status: 204 }), calls);
  await resolveR2S3Stores(ENV, { clientFactory: factory }).bulkStore.delete("key");
  check(calls[0].init.method === "DELETE", "DELETE uses the S3 object operation");
}

{
  const factory = () => ({ fetch: async () => { throw new Error(`Authorization ${redactionFixture}`); } });
  let error;
  try {
    await resolveR2S3Stores(ENV, { clientFactory: factory }).rawStore.head("key");
  } catch (caught) {
    error = caught;
  }
  check(error?.status === 503 && error?.code === "R2_S3_HEAD_FAILED", "network failures use a stable safe error");
  check(!String(error?.message).includes(redactionFixture) && !String(error?.message).includes("Authorization"), "network failure details are redacted");
}

{
  const digest = "c".repeat(64);
  const client = new AwsClient({
    accessKeyId: "fake-access-key",
    secretAccessKey: "fake-secret-key",
    service: "s3",
    region: "auto",
  });
  const signed = await client.sign(`https://${"a".repeat(32)}.r2.cloudflarestorage.com/bucket/key`, {
    method: "PUT",
    headers: { "x-amz-content-sha256": digest },
    body: new Uint8Array([1, 2, 3]),
  });
  check(signed.headers.get("authorization")?.startsWith("AWS4-HMAC-SHA256 Credential=fake-access-key/"), "AwsClient emits SigV4 authorization");
  check(/^\d{8}T\d{6}Z$/.test(signed.headers.get("x-amz-date") || ""), "AwsClient emits an AWS timestamp");
  check(signed.headers.get("x-amz-content-sha256") === digest, "AwsClient signs the supplied payload digest");

  const streamSigned = await client.sign(`https://${"a".repeat(32)}.r2.cloudflarestorage.com/bucket/key`, {
    method: "PUT",
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    }),
  });
  check(streamSigned.headers.get("x-amz-content-sha256") === "UNSIGNED-PAYLOAD", "AwsClient supports streaming S3 bodies without buffering");
}

for (const key of ["/leading", "a/../b", "a/./b"]) {
  const factory = fakeClientFactory(() => new Response(null, { status: 200 }));
  let error;
  try {
    await resolveR2S3Stores(ENV, { clientFactory: factory }).rawStore.head(key);
  } catch (caught) {
    error = caught;
  }
  check(error?.code === "R2_S3_CONFIG_MISSING", `ambiguous key ${key} fails closed`);
}

{
  const factory = fakeClientFactory(() => new Response(null, { status: 200 }));
  let error;
  try {
    await resolveR2S3Stores(ENV, { clientFactory: factory }).rawStore.put("key", "body", {
      onlyIf: { etagMatches: "unexpected" },
    });
  } catch (caught) {
    error = caught;
  }
  check(error?.code === "R2_S3_CONFIG_MISSING", "unsupported conditional writes fail closed");
}

{
  const source = await readFile(new URL("../worker/bulk-import.js", import.meta.url), "utf8");
  check(!source.includes("env.RAW_ARCHIVE.head("), "bulk import has no direct native-binding HEAD bypass");
  check(source.includes("verifyObject(await rawStore.head(sourceKey)"), "activation resolves the raw store through the adapter boundary");
  check(source.includes("if (created === null)"), "upload paths handle conditional-write races");
}

console.log(`PASSED: R2 S3 adapter probe (${assertions} assertions)`);
process.exitCode = assertions > 0 ? 0 : 1;
