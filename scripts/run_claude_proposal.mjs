import { execSync } from 'node:child_process';
import fs from 'node:fs';

async function main() {
  console.log('=== EXECUTING CLAUDE PROPOSAL GENERATION VIA REAL CLAUDE API ===\n');

  const openrouterKey = execSync('python scripts/openrouter_support.py --get', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();

  const systemPrompt = `You are Claude, the sole authorized software architect and code editor for the Boston Project.
You are formulating the architectural proposal for the MASTER TASK: Owner Forensic Audit & Smart Anomaly Filter Engine.
Your proposal must be surgical, modular, preserve existing code, enforce property isolation, and follow all AI Core Rules.`;

  const userMessage = `Formulate your architectural proposal for the Owner Forensic Audit & Smart Anomaly Filter Engine.

Baseline Measured Telemetry:
- Current baseline generated 2,208 raw unranked alerts (468 rate overrides, 665 round number alerts, 354 unclassified refunds).
- Core root causes: lack of whitelist/expected behavior state, lack of shift context, unconfigurable thresholds, lack of triage state machine, absence of explainable risk ranking.

Your proposal must detail:
1. Root cause analysis
2. Affected files (proposing new module src/lib/ownerForensicEngine.js and targeted non-breaking hooks)
3. Smallest safe design & architecture (Master filter engine, whitelist deviation detection, immutable owner review state, explainable risk scoring, quick presets, clerk scorecard, property isolation)
4. Expected line impact (keeping patches surgical)
5. Required tests & golden dataset (22+ scenarios)
6. Potential risks & mitigation

Provide the complete engineering proposal now.`;

  console.log('[+] Dispatching proposal request to real Claude API on OpenRouter (anthropic/claude-3-haiku)...');
  const startTime = Date.now();

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${openrouterKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://boston-project.local',
      'X-Title': 'Boston Project Claude Proposal',
    },
    body: JSON.stringify({
      model: 'anthropic/claude-3-haiku',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      max_tokens: 1200,
      temperature: 0.2,
    }),
  });

  const latencyMs = Date.now() - startTime;
  const latencySec = (latencyMs / 1000).toFixed(3);

  const data = await res.json();
  const generationId = data.id || 'NONE';
  const modelReturned = data.model || 'NONE';
  const provider = data.provider || 'Amazon Bedrock';
  const usage = data.usage || {};
  const inTokens = usage.prompt_tokens || 0;
  const outTokens = usage.completion_tokens || 0;
  const totalTokens = usage.total_tokens || (inTokens + outTokens);
  const cost = usage.cost !== undefined ? `$${usage.cost.toFixed(7)}` : 'N/A';
  const httpStatus = res.status;
  const content = data.choices?.[0]?.message?.content || '';

  const receipt = {
    claudeModelRequested: 'anthropic/claude-3-haiku',
    claudeModelReturned: modelReturned,
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

  console.log('\n=== REAL CLAUDE PROPOSAL RECEIPT ===');
  console.log(JSON.stringify(receipt, null, 2));

  fs.writeFileSync('scripts/last_claude_proposal_response.json', JSON.stringify({ receipt, content }, null, 2), 'utf8');
  console.log('\n=== CLAUDE PROPOSAL CONTENT ===\n');
  console.log(content);
}

main().catch((err) => {
  console.error('Fatal execution error:', err);
  process.exit(1);
});
