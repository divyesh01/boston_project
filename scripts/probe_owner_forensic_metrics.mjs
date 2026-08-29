import fs from 'node:fs';
import { parseCsvText } from '../src/lib/csvParser.js';
import { mapTransactionRow, isTrailerRow } from '../src/lib/transactionNorm.js';
import { scanAdjustmentsRefunds } from '../src/lib/reportParsers.js';
import { detectAnomalies, detectClerkAnomalies } from '../src/lib/anomalyDetector.js';
import {
  evaluateForensicAuditBatch,
  SEVERITY_LEVELS,
  REVIEW_STATES,
} from '../src/lib/ownerForensicEngine.js';

async function main() {
  console.log('=== BEFORE VS AFTER OWNER FORENSIC AUDIT TELEMETRY ===\n');

  const txnCsv = fs.readFileSync('scripts/data/All Transactions.csv', 'utf8');
  const adjCsv = fs.readFileSync('scripts/data/Adjustments and Refunds Activity.csv', 'utf8');

  const txnRows = parseCsvText(txnCsv);
  const adjRows = parseCsvText(adjCsv);

  const txnHeaders = txnRows[0];
  const coercions = [];
  const normalizedTxns = [];
  for (let i = 1; i < txnRows.length; i++) {
    const row = mapTransactionRow(txnHeaders, txnRows[i], coercions);
    if (!isTrailerRow(row) && row.date) {
      normalizedTxns.push(row);
    }
  }

  const scannedAdj = scanAdjustmentsRefunds(adjRows, { propertyId: 'prop_1' });

  // 1. Before (Legacy)
  const legacyTxnFlags = detectAnomalies(normalizedTxns);
  const legacyClerkFlags = detectClerkAnomalies(scannedAdj);
  const totalLegacyFlags = legacyTxnFlags.length + legacyClerkFlags.flaggedAnomalies.length;

  // 2. After (Owner Forensic Engine)
  const evaluatedBatch = evaluateForensicAuditBatch({
    transactions: normalizedTxns,
    adjustments: scannedAdj.adjustments,
    refunds: scannedAdj.refunds,
    propertyAdrMap: { prop_1: 110.0, default: 110.0 },
  });

  const { anomalies, summary } = evaluatedBatch;

  console.log('--- BEFORE (LEGACY SYSTEM) ---');
  console.log(`Total Raw Alerts: ${totalLegacyFlags}`);
  console.log(`  - Transaction Alerts: ${legacyTxnFlags.length}`);
  console.log(`  - Clerk Activity Alerts: ${legacyClerkFlags.flaggedAnomalies.length}`);

  console.log('\n--- AFTER (OWNER FORENSIC ENGINE) ---');
  console.log(`Total Candidates Evaluated: ${summary.totalRawEvaluated}`);
  console.log(`Expected / Routine Postings: ${summary.expectedCount}`);
  console.log(`Whitelisted Stays: ${summary.whitelistedCount}`);
  console.log(`Low Severity (Minor/Info): ${summary.lowCount}`);
  console.log(`Medium Severity (Review): ${summary.mediumCount}`);
  console.log(`High Severity (Escalated Review): ${summary.highCount}`);
  console.log(`CRITICAL Severity (Immediate Action): ${summary.criticalCount}`);
  console.log(`\nOwner Priority Triage Inbox Queue (Critical + High): ${summary.criticalCount + summary.highCount} (down from ${totalLegacyFlags} raw alerts!)`);
}

main().catch(console.error);
