/**
 * @fileoverview Select — the same sunken well as Input, around a NATIVE select.
 *
 * Deliberately not a Radix/listbox rewrite. Every select on these pages is a
 * native <select> whose handler reads `e.target.value`, and the native control
 * brings keyboard behaviour, type-ahead, mobile pickers and form participation
 * that a div-based menu has to re-earn. Changing the element would change
 * behaviour, which is not what a visual pass is allowed to do. So the only
 * changes here are the surface, the chevron, and the removal of the browser's
 * own arrow via appearance-none.
 *
 * The chevron is decoration over a real control: aria-hidden, pointer-events
 * disabled so a click on it still opens the select, and pr-8 on the field so a
 * long option label cannot run underneath it.
 *
 * @module ui-exec/Select
 */

import React from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

// Single composed box-shadow — the recess and the inset hairline are both
// box-shadow, and tailwind-merge cannot merge two utilities that own the same
// property, so stacking them would silently drop one. The `shadow:` type hint
// is required: for a bare var() Tailwind guesses shadow-COLOUR and emits no
// box-shadow line at all (measured on this repo's tailwind 3.4.19).
//
// No focus-visible:outline-none: the global emerald outline in src/index.css is
// the focus indicator, and it is measured (10.64:1 on --s-raised).
const FIELD =
  "h-9 w-full appearance-none rounded-lg pl-3 pr-8 text-sm text-[var(--t-primary)] " +
  "bg-[var(--s-overlay)] shadow-[shadow:var(--well-inset),inset_0_0_0_1px_var(--line)] " +
  "hover:bg-[var(--s-hover)] " +
  "transition-[background-color,box-shadow,color] " +
  "[transition-duration:var(--fx-fast)] [transition-timing-function:var(--fx-ease)] " +
  "disabled:pointer-events-none disabled:opacity-50";

/**
 * @type {React.ForwardRefExoticComponent<
 *   { wrapperClassName?: string } &
 *   React.SelectHTMLAttributes<HTMLSelectElement> &
 *   React.RefAttributes<HTMLSelectElement>
 * >}
 */
const Select = React.forwardRef(function Select(
  { className = "", wrapperClassName = "", children, ...rest },
  ref
) {
  return (
    <span className={cn("relative inline-flex w-full items-center", wrapperClassName)}>
      <select ref={ref} className={cn(FIELD, className)} {...rest}>
        {children}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute right-2.5 h-4 w-4 text-[var(--t-tertiary)]"
      />
    </span>
  );
});

export default Select;
