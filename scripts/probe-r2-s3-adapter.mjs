import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import { AwsClient } from "aws4fetch";
import {
  isR2S3Enabled,
  resolveR2S3Stores,
  GcsJsonClient,
  createGoogleServiceAccountJwt,
} from "../worker/r2-s3-adapter.js";

// Synthetic redaction fixture assembled at runtime; it is not an account credential.
const redactionFixture = ["redaction", "fixture", "value"].join(":");
const oauthAccessTokenFixture = ["probe", "oauth", "bearer", "fixture"].join("-");
const { privateKey: syntheticRsaPrivateKeyPem } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
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

const GCS_ENV = {
  S3_ENABLED: "true",
  S3_PROVIDER: "gcs",
  S3_ENDPOINT: "https://storage.googleapis.com",
  S3_REGION: "us-east1",
  S3_RAW_BUCKET: "rri-raw-canary-gcs",
  S3_DATA_BUCKET: "rri-data-canary-gcs",
  GCS_SERVICE_ACCOUNT_JSON: JSON.stringify({
    client_email: "synthetic-gcs@synthetic.test",
    private_key: syntheticRsaPrivateKeyPem,
  }),
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

function nodeDigestFactory() {
  const hash = createHash("sha256");
  return {
    update(chunk) {
      hash.update(chunk);
    },
    finish() {
      return hash.digest("hex");
    },
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
  check(!request.init.aws?.signQuery, "R2 does not use query signing");
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
  check(!request.init.aws?.signQuery, "Backblaze does not use query signing");
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

for (const missingName of [
  "S3_ENDPOINT",
  "S3_REGION",
  "S3_RAW_BUCKET",
  "S3_DATA_BUCKET",
  "GCS_SERVICE_ACCOUNT_JSON",
]) {
  const env = { ...GCS_ENV };
  delete env[missingName];
  let error;
  try {
    resolveR2S3Stores(env);
  } catch (caught) {
    error = caught;
  }
  check(error?.code === "R2_S3_CONFIG_MISSING", `GCS missing ${missingName} fails closed`);
  check(!String(error?.message).includes(redactionFixture), `GCS missing ${missingName} error redacts credentials`);
}

for (const endpoint of [
  "http://storage.googleapis.com",
  "https://storage.googleapis.com:443",
  "https://storage.googleapis.com/path",
  ["https://user", "storage.googleapis.com"].join("@"),
  "https://storage.googleapis.com?query=1",
  "https://storage.googleapis.example.com",
]) {
  let error;
  try {
    resolveR2S3Stores({ ...GCS_ENV, S3_ENDPOINT: endpoint });
  } catch (caught) {
    error = caught;
  }
  check(error?.code === "R2_S3_CONFIG_MISSING", `invalid GCS endpoint ${endpoint} fails closed`);
}

{
  const signedCalls = [];
  const sessionCalls = [];
  const optionsSeen = [];
  const sessionUri = "https://storage.googleapis.com/upload/session?upload_id=synthetic-sensitive-session";
  const payload = new Uint8Array((256 * 1024 * 2) + 3);
  payload.fill(97);
  const expectedSha256 = createHash("sha256").update(payload).digest("hex");
  let persistedEnd = -1;
  const fetchImpl = async (url, init = {}) => {
    sessionCalls.push({ url: String(url), init });
    const headers = new Headers(init.headers);
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    const range = headers.get("content-range");
    if (range?.endsWith("/*")) {
      const match = range.match(/^bytes (\d+)-(\d+)\/\*$/);
      persistedEnd = Number(match?.[2]);
      return new Response(null, { status: 308, headers: { range: `bytes=0-${persistedEnd}` } });
    }
    return new Response(null, { status: 201, headers: { etag: '"gcs-created"' } });
  };
  const factory = fakeClientFactory((_url, init) => {
    signedCalls.push(init);
    return new Response(null, { status: 201, headers: { location: sessionUri } });
  }, [], optionsSeen);
  const { rawStore } = resolveR2S3Stores(GCS_ENV, {
    clientFactory: factory,
    fetch: fetchImpl,
    digestFactory: nodeDigestFactory,
  });
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(payload);
      controller.close();
    },
  });
  const result = await rawStore.put("rri-raw/account/property/Café report.csv", stream, {
    customMetadata: { original_file_name: "Café ✓.csv", account_id: "account" },
    httpMetadata: { contentType: "text/csv" },
    sha256: expectedSha256,
    onlyIf: { etagDoesNotMatch: "*" },
  });
  const initiation = signedCalls[0];
  const initiationHeaders = new Headers(initiation.headers);
  check(initiation.method === "POST", "GCS resumable upload uses a signed POST initiation");
  check(!initiation.aws?.signQuery, "GCS resumable upload initiation does not use AWS query signing");
  check(!initiationHeaders.has("x-amz-content-sha256"), "GCS initiation carries no x-amz-content-sha256 header");
  check(initiationHeaders.get("x-goog-resumable") === "start", "GCS initiation requests a resumable session");
  check(initiationHeaders.get("x-goog-if-generation-match") === "0", "GCS initiation atomically requires object absence");
  check(initiationHeaders.get("x-goog-meta-original_file_name")?.startsWith("=?UTF-8?B?"), "GCS Unicode metadata uses RFC 2047");
  check(initiationHeaders.get("content-type") === "text/csv", "GCS initiation preserves HTTP metadata");
  check(optionsSeen[0].region === "us-east1" && typeof optionsSeen[0].serviceAccountJson === "string", "GCS client receives OAuth configuration");
  check(sessionCalls.length === 3, "GCS bounded upload uses two complete chunks and one final chunk");
  check(new Headers(sessionCalls[0].init.headers).get("content-range") === "bytes 0-262143/*", "GCS first intermediate range is exact");
  check(new Headers(sessionCalls[1].init.headers).get("content-range") === "bytes 262144-524287/*", "GCS second intermediate range is exact");
  check(new Headers(sessionCalls[2].init.headers).get("content-range") === "bytes 524288-524290/524291", "GCS final range declares the complete size");
  check(new Headers(sessionCalls[2].init.headers).get("x-goog-hash")?.startsWith("crc32c="), "GCS final commit requests server-side CRC32C validation");
  check(sessionCalls.every((call) => !new Headers(call.init.headers).has("authorization")), "GCS session requests remain unsigned");
  check(sessionCalls.every((call) => call.url === sessionUri), "GCS session requests use only the returned session URI");
  check(result.etag === "gcs-created", "GCS PUT normalizes the final ETag");
}

