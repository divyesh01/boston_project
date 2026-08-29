/**
 * Phoenix OpenTelemetry & OpenInference Tracer
 * --------------------------------------------
 * Visual Observability & Multi-Agent Workflow Tracing for Arize Phoenix.
 * Formats real agent executions according to OpenInference conventions and
 * exports spans to Phoenix at http://localhost:6006.
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import process from 'node:process';

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

export class PhoenixTracer {
  constructor(options = {}) {
    const env = typeof process !== 'undefined' && process.env ? process.env : {};
    this.endpoint = options.endpoint || env.PHOENIX_ENDPOINT || 'http://localhost:6006/v1/traces';
    this.projectName = options.projectName || env.PHOENIX_PROJECT_NAME || 'default';
    this.enabled = options.enabled !== false;
    this.recordedSpans = [];
  }

  generateTraceId() {
    return randomHex(16);
  }

  generateSpanId() {
    return randomHex(8);
  }

  /**
   * Builds an OpenInference span.
   */
  buildSpan({
    name,
    kind = 'AGENT', // AGENT, LLM, CHAIN, TOOL
    traceId = this.generateTraceId(),
    spanId = this.generateSpanId(),
    parentSpanId = null,
    attributes = {},
    status = 'OK',
    errorMessage = null,
    startTime = Date.now(),
    endTime = Date.now(),
  }) {
    const span = {
      name,
      kind,
      traceId,
      spanId,
      parentSpanId,
      startTime,
      endTime,
      status,
      errorMessage,
      attributes: {
        'openinference.span.kind': kind,
        'project.name': this.projectName,
        ...attributes,
      },
    };

    if (errorMessage) {
      span.attributes['error.message'] = errorMessage;
    }

    return span;
  }

  /**
   * Exports real span batch asynchronously via the OTLP bridge.
   */
  async exportSpans(spans) {
    if (!this.enabled || !spans || spans.length === 0) return { success: false, reason: 'DISABLED_OR_EMPTY' };

    try {
      const bridgePath = path.resolve(process.cwd(), 'scripts/otlp_export_bridge.py');
      const py = spawn('python', [bridgePath], { stdio: ['pipe', 'pipe', 'ignore'] });

      return await new Promise((resolve) => {
        let output = '';
        py.stdout.on('data', (d) => { output += d.toString(); });
        py.on('close', () => {
          try {
            const res = JSON.parse(output.trim() || '{}');
            resolve(res);
          } catch {
            resolve({ success: false, raw: output });
          }
        });
        py.on('error', (err) => {
          resolve({ success: false, error: err.message });
        });

        py.stdin.write(JSON.stringify(spans));
        py.stdin.end();
      });
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Instruments a real LLM call (Gemini, Claude, Nara, OpenRouter).
   */
  async recordLlmCall({
    name,
    provider,
    modelRequested,
    modelReturned,
    input,
    output,
    tokens = {},
    latencySeconds = 0,
    status = 'OK',
    error = null,
    traceId = null,
    parentSpanId = null,
    customAttributes = {},
  }) {
    const end = Date.now();
    const start = end - Math.round(latencySeconds * 1000);

    const span = this.buildSpan({
      name: name || `LLM: ${modelReturned || modelRequested || 'Unknown'}`,
      kind: 'LLM',
      traceId: traceId || this.generateTraceId(),
      parentSpanId,
      startTime: start,
      endTime: end,
      status: status === 'OK' && !error ? 'OK' : 'ERROR',
      errorMessage: error ? (typeof error === 'string' ? error : error.message) : null,
      attributes: {
        'llm.provider': provider,
        'llm.model_name': modelReturned || modelRequested,
        'llm.model_requested': modelRequested,
        'input.value': typeof input === 'string' ? input : JSON.stringify(input),
        'output.value': output ? (typeof output === 'string' ? output : JSON.stringify(output)) : '',
        'llm.token_count.prompt_tokens': (tokens && typeof tokens === 'object' && 'prompt_tokens' in tokens) ? tokens.prompt_tokens : 0,
        'llm.token_count.completion_tokens': (tokens && typeof tokens === 'object' && 'completion_tokens' in tokens) ? tokens.completion_tokens : 0,
        'llm.token_count.total_tokens': (tokens && typeof tokens === 'object' && 'total_tokens' in tokens) ? tokens.total_tokens : 0,
        ...customAttributes,
      },
    });

    this.recordedSpans.push(span);
    // Asynchronous non-blocking export
    this.exportSpans([span]).catch(() => {});
    return span;
  }

  /**
   * Instruments a real Agent execution span (e.g. Orchestrator, Dual-Pillar Solver, Nara Pool).
   */
  async recordAgentCall({
    name,
    role,
    input,
    output,
    latencySeconds = 0,
    status = 'OK',
    error = null,
    traceId = null,
    parentSpanId = null,
    customAttributes = {},
  }) {
    const end = Date.now();
    const start = end - Math.round(latencySeconds * 1000);

    const span = this.buildSpan({
      name,
      kind: 'AGENT',
      traceId: traceId || this.generateTraceId(),
      parentSpanId,
      startTime: start,
      endTime: end,
      status: status === 'OK' && !error ? 'OK' : 'ERROR',
      errorMessage: error ? (typeof error === 'string' ? error : error.message) : null,
      attributes: {
        'agent.name': name,
        'agent.role': role,
        'input.value': typeof input === 'string' ? input : JSON.stringify(input),
        'output.value': output ? (typeof output === 'string' ? output : JSON.stringify(output)) : '',
        ...customAttributes,
      },
    });

    this.recordedSpans.push(span);
    this.exportSpans([span]).catch(() => {});
    return span;
  }
}

export const phoenixTracer = new PhoenixTracer();
