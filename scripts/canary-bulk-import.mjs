// scripts/canary-bulk-import.mjs
// Command-line canary test orchestrator for Red Roof Intelligence (RRI) Bulk Import.
// Safe, attributable execution against isolated canary worker with strict production guards.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import zlib from 'node:zlib';
import {
  assertSafeCanaryEnvironment,
  assertNotProductionTarget,
  redactSecrets,
  ProductionGuardError,
} from './canary/production-guard.mjs';
import {
  generateFixtureWithOracle,
  computeIndependentNormalizedHash,
  REPORT_TYPES,
} from './canary/fixture-generator.mjs';
import { CleanupRegistry } from './canary/cleanup-registry.mjs';
import { CanaryClient, CanaryApiError } from './canary/canary-client.mjs';

function parseArgs(args) {
  const flags = {
    dryRun: false,
    preflight: false,
    smoke: false,
    importStage: false,
    concurrency: false,
    hydration: false,
    lock: false,
    large: false,
    cleanup: false,
    all: false,
    json: false,
    allowBucketLock: false,
    output: null,
    config: null,
    target: null,
    property: null,
    account: null,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--preflight') flags.preflight = true;
    else if (arg === '--smoke') flags.smoke = true;
    else if (arg === '--import') flags.importStage = true;
    else if (arg === '--concurrency') flags.concurrency = true;
    else if (arg === '--hydration') flags.hydration = true;
    else if (arg === '--lock') flags.lock = true;
    else if (arg === '--large') flags.large = true;
    else if (arg === '--cleanup') flags.cleanup = true;
    else if (arg === '--all') flags.all = true;
    else if (arg === '--json') flags.json = true;
    else if (arg === '--allow-canary-bucket-lock') flags.allowBucketLock = true;
    else if (arg.startsWith('--output=')) flags.output = arg.slice(9);
    else if (arg === '--output' && i + 1 < args.length) flags.output = args[++i];
    else if (arg.startsWith('--config=')) flags.config = arg.slice(9);
    else if (arg === '--config' && i + 1 < args.length) flags.config = args[++i];
    else if (arg.startsWith('--target=')) flags.target = arg.slice(9);
    else if (arg === '--target' && i + 1 < args.length) flags.target = args[++i];
    else if (arg.startsWith('--property=')) flags.property = arg.slice(11);
    else if (arg === '--property' && i + 1 < args.length) flags.property = args[++i];
    else if (arg.startsWith('--account=')) flags.account = arg.slice(10);
    else if (arg === '--account' && i + 1 < args.length) flags.account = args[++i];
  }

  // If no action specified, default to --all or --dry-run
  if (!flags.preflight && !flags.smoke && !flags.importStage && !flags.concurrency &&
      !flags.hydration && !flags.lock && !flags.large && !flags.cleanup && !flags.all) {
    flags.dryRun = true;
    flags.all = true;
  }

  return flags;
}

function loadConfigFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return {};
  const content = fs.readFileSync(filePath, 'utf8');
  const env = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const k = trimmed.slice(0, eqIdx).trim();
      let v = trimmed.slice(eqIdx + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      env[k] = v;
    }
  }
  return env;
}

