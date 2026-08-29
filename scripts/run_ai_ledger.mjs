import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import {
  classifyProviderIdentity,
  parseAffordableTokenLimit,
  validateCompletionPayload,
} from '../src/lib/universalModelRouter.js';

const apiKey = execSync('python -c "import scripts.openrouter_support as ops; print(ops.get_stored_key())"', { encoding: 'utf8' }).trim();
if (!apiKey) {
  console.error('No API key available.');
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function callOpenRouter(model, messages, timeoutMs = 25000, maxTokens = 160) {
  const t0 = Date.now();
  const isoTime = new Date().toISOString();
  let tokenBudget = maxTokens;
  let budgetAdapted = false;

  for (let requestAttempt = 1; requestAttempt <= 2; requestAttempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + apiKey,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/divyesh01/boston_project',
          'X-Title': 'BostonProject-LiveLedger',
          'User-Agent': 'BostonProject-LiveLedger/3.0',
        },
        body: JSON.stringify({
          model: model,
          messages: messages,
          max_tokens: tokenBudget,
          temperature: 0.1,
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok) {
        const errText = await res.text();
        const affordableLimit = res.status === 402
          ? parseAffordableTokenLimit(errText, tokenBudget)
          : null;
        if (!budgetAdapted && affordableLimit && affordableLimit < tokenBudget) {
          tokenBudget = affordableLimit;
          budgetAdapted = true;
          continue;
        }
        return failureResult(
          'HTTP ' + res.status + ': ' + res.statusText + ' - ' + errText.slice(0, 300),
          tokenBudget,
        );
      }

      const data = await res.json();
      const validated = validateCompletionPayload(data, model, 'OPENROUTER');
      if (!validated.success) return failureResult(validated.error, tokenBudget);

      return {
        success: true,
        timestamp: isoTime,
        durationSeconds: elapsedSeconds(),
        generationId: data?.id || ('gen-' + t0),
        modelRequested: model,
        modelReturned: validated.actualModel,
        transportProvider: validated.identity.transportProvider,
        actualProvider: validated.identity.actualProvider,
        upstreamProvider: validated.identity.upstreamProvider,
        tokenBudgetUsed: tokenBudget,
        usage: data?.usage || {},
        content: validated.content,
        error: null,
      };
    } catch (err) {
      clearTimeout(timer);
      return failureResult(
        err.name === 'AbortError' ? 'Timeout after ' + timeoutMs + 'ms' : err.message,
        tokenBudget,
      );
    }
  }

  return failureResult('Token budget retry exhausted.', tokenBudget);

  function elapsedSeconds() {
    return Number(((Date.now() - t0) / 1000).toFixed(3));
  }

  function failureResult(error, tokenBudgetUsed) {
    return {
      success: false,
      timestamp: isoTime,
      durationSeconds: elapsedSeconds(),
      generationId: null,
      modelRequested: model,
      modelReturned: null,
      transportProvider: 'OPENROUTER',
      actualProvider: null,
      upstreamProvider: null,
      tokenBudgetUsed,
      usage: null,
      content: null,
      error,
    };
  }
}

