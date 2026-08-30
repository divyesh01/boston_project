/**
 * @fileoverview SegmentedControl — a sunken track holding one raised pill.
 *
 * The depth system's third shape: the track is a well (like Input.jsx) and the
 * SELECTED item is a raised pill (like Button.jsx). That is the whole idea — the
 * chosen option physically sits above the ones it was chosen over, so the state
 * survives greyscale, a colour-vision deficiency and a bad monitor. Colour is
 * never the only cue: the selected item is also raised, and it is the only item
 * carrying aria-pressed="true" and the heavier weight.
 *
 * SEMANTICS, and a deliberate departure from the tablist pattern: these are
 * toggle buttons in a group, not tabs. `role="tablist"` and `role="radiogroup"`
 * both promise roving focus with arrow-key navigation, which this component
 * does not implement — every item is individually tabbable, which is the native
 * button behaviour and what the markup here actually delivers. Claiming tab or
 * radio semantics without the keyboard contract behind them is worse for a
 * screen-reader user than an honest group of pressed/unpressed buttons.
 *
 * @module ui-exec/SegmentedControl
 */

import React from "react";
import { cn } from "@/lib/utils";

// One composed box-shadow per state. The recess, the inset hairline and the
// pill's bevel all own `box-shadow`, and tailwind-merge cannot merge two
// utilities that write the same property — the loser vanishes silently. The
// `shadow:` type hint is required too: for a bare var() Tailwind guesses
// shadow-COLOUR and emits no box-shadow at all (measured, tailwind 3.4.19).
const TRACK =
  "inline-flex items-center gap-0.5 rounded-lg p-0.5 " +
  "bg-[var(--s-overlay)] shadow-[shadow:var(--well-inset),inset_0_0_0_1px_var(--line)]";

const ITEM =
  "rounded-[7px] font-medium whitespace-nowrap " +
  "transition-[background-color,box-shadow,color,transform] " +
  "[transition-duration:var(--fx-fast)] [transition-timing-function:var(--fx-ease)] " +
  "disabled:pointer-events-none disabled:opacity-50 disabled:shadow-none";

// The pill radius is 7px rather than a Tailwind step: the track is rounded-lg
// (8px via --radius) with 2px of padding, so an 8px child inside it leaves a
// visible sliver of track in each corner. 7px is the radius that reads as
// concentric.
const SELECTED =
  "bg-[var(--s-hover)] text-[var(--t-primary)] font-semibold " +
  "shadow-[shadow:var(--bevel-raised),var(--elev-1)]";

const UNSELECTED =
  "bg-transparent text-[var(--t-tertiary)] hover:bg-[var(--s-hover)] hover:text-[var(--t-secondary)]";

// 28px is the floor here, above the 24x24 WCAG 2.5.8 pointer-target minimum and
// matching Button's `xs`, because a segmented control is usually a filter
// sitting beside one.
//
// ON `lg` MEANING SOMETHING DIFFERENT HERE THAN IN Button.jsx, and it is
// deliberate rather than drift. Button's `lg` is h-11 (44px); this `lg` is h-9
// (36px). Owner ruling: both stay as they are. This component's scale is the
// FIELD scale (28/32/36) and tops out at the 36px height it shares with Input
// and Select, because a segmented control is a field-shaped thing that sits in a
// filter row and must line up with the controls beside it. Button's scale is the
// ACTION scale, and its `lg` at 44px exists for the one hero action at the top
// of a page. `lg` means "largest in its own family"; the two families are
// different on purpose, so collapsing them would break one to flatter the other.
const SIZES = {
  sm: "h-7 px-2.5 text-xs",
  md: "h-8 px-3 text-xs",
  lg: "h-9 px-4 text-sm",
};

/**
 * Accept both shapes the call sites already use: an object per option, or a
 * tuple. Several pages build their filter lists as arrays of tuples inline, and
 * a third element is used as the tooltip — normalising here means neither form
 * has to be rewritten to adopt this component.
 *
 * @param {{ value: any, label?: import('react').ReactNode, hint?: string } | Array<any>} opt
 * @returns {{ value: any, label: import('react').ReactNode, hint: string | undefined }}
 */
function normalizeOption(opt) {
  if (Array.isArray(opt)) {
    return { value: opt[0], label: opt[1] ?? String(opt[0]), hint: opt[2] };
  }
  return { value: opt.value, label: opt.label ?? String(opt.value), hint: opt.hint };
}

export default function SegmentedControl(
  /** @type {{
   *   options: Array<{ value: any, label?: import('react').ReactNode, hint?: string } | Array<any>>;
   *   value: any;
   *   onChange: (value: any) => void;
   *   size?: 'sm' | 'md' | 'lg';
   *   label?: string;
   *   className?: string;
   *   disabled?: boolean;
   * }} */
  { options = [], value, onChange, size = "md", label, className = "", disabled = false }
) {
  const dims = SIZES[size] ?? SIZES.md;
  return (
    <div role="group" aria-label={label} className={cn(TRACK, className)}>
      {options.map((opt) => {
        const o = normalizeOption(opt);
        const selected = o.value === value;
        return (
          <button
            // type="button" is not optional: an unset type inside a <form>
            // defaults to "submit", so a filter switch dropped into one of the
            // real forms on these pages would submit it on every click.
            type="button"
            key={String(o.value)}
            title={o.hint}
            aria-pressed={selected}
            disabled={disabled}
            onClick={() => { if (!selected) onChange(o.value); }}
            className={cn(ITEM, dims, selected ? SELECTED : UNSELECTED)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
