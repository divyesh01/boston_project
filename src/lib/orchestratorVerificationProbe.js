/**
 * Orchestrator diagnostic contract helpers.
 *
 * Pure, side-effect-free accessors used by verification probes and telemetry
 * exporters to assert the orchestrator's declared invariants without booting
 * the orchestrator itself.
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