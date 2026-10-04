import { sanitizeCsvCell } from './securityUtils';

const csvAmount = (value) => sanitizeCsvCell(value == null || value === '' || !Number.isFinite(Number(value)) ? 'Unavailable' : Number(value).toFixed(2));

/**
 * Exports 3-way financial reconciliation data to a secure CSV file.
 * @param {Object} reconciliationData - Output from reconcileDailyFinancials()
 * @param {string} [propertyName='Property'] - Property identifier for filename
 */
export function exportReconciliationToCsv(reconciliationData, propertyName = 'Portfolio') {
  if (!reconciliationData || !reconciliationData.days || !reconciliationData.days.length) {
    throw new Error('Export Error: No reconciliation records available to export.');
  }

  const headers = [
    'Date',
    'PMS Total Revenue',
    'PMS Card Revenue',
    'PMS Cash Revenue',
    'Merchant Settled Net',
    'Bank Deposited',
    'Card Variance',
    'Audit Status'
  ];

  const rows = reconciliationData.days.map(day => [
    sanitizeCsvCell(day.date),
    csvAmount(day.pmsTotal),
    csvAmount(day.pmsCard),
    csvAmount(day.pmsCash),
    csvAmount(day.merchantSettledNet),
    csvAmount(day.bankDeposited),
    csvAmount(day.cardVariance),
    sanitizeCsvCell(day.status)
  ]);

  // Add Summary Footer Row
  const summary = reconciliationData.periodSummary || {};
  rows.push([]);
  rows.push([
    'TOTALS',
    csvAmount(summary.totalPmsRevenue),
    '',
    '',
    csvAmount(summary.totalMerchantSettled),
    csvAmount(summary.totalBankDeposited),
    csvAmount(summary.netVariance),
    sanitizeCsvCell(summary.reconciliationHealth || 'N/A')
  ]);

  const csvContent = '\uFEFF' + [
    headers.join(','),
    ...rows.map(r => r.join(','))
  ].join('\r\n');

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const safePropName = propertyName.replace(/[^a-zA-Z0-9_-]/g, '_');
  const timestamp = new Date().toISOString().slice(0, 10);

  link.setAttribute('href', url);
  link.setAttribute('download', `Reconciliation_${safePropName}_${timestamp}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
