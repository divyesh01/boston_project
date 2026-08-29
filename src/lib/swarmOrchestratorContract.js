/**
 * swarmOrchestratorContract.js
 *
 * Single authoritative declaration of the swarm orchestrator's public contract:
 * version identity, active-active provider topology, operating invariants, and
 * live worker capabilities.
 *
 * ISOLATION CONTRACT
 * ------------------
 * - Leaf module: zero imports, zero I/O, zero environment reads, zero side
 *   effects at import time. Safe to import from the orchestrator core, the
 *   verification probe, ledger writers, CLI probe scripts, Node tests, and
 *   browser bundles without initialization-order hazards or import cycles.
 * - No module-level mutable state. Every accessor allocates a fresh object and
 *   fresh arrays on each call, so a consumer that sorts, pushes to, or
 *   otherwise mutates a returned value cannot corrupt any other consumer's
 *   view. There is no shared canonical reference to protect, which is why this
 *   module deliberately does NOT use Object.freeze indirection: the declared
 *   values sit inline where a reader can see them.
 * - No environment reads by design. An invariant that varies by environment is
 *   not an invariant.
 *
 * ERROR CONTRACT
 * --------------
 * None of these functions throw, perform I/O, or return null/undefined.
 * Callers need no try/catch or error-boundary coverage.
 *
 * Note on the wall clock: `getSwarmOrchestratorVersion()` calls
 * `new Date().toISOString()` directly and does NOT swallow clock faults. A
 * zero-argument `new Date()` yields a valid Date under jest/vitest/sinon fake
 * timers, so the RangeError path is unreachable in practice. More importantly,
 * this value is written into forensic evidence: substituting a fabricated
 * fallback timestamp would turn a loud clock fault into a plausible-looking
 * false record. Fail loud rather than fabricate.
 *
 * DETERMINISM CONTRACT
 * --------------------
 * `getActiveActiveProviderTopology()`, `verifySwarmInvariants()`, and
 * `getLiveWorkerCapabilities()` are pure and deterministic, with fixed key
 * order, and are safe to serialize into a SHA-256 evidence digest directly.
 *
 * `getSwarmOrchestratorVersion()` is the ONE impure accessor: its `timestamp`
 * field is wall-clock and changes on every call. Any content-addressed hash,
 * ledger key, snapshot, or golden-file assertion MUST exclude `timestamp` and
 * assert on `version` / `architecture` / `status` instead. Hashing the whole
 * object produces a digest that can never be reproduced.
 *
 * SEMANTIC CONTRACT
 * -----------------
 * These are declarative reporters, not enforcers. `verifySwarmInvariants()` is
 * named as a verb but returns a manifest: it reports the invariants the swarm
 * is contracted to uphold. It does not read quotas, inspect file permissions,
 * or validate hashes, and it cannot fail. A truthy `protectedFilesLocked` is
 * NOT evidence that files are locked on disk, and the returned envelope is
 * always truthy, so it must never be used as a boolean gate.
 *
 * Runtime enforcement belongs in the probe/enforcement layer
 * (`src/lib/orchestratorVerificationProbe.js`, `src/orchestrator/`), which
 * should import these values as the EXPECTED state, measure the observed state,
 * compare, and fail closed on divergence. The shape and values returned here
 * must stay stable so that comparison has a fixed reference point.
 *
 * @module lib/swarmOrchestratorContract
 */

/**
 * Reports the swarm orchestrator's version and architecture identity.
 *
 * `timestamp` records the moment of interrogation, not the build or release
 * time. It is the only non-deterministic field in this module; exclude it from
 * every digest and snapshot (see DETERMINISM CONTRACT above).
 *
 * @returns {{
 *   version: string,
 *   architecture: string,
 *   status: string,
 *   timestamp: string
 * }} Freshly constructed version descriptor. `timestamp` is ISO-8601 UTC and
 *    is NOT stable across invocations.
 */
export function getSwarmOrchestratorVersion() {
  return {
    version: '2.0.0',
    architecture: 'ACTIVE_ACTIVE_HIGH_PARALLELISM_SWARM',
    status: 'PRODUCTION_READY',
    timestamp: new Date().toISOString(),
  };
}

