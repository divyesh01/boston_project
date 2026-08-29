#!/usr/bin/env node
/**
 * Provider Probe & Telemetry Matrix
 * ---------------------------------
 * Probes all configured providers and accounts, measuring health, latency,
 * and key status without ever exposing secrets.
 */

import { defaultRegistry } from '../../src/orchestrator/index.js';

async function main() {
  console.log('================================================================================');
  console.log('API-FIRST MULTI-AGENT ORCHESTRATOR — PROVIDER HEALTH & TELEMETRY MATRIX');
  console.log('================================================================================\n');

  const status = defaultRegistry.getProviderStatus();
  console.log('Configured Provider Status:');
  console.table(Object.entries(status).map(([name, s]) => ({
    Provider: name,
    'Key Configured': s.keyConfigured ? 'YES ✅' : 'NO ❌',
    'Key Preview': s.keyMasked,
  })));

  console.log('\nProbing Live Provider Endpoints (with strict 8s timeout)...');
  const probeResults = [];

  for (const [name, adapter] of defaultRegistry.adapters.entries()) {
    process.stdout.write(`[*] Probing ${name}... `);
    const probe = await adapter.probeHealth();
    if (probe.healthy) {
      console.log(`[+] HEALTHY (${probe.latencyMs}ms)`);
    } else {
      console.log(`[-] ${probe.status} (${probe.error})`);
    }
    probeResults.push({
      Provider: name,
      Status: probe.healthy ? 'HEALTHY ✅' : `${probe.status} ❌`,
      'Latency (ms)': probe.latencyMs,
      Notes: probe.error || 'Endpoint reachable',
    });
  }

  console.log('\nLive Health Matrix:');
  console.table(probeResults);
  console.log('================================================================================\n');
}

main().catch((err) => {
  console.error('Fatal probe error:', err);
  process.exit(1);
});
