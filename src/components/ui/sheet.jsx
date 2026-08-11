/**
 * @fileoverview Sheet components for slide-out panels.
 * 
 * Built on Radix UI Dialog primitive for accessible slide-out panels.
 * Supports four directions (top, bottom, left, right) with CVA variants.
 * Used for sidebars, detail panels, and mobile navigation.
 * 
 * @module ui/sheet
 * @example
 * ```jsx
 * import {
 *   Sheet,
 *   SheetTrigger,
 *   SheetContent,
 *   SheetHeader,
 *   SheetTitle,
 * } from "@/components/ui/sheet";
 * 
 * <Sheet>
 *   <SheetTrigger asChild>
 *     <Button>Open Panel</Button>
 *   </SheetTrigger>
 *   <SheetContent side="right">
 *     <SheetHeader>
 *       <SheetTitle>Details</SheetTitle>
 *     </SheetHeader>
 *     <p>Panel content here...</p>
 *   </SheetContent>
 * </Sheet>
 * ```
 */

"use client";
import * as React from "react"
import * as SheetPrimitive from "@radix-ui/react-dialog"
import { cva } from "class-variance-authority";
import { X } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * Sheet root component.
 * 
 * Manages open/close state for the sheet panel. Wraps all sheet
 * components and provides context for state management.
 * 
 * @type {typeof SheetPrimitive.Root}
 * @property {boolean} [open] - Controlled open state
 * @property {(open: boolean) => void} [onOpenChange] - Open state change callback
 * @property {boolean} [modal] - Whether sheet is modal (default: true)
 */
const Sheet = SheetPrimitive.Root

/**
 * Sheet trigger element.
 * 
 * The element that opens the sheet when clicked. Can use asChild
 * to merge onto a custom element.
 * 
 * @type {typeof SheetPrimitive.Trigger}
 * @property {boolean} [asChild] - Merge props onto child element
 */
const SheetTrigger = SheetPrimitive.Trigger

/**
 * Sheet close button.
 * 
 * Element that closes the sheet when clicked. Can use asChild
 * to merge onto a custom element.
 * 
 * @type {typeof SheetPrimitive.Close}
 * @property {boolean} [asChild] - Merge props onto child element
 */
const SheetClose = SheetPrimitive.Close

/**
 * Sheet portal container.
 * 
 * Renders the sheet content in a portal at the document root.
 * 
 * @type {typeof SheetPrimitive.Portal}
 * @property {HTMLElement} [container] - Custom portal container
 */
const SheetPortal = SheetPrimitive.Portal

/**
 * Sheet overlay backdrop.
 * 
 * Semi-transparent backdrop rendered behind the sheet content.
 * Clicking the overlay closes the sheet.
 * 
 * @type {React.ComponentPropsWithoutRef<typeof SheetPrimitive.Overlay>}
 * @property {string} [className] - Additional CSS classes
 * @property {boolean} [forceMount] - Force mount for SSR
 */
const SheetOverlay = React.forwardRef(({ className, ...props }, ref) => (
  <SheetPrimitive.Overlay
    className={cn(
      "fixed inset-0 z-50 bg-black/80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className
    )}
    {...props}
    ref={ref} />
))
SheetOverlay.displayName = SheetPrimitive.Overlay.displayName

/**
 * Sheet content variants for different slide directions.
 * 
 * Defines animation and positioning for top, bottom, left, and right.
 * Default side is right (most common for detail panels).
 * 
 * @type {Function}
 */
const sheetVariants = cva(
  "fixed z-50 gap-4 bg-background p-6 shadow-lg transition ease-in-out data-[state=closed]:duration-300 data-[state=open]:duration-500 data-[state=open]:animate-in data-[state=closed]:animate-out",
  {
    variants: {
      side: {
        top: "inset-x-0 top-0 border-b data-[state=closed]:slide-out-to-top data-[state=open]:slide-in-from-top",
        bottom:
          "inset-x-0 bottom-0 border-t data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom",
        left: "inset-y-0 left-0 h-full w-3/4 border-r data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left sm:max-w-sm",
        right:
          "inset-y-0 right-0 h-full w-3/4 border-l data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right sm:max-w-sm",
      },
    },
    defaultVariants: {
      side: "right",
    },
  }
)

