import React, { useState } from "react";
import { X, Percent, ToggleLeft, ToggleRight, Save } from "lucide-react";
import { getTaxConfig, setTaxConfig, formatTaxRate } from "@/lib/taxConfig";

export default function TaxConfigModal({ open, onClose }) {
  const [config, setConfig] = useState(getTaxConfig());
  // Closing the dialog is this component's only "saved" signal, so it must not
  // close on a write the browser refused: the tax rate every charge is computed
  // from would still be the old one, with nothing on screen to say so.
  const [saveError, setSaveError] = useState("");

  if (!open) return null;

  const handleSave = () => {
    if (!setTaxConfig(config)) {
      setSaveError(
        "The browser refused to store this tax configuration. The previous tax rate is still being applied to every charge. Storage may be full, or this window may be in private browsing — check the browser console for the key that failed."
      );
      return;
    }
    setSaveError("");
    onClose();
  };

  const toggleSource = (key) => {
    setConfig({
      ...config,
      sources: config.sources.map((s) =>
        s.key === key ? { ...s, taxable: !s.taxable } : s
      ),
    });
  };

  const ratePercent = (Number(config.taxRate) || 0) * 100;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-[#151921] p-6 shadow-2xl">
        <div className="mb-5 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Percent className="h-5 w-5 text-[#00D4FF]" />
            <h2 className="font-heading text-lg font-semibold text-white">Tax Configuration</h2>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Tax Enable Toggle */}
        <div className="mb-5 flex items-center justify-between rounded-xl border border-white/5 bg-[#0b0e14] px-4 py-3">
          <div>
            <p className="text-sm font-medium text-white">Apply Tax</p>
            <p className="text-xs text-slate-500">Enable or disable tax calculation globally</p>
          </div>
          <button onClick={() => setConfig({ ...config, taxEnabled: !config.taxEnabled })}>
            {config.taxEnabled ? (
              <ToggleRight className="h-7 w-7 text-[#00E096]" />
            ) : (
              <ToggleLeft className="h-7 w-7 text-slate-600" />
            )}
          </button>
        </div>

        {/* Tax Rate Input */}
        <div className="mb-5">
          <label className="mb-1.5 block text-xs font-medium uppercase tracking-widest text-slate-400">
            Tax Rate (%)
          </label>
          <div className="relative">
            <input
              type="number"
              step="0.01"
              value={ratePercent.toFixed(2)}
              onChange={(e) => {
                const pct = parseFloat(e.target.value) || 0;
                setConfig({ ...config, taxRate: pct / 100 });
              }}
              disabled={!config.taxEnabled}
              className="w-full rounded-lg border border-white/10 bg-[#0b0e14] px-4 py-2.5 text-sm text-white outline-none focus:border-[#00D4FF] disabled:opacity-40"
            />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-slate-500">%</span>
          </div>
          <p className="mt-1 text-xs text-slate-500">
            Combined tax rate · Currently {formatTaxRate(config.taxRate)}
          </p>
        </div>

        {/* Formula Display */}
        <div className="mb-5 rounded-xl border border-[#00D4FF]/15 bg-[#00D4FF]/[0.04] p-3">
          <p className="text-xs text-slate-400">Formula</p>
          <p className="mt-1 font-mono text-sm text-[#00D4FF]">
            Tax = Room Rent × {formatTaxRate(config.taxRate)}
          </p>
          <div className="mt-2 space-y-0.5 text-xs text-slate-500">
            <p>$100 × {formatTaxRate(config.taxRate)} = ${(100 * config.taxRate).toFixed(2)}</p>
            <p>$200 × {formatTaxRate(config.taxRate)} = ${(200 * config.taxRate).toFixed(2)}</p>
            <p>$300 × {formatTaxRate(config.taxRate)} = ${(300 * config.taxRate).toFixed(2)}</p>
          </div>
        </div>

        {/* Per-Source Tax Toggles */}
        <div className="mb-5">
          <p className="mb-2 text-xs font-medium uppercase tracking-widest text-slate-400">
            Taxable Booking Sources
          </p>
          <div className="space-y-1.5">
            {config.sources.map((src) => (
              <button
                key={src.key}
                onClick={() => toggleSource(src.key)}
                disabled={!config.taxEnabled}
                className="flex w-full items-center justify-between rounded-lg border border-white/5 bg-[#0b0e14] px-4 py-2.5 text-left transition-colors hover:border-white/10 disabled:opacity-40"
              >
                <span className="text-sm text-slate-200">{src.label}</span>
                {src.taxable ? (
                  <span className="flex items-center gap-1 text-xs text-[#00E096]">
                    <ToggleRight className="h-5 w-5" /> Taxable
                  </span>
                ) : (
                  <span className="flex items-center gap-1 text-xs text-slate-500">
                    <ToggleLeft className="h-5 w-5" /> Exempt
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>

        {/* Actions */}
        {saveError ? (
          <p
            role="alert"
            className="mb-3 rounded-lg border border-[#FF6B6B]/30 bg-[#FF6B6B]/[0.08] px-3 py-2 text-xs text-[#FFB4B4]"
          >
            {saveError}
          </p>
        ) : null}
        <div className="flex justify-end gap-3">
          <button
            onClick={onClose}
            className="rounded-lg border border-white/10 px-4 py-2 text-sm text-slate-300 hover:bg-white/5"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="flex items-center gap-1.5 rounded-lg bg-[#6C63FF] px-4 py-2 text-sm font-medium text-white hover:bg-[#5b52e8]"
          >
            <Save className="h-4 w-4" /> Save Tax Config
          </button>
        </div>
      </div>
    </div>
  );
}