/**
 * @fileoverview Accordion components for collapsible content sections (compiled).
 * @module ui/accordion
 * @see {@link ./accordion.jsx} for source with full JSDoc documentation.
 */

import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import * as React from "react";
import * as AccordionPrimitive from "@radix-ui/react-accordion";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Accordion root component.
 * @type {typeof AccordionPrimitive.Root}
 */
const Accordion = AccordionPrimitive.Root;

/**
 * Individual accordion item container.
 * @type {React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Item>}
 * @property {string} value - Unique identifier (required)
 * @property {boolean} [disabled] - Disabled state
 * @property {string} [className] - Additional CSS classes
 */
const AccordionItem = React.forwardRef(({ className, ...props }, ref) => (_jsx(AccordionPrimitive.Item, { ref: ref, className: cn("border-b", className), ...props })));
AccordionItem.displayName = "AccordionItem";

/**
 * Accordion trigger button with rotating chevron indicator.
 * @type {React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Trigger>}
 * @property {boolean} [disabled] - Disabled state
 * @property {string} [className] - Additional CSS classes
 * @property {React.ReactNode} children - Trigger content
 */
const AccordionTrigger = React.forwardRef(({ className, children, ...props }, ref) => (_jsx(AccordionPrimitive.Header, { className: "flex", children: _jsxs(AccordionPrimitive.Trigger, { ref: ref, className: cn("flex flex-1 items-center justify-between py-4 text-sm font-medium transition-all hover:underline text-left [&[data-state=open]>svg]:rotate-180", className), ...props, children: [children, _jsx(ChevronDown, { className: "h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200" })] }) })));
AccordionTrigger.displayName = AccordionPrimitive.Trigger.displayName;

/**
 * Accordion content panel with expand/collapse animations.
 * @type {React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Content>}
 * @property {boolean} [forceMount] - Force mount for SSR
 * @property {string} [className] - Additional CSS classes for inner div
 * @property {React.ReactNode} children - Content to display
 */
const AccordionContent = React.forwardRef(({ className, children, ...props }, ref) => (_jsx(AccordionPrimitive.Content, { ref: ref, className: "overflow-hidden text-sm data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down", ...props, children: _jsx("div", { className: cn("pb-4 pt-0", className), children: children }) })));
AccordionContent.displayName = AccordionPrimitive.Content.displayName;

export { Accordion, AccordionItem, AccordionTrigger, AccordionContent };
