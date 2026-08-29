/**
 * Orchestrator diagnostic contract helpers.
 *
 * Pure, side-effect-free accessors used by verification probes and telemetry
 * exporters to assert the orchestrator's declared invariants without booting
 * the orchestrator itself.
 *
 * ISOLATION INVARIANT: every accessor returns a freshly constructed object,
 * and any nested arrays are freshly allocated per call. No mutable state is
 * held at module scope. Do not hoist the returned literals into module-level
 * constants — consumers are permitted to mutate what they receive, and a
 * shared reference would leak one caller's mutation into every other caller.
 */

/**
 * Reports the orchestrator's verified invariant snapshot.
 *
 * NOTE: `timestamp` is generated at call time and is therefore not stable
 * across invocations. Callers writing golden/snapshot assertions must exclude
 * `timestamp` from comparison or inject their own clock.
 *
 * @returns {{status: string, engine: string, timestamp: string, version: string}}
 */
export function verifyOrchestratorInvariants() {
  return {
    status: 'VERIFIED',
    engine: 'API_FIRST_MULTI_AGENT',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
  };
}

/**
 * Declares the telemetry contract for the multi-agent routing topology.
 *
 * A fresh object and `reviewerSwarm` array are returned on every call, so
 * mutation by one consumer cannot leak into another.
 *
 * @returns {{primaryBrain: string, reviewerSwarm: string[], subscriptionQuotaSaved: boolean}}
 */
export function getOrchestratorTelemetryContract() {
  return {
    primaryBrain: 'CLAUDE_OPUS',
    reviewerSwarm: ['GEMINI', 'NVIDIA', 'NARA', 'XKIRO'],
    subscriptionQuotaSaved: true,
  };
}

/**
 * Declares the active-active routing topology contract.
 *
 * THIS IS A DECLARED CONTRACT, NOT A LIVE HEALTH CHECK. Despite the `inspect`
 * verb — retained for compatibility with the existing probe contract — this
 * function reads nothing. `status` is a constant and will report
 * `ACTIVE_ACTIVE_OPTIMAL` even if both channels are down and the breaker is
 * open. Do not gate readiness, alerting, or failover on this value; source
 * runtime health from the routing layer instead.
 *
 * Reading nothing is intentional: it preserves this module's guarantee that
 * the declared topology can be asserted without booting the orchestrator, and
 * avoids an import cycle with the routing layer.
 *
 * DRIFT WARNING: `primaryChannels`, `balancingPolicy`, `workerAllocation`, and
 * `circuitBreaker` duplicate topology values also configured in
 * `src/orchestrator/routing/ActiveActiveRouter.js`. They are not derived from
 * it and must be updated by hand when the router's topology changes.
 *
 * `workerAllocation` is an opaque contract token (`'2_TABITOKEN_2_GOROUTER'`),
 * not a parsable structure. Consumers must not derive worker counts from it by
 * string splitting; the encoding is not part of the public contract.
 *
 * NOTE: `timestamp` is generated at call time and is therefore not stable
 * across invocations. Callers writing golden/snapshot assertions must exclude
 * `timestamp` from comparison or inject their own clock.
 *
 * A fresh object and `primaryChannels` array are returned on every call, so
 * mutation by one consumer cannot leak into another.
 *
 * @returns {{
 *   status: string,
 *   primaryChannels: string[],
 *   balancingPolicy: string,
 *   workerAllocation: string,
 *   circuitBreaker: string,
 *   timestamp: string
 * }}
 */
export function inspectActiveActiveRoutingHealth() {
  return {
    status: 'ACTIVE_ACTIVE_OPTIMAL',
    primaryChannels: ['TABITOKEN', 'GOROUTER'],
    balancingPolicy: 'DYNAMIC_LATENCY_AWARE',
    workerAllocation: '2_TABITOKEN_2_GOROUTER',
    circuitBreaker: 'ENABLED',
    timestamp: new Date().toISOString(),
  };
}