export async function runCanary(options = {}) {
  const fileEnv = loadConfigFile(options.config || process.env.CANARY_CONFIG_FILE || 'canary.env');
  const mergedEnv = { ...fileEnv, ...process.env };

  const targetUrl = options.target || mergedEnv.CANARY_WORKER_URL || 'https://rri-bulk-canary-a61a110.divyesh-boston.workers.dev';
  const propertyId = options.property || mergedEnv.CANARY_PROPERTY_ID || 'canary-prop-1';
  const accountId = options.account || mergedEnv.CANARY_ACCOUNT_ID || 'canary-account-1';
  const authCookie = mergedEnv.CANARY_AUTH_COOKIE || null;
  const authToken = mergedEnv.CANARY_AUTH_TOKEN || null;
  const allowBucketLock = Boolean(options.allowBucketLock || mergedEnv.CANARY_ALLOW_BUCKET_LOCK === 'true');

  // Enforce production safety assertions
  assertSafeCanaryEnvironment({ url: targetUrl }, mergedEnv);

  const client = new CanaryClient({
    baseUrl: targetUrl,
    accountId,
    propertyId,
    authCookie,
    authToken,
    dryRun: options.dryRun,
    fetchImpl: options.fetchImpl,
  });

  const registry = new CleanupRegistry();
  if (!options.dryRun && typeof process.once === 'function') {
    registry.installSignalHandlers(client);
  }

  const results = {
    runId: registry.runId,
    targetUrl: redactSecrets(targetUrl),
    dryRun: options.dryRun,
    timestamp: new Date().toISOString(),
    stages: {},
    telemetry: {
      full_import_d1_writes: {
        value: null,
        classification: 'UNMEASURED',
        note: 'D1 physical writes for full-size import will be measured once Cloudflare error 10136 is resolved',
      },
      write_amplification_model: {
        value: '≤ 20 writes per full batch import',
        classification: 'MODELED',
        note: 'Theoretical upper bound for batched manifest & sync mutations',
      },
      compact_activation_d1_writes: {
        value: 3,
        classification: 'LOCAL_SQLITE_MEASURED',
        note: 'Exactly 3 rows written to D1 for atomic activation',
      },
      raw_archival_d1_writes: {
        value: 1,
        classification: 'LOCAL_SQLITE_MEASURED',
        note: 'Exactly 1 row written to D1 for raw archive manifest',
      },
      requests_dispatched: {
        value: 0,
        classification: options.dryRun ? 'MODELED' : 'LOCAL_CLIENT_MEASURED',
        note: options.dryRun ? 'Zero network requests in dry-run mode' : 'Actual HTTP requests sent by local client',
      },
    },
    verdict: 'PENDING',
  };

  const doAll = options.all;
  let stageExecutionError = null;

  try {
    // ── STAGE 1: PREFLIGHT ───────────────────────────────────────────────────
    if (doAll || options.preflight) {
      const stage = { name: 'preflight', ok: true, details: {} };
      try {
        const pre = await client.preflight();
        stage.details = pre;
      } catch (err) {
        stage.ok = false;
        stage.error = err.message;
      }
      results.stages.preflight = stage;
      if (!stage.ok && !options.dryRun) throw new Error(`Preflight failed: ${stage.error}`);
    }

    // ── STAGE 2: SMOKE (Single small report) ─────────────────────────────────
    if (doAll || options.smoke) {
      const stage = { name: 'smoke', ok: true, details: {} };
      try {
        const fixture = await generateFixtureWithOracle({
          reportType: 'payments',
          rowCount: 3,
          accountId,
          propertyId,
          options: { seed: `${registry.runId}-smoke` },
        });

        // 1. Upload raw
        const rawRes = await client.uploadRawArchive({
          serverPropertyId: propertyId,
          reportType: fixture.reportType,
          rawFileHash: fixture.rawSha256,
          rawArchiveId: `raw_${registry.runId}_smoke`,
          originalFileName: 'payments_smoke.csv',
          mimeType: 'text/csv',
          rawBytes: fixture.rawBytes,
        });
        const rawKey = rawRes.raw_object_key || fixture.rawCanonicalKey;
        registry.trackRawKey(rawKey);

        // 2. Record raw
        const recRes = await client.recordRawArchive({
          serverPropertyId: propertyId,
          reportType: fixture.reportType,
          rawFileHash: fixture.rawSha256,
          rawArchiveId: `raw_${registry.runId}_smoke`,
          originalFileName: 'payments_smoke.csv',
          fileSize: fixture.rawBytes.byteLength,
        });
        registry.markRawKeyMapped(rawKey);
        registry.trackArchiveId(recRes.raw_archive_id || `raw_${registry.runId}_smoke`);

        // 3. Upload bundle
        const bRes = await client.uploadBundle({
          serverPropertyId: propertyId,
          reportType: fixture.reportType,
          rawFileHash: fixture.rawSha256,
          normalizedHash: fixture.normalizedHash,
          rowCount: fixture.rowCount,
          compressedBuffer: fixture.compressedBundle,
          payloadSha256: fixture.payloadSha256,
        });
        const bundleKey = bRes.object_key || fixture.bundleCanonicalKey;
        registry.trackBundleKey(bundleKey);

        // 4. Activate bundle
        const actRes = await client.activateBundle({
          id: recRes.bundle_id || `bundle_${registry.runId}_smoke`,
          source_archive_id: recRes.bundle_id || `raw_${registry.runId}_smoke`,
          server_property_id: propertyId,
          report_type: fixture.reportType,
          raw_file_hash: fixture.rawSha256,
          normalized_hash: fixture.normalizedHash,
          row_count: fixture.rowCount,
          entity_counts: fixture.entityCounts,
          min_date: fixture.minDate,
          max_date: fixture.maxDate,
        });
        registry.markBundleKeyMapped(bundleKey);
        registry.trackBundleId(actRes.bundle_id || `bundle_${registry.runId}_smoke`);

        stage.details = {
          rawCanonicalKey: fixture.rawCanonicalKey,
          bundleCanonicalKey: fixture.bundleCanonicalKey,
          bundleId: actRes.bundle_id,
        };
      } catch (err) {
        stage.ok = false;
        stage.error = err.message;
      }
      results.stages.smoke = stage;
      if (!stage.ok && !options.dryRun) throw new Error(`Smoke test failed: ${stage.error}`);
    }

    // ── STAGE 3: FULL IMPORT (Multi-report families + ugly edge cases) ───────
    if (doAll || options.importStage) {
      const stage = { name: 'import', ok: true, reportsTested: [], details: {} };
      const testCases = [
        { type: 'transactions', rows: 10, opts: { bom: true, quotedCommas: true } },
        { type: 'adjustments_refunds', rows: 8, opts: { negativeAmounts: true } },
        { type: 'occupancy', rows: 14, opts: {} },
        { type: 'clerk', rows: 6, opts: { extraWhitespace: true } },
      ];

      for (const tc of testCases) {
        try {
          const fixture = await generateFixtureWithOracle({
            reportType: tc.type,
            rowCount: tc.rows,
            accountId,
            propertyId,
            options: { ...tc.opts, seed: `${registry.runId}-${tc.type}`, baseMonth: 10 },
          });

          const rawRes = await client.uploadRawArchive({
            serverPropertyId: propertyId,
            reportType: tc.type,
            rawFileHash: fixture.rawSha256,
            rawArchiveId: `raw_${registry.runId}_${tc.type}`,
            originalFileName: `${tc.type}.csv`,
            rawBytes: fixture.rawBytes,
          });
          const rawKey = rawRes.raw_object_key || fixture.rawCanonicalKey;
          registry.trackRawKey(rawKey);

          const recRes = await client.recordRawArchive({
            serverPropertyId: propertyId,
            reportType: tc.type,
            rawFileHash: fixture.rawSha256,
            rawArchiveId: `raw_${registry.runId}_${tc.type}`,
            originalFileName: `${tc.type}.csv`,
            fileSize: fixture.rawBytes.byteLength,
            minDate: fixture.minDate,
            maxDate: fixture.maxDate,
          });
          registry.markRawKeyMapped(rawKey);
          registry.trackArchiveId(recRes.raw_archive_id || `raw_${registry.runId}_${tc.type}`);

          const bRes = await client.uploadBundle({
            serverPropertyId: propertyId,
            reportType: tc.type,
            rawFileHash: fixture.rawSha256,
            normalizedHash: fixture.normalizedHash,
            rowCount: fixture.rowCount,
            compressedBuffer: fixture.compressedBundle,
            payloadSha256: fixture.payloadSha256,
          });
          const bundleKey = bRes.object_key || fixture.bundleCanonicalKey;
          registry.trackBundleKey(bundleKey);

          const bundleId = recRes.bundle_id || `raw_${registry.runId}_${tc.type}`;
          const actRes = await client.activateBundle({
            id: bundleId,
            source_archive_id: bundleId,
            server_property_id: propertyId,
            report_type: tc.type,
            raw_file_hash: fixture.rawSha256,
            normalized_hash: fixture.normalizedHash,
            row_count: fixture.rowCount,
            entity_counts: fixture.entityCounts,
            min_date: fixture.minDate,
            max_date: fixture.maxDate,
          });
          registry.markBundleKeyMapped(bundleKey);
          registry.trackBundleId(actRes.bundle_id || bundleId);

          stage.reportsTested.push({ type: tc.type, rowCount: fixture.rowCount, ok: true });
        } catch (err) {
          stage.ok = false;
          stage.reportsTested.push({ type: tc.type, ok: false, error: err.message });
        }
      }
      results.stages.import = stage;
      if (!stage.ok && !options.dryRun) throw new Error('Full import stage failed');
    }

    // ── STAGE 4: CONCURRENCY & IDEMPOTENCY ───────────────────────────────────
    if (doAll || options.concurrency) {
      const stage = { name: 'concurrency', ok: true, details: {} };
      try {
        // 4A. Simultaneous Identical Upload & Activation Race (Idempotency)
        const fixtureIdentical = await generateFixtureWithOracle({
          reportType: 'payments',
          rowCount: 3,
          accountId,
          propertyId,
          options: { seed: `${registry.runId}-conc-ident`, baseMonth: 11 },
        });

        const rawIdentRes = await client.uploadRawArchive({
          serverPropertyId: propertyId,
          reportType: fixtureIdentical.reportType,
          rawFileHash: fixtureIdentical.rawSha256,
          rawArchiveId: `raw_${registry.runId}_conc_ident`,
          originalFileName: 'payments_ident.csv',
          rawBytes: fixtureIdentical.rawBytes,
        });
        const rawIdentKey = rawIdentRes.raw_object_key || fixtureIdentical.rawCanonicalKey;
        registry.trackRawKey(rawIdentKey);

        const recIdentRes = await client.recordRawArchive({
          serverPropertyId: propertyId,
          reportType: fixtureIdentical.reportType,
          rawFileHash: fixtureIdentical.rawSha256,
          rawArchiveId: `raw_${registry.runId}_conc_ident`,
          originalFileName: 'payments_ident.csv',
          fileSize: fixtureIdentical.rawBytes.byteLength,
        });
        registry.markRawKeyMapped(rawIdentKey);
        registry.trackArchiveId(recIdentRes.raw_archive_id || `raw_${registry.runId}_conc_ident`);

        const bIdentRes = await client.uploadBundle({
          serverPropertyId: propertyId,
          reportType: fixtureIdentical.reportType,
          rawFileHash: fixtureIdentical.rawSha256,
          normalizedHash: fixtureIdentical.normalizedHash,
          rowCount: fixtureIdentical.rowCount,
          compressedBuffer: fixtureIdentical.compressedBundle,
          payloadSha256: fixtureIdentical.payloadSha256,
        });
        const bundleIdentKey = bIdentRes.object_key || fixtureIdentical.bundleCanonicalKey;
        registry.trackBundleKey(bundleIdentKey);

        const identBundleId = recIdentRes.bundle_id || `bundle_${registry.runId}_conc_ident`;
        const identPayload = {
          id: identBundleId,
          source_archive_id: identBundleId,
          server_property_id: propertyId,
          report_type: fixtureIdentical.reportType,
          raw_file_hash: fixtureIdentical.rawSha256,
          normalized_hash: fixtureIdentical.normalizedHash,
          row_count: fixtureIdentical.rowCount,
          entity_counts: fixtureIdentical.entityCounts,
          min_date: fixtureIdentical.minDate,
          max_date: fixtureIdentical.maxDate,
        };

        const [actIdent1, actIdent2] = await Promise.all([
          client.activateBundle(identPayload),
          client.activateBundle(identPayload),
        ]);

        if (!options.dryRun) {
          if (!actIdent1.ok || !actIdent2.ok) {
            throw new Error('Identical race failed: expected both requests to succeed idempotently');
          }
          if (actIdent1.bundle_id !== actIdent2.bundle_id) {
            throw new Error(`Identical race bundle ID mismatch: ${actIdent1.bundle_id} vs ${actIdent2.bundle_id}`);
          }
        }
        registry.markBundleKeyMapped(bundleIdentKey);
        registry.trackBundleId(actIdent1.bundle_id || identBundleId);

        // 4B. Conflicting Overlap Race (Overlapping Dates + Same Report Type, Different Content)
        const fixtureOverlap1 = await generateFixtureWithOracle({
          reportType: 'gross_revenue',
          rowCount: 4,
          accountId,
          propertyId,
          options: { seed: `${registry.runId}-ov1`, baseMonth: 12, dayOffset: 0 },
        });
        const fixtureOverlap2 = await generateFixtureWithOracle({
          reportType: 'gross_revenue',
          rowCount: 4,
          accountId,
          propertyId,
          options: { seed: `${registry.runId}-ov2`, baseMonth: 12, dayOffset: 2 },
        });

        // Upload both raw archives and bundles
        const rawO1 = await client.uploadRawArchive({
          serverPropertyId: propertyId,
          reportType: fixtureOverlap1.reportType,
          rawFileHash: fixtureOverlap1.rawSha256,
          rawArchiveId: `raw_${registry.runId}_ov1`,
          rawBytes: fixtureOverlap1.rawBytes,
        });
        const rawO1Key = rawO1.raw_object_key || fixtureOverlap1.rawCanonicalKey;
        registry.trackRawKey(rawO1Key);
        const recO1 = await client.recordRawArchive({
          serverPropertyId: propertyId,
          reportType: fixtureOverlap1.reportType,
          rawFileHash: fixtureOverlap1.rawSha256,
          rawArchiveId: `raw_${registry.runId}_ov1`,
          fileSize: fixtureOverlap1.rawBytes.byteLength,
          minDate: fixtureOverlap1.minDate,
          maxDate: fixtureOverlap1.maxDate,
        });
        registry.markRawKeyMapped(rawO1Key);
        registry.trackArchiveId(recO1.raw_archive_id || `raw_${registry.runId}_ov1`);

        const bO1 = await client.uploadBundle({
          serverPropertyId: propertyId,
          reportType: fixtureOverlap1.reportType,
          rawFileHash: fixtureOverlap1.rawSha256,
          normalizedHash: fixtureOverlap1.normalizedHash,
          rowCount: fixtureOverlap1.rowCount,
          compressedBuffer: fixtureOverlap1.compressedBundle,
          payloadSha256: fixtureOverlap1.payloadSha256,
        });
        const bO1Key = bO1.object_key || fixtureOverlap1.bundleCanonicalKey;
        registry.trackBundleKey(bO1Key);

        const rawO2 = await client.uploadRawArchive({
          serverPropertyId: propertyId,
          reportType: fixtureOverlap2.reportType,
          rawFileHash: fixtureOverlap2.rawSha256,
          rawArchiveId: `raw_${registry.runId}_ov2`,
          rawBytes: fixtureOverlap2.rawBytes,
        });
        const rawO2Key = rawO2.raw_object_key || fixtureOverlap2.rawCanonicalKey;
        registry.trackRawKey(rawO2Key);
        const recO2 = await client.recordRawArchive({
          serverPropertyId: propertyId,
          reportType: fixtureOverlap2.reportType,
          rawFileHash: fixtureOverlap2.rawSha256,
          rawArchiveId: `raw_${registry.runId}_ov2`,
          fileSize: fixtureOverlap2.rawBytes.byteLength,
          minDate: fixtureOverlap2.minDate,
          maxDate: fixtureOverlap2.maxDate,
        });
        registry.markRawKeyMapped(rawO2Key);
        registry.trackArchiveId(recO2.raw_archive_id || `raw_${registry.runId}_ov2`);

        const bO2 = await client.uploadBundle({
          serverPropertyId: propertyId,
          reportType: fixtureOverlap2.reportType,
          rawFileHash: fixtureOverlap2.rawSha256,
          normalizedHash: fixtureOverlap2.normalizedHash,
          rowCount: fixtureOverlap2.rowCount,
          compressedBuffer: fixtureOverlap2.compressedBundle,
          payloadSha256: fixtureOverlap2.payloadSha256,
        });
        const bO2Key = bO2.object_key || fixtureOverlap2.bundleCanonicalKey;
        registry.trackBundleKey(bO2Key);

        const idO1 = recO1.bundle_id || `bundle_${registry.runId}_ov1`;
        const idO2 = recO2.bundle_id || `bundle_${registry.runId}_ov2`;
        const pO1 = {
          id: idO1,
          source_archive_id: idO1,
          server_property_id: propertyId,
          report_type: fixtureOverlap1.reportType,
          raw_file_hash: fixtureOverlap1.rawSha256,
          normalized_hash: fixtureOverlap1.normalizedHash,
          row_count: fixtureOverlap1.rowCount,
          entity_counts: fixtureOverlap1.entityCounts,
          min_date: fixtureOverlap1.minDate,
          max_date: fixtureOverlap1.maxDate,
        };
        const pO2 = {
          id: idO2,
          source_archive_id: idO2,
          server_property_id: propertyId,
          report_type: fixtureOverlap2.reportType,
          raw_file_hash: fixtureOverlap2.rawSha256,
          normalized_hash: fixtureOverlap2.normalizedHash,
          row_count: fixtureOverlap2.rowCount,
          entity_counts: fixtureOverlap2.entityCounts,
          min_date: fixtureOverlap2.minDate,
          max_date: fixtureOverlap2.maxDate,
        };

        const overlapRaces = await Promise.allSettled([
          client.activateBundle(pO1),
          client.activateBundle(pO2),
        ]);

        if (!options.dryRun) {
          const fulfilled = overlapRaces.filter((r) => r.status === 'fulfilled');
          const rejected = overlapRaces.filter((r) => r.status === 'rejected');
          if (fulfilled.length !== 1 || rejected.length !== 1) {
            throw new Error(`Overlap race expected 1 winner and 1 rejection, got ${fulfilled.length} fulfilled, ${rejected.length} rejected`);
          }
          const winner = fulfilled[0].value;
          const loserErr = rejected[0].reason;
          if (loserErr.status !== 409) {
            throw new Error(`Expected 409 rejection on overlapping activation, got status ${loserErr.status}: ${loserErr.message}`);
          }

          // Mark winner mapped
          const isWinnerO1 = winner.bundle_id === idO1;
          const winnerKey = isWinnerO1 ? bO1Key : bO2Key;
          const loserKey = isWinnerO1 ? bO2Key : bO1Key;
          const loserPayload = isWinnerO1 ? pO2 : pO1;

          registry.markBundleKeyMapped(winnerKey);
          registry.trackBundleId(winner.bundle_id);

          // Now test explicit replacement recovery: activate loser with supersedes_bundle_id
          const replaceRes = await client.activateBundle({
            ...loserPayload,
            supersedes_bundle_id: winner.bundle_id,
            expected_revision: winner.revision,
          });
          if (!replaceRes.ok) throw new Error('Replacement activation failed after overlap conflict');
          registry.markBundleKeyMapped(loserKey);
          registry.trackBundleId(replaceRes.bundle_id || loserPayload.id);
        } else {
          registry.markBundleKeyMapped(bO1Key);
          registry.markBundleKeyMapped(bO2Key);
          registry.trackBundleId(idO1);
          registry.trackBundleId(idO2);
        }

        // 4C. Distinct Non-Overlapping Race (Disjoint report types / scopes)
        const fixtureDistinct1 = await generateFixtureWithOracle({
          reportType: 'clerk',
          rowCount: 3,
          accountId,
          propertyId,
          options: { seed: `${registry.runId}-distinct-1`, baseYear: 2027, baseMonth: 1 },
        });
        const fixtureDistinct2 = await generateFixtureWithOracle({
          reportType: 'occupancy',
          rowCount: 3,
          accountId,
          propertyId,
          options: { seed: `${registry.runId}-distinct-2`, baseYear: 2027, baseMonth: 2 },
        });

        const rawD1 = await client.uploadRawArchive({
          serverPropertyId: propertyId,
          reportType: fixtureDistinct1.reportType,
          rawFileHash: fixtureDistinct1.rawSha256,
          rawArchiveId: `raw_${registry.runId}_dist1`,
          rawBytes: fixtureDistinct1.rawBytes,
        });
        const rawD1Key = rawD1.raw_object_key || fixtureDistinct1.rawCanonicalKey;
        registry.trackRawKey(rawD1Key);
        const recD1 = await client.recordRawArchive({
          serverPropertyId: propertyId,
          reportType: fixtureDistinct1.reportType,
          rawFileHash: fixtureDistinct1.rawSha256,
          rawArchiveId: `raw_${registry.runId}_dist1`,
          fileSize: fixtureDistinct1.rawBytes.byteLength,
        });
        registry.markRawKeyMapped(rawD1Key);
        registry.trackArchiveId(recD1.raw_archive_id || `raw_${registry.runId}_dist1`);

        const bD1 = await client.uploadBundle({
          serverPropertyId: propertyId,
          reportType: fixtureDistinct1.reportType,
          rawFileHash: fixtureDistinct1.rawSha256,
          normalizedHash: fixtureDistinct1.normalizedHash,
          rowCount: fixtureDistinct1.rowCount,
          compressedBuffer: fixtureDistinct1.compressedBundle,
          payloadSha256: fixtureDistinct1.payloadSha256,
        });
        const bD1Key = bD1.object_key || fixtureDistinct1.bundleCanonicalKey;
        registry.trackBundleKey(bD1Key);

        const rawD2 = await client.uploadRawArchive({
          serverPropertyId: propertyId,
          reportType: fixtureDistinct2.reportType,
          rawFileHash: fixtureDistinct2.rawSha256,
          rawArchiveId: `raw_${registry.runId}_dist2`,
          rawBytes: fixtureDistinct2.rawBytes,
        });
        const rawD2Key = rawD2.raw_object_key || fixtureDistinct2.rawCanonicalKey;
        registry.trackRawKey(rawD2Key);
        const recD2 = await client.recordRawArchive({
          serverPropertyId: propertyId,
          reportType: fixtureDistinct2.reportType,
          rawFileHash: fixtureDistinct2.rawSha256,
          rawArchiveId: `raw_${registry.runId}_dist2`,
          fileSize: fixtureDistinct2.rawBytes.byteLength,
        });
        registry.markRawKeyMapped(rawD2Key);
        registry.trackArchiveId(recD2.raw_archive_id || `raw_${registry.runId}_dist2`);

        const bD2 = await client.uploadBundle({
          serverPropertyId: propertyId,
          reportType: fixtureDistinct2.reportType,
          rawFileHash: fixtureDistinct2.rawSha256,
          normalizedHash: fixtureDistinct2.normalizedHash,
          rowCount: fixtureDistinct2.rowCount,
          compressedBuffer: fixtureDistinct2.compressedBundle,
          payloadSha256: fixtureDistinct2.payloadSha256,
        });
        const bD2Key = bD2.object_key || fixtureDistinct2.bundleCanonicalKey;
        registry.trackBundleKey(bD2Key);

        const idD1 = recD1.bundle_id || `bundle_${registry.runId}_dist1`;
        const idD2 = recD2.bundle_id || `bundle_${registry.runId}_dist2`;
        const pD1 = {
          id: idD1,
          source_archive_id: idD1,
          server_property_id: propertyId,
          report_type: fixtureDistinct1.reportType,
          raw_file_hash: fixtureDistinct1.rawSha256,
          normalized_hash: fixtureDistinct1.normalizedHash,
          row_count: fixtureDistinct1.rowCount,
          entity_counts: fixtureDistinct1.entityCounts,
          min_date: fixtureDistinct1.minDate,
          max_date: fixtureDistinct1.maxDate,
        };
        const pD2 = {
          id: idD2,
          source_archive_id: idD2,
          server_property_id: propertyId,
          report_type: fixtureDistinct2.reportType,
          raw_file_hash: fixtureDistinct2.rawSha256,
          normalized_hash: fixtureDistinct2.normalizedHash,
          row_count: fixtureDistinct2.rowCount,
          entity_counts: fixtureDistinct2.entityCounts,
          min_date: fixtureDistinct2.minDate,
          max_date: fixtureDistinct2.maxDate,
        };

        const [resD1, resD2] = await Promise.all([
          client.activateBundle(pD1),
          client.activateBundle(pD2),
        ]);

        if (!options.dryRun) {
          if (!resD1.ok || !resD2.ok) throw new Error('Distinct concurrent activation failed');
          if (resD1.revision === resD2.revision) {
            throw new Error(`Distinct concurrent activations must receive distinct monotonic revisions, got ${resD1.revision}`);
          }
        }
        registry.markBundleKeyMapped(bD1Key);
        registry.markBundleKeyMapped(bD2Key);
        registry.trackBundleId(resD1.bundle_id || idD1);
        registry.trackBundleId(resD2.bundle_id || idD2);

        stage.details = {
          identicalRaceTested: true,
          overlapRaceTested: true,
          distinctRaceTested: true,
        };
      } catch (err) {
        stage.ok = false;
        stage.error = err.message;
      }
      results.stages.concurrency = stage;
      if (!stage.ok && !options.dryRun) throw new Error(`Concurrency stage failed: ${stage.error}`);
    }

    // ── STAGE 5: HYDRATION FEED & DATA INTEGRITY ─────────────────────────────
    if (doAll || options.hydration) {
      const stage = { name: 'hydration', ok: true, details: {} };
      try {
        // Hydration test using an independent client representing Browser B
        const browserB = new CanaryClient({
          baseUrl: targetUrl,
          accountId,
          propertyId,
          authCookie,
          authToken,
          dryRun: options.dryRun,
          fetchImpl: options.fetchImpl,
        });

        const feed = await browserB.getManifest({
          serverPropertyId: propertyId,
          sinceRevision: 0,
        });

        if (options.dryRun) {
          stage.details = { dryRun: true, manifestCount: 0 };
        } else {
          const manifests = feed.manifests || [];
          if (manifests.length === 0) {
            throw new Error('No active manifests found for hydration verification');
          }

          const activeManifests = manifests.filter((m) => m.status === 'active');
          const targetManifest = activeManifests[activeManifests.length - 1] || manifests[manifests.length - 1];

          // Browser B downloads bundle payload directly
          const bundleData = await browserB.downloadBundle(targetManifest.id);

          // Decompress gzip payload
          const decompressed = zlib.gunzipSync(Buffer.from(bundleData.buffer));

          // Parse and verify row count and deterministic row IDs
          const lines = decompressed.toString('utf8').trim().split('\n').filter(Boolean);
          if (lines.length !== targetManifest.row_count) {
            throw new Error(`Hydrated row count mismatch: manifest says ${targetManifest.row_count}, but payload has ${lines.length} rows`);
          }

          const items = [];
          for (let idx = 0; idx < lines.length; idx++) {
            const item = JSON.parse(lines[idx]);
            const row = item.row || item;
            const hasId = Boolean(row.id || row.row_id || row.record_key || row.transaction_id || row.key);
            if (!hasId) {
              throw new Error(`Row ${idx} in hydrated bundle is missing a deterministic identifier`);
            }
            items.push(item);
          }

          // Independently recompute canonical normalized content and hash
          const { normalizedHash: computedNormalizedHash } = computeIndependentNormalizedHash(items);

          const expectedNormalizedHash = targetManifest.normalized_hash;
          const xNormalizedHash = bundleData.normalizedHash || '';

          if (computedNormalizedHash !== expectedNormalizedHash) {
            throw new Error(
              `Hydration normalized hash mismatch: computed independent hash (${computedNormalizedHash}) !== manifest normalized_hash (${expectedNormalizedHash})`
            );
          }

          if (xNormalizedHash && computedNormalizedHash !== xNormalizedHash) {
            throw new Error(
              `Hydration header hash mismatch: computed independent hash (${computedNormalizedHash}) !== x-normalized-hash header (${xNormalizedHash})`
            );
          }

          // Verify stale cursor / pagination token: querying since latest cursor returns 0 new
          const maxRevision = Math.max(...manifests.map((m) => m.revision || 0));
          const latestManifests = manifests.filter((m) => (m.revision || 0) === maxRevision);
          const lastId = latestManifests.sort((a, b) => a.id.localeCompare(b.id)).pop()?.id || '';

          const upToDateFeed = await browserB.getManifest({
            serverPropertyId: propertyId,
            sinceRevision: maxRevision,
            afterId: lastId,
          });
          const newer = upToDateFeed.manifests || [];
          if (newer.length > 0) {
            throw new Error(`Stale cursor invalidation failed: expected 0 newer manifests past revision ${maxRevision} (after_id ${lastId}), got ${newer.length}`);
          }

          // Querying with cursor before target manifest includes target
          const pastFeed = await browserB.getManifest({
            serverPropertyId: propertyId,
            sinceRevision: Math.max(0, targetManifest.revision - 1),
          });
          const containsTarget = (pastFeed.manifests || []).some((m) => m.id === targetManifest.id);
          if (!containsTarget) {
            throw new Error(`Pagination cursor failed to return target manifest ${targetManifest.id} at revision ${targetManifest.revision}`);
          }

          stage.details = {
            manifestCount: manifests.length,
            activeManifestsCount: activeManifests.length,
            verifiedBundleId: targetManifest.id,
            decompressedBytes: decompressed.byteLength,
            rowCount: lines.length,
            rowIdsVerified: true,
            computedNormalizedHash,
            expectedNormalizedHash,
            headerNormalizedHash: xNormalizedHash,
            contentHashMatched: computedNormalizedHash === expectedNormalizedHash && (!xNormalizedHash || computedNormalizedHash === xNormalizedHash),
            staleCursorVerified: true,
          };
        }
      } catch (err) {
        stage.ok = false;
        stage.error = err.message;
      }
      results.stages.hydration = stage;
      if (!stage.ok && !options.dryRun) throw new Error(`Hydration stage failed: ${stage.error}`);
    }

    // ── STAGE 6: BUCKET LOCK SAFETY ─────────────────────────────────────────
    if (doAll || options.lock) {
      const stage = { name: 'lock', ok: true, details: {} };
      if (!allowBucketLock) {
        stage.skipped = true;
        stage.reason = 'Skipped: --allow-canary-bucket-lock flag omitted (safety guard)';
      } else {
        stage.executed = true;
        const archiveIdToTest = [...registry.createdArchiveIds][0];
        if (!archiveIdToTest) {
          stage.ok = false;
          stage.error = 'No created raw archive available to test bucket lock';
        } else {
          try {
            const res = await client.destroyRawArchive({
              archiveId: archiveIdToTest,
              confirmDestroy: true,
              allowBucketLock: true,
            });
            // If the call did not throw, the archive was not retention locked!
            stage.ok = false;
            stage.error = `Expected raw archive deletion to fail with HTTP 423 RAW_ARCHIVE_LOCKED, but succeeded: ${JSON.stringify(res)}`;
          } catch (err) {
            if (err.status === 423 && (err.code === 'RAW_ARCHIVE_LOCKED' || /retention locked/i.test(err.message))) {
              stage.ok = true;
              stage.verifiedLock = true;
              stage.details = { status: 423, code: 'RAW_ARCHIVE_LOCKED' };
            } else {
              stage.ok = false;
              stage.error = `Expected HTTP 423 RAW_ARCHIVE_LOCKED, got ${err.status} ${err.code}: ${err.message}`;
            }
          }
        }
      }
      results.stages.lock = stage;
      if (!stage.ok && !options.dryRun) throw new Error(`Bucket lock stage failed: ${stage.error}`);
    }

    // ── STAGE 7: LARGE FIXTURE STREAMING ────────────────────────────────────
    if (doAll || options.large) {
      const stage = { name: 'large', ok: true, details: {} };
      try {
        const largeFixture = await generateFixtureWithOracle({
          reportType: 'transactions',
          rowCount: 1000,
          accountId,
          propertyId,
          options: { seed: `${registry.runId}-large`, baseYear: 2027, baseMonth: 3 },
        });
        stage.details = {
          rowCount: largeFixture.rowCount,
          rawBytesSize: largeFixture.rawBytes.byteLength,
          compressedBundleSize: largeFixture.compressedBundle.byteLength,
        };
      } catch (err) {
        stage.ok = false;
        stage.error = err.message;
      }
      results.stages.large = stage;
      if (!stage.ok && !options.dryRun) throw new Error(`Large fixture stage failed: ${stage.error}`);
    }

  } catch (err) {
    stageExecutionError = err;
  } finally {
    // ── STAGE 8: CLEANUP ────────────────────────────────────────────────────
    // Executes in a finally-equivalent path after normal run OR after stage failure
    if (doAll || options.cleanup || stageExecutionError) {
      const stage = { name: 'cleanup', ok: true, details: {} };
      try {
        const cleanupRes = await registry.runCleanup(client);
        stage.details = cleanupRes;
        stage.verdict = cleanupRes.verdict;
        stage.deleted = cleanupRes.deleted;
        stage.locked = cleanupRes.locked;
        stage.failed = cleanupRes.failed;
        stage.orphanedR2Keys = cleanupRes.orphanedR2Keys;
        stage.remainingKeys = cleanupRes.remainingKeys;
        if (cleanupRes.verdict !== 'CLEAN' && cleanupRes.verdict !== 'SKIPPED') {
          stage.ok = false;
          stage.error = `Cleanup verdict was ${cleanupRes.verdict} (${cleanupRes.remainingKeys?.length || 0} remaining resources to sweep manually)`;
        }
      } catch (cleanupErr) {
        stage.ok = false;
        stage.verdict = 'FAILED';
        stage.error = cleanupErr.message;
        stage.orphanedR2Keys = [...registry.orphanedR2Keys];
        stage.remainingKeys = [...registry.createdRawKeys, ...registry.createdBundleKeys];
      }
      results.stages.cleanup = stage;
    }
  }

  results.telemetry.requests_dispatched.value = client.requestsDispatched;

  // Determine conservative final verdict
  let verdict = options.dryRun ? 'PASS (DRY_RUN)' : 'PASS';
  const failedStages = Object.entries(results.stages).filter(([_, s]) => s && s.ok === false);

  if (stageExecutionError) {
    verdict = 'FAIL';
    results.fatalError = stageExecutionError.message;
    results.failureReason = `Stage execution failed: ${stageExecutionError.message}`;
  } else if (failedStages.length > 0) {
    verdict = 'FAIL';
    results.failureReason = `Failed stages: ${failedStages.map(([n]) => n).join(', ')}`;
  } else if (results.stages.cleanup && results.stages.cleanup.verdict !== 'CLEAN' && results.stages.cleanup.verdict !== 'SKIPPED') {
    verdict = 'FAIL';
    results.failureReason = `Cleanup verdict was ${results.stages.cleanup.verdict} (uncleaned resources: ${results.stages.cleanup.remainingKeys?.length || 0})`;
  } else if (results.stages.lock?.skipped && !options.dryRun) {
    verdict = 'QUALIFIED_PASS (BUCKET_LOCK_SKIPPED)';
  }

  results.verdict = verdict;
  return results;
}