{
  const sessionCalls = [];
  const sessionUri = "https://storage.googleapis.com/upload/session?upload_id=crc-vector";
  const payload = new TextEncoder().encode("123456789");
  const expectedSha256 = createHash("sha256").update(payload).digest("hex");
  const factory = fakeClientFactory(() => new Response(null, {
    status: 201,
    headers: { location: sessionUri },
  }));
  const fetchImpl = async (url, init = {}) => {
    sessionCalls.push({ url: String(url), init });
    return new Response(null, { status: 201 });
  };
  const store = resolveR2S3Stores(GCS_ENV, {
    clientFactory: factory,
    fetch: fetchImpl,
    digestFactory: nodeDigestFactory,
  }).rawStore;
  await store.put("crc-vector", payload, {
    sha256: expectedSha256,
    onlyIf: { etagDoesNotMatch: "*" },
  });
  check(new Headers(sessionCalls[0].init.headers).get("x-goog-hash") === "crc32c=4waSgw==", "GCS CRC32C matches the standard test vector");
}

{
  const signedCalls = [];
  const unicode = "Café ✓.csv";
  const encoded = Buffer.from(unicode, "utf8").toString("base64");
  const factory = fakeClientFactory((_url, init) => {
    signedCalls.push(init);
    if (init.method === "HEAD") {
      return new Response(null, {
        status: 200,
        headers: {
          etag: '"gcs-head"',
          "content-length": "7",
          "content-type": "text/csv",
          "x-goog-meta-original_file_name": `=?UTF-8?B?${encoded}?=`,
        },
      });
    }
    if (init.method === "GET") return new Response("payload", { status: 200, headers: { "content-length": "7" } });
    return new Response(null, { status: 204 });
  });
  const store = resolveR2S3Stores(GCS_ENV, { clientFactory: factory }).rawStore;
  const head = await store.head("Café report.csv");
  check(head.etag === "gcs-head" && head.customMetadata.original_file_name === unicode, "GCS HEAD parses identity and Unicode metadata");
  const object = await store.get("Café report.csv");
  check(await object.text() === "payload", "GCS GET streams the object body");
  await store.delete("Café report.csv");
  check(signedCalls.map((call) => call.method).join(",") === "HEAD,GET,DELETE", "GCS HEAD, GET, and DELETE use object requests");
  check(signedCalls.every((call) => !call.aws?.signQuery), "GCS HEAD, GET, and DELETE do not use AWS query signing");
}

for (const operation of ["head", "get"]) {
  const calls = [];
  const factory = fakeClientFactory(() => new Response(null, { status: 404 }), calls);
  const store = resolveR2S3Stores(GCS_ENV, { clientFactory: factory }).rawStore;
  check(await store[operation]("guaranteed-nonexistent-key") === null, `GCS nonexistent ${operation.toUpperCase()} returns null`);
  check(calls[0].init.method === operation.toUpperCase(), `GCS nonexistent ${operation.toUpperCase()} sends the expected method`);
}

{
  const sessionCalls = [];
  const sessionUri = "https://storage.googleapis.com/upload/session?upload_id=conflict-secret";
  const factory = fakeClientFactory(() => new Response(null, { status: 201, headers: { location: sessionUri } }));
  const fetchImpl = async (url, init = {}) => {
    sessionCalls.push({ url: String(url), init });
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    return new Response(null, { status: 412 });
  };
  const payload = new TextEncoder().encode("conflict");
  const result = await resolveR2S3Stores(GCS_ENV, {
    clientFactory: factory,
    fetch: fetchImpl,
    digestFactory: nodeDigestFactory,
  }).rawStore.put("existing-key", payload, {
    sha256: createHash("sha256").update(payload).digest("hex"),
    onlyIf: { etagDoesNotMatch: "*" },
  });
  check(result === null, "GCS final 412 preserves write-once null semantics");
  check(new Headers(sessionCalls[0].init.headers).get("x-goog-hash")?.startsWith("crc32c="), "GCS conflict occurs on the checksum-protected final commit");
}

{
  let sessionFetches = 0;
  const factory = fakeClientFactory(() => new Response(null, { status: 412 }));
  const result = await resolveR2S3Stores(GCS_ENV, {
    clientFactory: factory,
    fetch: async () => {
      sessionFetches += 1;
      return new Response(null, { status: 500 });
    },
    digestFactory: nodeDigestFactory,
  }).rawStore.put("already-present", new Uint8Array([1]), {
    sha256: createHash("sha256").update(new Uint8Array([1])).digest("hex"),
    onlyIf: { etagDoesNotMatch: "*" },
  });
  check(result === null, "GCS initiation 412 preserves write-once null semantics");
  check(sessionFetches === 0, "GCS initiation conflict never uploads object bytes");
}

