import { AwsClient } from "aws4fetch";

const ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/i;
const BUCKET_PATTERN = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const RFC2047_PATTERN = /^=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=$/i;
const B2_ENDPOINT_PATTERN = /^https:\/\/s3\.([a-z0-9]+(?:-[a-z0-9]+)*)\.backblazeb2\.com\/?$/;
const REGION_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const B2_BUCKET_PATTERN = /^[a-z0-9][a-z0-9.-]{4,61}[a-z0-9]$/;
const IPV4_PATTERN = /^\d+\.\d+\.\d+\.\d+$/;
const B2_FORBIDDEN_PREFIXES = ["b2-", "xn--", "sthree-", "amzn-s3-demo-"];
const B2_FORBIDDEN_SUFFIXES = ["-s3alias", "--ol-s3", ".mrap", "--x-s3", "--table-s3"];

const GCS_ENDPOINT = "https://storage.googleapis.com";
const GCS_ENDPOINT_PATTERN = /^https:\/\/storage\.googleapis\.com\/?$/;
const GCS_BUCKET_PATTERN = /^[a-z0-9][a-z0-9.-]{1,220}[a-z0-9]$/;
const GCS_REGION_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CHUNK_SIZE = 256 * 1024;

function isValidB2Bucket(name) {
  if (typeof name !== "string") return false;
  if (!B2_BUCKET_PATTERN.test(name)) return false;
  if (name.includes("..")) return false;
  if (IPV4_PATTERN.test(name)) return false;
  if (B2_FORBIDDEN_PREFIXES.some((prefix) => name.startsWith(prefix))) return false;
  if (B2_FORBIDDEN_SUFFIXES.some((suffix) => name.endsWith(suffix))) return false;
  return true;
}

function isValidGcsBucket(name) {
  if (typeof name !== "string") return false;
  if (!GCS_BUCKET_PATTERN.test(name)) return false;
  if (name.includes("..")) return false;
  if (IPV4_PATTERN.test(name)) return false;
  return true;
}

function isGenericS3Enabled(env) {
  return env?.S3_ENABLED === true || env?.S3_ENABLED === "true";
}

export function isR2S3Enabled(env) {
  return isGenericS3Enabled(env) || env?.R2_S3_ENABLED === true || env?.R2_S3_ENABLED === "true";
}

function requiredString(env, name) {
  const value = env?.[name];
  return typeof value === "string" ? value.trim() : "";
}

