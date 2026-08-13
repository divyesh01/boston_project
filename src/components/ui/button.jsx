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
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow hover:bg-primary/90",
        destructive:
          "bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90",
        outline:
          "border border-input bg-transparent shadow-sm hover:bg-accent hover:text-accent-foreground",
        secondary:
          "bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
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