{
  const sessionCalls = [];
  const sessionUri = "https://storage.googleapis.com/upload/session?upload_id=sha-mismatch-secret";
  const factory = fakeClientFactory(() => new Response(null, { status: 201, headers: { location: sessionUri } }));
  const fetchImpl = async (url, init = {}) => {
    sessionCalls.push({ url: String(url), init });
    return new Response(null, { status: init.method === "DELETE" ? 204 : 201 });
  };
  let error;
  try {
    await resolveR2S3Stores(GCS_ENV, {
      clientFactory: factory,
      fetch: fetchImpl,
      digestFactory: nodeDigestFactory,
    }).rawStore.put("mismatch", new TextEncoder().encode("payload"), {
      sha256: "0".repeat(64),
      onlyIf: { etagDoesNotMatch: "*" },
    });
  } catch (caught) {
    error = caught;
  }
  check(error?.code === "CHECKSUM_MISMATCH", "GCS SHA-256 mismatch fails before object commit");
  check(sessionCalls.length === 1 && sessionCalls[0].init.method === "DELETE", "GCS SHA-256 mismatch cancels the incomplete session");
  check(!String(error?.message).includes(sessionUri), "GCS checksum errors never expose session URIs");
}

{
  const sessionUri = "https://storage.googleapis.com/upload/session?upload_id=never-log-this";
  const factory = fakeClientFactory(() => new Response(null, { status: 201, headers: { location: sessionUri } }));
  const fetchImpl = async (_url, init = {}) => new Response(null, { status: init.method === "DELETE" ? 204 : 500 });
  let error;
  try {
    const payload = new TextEncoder().encode("payload");
    await resolveR2S3Stores(GCS_ENV, {
      clientFactory: factory,
      fetch: fetchImpl,
      digestFactory: nodeDigestFactory,
    }).rawStore.put("safe-error-key", payload, {
      sha256: createHash("sha256").update(payload).digest("hex"),
      onlyIf: { etagDoesNotMatch: "*" },
    });
  } catch (caught) {
    error = caught;
  }
  check(error?.code === "R2_S3_PUT_FAILED" && error?.status === 500, "GCS session failure uses a stable safe error");
  check(!String(error?.message).includes("upload_id") && !String(error?.message).includes(redactionFixture), "GCS session failure redacts session and credential material");
}

{
  const factory = () => ({ fetch: async () => { throw new Error(`Authorization ${redactionFixture}`); } });
  let error;
  try {
    await resolveR2S3Stores(GCS_ENV, {
      clientFactory: factory,
      fetch: async () => new Response(null, { status: 500 }),
      digestFactory: nodeDigestFactory,
    }).rawStore.put("key", new Uint8Array([1]), { onlyIf: { etagDoesNotMatch: "*" } });
  } catch (caught) {
    error = caught;
  }
  check(error?.code === "R2_S3_PUT_FAILED" && error?.status === 503, "GCS initiation network failure uses a stable safe error");
  check(!String(error?.message).includes(redactionFixture) && !String(error?.message).includes("Authorization"), "GCS initiation network failure redacts credentials");
}

{
  let sessionFetches = 0;
  const factory = fakeClientFactory(() => new Response(null, {
    status: 201,
    headers: { location: "https://example.invalid/upload?upload_id=ssrf" },
  }));
  let error;
  try {
    await resolveR2S3Stores(GCS_ENV, {
      clientFactory: factory,
      fetch: async () => {
        sessionFetches += 1;
        return new Response(null, { status: 500 });
      },
      digestFactory: nodeDigestFactory,
    }).rawStore.put("key", new Uint8Array([1]), { onlyIf: { etagDoesNotMatch: "*" } });
  } catch (caught) {
    error = caught;
  }
  check(error?.code === "R2_S3_CONFIG_MISSING", "GCS rejects an untrusted resumable session origin");
  check(sessionFetches === 0 && !String(error?.message).includes("upload_id"), "GCS session-origin rejection prevents SSRF and redacts the URI");
}

{
  const fixedDate = new Date("2026-09-22T13:30:33.000Z");
  const jwt = await createGoogleServiceAccountJwt(GCS_ENV.GCS_SERVICE_ACCOUNT_JSON, fixedDate);
  const parts = jwt.split(".");
  check(parts.length === 3, "Google service account JWT has 3 dot-separated parts");
  const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  check(header.alg === "RS256" && header.typ === "JWT", "JWT header specifies RS256 algorithm and JWT type");
  check(payload.iss === "synthetic-gcs@synthetic.test", "JWT payload contains service account email");
  check(payload.scope === "https://www.googleapis.com/auth/devstorage.read_write", "JWT payload contains devstorage.read_write scope");
  check(payload.aud === "https://oauth2.googleapis.com/token", "JWT payload audience is googleapis token endpoint");
  check(payload.iat === 1790083833, "JWT issued-at timestamp matches test date");
  check(payload.exp === 1790083833 + 3600, "JWT expiration is 1 hour after issuance");
  check(!jwt.includes("PRIVATE KEY"), "JWT never contains the private key");

  let error;
  try {
    await createGoogleServiceAccountJwt({
      client_email: "test@project.test",
      private_key: redactionFixture,
    });
  } catch (caught) {
    error = caught;
  }
  check(error?.code === "R2_S3_CONFIG_MISSING", "invalid GCS service account private key fails closed");
  check(!String(error?.message).includes(redactionFixture), "invalid GCS service account private key error redacts key");
}