function readConfig(env) {
  if (isGenericS3Enabled(env)) {
    const provider = (env?.S3_PROVIDER || "").toLowerCase();
    if (provider === "gcs") {
      const names = ["S3_ENDPOINT", "S3_RAW_BUCKET", "S3_DATA_BUCKET"];
      const values = Object.fromEntries(names.map((name) => [name, requiredString(env, name)]));
      values.GCS_SERVICE_ACCOUNT_JSON = requiredString(env, "GCS_SERVICE_ACCOUNT_JSON");
      const allNames = [...names, "GCS_SERVICE_ACCOUNT_JSON"];
      const missing = allNames.filter((name) => !values[name]);
      if (missing.length) throw configError(`missing ${missing.join(", ")}`);
      if (!GCS_ENDPOINT_PATTERN.test(values.S3_ENDPOINT)) throw configError("invalid S3_ENDPOINT for GCS");
      if (!GCS_REGION_PATTERN.test(requiredString(env, "S3_REGION") || "")) throw configError("invalid S3_REGION for GCS");
      for (const name of ["S3_RAW_BUCKET", "S3_DATA_BUCKET"]) {
        if (!isValidGcsBucket(values[name])) throw configError(`invalid ${name} for GCS`);
      }
      let serviceAccount;
      try {
        serviceAccount = JSON.parse(values.GCS_SERVICE_ACCOUNT_JSON);
      } catch {
        throw configError("invalid GCS_SERVICE_ACCOUNT_JSON");
      }
      if (!serviceAccount || typeof serviceAccount.client_email !== "string" || typeof serviceAccount.private_key !== "string") {
        throw configError("invalid GCS service account credentials");
      }
      return {
        rawBucket: values.S3_RAW_BUCKET,
        dataBucket: values.S3_DATA_BUCKET,
        serviceAccountJson: values.GCS_SERVICE_ACCOUNT_JSON,
        endpoint: GCS_ENDPOINT,
        region: requiredString(env, "S3_REGION"),
        provider: "gcs",
      };
    }
    const names = [
      "S3_ENDPOINT",
      "S3_RAW_BUCKET",
      "S3_DATA_BUCKET",
      "S3_ACCESS_KEY_ID",
      "S3_SECRET_ACCESS_KEY",
    ];
    const values = Object.fromEntries(names.map((name) => [name, requiredString(env, name)]));
    const missing = names.filter((name) => !values[name]);
    if (missing.length) throw configError(`missing ${missing.join(", ")}`);

    for (const name of ["S3_RAW_BUCKET", "S3_DATA_BUCKET"]) {
      if (!isValidB2Bucket(values[name])) throw configError(`invalid ${name}`);
    }
    const match = values.S3_ENDPOINT.match(B2_ENDPOINT_PATTERN);
    if (!match) throw configError("invalid S3_ENDPOINT");
    const inferredRegion = match[1];
    const regionValue = requiredString(env, "S3_REGION");
    if (regionValue) {
      if (!REGION_PATTERN.test(regionValue)) throw configError("invalid S3_REGION");
      if (regionValue !== inferredRegion) throw configError("invalid S3_REGION mismatch");
    }
    return {
      rawBucket: values.S3_RAW_BUCKET,
      dataBucket: values.S3_DATA_BUCKET,
      accessKeyId: values.S3_ACCESS_KEY_ID,
      secretAccessKey: values.S3_SECRET_ACCESS_KEY,
      endpoint: `https://s3.${inferredRegion}.backblazeb2.com`,
      region: regionValue || inferredRegion,
      provider: "backblaze",
    };
  }

  const names = [
    "R2_S3_ACCOUNT_ID",
    "R2_S3_RAW_BUCKET",
    "R2_S3_DATA_BUCKET",
    "R2_S3_ACCESS_KEY_ID",
    "R2_S3_SECRET_ACCESS_KEY",
  ];
  const values = Object.fromEntries(names.map((name) => [name, requiredString(env, name)]));
  const missing = names.filter((name) => !values[name]);
  if (missing.length) throw configError(`missing ${missing.join(", ")}`);
  if (!ACCOUNT_ID_PATTERN.test(values.R2_S3_ACCOUNT_ID)) throw configError("invalid R2_S3_ACCOUNT_ID");
  for (const name of ["R2_S3_RAW_BUCKET", "R2_S3_DATA_BUCKET"]) {
    if (!BUCKET_PATTERN.test(values[name])) throw configError(`invalid ${name}`);
  }
  return {
    accountId: values.R2_S3_ACCOUNT_ID.toLowerCase(),
    rawBucket: values.R2_S3_RAW_BUCKET,
    dataBucket: values.R2_S3_DATA_BUCKET,
    accessKeyId: values.R2_S3_ACCESS_KEY_ID,
    secretAccessKey: values.R2_S3_SECRET_ACCESS_KEY,
    endpoint: `https://${values.R2_S3_ACCOUNT_ID.toLowerCase()}.r2.cloudflarestorage.com`,
    region: "auto",
    provider: "r2",
  };
}

function configError(message) {
  return Object.assign(new Error(`R2 S3 configuration error: ${message}`), {
    code: "R2_S3_CONFIG_MISSING",
    status: 503,
  });
}

