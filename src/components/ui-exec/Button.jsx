/**
 * @fileoverview Button — the raised half of the control depth system.
 *
 * One button, six variants, five sizes, so the ~34 pages stop hand-rolling a
 * pill per call site. Before this file, Payroll.jsx alone typed four different
 * button recipes within twenty lines of each other, each with its own hex, its
 * own hover and its own opinion about whether a disabled button still looks
 * pressable.
 *
 * DEPTH IS THE POINT. Buttons are lit from above (a 1px top highlight over a
 * contact + ambient shadow) and inputs are holes (see Input.jsx). Those two
 * directions of light are what let a dense financial screen be read at a glance:
 * anything raised is a thing you press, anything sunken is a thing you fill in.
 * The bevel is the detail that reads as expensive — same trick as --elev-2 in
 * src/index.css, pulled out as --bevel-raised so it can be composed with a
 * CHANGING elevation on hover.
 *
 * @module ui-exec/Button
 */

import React from "react";
import { cn } from "@/lib/utils";

// SHADOWS CARRY A `shadow:` TYPE HINT ON PURPOSE, and this is measured, not
// stylistic. Tailwind's `shadow-*` namespace holds both box-shadow and
// shadow-COLOR utilities, and for an arbitrary value it has to guess which one
// was meant. A bare var() reference is guessed as a COLOUR: compiled with this
// repo's own tailwind 3.4.19 and config, a plain bracketed shadow utility
// wrapping var(--elev-1) emits
//
//     --tw-shadow-color: var(--elev-1); --tw-shadow: var(--tw-shadow-colored)
//
// and NO box-shadow property at all — the element gets no shadow, the build
// succeeds, and nothing warns. Adding the `shadow:` hint names the property, so
// the same value emits a real box-shadow line. Verified by running the tailwind
// CLI over a scratch file and reading the emitted CSS, both forms side by side.
//
// (Card.jsx and KpiCard.jsx use the un-hinted form and are therefore rendering
// flat today. That is a real defect but it is not this file's to fix — those two
// files are out of scope for this change and are named here so the finding is
// not lost.)
//
// The transition list is enumerated rather than blanket, for the same reason
// Card.jsx enumerates its own: a blanket transition animates layout properties
// too, so a button that reflows would slide. `transform` is in the list only so
// the RELEASE of a press eases — the press itself belongs to the global
// `button:active` rule in src/index.css and is deliberately not re-implemented
// here. Duration and easing use the arbitrary-PROPERTY form; the shorthand
// utility form with a bracketed value is ambiguous against tailwindcss-animate
// and silently emits nothing (scripts/verify-motion.mjs section 13).
const BASE =
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg font-medium " +
  "transition-[background-color,border-color,box-shadow,color,transform] " +
  "[transition-duration:var(--fx-fast)] [transition-timing-function:var(--fx-ease)] " +
  // A disabled control must not look raised: opacity alone leaves a faded
  // button still floating above the surface, which still reads as pressable.
  "disabled:pointer-events-none disabled:opacity-50 disabled:shadow-none " +
  "[&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:pointer-events-none";

// NO focus-visible:outline-none anywhere in this file. src/index.css ships a
// measured global focus outline (2px --brand, 10.64:1 on --s-raised) and these
// primitives inherit it. The stock src/components/ui/button.jsx suppresses that
// outline in favour of a 1px ring on --ring, which on this dark theme is a
// far weaker indicator; that mistake is not copied here.
const RAISED =
  "shadow-[shadow:var(--bevel-raised),var(--elev-1)] " +
  "hover:shadow-[shadow:var(--bevel-raised),var(--elev-2)]";

const VARIANTS = {
  // The one button on screen that is the answer to the question. --brand-ink is
  // the only text colour allowed on an emerald fill: the text ramp measures
  // 1.61:1 there, this near-black green measures 9.42:1. The hover adds one
  // brand-tinted ambient layer under the raised stack, so the primary lights up
  // instead of merely rising — the only variant that gets it, because more than
  // one glowing button per screen is a marketing site, not an operations tool.
  primary:
    "bg-[var(--brand)] text-[var(--brand-ink)] " +
    RAISED +
    " hover:shadow-[shadow:var(--bevel-raised),var(--elev-2),0_6px_18px_-8px_var(--brand-glow)]",

  // The default for anything that is not the primary action. Transparent at
  // rest so a row of these does not read as a wall of chrome; the hairline and
  // the elevation are what make it a control.
  secondary:
    "border border-[var(--line)] bg-transparent text-[var(--t-secondary)] " +
    RAISED +
    " hover:border-[var(--line-strong)] hover:bg-[var(--s-hover)] hover:text-[var(--t-primary)]",

  // A brand-tinted action that is not THE action — "Quick Add", "Export".
  // Hover brightens the hairline to full --brand rather than washing the fill
  // harder, because a 12% wash has nowhere brighter to go without a second
  // token that means the same thing.
  soft:
    "border border-[var(--brand-line)] bg-[var(--brand-quiet)] text-[var(--brand)] " +
    RAISED +
    " hover:border-[var(--brand)]",

  // No surface at rest. For icon buttons and toolbar affordances that must not
  // compete with the data — a dialog close, a row menu. No elevation: a ghost
  // that casts a shadow is not a ghost.
  ghost:
    "bg-transparent text-[var(--t-tertiary)] hover:bg-[var(--s-hover)] hover:text-[var(--t-primary)]",

  // Destructive. Colour is NEVER the only signal (WCAG 1.4.1) — the caller
  // supplies the verb and, where it matters, a confirm step; this variant only
  // makes the verb look like what it does.
  danger:
    "border border-[var(--danger-line)] bg-[var(--danger-quiet)] text-[var(--data-negative)] " +
    RAISED +
    " hover:border-[var(--data-negative)]",

  // A real link that happens to be a button. No surface, no elevation, and the
  // underline on hover is the non-colour cue.
  link: "bg-transparent text-[var(--brand)] underline-offset-4 hover:underline",
};

// WCAG 2.5.8 puts the floor for a pointer target at 24x24 CSS px, so nothing
// here goes under h-7 (28px) and the icon size stays square at the default
// height. `md` is the default because it matches the 36px controls the pages
// already use; `lg` exists for the one primary action at the top of a page.
const SIZES = {
  xs: "h-7 px-2.5 text-xs",
  sm: "h-8 px-3 text-xs",
  md: "h-9 px-4 text-sm",
  lg: "h-11 px-5 text-sm",
  icon: "h-9 w-9 p-0",
};

/**
 * @typedef {object} ButtonOwnProps
 * @property {'primary'|'secondary'|'soft'|'ghost'|'danger'|'link'} [variant='primary']
 * @property {'xs'|'sm'|'md'|'lg'|'icon'} [size='md']
 * @property {string} [className]
 */

/**
 * @type {React.ForwardRefExoticComponent<
 *   ButtonOwnProps & React.ButtonHTMLAttributes<HTMLButtonElement> &
 *   React.RefAttributes<HTMLButtonElement>
 * >}
 */
const Button = React.forwardRef(function Button(
  { variant = "primary", size = "md", type = "button", className = "", ...props },
  ref
) {
  // `type` defaults to "button" and is overridable. An unset type inside a
  // <form> defaults to "submit" in HTML, so a Cancel button next to a form —
  // Payroll.jsx has real ones — would submit the form it was meant to abandon.
  return (
    <button
      ref={ref}
      type={type}
      className={cn(BASE, VARIANTS[variant] ?? VARIANTS.primary, SIZES[size] ?? SIZES.md, className)}
      {...props}
    />
  );
});

export default Button;
