import React from "react";

// Date-range input pair.
//
// MIGRATED TO THE TOKEN LAYER 2026-08-20. This primitive was the last file in
// src/components/ui-exec/ still painting a hard-coded surface:
//
//     bg-[#0A1628] ... text-slate-200 focus:border-[#00D4FF]
//
// Three separate problems, all invisible until measured:
//
//   1. #0A1628 is the legacy navy. Every other ui-exec primitive had been moved
//      onto the ramp, so a RangePicker dropped into a Card sat on a surface that
//      no longer matched the card around it. Inputs and nested wells are
//      --s-overlay by definition in src/index.css.
//
//   2. #00D4FF is the legacy cyan accent. src/index.css gives chrome exactly one
//      accent (--brand, emerald) for a measured reason: cyan and indigo both
//      fail body-text contrast on the surface ramp, and five accents at equal
//      weight is what made the old dashboard read as noise. The focus border is
//      also redundant — index.css declares a global `:focus-visible` outline in
//      --brand, so a focused input already gets a 2px emerald ring. The old rule
//      used `focus:` rather than `focus-visible:`, so it also fired on a mouse
//      click, giving a pointer user an indicator meant for keyboard navigation.
//      Dropped in favour of the global ring, which is the single source of truth.
//
//   3. text-slate-200 is a Tailwind palette colour, not a token. The value a
//      user has typed is primary content, so it takes --t-primary (17.16:1 on
//      the ramp); the label and the separator are chrome, so they take
//      --t-tertiary (5.86:1 — still above the 4.5:1 body floor).
//
// scripts/probe-premium-surfaces.mjs now asserts over the WHOLE ui-exec
// directory rather than a hand-listed four files, which is how this one was
// found; it also resolves every var(--…) here against the declared token set,
// so a typo like var(--s-overlaay) fails the suite instead of silently painting
// nothing.
const FIELD =
  "rounded-lg border border-[var(--line)] bg-[var(--s-overlay)] px-3 py-1.5 text-sm " +
  "text-[var(--t-primary)] outline-none transition-colors duration-150 " +
  "hover:border-[var(--line-strong)]";

export default function RangePicker({ from, to, onChange, label }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {label && (
        <span className="text-xs uppercase tracking-widest text-[var(--t-tertiary)]">{label}</span>
      )}
      <input
        type="date"
        aria-label={label ? `${label} — from` : "From date"}
        value={from}
        onChange={(e) => onChange(e.target.value, to)}
        className={FIELD}
      />
      <span aria-hidden="true" className="text-[var(--t-tertiary)]">→</span>
      <input
        type="date"
        aria-label={label ? `${label} — to` : "To date"}
        value={to}
        onChange={(e) => onChange(from, e.target.value)}
        className={FIELD}
      />
    </div>
  );
}