function encodePathPart(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function objectUrl(endpoint, bucket, key) {
  const rawKey = String(key);
  const segments = rawKey.split("/");
  if (rawKey.startsWith("/") || segments.some((segment) => segment === "." || segment === "..")) {
    throw configError("invalid object key");
  }
  const encodedKey = segments.map(encodePathPart).join("/");
  return `${endpoint}/${encodePathPart(bucket)}/${encodedKey}`;
}

function base64EncodeUtf8(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64DecodeUtf8(value) {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function encodeMetadataValue(value) {
  const text = String(value);
  return /^[\x20-\x7e]*$/.test(text) ? text : `=?UTF-8?B?${base64EncodeUtf8(text)}?=`;
}

function decodeMetadataValue(value) {
  const match = String(value).match(RFC2047_PATTERN);
  if (!match) return String(value);
  try {
    return base64DecodeUtf8(match[1]);
  } catch {
    return String(value);
  }
}

function safeError(operation, url, response) {
  const parsed = new URL(url);
  const status = response?.status || 503;
  return Object.assign(new Error(`R2 S3 ${operation} failed: ${status} for ${parsed.origin}${parsed.pathname}`), {
    name: "R2S3Error",
    status,
    code: `R2_S3_${operation.toUpperCase()}_FAILED`,
  });
}

function parseObject(key, response) {
  const customMetadata = {};
  for (const [name, value] of response.headers.entries()) {
    const lowerName = name.toLowerCase();
    if (lowerName.startsWith("x-amz-meta-") || lowerName.startsWith("x-goog-meta-")) {
      const metaKey = lowerName.startsWith("x-amz-meta-") ? name.slice("x-amz-meta-".length) : name.slice("x-goog-meta-".length);
      customMetadata[metaKey] = decodeMetadataValue(value);
    }
  }
  const httpEtag = response.headers.get("etag") || undefined;
  const uploaded = response.headers.get("last-modified");
  const expires = response.headers.get("expires");
  return {
    key: String(key),
    size: Number(response.headers.get("content-length") || 0),
    etag: httpEtag?.replace(/^"|"$/g, ""),
    httpEtag,
    uploaded: uploaded ? new Date(uploaded) : undefined,
    customMetadata,
    httpMetadata: {
      contentType: response.headers.get("content-type") || undefined,
      contentEncoding: response.headers.get("content-encoding") || undefined,
      contentDisposition: response.headers.get("content-disposition") || undefined,
      contentLanguage: response.headers.get("content-language") || undefined,
      cacheControl: response.headers.get("cache-control") || undefined,
      expires: expires ? new Date(expires) : undefined,
    },
  };
}

function putHeaders(options, provider = "s3") {
  const headers = new Headers();
  const metaPrefix = provider === "gcs" ? "x-goog-meta-" : "x-amz-meta-";
  for (const [name, value] of Object.entries(options?.customMetadata || {})) {
    if (!/^[a-z0-9._-]+$/i.test(name)) throw configError("invalid custom metadata name");
    if (value != null) headers.set(`${metaPrefix}${name.toLowerCase()}`, encodeMetadataValue(value));
  }
  const metadata = options?.httpMetadata || {};
  const mappings = {
    contentType: "content-type",
    contentEncoding: "content-encoding",
    contentDisposition: "content-disposition",
    contentLanguage: "content-language",
    cacheControl: "cache-control",
  };
  for (const [field, header] of Object.entries(mappings)) {
    if (metadata[field] != null) headers.set(header, String(metadata[field]));
  }
  if (metadata.expires != null) {
    headers.set("expires", metadata.expires instanceof Date ? metadata.expires.toUTCString() : String(metadata.expires));
  }
  if (options?.onlyIf != null) {
    const keys = Object.keys(options.onlyIf);
    if (keys.length !== 1 || keys[0] !== "etagDoesNotMatch" || options.onlyIf.etagDoesNotMatch !== "*") {
      throw configError("unsupported onlyIf condition");
    }
    if (provider === "gcs") {
      headers.set("x-goog-if-generation-match", "0");
    } else {
      headers.set("if-none-match", "*");
    }
  }
  if (options?.sha256 != null) {
    if (!SHA256_PATTERN.test(String(options.sha256))) throw configError("invalid sha256 option");
    if (provider !== "gcs") {
      headers.set("x-amz-content-sha256", String(options.sha256).toLowerCase());
    }
  }
  return headers;
}

const CRC32C_TABLE = (() => {
  const table = new Uint32Array(256);
  const polynomial = 0x82f63b78;
  for (let i = 0; i < 256; i++) {
    let crc = i;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 1) ? (crc >>> 1) ^ polynomial : crc >>> 1;
    }
    table[i] = crc >>> 0;
  }
  return table;
})();

function updateCrc32c(crc, chunk) {
  for (const byte of chunk) {
    crc = (crc >>> 8) ^ CRC32C_TABLE[(crc ^ byte) & 0xff];
  }
  return crc >>> 0;
}

function crc32cToBase64(crc) {
  const bytes = new Uint8Array([
    (crc >>> 24) & 0xff,
    (crc >>> 16) & 0xff,
    (crc >>> 8) & 0xff,
    crc & 0xff,
  ]);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function bytesToHex(bytes) {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function createDigestAccumulator() {
  const DigestStream = Reflect.get(crypto, "DigestStream");
  if (typeof DigestStream !== "function") throw configError("GCS runtime support unavailable");
  const digestStream = new DigestStream("SHA-256");
  const writer = digestStream.getWriter();
  return {
    update: (chunk) => writer.write(chunk),
    async finish() {
      await writer.close();
      return bytesToHex(await digestStream.digest);
    },
    abort: (reason) => writer.abort(reason),
  };
}

function asReadableStream(value) {
  if (value && typeof value.getReader === "function") return value;
  const body = new Response(value).body;
  if (!body) throw configError("invalid upload body");
  return body;
}

function validateSessionUri(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "storage.googleapis.com" || url.username || url.password) {
      throw new Error("invalid session URI");
    }
    return url.toString();
  } catch {
    throw configError("invalid GCS upload session");
  }
}

function base64UrlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlEncodeText(value) {
  return base64UrlEncode(new TextEncoder().encode(value));
}

function pemToDer(value) {
  const body = String(value)
    .replace(/\\n/g, "\n")
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  try {
    const binary = atob(body);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw configError("invalid GCS service account private key");
  }
}

export async function createGoogleServiceAccountJwt(serviceAccountJson, now = new Date()) {
  let credentials;
  try {
    credentials = typeof serviceAccountJson === "string" ? JSON.parse(serviceAccountJson) : serviceAccountJson;
  } catch {
    throw configError("invalid GCS_SERVICE_ACCOUNT_JSON");
  }
  if (!credentials || typeof credentials.client_email !== "string" || typeof credentials.private_key !== "string") {
    throw configError("invalid GCS service account credentials");
  }
  const issuedAt = Math.floor(now.getTime() / 1000);
  const header = base64UrlEncodeText(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64UrlEncodeText(JSON.stringify({
    iss: credentials.client_email,
    scope: "https://www.googleapis.com/auth/devstorage.read_write",
    aud: "https://oauth2.googleapis.com/token",
    iat: issuedAt,
    exp: issuedAt + 3600,
  }));
  const unsigned = `${header}.${claim}`;
  let key;
  try {
    key = await crypto.subtle.importKey(
      "pkcs8",
      pemToDer(credentials.private_key),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch {
    throw configError("invalid GCS service account private key");
  }
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${base64UrlEncode(new Uint8Array(signature))}`;
}

function gcsObjectParts(endpoint, url) {
  const parsed = new URL(url);
  const expected = new URL(endpoint);
  if (parsed.origin !== expected.origin) throw configError("invalid GCS object URL");
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length < 2) throw configError("invalid GCS object URL");
  const bucket = decodeURIComponent(segments.shift());
  const key = segments.map((segment) => decodeURIComponent(segment)).join("/");
  return { bucket, key };
}

function gcsMetadataHeaders(object, bodyHeaders = {}) {
  const headers = new Headers(bodyHeaders);
  if (object?.size != null) headers.set("content-length", String(object.size));
  if (object?.etag) headers.set("etag", object.etag);
  if (object?.updated) headers.set("last-modified", new Date(object.updated).toUTCString());
  if (object?.contentType) headers.set("content-type", object.contentType);
  if (object?.contentEncoding) headers.set("content-encoding", object.contentEncoding);
  for (const [name, value] of Object.entries(object?.metadata || {})) {
    headers.set(`x-goog-meta-${name}`, encodeMetadataValue(value));
  }
  return headers;
}

export class GcsJsonClient {
  constructor({ serviceAccountJson, endpoint = GCS_ENDPOINT, tokenFetch, now }) {
    this.serviceAccountJson = serviceAccountJson;
    this.endpoint = endpoint;
    this.tokenFetch = tokenFetch || globalThis.fetch;
    this.now = now || (() => new Date());
    this.cachedToken = null;
    this.tokenPromise = null;
  }

  async accessToken() {
    const nowSeconds = Math.floor(this.now().getTime() / 1000);
    if (this.cachedToken && this.cachedToken.expiresAt > nowSeconds + 60) return this.cachedToken.value;
    if (this.tokenPromise) return this.tokenPromise;
    this.tokenPromise = (async () => {
      const assertion = await createGoogleServiceAccountJwt(this.serviceAccountJson, this.now());
      const response = await this.tokenFetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${encodeURIComponent(assertion)}`,
      });
      if (!response.ok) throw configError("GCS OAuth token exchange failed");
      const token = await response.json();
      if (typeof token?.access_token !== "string" || !Number.isFinite(Number(token.expires_in))) {
        throw configError("invalid GCS OAuth token response");
      }
      this.cachedToken = { value: token.access_token, expiresAt: nowSeconds + Number(token.expires_in) };
      return token.access_token;
    })();
    try {
      return await this.tokenPromise;
    } finally {
      this.tokenPromise = null;
    }
  }

  async authorized(url, init = {}) {
    const headers = new Headers(init.headers || {});
    headers.set("authorization", `Bearer ${await this.accessToken()}`);
    return this.tokenFetch(url, { ...init, headers });
  }

  async fetch(url, init = {}) {
    const method = String(init.method || "GET").toUpperCase();
    const headers = new Headers(init.headers || {});
    const { bucket, key } = gcsObjectParts(this.endpoint, url);
    const encodedBucket = encodePathPart(bucket);
    const encodedKey = encodeURIComponent(key);
    const metadataUrl = `${this.endpoint}/storage/v1/b/${encodedBucket}/o/${encodedKey}`;
    if (method === "POST" && headers.get("x-goog-resumable") === "start") {
      const metadata = {};
      for (const [name, value] of headers.entries()) {
        if (name.toLowerCase().startsWith("x-goog-meta-")) metadata[name.slice("x-goog-meta-".length)] = decodeMetadataValue(value);
      }
      const body = { name: key, metadata };
      if (headers.get("content-type")) body.contentType = headers.get("content-type");
      if (headers.get("content-encoding")) body.contentEncoding = headers.get("content-encoding");
      const query = new URLSearchParams({ uploadType: "resumable", name: key });
      if (headers.get("x-goog-if-generation-match") === "0") query.set("ifGenerationMatch", "0");
      const initiationUrl = `${this.endpoint}/upload/storage/v1/b/${encodedBucket}/o?${query.toString()}`;
      return this.authorized(initiationUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    }
    if (method === "HEAD") {
      const response = await this.authorized(metadataUrl, { method: "GET" });
      if (!response.ok) return response;
      const object = await response.json();
      return new Response(null, { status: response.status, headers: gcsMetadataHeaders(object) });
    }
    if (method === "GET") {
      const metadataResponse = await this.authorized(metadataUrl, { method: "GET" });
      if (!metadataResponse.ok) return metadataResponse;
      const object = await metadataResponse.json();
      const mediaResponse = await this.authorized(`${metadataUrl}?alt=media`, { method: "GET" });
      if (!mediaResponse.ok) return mediaResponse;
      return new Response(mediaResponse.body, {
        status: mediaResponse.status,
        statusText: mediaResponse.statusText,
        headers: gcsMetadataHeaders(object, mediaResponse.headers),
      });
    }
    if (method === "DELETE") {
      const response = await this.authorized(metadataUrl, { method: "DELETE" });
      if (response.status === 404 || response.status === 204 || response.status === 200) {
        return new Response(null, { status: 204 });
      }
      return response;
    }
    return this.authorized(url, init);
  }
}

