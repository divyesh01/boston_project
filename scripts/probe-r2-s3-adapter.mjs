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

const B2_ENV = {
  S3_ENABLED: "true",
  S3_ENDPOINT: "https://s3.us-west-004.backblazeb2.com",
  S3_RAW_BUCKET: "rri-raw-canary-b2",
  S3_DATA_BUCKET: "rri-data-canary-b2",
  S3_ACCESS_KEY_ID: "synthetic-b2-key-id",
  S3_SECRET_ACCESS_KEY: redactionFixture,
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
check(isR2S3Enabled({ S3_ENABLED: "true" }), "generic string true enables S3 mode");
check(isR2S3Enabled({ S3_ENABLED: true }), "generic boolean true enables S3 mode");
for (const value of [undefined, false, "false", "1", 1, ""]) {
  check(!isR2S3Enabled({ S3_ENABLED: value }), `generic value ${String(value)} keeps native mode`);
}
check(isR2S3Enabled({ S3_ENABLED: "false", R2_S3_ENABLED: "true" }), "legacy R2 enablement remains backward-compatible");
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

for (const missingName of [
  "S3_ENDPOINT",
  "S3_RAW_BUCKET",
  "S3_DATA_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
]) {
  const env = { ...B2_ENV };
  delete env[missingName];
  let error;
  try {
    resolveR2S3Stores(env);
  } catch (caught) {
    error = caught;
  }
  check(error?.code === "R2_S3_CONFIG_MISSING", `missing ${missingName} fails closed`);
  check(!String(error?.message).includes(redactionFixture), `missing ${missingName} error does not expose credentials`);
}

{
  let error;
  try {
    resolveR2S3Stores({
      ...B2_ENV,
      S3_ACCESS_KEY_ID: "",
      R2_S3_ACCESS_KEY_ID: "legacy-must-not-be-used",
      R2_S3_SECRET_ACCESS_KEY: "legacy-must-not-be-used",
      R2_S3_RAW_BUCKET: "legacy-raw-bucket",
      R2_S3_DATA_BUCKET: "legacy-data-bucket",
    });
  } catch (caught) {
    error = caught;
  }
  check(error?.code === "R2_S3_CONFIG_MISSING", "generic S3 mode never falls back to legacy R2 credentials");
}

{
  const optionsSeen = [];
  const factory = fakeClientFactory(() => new Response(null, { status: 200 }), [], optionsSeen);
  resolveR2S3Stores(B2_ENV, { clientFactory: factory });
  check(optionsSeen[0].region === "us-west-004", "Backblaze signing region is inferred from the endpoint");
  check(optionsSeen[0].service === "s3", "Backblaze signing service remains S3");

  const explicit = [];
  resolveR2S3Stores({ ...B2_ENV, S3_REGION: "us-west-004" }, {
    clientFactory: fakeClientFactory(() => new Response(null, { status: 200 }), [], explicit),
  });
  check(explicit[0].region === "us-west-004", "matching explicit Backblaze region is accepted");

  const omitted = [];
  resolveR2S3Stores({ ...B2_ENV, S3_REGION: "" }, {
    clientFactory: fakeClientFactory(() => new Response(null, { status: 200 }), [], omitted),
  });
  check(omitted[0].region === "us-west-004", "empty optional region uses the endpoint-derived region");
}

for (const region of ["us-east-005", "US-WEST-004", "auto", "us_west_004"]) {
  let error;
  try {
    resolveR2S3Stores({ ...B2_ENV, S3_REGION: region });
  } catch (caught) {
    error = caught;
  }
  check(error?.code === "R2_S3_CONFIG_MISSING", `invalid or mismatched region ${region} fails closed`);
}

for (const endpoint of [
  "http://s3.us-west-004.backblazeb2.com",
  "https://s3.US-WEST-004.backblazeb2.com",
  ["https://user", "s3.us-west-004.backblazeb2.com"].join("@"),
  "https://s3.us-west-004.backblazeb2.com:443",
  "https://s3.us-west-004.backblazeb2.com:8443",
  "https://s3.us-west-004.backblazeb2.com?query=1",
  "https://s3.us-west-004.backblazeb2.com#fragment",
  "https://s3.us-west-004.backblazeb2.com/path",
  "https://s3.us-west-004.example.com",
  "s3.us-west-004.backblazeb2.com",
]) {
  let error;
  try {
    resolveR2S3Stores({ ...B2_ENV, S3_ENDPOINT: endpoint });
  } catch (caught) {
    error = caught;
  }
  check(error?.code === "R2_S3_CONFIG_MISSING", `invalid Backblaze endpoint ${endpoint} fails closed`);
}

{
  const calls = [];
  const factory = fakeClientFactory(() => new Response(null, { status: 200 }), calls);
  const { rawStore } = resolveR2S3Stores({
    ...B2_ENV,
    S3_ENDPOINT: `${B2_ENV.S3_ENDPOINT}/`,
    S3_RAW_BUCKET: "valid.bucket-name",
    S3_DATA_BUCKET: "valid.data-bucket",
  }, { clientFactory: factory });
  await rawStore.head("key");
  check(calls[0].url === `${B2_ENV.S3_ENDPOINT}/valid.bucket-name/key`, "Backblaze endpoint trailing slash is normalized and dotted buckets use path style");
}

for (const bucket of [
  "short",
  "Uppercase-bucket",
  "bucket_with_underscore",
  "bucket..dots",
  "192.168.1.1",
  "b2-reserved",
  "xn--reserved",
  "sthree-reserved",
  "amzn-s3-demo-reserved",
  "reserved-s3alias",
  "reserved--ol-s3",
  "reserved.mrap",
  "reserved--x-s3",
  "reserved--table-s3",
  `${"a".repeat(64)}`,
]) {
  let error;
  try {
    resolveR2S3Stores({ ...B2_ENV, S3_RAW_BUCKET: bucket });
  } catch (caught) {
    error = caught;
  }
  check(error?.code === "R2_S3_CONFIG_MISSING", `invalid Backblaze bucket ${bucket} fails closed`);
}

{
  const calls = [];
  const optionsSeen = [];
  const factory = fakeClientFactory(() => new Response(null, {
    status: 200,
    headers: { etag: '\"b2-created\"' },
  }), calls, optionsSeen);
  const { rawStore } = resolveR2S3Stores(B2_ENV, { clientFactory: factory });
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("payload"));
      controller.close();
    },
  });
  const digest = "d".repeat(64);
  const result = await rawStore.put("rri-raw/account/property/Café report.csv", stream, {
    customMetadata: { original_file_name: "Café ✓.csv", account_id: "account" },
    httpMetadata: { contentType: "text/csv" },
    sha256: digest,
    onlyIf: { etagDoesNotMatch: "*" },
  });
  const request = calls[0];
  const url = new URL(request.url);
  check(url.origin === B2_ENV.S3_ENDPOINT, "Backblaze endpoint is used exactly");
  check(url.pathname === "/rri-raw-canary-b2/rri-raw/account/property/Caf%C3%A9%20report.csv", "Backblaze URL uses path style and per-segment encoding");
  check(request.init.method === "PUT" && request.init.body === stream, "Backblaze PUT preserves the streaming body");
  check(request.init.headers.get("if-none-match") === "*", "Backblaze conditional write sends If-None-Match star");
  check(request.init.headers.get("x-amz-content-sha256") === digest, "Backblaze PUT carries the expected checksum");
  check(request.init.headers.get("x-amz-meta-original_file_name").startsWith("=?UTF-8?B?"), "Backblaze Unicode metadata uses RFC 2047");
  check(request.init.headers.get("content-type") === "text/csv", "Backblaze HTTP metadata is forwarded");
  check(result.etag === "b2-created", "Backblaze PUT normalizes the ETag");
  check(optionsSeen[0].region === "us-west-004" && optionsSeen[0].service === "s3", "Backblaze client receives the exact signing scope");
  check(!("fetch" in optionsSeen[0]), "Backblaze AwsClient receives only documented constructor options");
}

