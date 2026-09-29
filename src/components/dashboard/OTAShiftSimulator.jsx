// src/components/dashboard/OTAShiftSimulator.jsx
// Interactive OTA Direct Shift Simulator. Allows hotel owners to model the EBITDA impact
// of shifting third-party OTA bookings (Expedia, Booking.com) to direct booking channels.

import React, { useState, useMemo } from 'react';
import { ArrowRight, TrendingUp, DollarSign, Percent, ShieldCheck, Sparkles, Sliders } from 'lucide-react';
import Card from '@/components/ui-exec/Card';
import { money, money2 } from '@/lib/hotel';
import { toCents, fromCents } from '@/lib/decimal';

/**
 * Calculates OTA to Direct shift economics with cent-exact integer math.
 *
 * @param {Object} params
 * @param {number} params.grossOtaRevenue Total gross OTA revenue in dollars
 * @param {number} params.shiftPct Percentage of OTA revenue to shift (0 to 50)
 * @param {number} [params.otaCommissionRate=0.16] Weighted OTA commission rate (default 16%)
 * @param {number} [params.directCostRate=0.035] Direct acquisition/engine fee (default 3.5%)
 * @param {number} [params.periodDays=214] Reporting period days for annualization
 * @returns {{
 *   shiftedRevenue: number,
 *   commissionSaved: number,
 *   directCost: number,
 *   netSavings: number,
 *   annualizedGain: number,
 *   effectiveMarginGainPct: number
 * }}
 */
export function calculateOtaShiftEconomics({
  grossOtaRevenue,
  shiftPct,
  otaCommissionRate = 0.16,
  directCostRate = 0.035,
  periodDays = 214,
}) {
  const otaCents = toCents(grossOtaRevenue);
  const shiftRatio = (Number(shiftPct) || 0) / 100;

  const shiftedCents = Math.round(otaCents * shiftRatio);
  const commSavedCents = Math.round(shiftedCents * otaCommissionRate);
  const directCostCents = Math.round(shiftedCents * directCostRate);
  const netSavingsCents = Math.max(0, commSavedCents - directCostCents);

  const days = Math.max(1, Number(periodDays) || 1);
  const annualizedCents = Math.round((netSavingsCents / days) * 365);

  const effectiveMarginGainPct = shiftedCents > 0
    ? Number(((netSavingsCents / shiftedCents) * 100).toFixed(1))
    : 0;

  return {
    shiftedRevenue: fromCents(shiftedCents),
    commissionSaved: fromCents(commSavedCents),
    directCost: fromCents(directCostCents),
    netSavings: fromCents(netSavingsCents),
    annualizedGain: fromCents(annualizedCents),
    effectiveMarginGainPct,
  };
}