function createGcsPutStore({ client, endpoint, bucket, fetchImpl, digestFactory }) {
  async function request(operation, key, init) {
    const url = objectUrl(endpoint, bucket, key);
    let response;
    try {
      response = await client.fetch(url, init);
    } catch {
      throw safeError(operation, url);
    }
    return { response, url };
  }

  async function discard(response) {
    try {
      await response.body?.cancel();
    } catch {
    }
  }

  async function putResumable(key, value, options = {}) {
    const { sha256: expectedSha256 } = options;

    const initUrl = objectUrl(endpoint, bucket, key);
    const initHeaders = putHeaders(options, "gcs");
    initHeaders.set("x-goog-resumable", "start");
    if (expectedSha256) {
      if (!SHA256_PATTERN.test(String(expectedSha256))) throw configError("invalid sha256 option");
      initHeaders.delete("x-amz-content-sha256");
    }

    let sessionUri;
    {
      let response;
      try {
        response = await client.fetch(initUrl, {
          method: "POST",
          headers: initHeaders,
          body: "",
        });
      } catch {
        throw safeError("put", initUrl);
      }
      if (response.status === 412) {
        await discard(response);
        return null;
      }
      if (!response.ok) {
        await discard(response);
        throw safeError("put", initUrl, response);
      }
      const location = response.headers.get("location");
      if (!location) {
        await discard(response);
        throw safeError("put", initUrl, new Response(null, { status: 500 }));
      }
      sessionUri = validateSessionUri(location);
      await discard(response);
    }

    const reader = asReadableStream(value).getReader();
    const digest = digestFactory();
    let crc32c = 0xffffffff;
    let totalBytes = 0;
    let uploadedBytes = 0;
    let heldChunk;
    let pending = new Uint8Array(CHUNK_SIZE);
    let pendingLength = 0;

    async function cancelSession() {
      try {
        await fetchImpl(sessionUri, { method: "DELETE", headers: { "content-length": "0" } });
      } catch {
      }
    }

    async function sendIntermediate(chunk) {
      const end = uploadedBytes + chunk.byteLength - 1;
      let response;
      try {
        response = await fetchImpl(sessionUri, {
          method: "PUT",
          headers: {
            "content-range": `bytes ${uploadedBytes}-${end}/*`,
            "content-length": String(chunk.byteLength),
          },
          body: chunk,
        });
      } catch {
        throw safeError("put", initUrl);
      }
      const persisted = response.headers.get("range");
      if (response.status !== 308 || persisted !== `bytes=0-${end}`) {
        await discard(response);
        throw safeError("put", initUrl, response);
      }
      uploadedBytes = end + 1;
      await discard(response);
    }

    try {
      while (true) {
        const { done, value: sourceChunk } = await reader.read();
        if (done) break;
        const chunk = sourceChunk instanceof Uint8Array ? sourceChunk : new Uint8Array(sourceChunk);
        await digest.update(chunk);
        crc32c = updateCrc32c(crc32c, chunk);
        totalBytes += chunk.byteLength;

        let sourceOffset = 0;
        while (sourceOffset < chunk.byteLength) {
          if (pendingLength === CHUNK_SIZE) {
            if (heldChunk) await sendIntermediate(heldChunk);
            heldChunk = pending;
            pending = new Uint8Array(CHUNK_SIZE);
            pendingLength = 0;
          }
          const length = Math.min(CHUNK_SIZE - pendingLength, chunk.byteLength - sourceOffset);
          pending.set(chunk.subarray(sourceOffset, sourceOffset + length), pendingLength);
          pendingLength += length;
          sourceOffset += length;
        }
      }

      let finalChunk;
      if (pendingLength > 0) {
        if (heldChunk) await sendIntermediate(heldChunk);
        finalChunk = pending.subarray(0, pendingLength);
      } else if (heldChunk) {
        finalChunk = heldChunk;
      } else {
        finalChunk = new Uint8Array(0);
      }

      const computedSha256 = await digest.finish();
      if (expectedSha256 && computedSha256.toLowerCase() !== expectedSha256.toLowerCase()) {
        throw Object.assign(new Error("checksum mismatch: sha256 verification failed"), {
          code: "CHECKSUM_MISMATCH",
          status: 400,
        });
      }

      const finalCrc32c = (crc32c ^ 0xffffffff) >>> 0;
      const crc32cBase64 = crc32cToBase64(finalCrc32c);
      const finalRange = totalBytes === 0
        ? "bytes */0"
        : `bytes ${uploadedBytes}-${totalBytes - 1}/${totalBytes}`;
      const finalHeaders = {
        "content-range": finalRange,
        "content-length": String(finalChunk.byteLength),
        "x-goog-hash": `crc32c=${crc32cBase64}`,
      };

      let finalResponse;
      try {
        finalResponse = await fetchImpl(sessionUri, {
          method: "PUT",
          headers: finalHeaders,
          body: finalChunk,
        });
      } catch {
        throw safeError("put", initUrl);
      }
      if (finalResponse.status === 412) {
        await discard(finalResponse);
        return null;
      }
      if (!finalResponse.ok) {
        await discard(finalResponse);
        throw safeError("put", initUrl, finalResponse);
      }

      const httpEtag = finalResponse.headers.get("etag") || undefined;
      return { key: String(key), etag: httpEtag?.replace(/^"|"$/g, ""), httpEtag };
    } catch (error) {
      await cancelSession();
      throw error;
    } finally {
      reader.releaseLock();
    }
  }

  return {
    async head(key) {
      const { response, url } = await request("head", key, { method: "HEAD" });
      if (response.status === 404) {
        await discard(response);
        return null;
      }
      if (!response.ok) {
        await discard(response);
        throw safeError("head", url, response);
      }
      return parseObject(key, response);
    },

    async get(key) {
      const { response, url } = await request("get", key, { method: "GET" });
      if (response.status === 404) {
        await discard(response);
        return null;
      }
      if (!response.ok) {
        await discard(response);
        throw safeError("get", url, response);
      }
      return {
        ...parseObject(key, response),
        body: response.body,
        get bodyUsed() { return response.bodyUsed; },
        arrayBuffer: () => response.arrayBuffer(),
        text: () => response.text(),
        json: () => response.json(),
        blob: () => response.blob(),
      };
    },

    async put(key, value, options = {}) {
      return putResumable(key, value, options);
    },

    async delete(key) {
      const { response, url } = await request("delete", key, { method: "DELETE" });
      if (!response.ok) {
        await discard(response);
        throw safeError("delete", url, response);
      }
    },
  };
}

