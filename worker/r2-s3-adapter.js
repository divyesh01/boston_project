import { AwsClient } from "aws4fetch";

const ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/i;
const BUCKET_PATTERN = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const RFC2047_PATTERN = /^=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=$/i;

export function isR2S3Enabled(env) {
  return env?.R2_S3_ENABLED === true || env?.R2_S3_ENABLED === "true";
}

function requiredString(env, name) {
  const value = env?.[name];
  return typeof value === "string" ? value.trim() : "";
}

function readConfig(env) {
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
    if (name.startsWith("x-amz-meta-")) {
      customMetadata[name.slice("x-amz-meta-".length)] = decodeMetadataValue(value);
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

function putHeaders(options) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(options?.customMetadata || {})) {
    if (!/^[a-z0-9._-]+$/i.test(name)) throw configError("invalid custom metadata name");
    if (value != null) headers.set(`x-amz-meta-${name.toLowerCase()}`, encodeMetadataValue(value));
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
    headers.set("if-none-match", "*");
  }
  if (options?.sha256 != null) {
    if (!SHA256_PATTERN.test(String(options.sha256))) throw configError("invalid sha256 option");
    headers.set("x-amz-content-sha256", String(options.sha256).toLowerCase());
  }
  return headers;
}

function createStore({ client, endpoint, bucket }) {
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
      // The status remains authoritative even if the error body cannot be canceled.
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
        headers: putHeaders(options),
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
  const createClient = dependencies.clientFactory || ((options) => new AwsClient(options));
  const client = createClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: "s3",
    region: "auto",
  });
  if (!client || typeof client.fetch !== "function") throw configError("invalid S3 client");
  const endpoint = `https://${config.accountId}.r2.cloudflarestorage.com`;
  return {
    rawStore: createStore({ client, endpoint, bucket: config.rawBucket }),
    bulkStore: createStore({ client, endpoint, bucket: config.dataBucket }),
  };
}
