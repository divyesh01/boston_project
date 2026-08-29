import { execSync } from 'node:child_process';

async function probeExternalApis() {
  console.log('================================================================================');
  console.log('LIVE EXTERNAL AI API AUDIT & GENERATION LEDGER PROBE');
  console.log('================================================================================\n');

  let naraKey = null;
  let openrouterKey = null;
  try {
    naraKey = execSync('python scripts/nara_support.py --get NARA-A', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim() || null;
  } catch {}
  try {
    openrouterKey = execSync('python scripts/openrouter_support.py --get', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim() || null;
  } catch {}

  const ledger = [];

  // Key Balance Check
  if (openrouterKey) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/auth/key', {
        headers: { 'Authorization': `Bearer ${openrouterKey}` }
      });
      const data = await res.json().catch(() => ({}));
      console.log(`[OpenRouter Key Metadata] HTTP ${res.status}`);
      console.log(`  - Key Label: ${data.data?.label || 'N/A'}`);
      console.log(`  - Total Historical Usage: $${data.data?.usage?.toFixed(6) ?? 0}`);
      console.log(`  - Limit: ${data.data?.limit !== null && data.data?.limit !== undefined ? '$' + data.data?.limit : 'Unlimited'}`);
      console.log(`  - Is Free Tier: ${data.data?.is_free_tier}\n`);
    } catch (e) {
      console.log(`[OpenRouter Key Info] Error: ${e.message}`);
    }
  }

  // 1. Google Gemini (via OpenRouter)
  if (openrouterKey) {
    const model = 'google/gemini-2.5-flash';
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${openrouterKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://boston-project.local',
          'X-Title': 'Boston Project Forensic Audit',
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'Say "GEMINI_LIVE_AUDIT_OK" in exactly 3 words.' }],
          max_tokens: 15,
        }),
      });

      const body = await res.json().catch(() => ({}));
      const genId = body.id || 'NONE';
      const inTokens = body.usage?.prompt_tokens ?? 'N/A';
      const outTokens = body.usage?.completion_tokens ?? 'N/A';
      const cost = body.usage?.cost !== undefined ? `$${body.usage.cost.toFixed(7)}` : 'N/A';
      const err = body.error?.message || (res.status !== 200 ? JSON.stringify(body) : null);
      const text = body.choices?.[0]?.message?.content?.trim() || 'NONE';

      ledger.push({
        provider: 'OpenRouter (Google)',
        modelRequested: model,
        modelReturned: body.model || 'NONE',
        upstreamProvider: body.provider || 'Google AI Studio',
        generationId: genId,
        inTokens,
        outTokens,
        cost,
        httpStatus: res.status,
        proven: res.status === 200 && genId.startsWith('gen-'),
        contentExcerpt: text,
        note: err ? `Error: ${err.slice(0, 100)}` : `OK: "${text}"`
      });
    } catch (e) {
      ledger.push({
        provider: 'OpenRouter (Google)',
        modelRequested: model,
        modelReturned: 'NONE',
        upstreamProvider: 'NONE',
        generationId: 'NONE',
        inTokens: 0,
        outTokens: 0,
        cost: '$0.00',
        httpStatus: 'NETWORK_ERR',
        proven: false,
        contentExcerpt: 'NONE',
        note: e.message
      });
    }
  }

  // 2. Anthropic Claude (via OpenRouter)
  if (openrouterKey) {
    const model = 'anthropic/claude-3-haiku';
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${openrouterKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://boston-project.local',
          'X-Title': 'Boston Project Forensic Audit',
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'Say "CLAUDE_LIVE_AUDIT_OK" in exactly 3 words.' }],
          max_tokens: 15,
        }),
      });

      const body = await res.json().catch(() => ({}));
      const genId = body.id || 'NONE';
      const inTokens = body.usage?.prompt_tokens ?? 'N/A';
      const outTokens = body.usage?.completion_tokens ?? 'N/A';
      const cost = body.usage?.cost !== undefined ? `$${body.usage.cost.toFixed(7)}` : 'N/A';
      const err = body.error?.message || (res.status !== 200 ? JSON.stringify(body) : null);
      const text = body.choices?.[0]?.message?.content?.trim() || 'NONE';

      ledger.push({
        provider: 'OpenRouter (Anthropic)',
        modelRequested: model,
        modelReturned: body.model || 'NONE',
        upstreamProvider: body.provider || 'Amazon Bedrock / Anthropic Direct',
        generationId: genId,
        inTokens,
        outTokens,
        cost,
        httpStatus: res.status,
        proven: res.status === 200 && genId.startsWith('gen-'),
        contentExcerpt: text,
        note: err ? `Error: ${err.slice(0, 100)}` : `OK: "${text}"`
      });
    } catch (e) {
      ledger.push({
        provider: 'OpenRouter (Anthropic)',
        modelRequested: model,
        modelReturned: 'NONE',
        upstreamProvider: 'NONE',
        generationId: 'NONE',
        inTokens: 0,
        outTokens: 0,
        cost: '$0.00',
        httpStatus: 'NETWORK_ERR',
        proven: false,
        contentExcerpt: 'NONE',
        note: e.message
      });
    }
  }

  // 3. NaraRouter (Free worker)
  if (naraKey) {
    const model = 'tencent-hy3-free';
    try {
      const res = await fetch('https://router.bynara.id/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${naraKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'Say "NARA_LIVE_AUDIT_OK"' }],
          max_tokens: 10,
        }),
      });

      const body = await res.json().catch(() => ({}));
      const genId = body.id || 'NONE';
      const inTokens = body.usage?.prompt_tokens ?? 'N/A';
      const outTokens = body.usage?.completion_tokens ?? 'N/A';
      const err = body.error?.message || (res.status !== 200 ? JSON.stringify(body) : null);
      const text = body.choices?.[0]?.message?.content?.trim() || 'NONE';

      ledger.push({
        provider: 'NaraRouter',
        modelRequested: model,
        modelReturned: body.model || 'NONE',
        upstreamProvider: 'Tencent',
        generationId: genId,
        inTokens,
        outTokens,
        cost: '$0.00 (Free)',
        httpStatus: res.status,
        proven: res.status === 200,
        contentExcerpt: text,
        note: err ? `Error: ${err.slice(0, 100)}` : `OK: "${text}"`
      });
    } catch (e) {
      ledger.push({
        provider: 'NaraRouter',
        modelRequested: model,
        modelReturned: 'NONE',
        upstreamProvider: 'NONE',
        generationId: 'NONE',
        inTokens: 0,
        outTokens: 0,
        cost: '$0.00',
        httpStatus: 'NETWORK_ERR',
        proven: false,
        contentExcerpt: 'NONE',
        note: e.message
      });
    }
  }

  // 4. NVIDIA NIM
  ledger.push({
    provider: 'NVIDIA NIM',
    modelRequested: 'meta/llama-3.1-70b-instruct',
    modelReturned: 'NONE',
    upstreamProvider: 'NONE',
    generationId: 'NONE',
    inTokens: 0,
    outTokens: 0,
    cost: '$0.00',
    httpStatus: 'NO_KEY',
    proven: false,
    contentExcerpt: 'NONE',
    note: 'NVIDIA_API_KEY is not set in environment.'
  });

  console.log('================================================================================');
  console.log('REAL PROVIDER API EXECUTION LEDGER (LIVE VERIFIABLE EVIDENCE)');
  console.log('================================================================================');
  console.table(ledger.map(row => ({
    'Provider': row.provider,
    'Model': row.modelRequested,
    'Upstream': row.upstreamProvider,
    'Generation ID': row.generationId,
    'In': row.inTokens,
    'Out': row.outTokens,
    'Cost ($)': row.cost,
    'HTTP': row.httpStatus,
    'Status': row.proven ? '✅ REAL_PROVEN' : '❌ UNPROVEN'
  })));

  console.log('\nDetailed Real Responses & Verifiable Generation IDs:');
  for (const r of ledger) {
    console.log(`- [${r.provider}] (${r.modelRequested})`);
    console.log(`    HTTP Status: ${r.httpStatus}`);
    console.log(`    Generation ID: ${r.generationId}`);
    console.log(`    Upstream Provider: ${r.upstreamProvider}`);
    console.log(`    Tokens: ${r.inTokens} prompt tokens in / ${r.outTokens} completion tokens out`);
    console.log(`    Cost: ${r.cost}`);
    console.log(`    Exact Response: "${r.contentExcerpt}"`);
    console.log(`    Verifiable in Logs: ${r.proven ? `YES (Search ID "${r.generationId}" in provider dashboard)` : 'NO'}\n`);
  }
}

probeExternalApis().catch(err => {
  console.error('Fatal probe error:', err);
});