function createStore({ client, endpoint, bucket, provider = "s3" }) {
  async function request(operation, key, init) {
    const url = objectUrl(endpoint, bucket, key);
    let response;
    try {
      response = await client.fetch(url, init);
    } catch {
      throw safeError(operation, url);
    }
    return { response, url };
  }

  async function discard(response) {
    try {
      await response.body?.cancel();
    } catch {
    }
  }

  return {
    async head(key) {
      const { response, url } = await request("head", key, { method: "HEAD" });
      if (response.status === 404) return null;
      if (!response.ok) {
        await discard(response);
        throw safeError("head", url, response);
      }
      return parseObject(key, response);
    },

    async get(key) {
      const { response, url } = await request("get", key, { method: "GET" });
      if (response.status === 404) {
        await discard(response);
        return null;
      }
      if (!response.ok) {
        await discard(response);
        throw safeError("get", url, response);
      }
      return {
        ...parseObject(key, response),
        body: response.body,
        get bodyUsed() { return response.bodyUsed; },
        arrayBuffer: () => response.arrayBuffer(),
        text: () => response.text(),
        json: () => response.json(),
        blob: () => response.blob(),
      };
    },

    async put(key, value, options = {}) {
      const { response, url } = await request("put", key, {
        method: "PUT",
        headers: putHeaders(options, provider),
        body: value,
      });
      if (response.status === 412) {
        await discard(response);
        return null;
      }
      if (!response.ok) {
        await discard(response);
        throw safeError("put", url, response);
      }
      const httpEtag = response.headers.get("etag") || undefined;
      return { key: String(key), etag: httpEtag?.replace(/^"|"$/g, ""), httpEtag };
    },

    async delete(key) {
      const { response, url } = await request("delete", key, { method: "DELETE" });
      if (!response.ok) {
        await discard(response);
        throw safeError("delete", url, response);
      }
    },
  };
}

