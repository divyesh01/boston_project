/**
 * @fileoverview Input — the sunken half of the control depth system.
 *
 * A text field is a HOLE in the surface: --s-overlay ground, a tight dark
 * shadow just inside the top edge, and an inset hairline. Buttons are lit from
 * above (Button.jsx), fields are recessed, and that single opposition is what
 * makes a dense page scannable — raised means press, sunken means fill in.
 *
 * The recess is a box-shadow rather than a border on purpose: an inset shadow
 * costs no layout space, so dropping a field into a grid cell cannot shift the
 * grid by 1px. Same reason `.u-hairline` exists in src/index.css.
 *
 * WHOLLY UNCONTROLLED-SAFE AND CONTROLLED-SAFE: every native prop is spread
 * through untouched and `onChange` receives the DOM event, never a bare value.
 * The 60+ existing fields in Payroll.jsx and Settings.jsx read `e.target.value`
 * inside their handlers; a component that "helpfully" passed the value instead
 * would break every one of them silently, because `e.target` on a string is
 * undefined rather than an error at the call site.
 *
 * @module ui-exec/Input
 */

import React from "react";
import { cn } from "@/lib/utils";

// ONE box-shadow utility per state, never two. The recess and the hairline are
// both box-shadow, and tailwind-merge cannot merge two class names that own the
// same property — the later one wins outright and the other silently vanishes.
// So they are composed into a single value here (and any ring-* utility on a
// field would collide the same way, which is another reason the focus indicator
// stays the global outline instead of a ring).
//
// The `shadow:` type hint is load-bearing: Tailwind's shadow-* namespace holds
// both box-shadow and shadow-COLOR, and for a bare var() it guesses COLOUR and
// emits no box-shadow at all. Measured against this repo's tailwind 3.4.19 by
// compiling both forms and reading the output CSS.
const WELL =
  "bg-[var(--s-overlay)] shadow-[shadow:var(--well-inset),inset_0_0_0_1px_var(--line)] " +
  "hover:bg-[var(--s-hover)]";

// No focus-visible:outline-none. src/index.css ships a measured global focus
// outline (2px --brand, 10.64:1) and this field inherits it. `outline-none`
// would leave a keyboard user with no indicator at all on a field whose only
// other focus signal would be colour.
const FIELD =
  "h-9 w-full rounded-lg px-3 text-sm text-[var(--t-primary)] " +
  "placeholder:text-[var(--t-tertiary)] " +
  "transition-[background-color,box-shadow,color] " +
  "[transition-duration:var(--fx-fast)] [transition-timing-function:var(--fx-ease)] " +
  "disabled:pointer-events-none disabled:opacity-50";

// A checkbox is not a small text field. Given the well treatment it would render
// as a 36px-tall empty trough with a tick floating in it, and `w-full` would
// stretch it across its column. Native rendering plus accent-color is both
// correct and the only version that stays in sync with the OS control.
const TOGGLE =
  "h-4 w-4 shrink-0 cursor-pointer accent-[var(--brand)] " +
  "disabled:cursor-not-allowed disabled:opacity-50";

/**
 * @type {React.ForwardRefExoticComponent<
 *   React.InputHTMLAttributes<HTMLInputElement> & React.RefAttributes<HTMLInputElement>
 * >}
 */
const Input = React.forwardRef(function Input({ className = "", type = "text", ...rest }, ref) {
  const isToggle = type === "checkbox" || type === "radio";
  return (
    <input
      ref={ref}
      type={type}
      className={cn(isToggle ? TOGGLE : cn(WELL, FIELD), className)}
      {...rest}
    />
  );
});

export default Input;
