/**
 * @fileoverview Dialog components for modal overlays and confirmations.
 * 
 * Built on Radix UI Dialog primitive for accessible, keyboard-navigable
 * modal dialogs. Supports focus trapping, scroll locking, and animated
 * enter/exit transitions. Used for confirmations, forms, and detail views.
 * 
 * @module ui/dialog
 * @example
 * ```jsx
 * import {
 *   Dialog,
 *   DialogTrigger,
 *   DialogContent,
 *   DialogHeader,
 *   DialogTitle,
 *   DialogDescription,
 *   DialogFooter,
 * } from "@/components/ui/dialog";
 * 
 * <Dialog>
 *   <DialogTrigger asChild>
 *     <Button>Open Dialog</Button>
 *   </DialogTrigger>
 *   <DialogContent>
 *     <DialogHeader>
 *       <DialogTitle>Confirm Action</DialogTitle>
 *       <DialogDescription>
 *         Are you sure you want to proceed?
 *       </DialogDescription>
 *     </DialogHeader>
 *     <DialogFooter>
 *       <Button variant="outline">Cancel</Button>
 *       <Button>Confirm</Button>
 *     </DialogFooter>
 *   </DialogContent>
 * </Dialog>
 * ```
 */

"use client"

import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { X } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * Dialog root component.
 * 
 * Manages the open/close state for the dialog. Wraps all dialog
 * components and provides context for state management.
 * 
 * @type {typeof DialogPrimitive.Root}
 * @property {boolean} [open] - Controlled open state
 * @property {(open: boolean) => void} [onOpenChange] - Open state change callback
 * @property {boolean} [modal] - Whether dialog is modal (default: true)
 * @property {React.ReactNode} children - DialogTrigger and DialogContent
 */
const Dialog = DialogPrimitive.Root

/**
 * Dialog trigger element.
 * 
 * The element that opens the dialog when clicked. Can use asChild
 * to merge onto a custom element (e.g., Button).
 * 
 * @type {typeof DialogPrimitive.Trigger}
 * @property {boolean} [asChild] - Merge props onto child element
 * @property {React.ReactNode} children - Trigger content
 */
const DialogTrigger = DialogPrimitive.Trigger

/**
 * Dialog portal container.
 * 
 * Renders the dialog content in a portal at the document root,
 * ensuring proper z-index stacking and overflow handling.
 * 
 * @type {typeof DialogPrimitive.Portal}
 * @property {HTMLElement} [container] - Custom portal container
 * @property {React.ReactNode} children - DialogOverlay and DialogContent
 */
const DialogPortal = DialogPrimitive.Portal

/**
 * Dialog close button.
 * 
 * Element that closes the dialog when clicked. Can use asChild
 * to merge onto a custom element.
 * 
 * @type {typeof DialogPrimitive.Close}
 * @property {boolean} [asChild] - Merge props onto child element
 * @property {React.ReactNode} children - Close button content
 */
const DialogClose = DialogPrimitive.Close

/**
 * Dialog overlay backdrop.
 * 
 * Semi-transparent backdrop rendered behind the dialog content.
 * Clicking the overlay closes the dialog (when modal).
 * Includes fade animations for enter/exit transitions.
 * 
 * @type {React.ForwardRefExoticComponent<any>}
 * @property {string} [className] - Additional CSS classes
 * @property {boolean} [forceMount] - Force mount for SSR
 */
const DialogOverlay = React.forwardRef(
  ({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-50 bg-black/80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className
    )}
    {...props} />
))
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName

/**
 * Dialog content container.
 * 
 * The main dialog panel with positioning, padding, and animations.
 * Includes a close button (X) in the top-right corner.
 * Renders inside DialogPortal with DialogOverlay.
 * 
 * @type {React.ForwardRefExoticComponent<any>}
 * @property {string} [className] - Additional CSS classes
 * @property {React.ReactNode} children - Dialog header, body, footer
 * @property {boolean} [forceMount] - Force mount for SSR
 * @property {(event: Event) => void} [onEscapeKeyDown] - Escape key handler
 * @property {(event: Event) => void} [onPointerDownOutside] - Click outside handler
 * @property {(event: Event) => void} [onInteractOutside] - Interaction outside handler
 */
const DialogContent = React.forwardRef(
  ({ className, children, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        "fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border bg-background p-6 shadow-lg duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] sm:rounded-lg",
        className
      )}
      {...props}>
      {children}
      <DialogPrimitive.Close
        className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground">
        <X className="h-4 w-4" />
        <span className="sr-only">Close</span>
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPortal>
))
DialogContent.displayName = DialogPrimitive.Content.displayName

/**
 * Dialog header section.
 * 
 * Container for the dialog title and description. Uses flexbox
 * layout with vertical spacing and responsive text alignment.
 * 
 * @type {React.FC<any>}
 * @property {string} [className] - Additional CSS classes
 * @property {React.ReactNode} children - DialogTitle and DialogDescription
 */
const DialogHeader = ({ className, ...props }) => (
  <div
    className={cn("flex flex-col space-y-1.5 text-center sm:text-left", className)}
    {...props} />
)
DialogHeader.displayName = "DialogHeader"

/**
 * Dialog footer section.
 * 
 * Container for action buttons. Uses responsive flexbox layout
 * that stacks vertically on mobile and horizontally on desktop.
 * 
 * @type {React.FC<any>}
 * @property {string} [className] - Additional CSS classes
 * @property {React.ReactNode} children - Action buttons
 */
const DialogFooter = ({ className, ...props }) => (
  <div
    className={cn("flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2", className)}
    {...props} />
)
DialogFooter.displayName = "DialogFooter"

/**
 * Dialog title heading.
 * 
 * Renders as an h2 element with bold, tight-tracking styling.
 * Required for accessibility - provides the dialog's accessible name.
 * 
 * @type {React.ForwardRefExoticComponent<any>}
 * @property {string} [className] - Additional CSS classes
 * @property {React.ReactNode} children - Title text
 */
const DialogTitle = React.forwardRef(
  ({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn("text-lg font-semibold leading-none tracking-tight", className)}
    {...props} />
))
DialogTitle.displayName = DialogPrimitive.Title.displayName

/**
 * Dialog description text.
 * 
 * Secondary text providing additional context. Renders in muted
 * color below the title. Provides the dialog's accessible description.
 * 
 * @type {React.ForwardRefExoticComponent<any>}
 * @property {string} [className] - Additional CSS classes
 * @property {React.ReactNode} children - Description text
 */
const DialogDescription = React.forwardRef(
  ({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props} />
))
DialogDescription.displayName = DialogPrimitive.Description.displayName

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
}
