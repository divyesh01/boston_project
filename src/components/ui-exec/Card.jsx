import React from "react";
import { cn } from "@/lib/utils";

// Every card in the app settles in through the shared `.fx-enter` entrance
// (src/index.css) rather than a per-card framer-motion component. Two reasons:
// a CSS animation costs no JS on a page that can hold 30+ cards, and it is
// covered by the single global `prefers-reduced-motion` kill switch instead of
// needing each card to check the preference itself.
//
// This is also the chart entrance: charts live inside Cards, so a chart card
// fades and rises into place while the ring and its labels appear at final
// geometry — the label layout engine is never animated.
//
// Surfaces, hairlines and shadows come from the tokens in index.css. Nothing
// here hard-codes a hex any more: this one component is the surface treatment
// for ~34 pages, so a literal typed here becomes a literal everywhere.

export default function Card(
  /** @type {{
   *   title?: import('react').ReactNode;
   *   subtitle?: import('react').ReactNode;
   *   right?: import('react').ReactNode;
   *   children?: import('react').ReactNode;
   *   className?: string;
   *   glass?: boolean;
   *   flush?: boolean;
   * }} */
  { title, subtitle, right, children, className = "", glass = false, flush = false }) {
  return (
    <div
      className={cn(
        "fx-enter relative rounded-2xl",
        // Opt-in glass. Default is a solid raised surface because
        // backdrop-filter forces a compositing pass per element and these
        // pages hold 30+ cards — glass is for the few that overlay content.
        glass ? "u-glass" : "border border-[var(--line-subtle)] bg-[var(--s-raised)]",
        // 24px instead of the old 20px. The brief is "generous whitespace",
        // and at 20px a chart's own labels sat too close to the hairline.
        flush ? "p-0" : "p-6",
        "shadow-[var(--elev-2)]",
        // An explicit property list, never a blanket transition: blanket ones
        // animate layout properties too, so a card that reflows would slide.
        // (The string is spelled out nowhere here on purpose — verify-motion
        // greps this file for it as raw text.)
        // Durations come from the motion tokens rather than Tailwind's scale so
        // the CSS and JS halves of the motion system cannot drift.
        //
        // The duration and easing MUST use the arbitrary-PROPERTY form
        // (square brackets around a full "transition-duration:value" pair),
        // never the shorthand utility form ("duration-" plus a bracketed
        // value). tailwindcss-animate registers duration-* and ease-* for
        // animation-duration/animation-timing-function, which collides with
        // core's transition-* pair: for an arbitrary value Tailwind cannot tell
        // the two apart, warns "ambiguous and matches multiple utilities", and
        // emits NO RULE AT ALL. The class silently vanishes and the element
        // falls back to Tailwind's 150ms / cubic-bezier(.4,0,.2,1) default,
        // which is the exact token drift the note above says is impossible.
        // verify-motion.mjs asserts this. Do not "tidy" the syntax back.
        // (Spelled out in prose, not as literals: the content scanner reads
        // comments too, and a bracketed example here becomes a real candidate
        // class that re-triggers the very warning it describes.)
        "transition-[border-color,box-shadow] [transition-duration:var(--fx-base)] [transition-timing-function:var(--fx-ease)]",
        "hover:border-[var(--line)] hover:shadow-[var(--elev-3)]",
        className
      )}
    >
      {(title || right) && (
        <div className={cn("flex items-start justify-between gap-4", flush ? "px-6 pt-6 pb-4" : "mb-5")}>
          <div className="min-w-0">
            {title && (
              <h3 className="truncate font-heading text-[13px] font-semibold tracking-[0.01em] text-[var(--t-primary)]">
                {title}
              </h3>
            )}
            {subtitle && <p className="mt-1.5 text-xs leading-relaxed text-[var(--t-tertiary)]">{subtitle}</p>}
          </div>
          {right && <div className="shrink-0">{right}</div>}
        </div>
      )}
      {children}
    </div>
  );
}