{
  const unicode = "Café ✓.csv";
  const encoded = Buffer.from(unicode, "utf8").toString("base64");
  const calls = [];
  const factory = fakeClientFactory(() => new Response(null, {
    status: 200,
    headers: {
      "content-length": "7",
      "content-type": "text/csv",
      etag: '\"b2-head\"',
      "x-amz-meta-original_file_name": `=?UTF-8?B?${encoded}?=`,
      "x-amz-meta-sha256": "e".repeat(64),
    },
  }), calls);
  const head = await resolveR2S3Stores(B2_ENV, { clientFactory: factory }).rawStore.head("Café report.csv");
  check(calls[0].init.method === "HEAD", "Backblaze HEAD uses the S3 object operation");
  check(head.key === "Café report.csv" && head.size === 7 && head.etag === "b2-head", "Backblaze HEAD preserves object identity fields");
  check(head.customMetadata.original_file_name === unicode, "Backblaze HEAD decodes Unicode metadata");
  check(head.customMetadata.sha256 === "e".repeat(64), "Backblaze HEAD preserves checksum metadata");
}

{
  const calls = [];
  const factory = fakeClientFactory(() => new Response("payload", {
    status: 200,
    headers: { "content-type": "text/plain", "content-length": "7" },
  }), calls);
  const object = await resolveR2S3Stores(B2_ENV, { clientFactory: factory }).rawStore.get("key");
  check(calls[0].init.method === "GET", "Backblaze GET uses the S3 object operation");
  check(await object.text() === "payload", "Backblaze GET exposes the response body");
}