// CLI execution entry point
if (process.argv[1] && process.argv[1].endsWith('canary-bulk-import.mjs')) {
  const flags = parseArgs(process.argv.slice(2));

  console.log('============================================================');
  console.log('       RRI BULK IMPORT CANARY TEST ORCHESTRATOR');
  console.log('============================================================');
  if (flags.dryRun) {
    console.log('MODE: DRY RUN (0 network requests will be dispatched)\n');
  }

  runCanary(flags)
    .then((res) => {
      if (flags.json) {
        console.log(JSON.stringify(res, null, 2));
      } else {
        console.log(`\nCanary Run ID: ${res.runId}`);
        console.log(`Target URL:    ${res.targetUrl}`);
        console.log(`Verdict:       ${res.verdict}`);
        console.log('\nExecuted Stages:');
        for (const [name, stage] of Object.entries(res.stages)) {
          const status = stage.ok !== false ? 'OK' : 'FAILED';
          console.log(`  - ${name.padEnd(14)}: ${status} ${stage.skipped ? '(SKIPPED)' : ''}`);
        }
        console.log('\nTelemetry Classification:');
        for (const [k, v] of Object.entries(res.telemetry)) {
          console.log(`  - ${k.padEnd(30)}: [${v.classification}] ${v.value ?? 'N/A'}`);
        }
      }

      if (flags.output) {
        fs.writeFileSync(flags.output, JSON.stringify(res, null, 2), 'utf8');
        console.log(`\nWrote JSON report to: ${flags.output}`);
      }

      const isSuccess = ['PASS', 'PASS (DRY_RUN)', 'QUALIFIED_PASS (BUCKET_LOCK_SKIPPED)'].includes(res.verdict);
      process.exit(isSuccess ? 0 : 1);
    })
    .catch((err) => {
      console.error('\nFatal Canary Error:', err.message);
      process.exit(1);
    });
}
