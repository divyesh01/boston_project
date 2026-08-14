import { Inbox, AlertTriangle, RefreshCw } from "lucide-react";

export function EmptyState({ icon: Icon = Inbox, title, description, action = null, className = "" }) {
  return (
    <div className={`flex flex-col items-center justify-center rounded-2xl border border-white/5 bg-[#0A1628]/40 px-6 py-12 text-center ${className}`}>
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-white/5 text-slate-400">
        <Icon className="h-6 w-6" />
      </div>
      <h3 className="text-sm font-medium text-slate-200">{title}</h3>
      {description && <p className="mt-1 max-w-sm text-xs text-slate-500">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ title = "Something went wrong", description, error, onRetry, className = "" }) {
  return (
    <div className={`flex flex-col items-center justify-center rounded-2xl border border-red-500/20 bg-red-500/[0.04] px-6 py-12 text-center ${className}`}>
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-500/10 text-red-400">
        <AlertTriangle className="h-6 w-6" />
      </div>
      <h3 className="text-sm font-medium text-red-200">{title}</h3>
      {description && <p className="mt-1 max-w-sm text-xs text-slate-400">{description}</p>}
      {error && (
        <p className="mt-2 max-w-sm break-words text-[11px] text-red-300/70">
          {String(error?.message || error)}
        </p>
      )}
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-4 inline-flex items-center gap-2 rounded-lg bg-[#6C63FF] px-4 py-2 text-sm font-medium text-white hover:bg-[#5b52e8]"
        >
          <RefreshCw className="h-4 w-4" /> Try again
        </button>
      )}
    </div>
  );
}