for (const operation of ["head", "get"]) {
  const calls = [];
  const factory = fakeClientFactory(() => new Response(null, { status: 404 }), calls);
  const result = await resolveR2S3Stores(B2_ENV, { clientFactory: factory }).rawStore[operation]("guaranteed-nonexistent-key");
  check(result === null, `Backblaze nonexistent ${operation.toUpperCase()} returns null`);
  check(calls[0].init.method === operation.toUpperCase(), `Backblaze nonexistent ${operation.toUpperCase()} sends the expected method`);
}

{
  const calls = [];
  const factory = fakeClientFactory(() => new Response(null, { status: 412 }), calls);
  const result = await resolveR2S3Stores(B2_ENV, { clientFactory: factory }).rawStore.put("existing-key", "payload", {
    sha256: "f".repeat(64),
    onlyIf: { etagDoesNotMatch: "*" },
  });
  check(result === null, "Backblaze conditional conflict preserves write-once null semantics");
  check(calls[0].init.headers.get("if-none-match") === "*", "Backblaze conditional conflict request remains write-once");
}

{
  const factory = fakeClientFactory(() => new Response(null, { status: 200 }));
  let error;
  try {
    await resolveR2S3Stores(B2_ENV, { clientFactory: factory }).rawStore.put("key", "payload", {
      sha256: "not-a-sha256",
    });
  } catch (caught) {
    error = caught;
  }
  check(error?.code === "R2_S3_CONFIG_MISSING", "Backblaze PUT rejects an invalid expected checksum before dispatch");
}

{
  const calls = [];
  const factory = fakeClientFactory(() => new Response(null, { status: 204 }), calls);
  await resolveR2S3Stores(B2_ENV, { clientFactory: factory }).bulkStore.delete("key");
  check(calls[0].init.method === "DELETE", "Backblaze DELETE uses the S3 object operation");
  check(calls[0].url === `${B2_ENV.S3_ENDPOINT}/${B2_ENV.S3_DATA_BUCKET}/key`, "Backblaze DELETE targets the configured data bucket");
}

{
  const factory = () => ({ fetch: async () => { throw new Error(`Authorization ${redactionFixture}`); } });
  let error;
  try {
    await resolveR2S3Stores(B2_ENV, { clientFactory: factory }).rawStore.head("key");
  } catch (caught) {
    error = caught;
  }
  check(error?.status === 503 && error?.code === "R2_S3_HEAD_FAILED", "Backblaze network failures use a stable safe error");
  check(!String(error?.message).includes(redactionFixture) && !String(error?.message).includes("Authorization"), "Backblaze network failure details are redacted");
}

{
  const digest = "a".repeat(64);
  const client = new AwsClient({
    accessKeyId: "synthetic-b2-key-id",
    secretAccessKey: "synthetic-b2-secret-key",
    service: "s3",
    region: "us-west-004",
  });
  const signed = await client.sign(`${B2_ENV.S3_ENDPOINT}/${B2_ENV.S3_RAW_BUCKET}/folder/Caf%C3%A9%20report.csv`, {
    method: "PUT",
    headers: {
      "if-none-match": "*",
      "x-amz-content-sha256": digest,
      "x-amz-meta-original_file_name": "=?UTF-8?B?Q2Fmw6kg4pyTLmNzdg==?=",
    },
    body: new Uint8Array([1, 2, 3]),
  });
  const authorization = signed.headers.get("authorization") || "";
  check(authorization.startsWith("AWS4-HMAC-SHA256 Credential=synthetic-b2-key-id/"), "Backblaze request uses SigV4 authorization");
  check(authorization.includes("/us-west-004/s3/aws4_request"), "Backblaze SigV4 scope contains the configured region and S3 service");
  check(authorization.includes("SignedHeaders=host;if-none-match;x-amz-content-sha256;x-amz-date;x-amz-meta-original_file_name"), "Backblaze SigV4 authorization has the exact relevant signed-header names");
  check(signed.headers.get("x-amz-content-sha256") === digest, "Backblaze signer preserves the supplied payload digest");
  check(!authorization.includes("synthetic-b2-secret-key"), "Backblaze authorization never contains the secret key");
}

console.log(`PASSED: R2 and Backblaze B2 S3 adapter probe (${assertions} assertions)`);
process.exitCode = assertions > 0 ? 0 : 1;