export default function OTAShiftSimulator({
  grossOtaRevenue = 136988.58,
  otaCommissionRate = 0.16,
  periodDays = 214,
}) {
  const [shiftPct, setShiftPct] = useState(15); // default 15% target shift

  const results = useMemo(() => {
    return calculateOtaShiftEconomics({
      grossOtaRevenue,
      shiftPct,
      otaCommissionRate,
      periodDays,
    });
  }, [grossOtaRevenue, shiftPct, otaCommissionRate, periodDays]);

  return (
    <Card className="relative overflow-hidden border border-emerald-500/20 bg-gradient-to-br from-slate-900/95 via-slate-900 to-emerald-950/20 p-6 shadow-2xl backdrop-blur-xl">
      <div className="absolute right-0 top-0 -mr-16 -mt-16 h-64 w-64 rounded-full bg-emerald-500/5 blur-3xl" />

      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-white/5 pb-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              <Sliders className="h-4 w-4" />
            </span>
            <h3 className="text-base font-semibold text-white tracking-wide">
              OTA-to-Direct Shift Simulator
            </h3>
            <span className="rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-[11px] font-medium text-emerald-400 border border-emerald-500/20">
              EBITDA Accelerator
            </span>
          </div>
          <p className="mt-1 text-xs text-slate-400">
            Model cash retained by migrating third-party OTA bookings to your direct brand website.
          </p>
        </div>

        <div className="text-right">
          <div className="text-xs text-slate-400">Current Base OTA Volume</div>
          <div className="text-sm font-semibold text-slate-200">{money(grossOtaRevenue)}</div>
        </div>
      </div>

      {/* Interactive Controls & Realtime Results */}
      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Left Column: Interactive Slider */}
        <div className="lg:col-span-5 space-y-5">
          <div>
            <div className="flex justify-between text-xs font-medium text-slate-300 mb-2">
              <span className="flex items-center gap-1.5">
                <Percent className="h-3.5 w-3.5 text-emerald-400" /> Target Direct Shift
              </span>
              <span className="text-base font-bold text-emerald-400">{shiftPct}%</span>
            </div>
            <input
              type="range"
              min="0"
              max="50"
              step="1"
              value={shiftPct}
              onChange={(e) => setShiftPct(Number(e.target.value))}
              className="w-full h-2 rounded-lg bg-slate-700/80 accent-emerald-500 cursor-pointer"
            />
            <div className="flex justify-between text-[10px] text-slate-500 mt-1">
              <span>0% (Status Quo)</span>
              <span>25% (Moderate Target)</span>
              <span>50% (Aggressive Brand Shift)</span>
            </div>
          </div>

          <div className="rounded-xl border border-white/5 bg-slate-800/40 p-4 space-y-2.5 text-xs">
            <div className="flex justify-between text-slate-400">
              <span>Shifted OTA Volume:</span>
              <span className="font-semibold text-slate-200">{money(results.shiftedRevenue)}</span>
            </div>
            <div className="flex justify-between text-slate-400">
              <span>OTA Commission Avoided ({(otaCommissionRate * 100).toFixed(0)}%):</span>
              <span className="font-semibold text-emerald-400">+{money(results.commissionSaved)}</span>
            </div>
            <div className="flex justify-between text-slate-400">
              <span>Direct Acquisition Friction (3.5%):</span>
              <span className="font-semibold text-slate-400">-{money(results.directCost)}</span>
            </div>
            <div className="border-t border-white/5 pt-2 flex justify-between font-medium text-slate-300">
              <span>Net Take-Home Margin:</span>
              <span className="text-emerald-400 font-bold">+{results.effectiveMarginGainPct}%</span>
            </div>
          </div>
        </div>

        {/* Right Column: Hero KPI Readouts */}
        <div className="lg:col-span-7 grid grid-cols-1 sm:grid-cols-2 gap-4">
          {/* Period Net Gain */}
          <div className="rounded-xl border border-emerald-500/30 bg-emerald-950/20 p-5 flex flex-col justify-between">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-emerald-300/80">Period Retained Cash</span>
              <span className="rounded-md bg-emerald-500/20 p-1.5 text-emerald-400">
                <DollarSign className="h-4 w-4" />
              </span>
            </div>
            <div className="my-3">
              <div className="text-2xl font-bold tracking-tight text-white">
                +{money2(results.netSavings)}
              </div>
              <div className="text-[11px] text-emerald-400/80 mt-1 flex items-center gap-1">
                <TrendingUp className="h-3 w-3" /> Direct cash added to bottom line
              </div>
            </div>
            <div className="text-[10px] text-slate-400">
              Over {periodDays} actual business days
            </div>
          </div>

          {/* Annualized Gain */}
          <div className="rounded-xl border border-sky-500/30 bg-sky-950/20 p-5 flex flex-col justify-between">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-sky-300/80">Run-Rate Annualized Gain</span>
              <span className="rounded-md bg-sky-500/20 p-1.5 text-sky-400">
                <Sparkles className="h-4 w-4" />
              </span>
            </div>
            <div className="my-3">
              <div className="text-2xl font-bold tracking-tight text-white">
                +{money(results.annualizedGain)}
              </div>
              <div className="text-[11px] text-sky-400/80 mt-1 flex items-center gap-1">
                <ShieldCheck className="h-3 w-3" /> Projected 12-month EBITDA lift
              </div>
            </div>
            <div className="text-[10px] text-slate-400">
              Assuming sustained {shiftPct}% direct booking share
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}
