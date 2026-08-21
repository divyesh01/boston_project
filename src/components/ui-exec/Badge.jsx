import React from "react";
import { ArrowUp, ArrowDown, Minus, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

// Compact delta / status indicator for metric surfaces.
//
// Every tone ships a GLYPH, not just a colour. That is a hard requirement, not
// polish: WCAG 1.4.1 (Use of Colour) is failed by a badge that encodes "down"
// purely as red, and the ui-ux-pro-max `ux` domain flags colour-only meaning at
// severity High. It also covers the ~8% of male users with red/green CVD, who
// are a meaningful slice of any hotel's back-office staff. So a negative badge
// reads "▼ 4.2%" even in greyscale.
//
// Colours come from the LOCKED semantic data palette in index.css, never from
// the chrome accent — profit and loss must stay hue-distinct.

const TONES = {
  positive: { color: "var(--data-positive)", wash: "rgba(0, 224, 150, 0.10)", ring: "rgba(0, 224, 150, 0.22)", Icon: ArrowUp },
  negative: { color: "var(--data-negative)", wash: "rgba(255, 107, 107, 0.10)", ring: "rgba(255, 107, 107, 0.22)", Icon: ArrowDown },
  warning:  { color: "var(--data-warning)",  wash: "rgba(255, 181, 71, 0.10)",  ring: "rgba(255, 181, 71, 0.22)",  Icon: AlertTriangle },
  neutral:  { color: "var(--t-secondary)",   wash: "rgba(255, 255, 255, 0.05)", ring: "var(--line)",               Icon: Minus },
};

/**
 * Resolve a tone from a signed number when the caller has a delta but no
 * explicit tone. `flat` at exactly 0 avoids calling a no-change "negative".
 */
export function toneFromDelta(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v === 0) return "neutral";
  return v > 0 ? "positive" : "negative";
}

export default function Badge(
  /** @type {{
   *   children?: import('react').ReactNode;
   *   tone?: 'positive' | 'negative' | 'warning' | 'neutral';
   *   icon?: boolean;
   *   title?: string;
   *   className?: string;
   * }} */
  { children, tone = "neutral", icon = true, title, className = "" }
) {
  const t = TONES[tone] ?? TONES.neutral;
  const { Icon } = t;

  return (
    <span
      title={title}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5",
        "text-[11px] font-semibold leading-none",
        "u-figure",
        className
      )}
      style={{
        color: t.color,
        backgroundColor: t.wash,
        boxShadow: `inset 0 0 0 1px ${t.ring}`,
      }}
    >
      {icon && <Icon className="h-3 w-3 shrink-0" strokeWidth={2.75} aria-hidden="true" />}
      {children}
    </span>
  );
}