/**
 * Sheet content panel.
 * 
 * The main sheet panel that slides in from the specified side.
 * Includes a close button (X) in the top-right corner.
 * Default side is right with max-width on small screens.
 * 
 * @type {React.ForwardRefExoticComponent<{side: 'top' | 'bottom' | 'left' | 'right'} & React.ComponentPropsWithoutRef<typeof SheetPrimitive.Content>>}
 * @property {'top' | 'bottom' | 'left' | 'right'} [side='right'] - Slide direction
 * @property {string} [className] - Additional CSS classes
 * @property {React.ReactNode} children - Sheet content
 * @property {(event: Event) => void} [onEscapeKeyDown] - Escape key handler
 * @property {(event: Event) => void} [onPointerDownOutside] - Click outside handler
 */
const SheetContent = React.forwardRef(({ side = "right", className, children, ...props }, ref) => (
  <SheetPortal>
    <SheetOverlay />
    <SheetPrimitive.Content ref={ref} className={cn(sheetVariants({ side }), className)} {...props}>
      <SheetPrimitive.Close
        className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-secondary">
        <X className="h-4 w-4" />
        <span className="sr-only">Close</span>
      </SheetPrimitive.Close>
      {children}
    </SheetPrimitive.Content>
  </SheetPortal>
))
SheetContent.displayName = SheetPrimitive.Content.displayName

/**
 * Sheet header section.
 * 
 * Container for the sheet title and description.
 * Uses flexbox column layout with centered text on mobile.
 * 
 * @type {React.HTMLAttributes<HTMLDivElement>}
 * @property {string} [className] - Additional CSS classes
 * @property {React.ReactNode} children - SheetTitle and SheetDescription
 */
const SheetHeader = ({ className, ...props }) => (
  <div
    className={cn("flex flex-col space-y-2 text-center sm:text-left", className)}
    {...props} />
)
SheetHeader.displayName = "SheetHeader"

/**
 * Sheet footer section.
 * 
 * Container for action buttons. Uses responsive flexbox layout
 * that stacks vertically on mobile and horizontally on desktop.
 * 
 * @type {React.HTMLAttributes<HTMLDivElement>}
 * @property {string} [className] - Additional CSS classes
 * @property {React.ReactNode} children - Action buttons
 */
const SheetFooter = ({ className, ...props }) => (
  <div
    className={cn("flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2", className)}
    {...props} />
)
SheetFooter.displayName = "SheetFooter"

/**
 * Sheet title heading.
 * 
 * Bold heading for the sheet panel. Required for accessibility.
 * 
 * @type {React.ComponentPropsWithoutRef<typeof SheetPrimitive.Title>}
 * @property {string} [className] - Additional CSS classes
 * @property {React.ReactNode} children - Title text
 */
const SheetTitle = React.forwardRef(({ className, ...props }, ref) => (
  <SheetPrimitive.Title
    ref={ref}
    className={cn("text-lg font-semibold text-foreground", className)}
    {...props} />
))
SheetTitle.displayName = SheetPrimitive.Title.displayName

/**
 * Sheet description text.
 * 
 * Secondary text providing additional context for the sheet.
 * 
 * @type {React.ComponentPropsWithoutRef<typeof SheetPrimitive.Description>}
 * @property {string} [className] - Additional CSS classes
 * @property {React.ReactNode} children - Description text
 */
const SheetDescription = React.forwardRef(({ className, ...props }, ref) => (
  <SheetPrimitive.Description
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props} />
))
SheetDescription.displayName = SheetPrimitive.Description.displayName

export {
  Sheet,
  SheetPortal,
  SheetOverlay,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
}