async function executeCheckpoint(config) {
  const { role, agentName, requiredPrefix, systemPrompt, userPrompt, modelChain, maxTokens = 160 } = config;
  console.log('\n=======================================================');
  console.log('[*] Invoking: ' + agentName + ' (' + role + ')');
  console.log('[*] Required Provider Prefix: ' + (requiredPrefix || 'ANY'));
  console.log('[*] System Prompt: ' + systemPrompt.slice(0, 75) + '...');

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];

  const attempts = [];
  let successfulRes = null;

  for (const model of modelChain) {
    console.log('  -> Attempting model: ' + model + '...');
    const res = await callOpenRouter(model, messages, 25000, maxTokens);
    attempts.push({
      model: model,
      success: res.success,
      durationSeconds: res.durationSeconds,
      error: res.error,
      generationId: res.generationId,
      modelReturned: res.modelReturned,
      transportProvider: res.transportProvider,
      actualProvider: res.actualProvider,
      upstreamProvider: res.upstreamProvider,
      tokenBudgetUsed: res.tokenBudgetUsed,
    });

    if (res.success) {
      const identity = classifyProviderIdentity({
        transportProvider: res.transportProvider,
        actualModel: res.modelReturned,
        upstreamProvider: res.upstreamProvider,
      });
      const identityMatches = requiredPrefix
        ? res.modelReturned.toLowerCase().startsWith(requiredPrefix.toLowerCase())
        : true;
      if (identityMatches) {
        successfulRes = { ...res, ...identity };
        console.log('  [+] Live response received from: ' + res.modelReturned + ' in ' + res.durationSeconds + 's (ID: ' + res.generationId + ')');
        break;
      }
      attempts[attempts.length - 1].success = false;
      attempts[attempts.length - 1].error = 'MODEL_IDENTITY_MISMATCH: expected ' + requiredPrefix + ', received ' + res.modelReturned;
      console.log('  [!] ' + attempts[attempts.length - 1].error);
    } else {
      console.log('  [-] Failed (' + model + '): ' + res.error);
    }
    // Small delay between fallback attempts
    await sleep(1500);
  }

  if (!successfulRes) {
    console.log('  [X] All candidate models failed.');
    return {
      role: role,
      agentName: agentName,
      requiredPrefix: requiredPrefix,
      isGenuineProvider: false,
      providerStatus: 'FAILED / UNAVAILABLE ❌',
      checkpointStatus: 'UNPROVEN',
      timestamp: new Date().toISOString(),
      modelRequested: modelChain[0],
      modelUsed: null,
      generationId: null,
      durationSeconds: attempts.reduce((acc, a) => acc + (a.durationSeconds || 0), 0),
      usage: null,
      attempts: attempts,
      response: null,
      error: 'All candidate models in chain failed.',
    };
  }

  const modelUsed = successfulRes.modelReturned || '';
  const isGenuine = requiredPrefix ? modelUsed.toLowerCase().startsWith(requiredPrefix.toLowerCase()) : true;

  if (isGenuine) {
    console.log('  [✓] PROVIDER IDENTITY CONFIRMED: Genuine ' + requiredPrefix + ' model used (' + modelUsed + ')');
    return {
      role: role,
      agentName: agentName,
      requiredPrefix: requiredPrefix,
      isGenuineProvider: true,
      providerStatus: 'GENUINE_PROVEN ✅',
      checkpointStatus: 'PASS',
      timestamp: successfulRes.timestamp,
      modelRequested: successfulRes.modelRequested,
      modelUsed: modelUsed,
      transportProvider: successfulRes.transportProvider,
      actualProvider: successfulRes.actualProvider,
      upstreamProvider: successfulRes.upstreamProvider,
      tokenBudgetUsed: successfulRes.tokenBudgetUsed,
      generationId: successfulRes.generationId,
      durationSeconds: successfulRes.durationSeconds,
      usage: successfulRes.usage,
      attempts: attempts,
      response: successfulRes.content,
      error: null,
    };
  } else {
    console.log('  [!] PROVIDER IDENTITY MISMATCH: Expected ' + requiredPrefix + ' but got ' + modelUsed);
    return {
      role: role,
      agentName: agentName,
      requiredPrefix: requiredPrefix,
      isGenuineProvider: false,
      providerStatus: 'FALLBACK_ONLY (Not Genuine ' + requiredPrefix + ') ⚠️',
      checkpointStatus: 'UNPROVEN (Fallback Executed)',
      timestamp: successfulRes.timestamp,
      modelRequested: successfulRes.modelRequested,
      modelUsed: modelUsed,
      generationId: successfulRes.generationId,
      durationSeconds: successfulRes.durationSeconds,
      usage: successfulRes.usage,
      attempts: attempts,
      response: successfulRes.content,
      error: null,
    };
  }
}

