// src/components/dashboard/OwnerPacketPreview.jsx
// Visual executive preview card summarizing the 5-sheet Monthly Owner Performance Packet.

import React from 'react';
import { FileSpreadsheet, CheckCircle2, ShieldCheck, Download, ChevronRight } from 'lucide-react';
import Card from '@/components/ui-exec/Card';
import { money } from '@/lib/hotel';

export default function OwnerPacketPreview({
  onDownloadPacket,
  revenue = 1020598.17,
  roomsSold = 12362,
  occupancy = 0.578,
  propertiesCount = 2,
  isExporting = false,
}) {
  const sheets = [
    { num: 1, name: 'Executive Summary', detail: 'Portfolio ADR, RevPAR, Net Kept & Headline KPIs' },
    { num: 2, name: 'Property Performance', detail: 'Volume vs Rate Effect Variance Decomposition' },
    { num: 3, name: 'OTA & Channel Economics', detail: 'Channel Net Take-Home & Direct Booking Shift' },
    { num: 4, name: 'Data Health & Audit', detail: 'Cent-Exact Ledger Reconciliation ($0.00 Discrepancy)' },
    { num: 5, name: 'Provenance & Controls', detail: 'Immutable SHA-256 Raw File Audit Signatures' },
  ];

  return (
    <Card className="border border-white/10 bg-slate-900/90 p-5 shadow-xl backdrop-blur-md">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-white/5 pb-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-500/10 text-amber-400 border border-amber-500/20">
            <FileSpreadsheet className="h-5 w-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-white tracking-wide">
                Owner Performance Packet (.xlsx)
              </h3>
              <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-300 border border-amber-500/20">
                5-Sheet Multi-Property
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              Executive Excel workbook compiled with integer-cent reconciliation.
            </p>
          </div>
        </div>

        <button
          onClick={onDownloadPacket}
          disabled={isExporting}
          className="flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-emerald-600/20 hover:from-emerald-500 hover:to-teal-500 active:scale-[0.98] transition-all disabled:opacity-50"
        >
          <Download className="h-3.5 w-3.5" />
          {isExporting ? 'Generating...' : 'Download Packet'}
        </button>
      </div>

      <div className="mt-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-2.5">
        {sheets.map((sheet) => (
          <div
            key={sheet.num}
            className="rounded-xl border border-white/5 bg-slate-800/40 p-3 flex flex-col justify-between hover:border-amber-500/30 transition-colors"
          >
            <div>
              <div className="flex items-center justify-between text-[11px] font-mono text-slate-500">
                <span>SHEET 0{sheet.num}</span>
                <CheckCircle2 className="h-3.5 w-3.5 text-amber-400" />
              </div>
              <div className="text-xs font-medium text-slate-200 mt-1.5 font-sans">
                {sheet.name}
              </div>
            </div>
            <div className="text-[10px] text-slate-400 mt-2 line-clamp-2">
              {sheet.detail}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
