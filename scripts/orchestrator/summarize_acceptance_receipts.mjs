import fs from 'node:fs';

const receipts = fs.readFileSync('.agent-runs/session-acceptance-task-active-active-002/receipts/agent_receipts.txt', 'utf8');
const blocks = receipts.split('====================================================\nAGENT USAGE RECEIPT\n====================================================\n').filter(Boolean);

console.log('Total receipt blocks:', blocks.length);

let totalIn = 0;
let totalOut = 0;
let totalAll = 0;
let totalCost = 0.0;
const waveADistribution = { TABITOKEN: 0, GOROUTER: 0 };
const receiptsSummary = [];

for (const b of blocks) {
  const roleMatch = b.match(/Role:\s*([^\n]+)/);
  const transMatch = b.match(/Transport Provider:\s*([^\n]+)/);
  const actMatch = b.match(/Actual Provider:\s*([^\n]+)/);
  const modelMatch = b.match(/Returned Model:\s*([^\n]+)/);
  const inMatch = b.match(/Input Tokens:\s*(\d+)/);
  const outMatch = b.match(/Output Tokens:\s*(\d+)/);
  const totalMatch = b.match(/Total Tokens:\s*(\d+)/);
  const resMatch = b.match(/Result:\s*([^\n]+)/);
  const genMatch = b.match(/Generation \/ Request \/ Correlation ID:\s*([^\n]+)/);
  const latMatch = b.match(/Latency:\s*([0-9.]+)s/);
  const startMatch = b.match(/Start Timestamp:\s*([^\n]+)/);
  const finishMatch = b.match(/Completion Timestamp:\s*([^\n]+)/);
  const costMatch = b.match(/Estimated Cost:\s*\$([0-9.]+)/);

  const role = roleMatch ? roleMatch[1].trim() : 'UNKNOWN';
  const transport = transMatch ? transMatch[1].trim() : 'UNKNOWN';
  const actual = actMatch ? actMatch[1].trim() : 'UNKNOWN';
  const model = modelMatch ? modelMatch[1].trim() : 'UNKNOWN';
  const inTok = inMatch ? parseInt(inMatch[1], 10) : 0;
  const outTok = outMatch ? parseInt(outMatch[1], 10) : 0;
  const tTok = totalMatch ? parseInt(totalMatch[1], 10) : (inTok + outTok);
  const result = resMatch ? resMatch[1].trim() : 'UNKNOWN';
  const genId = genMatch ? genMatch[1].trim() : 'NONE';
  const lat = latMatch ? parseFloat(latMatch[1]) : 0;
  const start = startMatch ? startMatch[1].trim() : 'N/A';
  const finish = finishMatch ? finishMatch[1].trim() : 'N/A';
  const cost = costMatch ? parseFloat(costMatch[1]) : 0.0;

  totalIn += inTok;
  totalOut += outTok;
  totalAll += tTok;
  totalCost += cost;

  if (role.startsWith('CLAUDE_OPUS') && role !== 'CLAUDE_OPUS_AUTHORITATIVE_SYNTHESIS') {
    if (transport === 'TABITOKEN') waveADistribution.TABITOKEN++;
    if (transport === 'GOROUTER') waveADistribution.GOROUTER++;
  }

  receiptsSummary.push({ role, transport, actual, model, genId, start, finish, lat, inTok, outTok, tTok, cost, result });
}

console.log('\n--- WAVE A LOAD DISTRIBUTION ---');
console.log('Tabitoken Wave A workers:', waveADistribution.TABITOKEN);
console.log('GoRouter Wave A workers:', waveADistribution.GOROUTER);
console.log('Exact 2 Tabitoken + 2 GoRouter balance achieved:', (waveADistribution.TABITOKEN === 2 && waveADistribution.GOROUTER === 2) ? 'YES' : 'NO');

console.log('\n--- SUMMARY ---');
console.log('Grand Total Input Tokens:', totalIn);
console.log('Grand Total Output Tokens:', totalOut);
console.log('Grand Total Tokens:', totalAll);
console.log('Grand Total Estimated Cost: $' + totalCost.toFixed(5));

console.log('\n--- CALL DETAILS ---');
console.log(JSON.stringify(receiptsSummary, null, 2));
