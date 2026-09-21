// scripts/canary/cleanup-registry.mjs
// Scoped run-ID tracking and safe cleanup registry for canary resources.

export class CleanupRegistry {
  /**
   * @param {string} [runId]
   */
  constructor(runId) {
    this.runId = runId || `canary-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    this.createdRawKeys = new Set();
    this.createdBundleKeys = new Set();
    this.createdBundleIds = new Set();
    this.bundleKeyIds = new Map();
    this.createdArchiveIds = new Set();
    this.mappedRawKeys = new Set();
    this.mappedBundleKeys = new Set();
    this.orphanedR2Keys = new Set();
    this._signalHandlerInstalled = false;
  }

  /**
   * Record a created raw object key.
   * @param {string} key
   * @param {boolean} [mapped]
   */
  trackRawKey(key, mapped = false) {
    if (key) {
      const k = String(key);
      this.createdRawKeys.add(k);
      if (mapped) this.mappedRawKeys.add(k);
    }
  }

  /**
   * Record a created bundle object key.
   * @param {string} key
   * @param {boolean} [mapped]
   */
  trackBundleKey(key, mapped = false) {
    if (key) {
      const k = String(key);
      this.createdBundleKeys.add(k);
      if (mapped) this.mappedBundleKeys.add(k);
    }
  }

  /**
   * Mark a raw key as successfully mapped to a D1 record.
   * @param {string} key
   */
  markRawKeyMapped(key) {
    if (key) this.mappedRawKeys.add(String(key));
  }

  /**
   * Mark a bundle key as successfully mapped to a D1 record.
   * @param {string} key
   */
  markBundleKeyMapped(key) {
    if (key) this.mappedBundleKeys.add(String(key));
  }

  /**
   * Explicitly record an unmapped / orphaned R2 key.
   * @param {string} key
   */
  trackOrphanedR2Key(key) {
    if (key) this.orphanedR2Keys.add(String(key));
  }

  /**
   * Record a created bundle ID.
   * @param {string} id
   */
  trackBundleId(id, key = null) {
    if (id) {
      const bundleId = String(id);
      this.createdBundleIds.add(bundleId);
      if (key) this.bundleKeyIds.set(String(key), bundleId);
    }
  }

  /**
   * Record a created raw archive ID.
   * @param {string} id
   */
  trackArchiveId(id) {
    if (id) this.createdArchiveIds.add(String(id));
  }

  /**
   * Install emergency signal handlers to sweep resources on user cancel (Ctrl+C).
   * @param {any} client
   */
  installSignalHandlers(client) {
    if (this._signalHandlerInstalled) return;
    this._signalHandlerInstalled = true;

    const handler = async (signal) => {
      console.warn(`\n[CLEANUP] Received ${signal}. Executing emergency canary cleanup for run ${this.runId}...`);
      try {
        const result = await this.cleanup(client, { emergency: true });
        console.warn(`[CLEANUP] Emergency cleanup result: ${result.verdict} (deleted ${result.deleted}, remaining: ${result.remainingKeys.length})`);
      } catch (err) {
        console.error('[CLEANUP] Emergency cleanup failed:', err?.message || err);
      }
      process.exit(130);
    };

    process.once('SIGINT', () => handler('SIGINT'));
    process.once('SIGTERM', () => handler('SIGTERM'));
  }

  /**
   * Execute cleanup of all tracked resources using client.
   * @param {any} client
   * @param {object} [options]
   * @param {boolean} [options.emergency]
   * @param {boolean} [options.confirmDestroy]
   * @returns {Promise<{
   *   runId: string,
   *   attempted: number,
   *   deleted: number,
   *   locked: number,
   *   failed: number,
   *   orphanedR2Keys: string[],
   *   remainingKeys: string[],
   *   verdict: 'CLEAN' | 'PARTIAL' | 'FAILED' | 'SKIPPED',
   *   reportStatus: string,
   * }>}
   */
  async runCleanup(client, options = {}) {
    const remainingKeys = [];

    for (const [key, bundleId] of this.bundleKeyIds) {
      if (this.createdBundleIds.has(bundleId)) this.mappedBundleKeys.add(key);
    }

    // Identify unmapped R2 keys that were never committed to D1 manifests
    const unmappedRaw = [...this.createdRawKeys].filter((k) => !this.mappedRawKeys.has(k));
    const unmappedBundles = [...this.createdBundleKeys].filter((k) => !this.mappedBundleKeys.has(k) && !this.bundleKeyIds.has(k));
    for (const key of [...unmappedRaw, ...unmappedBundles, ...this.orphanedR2Keys]) {
      this.orphanedR2Keys.add(key);
      const tag = `${key} (unmapped-r2-orphan)`;
      if (!remainingKeys.includes(tag)) {
        remainingKeys.push(tag);
      }
    }

    const attempted = this.createdBundleIds.size + this.createdArchiveIds.size + unmappedRaw.length + unmappedBundles.length;
    let deleted = 0;
    let locked = 0;
    let failed = unmappedRaw.length + unmappedBundles.length;

    if (!client || typeof client.deleteBundle !== 'function') {
      const hasTracked = this.createdRawKeys.size > 0 || this.createdBundleKeys.size > 0 || this.createdBundleIds.size > 0 || this.createdArchiveIds.size > 0;
      return {
        runId: this.runId,
        attempted,
        deleted: 0,
        locked: 0,
        failed: hasTracked ? attempted : 0,
        orphanedR2Keys: [...this.orphanedR2Keys],
        remainingKeys: [...remainingKeys, ...this.createdRawKeys, ...this.createdBundleKeys],
        verdict: hasTracked ? 'FAILED' : 'SKIPPED',
        reportStatus: hasTracked ? 'NO_CLIENT_FOR_CLEANUP_FAILED' : 'NO_CLIENT_FOR_CLEANUP',
      };
    }

    // 1. Delete / Tombstone created bundles
    for (const bundleId of this.createdBundleIds) {
      try {
        const res = await client.deleteBundle(bundleId);
        if (res && (res.ok || res.dryRun)) {
          deleted++;
        } else {
          failed++;
          remainingKeys.push(bundleId);
        }
      } catch (err) {
        // If 404 IMPORT_BUNDLE_NOT_FOUND, the bundle was already superseded, tombstoned, or deactivated
        if (err?.status === 404 && (err?.code === 'IMPORT_BUNDLE_NOT_FOUND' || /bundle not found/i.test(err?.message))) {
          deleted++;
        } else {
          failed++;
          remainingKeys.push(bundleId);
        }
      }
    }


    // 2. Destroy raw archives if supported
    for (const archiveId of this.createdArchiveIds) {
      try {
        const res = await client.destroyRawArchive({
          archiveId,
          confirmDestroy: options.confirmDestroy !== false,
        });
        if (res && (res.ok || res.dryRun)) {
          deleted++;
        } else {
          failed++;
          remainingKeys.push(archiveId);
        }
      } catch (err) {
        if (err?.status === 423 || err?.code === 'RAW_ARCHIVE_LOCKED') {
          locked++;
          // Retention locked is an expected state if bucket policy is applied
          remainingKeys.push(`${archiveId} (retention-locked)`);
        } else {
          failed++;
          remainingKeys.push(archiveId);
        }
      }
    }

    const totalCreated = this.createdRawKeys.size + this.createdBundleKeys.size + this.createdBundleIds.size + this.createdArchiveIds.size;
    let verdict = 'CLEAN';
    if (this.orphanedR2Keys.size > 0 || failed > 0 || remainingKeys.length > 0) {
      verdict = (deleted > 0) ? 'PARTIAL' : 'FAILED';
    } else if (locked > 0) {
      verdict = 'PARTIAL';
    } else if (totalCreated > 0 && deleted === 0 && !options.dryRun) {
      verdict = 'FAILED';
    }

    const reportStatus = (verdict === 'CLEAN')
      ? 'CLEAN'
      : `CLEANUP ${verdict} (${remainingKeys.length} remaining resources to sweep manually)`;

    return {
      runId: this.runId,
      attempted,
      deleted,
      locked,
      failed,
      orphanedR2Keys: [...this.orphanedR2Keys],
      remainingKeys,
      verdict,
      reportStatus,
    };
  }

  // Alias for backward compatibility
  async cleanup(client, options = {}) {
    return this.runCleanup(client, options);
  }
}
