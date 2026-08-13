/**
 * @fileoverview Label component for form field labels.
 * Built on Radix UI Label primitive with peer-disabled styling support.
 * @module label
 */
import * as React from "react"
import * as LabelPrimitive from "@radix-ui/react-label"
import { cva } from "class-variance-authority";

import { cn } from "@/lib/utils"

const labelVariants = cva(
  "text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
)

/** @type {React.ForwardRefExoticComponent<any>} */
/** @type {React.ForwardRefExoticComponent<any>} */
const Label = React.forwardRef(
  (
    /** @type {import('react').ComponentPropsWithoutRef<typeof LabelPrimitive.Root>} */
    { className, ...props },
    ref
  ) => (
  <LabelPrimitive.Root ref={ref} className={cn(labelVariants(), className)} {...props} />
))
Label.displayName = LabelPrimitive.Root.displayName

export { Label }
