/**
 * @fileoverview Accordion components for collapsible content sections.
 * 
 * Built on Radix UI Accordion primitive for accessible, keyboard-navigable
 * collapsible sections. Supports single and multiple expansion modes,
 * with smooth CSS animations for open/close transitions.
 * 
 * @module ui/accordion
 * @example
 * ```jsx
 * import {
 *   Accordion,
 *   AccordionItem,
 *   AccordionTrigger,
 *   AccordionContent,
 * } from "@/components/ui/accordion";
 * 
 * <Accordion type="single" collapsible>
 *   <AccordionItem value="item-1">
 *     <AccordionTrigger>Is it accessible?</AccordionTrigger>
 *     <AccordionContent>
 *       Yes. It adheres to the WAI-ARIA design pattern.
 *     </AccordionContent>
 *   </AccordionItem>
 * </Accordion>
 * ```
 */

import * as React from "react"
import * as AccordionPrimitive from "@radix-ui/react-accordion"
import { ChevronDown } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * Accordion root component.
 * 
 * Wraps all accordion items and manages expansion state.
 * Supports "single" (one item open at a time) or "multiple" modes.
 * 
 * @type {typeof AccordionPrimitive.Root}
 * @property {'single' | 'multiple'} [type] - Expansion mode (required)
 * @property {string[]} [defaultValue] - Initially expanded item values
 * @property {string[]} [value] - Controlled expanded item values
 * @property {(value: string[]) => void} [onValueChange] - Callback when expanded items change
 * @property {boolean} [collapsible] - Whether all items can be closed (single mode only)
 * @property {boolean} [disabled] - Whether all items are disabled
 * @property {'horizontal' | 'vertical'} [orientation] - Layout direction
 * @property {string} [className] - Additional CSS classes
 * 
 * @example
 * <Accordion type="single" collapsible defaultValue={['item-1']}>
 *   {children}
 * </Accordion>
 */
const Accordion = AccordionPrimitive.Root

/**
 * Individual accordion item container.
 * 
 * Each item must have a unique `value` prop that identifies it
 * within the accordion's state management.
 * 
 * @type {React.ForwardRefExoticComponent<any>}
 * @property {string} value - Unique identifier for this item (required)
 * @property {boolean} [disabled] - Whether this specific item is disabled
 * @property {string} [className] - Additional CSS classes for the item border
 * 
 * @example
 * <AccordionItem value="section-1" className="border-b-2">
 *   <AccordionTrigger>Click to expand</AccordionTrigger>
 *   <AccordionContent>Hidden content</AccordionContent>
 * </AccordionItem>
 */
const AccordionItem = React.forwardRef(
  /**
   * @param {React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Item>} props
   */
  ({ className, ...props }, ref) => (
    <AccordionPrimitive.Item ref={ref} className={cn("border-b", className)} {...props} />
  )
)
AccordionItem.displayName = "AccordionItem"

/**
 * Accordion trigger button.
 * 
 * Renders as a button inside the item header. Clicking toggles
 * the item's expanded state. Includes a rotating chevron indicator
 * that rotates 180° when the item is open.
 * 
 * @type {React.ForwardRefExoticComponent<any>}
 * @property {boolean} [disabled] - Whether the trigger is disabled
 * @property {string} [className] - Additional CSS classes
 * @property {React.ReactNode} children - Trigger content (usually text)
 * 
 * @example
 * <AccordionTrigger className="text-lg font-semibold">
 *   Section Title
 * </AccordionTrigger>
 */
const AccordionTrigger = React.forwardRef(({ className, children, ...props }, ref) => (
  <AccordionPrimitive.Header className="flex">
    <AccordionPrimitive.Trigger
      ref={ref}
      className={cn(
        "flex flex-1 items-center justify-between py-4 text-sm font-medium transition-all hover:underline text-left [&[data-state=open]>svg]:rotate-180",
        className
      )}
      {...props}>
      {children}
      <ChevronDown
        className="h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200" />
    </AccordionPrimitive.Trigger>
  </AccordionPrimitive.Header>
))
AccordionTrigger.displayName = AccordionPrimitive.Trigger.displayName

/**
 * Accordion content panel.
 * 
 * Contains the collapsible content body. Uses CSS animations
 * for smooth expand/collapse transitions. The content is
 * hidden from screen readers when collapsed.
 * 
 * @type {React.ForwardRefExoticComponent<any>}
 * @property {boolean} [forceMount] - Force mount content even when closed (for SSR)
 * @property {string} [className] - Additional CSS classes for the inner content div
 * @property {React.ReactNode} children - Content to display when expanded
 * 
 * @example
 * <AccordionContent className="text-base">
 *   <p>This content is revealed when the trigger is clicked.</p>
 * </AccordionContent>
 */
const AccordionContent = React.forwardRef(({ className, children, ...props }, ref) => (
  <AccordionPrimitive.Content
    ref={ref}
    className="overflow-hidden text-sm data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down"
    {...props}>
    <div className={cn("pb-4 pt-0", className)}>{children}</div>
  </AccordionPrimitive.Content>
))
AccordionContent.displayName = AccordionPrimitive.Content.displayName

export { Accordion, AccordionItem, AccordionTrigger, AccordionContent }
