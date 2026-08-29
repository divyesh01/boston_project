import { execSync } from 'node:child_process';
import fs from 'node:fs';

async function runGeminiReview() {
  console.log('=== DISPATCHING REAL GEMINI API CALL (google/gemini-2.5-flash) ===\n');

  const openrouterKey = execSync('python scripts/openrouter_support.py --get', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();

  const systemPrompt = `You are Gemini, the read-only adversarial challenger and code reviewer for the Boston Project.
Your task is to inspect the proposed UI integration and Dexie persistence layer for the Owner Forensic Audit Engine.`;

  const userMessage = `Perform a read-only architectural challenge of the Owner Forensic Engine UI integration and Dexie persistence:
1. UI Triage Queue in ActionCenter.jsx (rendering 68 prioritized items, presets, explainable tags)
2. Dexie persistence for Owner Review States (UNREVIEWED, APPROVED, ESCALATED, RESOLVED) and Whitelist rules
3. Immutable provenance logging in AuditLog table without mutating source financial rows

Provide your concise adversarial inspection and verification findings.`;

  const startTime = Date.now();
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${openrouterKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://boston-project.local',
      'X-Title': 'Boston Project Gemini Review',
    },
    body: JSON.stringify({
      model: 'google/gemini-2.5-flash',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      max_tokens: 500,
      temperature: 0.2,
    }),
  });

  const latencyMs = Date.now() - startTime;
  const latencySec = (latencyMs / 1000).toFixed(3);
  const data = await res.json();

  const generationId = data.id || 'NONE';
  const modelReturned = data.model || 'google/gemini-2.5-flash';
  const provider = data.provider || 'Google AI Studio';
  const usage = data.usage || {};
  const inTokens = usage.prompt_tokens || 0;
  const outTokens = usage.completion_tokens || 0;
  const totalTokens = usage.total_tokens || (inTokens + outTokens);
  const cost = usage.cost !== undefined ? `$${usage.cost.toFixed(7)}` : (usage.cost_details?.upstream_inference_cost ? `$${usage.cost_details.upstream_inference_cost.toFixed(7)}` : 'N/A');
  const httpStatus = res.status;
  const content = data.choices?.[0]?.message?.content || '';

  const receipt = {
    agent: 'Gemini',
    modelRequested: 'google/gemini-2.5-flash',
    modelReturned,
    actualProvider: provider,
    generationId,
    inputTokens: inTokens,
    outputTokens: outTokens,
    totalTokens,
    cost,
    httpStatus,
    latency: `${latencySec}s`,
    timestamp: new Date().toISOString(),
  };

  console.log('\n=== REAL GEMINI API RECEIPT ===');
  console.log(JSON.stringify(receipt, null, 2));

  fs.writeFileSync('scripts/last_gemini_review_response.json', JSON.stringify({ receipt, content }, null, 2), 'utf8');
  console.log('\n=== GEMINI REVIEW CONTENT ===\n');
  console.log(content);
}

runGeminiReview().catch(console.error);
