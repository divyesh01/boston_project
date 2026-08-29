import fs from 'node:fs';
import { parseCsvText } from '../src/lib/csvParser.js';
import { mapTransactionRow, isTrailerRow } from '../src/lib/transactionNorm.js';
import { scanAdjustmentsRefunds } from '../src/lib/reportParsers.js';
import { detectAnomalies, detectClerkAnomalies } from '../src/lib/anomalyDetector.js';

async function probeBaseline() {
  console.log('=== BASELINE ANOMALY DETECTION TELEMETRY ===\n');

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

  const rawTxnAnomalies = detectAnomalies(normalizedTxns);
  const rawClerkAnomalies = detectClerkAnomalies(scannedAdj);

  console.log(`Transactions Scanned: ${normalizedTxns.length}`);
  console.log(`Transaction Anomalies Flagged: ${rawTxnAnomalies.length}`);
  const txnBreakdown = {};
  for (const a of rawTxnAnomalies) {
    txnBreakdown[a.alert_type] = (txnBreakdown[a.alert_type] || 0) + 1;
  }
  console.log('Transaction Anomalies Breakdown:', txnBreakdown);

  console.log(`\nAdjustments/Refunds Scanned: ${scannedAdj.adjustments?.length || 0} adjustments, ${scannedAdj.refunds?.length || 0} refunds`);
  console.log(`Clerk Anomalies Flagged: ${rawClerkAnomalies.flaggedAnomalies.length}`);
  const clerkBreakdown = {};
  for (const a of rawClerkAnomalies.flaggedAnomalies) {
    clerkBreakdown[a.ruleId] = (clerkBreakdown[a.ruleId] || 0) + 1;
  }
  console.log('Clerk Anomalies Breakdown:', clerkBreakdown);
  console.log('\nTotal Raw Alerts Generated in Baseline:', rawTxnAnomalies.length + rawClerkAnomalies.flaggedAnomalies.length);
}

probeBaseline().catch(console.error);
