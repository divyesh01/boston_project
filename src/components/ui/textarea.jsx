/**
 * @fileoverview Textarea component for multi-line text entry.
 * 
 * Styled textarea with focus ring and disabled state.
 * Used throughout forms for comments, descriptions, and notes.
 * 
 * @module ui/textarea
 * @example
 * ```jsx
 * import { Textarea } from "@/components/ui/textarea";
 * 
 * // Basic textarea
 * <Textarea placeholder="Enter your message..." />
 * 
 * // With rows
 * <Textarea rows={6} placeholder="Long description..." />
 * 
 * // Disabled
 * <Textarea disabled placeholder="Cannot edit" />
 * ```
 */

import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Textarea component for multi-line text entry.
 * 
 * Styled textarea element with focus-visible ring, disabled state,
 * and placeholder styling. Includes responsive font sizing for
 * mobile devices and minimum height constraint.
 * 
 * @type {React.ComponentPropsWithoutRef<"textarea">}
 * @property {string} [className] - Additional CSS classes
 * @property {string} [placeholder] - Placeholder text
 * @property {boolean} [disabled] - Whether textarea is disabled
 * @property {boolean} [readOnly] - Whether textarea is read-only
 * @property {number} [rows] - Number of visible text lines
 * @property {string} [value] - Controlled textarea value
 * @property {(e: React.ChangeEvent<HTMLTextAreaElement>) => void} [onChange] - Change handler
 * @property {(e: React.FocusEvent<HTMLTextAreaElement>) => void} [onFocus] - Focus handler
 * @property {(e: React.FocusEvent<HTMLTextAreaElement>) => void} [onBlur] - Blur handler
 */
const Textarea = React.forwardRef(({ className, ...props }, ref) => {
  return (
    <textarea
      className={cn(
        "flex min-h-[60px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        className
      )}
      ref={ref}
      {...props} />
  );
})
Textarea.displayName = "Textarea"

export { Textarea }
