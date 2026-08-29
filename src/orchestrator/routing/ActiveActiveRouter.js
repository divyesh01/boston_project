/**
 * ActiveActiveRouter
 * ------------------
 * Implements Active-Active concurrent routing for Claude Opus across
 * Tabitoken and GoRouter, with circuit breaker health states and dynamic failover.
 */

export const PROVIDER_HEALTH_STATE = {
  HEALTHY: 'HEALTHY',
  DEGRADED: 'DEGRADED',
  COOLDOWN: 'COOLDOWN',
  UNAVAILABLE: 'UNAVAILABLE',
  RECOVERING: 'RECOVERING',
};

export class ActiveActiveRouter {
  constructor(options = {}) {
    this.primaryProviders = options.primaryProviders || ['TABITOKEN', 'GOROUTER'];
    this.cooldownDurationMs = options.cooldownDurationMs || 15000;
    this.maxConsecutiveFailures = options.maxConsecutiveFailures || 2;
    this.modelPreference = options.modelPreference || ['claude-opus-5', 'claude-opus-4-8'];

    // Provider state tracking
    this.providerStates = new Map();
    for (const p of this.primaryProviders) {
      this._initProviderState(p);
    }

    this.roundRobinIndex = 0;
  }

  _initProviderState(providerName) {
    const norm = providerName.toUpperCase();
    this.providerStates.set(norm, {
      name: norm,
      health: PROVIDER_HEALTH_STATE.HEALTHY,
      activeRequests: 0,
      totalCalls: 0,
      successfulCalls: 0,
      failedCalls: 0,
      consecutiveFailures: 0,
      lastFailureTime: null,
      lastSuccessTime: null,
      cooldownUntil: null,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      recentErrors: [],
      recentLatencies: [],
    });
  }

  getProviderState(providerName) {
    const norm = providerName.toUpperCase();
    if (!this.providerStates.has(norm)) {
      this._initProviderState(norm);
    }
    const state = this.providerStates.get(norm);
    this._refreshHealthState(state);
    return state;
  }

  _refreshHealthState(state) {
    const now = Date.now();
    if (state.health === PROVIDER_HEALTH_STATE.COOLDOWN) {
      if (state.cooldownUntil && now >= state.cooldownUntil) {
        state.health = PROVIDER_HEALTH_STATE.RECOVERING;
      }
    }
  }

  selectProviderForClaude(options = {}) {
    const { preferredProvider = null, excludeProviders = [] } = options;
    const excludedNorm = excludeProviders.map((p) => p.toUpperCase());

    if (preferredProvider) {
      const prefNorm = preferredProvider.toUpperCase();
      const pState = this.getProviderState(prefNorm);
      if (this.isProviderEligible(prefNorm) && !excludedNorm.includes(prefNorm)) {
        return {
          provider: prefNorm,
          model: this.modelPreference[0],
          health: pState.health,
          reason: 'PREFERRED_ACTIVE',
        };
      }
    }

    const eligible = this.primaryProviders.filter((p) => {
      const norm = p.toUpperCase();
      return !excludedNorm.includes(norm) && this.isProviderEligible(norm);
    });

    if (eligible.length === 0) {
      const recovering = this.primaryProviders.filter((p) => {
        const norm = p.toUpperCase();
        const s = this.getProviderState(norm);
        return !excludedNorm.includes(norm) && s.health !== PROVIDER_HEALTH_STATE.UNAVAILABLE;
      });

      if (recovering.length > 0) {
        const p = recovering[0];
        const s = this.getProviderState(p);
        return {
          provider: p,
          model: this.modelPreference[0],
          health: s.health,
          reason: 'FAILOVER_TRIAL_RECOVERY',
        };
      }

      return null;
    }

    if (eligible.length === 1) {
      const p = eligible[0];
      const s = this.getProviderState(p);
      return {
        provider: p,
        model: this.modelPreference[0],
        health: s.health,
        reason: 'ACTIVE_AVAILABLE',
      };
    }

    const s0 = this.getProviderState(eligible[0]);
    const s1 = this.getProviderState(eligible[1]);

    let selected;
    if (s0.activeRequests < s1.activeRequests) {
      selected = eligible[0];
    } else if (s1.activeRequests < s0.activeRequests) {
      selected = eligible[1];
    } else {
      selected = eligible[this.roundRobinIndex % eligible.length];
      this.roundRobinIndex++;
    }

    const selState = this.getProviderState(selected);
    return {
      provider: selected,
      model: this.modelPreference[0],
      health: selState.health,
      reason: 'ACTIVE_ACTIVE_BALANCED',
    };
  }

