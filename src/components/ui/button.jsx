/**
 * @fileoverview Button component with variant-based styling.
 * 
 * Built with class-variance-authority (CVA) for type-safe variant styling.
 * Supports asChild pattern for rendering as any element (e.g., Link).
 * Includes focus-visible ring, disabled state, and icon sizing.
 * 
 * @module ui/button
 * @example
 * ```jsx
 * import { Button } from "@/components/ui/button";
 * 
 * // Default button
 * <Button>Click me</Button>
 * 
 * // Variant and size
 * <Button variant="outline" size="sm">Small Outline</Button>
 * 
 * // As link
 * <Button asChild>
 *   <a href="/dashboard">Go to Dashboard</a>
 * </Button>
 * 
 * // With icon
 * <Button>
 *   <PlusIcon className="h-4 w-4" />
 *   Add Item
 * </Button>
 * ```
 */

import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva } from "class-variance-authority";

import { cn } from "@/lib/utils"

/**
 * @typedef {Object} ButtonProps
 * Props for Button component.
 * @property {'default' | 'destructive' | 'outline' | 'secondary' | 'ghost' | 'link'} [variant='default'] - Visual style variant
 * @property {'default' | 'sm' | 'lg' | 'icon'} [size='default'] - Size preset
 * @property {boolean} [asChild=false] - Render as child element instead of button
 * @property {string} [className] - Additional CSS classes
 * @property {boolean} [disabled] - Whether button is disabled
 * @property {React.ReactNode} children - Button content
 */

/**
 * CVA variant definitions for buttons.
 * 
 * Defines all visual variants and size presets. Used internally
 * by the Button component to generate class names.
 * 
 * @type {Function}
 */
const buttonVariants = cva(
  // Luxury 3D base. Transition is SCOPED (no transition-all layout thrash and no
  // framer-motion contention). No will-change (avoids per-instance compositor
  // promotion in dense grids). Emerald brand focus ring WITHOUT a hardcoded
  // ring-offset color (prevents a mismatched halo inside raised cards).
  // disabled:opacity-50 retained for WCAG perceivability. Reduced-motion fully
  // neutralizes both the base transform hint and the hover/press transforms.
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium select-none transform-gpu transition-[transform,box-shadow,background-color,border-color] duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00E096] disabled:pointer-events-none disabled:opacity-50 disabled:shadow-none disabled:translate-y-0 motion-reduce:transition-none motion-reduce:transform-none motion-reduce:hover:translate-y-0 motion-reduce:active:translate-y-0 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        // Primary — rich violet gradient over bg-primary token, specular top
        // bevel, dual contact shadow. bg-primary retained as graceful fallback.
        default:
          "bg-primary text-primary-foreground [background-image:linear-gradient(to_bottom,#7C5CFF,#5B3FE0)] border border-white/10 shadow-[0_2px_4px_-1px_rgba(0,0,0,0.50),0_1px_2px_rgba(0,0,0,0.40),inset_0_1px_0_rgba(255,255,255,0.16)] hover:-translate-y-px hover:[background-image:linear-gradient(to_bottom,#8A6CFF,#6A4EF0)] hover:shadow-[0_6px_12px_-2px_rgba(0,0,0,0.55),0_3px_6px_rgba(0,0,0,0.40),inset_0_1px_0_rgba(255,255,255,0.20)] active:translate-y-[1px] active:shadow-[0_1px_2px_rgba(0,0,0,0.45),inset_0_1px_2px_rgba(0,0,0,0.30)]",
        // Destructive — ruby gradient. bg-destructive retained as fallback token.
        destructive:
          "bg-destructive text-destructive-foreground [background-image:linear-gradient(to_bottom,#E0435B,#B21E38)] border border-white/10 shadow-[0_2px_4px_-1px_rgba(0,0,0,0.50),0_1px_2px_rgba(0,0,0,0.40),inset_0_1px_0_rgba(255,255,255,0.16)] hover:-translate-y-px hover:[background-image:linear-gradient(to_bottom,#EC5268,#C42741)] hover:shadow-[0_6px_12px_-2px_rgba(0,0,0,0.55),0_3px_6px_rgba(0,0,0,0.40),inset_0_1px_0_rgba(255,255,255,0.20)] active:translate-y-[1px] active:shadow-[0_1px_2px_rgba(0,0,0,0.45),inset_0_1px_2px_rgba(0,0,0,0.30)]",
        // Outline — hairline perimeter over faint raised surface. border and
        // hover:bg-accent tokens both retained.
        outline:
          "border border-input bg-transparent text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.30),inset_0_1px_0_rgba(255,255,255,0.06)] hover:-translate-y-px hover:bg-accent hover:text-accent-foreground hover:shadow-[0_5px_10px_-2px_rgba(0,0,0,0.50),inset_0_1px_0_rgba(255,255,255,0.08)] active:translate-y-[1px] active:shadow-[inset_0_1px_2px_rgba(0,0,0,0.25)]",
        // Secondary — elevated dark-slate gradient, lighter bevel (0.08).
        // bg-secondary retained as fallback token.
        secondary:
          "bg-secondary text-secondary-foreground [background-image:linear-gradient(to_bottom,#1B2230,#10141B)] border border-white/10 shadow-[0_2px_4px_-1px_rgba(0,0,0,0.50),0_1px_2px_rgba(0,0,0,0.40),inset_0_1px_0_rgba(255,255,255,0.08)] hover:-translate-y-px hover:[background-image:linear-gradient(to_bottom,#222B3B,#151A22)] hover:shadow-[0_6px_12px_-2px_rgba(0,0,0,0.55),0_3px_6px_rgba(0,0,0,0.40),inset_0_1px_0_rgba(255,255,255,0.10)] active:translate-y-[1px] active:shadow-[0_1px_2px_rgba(0,0,0,0.45),inset_0_1px_2px_rgba(0,0,0,0.30)]",
        // Ghost — intentionally flat, no elevation. hover:bg-accent retained.
        ghost: "text-foreground hover:bg-accent hover:text-accent-foreground",
        // Link — pure text affordance, no 3D chrome. text-primary retained.
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-10 rounded-md px-8",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

/**
 * Button component with variant styling and asChild support.
 * 
 * Renders as a button by default, or merges onto its child when
 * `asChild` is true (useful for React Router Link integration).
 * Includes focus-visible ring, disabled state, and automatic icon sizing.
 * 
 * @type {React.ForwardRefExoticComponent<any>}
 * @property {'default' | 'destructive' | 'outline' | 'secondary' | 'ghost' | 'link'} [variant='default'] - Visual style
 * @property {'default' | 'sm' | 'lg' | 'icon'} [size='default'] - Size preset
 * @property {boolean} [asChild=false] - Render as child element
 * @property {string} [className] - Additional CSS classes
 * @property {boolean} [disabled] - Disabled state
 * @property {React.ReactNode} children - Button content
 * 
 * @example
 * <Button variant="destructive" size="lg">Delete</Button>
 * 
 * @example
 * <Button asChild>
 *   <Link to="/settings">Settings</Link>
 * </Button>
 */
const Button = React.forwardRef(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
  const Comp = asChild ? Slot : "button"
  return (
    (<Comp
      className={cn(buttonVariants({ variant, size, className }))}
      ref={ref}
      {...props} />)
  );
})
Button.displayName = "Button"

export { Button, buttonVariants }