/**
 * Reports the active-active provider topology.
 *
 * `primaryBrain` is the authoritative synthesis authority and is never balanced
 * away. The `activeActiveProviders` entries run CONCURRENTLY and are not a
 * primary/standby failover chain: both carry live traffic, apportioned by
 * `balancingPolicy`. Ordering within `activeActiveProviders` carries no
 * priority or preference semantics.
 *
 * Pure and deterministic. Safe to hash. The returned array is a fresh copy and
 * may be mutated freely.
 *
 * @returns {{
 *   primaryBrain: string,
 *   activeActiveProviders: string[],
 *   mode: string,
 *   balancingPolicy: string
 * }} Freshly constructed topology descriptor.
 */
export function getActiveActiveProviderTopology() {
  return {
    primaryBrain: 'CLAUDE_OPUS',
    activeActiveProviders: ['TABITOKEN', 'GOROUTER'],
    mode: 'ACTIVE_ACTIVE_CONCURRENT',
    balancingPolicy: 'DYNAMIC_HEALTH_AND_WORKLOAD_BALANCED',
  };
}

/**
 * Reports the declared operating invariants of the swarm.
 *
 *  - `codexQuotaUsage`            Codex quota is conserved, not consumed.
 *  - `antigravityAuthoring`       Antigravity is external-API-only; it must
 *                                 never author files.
 *  - `sha256VerificationRequired` Artifacts require content-hash verification
 *                                 before acceptance.
 *  - `protectedFilesLocked`       Protected paths are contracted as immutable
 *                                 against autonomous modification.
 *  - `qualityOverCost`            Routing optimizes for output quality, never
 *                                 for lowest token spend.
 *
 * DECLARATION, NOT AUDIT. This function performs no measurement and cannot
 * fail; the envelope it returns is always truthy. Do not use it as a pass/fail
 * gate and do not read its fields as proof of runtime state — see SEMANTIC
 * CONTRACT in the module header.
 *
 * Pure and deterministic. Safe to hash.
 *
 * @returns {{
 *   codexQuotaUsage: string,
 *   antigravityAuthoring: string,
 *   sha256VerificationRequired: boolean,
 *   protectedFilesLocked: boolean,
 *   qualityOverCost: boolean
 * }} Freshly constructed invariant manifest.
 */
export function verifySwarmInvariants() {
  return {
    codexQuotaUsage: '0% (CONSERVED)',
    antigravityAuthoring: 'BLOCKED (EXTERNAL API ONLY)',
    sha256VerificationRequired: true,
    protectedFilesLocked: true,
    qualityOverCost: true,
  };
}

/**
 * Reports live worker capabilities: the ordered execution waves, the full set
 * of providers reachable by workers, and the concurrency primitive used to fan
 * out work within a wave.
 *
 * `waves` is ordered and that order is semantically load-bearing: parallel
 * authoring (A) precedes specialist review (B), which precedes authoritative
 * synthesis (C). Each wave consumes the prior wave's output, so waves execute
 * sequentially even though fan-out within a wave is concurrent. Callers that
 * schedule work must preserve this sequence.
 *
 * `activeProviders` is a SUPERSET of
 * `getActiveActiveProviderTopology().activeActiveProviders`: it additionally
 * includes the review participant `NARA` and the terminal
 * `LOCAL_DETERMINISTIC` fallback, which must remain last so that degraded runs
 * still produce a reproducible artifact when every external provider is
 * unavailable. The two lists are not interchangeable. The superset relationship
 * is asserted in tests/orchestrator/swarmOrchestratorContract.test.js — adding
 * a provider to the topology without adding it here is a test failure, not a
 * silent divergence.
 *
 * `ASYNC_PROMISE_ALL_BOUNDED` means fan-out is `Promise.all`-shaped but capped
 * by a concurrency bound; callers must not assume unbounded parallelism.
 *
 * Pure and deterministic. Safe to hash. Both arrays are fresh copies and may be
 * mutated freely.
 *
 * @returns {{
 *   waves: string[],
 *   activeProviders: string[],
 *   concurrencyModel: string
 * }} Freshly constructed capability descriptor.
 */
export function getLiveWorkerCapabilities() {
  return {
    waves: [
      'WAVE_A_PARALLEL_CLAUDE_OPUS',
      'WAVE_B_SPECIALIST_REVIEWER_SWARM',
      'WAVE_C_AUTHORITATIVE_SYNTHESIS',
    ],
    activeProviders: ['TABITOKEN', 'GOROUTER', 'NARA', 'LOCAL_DETERMINISTIC'],
    concurrencyModel: 'ASYNC_PROMISE_ALL_BOUNDED',
  };
}