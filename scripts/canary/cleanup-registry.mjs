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
    this.createdArchiveIds = new Set();
    this._signalHandlerInstalled = false;
  }

  /**
   * Record a created raw object key.
   * @param {string} key
   */
  trackRawKey(key) {
    if (key) this.createdRawKeys.add(String(key));
  }

  /**
   * Record a created bundle object key.
   * @param {string} key
   */
  trackBundleKey(key) {
    if (key) this.createdBundleKeys.add(String(key));
  }

  /**
   * Record a created bundle ID.
   * @param {string} id
   */
  trackBundleId(id) {
    if (id) this.createdBundleIds.add(String(id));
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
   *   remainingKeys: string[],
   *   verdict: 'CLEAN' | 'PARTIAL' | 'FAILED' | 'SKIPPED',
   *   reportStatus: string,
   * }>}
   */
  async runCleanup(client, options = {}) {
    const attempted = this.createdBundleIds.size + this.createdArchiveIds.size;
    let deleted = 0;
    let locked = 0;
    let failed = 0;
    const remainingKeys = [];

    if (!client || typeof client.deleteBundle !== 'function') {
      return {
        runId: this.runId,
        attempted: 0,
        deleted: 0,
        locked: 0,
        failed: 0,
        remainingKeys: [...this.createdRawKeys, ...this.createdBundleKeys],
        verdict: 'SKIPPED',
        reportStatus: 'NO_CLIENT_FOR_CLEANUP',
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
        }
      } catch (err) {
        failed++;
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

    let verdict = 'CLEAN';
    if (failed > 0) {
      verdict = deleted > 0 ? 'PARTIAL' : 'FAILED';
    } else if (locked > 0) {
      verdict = 'PARTIAL';
    }

    const reportStatus = (verdict === 'CLEAN')
      ? 'CLEAN'
      : `TEST PASS / CLEANUP ${verdict} (${remainingKeys.length} remaining resources to sweep manually)`;

    return {
      runId: this.runId,
      attempted,
      deleted,
      locked,
      failed,
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