{
  let tokenRequests = 0;
  let now = new Date("2026-09-22T13:30:33.000Z");
  const calls = [];
  const tokenFetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url) === "https://oauth2.googleapis.com/token") {
      tokenRequests += 1;
      const body = String(init?.body || "");
      check(init?.method === "POST", "OAuth token exchange uses POST");
      check(body.includes("grant_type="), "OAuth token exchange carries grant_type");
      check(body.includes("assertion="), "OAuth token exchange carries assertion JWT");
      return new Response(JSON.stringify({ access_token: oauthAccessTokenFixture, expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const parsed = new URL(url);
    if (parsed.pathname.includes("/upload/storage/v1/")) {
      return new Response(null, { status: 200, headers: { location: "https://storage.googleapis.com/upload/session?upload_id=e2e-session" } });
    }
    if (parsed.searchParams.get("alt") === "media") {
      return new Response("payload", { status: 200 });
    }
    if (init.method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    return new Response(JSON.stringify({
      name: "folder/Café report.csv",
      size: "7",
      etag: "test-etag",
      updated: "2026-09-22T13:30:33.000Z",
      contentType: "text/plain",
      metadata: {
        account_id: "account",
        server_property_id: "property",
        raw_hash: "a".repeat(64),
        report_type: "Revenue",
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const client = new GcsJsonClient({
    serviceAccountJson: GCS_ENV.GCS_SERVICE_ACCOUNT_JSON,
    tokenFetch,
    now: () => now,
  });

  const initiationResponse = await client.fetch("https://storage.googleapis.com/rri-data-canary-gcs/folder/Caf%C3%A9%20report.csv", {
    method: "POST",
    headers: {
      "x-goog-resumable": "start",
      "x-goog-if-generation-match": "0",
      "x-goog-meta-account_id": "account",
      "x-goog-meta-server_property_id": "property",
      "x-goog-meta-raw_hash": "a".repeat(64),
      "x-goog-meta-report_type": "Revenue",
      "content-type": "text/csv",
    },
    body: "",
  });
  check(initiationResponse?.ok, "GCS JSON client initiates resumable upload");
  check(initiationResponse?.headers.get("location")?.includes("e2e-session"), "Resumable initiation returns session URI");

  const initiation = calls.find((call) => call.init.method === "POST" && String(call.url).includes("upload/storage/v1"));
  check(initiation?.url.includes("ifGenerationMatch=0"), "GCS JSON initiation carries generation-match 0");
  check(new Headers(initiation?.init.headers).get("authorization") === `Bearer ${oauthAccessTokenFixture}`, "GCS JSON initiation uses OAuth bearer authorization");
  const initBody = JSON.parse(initiation?.init.body || "{}");
  check(initBody.name === "folder/Café report.csv", "GCS JSON initiation persists object name in request body");
  check(initBody.metadata.account_id === "account" && initBody.metadata.server_property_id === "property" && initBody.metadata.raw_hash === "a".repeat(64), "GCS JSON initiation persists object metadata in request body");

  const head = await client.fetch("https://storage.googleapis.com/rri-data-canary-gcs/folder/Caf%C3%A9%20report.csv", { method: "HEAD" });
  check(head.headers.get("x-goog-meta-account_id") === "account" && head.headers.get("x-goog-meta-server_property_id") === "property", "GCS JSON metadata GET exposes exact custom metadata");

  const media = await client.fetch("https://storage.googleapis.com/rri-data-canary-gcs/folder/Caf%C3%A9%20report.csv", { method: "GET" });
  check(await media.text() === "payload" && media.headers.get("etag") === "test-etag", "GCS JSON media GET preserves bytes and metadata");

  await client.fetch("https://storage.googleapis.com/rri-data-canary-gcs/folder/Caf%C3%A9%20report.csv", { method: "DELETE" });
  check(calls.some((call) => call.init.method === "DELETE" && String(call.url).includes("/storage/v1/b/")), "GCS JSON DELETE uses the object metadata endpoint");

  check(tokenRequests === 1, "GCS OAuth access token is cached across requests");

  now = new Date(now.getTime() + 3600 * 1000);
  await client.fetch("https://storage.googleapis.com/rri-data-canary-gcs/folder/Caf%C3%A9%20report.csv", { method: "HEAD" });
  check(tokenRequests === 2, "GCS OAuth access token refreshes when expired");
}

{
  let tokenRequests = 0;
  const tokenFetch = async (url) => {
    if (String(url) === "https://oauth2.googleapis.com/token") {
      tokenRequests += 1;
      return new Response(JSON.stringify({ access_token: oauthAccessTokenFixture, expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({
      name: "probe-key",
      size: "7",
      etag: "probe-etag",
      updated: "2026-09-22T13:30:33.000Z",
      contentType: "text/plain",
      metadata: { key: "value" },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const store = resolveR2S3Stores(GCS_ENV, {
    tokenFetch,
    fetch: async () => new Response(null, {
      status: 201,
      headers: { etag: '"created-etag"', location: "https://storage.googleapis.com/upload/session?upload_id=probe" },
    }),
    digestFactory: nodeDigestFactory,
  }).rawStore;

  const headObj = await store.head("probe-key");
  check(headObj?.etag === "probe-etag" && headObj?.customMetadata?.key === "value", "adapter HEAD parses GCS JSON object and metadata");
  check(tokenRequests === 1, "adapter uses the cached OAuth token");
}

{
  const originalFetch = globalThis.fetch;
  let receiverCalls = 0;
  let receivedThis = null;

  globalThis.fetch = function receiverSensitiveFetch(url, init = {}) {
    receiverCalls += 1;
    receivedThis = this;
    if (this !== globalThis) {
      throw new TypeError("Illegal invocation");
    }
    if (String(url) === "https://oauth2.googleapis.com/token") {
      return new Response(JSON.stringify({ access_token: oauthAccessTokenFixture, expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({
      name: "default-receiver-key",
      size: "12",
      etag: "receiver-safe-etag",
      updated: "2026-09-22T13:30:33.000Z",
      contentType: "text/plain",
      metadata: { receiver: "safe" },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const defaultClient = new GcsJsonClient({
      serviceAccountJson: GCS_ENV.GCS_SERVICE_ACCOUNT_JSON,
      now: () => new Date("2026-09-22T13:30:33.000Z"),
    });

    const token = await defaultClient.accessToken();
    check(token === oauthAccessTokenFixture, "default-fetch path acquires OAuth token without illegal invocation");
    check(receivedThis === globalThis, "default-fetch path preserves globalThis as receiver");

    const headResponse = await defaultClient.fetch("https://storage.googleapis.com/rri-data-canary-gcs/default-receiver-key", { method: "HEAD" });
    check(headResponse.ok, "default-fetch path HEAD succeeds with receiver-safe fetch");
    check(headResponse.headers.get("x-goog-meta-receiver") === "safe", "default-fetch path exposes metadata");

    const store = resolveR2S3Stores(GCS_ENV, {
      digestFactory: nodeDigestFactory,
    }).rawStore;
    const headObj = await store.head("default-receiver-key");
    check(headObj?.etag === "receiver-safe-etag" && headObj?.customMetadata?.receiver === "safe", "resolveR2S3Stores default-fetch path is receiver-safe");

    let injectedCalls = 0;
    const injectedTokenFetch = async (url) => {
      injectedCalls += 1;
      if (String(url) === "https://oauth2.googleapis.com/token") {
        return new Response(JSON.stringify({ access_token: "probe-chain-secret", expires_in: 3600 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };

    const injectedClient = new GcsJsonClient({
      serviceAccountJson: GCS_ENV.GCS_SERVICE_ACCOUNT_JSON,
      tokenFetch: injectedTokenFetch,
      now: () => new Date("2026-09-22T13:30:33.000Z"),
    });
    const priorReceiverCalls = receiverCalls;
    const injectedToken = await injectedClient.accessToken();
    check(injectedToken === "probe-chain-secret", "explicit injected tokenFetch behavior remains intact");
    check(injectedCalls === 1, "explicit injected tokenFetch is called directly");
    check(receiverCalls === priorReceiverCalls, "explicit injected tokenFetch does not call default fetch");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION: GCS JSON Resumable Upload Metadata Persistence & Outbound Request
// ─────────────────────────────────────────────────────────────────────────────
{
  const outboundCalls = [];
  const tokenFetch = async (url, init = {}) => {
    outboundCalls.push({ url: String(url), init });
    if (String(url).includes("oauth2.googleapis.com")) {
      return new Response(JSON.stringify({ access_token: "test-oauth-token", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const parsed = new URL(url);
    if (parsed.pathname.includes("/upload/storage/v1/")) {
      return new Response(null, {
        status: 200,
        headers: { location: "https://storage.googleapis.com/upload/session?upload_id=regression-session" },
      });
    }
    return new Response(null, { status: 200, headers: { etag: '"created-etag"' } });
  };

  const sessionCalls = [];
  const sessionFetch = async (url, init = {}) => {
    sessionCalls.push({ url: String(url), init });
    return new Response(null, {
      status: 201,
      headers: { etag: '"committed-etag"' },
    });
  };

  const stores = resolveR2S3Stores(GCS_ENV, {
    tokenFetch,
    fetch: sessionFetch,
    digestFactory: nodeDigestFactory,
  });

  const payload = new Uint8Array([1, 2, 3]);
  const rawHash = createHash("sha256").update(payload).digest("hex");
  const testKey = `rri-raw/acc_test/prop_test/${rawHash}`;
  const customMetadata = {
    account_id: "acc_test",
    server_property_id: "prop_test",
    raw_hash: rawHash,
    immutable: "true",
  };

  await stores.rawStore.put(testKey, payload, {
    customMetadata,
    httpMetadata: { contentType: "text/csv" },
    sha256: rawHash,
    onlyIf: { etagDoesNotMatch: "*" },
  });

  const initiation = outboundCalls.find((call) => call.init.method === "POST" && String(call.url).includes("/upload/storage/v1/"));
  check(initiation != null, "GCS resumable upload initiation request was made");
  check(initiation.init.method === "POST", "GCS resumable upload initiation method is POST");

  const initUrl = new URL(initiation.url);
  check(initUrl.origin === "https://storage.googleapis.com", "GCS initiation targets storage.googleapis.com");
  check(initUrl.pathname === `/upload/storage/v1/b/${GCS_ENV.S3_RAW_BUCKET}/o`, "GCS initiation targets JSON API resumable endpoint");
  check(initUrl.searchParams.get("uploadType") === "resumable", "GCS initiation carries uploadType=resumable");
  check(initUrl.searchParams.get("ifGenerationMatch") === "0", "GCS initiation carries ifGenerationMatch=0 query parameter");
  check(!initUrl.searchParams.has("name"), "GCS initiation does not place object name in query parameters (avoids metadata loss)");
  const allowedQueryParams = new Set(["uploadType", "ifGenerationMatch"]);
  const queryParamKeys = [...initUrl.searchParams.keys()];
  check(queryParamKeys.every((key) => allowedQueryParams.has(key)), "GCS initiation query parameters only contain allowed parameters");

  const initHeaders = new Headers(initiation.init.headers);
  check(initHeaders.get("content-type")?.toLowerCase().includes("application/json"), "GCS initiation content-type is application/json");
  check(initHeaders.get("content-type")?.toLowerCase().includes("charset=utf-8"), "GCS initiation content-type declares UTF-8 charset");
  check(initHeaders.get("x-upload-content-type") === "text/csv", "GCS initiation sends X-Upload-Content-Type header");

  let initBody;
  try {
    initBody = JSON.parse(initiation.init.body);
  } catch {
    initBody = null;
  }
  check(initBody != null && typeof initBody === "object", "GCS initiation body parses as JSON");
  check(initBody?.name === testKey, "GCS initiation body carries exact object name");
  check(initBody?.contentType === "text/csv", "GCS initiation body carries exact contentType");
  check(initBody?.metadata != null && typeof initBody.metadata === "object", "GCS initiation body carries metadata object");
  check(initBody?.metadata?.account_id === "acc_test", "GCS initiation metadata includes account_id");
  check(initBody?.metadata?.server_property_id === "prop_test", "GCS initiation metadata includes server_property_id");
  check(initBody?.metadata?.raw_hash === rawHash, "GCS initiation metadata includes raw_hash");
  check(initBody?.metadata?.immutable === "true", "GCS initiation metadata includes immutable");
  check(Object.keys(initBody?.metadata || {}).length === 4, "GCS initiation metadata contains exactly 4 keys without silent loss");

  const finalCommit = sessionCalls.find((call) => call.init.method === "PUT");
  check(finalCommit != null, "GCS resumable data session PUT was called");
  const finalHeaders = new Headers(finalCommit.init.headers);
  check(finalHeaders.get("x-goog-meta-account_id") === "acc_test", "GCS final commit PUT carries x-goog-meta-account_id");
  check(finalHeaders.get("x-goog-meta-server_property_id") === "prop_test", "GCS final commit PUT carries x-goog-meta-server_property_id");
  check(finalHeaders.get("x-goog-meta-raw_hash") === rawHash, "GCS final commit PUT carries x-goog-meta-raw_hash");
  check(finalHeaders.get("x-goog-meta-immutable") === "true", "GCS final commit PUT carries x-goog-meta-immutable");
}

// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION: Full GCS JSON API Lifecycle (Put, Head, Get, 412, Unicode, Bundle)
// ─────────────────────────────────────────────────────────────────────────────
{
  const mockStorage = new Map(); // key -> { bucket, name, metadata, contentType, contentEncoding, bytes, etag, updated, generation }
  const activeSessions = new Map(); // sessionId -> sessionData
  let sessionCounter = 0;

  const handleGcsFetch = async (urlStr, init = {}) => {
    const url = new URL(urlStr);
    const method = String(init.method || "GET").toUpperCase();

    // 1. OAuth token endpoint
    if (url.origin === "https://oauth2.googleapis.com" && url.pathname === "/token") {
      return new Response(JSON.stringify({ access_token: "mock-gcs-oauth-token", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    // 2. Resumable upload initiation endpoint
    if (url.origin === "https://storage.googleapis.com" && url.pathname.startsWith("/upload/storage/v1/b/")) {
      const parts = url.pathname.split("/").filter(Boolean);
      const bucket = decodeURIComponent(parts[4]);
      const isResumable = url.searchParams.get("uploadType") === "resumable";
      if (method === "POST" && isResumable) {
        // CRITICAL CHECK: Real GCS behavior!
        // If "name" is passed in query parameters, GCS ignores the body and metadata is empty {}.
        const queryName = url.searchParams.get("name");
        let objectName = queryName;
        let metadata = {};
        let contentType = undefined;
        let contentEncoding = undefined;

        if (queryName) {
          // GCS simple resumable initiation: body ignored, metadata lost!
          metadata = {};
        } else {
          // GCS metadata-bearing resumable initiation: body parsed!
          const parsedBody = JSON.parse(init.body || "{}");
          objectName = parsedBody.name;
          metadata = parsedBody.metadata || {};
          contentType = parsedBody.contentType;
          contentEncoding = parsedBody.contentEncoding;
        }

        const ifGenMatch = url.searchParams.get("ifGenerationMatch");
        const storageKey = `${bucket}/${objectName}`;
        const existing = mockStorage.get(storageKey);

        if (ifGenMatch === "0" && existing) {
          return new Response(JSON.stringify({ error: { code: 412, message: "Precondition Failed" } }), {
            status: 412,
            headers: { "content-type": "application/json" },
          });
        }

        sessionCounter += 1;
        const sessionId = `mock-session-${sessionCounter}`;
        activeSessions.set(sessionId, {
          bucket,
          objectName,
          metadata,
          contentType,
          contentEncoding,
          ifGenMatch,
        });

        return new Response(null, {
          status: 200,
          headers: {
            location: `https://storage.googleapis.com/upload/session?upload_id=${sessionId}`,
          },
        });
      }
    }

    // 3. Resumable session data upload (PUT chunk / commit)
    if (url.origin === "https://storage.googleapis.com" && url.pathname === "/upload/session") {
      const sessionId = url.searchParams.get("upload_id");
      const session = activeSessions.get(sessionId);
      if (!session) {
        return new Response(null, { status: 404 });
      }

      if (method === "PUT") {
        const storageKey = `${session.bucket}/${session.objectName}`;
        const existing = mockStorage.get(storageKey);
        if (session.ifGenMatch === "0" && existing) {
          return new Response(JSON.stringify({ error: { code: 412, message: "Precondition Failed" } }), {
            status: 412,
            headers: { "content-type": "application/json" },
          });
        }

        const chunkBytes = init.body instanceof Uint8Array
          ? init.body
          : new Uint8Array(init.body ? await new Response(init.body).arrayBuffer() : []);

        const etag = `"${createHash("md5").update(chunkBytes).digest("hex")}"`;
        const updated = new Date().toISOString();

        // GCS also allows X-Goog-Meta-* headers on PUT chunk
        const headers = new Headers(init.headers || {});
        for (const [name, value] of headers.entries()) {
          const lowerName = name.toLowerCase();
          if (lowerName.startsWith("x-goog-meta-")) {
            const metaKey = lowerName.slice("x-goog-meta-".length);
            session.metadata[metaKey] = value;
          }
        }

        mockStorage.set(storageKey, {
          bucket: session.bucket,
          name: session.objectName,
          metadata: { ...session.metadata },
          contentType: session.contentType || "application/octet-stream",
          contentEncoding: session.contentEncoding,
          bytes: chunkBytes,
          etag,
          updated,
          generation: (existing?.generation || 0) + 1,
        });

        activeSessions.delete(sessionId);
        return new Response(JSON.stringify({
          kind: "storage#object",
          name: session.objectName,
          bucket: session.bucket,
          size: String(chunkBytes.byteLength),
          etag,
          updated,
          contentType: session.contentType,
          contentEncoding: session.contentEncoding,
          metadata: session.metadata,
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            etag,
          },
        });
      }
    }

    // 4. Object metadata / media endpoint: /storage/v1/b/[BUCKET]/o/[KEY]
    if (url.origin === "https://storage.googleapis.com" && url.pathname.startsWith("/storage/v1/b/")) {
      const parts = url.pathname.split("/").filter(Boolean);
      const bucket = decodeURIComponent(parts[3]);
      const key = decodeURIComponent(parts.slice(5).join("/"));
      const storageKey = `${bucket}/${key}`;
      const object = mockStorage.get(storageKey);

      if (!object) {
        return new Response(JSON.stringify({ error: { code: 404, message: "Not Found" } }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }

      if (method === "GET") {
        if (url.searchParams.get("alt") === "media") {
          return new Response(object.bytes, {
            status: 200,
            headers: {
              "content-type": object.contentType || "application/octet-stream",
              etag: object.etag,
              "last-modified": new Date(object.updated).toUTCString(),
            },
          });
        }
        return new Response(JSON.stringify({
          kind: "storage#object",
          name: object.name,
          bucket: object.bucket,
          size: String(object.bytes.byteLength),
          etag: object.etag,
          updated: object.updated,
          contentType: object.contentType,
          contentEncoding: object.contentEncoding,
          metadata: object.metadata,
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (method === "DELETE") {
        mockStorage.delete(storageKey);
        return new Response(null, { status: 204 });
      }
    }

    return new Response(null, { status: 400 });
  };

  const gcsStores = resolveR2S3Stores(GCS_ENV, {
    tokenFetch: handleGcsFetch,
    fetch: handleGcsFetch,
    digestFactory: nodeDigestFactory,
  });

  // A. Raw CSV File Upload & Metadata Verification
  {
    const rawPayload = new TextEncoder().encode("header1,header2\nval1,val2\n");
    const rawHash = createHash("sha256").update(rawPayload).digest("hex");
    const rawKey = `rri-raw/acc_corp/prop_hotel_1/${rawHash}`;
    const rawMetadata = {
      account_id: "acc_corp",
      server_property_id: "prop_hotel_1",
      report_type: "daily_revenue",
      raw_hash: rawHash,
      raw_archive_id: "raw_arch_12345",
      original_file_name: "daily_rev.csv",
      uploaded_by: "user_789",
      immutable: "true",
    };

    const putResult = await gcsStores.rawStore.put(rawKey, rawPayload, {
      customMetadata: rawMetadata,
      httpMetadata: { contentType: "text/csv" },
      sha256: rawHash,
      onlyIf: { etagDoesNotMatch: "*" },
    });

    check(putResult != null, "GCS raw upload succeeds on initial put");
    check(putResult?.key === rawKey, "GCS raw upload returns exact key");
    check(typeof putResult?.etag === "string" && putResult.etag.length > 0, "GCS raw upload returns valid etag");

    const headResult = await gcsStores.rawStore.head(rawKey);
    check(headResult != null, "GCS raw object head succeeds");
    check(headResult?.size === rawPayload.byteLength, "GCS head size matches exact payload byte length");
    check(headResult?.httpMetadata?.contentType === "text/csv", "GCS head preserves contentType");
    check(headResult?.customMetadata != null, "GCS head returns customMetadata");
    check(headResult?.customMetadata?.account_id === "acc_corp", "GCS head customMetadata includes account_id");
    check(headResult?.customMetadata?.server_property_id === "prop_hotel_1", "GCS head customMetadata includes server_property_id");
    check(headResult?.customMetadata?.report_type === "daily_revenue", "GCS head customMetadata includes report_type");
    check(headResult?.customMetadata?.raw_hash === rawHash, "GCS head customMetadata includes raw_hash");
    check(headResult?.customMetadata?.raw_archive_id === "raw_arch_12345", "GCS head customMetadata includes raw_archive_id");
    check(headResult?.customMetadata?.original_file_name === "daily_rev.csv", "GCS head customMetadata includes original_file_name");
    check(headResult?.customMetadata?.uploaded_by === "user_789", "GCS head customMetadata includes uploaded_by");
    check(headResult?.customMetadata?.immutable === "true", "GCS head customMetadata includes immutable");

    const getResult = await gcsStores.rawStore.get(rawKey);
    check(getResult != null, "GCS raw object get succeeds");
    const retrievedText = await getResult.text();
    check(retrievedText === "header1,header2\nval1,val2\n", "GCS get returns exact original raw payload");
    check(getResult.customMetadata?.raw_hash === rawHash, "GCS get includes customMetadata");

    // Idempotent write-once: duplicate put with etagDoesNotMatch: "*" returns null (HTTP 412)
    const duplicatePut = await gcsStores.rawStore.put(rawKey, rawPayload, {
      customMetadata: rawMetadata,
      httpMetadata: { contentType: "text/csv" },
      sha256: rawHash,
      onlyIf: { etagDoesNotMatch: "*" },
    });
    check(duplicatePut === null, "GCS raw upload write-once returns null on duplicate put (HTTP 412)");
  }

  // B. Normalized Gzip Bundle Upload & Metadata Verification
  {
    const bundlePayload = new Uint8Array([31, 139, 8, 0, 1, 2, 3, 4, 5, 6]); // synthetic gzip
    const normHash = createHash("sha256").update(bundlePayload).digest("hex");
    const bundleKey = `rri-bulk/acc_corp/prop_hotel_1/v1/${normHash}.ndjson.gz`;
    const bundleMetadata = {
      account_id: "acc_corp",
      server_property_id: "prop_hotel_1",
      report_type: "daily_revenue",
      normalized_hash: normHash,
      raw_hash: "a".repeat(64),
      min_date: "2026-09-01",
      max_date: "2026-09-23",
      row_count: "150",
      identity_version: "2",
      entity_counts_json: JSON.stringify({ daily_revenue: 150 }),
      immutable: "true",
    };

    const putBundleResult = await gcsStores.bulkStore.put(bundleKey, bundlePayload, {
      customMetadata: bundleMetadata,
      httpMetadata: {
        contentType: "application/x-ndjson",
        contentEncoding: "gzip",
      },
      sha256: normHash,
      onlyIf: { etagDoesNotMatch: "*" },
    });

    check(putBundleResult != null, "GCS normalized bundle put succeeds");
    check(putBundleResult?.key === bundleKey, "GCS normalized bundle returns exact key");

    const headBundle = await gcsStores.bulkStore.head(bundleKey);
    check(headBundle != null, "GCS normalized bundle head succeeds");
    check(headBundle?.size === bundlePayload.byteLength, "GCS bundle head size matches payload length");
    check(headBundle?.httpMetadata?.contentType === "application/x-ndjson", "GCS bundle head preserves application/x-ndjson contentType");
    check(headBundle?.httpMetadata?.contentEncoding === "gzip", "GCS bundle head preserves gzip contentEncoding");
    check(headBundle?.customMetadata?.normalized_hash === normHash, "GCS bundle head preserves normalized_hash");
    check(headBundle?.customMetadata?.row_count === "150", "GCS bundle head preserves row_count");
    check(headBundle?.customMetadata?.identity_version === "2", "GCS bundle head preserves identity_version");
    check(headBundle?.customMetadata?.entity_counts_json === '{"daily_revenue":150}', "GCS bundle head preserves entity_counts_json");

    const duplicateBundlePut = await gcsStores.bulkStore.put(bundleKey, bundlePayload, {
      customMetadata: bundleMetadata,
      httpMetadata: {
        contentType: "application/x-ndjson",
        contentEncoding: "gzip",
      },
      sha256: normHash,
      onlyIf: { etagDoesNotMatch: "*" },
    });
    check(duplicateBundlePut === null, "GCS bundle upload write-once returns null on duplicate put");
  }

  // C. Unicode Metadata Round-Trip Encoding & Decoding
  {
    const unicodePayload = new TextEncoder().encode("unicode,test\n");
    const unicodeHash = createHash("sha256").update(unicodePayload).digest("hex");
    const unicodeKey = `rri-raw/acc_corp/prop_hotel_1/${unicodeHash}`;
    const unicodeMetadata = {
      account_id: "acc_corp",
      server_property_id: "prop_hotel_1",
      raw_hash: unicodeHash,
      original_file_name: "Café ✓.csv",
      notes: "Tokyo 東京 🚀",
      immutable: "true",
    };

    const putUniResult = await gcsStores.rawStore.put(unicodeKey, unicodePayload, {
      customMetadata: unicodeMetadata,
      httpMetadata: { contentType: "text/csv" },
      sha256: unicodeHash,
    });
    check(putUniResult != null, "GCS unicode metadata upload succeeds");

    const headUni = await gcsStores.rawStore.head(unicodeKey);
    check(headUni != null, "GCS unicode object head succeeds");
    check(headUni?.customMetadata?.original_file_name === "Café ✓.csv", "GCS head decodes RFC 2047 unicode original_file_name accurately");
    check(headUni?.customMetadata?.notes === "Tokyo 東京 🚀", "GCS head decodes RFC 2047 multibyte unicode notes accurately");
  }

  // D. Commit Chunk 412 Precondition Failed Handling
  {
    const commitFailSessionFetch = async (urlStr, init = {}) => {
      const url = new URL(urlStr);
      if (url.origin === "https://oauth2.googleapis.com") {
        return new Response(JSON.stringify({ access_token: "test-token", expires_in: 3600 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname.includes("/upload/storage/v1/")) {
        return new Response(null, {
          status: 200,
          headers: { location: "https://storage.googleapis.com/upload/session?upload_id=fail-session" },
        });
      }
      // Commit PUT returns 412
      return new Response(JSON.stringify({ error: { code: 412, message: "Precondition Failed" } }), {
        status: 412,
        headers: { "content-type": "application/json" },
      });
    };

    const commitFailStores = resolveR2S3Stores(GCS_ENV, {
      tokenFetch: commitFailSessionFetch,
      fetch: commitFailSessionFetch,
      digestFactory: nodeDigestFactory,
    });

    const payload = new Uint8Array([1, 2, 3]);
    const hash = createHash("sha256").update(payload).digest("hex");
    const result = await commitFailStores.rawStore.put(`rri-raw/acc/prop/${hash}`, payload, {
      sha256: hash,
      onlyIf: { etagDoesNotMatch: "*" },
    });
    check(result === null, "GCS putResumable returns null when final chunk commit returns HTTP 412");
  }
}

console.log(`PASSED: R2, Backblaze B2, and GCS object-storage adapter probe (${assertions} assertions)`);
process.exitCode = assertions > 0 ? 0 : 1;


