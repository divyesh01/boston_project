/**
 * @fileoverview Input component for text entry.
 * 
 * Styled text input with focus ring, disabled state, and file input support.
 * Used throughout forms and search interfaces.
 * 
 * @module ui/input
 * @example
 * ```jsx
 * import { Input } from "@/components/ui/input";
 * 
 * // Basic input
 * <Input placeholder="Enter your name" />
 * 
 * // With label
 * <div>
 *   <Label htmlFor="email">Email</Label>
 *   <Input id="email" type="email" placeholder="you@example.com" />
 * </div>
 * 
 * // File input
 * <Input type="file" accept=".csv,.xlsx" />
 * ```
 */

import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Input component for text entry.
 * 
 * Styled input element with focus-visible ring, disabled state,
 * placeholder styling, and file input support. Includes responsive
 * font sizing for mobile devices.
 * 
 * @type {React.ComponentPropsWithoutRef<"input">}
 * @property {string} [type] - Input type (text, email, password, file, etc.)
 * @property {string} [className] - Additional CSS classes
 * @property {string} [placeholder] - Placeholder text
 * @property {boolean} [disabled] - Whether input is disabled
 * @property {boolean} [readOnly] - Whether input is read-only
 * @property {string} [value] - Controlled input value
 * @property {(e: React.ChangeEvent<HTMLInputElement>) => void} [onChange] - Change handler
 * @property {(e: React.FocusEvent<HTMLInputElement>) => void} [onFocus] - Focus handler
 * @property {(e: React.FocusEvent<HTMLInputElement>) => void} [onBlur] - Blur handler
 */
const Input = React.forwardRef(
  ({ className, type, ...props }, ref) => {
  return (
    (<input
      type={type}
      className={cn(
        "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        className
      )}
      ref={ref}
      {...props} />
  );
})
Input.displayName = "Input"

export { Input }
