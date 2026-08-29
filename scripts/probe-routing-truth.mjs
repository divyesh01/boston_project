import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

import {
  MODEL_ROUTING_POLICY,
  UniversalModelRouter,
  classifyProviderIdentity,
  parseAffordableTokenLimit,
  validateCompletionPayload,
} from '../src/lib/universalModelRouter.js';
import { NaraHelperPool } from '../src/lib/naraHelperPool.js';

let assertions = 0;
const check = (condition, message) => {
  assert.ok(condition, message);
  assertions += 1;
};

const equal = (actual, expected, message) => {
  assert.equal(actual, expected, message);
  assertions += 1;
};

// Current routing policy must not send work to retired Claude 3.x endpoints.
const routedModels = Object.values(MODEL_ROUTING_POLICY)
  .flatMap((policy) => policy.candidateChain)
  .map((candidate) => candidate.model);
check(!routedModels.some((model) => /anthropic\/claude-3(?:\.|-|$)/.test(model)), 'retired Claude 3.x model remains in routing policy');
check(routedModels.includes('anthropic/claude-sonnet-5'), 'current Claude Sonnet model is missing from routing policy');

const executableRoutingSources = [
  'scripts/claude_provider.py',
  'scripts/openrouter_support.py',
  'scripts/run_ai_ledger.mjs',
  'scripts/execute_all_ai_checkpoints.py',
  'src/lib/universalModelRouter.js',
  'src/lib/naraHelperPool.js',
].map((file) => ({ file, source: fs.readFileSync(file, 'utf8') }));
for (const { file, source } of executableRoutingSources) {
  check(!/anthropic\/claude-3(?:\.|-|['"])/.test(source), `retired Claude 3.x ID remains in ${file}`);
}
check(
  executableRoutingSources.find(({ file }) => file.endsWith('execute_all_ai_checkpoints.py')).source
    .includes('run_ai_ledger.mjs'),
  'legacy checkpoint entry point must delegate to the canonical ledger router',
);

// A generic OpenRouter fallback is OpenRouter transport, but it is not Claude.
const genuineClaude = classifyProviderIdentity({
  transportProvider: 'OPENROUTER',
  actualModel: 'anthropic/claude-sonnet-5',
  upstreamProvider: 'Claude Platform on AWS',
});
equal(genuineClaude.transportProvider, 'OPENROUTER', 'Claude transport must remain OpenRouter');
equal(genuineClaude.actualProvider, 'ANTHROPIC', 'Claude model must be identified as Anthropic');
equal(genuineClaude.isClaude, true, 'current Claude model should satisfy Claude identity');

const disguisedFallback = classifyProviderIdentity({
  transportProvider: 'OPENROUTER',
  actualModel: 'minimax/minimax-m3:free',
  upstreamProvider: 'GMICloud',
});
equal(disguisedFallback.transportProvider, 'OPENROUTER', 'fallback transport should remain OpenRouter');
equal(disguisedFallback.actualProvider, 'MINIMAX', 'fallback must report its actual model provider');
equal(disguisedFallback.isClaude, false, 'generic fallback must never be labeled Claude');

// HTTP 200 with no usable assistant content is a failed completion.
const empty = validateCompletionPayload({
  id: 'gen-empty',
  model: 'anthropic/claude-sonnet-5',
  choices: [{ message: { content: '   ' } }],
}, 'anthropic/claude-sonnet-5', 'OPENROUTER');
equal(empty.success, false, 'empty HTTP 200 response must fail');
equal(empty.error, 'EMPTY_RESPONSE', 'empty response needs an explicit failure reason');

const usable = validateCompletionPayload({
  id: 'gen-real',
  model: 'anthropic/claude-sonnet-5',
  provider: 'Claude Platform on AWS',
  choices: [{ message: { content: 'ROUTER_OK' } }],
}, 'anthropic/claude-sonnet-5', 'OPENROUTER');
equal(usable.success, true, 'non-empty completion should pass');
equal(usable.actualModel, 'anthropic/claude-sonnet-5', 'actual returned model must be preserved');
equal(usable.identity.actualProvider, 'ANTHROPIC', 'actual provider must be derived from returned model');

// OpenRouter 402 errors disclose the affordable output ceiling. Retry below it.
equal(
  parseAffordableTokenLimit('{"error":{"message":"requested 1000 tokens, but can only afford 432"}}', 1000),
  432,
  'affordable token limit was not parsed',
);
equal(parseAffordableTokenLimit('unrelated error', 200), null, 'unrelated errors must not invent a token limit');

// Gemini is not healthy merely because an account object exists.
const router = new UniversalModelRouter();
equal(router.accounts['GEMINI-1'].available, false, 'Gemini must start unavailable until a live completion succeeds');
equal(router.accounts['GEMINI-1'].status, 'UNPROVEN', 'Gemini must start UNPROVEN');

const originalFetch = globalThis.fetch;
const response = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

try {
  const makeRouter = () => {
    const instance = new UniversalModelRouter();
    instance.accounts['OPENROUTER-1'].available = true;
    instance.accounts['OPENROUTER-1'].status = 'HEALTHY';
    return instance;
  };

  globalThis.fetch = async () => response(200, {
    id: 'gen-disguised',
    model: 'minimax/minimax-m3:free',
    provider: 'GMICloud',
    choices: [{ message: { content: 'fallback succeeded' } }],
  });
  const rejectedFallback = await makeRouter().execute({
    roleType: 'FINANCIAL_CALCULATION',
    prompt: 'identity test',
    mandatoryProvider: 'OPENROUTER',
    isAuthoritative: true,
    maxAttemptsPerModel: 1,
  });
  equal(rejectedFallback.success, false, 'non-Claude fallback must not satisfy an authoritative Claude route');
  check(
    rejectedFallback.fallbackPath.some((entry) => entry.status === 'MODEL_IDENTITY_MISMATCH'),
    'identity mismatch was not recorded',
  );

  globalThis.fetch = async () => response(200, {
    id: 'gen-claude',
    model: 'anthropic/claude-sonnet-5',
    provider: 'Claude Platform on AWS',
    choices: [{ message: { content: 'CLAUDE_OK' } }],
  });
  const acceptedClaude = await makeRouter().execute({
    roleType: 'FINANCIAL_CALCULATION',
    prompt: 'identity test',
    mandatoryProvider: 'OPENROUTER',
    isAuthoritative: true,
    maxAttemptsPerModel: 1,
  });
  equal(acceptedClaude.success, true, 'genuine returned Claude model should pass');
  equal(acceptedClaude.provider, 'OPENROUTER', 'result must report transport provider');
  equal(acceptedClaude.actualProvider, 'ANTHROPIC', 'result must report actual model provider');
  equal(acceptedClaude.model, 'anthropic/claude-sonnet-5', 'result must report actual returned model');

  const budgets = [];
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(init.body);
    budgets.push(payload.max_tokens);
    if (budgets.length === 1) {
      return response(402, { error: { message: 'requested 1000 tokens, but can only afford 432' } });
    }
    return response(200, {
      id: 'gen-resized',
      model: 'anthropic/claude-sonnet-5',
      provider: 'Claude Platform on AWS',
      choices: [{ message: { content: 'RESIZED_OK' } }],
    });
  };
  const resized = await makeRouter().execute({
    roleType: 'FINANCIAL_CALCULATION',
    prompt: 'budget test',
    mandatoryProvider: 'OPENROUTER',
    isAuthoritative: true,
    maxTokens: 1000,
    maxAttemptsPerModel: 2,
  });
  equal(resized.success, true, 'router should retry a disclosed affordable token budget');
  assert.deepEqual(budgets, [1000, 432], 'router did not use the provider-disclosed token ceiling');
  assertions += 1;

  const makeNaraPool = () => {
    const pool = new NaraHelperPool();
    pool.accounts['NARA-A'].available = true;
    pool.accounts['NARA-A'].status = 'AVAILABLE';
    return pool;
  };

  globalThis.fetch = async () => response(200, {
    id: 'nara-empty',
    model: 'tencent-hy3-free',
    choices: [{ message: { content: '' } }],
  });
  const emptyNara = await makeNaraPool().executeHelperTask({
    taskName: 'empty response test',
    roleType: 'ADVERSARIAL_TESTING',
    preferredModel: 'tencent-hy3-free',
    prompt: 'return content',
    timeoutMs: 100,
  });
  equal(emptyNara.success, false, 'Nara HTTP 200 with empty content must fail');
  check(
    emptyNara.entry.retryPath.every((entry) => entry.status === 'EMPTY_RESPONSE'),
    'Nara empty response failures must be explicit',
  );

  globalThis.fetch = async () => response(200, {
    id: 'nara-real',
    model: 'laguna-s-2.1',
    choices: [{ message: { content: 'NARA_OK' } }],
  });
  const usableNara = await makeNaraPool().executeHelperTask({
    taskName: 'usable response test',
    roleType: 'DEEP_CODING',
    preferredModel: 'laguna-s-2.1',
    prompt: 'return content',
    timeoutMs: 100,
  });
  equal(usableNara.success, true, 'Nara non-empty completion should pass');
  equal(usableNara.entry.modelReturned, 'laguna-s-2.1', 'Nara must preserve actual returned model');
  equal(usableNara.entry.actualProvider, 'NARA', 'Nara must report actual model provider identity');
} finally {
  globalThis.fetch = originalFetch;
}

const pythonProbe = spawnSync('python', ['scripts/probe-claude-provider-truth.py'], {
  cwd: process.cwd(),
  encoding: 'utf8',
});
equal(pythonProbe.status, 0, `Python Claude routing probe failed:\n${pythonProbe.stdout}\n${pythonProbe.stderr}`);

console.log(`ROUTING TRUTH PROBE PASSED (${assertions} assertions)`);
