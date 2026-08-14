import React, { useState } from 'react';
import { ShieldCheck, Copy, Download, Check, AlertTriangle } from 'lucide-react';
import { sanitizeText as sanitizeInput } from '@/lib/securityUtils';

export default function MFARecoveryModal({ isOpen, onClose, recoveryCodes = [], username = 'User' }) {
  const [copied, setCopied] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

  if (!isOpen) return null;

  const handleCopyAll = () => {
    navigator.clipboard.writeText(recoveryCodes.join('\n'));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    const text = `RED ROOF INTELLIGENCE — MFA RECOVERY CODES\nAccount: ${username}\nGenerated: ${new Date().toLocaleString()}\n\nKeep these single-use codes in a safe place:\n\n${recoveryCodes.join('\n')}\n`;
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `mfa-recovery-codes-${username}.txt`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl border border-gray-100">
        <div className="flex items-center gap-3 text-red-700">
          <div className="rounded-full bg-red-100 p-2.5">
            <ShieldCheck className="h-6 w-6" />
          </div>
          <div>
            <h3 className="text-lg font-bold text-gray-900">Save Your Backup Codes</h3>
            <p className="text-xs text-gray-500">Single-use emergency login codes</p>
          </div>
        </div>

        <div className="my-4 rounded-lg bg-amber-50 p-3 border border-amber-200 flex items-start gap-2.5 text-xs text-amber-800">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>If you lose access to your authenticator app, these codes are the <strong>only way</strong> to recover your account.</span>
        </div>

        <div className="grid grid-cols-2 gap-2 my-4 rounded-xl bg-gray-50 p-3.5 border border-gray-200">
          {recoveryCodes.map((code, idx) => (
            <div key={idx} className="font-mono text-center text-xs font-semibold text-gray-800 py-1.5 px-2 bg-white rounded border border-gray-100 shadow-sm">
              {sanitizeInput(code)}
            </div>
          ))}
        </div>

        <div className="flex gap-2 my-3">
          <button
            type="button"
            onClick={handleCopyAll}
            className="flex-1 inline-flex items-center justify-center gap-1.5 py-2 px-3 text-xs font-medium rounded-lg border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 transition"
          >
            {copied ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
            {copied ? 'Copied' : 'Copy All'}
          </button>
          <button
            type="button"
            onClick={handleDownload}
            className="flex-1 inline-flex items-center justify-center gap-1.5 py-2 px-3 text-xs font-medium rounded-lg border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 transition"
          >
            <Download className="h-4 w-4" />
            Download .txt
          </button>
        </div>

        <label className="flex items-center gap-2 text-xs text-gray-600 my-4 cursor-pointer">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
            className="rounded border-gray-300 text-red-600 focus:ring-red-500"
          />
          <span>I have saved these backup codes in a secure location.</span>
        </label>

        <button
          type="button"
          disabled={!acknowledged}
          onClick={onClose}
          className="w-full py-2.5 px-4 text-sm font-semibold rounded-xl text-white bg-red-700 hover:bg-red-800 disabled:opacity-50 disabled:cursor-not-allowed transition shadow-md shadow-red-700/20"
        >
          Complete Setup
        </button>
      </div>
    </div>
  );
}
