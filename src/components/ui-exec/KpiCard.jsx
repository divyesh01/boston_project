import React from "react";
import { useCountUp } from "@/lib/useCountUp";
import { cn } from "@/lib/utils";
import Badge from "./Badge";
import Sparkline from "./Sparkline";

/**
 * Infer a badge tone from the SIGN of the delta — never from whether the change
 * is desirable, because this component cannot know. A metric where up is bad
 * (expenses, cancellations, credit-card fees) must pass `deltaTone` explicitly.
 * Guessing "up is good" is how a dashboard ends up celebrating rising costs.
 */
function inferTone(delta) {
  const s = String(delta ?? "").trim();
  if (/^[-−–]/.test(s)) return "negative";
  if (/^\+/.test(s)) return "positive";
  return "neutral";
}

export default function KpiCard(
  /** @type {{
   *   label: string;
   *   value: string | number;
   *   sub?: string | import('react').ReactNode;
   *   accent?: string;
   *   icon?: import('react').ComponentType<{ className?: string; style?: import('react').CSSProperties }>;
   *   countUp?: boolean;
   *   delta?: string | number;
   *   deltaTone?: 'positive' | 'negative' | 'warning' | 'neutral';
   *   deltaTitle?: string;
   *   series?: Array<number>;
   * }} */
  { label, value, sub, accent = "var(--brand)", icon: Icon, countUp = true,
    delta, deltaTone, deltaTitle, series }) {
  // The app's signature moment: the figure rolls up from 0 on first paint and
  // re-rolls whenever it actually changes, so a new date range or a changed
  // credit-card fee rate visibly moves the money instead of silently swapping
  // one string for another.
  //
  // `value` arrives ALREADY FORMATTED from money()/money2()/pct()/num(), and
  // the hook settles on that exact string — it interpolates inside the shape of
  // the figure and never re-derives it, so a reconciled cent stays reconciled.
  // Pass countUp={false} for a figure that should not be read as a quantity.
  const shown = useCountUp(value, { enabled: countUp });

  // `accent` now defaults to the single chrome accent token rather than a
  // hard-coded indigo. Indigo measured 4.28:1 on this surface and failed body
  // text contrast; emerald measures 10.64:1. Call sites that pass a semantic
  // colour explicitly (C.coral for a negative metric) still win.
  const hasSpark = Array.isArray(series) && series.length > 0;

  return (
    <div
      className={cn(
        "fx-enter group relative overflow-hidden rounded-2xl p-5",
        // The `shadow:` type hint is not decoration. Tailwind 3.4 reads a bare
        // var() in an arbitrary shadow value as a shadow COLOUR, so this class
        // emitted --tw-shadow-color and NO box-shadow at all: the KPI row was
        // flat and the hover lift had nothing to lift off. Compiled-CSS receipt.
        "border border-[var(--line-subtle)] bg-[var(--s-raised)] shadow-[shadow:var(--elev-2)]",
        "transition-[border-color,transform,box-shadow] [transition-duration:var(--fx-base)] [transition-timing-function:var(--fx-ease)]",
        "hover:-translate-y-0.5 hover:border-[var(--line)] hover:shadow-[shadow:var(--elev-3)]"
      )}
    >
      {/* Accent hairline along the top edge. 1px, not the old 2px — at display
          scale a 2px bar reads as a UI chrome stripe, 1px reads as a bevel. */}
      <div
        className="absolute inset-x-0 top-0 h-px opacity-70 transition-opacity [transition-duration:var(--fx-base)] group-hover:opacity-100"
        style={{ background: `linear-gradient(90deg, transparent, ${accent} 50%, transparent)` }}
      />
      {/* A very faint accent bloom in the corner on hover. Opacity tops out at
          0.10 deliberately: enough to feel lit, not enough to tint the figure. */}
      <div
        className="pointer-events-none absolute -right-10 -top-10 h-28 w-28 rounded-full opacity-0 blur-2xl transition-opacity [transition-duration:var(--fx-base)] [transition-timing-function:var(--fx-ease)] group-hover:opacity-[0.10]"
        style={{ backgroundColor: accent }}
        aria-hidden="true"
      />

      <div className="flex items-center justify-between gap-3">
        <p className="u-eyebrow min-w-0 truncate">{label}</p>
        {Icon && (
          <Icon
            className="h-4 w-4 shrink-0 transition-transform [transition-duration:var(--fx-base)] [transition-timing-function:var(--fx-ease)] group-hover:scale-110"
            style={{ color: accent }}
          />
        )}
      </div>

      <div className="mt-3.5 flex items-end justify-between gap-3">
        {/* tabular-nums is load-bearing, not cosmetic: without fixed-width digits
            every frame of the roll is a different width and the figure jitters.
            `.u-figure` adds the mono stack and tnum on top, which makes the
            fixed advance a property of the glyphs themselves. */}
        <p
          className="u-figure min-w-0 truncate text-[1.7rem] font-semibold leading-none tabular-nums text-[var(--t-primary)]"
          title={String(value ?? "")}
        >
          {shown}
        </p>
        {delta != null && delta !== "" && (
          <Badge tone={deltaTone ?? inferTone(delta)} title={deltaTitle} className="mb-0.5">
            {delta}
          </Badge>
        )}
      </div>

      {sub && <p className="mt-2 text-xs leading-relaxed text-[var(--t-tertiary)]">{sub}</p>}

      {/* Full-bleed trend strip. Negative margins pull it to the card edges and
          the card's overflow-hidden + rounded-2xl clip it to the corner radius. */}
      {hasSpark && (
        <div className="-mx-5 -mb-5 mt-4">
          <Sparkline data={series} color={accent} className="h-8 w-full" />
        </div>
      )}
    </div>
  );
}