export function resolveR2S3Stores(env, dependencies = {}) {
  if (!isR2S3Enabled(env)) return null;
  const config = readConfig(env);
  const createClient = dependencies.clientFactory || ((options) => config.provider === "gcs"
    ? new GcsJsonClient({ ...options, tokenFetch: dependencies.tokenFetch || dependencies.fetch })
    : new AwsClient(options));
  const client = createClient(config.provider === "gcs" ? {
    serviceAccountJson: config.serviceAccountJson,
    endpoint: config.endpoint,
    region: config.region,
  } : {
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: "s3",
    region: config.region,
  });
  if (!client || typeof client.fetch !== "function") throw configError("invalid S3 client");
  const endpoint = config.endpoint;
  const provider = config.provider || "s3";
  const storeFactory = provider === "gcs" ? createGcsPutStore : createStore;
  const fetchImpl = dependencies.fetch || globalThis.fetch;
  const digestFactory = dependencies.digestFactory || createDigestAccumulator;
  if (provider === "gcs" && (typeof fetchImpl !== "function" || typeof digestFactory !== "function")) {
    throw configError("GCS runtime support unavailable");
  }
  return {
    rawStore: storeFactory({ client, endpoint, bucket: config.rawBucket, provider, fetchImpl, digestFactory }),
    bulkStore: storeFactory({ client, endpoint, bucket: config.dataBucket, provider, fetchImpl, digestFactory }),
  };
}
