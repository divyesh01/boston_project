/**
 * BaseProviderAdapter
 * -------------------
 * Abstract base class for all AI provider adapters in the orchestrator.
 * Standardizes outbound requests, timeout handling, and telemetry normalization.
 */

export class BaseProviderAdapter {
  constructor(config = {}) {
    this.name = config.name || 'UNKNOWN_PROVIDER';
    this.alias = config.alias || this.name;
    this.baseUrl = config.baseUrl || '';
    this.defaultHeaders = config.defaultHeaders || {};
  }

  /**
   * Abstract execution method.
   * @param {any} _options
   * @returns {Promise<any>}
   */
  async call(_options) {
    throw new Error(`call() not implemented in ${this.constructor.name}`);
  }

  /**
   * Health probe check.
   */
  async probeHealth() {
    return {
      healthy: false,
      status: 'NOT_IMPLEMENTED',
      latencyMs: 0,
      error: 'Health probe not implemented',
    };
  }
}
