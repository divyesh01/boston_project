import React, { useState } from "react";
import { Download, Copy, Check } from "lucide-react";
import { exportChartPng, copyChartToClipboard } from "@/lib/chartExport";

export default function ChartToolbar(
  /** @type {{ targetRef: any; title?: any; dateRange?: any }} */
  { targetRef, title, dateRange }) {
  const [busy, setBusy] = useState(null);
  const [copied, setCopied] = useState(false);

  const handlePng = async () => {
    if (!targetRef?.current) return;
    setBusy("png");
    try {
      await exportChartPng(targetRef.current, `${(title || "chart").replace(/[^a-z0-9]/gi, "_")}.png`, title, dateRange);
    } catch (e) {
      console.error(e);
    }
    setBusy(null);
  };

  const handleCopy = async () => {
    if (!targetRef?.current) return;
    setBusy("copy");
    try {
      await copyChartToClipboard(targetRef.current, title, dateRange);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.error(e);
    }
    setBusy(null);
  };

  return (
    <div className="flex gap-2">
      <button
        onClick={handlePng}
        disabled={!!busy}
        className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-[#0A1628] px-3 py-1.5 text-xs text-slate-300 transition-colors hover:border-[#00D4FF]/60 hover:text-white disabled:opacity-50"
      >
        <Download className="h-3.5 w-3.5" /> {busy === "png" ? "Saving…" : "PNG"}
      </button>
      <button
        onClick={handleCopy}
        disabled={!!busy}
        className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-[#0A1628] px-3 py-1.5 text-xs text-slate-300 transition-colors hover:border-[#00D4FF]/60 hover:text-white disabled:opacity-50"
      >
        {copied ? <Check className="h-3.5 w-3.5 text-[#00E096]" /> : <Copy className="h-3.5 w-3.5" />}
        {busy === "copy" ? "Copying…" : copied ? "Copied!" : "Copy"}
      </button>
    </div>
  );
}