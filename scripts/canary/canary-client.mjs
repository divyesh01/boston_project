// scripts/canary/canary-client.mjs
// Safe HTTP client for interacting with the RRI Canary Worker endpoint.

import { assertNotProductionTarget, redactSecrets } from './production-guard.mjs';

export class CanaryApiError extends Error {
  /**
   * @param {string} message
   * @param {number} status
   * @param {string} [code]
   * @param {any} [details]
   */
  constructor(message, status = 500, code = 'CANARY_API_ERROR', details = {}) {
    super(redactSecrets(message));
    this.name = 'CanaryApiError';
    this.status = status;
    this.code = code;
    this.details = redactSecrets(details);
  }
}

export class CanaryClient {
  /**
   * @param {object} config
   * @param {string} config.baseUrl Target canary worker URL
   * @param {string} [config.accountId] Account ID
   * @param {string} [config.propertyId] Property ID
   * @param {string} [config.authCookie] Session cookie string
   * @param {string} [config.authToken] Bearer token string
   * @param {boolean} [config.dryRun] If true, NO network calls are made
   * @param {number} [config.timeoutMs] Request timeout in ms (default 30000)
   * @param {typeof fetch} [config.fetchImpl] Custom fetch implementation (for testing)
   */
  constructor(config = {}) {
    this.baseUrl = (config.baseUrl || '').replace(/\/+$/, '');
    this.accountId = config.accountId || 'canary-account-1';
    this.propertyId = config.propertyId || 'canary-prop-1';
    this.authCookie = config.authCookie || null;
    this.authToken = config.authToken || null;
    this.dryRun = Boolean(config.dryRun);
    this.timeoutMs = config.timeoutMs || 30000;
    this.fetch = config.fetchImpl || globalThis.fetch;

    this.requestsDispatched = 0;
    this.plannedRequests = [];

    // Pre-flight assertion: verify this is NOT targeting production
    assertNotProductionTarget({ url: this.baseUrl });
  }