  planParallelClaudeWave(workerCount = 2, options = {}) {
    const assignments = [];
    const eligibleProviders = this.primaryProviders.filter((p) => this.isProviderEligible(p));

    if (eligibleProviders.length === 0) {
      for (let i = 0; i < workerCount; i++) {
        const p = this.primaryProviders[i % this.primaryProviders.length];
        assignments.push({
          workerIndex: i,
          provider: p,
          model: this.modelPreference[0],
          mode: 'FAILOVER_DEGRADED',
        });
      }
      return assignments;
    }

    for (let i = 0; i < workerCount; i++) {
      const chosenProvider = eligibleProviders[i % eligibleProviders.length];
      assignments.push({
        workerIndex: i,
        provider: chosenProvider,
        model: this.modelPreference[0],
        mode: eligibleProviders.length > 1 ? 'ACTIVE_ACTIVE_CONCURRENT' : 'SINGLE_PROVIDER_CONCURRENT',
      });
    }

    return assignments;
  }

  isProviderEligible(providerName) {
    const s = this.getProviderState(providerName);
    return (
      s.health === PROVIDER_HEALTH_STATE.HEALTHY ||
      s.health === PROVIDER_HEALTH_STATE.RECOVERING ||
      (s.health === PROVIDER_HEALTH_STATE.DEGRADED && s.consecutiveFailures < this.maxConsecutiveFailures)
    );
  }

  recordRequestStart(providerName) {
    const s = this.getProviderState(providerName);
    s.activeRequests++;
  }

  recordRequestOutcome(providerName, result) {
    const s = this.getProviderState(providerName);
    s.activeRequests = Math.max(0, s.activeRequests - 1);
    s.totalCalls++;

    if (result.latencySeconds) {
      s.recentLatencies.push(result.latencySeconds);
      if (s.recentLatencies.length > 20) s.recentLatencies.shift();
    }

    if (result.usage?.prompt_tokens) {
      s.totalInputTokens += result.usage.prompt_tokens;
    }
    if (result.usage?.completion_tokens) {
      s.totalOutputTokens += result.usage.completion_tokens;
    }

    if (result.success) {
      s.successfulCalls++;
      s.consecutiveFailures = 0;
      s.lastSuccessTime = Date.now();
      if (s.health === PROVIDER_HEALTH_STATE.RECOVERING || s.health === PROVIDER_HEALTH_STATE.DEGRADED) {
        s.health = PROVIDER_HEALTH_STATE.HEALTHY;
        s.cooldownUntil = null;
      }
    } else {
      s.failedCalls++;
      s.consecutiveFailures++;
      s.lastFailureTime = Date.now();
      s.recentErrors.push({
        time: new Date().toISOString(),
        error: result.error,
        httpStatus: result.httpStatus,
      });
      if (s.recentErrors.length > 10) s.recentErrors.shift();

      const isHardError =
        result.httpStatus === 401 ||
        result.httpStatus === 'MISSING_KEY' ||
        result.httpStatus === 403;

      if (isHardError) {
        s.health = PROVIDER_HEALTH_STATE.UNAVAILABLE;
      } else if (s.consecutiveFailures >= this.maxConsecutiveFailures) {
        s.health = PROVIDER_HEALTH_STATE.COOLDOWN;
        s.cooldownUntil = Date.now() + this.cooldownDurationMs;
      } else {
        s.health = PROVIDER_HEALTH_STATE.DEGRADED;
      }
    }
  }

  getBalanceMetrics() {
    const metrics = {};
    let totalClaudeCalls = 0;
    let totalClaudeInputTokens = 0;

    for (const p of this.primaryProviders) {
      const s = this.getProviderState(p);
      metrics[p] = {
        name: p,
        health: s.health,
        totalCalls: s.totalCalls,
        successfulCalls: s.successfulCalls,
        failedCalls: s.failedCalls,
        activeRequests: s.activeRequests,
        inputTokens: s.totalInputTokens,
        outputTokens: s.totalOutputTokens,
        consecutiveFailures: s.consecutiveFailures,
      };
      totalClaudeCalls += s.totalCalls;
      totalClaudeInputTokens += s.totalInputTokens;
    }

    const p1 = this.getProviderState(this.primaryProviders[0] || 'TABITOKEN');
    const p2 = this.getProviderState(this.primaryProviders[1] || 'GOROUTER');

    let status = 'UNPROVEN';
    if (p1.successfulCalls > 0 && p2.successfulCalls > 0) {
      const ratio = p1.successfulCalls / (p1.successfulCalls + p2.successfulCalls);
      if (ratio >= 0.3 && ratio <= 0.7) {
        status = 'BALANCED';
      } else {
        status = 'TEMPORARILY IMBALANCED';
      }
    } else if (p1.successfulCalls > 0 && p2.health !== PROVIDER_HEALTH_STATE.HEALTHY) {
      status = 'FAILOVER MODE';
    } else if (p2.successfulCalls > 0 && p1.health !== PROVIDER_HEALTH_STATE.HEALTHY) {
      status = 'FAILOVER MODE';
    } else if (p1.successfulCalls > 0 || p2.successfulCalls > 0) {
      status = 'SINGLE PROVIDER ONLY';
    }

    return {
      providers: metrics,
      totalClaudeCalls,
      totalClaudeInputTokens,
      status,
      timestamp: new Date().toISOString(),
    };
  }
}

export const defaultActiveRouter = new ActiveActiveRouter();