async function main() {
  console.log('=================================================================');
  console.log('🚀 LIVE MULTI-AGENT INVOCATION CHAIN (STRICT PROVIDER ENFORCEMENT)');
  console.log('=================================================================');

  // Genuine Anthropic Claude models active on OpenRouter
  const ANTHROPIC_CLAUDE_CHAIN = [
    'anthropic/claude-sonnet-5',
    'anthropic/claude-opus-4.8',
    'anthropic/claude-opus-5',
    'anthropic/claude-opus-4.7',
    'anthropic/claude-fable-5',
  ];

  // Genuine NVIDIA NIM models active on OpenRouter
  const NVIDIA_CHAIN = [
    'nvidia/nemotron-3-super-120b-a12b:free',
    'nvidia/nemotron-3.5-lightning:free',
    'nvidia/nemotron-3-ultra-550b-a55b:free',
    'nvidia/nemotron-3.5-content-safety:free',
  ];

  // OpenRouter Research Engine models for xKiro Proxy
  const RESEARCH_CHAIN = [
    'poolside/laguna-s-2.1:free',
    'liquid/lfm-2.5-2.6b:free',
    'poolside/laguna-xs-2.1:free',
  ];

  // OpenRouter Swarm models
  const OPENROUTER_SWARM_CHAIN = [
    'poolside/laguna-xs-2.1:free',
    'liquid/lfm-2.5-2.6b:free',
  ];

  const context = [
    'Project: Boston Project (Hotel Operations & Owner Intelligence Dashboard)',
    'Recent Core Engineering & Quality Actions:',
    '1. RoomBoard.jsx & roomBoard.js: Fixed cross-property room selection collision where rooms.find by room_number could pick a room from property B while on property A. Added normalizeRoomId sanitization, ROOM_STATUS validation, and synchronized maintenance: out_of_service with status changes. React tiles now keyed with property_id_room_number.',
    '2. uploadGuard.js: Added 4KB binary magic byte inspection (PE MZ, ELF, Mach-O, ZIP disguised as CSV, UTF-16 BOM vs UTF-8 control characters) to prevent malicious or malformed CSV/spreadsheet uploads.',
    '3. Deterministic Test Status: 365 vitest tests pass, 130 probe suites pass, tsc 0 errors, eslint 0 errors, production build green in 26.25s.'
  ].join('\n\n');

  const ledger = [];

  // Claude CP1: Pre-Implementation Inspector
  ledger.push(await executeCheckpoint({
    role: 'Claude CP1 (Pre-Implementation Inspector)',
    agentName: 'Claude High-Trust Inspector',
    requiredPrefix: 'anthropic/claude-',
    systemPrompt: 'You are Claude, the Hotel System High-Trust Pre-Implementation Inspector. In 3 bullet points, analyze what could Gemini or the current plan have missed regarding multi-property room selection and binary upload security.',
    userPrompt: context,
    modelChain: ANTHROPIC_CLAUDE_CHAIN,
    maxTokens: 160,
  }));
  await sleep(3500);

  // Claude CP2: Independent Peer Engineer (Solution B)
  ledger.push(await executeCheckpoint({
    role: 'Claude CP2 (Equal Peer Engineer)',
    agentName: 'Claude Peer Engineer',
    requiredPrefix: 'anthropic/claude-',
    systemPrompt: 'You are Claude, an Equal Peer Engineer. In 3 bullet points, formulate an independent Solution B for hotel room status reconciliation and multi-tenant property isolation.',
    userPrompt: context,
    modelChain: ANTHROPIC_CLAUDE_CHAIN,
    maxTokens: 160,
  }));
  await sleep(3500);

  // Claude CP3: Post-Implementation Inspector (Diff Audit)
  ledger.push(await executeCheckpoint({
    role: 'Claude CP3 (Post-Implementation Inspector)',
    agentName: 'Claude Diff Auditor',
    requiredPrefix: 'anthropic/claude-',
    systemPrompt: 'You are Claude, the Post-Implementation Inspector. In 3 bullet points, review the property-scoped room lookup and uploadGuard magic-byte checks. Report any residual risks.',
    userPrompt: context,
    modelChain: ANTHROPIC_CLAUDE_CHAIN,
    maxTokens: 160,
  }));
  await sleep(3500);

  // Claude CP4: Hotel Data & Financial Truth Review
  ledger.push(await executeCheckpoint({
    role: 'Claude CP4 (Financial & Tenant Truth)',
    agentName: 'Claude Financial Reviewer',
    requiredPrefix: 'anthropic/claude-',
    systemPrompt: 'You are Claude, the Foundation Hotel Financial & Data Truth Inspector. Audit ADR, RevPAR, Occupancy, and integer-cent invariants across multi-property boundaries. Verify zero leakage.',
    userPrompt: context,
    modelChain: ANTHROPIC_CLAUDE_CHAIN,
    maxTokens: 160,
  }));
  await sleep(3500);

  // Claude CP5: Final Tribunal Release Gate
  ledger.push(await executeCheckpoint({
    role: 'Claude CP5 (Final Tribunal Release Gate)',
    agentName: 'Claude Final Tribunal',
    requiredPrefix: 'anthropic/claude-',
    systemPrompt: 'You are Claude, sitting on the Final Tribunal. Evaluate the full evidence package. Return exactly ONE verdict: PASS, FAIL, or UNPROVEN, followed by a concise 2-sentence rationale.',
    userPrompt: context,
    modelChain: ANTHROPIC_CLAUDE_CHAIN,
    maxTokens: 160,
  }));
  await sleep(3500);

  // Claude CP6: Deployment / Live Production Inspector
  ledger.push(await executeCheckpoint({
    role: 'Claude CP6 (Deployment / Live Inspector)',
    agentName: 'Claude Deployment Inspector',
    requiredPrefix: 'anthropic/claude-',
    systemPrompt: 'You are Claude, the Deployment & Live Production Inspector. Verify production URL https://boston-project.divyesh-boston.workers.dev/ readiness with CSP headers, SRI integrity, and SPA hydration safety.',
    userPrompt: context,
    modelChain: ANTHROPIC_CLAUDE_CHAIN,
    maxTokens: 160,
  }));
  await sleep(2500);

  // NVIDIA NIM: Senior Technical & Security Reviewer
  ledger.push(await executeCheckpoint({
    role: 'NVIDIA NIM (Senior Technical & Security Specialist)',
    agentName: 'NVIDIA NIM Reviewer',
    requiredPrefix: 'nvidia/',
    systemPrompt: 'You are NVIDIA NIM Senior Reviewer. Perform a 5-pillar review: Security, Technical Correctness, Data Integrity, Concurrency, Performance. State CLEAR or BLOCK for each pillar.',
    userPrompt: context,
    modelChain: NVIDIA_CHAIN,
    maxTokens: 250,
  }));
  await sleep(2000);

  // xKiro Role: Research & Standards Specialist (Explicitly mapped to OpenRouter Research Engine)
  ledger.push(await executeCheckpoint({
    role: 'xKiro Role (Research & Standards Specialist)',
    agentName: 'OpenRouter Research Agent (xKiro Proxy)',
    requiredPrefix: null,
    systemPrompt: 'You are an authoritative research and standards specialist for hospitality. Provide authoritative research notes on USALI room status definitions (Available vs OOO vs Dirty) and MIME/Magic byte verification standards (RFC 4180 / ISO/IEC 29500).',
    userPrompt: context,
    modelChain: RESEARCH_CHAIN,
    maxTokens: 250,
  }));
  await sleep(2000);

  // OpenRouter Free Swarm: Adversarial Edge Cases
  ledger.push(await executeCheckpoint({
    role: 'OpenRouter Free Swarm (Adversarial Edge-Case Generator)',
    agentName: 'OpenRouter Swarm Agent',
    requiredPrefix: null,
    systemPrompt: 'You are the OpenRouter Free Swarm Adversarial Tester. Generate 3 subtle adversarial edge cases for RoomBoard status updates and file uploads that could bypass naive guards.',
    userPrompt: context,
    modelChain: OPENROUTER_SWARM_CHAIN,
    maxTokens: 250,
  }));

  const outPath = path.resolve(process.cwd(), 'ai_invocation_ledger.json');
  fs.writeFileSync(outPath, JSON.stringify(ledger, null, 2), 'utf8');

  console.log('\n=======================================================');
  console.log('✓ AI Invocation Ledger written to: ' + outPath);
  console.log('✓ Total Live Invocations: ' + ledger.length);
  
  const genuineClaudeCount = ledger.filter(e => e.role.startsWith('Claude') && e.isGenuineProvider).length;
  console.log('✓ Genuine Anthropic Claude Calls: ' + genuineClaudeCount + '/6');
  
  const genuineNvidiaCount = ledger.filter(e => e.role.startsWith('NVIDIA') && e.isGenuineProvider).length;
  console.log('✓ Genuine NVIDIA NIM Calls: ' + genuineNvidiaCount + '/1');
  
  const allSuccessful = ledger.filter(e => e.modelUsed !== null).length;
  console.log('✓ Total Live Response Calls: ' + allSuccessful + '/' + ledger.length);
  console.log('=======================================================');
}

main().catch((err) => {
  console.error('Fatal Error in main:', err);
  process.exit(1);
});
