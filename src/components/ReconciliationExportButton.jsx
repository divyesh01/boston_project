import React, { useState } from 'react';
import { Download, Check, AlertCircle } from 'lucide-react';
import { exportReconciliationToCsv } from '@/lib/reconciliationExport';

export default function ReconciliationExportButton({ reconciliationData, propertyName = 'Property' }) {
  const [status, setStatus] = useState('idle'); // idle | exporting | success | error

  const handleExport = () => {
    try {
      setStatus('exporting');
      exportReconciliationToCsv(reconciliationData, propertyName);
      setStatus('success');
      setTimeout(() => setStatus('idle'), 2500);
    } catch (err) {
      console.error('Export failed:', err);
      setStatus('error');
      setTimeout(() => setStatus('idle'), 3000);
    }
  };

  return (
    <button
      type="button"
      onClick={handleExport}
      disabled={status === 'exporting' || !reconciliationData?.days?.length}
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition shadow-sm ${
        status === 'success'
          ? 'bg-emerald-50 text-emerald-700 border-emerald-300'
          : status === 'error'
          ? 'bg-red-50 text-red-700 border-red-300'
          : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
      } disabled:opacity-50 disabled:cursor-not-allowed`}
    >
      {status === 'success' ? (
        <>
          <Check className="h-3.5 w-3.5 text-emerald-600" />
          <span>Downloaded CSV</span>
        </>
      ) : status === 'error' ? (
        <>
          <AlertCircle className="h-3.5 w-3.5 text-red-600" />
          <span>Export Failed</span>
        </>
      ) : (
        <>
          <Download className="h-3.5 w-3.5 text-gray-600" />
          <span>Export Reconciliation</span>
        </>
      )}
    </button>
  );
}
