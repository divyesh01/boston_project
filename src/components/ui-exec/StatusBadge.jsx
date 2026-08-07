import React from "react";
import { CheckCircle2, Clock4, Eye, PartyPopper, XCircle } from "lucide-react";

// Status badge with emoji + custom icon and a soft pulsing glow.
// Maps payroll/workflow statuses to neon pastel accent colors.
const META = {
  approved: {
    label: "Approved",
    emoji: "✅",
    icon: CheckCircle2,
    text: "text-[#00E096]",
    bg: "bg-[#00E096]/10",
    border: "border-[#00E096]/40",
    glow: "0 0 12px rgba(0,224,150,0.45)",
    pulse: true,
  },
  paid: {
    label: "Paid",
    emoji: "💰",
    icon: PartyPopper,
    text: "text-[#4FE3C1]",
    bg: "bg-[#4FE3C1]/10",
    border: "border-[#4FE3C1]/40",
    glow: "0 0 12px rgba(79,227,193,0.45)",
    pulse: false,
  },
  pending_review: {
    label: "Pending Review",
    emoji: "⏳",
    icon: Eye,
    text: "text-[#FFB547]",
    bg: "bg-[#FFB547]/10",
    border: "border-[#FFB547]/40",
    glow: "0 0 12px rgba(255,181,71,0.45)",
    pulse: true,
  },
  draft: {
    label: "Draft",
    emoji: "📝",
    icon: Clock4,
    text: "text-slate-400",
    bg: "bg-slate-400/10",
    border: "border-slate-400/30",
    glow: "0 0 8px rgba(148,163,184,0.25)",
    pulse: false,
  },
  failed: {
    label: "Failed",
    emoji: "⛔",
    icon: XCircle,
    text: "text-[#FF6B6B]",
    bg: "bg-[#FF6B6B]/10",
    border: "border-[#FF6B6B]/40",
    glow: "0 0 12px rgba(255,107,107,0.45)",
    pulse: true,
  },
  active: {
    label: "Active",
    emoji: "🟢",
    icon: CheckCircle2,
    text: "text-[#00E096]",
    bg: "bg-[#00E096]/10",
    border: "border-[#00E096]/40",
    glow: "0 0 12px rgba(0,224,150,0.45)",
    pulse: true,
  },
  inactive: {
    label: "Inactive",
    emoji: "⚪",
    icon: XCircle,
    text: "text-slate-500",
    bg: "bg-slate-500/10",
    border: "border-slate-500/30",
    glow: "none",
    pulse: false,
  },
};

export default function StatusBadge({ status = "draft", size = "md", onClick = undefined }) {
  const meta = META[status] || { ...META.draft, label: status, emoji: "❔" };
  const Icon = meta.icon;
  const dims = size === "sm" ? "gap-1 px-2 py-0.5 text-[10px]" : "gap-1.5 px-2.5 py-1 text-xs";
  const iconDims = size === "sm" ? "h-3 w-3" : "h-3.5 w-3.5";

  return (
    <span
      onClick={onClick}
      className={`inline-flex select-none items-center rounded-full border font-medium tracking-wide ${dims} ${meta.bg} ${meta.border} ${meta.text} ${onClick ? "cursor-pointer" : "cursor-default"} ${meta.pulse ? "status-pulse" : ""}`}
      style={{ boxShadow: meta.glow }}
      title={meta.label}
    >
      <Icon className={`${iconDims} ${meta.pulse ? "animate-pulse" : ""}`} />
      <span className="hidden sm:inline">{meta.label}</span>
      <span className="sm:hidden">{meta.emoji}</span>
    </span>
  );
}