  /**
   * Internal request dispatcher with strict production guard and dry-run protection.
   * @param {string} path
   * @param {RequestInit & { json?: any, rawBody?: Uint8Array | ArrayBuffer }} [options]
   */
  async _request(path, options = {}) {
    // Assert again before every call
    assertNotProductionTarget({ url: this.baseUrl });

    const method = (options.method || 'GET').toUpperCase();
    const url = `${this.baseUrl}${path.startsWith('/') ? path : '/' + path}`;

    const headers = new Headers(options.headers || {});
    if (this.authToken && !headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${this.authToken}`);
    }
    if (this.authCookie && !headers.has('Cookie')) {
      headers.set('Cookie', this.authCookie);
    }

    let body = options.body;
    if (options.json !== undefined) {
      headers.set('Content-Type', 'application/json');
      body = JSON.stringify(options.json);
    } else if (options.rawBody !== undefined) {
      body = options.rawBody;
    }

    if (this.dryRun) {
      this.plannedRequests.push({
        method,
        url: redactSecrets(url),
        headers: redactSecrets(Object.fromEntries(headers.entries())),
        hasBody: Boolean(body),
        bodyLength: body ? (body.byteLength || body.length || 0) : 0,
      });

      return {
        ok: true,
        dryRun: true,
        status: 200,
        statusText: 'OK (DRY RUN)',
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ ok: true, dryRun: true }),
        text: async () => JSON.stringify({ ok: true, dryRun: true }),
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    }

    this.requestsDispatched++;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetch(url, {
        method,
        headers,
        body,
        signal: controller.signal,
      });
      return response;
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new CanaryApiError(`Request timed out after ${this.timeoutMs}ms`, 504, 'GATEWAY_TIMEOUT', { url, method });
      }
      throw new CanaryApiError(
        `Network request failed: ${err.message}`,
        503,
        'CANARY_FETCH_FAILED',
        { url: redactSecrets(url), method, originalError: err.message }
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Parse JSON or extract structured error.
   * @param {Response|any} res
   */
  async _parseJsonResponse(res) {
    if (res.dryRun) return { ok: true, dryRun: true };
    const contentType = res.headers.get('content-type') || '';
    let bodyData = null;
    if (contentType.includes('application/json')) {
      try {
        bodyData = await res.json();
      } catch {
        bodyData = null;
      }
    } else {
      const text = await res.text().catch(() => '');
      try {
        bodyData = JSON.parse(text);
      } catch {
        bodyData = { raw: text };
      }
    }

    if (!res.ok) {
      const msg = bodyData?.error || bodyData?.message || `Request failed with status ${res.status}`;
      const code = bodyData?.code || `HTTP_${res.status}`;
      throw new CanaryApiError(msg, res.status, code, bodyData);
    }

    return bodyData || { ok: true };
  }

  /**
   * Preflight health and reachability check.
   */
  async preflight() {
    const res = await this._request(`/api/bulk-import/manifest?server_property_id=${encodeURIComponent(this.propertyId)}`);
    return await this._parseJsonResponse(res);
  }

  /**
   * Check duplicate server manifest.
   */
  async checkDuplicate({ serverPropertyId, rawFileHash, normalizedHash }) {
    const res = await this._request('/api/bulk-import/check-duplicate', {
      method: 'POST',
      json: {
        server_property_id: serverPropertyId || this.propertyId,
        raw_file_hash: rawFileHash || null,
        normalized_hash: normalizedHash || null,
      },
    });
    return await this._parseJsonResponse(res);
  }

  /**
   * Check raw duplicate archive.
   */
  async checkRawDuplicate({ serverPropertyId, rawFileHash }) {
    const res = await this._request('/api/bulk-import/raw-check', {
      method: 'POST',
      json: {
        server_property_id: serverPropertyId || this.propertyId,
        raw_file_hash: rawFileHash,
      },
    });
    return await this._parseJsonResponse(res);
  }

  /**
   * Upload raw original archive to /api/bulk-import/raw-upload.
   */
  async uploadRawArchive({
    serverPropertyId,
    reportType,
    rawFileHash,
    rawArchiveId,
    originalFileName,
    mimeType = 'text/csv',
    rawBytes,
  }) {
    const headers = {
      'Content-Type': mimeType,
      'x-server-property-id': serverPropertyId || this.propertyId,
      'x-report-type': reportType || 'unknown',
      'x-raw-hash': rawFileHash,
      'x-archive-id': rawArchiveId || `raw_${Date.now()}`,
      'x-file-name': originalFileName || 'report.csv',
    };

    const res = await this._request('/api/bulk-import/raw-upload', {
      method: 'PUT',
      headers,
      rawBody: rawBytes,
    });
    return await this._parseJsonResponse(res);
  }

  /**
   * Record raw archive in D1 manifest.
   */
  async recordRawArchive(params) {
    const res = await this._request('/api/bulk-import/raw-archive', {
      method: 'POST',
      json: {
        server_property_id: params.serverPropertyId || this.propertyId,
        report_type: params.reportType || 'unknown',
        raw_file_hash: params.rawFileHash,
        raw_archive_id: params.rawArchiveId,
        id: params.id || params.rawArchiveId,
        original_file_name: params.originalFileName || 'report.csv',
        file_size: params.fileSize || 0,
        mime_type: params.mimeType || 'text/csv',
        min_date: params.minDate || null,
        max_date: params.maxDate || null,
      },
    });
    return await this._parseJsonResponse(res);
  }

  /**
   * Upload normalized bundle to /api/bulk-import/upload.
   */
  async uploadBundle({
    serverPropertyId,
    reportType,
    rawFileHash,
    normalizedHash,
    rowCount,
    compressedBuffer,
    identityVersion = 2,
    payloadSha256,
  }) {
    const headers = {
      'Content-Type': 'application/x-ndjson',
      'Content-Encoding': 'gzip',
      'x-server-property-id': serverPropertyId || this.propertyId,
      'x-report-type': reportType,
      'x-raw-hash': rawFileHash,
      'x-normalized-hash': normalizedHash,
      'x-row-count': String(rowCount),
      'x-identity-version': String(identityVersion),
    };
    if (payloadSha256) {
      headers['x-payload-sha256'] = payloadSha256;
    }

    const res = await this._request('/api/bulk-import/upload', {
      method: 'PUT',
      headers,
      rawBody: compressedBuffer,
    });
    return await this._parseJsonResponse(res);
  }

  /**
   * Activate bundle in D1.
   */
  async activateBundle(metadata) {
    const res = await this._request('/api/bulk-import/activate', {
      method: 'POST',
      json: {
        ...metadata,
        server_property_id: metadata.server_property_id || this.propertyId,
      },
    });
    return await this._parseJsonResponse(res);
  }

  /**
   * Manifest feed query.
   */
  async getManifest({ serverPropertyId, sinceRevision = 0, afterId = '' } = {}) {
    const q = new URLSearchParams({
      server_property_id: serverPropertyId || this.propertyId,
      since_revision: String(sinceRevision),
      after_id: afterId,
    });
    const res = await this._request(`/api/bulk-import/manifest?${q.toString()}`);
    return await this._parseJsonResponse(res);
  }

  /**
   * Download raw archive bytes.
   */
  async downloadRawArchive(archiveId) {
    const res = await this._request(`/api/bulk-import/raw/${encodeURIComponent(archiveId)}`);
    if (res.dryRun) return { ok: true, dryRun: true, buffer: new ArrayBuffer(0) };
    if (!res.ok) {
      throw new CanaryApiError(`Raw archive download failed: ${res.status}`, res.status);
    }
    const buffer = await res.arrayBuffer();
    return {
      ok: true,
      buffer,
      rawHash: res.headers.get('x-raw-hash') || '',
    };
  }

  /**
   * Download bundle gzip NDJSON bytes.
   */
  async downloadBundle(bundleId) {
    const res = await this._request(`/api/bulk-import/bundle/${encodeURIComponent(bundleId)}`);
    if (res.dryRun) return { ok: true, dryRun: true, buffer: new ArrayBuffer(0) };
    if (!res.ok) {
      throw new CanaryApiError(`Bundle download failed: ${res.status}`, res.status);
    }
    const buffer = await res.arrayBuffer();
    return {
      ok: true,
      buffer,
      normalizedHash: res.headers.get('x-normalized-hash') || '',
    };
  }

  /**
   * Destroy raw archive.
   */
  async destroyRawArchive({ archiveId, confirmDestroy = true, allowBucketLock = false }) {
    const res = await this._request('/api/bulk-import/raw-destroy', {
      method: 'POST',
      json: {
        archive_id: archiveId,
        confirm_destroy: confirmDestroy,
        confirm: 'I_UNDERSTAND_THIS_PERMANENTLY_DELETES_RAW_SOURCE',
        allow_bucket_lock: allowBucketLock,
      },
    });
    return await this._parseJsonResponse(res);
  }

  /**
   * Delete / Tombstone bundle.
   */
  async deleteBundle(bundleId) {
    const res = await this._request('/api/bulk-import/delete', {
      method: 'POST',
      json: { bundle_id: bundleId },
    });
    return await this._parseJsonResponse(res);
  }

  /**
   * Supersede bundle.
   */
  async supersedeBundle({ oldBundleId, newBundleId }) {
    const res = await this._request('/api/bulk-import/supersede', {
      method: 'POST',
      json: { old_bundle_id: oldBundleId, new_bundle_id: newBundleId },
    });
    return await this._parseJsonResponse(res);
  }
}
