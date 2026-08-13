/**
 * @fileoverview ToggleGroup component for grouped toggle buttons.
 * Uses Radix UI ToggleGroup primitive with context-based size/variant sharing.
 * @module toggle-group
 */
"use client";
import * as React from "react"
import * as ToggleGroupPrimitive from "@radix-ui/react-toggle-group"

import { cn } from "@/lib/utils"
import { toggleVariants } from "@/components/ui/toggle"

const ToggleGroupContext = React.createContext({
  size: "default",
  variant: "default",
})

/** @type {React.ForwardRefExoticComponent<any>} */
/** @type {React.ForwardRefExoticComponent<any>} */
const ToggleGroup = React.forwardRef(
  /**
   * @param {React.ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Root>} props
   */
  ({ className, variant, size, children, ...props }, ref) => (
  <ToggleGroupPrimitive.Root
    ref={ref}
    className={cn("flex items-center justify-center gap-1", className)}
    {...props}>
    <ToggleGroupContext.Provider value={{ variant, size }}>
      {children}
    </ToggleGroupContext.Provider>
  </ToggleGroupPrimitive.Root>
))

ToggleGroup.displayName = ToggleGroupPrimitive.Root.displayName

/** @type {React.ForwardRefExoticComponent<any>} */
/** @type {React.ForwardRefExoticComponent<any>} */
const ToggleGroupItem = React.forwardRef(
  /**
   * @param {React.ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Item>} props
   */
  ({ className, children, variant, size, ...props }, ref) => {
  const context = React.useContext(ToggleGroupContext)

  return (
    (<ToggleGroupPrimitive.Item
      ref={ref}
      className={cn(toggleVariants({
        variant: context.variant || variant,
        size: context.size || size,
      }), className)}
      {...props}>
      {children}
    </ToggleGroupPrimitive.Item>)
  );
})

ToggleGroupItem.displayName = ToggleGroupPrimitive.Item.displayName

export { ToggleGroup, ToggleGroupItem }
